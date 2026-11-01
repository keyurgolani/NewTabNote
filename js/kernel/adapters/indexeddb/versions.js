/**
 * A note's three versions on #17's IndexedDB adapter (#17, "Versions"; ports/repository.js,
 * WriteScope): `revision`, `placementVersion`, and `sourceRevision`, fields of its `canvases`
 * record, each read as 0 when the record has none, as every record 1.4.x and #17 PR 1b wrote.
 * Folders and blocks carry none (#17 PR 2a, a deviation from the approved plan: no Keep item
 * reads a block's version, and the editor sends whole blocks with every save, so they would
 * come back stale each time).
 *
 * Each command's transaction has a tracker. It notes the versions every note had as
 * committed, the first time the transaction reads the note, which is what `versions` answers.
 * Every note the transaction puts carries the versions its command gives it, whatever the
 * record a unit spread them from says: the committed ones for a content command, one more
 * placement version for a placement one, and the source revision a derived one carries. Once
 * the units have run, `settle` moves the primary note's content revision on a content command
 * that changed it, putting the note again with only that field changed, starts a note made
 * again under a deleted note's id past the revision the deleted one had, and answers what the
 * commit changed for the change log.
 *
 * What the change log's ops are worked out from (#17 PR 4c, domain/changes.js): each note,
 * block, and folder as the transaction first found it, and as the commit leaves it. A read
 * notes what it found. A write of a record nothing read yet looks the record up first, the read
 * issued ahead of the write, so IndexedDB's request order gives the record as it was. A read of
 * a note's blocks through the `canvasId` index covers them all, so a save that reads them once
 * ahead of its puts (saveNoteContent) looks none of them up one at a time, and a block it puts
 * that the read didn't find is one the note didn't have.
 */

import { blocksByNote, folderOps, noteOps } from '../../core/domain/changes.js';
import { UnavailableError } from '../../core/contracts/outcomes.js';
import { result } from './requests.js';

/** @typedef {import('../../core/ports/repository.js').Versions} Versions */
/** @typedef {import('../../core/ports/repository.js').WriteScope} WriteScope */
/** @typedef {import('../../core/ports/commit-log.js').LoggedChange} LoggedChange */
/** @typedef {import('../../core/domain/changes.js').Around} Around */
/** @typedef {Record<string, unknown>} Row */

/** The fields a note's versions take on its record */
export const VERSION_FIELDS = Object.freeze(['revision', 'placementVersion', 'sourceRevision']);

/**
 * @param {unknown} value
 * @returns {number}
 */
const count = value =>
  Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : 0;

/**
 * The versions a stored note has, each 0 when it has none
 * @param {Record<string, unknown>} record
 * @returns {Versions}
 */
export function versionsOf(record) {
  return {
    revision: count(record.revision),
    placementVersion: count(record.placementVersion),
    sourceRevision: count(record.sourceRevision),
  };
}

/**
 * @param {Versions} a
 * @param {Versions | null} b
 */
const same = (a, b) =>
  b !== null &&
  a.revision === b.revision &&
  a.placementVersion === b.placementVersion &&
  a.sourceRevision === b.sourceRevision;

/** @type {Versions} */
const NONE = Object.freeze({ revision: 0, placementVersion: 0, sourceRevision: 0 });

/**
 * A key as one string, so two copies of one array key, as #20's storage probe writes under,
 * are one record, and a string key never reads as another key's form
 * @param {IDBValidKey} key
 * @returns {string}
 */
const idOf = key => (typeof key === 'string' ? `s${key}` : `k${JSON.stringify(key)}`);

/**
 * What a commit changed, once `settle` has moved its versions
 * @typedef {object} Settled
 * @property {number | undefined} revision - the primary note's content revision, for the outcome
 * @property {LoggedChange[]} changes
 *   One per note and folder the commit changed, in the order it first wrote them, with its ops
 * @property {Array<{id: string, lastRevision: number}>} deleted - the notes it deleted that were stored
 */

