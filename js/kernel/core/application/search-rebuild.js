/**
 * rebuild-index's write (#20's Recovery Center, #35 slice 8): the search entry of each note the
 * app indexes, written again from its blocks as js/workers/indexer.js's buildNoteEntry makes one.
 * recovery.html sends it in batches of REBUILD_BATCH notes, which the worker's queue runs
 * (rebuildSearchIndex, contracts/recovery-port.js), and which recovery.html's fallback commits on
 * the page's own adapter only while the coordinator can't. The Recovery Center's preview and its
 * check after the rebuild read the entries the same way (js/trust/core/remediation/catalog.js).
 */

import { isId } from '../contracts/checks.js';
import { committed } from '../contracts/outcomes.js';
import { invalid } from './notes.js';
import { unitsWork } from './work.js';

/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../ports/repository.js').Work} Work */
/** @typedef {import('../contracts/operations/rebuild-search-index.js').RebuildSearchIndex} RebuildSearchIndex */

/** How many notes one rebuild transaction writes the entries of, which the batch's schema holds it to */
export const REBUILD_BATCH = 100;

/**
 * A note's search entry, as js/workers/indexer.js's buildNoteEntry makes it from the note and
 * its blocks in the order the `canvasId` index gives them
 * @param {NoteRecord} note
 * @param {readonly BlockRecord[]} blocks
 */
export function searchEntryOf(note, blocks) {
  const content = blocks
    .map(block => block.content || '')
    .join(' ')
    .replace(/<[^>]*>?/gm, '');
  const text = `${content} ${note.name || ''}`;
  const tags = new Set();
  for (const match of text.matchAll(/#([\w-]+)/g)) tags.add(match[1].toLowerCase());
  return {
    noteId: note.id,
    name: note.name || 'Untitled',
    content,
    tags: Array.from(tags),
    updatedAt: note.updatedAt,
  };
}

/**
 * Whether the app's indexer indexes `note`: the notes its list holds, outside trash and the
 * archive and not templates, so a rebuild and the indexer's own setSearchIndex never undo
 * each other
 * @param {NoteRecord} note
 */
export const indexed = note => !note.trashed && !note.archived && !note.isTemplate;

export const rebuildCommands = {
  /**
   * One batch's entries, in one transaction. Content scope with no `revised`: it writes only
   * search entries, so no note's revision moves.
   * @param {RebuildSearchIndex} command
   * @returns {Work | Outcome}
   */
  rebuildSearchIndex(command) {
    const { noteIds } = command;
    if (!Array.isArray(noteIds) || noteIds.length === 0 || noteIds.length > REBUILD_BATCH || !noteIds.every(isId)) {
      return invalid();
    }
    const batch = [...noteIds];
    /** @type {Unit} */
    const rebuild = {
      stores: ['notes', 'blocks', 'searchIndex'],
      async run(tx) {
        for (const noteId of batch) {
          const note = await tx.get('notes', noteId);
          // A note deleted, trashed, archived, or made a template since the preview gets
          // nothing written, and its old entry stays
          if (!note || !indexed(note)) continue;
          const blocks = await tx.getAllByIndex('blocks', 'canvasId', noteId);
          tx.put('searchIndex', searchEntryOf(note, blocks));
        }
      },
    };
    return unitsWork(/** @type {any} */ (command), [rebuild], () => committed('search-index-rebuilt', batch));
  },
};
