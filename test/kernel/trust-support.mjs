// Test doubles for #20's trust core: a settings area with chrome.storage.local's get and set,
// Web Locks that run one callback per name at a time, timers on a test clock, and the two
// trust stores (the memory one and NewTabNoteTrust over fake-indexeddb) as contexts of one
// browser profile.

import { createRequire } from 'node:module';

import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { faultyFactory } from './storage-faults.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {import('../../js/trust/core/ports.js').SettingsPort} SettingsPort */
/** @typedef {import('../../js/trust/core/ports.js').Locks} Locks */

const requireCommonJs = createRequire(import.meta.url);
/** @type {{IDBFactory: new () => IDBFactory, IDBKeyRange: {upperBound(bound: unknown, open?: boolean): IDBKeyRange}}} */
const fake = requireCommonJs('fake-indexeddb');

/**
 * A settings area: what's stored, every set it took, and failures to inject
 * @returns {SettingsPort & {items: Map<string, unknown>, sets: Record<string, unknown>[], failSets: number, failGets: number}}
 */
export function settingsArea() {
  const items = new Map();
  /** @type {Record<string, unknown>[]} */
  const sets = [];
  const area = {
    items,
    sets,
    failSets: 0,
    failGets: 0,
    /** @param {string[]} keys */
    async get(keys) {
      if (area.failGets > 0) {
        area.failGets--;
        throw new Error('settings read failed');
      }
      /** @type {Record<string, unknown>} */
      const found = {};
      for (const key of keys) if (items.has(key)) found[key] = JSON.parse(JSON.stringify(items.get(key)));
      return found;
    },
    /** @param {Record<string, unknown>} values */
    async set(values) {
      if (area.failSets > 0) {
        area.failSets--;
        throw new Error('settings write failed');
      }
      sets.push(JSON.parse(JSON.stringify(values)));
      for (const [key, value] of Object.entries(values)) items.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
  return area;
}

/**
 * Web Locks shared by every context of a profile: one callback per name at a time
 * @returns {Locks}
 */
export function lockManager() {
  /** @type {Map<string, Promise<unknown>>} */
  const held = new Map();
  return {
    request(name, callback) {
      const before = held.get(name) || Promise.resolve();
      const turn = before.then(() => callback());
      held.set(
        name,
        turn.catch(() => {}),
      );
      return turn;
    },
  };
}

/**
 * A clock tests move by hand
 * @param {number} [start]
 */
export function manualClock(start = NOW) {
  let now = start;
  return {
    now: () => now,
    /** @param {number} ms */
    advance(ms) {
      now += ms;
    },
    /** @param {number} at */
    set(at) {
      now = at;
    },
  };
}

/**
 * Timers that run when a test fires them, or never
 */
export function manualTimers() {
  /** @type {Map<number, () => void>} */
  const pending = new Map();
  let next = 1;
  return {
    pending,
    /** @param {() => void} callback */
    set(callback) {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    /** @param {unknown} handle */
    clear(handle) {
      pending.delete(/** @type {number} */ (handle));
    },
    fireAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

/** Real timers, for the check timeouts tests don't fire by hand */
export const realTimers = Object.freeze({
  /** @param {() => void} callback @param {number} ms */
  set: (callback, ms) => setTimeout(callback, ms),
  /** @param {unknown} handle */
  clear: handle => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
});

/**
 * Ids a test can read: a hex prefix, then a count, so each incident's ref differs
 * @param {string} [prefix]
 */
export function hexIds(prefix = 'a1b2') {
  let n = 0;
  return { next: () => `${prefix}${(++n).toString(16).padStart(4, '0')}-0000-4000-8000-000000000000` };
}

/**
 * `store` with runs a test can make fail: the next `count` runs reject with an
 * UnavailableError of `code`, as a store whose writes the disk refuses does
 * @param {TrustStore} store
 */
export function flakyStore(store) {
  const plan = {
    count: 0,
    cause: /** @type {import('../../js/kernel/core/contracts/outcomes.js').UnavailableCause} */ ('storage'),
    code: 'unreadable',
    /** Whether the next failure is a TypeError, as a programming error throws, not an UnavailableError */
    typeError: false,
  };
  return {
    store: /** @type {TrustStore} */ ({
      open: () => store.open(),
      close: () => store.close(),
      run: (stores, mode, unit) => {
        if (plan.count > 0) {
          plan.count--;
          if (plan.typeError) return Promise.reject(new TypeError('a store that broke'));
          return Promise.reject(new UnavailableError(plan.cause, plan.code, false));
        }
        return store.run(stores, mode, unit);
      },
    }),
    /** @param {number} count @param {string} [code] @param {{typeError?: boolean}} [options] */
    failNext(count, code = 'unreadable', { typeError = false } = {}) {
      plan.count = count;
      plan.code = code;
      plan.typeError = typeError;
    },
  };
}

/**
 * One browser profile: a fake-indexeddb factory behind the fault wrapper, its settings area,
 * and its locks
 */
export function trustProfile() {
  const real = new fake.IDBFactory();
  return { real, faults: faultyFactory(real), settings: settingsArea(), locks: lockManager() };
}

/** @typedef {ReturnType<typeof trustProfile>} TrustProfile */

/** fake-indexeddb's IDBKeyRange, which NewTabNoteTrust's adapter takes in Node */
export const fakeKeyRange = fake.IDBKeyRange;

/**
 * NewTabNoteTrust over `profile`'s factory
 * @param {TrustProfile} profile
 */
export function databaseOn(profile) {
  return createTrustDatabase({ indexedDB: profile.faults.factory, keyRange: fake.IDBKeyRange });
}

/** A factory whose every open throws, as IndexedDB does in a profile that can't open it */
export const brokenFactory = /** @type {IDBFactory} */ (
  /** @type {unknown} */ ({
    open() {
      throw new DOMException('The database could not be opened', 'UnknownError');
    },
  })
);

/**
 * Records over `store` in `profile`, opened
 * @param {TrustStore} store
 * @param {TrustProfile} profile
 * @param {{clock?: ReturnType<typeof manualClock>, ids?: {next(): string}}} [options]
 */
export async function openRecords(store, profile, { clock = manualClock(), ids = hexIds() } = {}) {
  const records = createTrustRecords({ store, settings: profile.settings, clock, ids, locks: profile.locks });
  const opened = await records.open();
  return { records, clock, ids, opened };
}

/**
 * Every record in every store of `real`'s NewTabNoteTrust, as JSON, for canary searches
 * @param {IDBFactory} real
 * @returns {Promise<string>}
 */
export async function dumpTrustDatabase(real) {
  const db = await new Promise((resolve, reject) => {
    const request = real.open('NewTabNoteTrust');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  /** @type {Record<string, unknown[]>} */
  const dump = {};
  for (const name of [.../** @type {IDBDatabase} */ (db).objectStoreNames]) {
    dump[name] = await new Promise((resolve, reject) => {
      const request = /** @type {IDBDatabase} */ (db).transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  /** @type {IDBDatabase} */ (db).close();
  return JSON.stringify(dump);
}
