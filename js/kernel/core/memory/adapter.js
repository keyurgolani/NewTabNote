/**
 * The in-memory adapter (#12, "Layout"), with all three flags:
 * - atomicMultiStore: a command's units commit together, or nothing does
 * - revisions: a note has a content revision, which only a content command's change to its
 *   title or blocks moves (Work.scope, Work.revised). Committed outcomes report it, and a
 *   stale `expectedRevision` is a conflict, after which the adapter keeps the command. A note
 *   deleted and made again under its id carries on past the revision it had.
 * - idempotency: a commandId sent again with the same command gets its committed or conflict
 *   outcome again, and nothing runs; sent with another command it's `idempotency-key-reuse`.
 *   Rejections and `unavailable` outcomes aren't kept, so sending the command again runs it.
 *   A bulk command keeps only its fingerprint, from its first recall, so the same commandId
 *   with another selection is key reuse even when both are sent at once, and a resend runs
 *   again: each item that committed or conflicted answers from its own record, and each
 *   other item runs again. The same command is the same SHA-256 of its canonical JSON, keys
 *   sorted (memory/fingerprint.js), the digest #17 keeps, so no record holds the command.
 *
 * Transactions run one at a time, in the order they open, as IndexedDB runs readwrite
 * transactions over the same stores. Everything goes in and out as a copy.
 *
 * The contract suite runs against it, and `beforeWrite` lets a test make a write fail. #17
 * persists what it keeps: revisions, outcomes, and conflicts.
 *
 * Given #13's in-memory ledger and commit log (memory/ledger.js, memory/commit-log.js), it
 * writes them in the task that commits, as #17 writes its idempotency record and change-log
 * entry in the commit's transaction: a commit that changes notes or folders appends one change
 * per entity, with its revision, and its committed outcome carries that commitSeq. Then the
 * ledger keeps each committed or conflict outcome under its commandId. A resend appends and
 * records nothing again, and a bulk command's reservation stays the adapter's own, so its key
 * reads as absent there and each item's reads under its own.
 */

