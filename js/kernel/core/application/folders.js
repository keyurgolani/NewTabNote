/**
 * Folder use cases and the folder query. A move is checked against the folders as
 * committed, in the transaction that writes it, so a stale view can't move a folder into
 * one of its own descendants.
 */

import { isId, isIdOrNull } from '../contracts/checks.js';
import { committed, empty, ready, rejected } from '../contracts/outcomes.js';
import { createsCycle, folderSubtree, newFolderRecord } from '../domain/folder.js';
import { withPlacementGroup } from '../domain/placement.js';
import { newTombstone } from '../domain/tombstone.js';
import { contentChanged, unitsWork } from './work.js';

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

const invalid = () => rejected('validation', 'invalid-command');

/**
 * @param {string} folderId
 * @returns {() => {store: 'folders', key: string}}
 */
const folderRecord = folderId => () => ({ store: 'folders', key: folderId });

/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../domain/folder.js').FolderRecord} FolderRecord */

/**
 * A unit that reads the folder and puts what `change` makes of it, in one transaction, so a
 * rename and a collapse made at once both land
 * @param {string} folderId
 * @param {(folder: FolderRecord) => FolderRecord} change
 * @returns {Unit}
 */
function changeFolder(folderId, change) {
  return {
    stores: ['folders'],
    async run(tx) {
      const folder = await tx.get('folders', folderId);
      if (!folder) return rejected('not-found', 'folder-not-found');
      tx.put('folders', change(folder));
    },
  };
}

/**
 * @type {{
 *   createFolder: CommandHandler<'createFolder'>,
 *   moveFolder: CommandHandler<'moveFolder'>,
 *   renameFolder: CommandHandler<'renameFolder'>,
 *   setFolderCollapsed: CommandHandler<'setFolderCollapsed'>,
 *   deleteFolder: CommandHandler<'deleteFolder'>,
 * }}
 */
export const folderCommands = {
  createFolder(command, { clock }) {
    const { folderId, name, parentId } = command;
    if (!isId(folderId) || typeof name !== 'string' || !isIdOrNull(parentId)) return invalid();
    const now = clock.now();
    return unitsWork(
      command,
      [
        {
          stores: ['folders'],
          async run(tx) {
            if (await tx.get('folders', folderId)) return rejected('validation', 'folder-exists');
            if (parentId !== null && !(await tx.get('folders', parentId))) {
              return rejected('not-found', 'parent-not-found');
            }
            tx.put('folders', newFolderRecord({ id: folderId, name, parentId, now }));
          },
        },
      ],
      () => committed('folder-created', [folderId]),
      { primary: folderRecord(folderId), revised: contentChanged },
    );
  },

  moveFolder(command, { clock }) {
    const { folderId, parentId } = command;
    if (!isId(folderId) || !isIdOrNull(parentId)) return invalid();
    const now = clock.now();
    return unitsWork(
      command,
      [
        {
          stores: ['folders'],
          async run(tx) {
            const folders = await tx.getAll('folders');
            const folder = folders.find(candidate => candidate.id === folderId);
            if (!folder) return rejected('not-found', 'folder-not-found');
            if (parentId !== null && !folders.some(candidate => candidate.id === parentId)) {
              return rejected('not-found', 'parent-not-found');
            }
            if (createsCycle(folders, folderId, parentId)) return rejected('validation', 'folder-into-itself');
            tx.put('folders', { ...folder, parentId, updatedAt: now });
          },
        },
      ],
      () => committed('folder-moved', [folderId]),
      // A move is placement, so the folder's revision stays where it was
      { primary: folderRecord(folderId), scope: 'placement' },
    );
  },

  renameFolder(command, { clock }) {
    const { folderId, name } = command;
    if (!isId(folderId) || typeof name !== 'string') return invalid();
    const now = clock.now();
    return unitsWork(
      command,
      [changeFolder(folderId, folder => ({ ...folder, name, updatedAt: now }))],
      () => committed('folder-renamed', [folderId]),
      { primary: folderRecord(folderId), revised: contentChanged },
    );
  },

  setFolderCollapsed(command, { clock }) {
    const { folderId, collapsed } = command;
    if (!isId(folderId) || typeof collapsed !== 'boolean') return invalid();
    const now = clock.now();
    return unitsWork(
      command,
      [changeFolder(folderId, folder => ({ ...folder, collapsed, updatedAt: now }))],
      () => committed(collapsed ? 'folder-collapsed' : 'folder-expanded', [folderId]),
      { primary: folderRecord(folderId), scope: 'placement' },
    );
  },

  deleteFolder(command, { clock }) {
    const { folderId } = command;
    if (!isId(folderId)) return invalid();
    const now = clock.now();
    /** @type {string[]} */
    let deleted = [];
    /** @type {string[]} */
    let filed = [];
    /** @type {Unit} */
    const remove = {
      stores: ['folders', 'notes', 'tombstones'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        const folders = await tx.getAll('folders');
        if (!folders.some(folder => folder.id === folderId)) return rejected('not-found', 'folder-not-found');
        // The folders inside it as committed, and every note in them, to the root. Storage.deleteFolder
        // moved only the ones getAllNotes(true) lists, so a trashed note or a template kept a folder
        // that was gone, and once restored no list showed it.
        deleted = folderSubtree(folders, folderId);
        const inside = new Set(deleted);
        const notes = (await tx.getAll('notes')).filter(
          note => typeof note.folderId === 'string' && inside.has(note.folderId),
        );
        filed = notes.map(note => note.id);
        // Each folder with its tombstone, so the worker purges its name from every recovery
        // point too (#17 PR 2b), as it does a deleted note's rows
        for (const id of deleted) {
          tx.delete('folders', id);
          tx.put('tombstones', newTombstone('folder', id, 'deleted', now));
        }
        // Each to Unfiled, or a Daily Note to its date, its placement following (#17 PR 3a)
        for (const note of notes) {
          tx.put('notes', withPlacementGroup(note, { ...note, folderId: null, updatedAt: now }));
        }
      },
    };
    // The commit names the folders and the notes, so a note list reads both again
    return unitsWork(command, [remove], () => committed('folder-deleted', [...deleted, ...filed]), {
      scope: 'placement',
    });
  },
};

/** @type {{listFolders: QueryHandler<'listFolders'>}} */
export const folderQueries = {
  async listFolders(query, { adapter, clock }) {
    const folders = await adapter.read(['folders'], tx => tx.getAll('folders'));
    return folders.length > 0 ? ready(clock.now(), folders) : empty(clock.now());
  },
};
