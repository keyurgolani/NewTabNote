'use strict';

/**
 * The store hold, #28 slice 4's hung-repository fault (#301): a readwrite transaction another
 * context keeps busy over a database's stores until the case releases it, so a write to one of
 * them waits behind it for as long as the case says, or an upgrade kept open, so every other open
 * of the database waits. The close-drafts and journal specs hold the blocks while a tab closes,
 * and #2, #6 and #26 can hold a page's repository mid-call. Nothing under test/support/ ships.
 *
 *   const hold = await holdStores(popup, ['elements']);  // a Page or Worker, or an IDBFactory in Node
 *   // ... a write to elements waits
 *   await hold.stillHeld('once the tab has closed');    // throws unless the hold still holds
 *   expect(await hold.release()).toBe('complete');
 *
 * holdStores resolves once its first get has succeeded, so its transaction holds the stores, not
 * merely exists. holdUpgrade opens the database one version up and keeps the upgrade busy, and its
 * release aborts the upgrade, so the version stays as it was. Another context's connection that
 * stays open through the versionchange keeps the upgrade from starting, and then holdUpgrade fails
 * 10 s after its open hears blocked, naming the database. Once a hold holds, it has no time limit:
 * only its release, its context's end, or its connection's end ends it, so a case that fails
 * mid-hold has it ended by its teardown's close of the context. One that ended before its release
 * makes release() and stillHeld() fail at once, naming its database and stores.
 *
 * startStoreHold, readStoreHold and releaseStoreHold run in the context the hold is made from and
 * hold nothing from outside themselves, so they go in through evaluate as they are. In Node they
 * take a scope of their own, { indexedDB: factory }.
 */

/**
 * @typedef {{id: string, database: string, stores: string[], upgrade: boolean}} HoldPlan
 * @typedef {{holding: boolean, how: string | null}} HoldState
 * @typedef {{
 *   active: () => Promise<boolean>,
 *   stillHeld: (when: string) => Promise<void>,
 *   release: () => Promise<string>,
 * }} Hold
 */

/**
 * Starts a hold in `scope`, a global with indexedDB, and resolves once it holds
 * @param {HoldPlan} plan
 * @param {any} [scope]
 * @returns {Promise<void>}
 */
function startStoreHold(plan, scope = globalThis) {
  const holds = (scope.__ntnStoreHolds = scope.__ntnStoreHolds || new Map());
  const what = plan.upgrade ? `${plan.database}'s upgrade` : `${plan.database}'s ${plan.stores.join(', ')}`;
  return new Promise((resolve, reject) => {
    /** @type {any} */
    const hold = { what, upgrade: plan.upgrade, holding: false, released: false, how: null, tx: null, db: null };
    hold.ended = new Promise(settle => {
      hold.end = (/** @type {string} */ how) => () => {
        if (hold.how !== null) return;
        hold.holding = false;
        hold.how = how;
        if (hold.db) hold.db.close();
        settle(how);
        reject(new Error(`the hold on ${what} ended (${how}) before it held`));
      };
    });
    // A get on a key nobody writes keeps the transaction busy, one request at a time, until the release
    const spin = (/** @type {string} */ store) => {
      hold.tx.objectStore(store).get('ntn-hold').onsuccess = () => {
        if (!hold.holding && hold.how === null) {
          hold.holding = true;
          holds.set(plan.id, hold);
          resolve();
        }
        if (!hold.released) spin(store);
      };
    };
    let none = false;
    const refused = (/** @type {any} */ request) => () =>
      reject(new Error(`the hold on ${what} couldn't open ${plan.database}: ${none ? 'it isn\'t there' : request.error && request.error.name}`));
    const probe = scope.indexedDB.open(plan.database);
    // The database isn't there, and the hold makes none
    probe.onupgradeneeded = () => {
      none = true;
      probe.transaction.abort();
    };
    probe.onerror = refused(probe);
    probe.onsuccess = () => {
      if (!plan.upgrade) {
        hold.db = probe.result;
        try {
          hold.tx = hold.db.transaction(plan.stores, 'readwrite');
        } catch (error) {
          hold.db.close();
          reject(new Error(`the hold on ${what} couldn't start: ${error instanceof Error ? error.message : error}`));
          return;
        }
        hold.tx.oncomplete = hold.end('complete');
        hold.tx.onabort = hold.end('abort');
        hold.db.onclose = hold.end('closed');
        spin(plan.stores[0]);
        return;
      }
      const version = probe.result.version;
      probe.result.close();
      const open = scope.indexedDB.open(plan.database, version + 1);
      // Another connection that stays open through the versionchange keeps the upgrade from
      // starting, so the hold fails once it has stayed open this long after the open heard so, and
      // an upgrade that starts after that goes straight back
      const blockedBoundMs = 10_000;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let blocked;
      let late = false;
      open.onblocked = () => {
        if (blocked !== undefined) return;
        blocked = setTimeout(() => {
          late = true;
          reject(new Error(`the hold on ${what} couldn't start: another connection to ${plan.database} stayed open ${blockedBoundMs / 1000} s after its versionchange`));
        }, blockedBoundMs);
      };
      open.onupgradeneeded = () => {
        clearTimeout(blocked);
        if (late) {
          open.transaction.abort();
          return;
        }
        hold.db = open.result;
        hold.tx = open.transaction;
        hold.tx.oncomplete = hold.end('complete');
        hold.tx.onabort = hold.end('abort');
        // A store to spin on: the database's first, or one the abort takes back
        const names = hold.db.objectStoreNames;
        spin(names.length > 0 ? names[0] : hold.db.createObjectStore('ntn-hold').name);
      };
      // The release's abort fails the open too, which is how a held upgrade ends
      open.onerror = refused(open);
      open.onsuccess = () => open.result.close();
    };
  });
}

