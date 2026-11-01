/**
 * Close-time drafts at a page's start (#33, the stack's close-time PR): the drafts in the page's
 * localStorage, read through the page's store (closeDraftStore, on the storage its root hands
 * in, so nothing here touches a browser API), each applied through the page's kernel
 * (applyCloseDrafts), and the command that applies one (applyCloseDraft). The new tab loads this
 * module at its start, and Popup and Side Panel only when their localStorage holds a draft or
 * 1.4.3's catch-up key (composition/close-drafts.js, the lead's option 1), through
 * close-drafts-chunk.js, the `close-drafts-chunk` chunk their budget rows name as lazy, so their
 * start loads none of it.
 *
 * applyCloseDraft is one transaction over the notes and what they hold, as 1.4.3's applyOne is
 * on IndexedDB (the lead's Q3). Its unit reads the draft's note and versions, the stored copies
 * of the blocks the draft names, and whether its recovered note is stored, decides by the
 * draft's rules (domain/close-draft.js), and writes the save, the recovered note, the record's
 * catch-up, or nothing, so nothing writes the note between the read and the write. The applier
 * sends it under the draft's own commandId (`${draft.id}-apply`), so a resend after a page went
 * between the commit and the draft's remove replays, and below version 10, where no ledger keeps
 * it, rule 0 or content first finds the work done.
 *
 * Its outcome says what happened, for the applier:
 * - `close-draft-saved`, or `close-draft-saved-in-trash` for a note in the Trash (V3): the
 *   residue saved into the note
 * - `close-draft-recovered`: its recovered note, which it names when it made it now, and
 *   doesn't when an earlier start made it (rule 0)
 * - `close-draft-dropped`: nothing to write, or deletes alone over a note changed since
 * - `close-draft-caught-up`: dropped, with the record's preview and to-do progress made again
 *   from its blocks, which a delete that committed alone, or 1.4.x's closing write of blocks,
 *   left behind (3.1 (a)). The record's revision and `updatedAt` stay as they were.
 * - `close-draft-gone`: its note is deleted for good
 *
 * A save's preview and to-do progress come from the note's blocks as stored once the save is
 * in, in note order, as insertBlocks makes them, since the draft's were read from a page that
 * may not have had another writer's changes. Its links are the names the page's editor read
 * from its own text (`linkedNames`), as its save would have written them and as 1.4.3's applier
 * writes them: the kernel reads a block's text from its raw content (insertLinkText), which holds
 * a name's `&` as `&amp;` and leaves out a table's cells and a toggle's children, so names read
 * that way would drop links the editor's save keeps. A merged save's links are the closing
 * page's, and the note's next save reads them all again. The catch-up leaves links to that next
 * save for the same reason, as the worker's catch-up does (the lead's Q9).
 *
 * It carries no expected revision: its own base check runs inside its transaction
 * (test/kernel/write-guards.mjs).
 */

import { isId, isRecord } from '../contracts/checks.js';
import { committed, rejected } from '../contracts/outcomes.js';
import { CATCH_UP_KEY, DRAFTS_LOCK, DRAFT_PREFIX, SAVED_UNTOLD_KEY, UNTOLD_KEY } from '../domain/close-draft-keys.js';
import { decide, isCloseDraft, recoveredIdOf } from '../domain/close-draft.js';
import {
  inBlockOrder,
  linkTargets,
  newSearchEntry,
  noteSaveMetadata,
  trashRetentionDays,
} from '../domain/note.js';
import { recoveredNote } from '../domain/recovered-note.js';
import { zoneOf } from '../ports/runtime.js';
import { unitsWork } from './work.js';

/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {import('../domain/close-draft.js').Residue} Residue */
/** @typedef {import('../ports/repository.js').Tx} Tx */
/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../ports/repository.js').StoreName} StoreName */

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * What the unit decided, for the outcome: its code, the notes it changed, the note whose
 * revision the outcome reports, and whether it changed that note's content
 * @typedef {{code: string, changed: string[], primary?: string, revised: boolean}} Applied
 */

