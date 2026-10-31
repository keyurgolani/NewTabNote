/**
 * The in-memory adapter (#12, "Layout"), with three of the four flags:
 * - atomicMultiStore: a command's units commit together, or nothing does
 * - revisions: a note has the three versions #17 keeps (ports/repository.js, WriteScope), each
 *   0 until something moves it. Its content revision moves only when a content command
 *   changes its title or blocks (Work.scope, Work.revised), its placement version on every
 *   put of a placement command, and its source revision takes a derived command's
 *   Work.sourceRevision. Committed outcomes report the content revision, and a stale expected
 *   version is a conflict, after which the adapter keeps the command. A note deleted and made
 *   again under its id carries on past the revision it had.
 * - idempotency: a commandId sent again with the same command gets its committed or conflict
 *   outcome again, and nothing runs; sent with another command it's `idempotency-key-reuse`.
 *   Rejections and `unavailable` outcomes aren't kept, so sending the command again runs it.
 *   A bulk command keeps only its fingerprint, from its first recall, so the same commandId
 *   with another selection is key reuse even when both are sent at once, and a resend runs
 *   again: each item that committed or conflicted answers from its own record, and each
 *   other item runs again. The same command is the same SHA-256 of its canonical JSON, keys
 *   sorted (memory/fingerprint.js), the digest #17 keeps, so no record holds the command.
 *
 * - backups: false. The legacy import, auto-backup, and export file are 1.4.x's Storage code,
 *   so they answer `unavailable` here, until #18's backup engine runs on every adapter.
 *
 * Transactions run one at a time, in the order they open, as IndexedDB runs readwrite
 * transactions over the same stores. Everything goes in and out as a copy.
 *
 * The contract suite runs against it, and `beforeWrite` lets a test make a write fail. #17
 * persists what it keeps: revisions, outcomes, and conflicts. A conflict is kept as a record in
 * its `conflicts` store, and a tombstone a unit puts gets its note's last content revision and
 * the commit's seq, as on #17's adapter, so deleting a note drops its conflict records (#17
 * PR 2b).
 *
 * Given #13's in-memory ledger and commit log (memory/ledger.js, memory/commit-log.js), it
 * writes them in the task that commits, as #17 writes its idempotency record and change-log
 * entry in the commit's transaction: a commit that changes notes or folders appends one change
 * per entity, typed by the store it wrote and with its revision, and its committed outcome
 * carries that commitSeq. Then the
 * ledger keeps each committed or conflict outcome under its commandId. A resend appends and
 * records nothing again, and a bulk command's reservation stays the adapter's own, so its key
 * reads as absent there and each item's reads under its own.
 */

import { clone } from '../contracts/clone.js';
import { COMMANDS } from '../contracts/commands.js';
import { UnavailableError, rejected, unavailable, unavailableFrom } from '../contracts/outcomes.js';
import { DEFAULT_PREFERENCES } from '../domain/preferences.js';
import { DEFAULT_SESSION } from '../domain/session.js';
import { IDB_SETTINGS_KEYS, STORES } from '../ports/repository.js';
import { digestOf } from './fingerprint.js';

/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../ports/repository.js').CommitResult} CommitResult */
/** @typedef {import('../ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../ports/repository.js').StoreName} StoreName */
/** @typedef {import('../ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../ports/repository.js').ReadableSettingsArea} ReadableSettingsArea */
/** @typedef {import('../ports/repository.js').Tx} Tx */
/** @typedef {import('../ports/repository.js').ReadTx} ReadTx */
/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../ports/repository.js').Work} Work */
/** @typedef {import('../ports/commit-log.js').Change} Change */
/** @typedef {import('./commit-log.js').MemoryCommitLog} MemoryCommitLog */
/** @typedef {import('./ledger.js').MemoryLedger} MemoryLedger */

/**
 * A conflict the adapter kept, as `conflicts()` reads it from its `conflicts` store: the
 * command that lost, and the revision it lost to. The record that won is still in its store.
 * @typedef {object} KeptConflict
 * @property {string} commandId
 * @property {Command} command
 * @property {number} currentRevision
 */