/**
 * @typedef {object} VersionTracker
 * @property {(key: IDBValidKey, record: Record<string, unknown> | undefined) => void} saw
 *   Notes what a read found for the note `key`, the first time the transaction reads it
 * @property {(key: IDBValidKey) => Versions | undefined} versions
 * @property {(notes: IDBObjectStore, record: Record<string, unknown>) => void} putNote
 * @property {(notes: IDBObjectStore, key: IDBValidKey) => void} deleteNote
 * @property {(key: IDBValidKey, record: Record<string, unknown> | undefined) => void} sawBlock
 *   Notes what a read found for the block `key`, the first time the transaction reads it
 * @property {(noteId: IDBValidKey, read: Promise<unknown>) => void} coverBlocks
 *   A read of note `noteId`'s blocks through the `canvasId` index, which `read` answers
 * @property {(blocks: IDBObjectStore, record: Record<string, unknown>) => void} putBlock
 * @property {(blocks: IDBObjectStore, key: IDBValidKey) => void} deleteBlock
 * @property {(key: IDBValidKey, record: Record<string, unknown> | undefined) => void} sawFolder
 *   Notes what a read found for the folder `key`, the first time the transaction reads it
 * @property {(folders: IDBObjectStore, record: Record<string, unknown>) => void} putFolder
 * @property {(folders: IDBObjectStore, key: IDBValidKey) => void} deleteFolder
 * @property {(record: TombstoneRecord) => void} tombstone - a tombstone a unit put (#17 PR 2b)
 * @property {() => TombstoneRecord[]} tombstones - the ones put, each as last put, in order
 * @property {() => void} wrote - any other write
 * @property {() => boolean} written - whether the units wrote anything at all
 * @property {(options: SettleOptions) => Promise<Settled>} settle
 */

/** @typedef {import('../../core/domain/tombstone.js').TombstoneRecord} TombstoneRecord */

/**
 * @typedef {object} SettleOptions
 * @property {IDBObjectStore} notes
 * @property {IDBObjectStore | null} tombstones - null on a database below version 10
 * @property {{store: string, key: string} | undefined} primary
 * @property {boolean} revised - whether a content command changed the primary's content
 */

/**
 * A tracker for one transaction of a command of `scope`. A read has no scope.
 * @param {{scope?: WriteScope, sourceRevision?: number}} [command]
 * @returns {VersionTracker}
 */