/** Every store the apply reads or writes, in one transaction */
const STORES = /** @type {StoreName[]} */ (['notes', 'blocks', 'searchIndex', 'folders', 'links']);

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean} whether two to-do progresses are the same, null and a missing one alike
 */
const sameProgress = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The note as the save writes it: its title when the residue has one, a typed one marked as set
 * by hand and a generated one with when it was made, as the editor's save writes them, and its
 * preview and to-do progress from `blocks`, its blocks once the save is in. Its pin, folder,
 * archive and Trash stay as stored.
 * @param {NoteRecord} note
 * @param {Residue} residue
 * @param {CloseDraft} draft
 * @param {BlockRecord[]} blocks
 * @param {number} now
 * @returns {NoteRecord}
 */
function savedNote(note, residue, draft, blocks, now) {
  /** @type {NoteRecord} */
  const next = { ...note, ...noteSaveMetadata(inBlockOrder(blocks)), updatedAt: now };
  if (residue.name !== undefined) {
    next.name = residue.name;
    if (draft.titleOrigin === 'generated') next.lastAutoTitleAt = draft.at;
    else next.titleManuallySet = true;
  }
  return next;
}

/**
 * The note's wiki links replaced with links to the notes `names` name, in `tx`, as
 * Storage.updateNoteLinks replaced them
 * @param {Tx} tx
 * @param {string} noteId
 * @param {readonly string[]} names
 * @param {{now: number, nextId: () => string}} stamp
 */
async function replaceLinksIn(tx, noteId, names, { now, nextId }) {
  const targets = names.length > 0 ? linkTargets(await tx.getAll('notes'), names, noteId) : [];
  for (const key of await tx.getKeysByIndex('links', 'fromNoteId', noteId)) tx.delete('links', key);
  for (const toNoteId of targets) tx.put('links', { id: nextId(), fromNoteId: noteId, toNoteId, createdAt: now });
}