/**
 * Whether hold `id` still holds, and how it ended if it doesn't
 * @param {{id: string}} plan
 * @param {any} [scope]
 * @returns {HoldState}
 */
function readStoreHold({ id }, scope = globalThis) {
  const hold = scope.__ntnStoreHolds && scope.__ntnStoreHolds.get(id);
  if (!hold) throw new Error(`there's no hold ${id} here`);
  return { holding: hold.holding, how: hold.how };
}

/**
 * Ends hold `id` and answers how it ended: `complete` once a store hold's transaction has
 * committed, `abort` once an upgrade's has rolled back. A hold that ended first fails at once.
 * @param {{id: string}} plan
 * @param {any} [scope]
 * @returns {Promise<string>}
 */
function releaseStoreHold({ id }, scope = globalThis) {
  const hold = scope.__ntnStoreHolds && scope.__ntnStoreHolds.get(id);
  if (!hold) throw new Error(`there's no hold ${id} here`);
  scope.__ntnStoreHolds.delete(id);
  if (hold.how !== null) throw new Error(`the hold on ${hold.what} ended (${hold.how}) before its release`);
  hold.released = true;
  if (hold.upgrade) hold.tx.abort();
  return hold.ended;
}

let holdCount = 0;

/**
 * Runs one of the functions above where the hold is: in a Page or Worker through evaluate, or in
 * Node on the factory's scope
 * @param {any} target
 * @returns {(fn: Function, arg: object) => Promise<any>}
 */
function runnerFor(target) {
  if (typeof target.evaluate === 'function') return (fn, arg) => target.evaluate(fn, arg);
  const scope = { indexedDB: target };
  return async (fn, arg) => fn(arg, scope);
}

/**
 * @param {any} target
 * @param {Omit<HoldPlan, 'id'>} plan
 * @returns {Promise<Hold>}
 */
async function startHold(target, plan) {
  const run = runnerFor(target);
  const id = `ntn-hold-${process.pid}-${++holdCount}`;
  const what = plan.upgrade ? `${plan.database}'s upgrade` : `${plan.database}'s ${plan.stores.join(', ')}`;
  await run(startStoreHold, { id, ...plan });
  /** A call into the hold's context, whose failure names the hold */
  const call = async (/** @type {Function} */ fn, /** @type {string} */ doing) => {
    try {
      return await run(fn, { id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.includes(what) ? message : `the hold on ${what} can't be read ${doing}: ${message}`);
    }
  };
  /** @type {Hold} */
  const hold = {
    active: async () => (await call(readStoreHold, 'now')).holding,
    async stillHeld(when) {
      const state = await call(readStoreHold, when);
      if (state.holding) return;
      throw new Error(`the hold on ${what} no longer holds ${when}: it ended (${state.how})`);
    },
    release: () => call(releaseStoreHold, 'at its release'),
  };
  return hold;
}

/**
 * Holds `stores` of `database` in a readwrite transaction from `target`, a Playwright Page or
 * Worker, or an IDBFactory in Node, until its release
 * @param {any} target
 * @param {string[]} stores
 * @param {{database?: string}} [options]
 * @returns {Promise<Hold>}
 */
function holdStores(target, stores, { database = 'CanvasTabDB' } = {}) {
  return startHold(target, { database, stores: [...stores], upgrade: false });
}

/**
 * Holds `database`'s upgrade one version up from `target`, so every other open of it waits until
 * the release, which rolls the upgrade back
 * @param {any} target
 * @param {{database?: string}} [options]
 * @returns {Promise<Hold>}
 */
function holdUpgrade(target, { database = 'CanvasTabDB' } = {}) {
  return startHold(target, { database, stores: [], upgrade: true });
}

module.exports = { holdStores, holdUpgrade, startStoreHold, readStoreHold, releaseStoreHold };
