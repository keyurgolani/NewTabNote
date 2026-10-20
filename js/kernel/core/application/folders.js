/**
 * Folder use cases and the folder query. A move is checked against the folders as
 * committed, in the transaction that writes it, so a stale view can't move a folder into
 * one of its own descendants.
 */

import { isId, isIdOrNull } from '../contracts/checks.js';
import { committed, empty, ready, rejected } from '../contracts/outcomes.js';
import { createsCycle, newFolderRecord } from '../domain/folder.js';
import { unitsWork } from './work.js';

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

/** @type {{createFolder: CommandHandler<'createFolder'>, moveFolder: CommandHandler<'moveFolder'>}} */
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
      folderRecord(folderId),
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
      folderRecord(folderId),
    );
  },
};

/** @type {{listFolders: QueryHandler<'listFolders'>}} */
export const folderQueries = {
  async listFolders(query, { adapter, clock }) {
    const folders = await adapter.read(['folders'], tx => tx.getAll('folders'));
    return folders.length > 0 ? ready(clock.now(), folders) : empty(clock.now());
  },
};