/** @type {{applyCloseDraft: CommandHandler<'applyCloseDraft'>}} */
export const closeDraftCommands = {
  async applyCloseDraft(command, { adapter, clock, ids }) {
    const { draft } = command;
    if (!isCloseDraft(draft)) return rejected('validation', 'invalid-command');
    // The Trash's keeping time lives outside the note stores, so it's read before the unit
    // runs, as runTrashCleanup reads it: a recovered note in the Trash says how long it stays
    const { trashRetention } = await adapter.readSettings('preferences', ['trashRetention']);
    const trashDays = trashRetentionDays(trashRetention) ?? 0;
    const now = clock.now();
    const zone = zoneOf(clock);
    const { noteId } = draft;
    const recoveredId = recoveredIdOf(draft);
    const names = Array.isArray(draft.linkedNames) ? draft.linkedNames.filter(name => typeof name === 'string') : null;
    /** @type {Applied} */
    let applied = { code: 'close-draft-dropped', changed: [], revised: false };
    /** @type {Unit} */
    const apply = {
      stores: STORES,
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        const note = await tx.get('notes', noteId);
        const versions = note ? tx.versions('notes', noteId) : undefined;
        const madeBefore = Boolean(await tx.get('notes', recoveredId));
        /** @type {Map<string, Record<string, unknown>>} */
        const stored = new Map();
        for (const id of new Set([...draft.blocks.map(block => block.id), ...draft.deletedBlockIds])) {
          const copy = await tx.get('blocks', id);
          if (copy) stored.set(id, copy);
        }
        const decision = decide({ draft, note, madeBefore, stored, versions });
        if (decision.kind === 'recovered-before') {
          applied = { code: 'close-draft-recovered', changed: [], revised: false };
          return;
        }
        if (decision.kind === 'gone' || !note) {
          applied = { code: 'close-draft-gone', changed: [], revised: false };
          return;
        }
        const own = await tx.getAllByIndex('blocks', 'canvasId', noteId);
        if (decision.kind === 'dropped') {
          // The record catches up with its blocks, its revision and updatedAt as they were
          const { preview, todoProgress } = noteSaveMetadata(inBlockOrder(own));
          const lags = preview !== note.preview || !sameProgress(todoProgress, note.todoProgress);
          if (lags) tx.put('notes', { ...note, preview, todoProgress });
          applied = lags
            ? { code: 'close-draft-caught-up', changed: [noteId], primary: noteId, revised: false }
            : { code: 'close-draft-dropped', changed: [], revised: false };
          return;
        }
        const { residue } = decision;
        if (decision.kind === 'recover') {
          const folder = typeof note.folderId === 'string' && note.folderId !== '' ? await tx.get('folders', note.folderId) : undefined;
          // Every note, so the first sentence links the original only where the link reaches it alone (V1)
          const notes = await tx.getAll('notes');
          const made = recoveredNote(note, residue, draft, { now, zone, trashDays, inFolder: Boolean(folder), notes });
          tx.put('notes', made.note);
          for (const block of made.blocks) tx.put('blocks', block);
          tx.put('searchIndex', newSearchEntry(made.note, now));
          // The backlink on the original. Links the copied blocks hold come at its first save, as in 1.4.3.
          if (made.link) tx.put('links', { id: ids.next(), fromNoteId: recoveredId, toNoteId: noteId, createdAt: now });
          applied = { code: 'close-draft-recovered', changed: [recoveredId], primary: recoveredId, revised: true };
          return;
        }
        // The save: the residue's blocks are the note's own or new, and its deletes the note's own
        const gone = new Set(residue.deletedBlockIds);
        const puts = residue.blocks.map(block => /** @type {BlockRecord} */ ({ ...block, canvasId: noteId }));
        const changedIds = new Set(puts.map(block => block.id));
        const after = [...own.filter(block => !gone.has(block.id) && !changedIds.has(block.id)), ...puts];
        for (const block of puts) tx.put('blocks', block);
        for (const id of gone) tx.delete('blocks', id);
        const next = savedNote(note, residue, draft, after, now);
        tx.put('notes', next);
        if (residue.name !== undefined) {
          const entry = await tx.get('searchIndex', noteId);
          if (entry) tx.put('searchIndex', { ...entry, name: next.name, updatedAt: now });
        }
        if (names) await replaceLinksIn(tx, noteId, names, { now, nextId: () => ids.next() });
        applied = {
          code: note.trashed ? 'close-draft-saved-in-trash' : 'close-draft-saved',
          changed: [noteId],
          primary: noteId,
          revised: true,
        };
      },
    };
    return unitsWork(
      command,
      [apply],
      () => committed(applied.code, applied.changed, applied.changed.length === 0 ? { severity: 'info' } : {}),
      {
        primary: () => (isId(applied.primary) ? { store: 'notes', key: applied.primary } : undefined),
        revised: () => applied.revised,
      },
    );
  },
};

// ─── The page's drafts ───

/**
 * A page's localStorage, as its root hands it in: Web Storage's synchronous calls
 * @typedef {object} DraftStorage
 * @property {number} length
 * @property {(index: number) => string | null} key
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/**
 * The Web Locks a page has, as the apply and the deletes for good hold them
 * @typedef {{request: <T>(name: string, options: {mode: 'exclusive'}, callback: () => Promise<T>) => Promise<T>}} DraftLocks
 */

/**
 * The page's kernel, as the applier sends through it
 * @typedef {{execute: (command: import('../contracts/commands.js').Command) => Promise<unknown>}} DraftClient
 */