/**
 * @typedef {object} MemoryAdapterOptions
 * @property {(target: StoreName | SettingsArea, key: string) => void} [beforeWrite]
 *   Called before each write; a throw fails the command, as a failing IndexedDB request
 *   would. Throw an UnavailableError to choose the cause.
 * @property {MemoryLedger} [ledger] - where it keeps each committed and conflict outcome too
 * @property {MemoryCommitLog} [commitLog] - where it appends each commit's changed entities
 */

/** @typedef {KernelAdapter & {conflicts: () => KeptConflict[]}} MemoryAdapter */

/**
 * @param {unknown} key
 * @returns {key is string}
 */
const isKey = key => typeof key === 'string' && key !== '';

/**
 * A record's key as the one string its store's map holds it under: the id, or for a store
 * keyed by several fields (tombstones), their values as JSON. Undefined when a part isn't an id.
 * @param {StoreName} store
 * @param {unknown} key - a string, or for such a store the array of its parts
 * @returns {string | undefined}
 */
const keyString = (store, key) => {
  if (!Array.isArray(STORES[store].keyPath)) return isKey(key) ? key : undefined;
  return Array.isArray(key) && key.length === STORES[store].keyPath.length && key.every(isKey)
    ? JSON.stringify(key)
    : undefined;
};

/**
 * The key `record` is stored under in `store`, as keyString makes it
 * @param {StoreName} store
 * @param {Record<string, unknown>} record
 * @returns {string | undefined}
 */
const keyOf = (store, record) => {
  const { keyPath } = STORES[store];
  return keyString(store, Array.isArray(keyPath) ? keyPath.map(field => record[field]) : record[keyPath]);
};

/**
 * A key as a store's records give it: the id, or the array a keyString holds
 * @param {StoreName} store
 * @param {string} key
 * @returns {string}
 */
const keyFrom = (store, key) => (Array.isArray(STORES[store].keyPath) ? JSON.parse(key) : key);

/**
 * @param {string} a
 * @param {string} b
 */
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @typedef {{fingerprint: string, outcome?: Outcome}} KeptOutcome - a bulk command's has no outcome */

/**
 * @param {MemoryAdapterOptions} [options]
 * @returns {MemoryAdapter}
 */
