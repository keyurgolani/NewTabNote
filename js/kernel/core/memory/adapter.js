/**
 * The in-memory adapter (#12, "Layout"), with all three flags:
 * - atomicMultiStore: a command's units commit together, or nothing does
 * - revisions: a note has a content revision, which only a change to its title or blocks
 *   moves (Work.revised). Committed outcomes report it, and a stale `expectedRevision` is a
 *   conflict, after which the adapter keeps the command. A note deleted and made again under
 *   its id carries on past the revision it had.
 * - idempotency: a commandId sent again with the same command gets its committed or conflict
 *   outcome again, and nothing runs; sent with another command it's `idempotency-key-reuse`.
 *   A bulk command's outcome is kept once any of its items' outcomes is, so a bulk command
 *   sent again answers with the same items. Rejections and `unavailable` outcomes aren't
 *   kept, so sending the command again runs it. The same command is the same canonical JSON,
 *   keys sorted, which #17 hashes instead.
 *
 * Transactions run one at a time, in the order they open, as IndexedDB runs readwrite
 * transactions over the same stores. Everything goes in and out as a copy.
 *
 * The contract suite runs against it, and `beforeWrite` lets a test make a write fail. #17
 * persists what it keeps: revisions, outcomes, and conflicts.
 */

import { clone } from '../contracts/clone.js';
import { UnavailableError, rejected, unavailableFrom } from '../contracts/outcomes.js';
import { DEFAULT_PREFERENCES } from '../domain/preferences.js';
import { DEFAULT_SESSION } from '../domain/session.js';
import { STORES } from '../ports/repository.js';

/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../ports/repository.js').CommitResult} CommitResult */
/** @typedef {import('../ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../ports/repository.js').StoreName} StoreName */
/** @typedef {import('../ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../ports/repository.js').Tx} Tx */
/** @typedef {import('../ports/repository.js').ReadTx} ReadTx */
/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../ports/repository.js').Work} Work */

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

/**
 * `value` with every object's keys in sorted order, so two copies of one command serialize alike
 * @param {unknown} value
 * @returns {unknown}
 */
const sortedKeys = value => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(
    Object.keys(record)
      .sort(byKey)
      .map(key => [key, sortedKeys(record[key])]),
  );
};

/**
 * What tells one command from another under the same commandId: its canonical JSON
 * @param {Command} command
 * @returns {string}
 */
const fingerprintOf = command => JSON.stringify(sortedKeys(command));

/**
 * Whether a commandId keeps this outcome: a commit or a conflict, or a bulk outcome once any
 * of its items' outcomes is one
 * @param {Outcome | BulkOutcome} outcome
 * @returns {boolean}
 */
const isKept = outcome =>
  outcome.kind === 'bulk'
    ? outcome.items.some(item => isKept(item.outcome))
    : outcome.kind === 'committed' || outcome.kind === 'conflict';

/** @typedef {{fingerprint: string, outcome: Outcome | BulkOutcome}} KeptOutcome */

/**
 * @param {MemoryAdapterOptions} [options]
 * @returns {MemoryAdapter}
 */
export function createMemoryAdapter({ beforeWrite = () => {} } = {}) {
  /** @type {Map<StoreName, Map<string, Record<string, unknown>>>} */
  const stores = new Map(/** @type {StoreName[]} */ (Object.keys(STORES)).map(name => [name, new Map()]));
  /** @type {Map<string, number>} */
  const revisions = new Map();
  /** @type {Map<string, KeptOutcome>} */
  const outcomes = new Map();
  /** @type {KeptConflict[]} */
  const conflicts = [];
  /** @type {Record<SettingsArea, Map<string, unknown>>} */
  const settings = { preferences: new Map(), session: new Map() };
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
      getAllByIndex: async (store, index, value) => clone(records(store).filter(record => record[index] === value)),
      getKeysByIndex: async (store, index, value) =>
        records(store)
          .filter(record => record[index] === value)
          .map(record => /** @type {string} */ (record[STORES[store].keyPath])),
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
   * The committed outcome, with the primary record's revision: one more than before when the
   * command changed its content, and where it was otherwise.
   * @param {Work} work
   * @returns {Outcome | BulkOutcome}
   */
  const finish = work => {
    const outcome = work.done();
    const primary = work.primary && work.primary();
    if (!primary || outcome.kind === 'bulk') return outcome;
    if (work.revised && work.revised() && storeOf(primary.store).has(primary.key)) {
      const id = revisionKey(primary.store, primary.key);
      revisions.set(id, (revisions.get(id) || 0) + 1);
    }
    const revision = committedRevision(primary.store, primary.key);
    return revision === undefined ? outcome : { ...outcome, revision };
  };

  /**
   * @param {Work} work
   * @returns {Promise<Outcome | BulkOutcome>}
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
   * What the commandId already answered, or `idempotency-key-reuse` when it came with
   * another command. Undefined when it has no record.
   * @param {string} commandId
   * @param {Command} command
   * @returns {Outcome | BulkOutcome | undefined}
   */
  const keptFor = (commandId, command) => {
    const kept = outcomes.get(commandId);
    if (!kept) return undefined;
    if (kept.fingerprint !== fingerprintOf(command)) return rejected('validation', 'idempotency-key-reuse');
    return clone(kept.outcome);
  };

  return Object.freeze({
    name: 'memory',
    flags: Object.freeze({ atomicMultiStore: true, revisions: true, idempotency: true }),

    recall(command) {
      return keptFor(command.commandId, command);
    },

    commit(work) {
      return serial(async () => {
        // A send of the same command that committed while this one waited its turn
        const kept = keptFor(work.commandId, work.command);
        if (kept) return { outcome: kept, replayed: kept.kind !== 'rejected' };
        /** @type {Outcome | BulkOutcome} */
        let outcome;
        try {
          outcome = await apply(work);
        } catch (error) {
          return { outcome: unavailableFrom(error), replayed: false };
        }
        if (isKept(outcome)) {
          outcomes.set(work.commandId, { fingerprint: fingerprintOf(work.command), outcome: clone(outcome) });
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
        /** @type {Record<string, unknown>} */
        const values = {};
        for (const key of keys) if (settings[area].has(key)) values[key] = clone(settings[area].get(key));
        return values;
      });
    },

    conflicts: () => clone(conflicts),
  });
}