export function createVersionTracker({ scope = 'content', sourceRevision } = {}) {
  /**
   * Each note's versions as committed, or null for one the transaction found none of, by idOf
   * @type {Map<string, Versions | null>}
   */
  const known = new Map();
  /**
   * Reads of notes the transaction wrote before it read them, for their versions
   * @type {Promise<unknown>[]}
   */
  const lookups = [];
  /**
   * Each note the transaction wrote, by idOf: its key, the record as last put with the
   * versions it carries, or null for a delete. Versions are null for a note put before
   * anything said what it had.
   * @type {Map<string, {key: IDBValidKey, record: Record<string, unknown> | null, carried: Versions | null}>}
   */
  const notes = new Map();
  /**
   * Every note and folder written, in the order first written, for the change log. A key
   * that isn't an id, as #20's storage probe writes under, is no entity.
   * @type {Map<string, {entityType: 'note' | 'folder', entityId: string}>}
   */
  const entities = new Map();
  /**
   * The tombstones the units put, by entity, which the commit puts again with what only the
   * adapter knows (deletion.js)
   * @type {Map<string, TombstoneRecord>}
   */
  const buried = new Map();
  let any = false;
  /**
   * Each note as the transaction first found it, null for none, by idOf, beside its versions
   * in `known`, and each block and folder, for the change log's ops
   * @type {Map<string, Row | null>}
   */
  const foundNotes = new Map();
  /** @type {Map<string, Row | null>} */
  const foundBlocks = new Map();
  /** @type {Map<string, Row | null>} */
  const foundFolders = new Map();
  /**
   * Each block and folder the transaction wrote, by idOf: its key, and the record as last put,
   * or null for a delete, in the order first written
   * @type {Map<string, {key: IDBValidKey, record: Row | null}>}
   */
  const blockWrites = new Map();
  /** @type {Map<string, {key: IDBValidKey, record: Row | null}>} */
  const folderWrites = new Map();
  /**
   * The notes whose blocks a read through the `canvasId` index covers, each with whether the
   * read has answered, and the blocks put under it before it did
   * @type {Map<string, {answered: boolean, put: IDBValidKey[]}>}
   */
  const covered = new Map();

  /**
   * @param {'note' | 'folder'} entityType
   * @param {IDBValidKey} entityId
   */
  const touch = (entityType, entityId) => {
    any = true;
    if (typeof entityId !== 'string') return;
    const id = `${entityType}\0${entityId}`;
    if (!entities.has(id)) entities.set(id, { entityType, entityId });
  };

  /**
   * @param {IDBValidKey} key
   * @param {Record<string, unknown> | undefined} record
   */
  const saw = (key, record) => {
    const id = idOf(key);
    if (!known.has(id)) {
      known.set(id, record ? versionsOf(record) : null);
      foundNotes.set(id, record ?? null);
    }
  };

  /**
   * Notes what `key`'s record was, the first time anything says
   * @param {Map<string, Row | null>} found
   * @param {IDBValidKey} key
   * @param {unknown} record
   */
  const first = (found, key, record) => {
    const id = idOf(key);
    if (!found.has(id)) found.set(id, /** @type {Row | undefined} */ (record) ?? null);
  };

  /**
   * Reads `key` ahead of a write of it, unless something said what it was, so the commit's ops
   * know. Its answer comes before any request issued after it.
   * @param {Map<string, Row | null>} found
   * @param {IDBObjectStore} store
   * @param {IDBValidKey} key
   */
  const lookUpIn = (found, store, key) => {
    if (found.has(idOf(key))) return;
    lookups.push(
      result(store.get(key)).then(
        record => first(found, key, record),
        () => undefined,
      ),
    );
  };

  /**
   * The versions a note this command puts carries, from what it had: its content revision as
   * committed (settle moves the primary's), and what its scope moves
   * @param {Versions} had
   * @returns {Versions}
   */
  const carried = had => ({
    revision: had.revision,
    placementVersion: had.placementVersion + (scope === 'placement' ? 1 : 0),
    sourceRevision: scope === 'derived' && sourceRevision !== undefined ? sourceRevision : had.sourceRevision,
  });

  /**
   * Reads note `key` ahead of a write that comes before any read of it, so the transaction
   * learns what it had. IndexedDB answers a store's requests in order, so the read finds the
   * note as it was before the write.
   * @param {IDBObjectStore} store
   * @param {IDBValidKey} key
   */
  const lookUp = (store, key) => {
    if (known.has(idOf(key))) return;
    const read = result(store.get(key)).then(
      record => saw(key, /** @type {Record<string, unknown> | undefined} */ (record)),
      () => undefined,
    );
    lookups.push(read);
  };

  return {
    saw,
    versions: key => {
      const id = idOf(key);
      if (!known.has(id)) throw new UnavailableError('adapter', 'revision-before-get', false);
      return known.get(id) ?? undefined;
    },
    putNote(store, record) {
      const key = /** @type {IDBValidKey} */ (record.id);
      touch('note', key);
      lookUp(store, key);
      const had = known.get(idOf(key));
      const versions = had === undefined ? null : carried(had ?? NONE);
      const stored = versions ? { ...record, ...versions } : record;
      store.put(stored);
      notes.set(idOf(key), { key, record: stored, carried: versions });
    },
    deleteNote(store, key) {
      touch('note', key);
      lookUp(store, key);
      store.delete(key);
      notes.set(idOf(key), { key, record: null, carried: null });
    },
    sawBlock: (key, record) => first(foundBlocks, key, record),
    coverBlocks(noteId, read) {
      if (typeof noteId !== 'string' || covered.has(noteId)) return;
      const cover = { answered: false, put: /** @type {IDBValidKey[]} */ ([]) };
      covered.set(noteId, cover);
      lookups.push(
        read.then(
          records => {
            for (const record of /** @type {Row[]} */ (records))
              first(foundBlocks, /** @type {IDBValidKey} */ (record.id), record);
            // A block put under the read that it didn't find is one the note didn't have
            for (const key of cover.put) first(foundBlocks, key, null);
            cover.answered = true;
          },
          () => undefined,
        ),
      );
    },
    putBlock(store, record) {
      any = true;
      const key = /** @type {IDBValidKey} */ (record.id);
      const cover = typeof record.canvasId === 'string' ? covered.get(record.canvasId) : undefined;
      if (!cover) lookUpIn(foundBlocks, store, key);
      else if (cover.answered) first(foundBlocks, key, null);
      else cover.put.push(key);
      store.put(record);
      blockWrites.set(idOf(key), { key, record });
    },
    deleteBlock(store, key) {
      any = true;
      lookUpIn(foundBlocks, store, key);
      store.delete(key);
      blockWrites.set(idOf(key), { key, record: null });
    },
    sawFolder: (key, record) => first(foundFolders, key, record),
    putFolder(store, record) {
      const key = /** @type {IDBValidKey} */ (record.id);
      touch('folder', key);
      lookUpIn(foundFolders, store, key);
      store.put(record);
      folderWrites.set(idOf(key), { key, record });
    },
    deleteFolder(store, key) {
      touch('folder', key);
      lookUpIn(foundFolders, store, key);
      store.delete(key);
      folderWrites.set(idOf(key), { key, record: null });
    },
    tombstone(record) {
      any = true;
      buried.set(`${record.entityType}\0${record.id}`, record);
    },
    tombstones: () => [...buried.values()],
    wrote: () => {
      any = true;
    },
    written: () => any,

    async settle({ notes: store, tombstones, primary, revised }) {
      await Promise.all(lookups);
      const primaryKey = primary && primary.store === 'notes' ? primary.key : undefined;
      const primaryId = primaryKey === undefined ? undefined : idOf(primaryKey);
      // A note the transaction neither read nor wrote, whose revision the outcome reports
      /** @type {Record<string, unknown> | undefined} */
      let primaryRecord;
      if (primaryKey !== undefined && primaryId !== undefined && !known.has(primaryId) && !notes.has(primaryId)) {
        primaryRecord = /** @type {Record<string, unknown> | undefined} */ (await result(store.get(primaryKey)));
        saw(primaryKey, primaryRecord);
      }
      // A note made where none was stored carries on past a deleted one's last revision
      /** @type {Map<string, number>} */
      const bases = new Map();
      if (tombstones) {
        const made = [...notes].filter(
          ([id, write]) => write.record && known.get(id) === null && typeof write.key === 'string',
        );
        const found = await Promise.all(made.map(([, write]) => result(tombstones.get(['note', write.key]))));
        made.forEach(([id], index) => {
          const tombstone = /** @type {{lastRevision?: unknown} | undefined} */ (found[index]);
          if (tombstone) bases.set(id, count(tombstone.lastRevision));
        });
      }
      /** @type {Map<string, number>} */
      const revisions = new Map();
      for (const [id, write] of notes) {
        if (!write.record) continue;
        const had = known.get(id) ?? { ...NONE, revision: bases.get(id) ?? 0 };
        const next = carried(had);
        if (id === primaryId && revised) next.revision += 1;
        revisions.set(id, next.revision);
        if (!same(next, write.carried)) store.put({ ...write.record, ...next });
      }
      // A content command that changed the primary note without putting it, as deleting its
      // blocks or capturing into it does, moves its revision all the same
      const stored = primaryId !== undefined && !notes.has(primaryId) ? known.get(primaryId) : undefined;
      if (primaryKey !== undefined && primaryId !== undefined && stored && revised) {
        const record =
          primaryRecord ?? /** @type {Record<string, unknown> | undefined} */ (await result(store.get(primaryKey)));
        if (record) {
          const next = { ...stored, revision: stored.revision + 1 };
          store.put({ ...record, ...next });
          touch('note', primaryKey);
          revisions.set(primaryId, next.revision);
        }
      }
      /** @type {Array<{id: string, lastRevision: number}>} */
      const deleted = [];
      for (const [id, write] of notes) {
        const had = known.get(id);
        if (!write.record && had && typeof write.key === 'string')
          deleted.push({ id: write.key, lastRevision: had.revision });
      }
      /**
       * @param {string} id
       * @returns {number | undefined}
       */
      const revisionOf = id => {
        const write = notes.get(id);
        if (write) return write.record ? revisions.get(id) : undefined;
        if (revisions.has(id)) return revisions.get(id);
        const had = known.get(id);
        return had ? had.revision : undefined;
      };
      // Each block the commit wrote, as it was and as it's left, by the note it belongs to
      const byNote = blocksByNote(
        [...blockWrites.values()]
          .filter(write => typeof write.key === 'string')
          .map(
            ({ key, record }) =>
              /** @type {[string, Around]} */ ([key, { before: foundBlocks.get(idOf(key)) ?? null, after: record }]),
          ),
      );
      /** @type {LoggedChange[]} */
      const changes = [];
      for (const { entityType, entityId } of entities.values()) {
        const id = idOf(entityId);
        if (entityType === 'folder') {
          const write = folderWrites.get(id);
          const before = foundFolders.get(id) ?? null;
          changes.push({
            entityType,
            entityId,
            revision: 0,
            ops: folderOps({ before, after: write ? write.record : undefined }),
          });
          continue;
        }
        const write = notes.get(id);
        const had = known.get(id);
        const blocks = byNote.get(entityId) || [];
        byNote.delete(entityId);
        // A delete of a note that wasn't stored changed nothing
        if (write && !write.record && !had) continue;
        changes.push({
          entityType,
          entityId,
          revision: (write && !write.record ? had?.revision : revisionOf(id)) ?? 0,
          ops: noteOps({ before: foundNotes.get(id) ?? null, after: write ? write.record : undefined }, blocks),
        });
      }
      // A note the commit wrote only blocks of changed too, at its revision as stored
      for (const [noteId, blocks] of byNote) {
        const ops = noteOps({ before: null, after: undefined }, blocks);
        if (ops.length === 0) continue;
        const id = idOf(noteId);
        if (!known.has(id)) saw(noteId, /** @type {Row | undefined} */ (await result(store.get(noteId))));
        const had = known.get(id);
        // Blocks of a note that isn't stored are no note's
        if (!had) continue;
        changes.push({ entityType: 'note', entityId: noteId, revision: had.revision, ops });
      }
      return { revision: primaryId === undefined ? undefined : revisionOf(primaryId), changes, deleted };
    },
  };
}