import { clone } from '../contracts/clone.js';
import { COMMANDS } from '../contracts/commands.js';
import { UnavailableError, rejected, unavailableFrom } from '../contracts/outcomes.js';
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
 * A conflict the adapter kept: the command that lost, and the revision it lost to. The
 * record that won is still in its store.
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
  /** @type {Map<string, KeptOutcome>} */
  const outcomes = new Map();
  /** @type {KeptConflict[]} */
  const conflicts = [];
  /** @type {Record<ReadableSettingsArea, Map<string, unknown>>} */
  const settings = { preferences: new Map(), session: new Map(), jobs: new Map(), idbSettings: new Map() };
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
   * @param {StoreName} store
   * @param {string} key
   * @returns {number | undefined}
   */
  const committedRevision = (store, key) =>
    storeOf(store).has(key) ? revisions.get(revisionKey(store, key)) : undefined;

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
        const record = clone(current(store, key));
        got.add(revisionKey(store, key));
        return record;
      },
      getAll: async store => clone(records(store)),
      getAllByIndex: async (store, index, value) => clone(byIndex(store, index, value)),
      getKeysByIndex: async (store, index, value) =>
        byIndex(store, index, value).map(record => /** @type {string} */ (record[STORES[store].keyPath])),
      revision: (store, key) => {
        scoped(store);
        if (!got.has(revisionKey(store, key))) throw new UnavailableError('adapter', 'revision-before-get', false);
        return committedRevision(store, key);
      },
      put: (store, record) => write(store, /** @type {string} */ (record[STORES[store].keyPath]), record),
      delete: (store, key) => write(store, key, undefined),
    });
  };

  /**
   * The committed outcome, with the primary record's revision: one more than before when a
   * content command changed its content, and where it was otherwise. A placement or derived
   * command never moves it (ports/repository.js, WriteScope).
   * @param {Work} work
   * @returns {Outcome}
   */
  const finish = work => {
    const outcome = work.done();
    const primary = work.primary && work.primary();
    if (!primary) return outcome;
    const content = (work.scope || 'content') === 'content';
    if (content && work.revised && work.revised() && storeOf(primary.store).has(primary.key)) {
      const id = revisionKey(primary.store, primary.key);
      revisions.set(id, (revisions.get(id) || 0) + 1);
    }
    const revision = committedRevision(primary.store, primary.key);
    return revision === undefined ? outcome : { ...outcome, revision };
  };

  /**
   * @param {Work} work
   * @returns {Promise<Outcome>}
   */
  const apply = async work => {
    const { effect } = work;
    if (effect.kind === 'settings') {
      const entries = Object.entries(effect.values);
      for (const [key] of entries) beforeWrite(effect.area, key);
      for (const [key, value] of entries) settings[effect.area].set(key, clone(value));
      return finish(work);
    }
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
      return finish(work);
    }
    /** @type {Map<string, {store: StoreName, key: string, record: Record<string, unknown> | undefined}>} */
    const pending = new Map();
    for (const unit of effect.units) {
      if (unit.when && !unit.when()) continue;
      const stop = await unit.run(transaction(pending, unit.mode || 'readwrite', unit.stores));
      if (stop) {
        if (stop.kind === 'conflict') {
          conflicts.push({
            commandId: work.commandId,
            command: clone(work.command),
            currentRevision: stop.currentRevision,
          });
        }
        return stop;
      }
    }
    // A deleted record's revision stays, as #17's tombstone keeps `lastRevision`, so a record
    // made again under its key carries on past it, and a save loaded before the delete is a
    // conflict
    for (const { store, key, record } of pending.values()) {
      if (record === undefined) storeOf(store).delete(key);
      else storeOf(store).set(key, record);
    }
    return finish(work);
  };

  /**
   * The entities a committed command changed, for the commit log: notes and folders, each at
   * its revision, or 0 for one that has none. Settings and maintenance change no entity.
   * @param {Work} work
   * @param {Outcome} outcome
   * @returns {Change[]}
   */
  const changesOf = (work, outcome) => {
    if (outcome.kind !== 'committed') return [];
    const { aggregate } = COMMANDS[work.command.type];
    if (aggregate !== 'note' && aggregate !== 'folder') return [];
    /** @type {StoreName} */
    const store = aggregate === 'note' ? 'notes' : 'folders';
    return outcome.changedIds.map(entityId => ({
      entityType: aggregate,
      entityId,
      revision: revisions.get(revisionKey(store, entityId)) ?? 0,
    }));
  };

  /**
   * Writes the commit log and the ledger for an outcome the adapter keeps, and answers it with
   * its commitSeq when the log took a change
   * @param {Work} work
   * @param {Outcome} outcome
   * @returns {Outcome}
   */
  const log = (work, outcome) => {
    const changes = commitLog ? changesOf(work, outcome) : [];
    const kept = changes.length > 0 ? { ...outcome, commitSeq: commitLog?.append(changes) } : outcome;
    if (kept.kind === 'committed' || kept.kind === 'conflict') ledger?.record(work.command, kept);
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
    flags: Object.freeze({ atomicMultiStore: true, revisions: true, idempotency: true }),

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
        // A send of the same command that committed while this one waited its turn
        const kept = keptFor(work.commandId, work.command);
        if (kept) return { outcome: kept, replayed: kept.kind !== 'rejected' };
        /** @type {Outcome} */
        let outcome;
        try {
          outcome = await apply(work);
        } catch (error) {
          return { outcome: unavailableFrom(error), replayed: false };
        }
        if (outcome.kind === 'committed' || outcome.kind === 'conflict') {
          outcome = log(work, outcome);
          outcomes.set(work.commandId, { fingerprint: digestOf(work.command), outcome: clone(outcome) });
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

    conflicts: () => clone(conflicts),
  });
}