/**
 * @typedef {object} DraftStore
 * @property {() => boolean} has - whether a draft is stored, without parsing any: nearly every start has none
 * @property {() => Array<{key: string, draft: CloseDraft}>} list
 *   The drafts, in the order their tabs closed. One that doesn't parse, or isn't a draft this
 *   build applies, is removed: nothing could apply it.
 * @property {(key: string) => boolean} present - whether `key` is still stored
 * @property {(key: string) => void} remove
 * @property {(entry: {id: string, of: string}) => void} tell - a recovered note for the next new tab's toast, once
 * @property {(id: string) => void} tellSaved - a note in the Trash a draft was saved into, once
 * @property {(noteIds: readonly string[]) => void} clearNotes
 *   What `noteIds`, deleted for good, left here: their drafts, the drafts whose recovered note one
 *   of them is, and their untold entries, as a note's, its recovered note's, or its original's
 * @property {() => void} clearAll - every draft and list here, and 1.4.3's catch-up key, for a Reset
 * @property {() => unknown} takeCatchUp - 1.4.3's catch-up key's value, read, then removed
 */

/**
 * The drafts in `storage`, the page's localStorage. Never throws: a page without one, or
 * without access to it, has no drafts, and a write that doesn't fit is skipped.
 * @param {DraftStorage | undefined} storage
 * @returns {DraftStore}
 */
export function closeDraftStore(storage) {
  /** @param {string} key */
  const read = key => {
    try {
      return JSON.parse(/** @type {DraftStorage} */ (storage).getItem(key) || 'null');
    } catch {
      return null;
    }
  };
  /** @param {string} key */
  const remove = key => {
    try {
      /** @type {DraftStorage} */ (storage).removeItem(key);
    } catch {
      // Nothing to remove it from
    }
  };
  /**
   * @param {string} key
   * @param {unknown[]} entries - none removes the key
   */
  const write = (key, entries) => {
    try {
      if (entries.length > 0) /** @type {DraftStorage} */ (storage).setItem(key, JSON.stringify(entries));
      else remove(key);
    } catch {
      // Without it the next new tab says nothing, and the note is in the list either way
    }
  };
  /** @returns {string[]} */
  const keys = () => {
    try {
      const found = [];
      const store = /** @type {DraftStorage} */ (storage);
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key && key.startsWith(DRAFT_PREFIX)) found.push(key);
      }
      return found;
    } catch {
      return [];
    }
  };
  /**
   * An untold list's entries that name ids, as `fields` names them
   * @param {string} key
   * @param {string[]} fields
   * @returns {Array<Record<string, string>>}
   */
  const entries = (key, fields) => {
    const value = read(key);
    return Array.isArray(value)
      ? value.filter(entry => isRecord(entry) && fields.every(field => isId(entry[field])))
      : [];
  };
  /**
   * @param {string} key
   * @param {string[]} fields
   * @param {Record<string, string>} entry - added unless its id is there
   */
  const add = (key, fields, entry) => {
    const listed = entries(key, fields);
    if (!listed.some(item => item.id === entry.id)) write(key, [...listed, entry]);
  };
  return Object.freeze({
    has: () => keys().length > 0,
    list() {
      /** @type {Array<{key: string, draft: CloseDraft}>} */
      const found = [];
      for (const key of keys()) {
        const draft = read(key);
        if (isCloseDraft(draft)) found.push({ key, draft });
        else remove(key);
      }
      return found.sort((a, b) => a.draft.at - b.draft.at);
    },
    present(key) {
      try {
        return /** @type {DraftStorage} */ (storage).getItem(key) !== null;
      } catch {
        return false;
      }
    },
    remove,
    tell: entry => add(UNTOLD_KEY, ['id', 'of'], entry),
    tellSaved: id => add(SAVED_UNTOLD_KEY, ['id'], { id }),
    clearNotes(noteIds) {
      const ids = new Set(noteIds);
      for (const key of keys()) {
        const draft = read(key);
        if (isCloseDraft(draft) && (ids.has(draft.noteId) || ids.has(recoveredIdOf(draft)))) remove(key);
      }
      const told = entries(UNTOLD_KEY, ['id', 'of']);
      const kept = told.filter(entry => !ids.has(entry.id) && !ids.has(entry.of));
      if (kept.length !== told.length) write(UNTOLD_KEY, kept);
      const saved = entries(SAVED_UNTOLD_KEY, ['id']);
      const still = saved.filter(entry => !ids.has(entry.id));
      if (still.length !== saved.length) write(SAVED_UNTOLD_KEY, still);
    },
    clearAll() {
      for (const key of keys()) remove(key);
      for (const key of [UNTOLD_KEY, SAVED_UNTOLD_KEY, CATCH_UP_KEY]) remove(key);
    },
    takeCatchUp() {
      const value = read(CATCH_UP_KEY);
      remove(CATCH_UP_KEY);
      return value;
    },
  });
}