export function createMemoryAdapter({ beforeWrite = () => {}, ledger, commitLog } = {}) {
  /** @type {Map<StoreName, Map<string, Record<string, unknown>>>} */
  const stores = new Map(/** @type {StoreName[]} */ (Object.keys(STORES)).map(name => [name, new Map()]));
  /** @type {Map<string, number>} */
  const revisions = new Map();
  /**
   * Each note's placement version and source revision, by revisionKey, as revisions are
   * @type {Map<string, number>}
   */
  const placements = new Map();
  /** @type {Map<string, number>} */
  const sources = new Map();
  /** @type {Map<string, KeptOutcome>} */
  const outcomes = new Map();
  /** @type {Record<ReadableSettingsArea, Map<string, unknown>>} */
  const settings = {
    preferences: new Map(),
    session: new Map(),
    jobs: new Map(),
    chat: new Map(),
    onboarding: new Map(),
    backup: new Map(),
    upgrade: new Map(),
    idbSettings: new Map(),
  };
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * Run `task` after every transaction opened before it.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const serial = task => {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /**
   * @param {StoreName} store
   * @param {string} key
   */
  const revisionKey = (store, key) => `${store}\0${key}`;

  /**
   * @param {StoreName} store
   * @returns {Map<string, Record<string, unknown>>}
   */
  const storeOf = store => {
    const records = stores.get(store);
    if (!records) throw new UnavailableError('adapter', 'unknown-store', false);
    return records;
  };

  /**
   * A committed note's content revision, 0 until something moves it. Folders carry no versions
   * (#17 PR 2a's rule, as on #17's adapter), so a folder has none.
   * @param {StoreName} store
   * @param {string} key
   * @returns {number | undefined}
   */
  const committedRevision = (store, key) => {
    if (store !== 'notes' || !storeOf(store).has(key)) return undefined;
    return revisions.get(revisionKey(store, key)) ?? 0;
  };

  /**
   * A committed note's three versions, or undefined for a key the notes store doesn't hold
   * @param {StoreName} store
   * @param {string} key
   * @returns {import('../ports/repository.js').Versions | undefined}
   */
  const committedVersions = (store, key) => {
    if (store !== 'notes' || !storeOf(store).has(key)) return undefined;
    const id = revisionKey(store, key);
    return {
      revision: revisions.get(id) ?? 0,
      placementVersion: placements.get(id) ?? 0,
      sourceRevision: sources.get(id) ?? 0,
    };
  };

  /**
   * A transaction over `scope`'s committed records and the writes `pending` holds. As in
   * IndexedDB, a store outside the scope can't be read or written. A revision is answered
   * only for a key this transaction got, as #17's adapter can only answer it.
   * @param {Map<string, {store: StoreName, key: string, record: Record<string, unknown> | undefined}> | null} pending
   * @param {'readonly' | 'readwrite'} mode
   * @param {readonly StoreName[]} scope
   * @returns {Tx}
   */
  const transaction = (pending, mode, scope) => {
    /** @type {Set<string>} */
    const got = new Set();
    /**
     * @param {StoreName} store
     * @returns {Map<string, Record<string, unknown>>}
     */
    const scoped = store => {
      if (!scope.includes(store)) throw new UnavailableError('adapter', 'store-outside-transaction', false);
      return storeOf(store);
    };
    /**
     * @param {StoreName} store
     * @param {string} key
     */
    const current = (store, key) => {
      const write = pending && pending.get(revisionKey(store, key));
      return write ? write.record : scoped(store).get(key);
    };
    /** @param {StoreName} store */
    const records = store => {
      const keys = new Set(scoped(store).keys());
      if (pending) for (const write of pending.values()) if (write.store === store) keys.add(write.key);
      return [...keys]
        .sort(byKey)
        .map(key => current(store, key))
        .filter(record => record !== undefined);
    };
    /**
     * The records whose `index` field holds `value`, which the port takes only as an id. Each
     * adapter refuses anything else, since IndexedDB reads null and undefined as every record.
     * @param {StoreName} store
     * @param {string} index
     * @param {unknown} value
     */
    const byIndex = (store, index, value) => {
      const all = records(store);
      if (!isKey(value)) throw new UnavailableError('adapter', 'invalid-key', false);
      return all.filter(record => record[index] === value);
    };
    /**
     * @param {StoreName} store
     * @param {string} key
     * @param {Record<string, unknown> | undefined} record
     */
    const write = (store, key, record) => {
      scoped(store);
      if (!pending || mode === 'readonly') {
        throw new UnavailableError('adapter', 'write-in-readonly-transaction', false);
      }
      if (!isKey(key)) throw new UnavailableError('adapter', 'invalid-key', false);
      beforeWrite(store, key);
      pending.set(revisionKey(store, key), { store, key, record: record && clone(record) });
    };
    return /** @type {Tx} */ ({
      get: async (store, key) => {
        scoped(store);
        const stored = keyString(store, key);
        const record = stored === undefined ? undefined : clone(current(store, stored));
        got.add(revisionKey(store, key));
        return record;
      },
      getAll: async store => clone(records(store)),
      getAllByIndex: async (store, index, value) => clone(byIndex(store, index, value)),
      getKeysByIndex: async (store, index, value) =>
        byIndex(store, index, value).map(record => keyFrom(store, /** @type {string} */ (keyOf(store, record)))),
      revision: (store, key) => {
        scoped(store);
        if (!got.has(revisionKey(store, key))) throw new UnavailableError('adapter', 'revision-before-get', false);
        return committedRevision(store, key);
      },
      versions: (store, key) => {
        scoped(store);
        if (!got.has(revisionKey(store, key))) throw new UnavailableError('adapter', 'revision-before-get', false);
        return committedVersions(store, key);
      },
      put: (store, record) =>
        write(store, /** @type {string} */ (keyOf(store, /** @type {Record<string, unknown>} */ (record))), record),
      delete: (store, key) => write(store, /** @type {string} */ (keyString(store, key)), undefined),
    });
  };

  /**
   * A commit's writes, by revisionKey: each record as it'll be stored, or undefined for a delete
   * @typedef {Map<string, {store: StoreName, key: string, record: Record<string, unknown> | undefined}>} Pending
   */

  /**
   * Moves the versions a commit moves, once its writes are in (ports/repository.js,
   * WriteScope): the primary note's content revision by one when a content command changed
   * its content, the placement version of every note a placement command put, and the primary
   * note's source revision to the Work.sourceRevision a derived command that put it carries. A
   * deleted note keeps only its content revision, as #17's tombstone keeps `lastRevision`.
   * Folders carry none, so a folder command moves nothing.
   * @param {Work} work
   * @param {Pending} pending
   * @returns {{store: StoreName, key: string} | null} the primary record, when its content revision moved
   */
  const moveVersions = (work, pending) => {
    const scope = work.scope || 'content';
    for (const { store, key, record } of pending.values()) {
      if (store !== 'notes') continue;
      const id = revisionKey(store, key);
      if (record === undefined) {
        placements.delete(id);
        sources.delete(id);
      } else if (scope === 'placement') {
        placements.set(id, (placements.get(id) ?? 0) + 1);
      }
    }
    const primary = work.primary && work.primary();
    if (!primary || !storeOf(primary.store).has(primary.key)) return null;
    const id = revisionKey(primary.store, primary.key);
    if (scope === 'derived' && work.sourceRevision !== undefined && pending.get(id)?.record !== undefined) {
      sources.set(id, work.sourceRevision);
    }
    if (primary.store !== 'notes' || scope !== 'content' || !work.revised || !work.revised()) return null;
    revisions.set(id, (revisions.get(id) || 0) + 1);
    return primary;
  };

  /**
   * The committed outcome, with the primary record's content revision
   * @param {Work} work
   * @returns {Outcome}
   */
  const finish = work => {
    const outcome = work.done();
    const primary = work.primary && work.primary();
    if (!primary) return outcome;
    const revision = committedRevision(primary.store, primary.key);
    return revision === undefined ? outcome : { ...outcome, revision };
  };

  /**
   * The entities a commit changed, for the commit log, typed by the store it wrote: each note
   * and folder it put or deleted, and the primary record when only its revision moved, as when
   * blocks were deleted from a note. So deleteFolder's notes, filed at the root, go in as notes.
   * @param {Pending} pending
   * @param {{store: StoreName, key: string} | null} moved
   * @returns {Array<{store: 'notes' | 'folders', key: string}>}
   */
  const changedEntities = (pending, moved) => {
    /** @type {Map<string, {store: 'notes' | 'folders', key: string}>} */
    const changed = new Map();
    for (const { store, key } of [...pending.values(), ...(moved ? [moved] : [])]) {
      if (store === 'notes' || store === 'folders') changed.set(revisionKey(store, key), { store, key });
    }
    return [...changed.values()];
  };

  /**
   * What a command's commit did: its outcome, the notes and folders it changed, and the keys of
   * the tombstones it put, which take the commit's seq once the log has it
   * @typedef {{outcome: Outcome, changed: Array<{store: 'notes' | 'folders', key: string}>, tombstones: string[]}} Applied
   */

  /**
   * The conflict record a command that lost is kept as, under its commandId in `conflicts`,
   * as #17's adapter keeps it (adapters/indexeddb/conflicts.js), so deleting the note drops it
   * @param {Work} work
   * @param {import('../contracts/outcomes.js').Conflict} conflict
   * @returns {Record<string, unknown>}
   */
  const conflictRecord = (work, conflict) => {
    const primary = work.primary && work.primary();
    const fields = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (work.command));
    const expected = conflict.code === 'placement-conflict' ? fields.expectedPlacementVersion : fields.expectedRevision;
    return {
      id: work.commandId,
      noteId: primary && primary.store === 'notes' ? primary.key : null,
      scope: work.scope || 'content',
      expected: typeof expected === 'number' ? expected : null,
      current: conflict.currentRevision,
      command: clone(work.command),
    };
  };

  /**
   * @param {Work} work
   * @returns {Promise<Applied>}
   */
  const apply = async work => {
    const { effect } = work;
    if (effect.kind === 'settings') {
      const entries = Object.entries(effect.values);
      for (const [key] of entries) beforeWrite(effect.area, key);
      for (const [key, value] of entries) settings[effect.area].set(key, clone(value));
      return { outcome: finish(work), changed: [], tombstones: [] };
    }
    // The legacy backup tasks run only on 1.4.x's Storage (the `backups` flag)
    if (effect.kind === 'backup') return { outcome: unavailable('adapter', 'backups-need-legacy-storage', false), changed: [] };
    // The read-only integrity check has nothing to check in memory, and changes nothing
    if (effect.kind === 'integrity-check') return { outcome: finish(work), changed: [] };
    if (effect.kind === 'maintenance') {
      /** @type {Array<[SettingsArea, Readonly<Record<string, unknown>>]>} */
      const defaults = [
        ['preferences', DEFAULT_PREFERENCES],
        ['session', DEFAULT_SESSION],
      ];
      for (const [area, values] of defaults) {
        for (const [key, value] of Object.entries(values)) {
          if (!settings[area].has(key)) settings[area].set(key, clone(value));
        }
      }
      return { outcome: finish(work), changed: [], tombstones: [] };
    }
    /** @type {Pending} */
    const pending = new Map();
    for (const unit of effect.units) {
      if (unit.when && !unit.when()) continue;
      const stop = await unit.run(transaction(pending, unit.mode || 'readwrite', unit.stores));
      if (stop) {
        if (stop.kind === 'conflict') storeOf('conflicts').set(work.commandId, conflictRecord(work, stop));
        return { outcome: stop, changed: [], tombstones: [] };
      }
    }
    // A deleted record's revision stays, as #17's tombstone keeps `lastRevision`, so a record
    // made again under its key carries on past it, and a save loaded before the delete is a
    // conflict
    for (const { store, key, record } of pending.values()) {
      if (record === undefined) storeOf(store).delete(key);
      else storeOf(store).set(key, record);
    }
    const moved = moveVersions(work, pending);
    // A note's tombstone gets the content revision it had, as #17's adapter fills it in
    /** @type {string[]} */
    const tombstones = [];
    for (const { store, key, record } of pending.values()) {
      if (store !== 'tombstones' || !record) continue;
      const filled = { ...record, seq: null };
      if (record.entityType === 'note') filled.lastRevision = revisions.get(revisionKey('notes', String(record.id))) ?? 0;
      storeOf('tombstones').set(key, filled);
      tombstones.push(key);
    }
    return { outcome: finish(work), changed: changedEntities(pending, moved), tombstones };
  };

  /**
   * The changes a committed command appends to the commit log: each entity it changed, at its
   * revision, or 0 for one that has none, which every folder is. Settings and maintenance
   * change no entity.
   * @param {Applied} applied
   * @returns {Change[]}
   */
  const changesOf = ({ outcome, changed }) => {
    if (outcome.kind !== 'committed') return [];
    return changed.map(({ store, key }) => ({
      entityType: store === 'notes' ? 'note' : 'folder',
      entityId: key,
      revision: store === 'notes' ? (revisions.get(revisionKey(store, key)) ?? 0) : 0,
    }));
  };

  /**
   * Writes the commit log, and the ledger for a catalog command's outcome, and answers it with
   * its commitSeq when the log took a change
   * @param {Work} work
   * @param {Applied} applied
   * @param {boolean} keyed - whether the work is a catalog command, which the ledger keeps
   * @returns {Outcome}
   */
  const log = (work, applied, keyed) => {
    const { outcome } = applied;
    const changes = commitLog ? changesOf(applied) : [];
    const kept = changes.length > 0 ? { ...outcome, commitSeq: commitLog?.append(changes) } : outcome;
    // The commit's tombstones carry its seq, as on #17's adapter
    if ('commitSeq' in kept) {
      for (const key of applied.tombstones) {
        const tombstone = storeOf('tombstones').get(key);
        if (tombstone) storeOf('tombstones').set(key, { ...tombstone, seq: kept.commitSeq });
      }
    }
    if (keyed && (kept.kind === 'committed' || kept.kind === 'conflict')) ledger?.record(work.command, kept);
    return kept;
  };

  /**
   * What the commandId already answered, or `idempotency-key-reuse` when it came with
   * another command. Undefined when it has no record, or a bulk command's record, which keeps
   * no outcome.
   * @param {string} commandId
   * @param {Command} command
   * @returns {Outcome | undefined}
   */
  const keptFor = (commandId, command) => {
    const kept = outcomes.get(commandId);
    if (!kept) return undefined;
    if (kept.fingerprint !== digestOf(command)) return rejected('validation', 'idempotency-key-reuse');
    return kept.outcome && clone(kept.outcome);
  };

  return Object.freeze({
    name: 'memory',
    flags: Object.freeze({ atomicMultiStore: true, revisions: true, idempotency: true, backups: false }),

    recall(command) {
      const kept = keptFor(command.commandId, command);
      // A bulk command keeps only its fingerprint, from its first recall, before any of its
      // items runs. The same commandId with another selection is refused before it writes,
      // even sent at the same time, and a resend runs again, each item answering from its own
      // record.
      if (kept === undefined && COMMANDS[command.type].bulk && !outcomes.has(command.commandId)) {
        outcomes.set(command.commandId, { fingerprint: digestOf(command) });
      }
      return kept;
    },

    commit(work) {
      return serial(async () => {
        // Only a catalog command has a key to keep: other work, such as #20's storage probe,
        // runs each time and keeps no record, as on #17's adapter
        const keyed = Object.hasOwn(COMMANDS, work.command.type);
        // A send of the same command that committed while this one waited its turn
        const kept = keyed ? keptFor(work.commandId, work.command) : undefined;
        if (kept) return { outcome: kept, replayed: kept.kind !== 'rejected' };
        /** @type {Applied} */
        let applied;
        try {
          applied = await apply(work);
        } catch (error) {
          return { outcome: unavailableFrom(error), replayed: false };
        }
        let { outcome } = applied;
        if (outcome.kind === 'committed' || outcome.kind === 'conflict') {
          outcome = log(work, applied, keyed);
          if (keyed) outcomes.set(work.commandId, { fingerprint: digestOf(work.command), outcome: clone(outcome) });
        }
        return { outcome, replayed: false };
      });
    },

    read(storeNames, body) {
      return serial(() => {
        for (const store of storeNames) storeOf(store);
        return body(transaction(null, 'readonly', storeNames));
      });
    },

    readSettings(area, keys) {
      return serial(async () => {
        if (area === 'idbSettings' && keys.some(key => !IDB_SETTINGS_KEYS.includes(key))) {
          throw new UnavailableError('adapter', 'setting-not-served', false);
        }
        /** @type {Record<string, unknown>} */
        const values = {};
        for (const key of keys) if (settings[area].has(key)) values[key] = clone(settings[area].get(key));
        return values;
      });
    },

    // The export file is 1.4.x's Storage code (the `backups` flag)
    exportBackup: () => Promise.reject(new UnavailableError('adapter', 'backups-need-legacy-storage', false)),

    conflicts: () =>
      [...storeOf('conflicts').values()].map(record => ({
        commandId: /** @type {string} */ (record.id),
        command: /** @type {Command} */ (clone(record.command)),
        currentRevision: /** @type {number} */ (record.current),
      })),
  });
}
