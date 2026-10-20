/**
 * The in-memory adapter (#12, "Layout"), with all three flags:
 * - atomicMultiStore: a command's units commit together, or nothing does
 * - revisions: every record has one, committed outcomes report it, and a stale
 *   `expectedRevision` is a conflict, after which the adapter keeps the command
 * - idempotency: a commandId that already has an outcome gets that outcome again, and
 *   nothing runs. An `unavailable` outcome isn't kept, so resending the command retries it.
 *
 * Transactions run one at a time, in the order they open, as IndexedDB runs readwrite
 * transactions over the same stores. Everything goes in and out as a copy.
 *
 * The contract suite runs against it, and `beforeWrite` lets a test make a write fail. #17
 * persists what it keeps: revisions, outcomes, and conflicts.
 */

import { clone } from '../contracts/clone.js';
import { UnavailableError, unavailableFrom } from '../contracts/outcomes.js';
import { DEFAULT_PREFERENCES } from '../domain/preferences.js';
import { STORES } from '../ports/repository.js';

/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
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
 * @param {MemoryAdapterOptions} [options]
 * @returns {MemoryAdapter}
 */
export function createMemoryAdapter({ beforeWrite = () => {} } = {}) {
  /** @type {Map<StoreName, Map<string, Record<string, unknown>>>} */
  const stores = new Map(/** @type {StoreName[]} */ (Object.keys(STORES)).map(name => [name, new Map()]));
  /** @type {Map<string, number>} */
  const revisions = new Map();
  /** @type {Map<string, Outcome>} */
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
   * IndexedDB, a store outside the scope can't be read or written.
   * @param {Map<string, {store: StoreName, key: string, record: Record<string, unknown> | undefined}> | null} pending
   * @param {'readonly' | 'readwrite'} mode
   * @param {readonly StoreName[]} scope
   * @returns {Tx}
   */
  const transaction = (pending, mode, scope) => {
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
      get: async (store, key) => clone(current(store, key)),
      getAll: async store => clone(records(store)),
      getAllByIndex: async (store, index, value) => clone(records(store).filter(record => record[index] === value)),
      getKeysByIndex: async (store, index, value) =>
        records(store)
          .filter(record => record[index] === value)
          .map(record => /** @type {string} */ (record[STORES[store].keyPath])),
      revision: (store, key) => {
        scoped(store);
        return committedRevision(store, key);
      },
      put: (store, record) => write(store, /** @type {string} */ (record[STORES[store].keyPath]), record),
      delete: (store, key) => write(store, key, undefined),
    });
  };

  /**
   * The committed outcome, with the primary record's new revision.
   * @param {Work} work
   * @returns {Outcome}
   */
  const finish = work => {
    const outcome = work.done();
    const primary = work.primary && work.primary();
    const revision = primary && committedRevision(primary.store, primary.key);
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
      for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
        if (!settings.preferences.has(key)) settings.preferences.set(key, clone(value));
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
    for (const { store, key, record } of pending.values()) {
      const id = revisionKey(store, key);
      revisions.set(id, (revisions.get(id) || 0) + 1);
      if (record === undefined) storeOf(store).delete(key);
      else storeOf(store).set(key, record);
    }
    return finish(work);
  };

  return Object.freeze({
    name: 'memory',
    flags: Object.freeze({ atomicMultiStore: true, revisions: true, idempotency: true }),

    recall(commandId) {
      const outcome = outcomes.get(commandId);
      return outcome && clone(outcome);
    },

    commit(work) {
      return serial(async () => {
        const kept = outcomes.get(work.commandId);
        if (kept) return clone(kept);
        /** @type {Outcome} */
        let outcome;
        try {
          outcome = await apply(work);
        } catch (error) {
          return unavailableFrom(error);
        }
        outcomes.set(work.commandId, clone(outcome));
        return outcome;
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