/**
 * What a start's apply did, by note id
 * @typedef {object} ApplyResult
 * @property {string[]} saved - saved into their notes
 * @property {string[]} savedInTrash - saved into notes in the Trash, told about by the next new tab (V3)
 * @property {Array<{noteId: string, recoveredId: string}>} recovered - each draft's recovered note, made at this start or an earlier one
 * @property {string[]} dropped - nothing to write
 * @property {string[]} caughtUp - nothing to write but the record's preview and to-do progress
 * @property {string[]} gone - deleted for good since
 * @property {string[]} kept - not applied at this start, so the draft stays for the next
 * @property {unknown} catchUp - what 1.4.3's catch-up key held, null when it held nothing
 */

/** @returns {ApplyResult} */
const nothingApplied = () => ({
  saved: [],
  savedInTrash: [],
  recovered: [],
  dropped: [],
  caughtUp: [],
  gone: [],
  kept: [],
  catchUp: null,
});

/**
 * Apply every draft in `store` through `client`, the page's kernel once it's ready, one at a
 * time across pages, and remove each one the kernel committed. A draft whose command didn't
 * commit stays for the next start: storage that was unavailable, a connection the worker's
 * upgrade closed, or a refusal, which is logged by its code, never the draft. Each recovered
 * note goes on the list the next new tab's toast tells, whichever page made it, and each note in
 * the Trash a draft was saved into on its own list (V3).
 * @param {{client: DraftClient, store: DraftStore, locks?: DraftLocks | null, logger?: {warn: (event: string, detail: Record<string, unknown>) => void}}} options
 * @returns {Promise<ApplyResult>}
 */
export async function applyCloseDrafts({ client, store, locks = null, logger }) {
  const result = nothingApplied();
  result.catchUp = store.takeCatchUp();
  // Nearly every start: no draft, so no lock and no command
  if (!store.has()) return result;
  const run = async () => {
    for (const { key, draft } of store.list()) {
      // A delete for good may have cleared it since the list, and then the delete wins
      if (!store.present(key)) continue;
      const outcome = /** @type {import('../contracts/outcomes.js').Outcome} */ (
        await client.execute({ type: 'applyCloseDraft', commandId: `${draft.id}-apply`, draft })
      );
      if (outcome.kind !== 'committed') {
        result.kept.push(draft.noteId);
        if (outcome.kind === 'rejected' && logger) logger.warn('close-draft-refused', { code: outcome.code });
        continue;
      }
      const { noteId } = draft;
      if (outcome.code === 'close-draft-recovered') {
        const recoveredId = recoveredIdOf(draft);
        result.recovered.push({ noteId, recoveredId });
        store.tell({ id: recoveredId, of: noteId });
      } else if (outcome.code === 'close-draft-saved-in-trash') {
        result.savedInTrash.push(noteId);
        store.tellSaved(noteId);
      } else if (outcome.code === 'close-draft-saved') result.saved.push(noteId);
      else if (outcome.code === 'close-draft-caught-up') result.caughtUp.push(noteId);
      else if (outcome.code === 'close-draft-gone') result.gone.push(noteId);
      else result.dropped.push(noteId);
      store.remove(key);
    }
    return result;
  };
  return locks ? locks.request(DRAFTS_LOCK, { mode: 'exclusive' }, run) : run();
}

