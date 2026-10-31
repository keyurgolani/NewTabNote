'use strict';

// #20's slice 4 prerequisites, part 2 (on #17 PR 1b): the worker journals its migration run.
// A run that stops short of space, or waits on an older build's open page, journals
// storage.migration-blocked; one that fails with version 8 left working journals
// storage.migration-failed; one that upgrades a 1.4.x database journals
// storage.migration-completed. A blocked upgrade no longer journals storage.open-failed, and no
// migration event raises an incident: capture keeps working at 8, and storage's check reports
// the state. Each event holds value-free evidence only, and the same one is journaled once per
// worker start however often a page's request runs it again, and once across worker starts
// while the record or the blocked marker says the same.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { IDBKeyRange, IDBFactory } = require('fake-indexeddb');
const { createLegacyEnv, createDatabase, note, block } = require('./helpers/legacy-env');
const { loadBackground, startWorker } = require('./helpers/load-background');

// This build's version, which the worker's run brings a profile to (js/storage.js's dbVersion)
const THIS_VERSION = 11;

/** @type {any} */
let core;
/** @type {any} */
let support;

before(async () => {
  support = await import('./kernel/trust-support.mjs');
  core = {
    ...(await import('../js/trust/core/trust-records.js')),
    ...(await import('../js/kernel/adapters/indexeddb/trust.js')),
  };
});

/** What NewTabNoteTrust in `factory` holds: its events and incidents */
async function inspect(factory) {
  const store = core.createTrustDatabase({ indexedDB: factory, keyRange: IDBKeyRange });
  const clock = { now: () => Date.now() };
  const records = core.createTrustRecords({ store, settings: support.settingsArea(), clock, ids: { next: () => crypto.randomUUID() } });
  await records.open();
  const events = (await records.events()).filter(event => !event.code.startsWith('diagnostics.'));
  const incidents = await records.incidents();
  store.close();
  return { events: events.map(event => [event.code, event.fields]), incidents };
}

/** A 1.4.x database at version 8, with a note */
async function profileAt8(env) {
  await createDatabase(env.indexedDB, {
    records: { canvases: [note('n1', { name: 'Groceries' })], elements: [block('b1', 'n1', 0, 'Milk')] },
  });
}

const codes = seen => seen.events.map(([code]) => code);

describe("the worker journals its migration run (js/background.js, #17's runner)", () => {
  it("a 1.4.x database upgraded to this build's version journals storage.migration-completed, with no incident", async () => {
    const worker = await loadBackground({ setup: profileAt8 });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(seen.events, [['storage.migration-completed', { schemaVersion: THIS_VERSION, surface: 'worker-internal' }]]);
    assert.deepEqual(seen.incidents, []);
  });

  it('a fresh profile, whose run only makes the database, journals nothing', async () => {
    const worker = await loadBackground();
    await worker.drain();
    const opened = await worker.indexedDB.databases();
    assert.ok(!opened.some(database => database.name === 'NewTabNoteTrust'), 'it opened NewTabNoteTrust');
  });

  it('a run short of space journals storage.migration-blocked once, with the reason, and leaves 8 working', async () => {
    const worker = await loadBackground({
      opens: false,
      setup: async env => {
        await profileAt8(env);
        env.global.navigator.storage = { estimate: async () => ({ quota: 100 * 1024 ** 2, usage: 99 * 1024 ** 2 }) };
      },
    });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(seen.events, [
      ['storage.migration-blocked', { errorCode: 'space-short', schemaVersion: THIS_VERSION, surface: 'worker-internal' }],
    ]);
    assert.deepEqual(seen.incidents, []);
  });

  it('an upgrade an older build holds journals storage.migration-blocked, never storage.open-failed, then completed once it goes', async () => {
    const worker = await loadBackground({
      opens: false,
      setup: async env => {
        await profileAt8(env);
        // An older build's page that closes only a while after the upgrade asks it to
        const blocker = await new Promise((resolve, reject) => {
          const request = env.indexedDB.open('CanvasTabDB');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        blocker.onversionchange = () => setTimeout(() => blocker.close(), 300);
      },
    });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(seen.events, [
      ['storage.migration-blocked', { errorCode: 'blocked-upgrade', schemaVersion: THIS_VERSION, surface: 'worker-internal' }],
      ['storage.migration-completed', { schemaVersion: THIS_VERSION, surface: 'worker-internal' }],
    ]);
    assert.ok(!codes(seen).includes('storage.open-failed'));
    assert.deepEqual(seen.incidents, []);
  });

  it('a run that fails with 8 left working journals storage.migration-failed once, however often it runs again', async () => {
    const worker = await loadBackground({
      opens: false,
      setup: async env => {
        await profileAt8(env);
        // A recovery database without its stores, which the run refuses before it copies
        await new Promise((resolve, reject) => {
          const request = env.indexedDB.open('NewTabNoteRecovery', 1);
          request.onsuccess = () => {
            request.result.close();
            resolve(undefined);
          };
          request.onerror = () => reject(request.error);
        });
      },
    });
    await worker.drain();
    // Each capture after a run that read nothing runs it again at once
    await worker.dispatch('commands.onCommand', 'capture-selection', worker.tab);
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    const failed = seen.events.filter(([code]) => code === 'storage.migration-failed');
    assert.equal(failed.length, 1, JSON.stringify(seen.events));
    const [, fields] = failed[0];
    assert.deepEqual(Object.keys(fields).sort().filter(name => !['cause', 'errorCode', 'exception', 'retryable'].includes(name)), ['schemaVersion', 'surface']);
    assert.ok(!codes(seen).includes('storage.open-failed'));
    assert.deepEqual(seen.incidents.filter(incident => incident.providerId === 'storage'), []);
  });

  it("a 1.4.x database with a store this build doesn't know is refused, and journals storage.migration-failed with its code", async () => {
    const worker = await loadBackground({
      opens: false,
      setup: env => createDatabase(env.indexedDB, {
        extraStores: { strayStore: {} },
        records: { canvases: [note('n1', { name: 'Groceries' })], elements: [block('b1', 'n1', 0, 'Milk')] },
      }),
    });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    const failed = seen.events.filter(([code]) => code === 'storage.migration-failed');
    assert.equal(failed.length, 1, JSON.stringify(seen.events));
    assert.equal(failed[0][1].errorCode, 'unknown-shape');
  });

  it("a run that never starts, the migration's lock throwing, journals storage.migration-failed once", async () => {
    const worker = await loadBackground({
      opens: false,
      setup: async env => {
        await profileAt8(env);
        // Only the migration's lock: the journal takes its own locks to write
        const locks = env.global.navigator.locks;
        env.global.navigator.locks = {
          request: (name, ...rest) => {
            if (name === 'storage.migrate') throw new DOMException('no locks', 'InvalidStateError');
            return locks.request(name, ...rest);
          },
          query: (...args) => locks.query(...args),
        };
      },
    });
    await worker.drain();
    await worker.dispatch('commands.onCommand', 'capture-selection', worker.tab);
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.equal(seen.events.filter(([code]) => code === 'storage.migration-failed').length, 1, JSON.stringify(seen.events));
    assert.ok(!codes(seen).includes('storage.open-failed'));
  });
});

/** A recovery database without its stores, which the run refuses before it copies */
function brokenRecovery(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open('NewTabNoteRecovery', 1);
    request.onsuccess = () => {
      request.result.close();
      resolve(undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Starts js/background.js `times` times on one profile, each a new worker as Chrome starts one
 * after the last stopped: the same IndexedDB and chrome.storage. `setup` gets each start's
 * environment before it starts. Answers NewTabNoteTrust's journal and the storage after them.
 */
async function restarts(times, setup) {
  const factory = new IDBFactory();
  let chrome;
  for (let start = 1; start <= times; start += 1) {
    const env = createLegacyEnv({ context: 'worker', indexedDB: factory, ...(chrome ? { chrome } : {}) });
    chrome = env.chrome;
    env.chrome.api.contextMenus.create = (properties, callback) => {
      if (typeof callback === 'function') callback();
    };
    await setup(env, start);
    await startWorker(env);
    for (let round = 0; round < 10; round += 1) {
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  return { seen: await inspect(factory), local: chrome.local };
}

describe('the migration events across worker starts (#20 slice 4 prerequisites, part 2, review)', () => {
  it('a run that fails the same way on each start journals storage.migration-failed once', async () => {
    const { seen } = await restarts(3, async (env, start) => {
      if (start === 1) {
        await profileAt8(env);
        await brokenRecovery(env.indexedDB);
      }
    });
    assert.equal(seen.events.filter(([code]) => code === 'storage.migration-failed').length, 1, JSON.stringify(seen.events));
  });

  it('a blocked marker a stopped worker left goes when the next start runs unblocked, and storage reads migrated', async () => {
    const { seen, local } = await restarts(1, async env => {
      await profileAt8(env);
      env.chrome.local.storageUpgradeBlocked = { at: 1 };
    });
    assert.equal(local.storageUpgradeBlocked ?? null, null, "the start cleared the marker");
    assert.equal(local.setting_storageUpgrade.status, 'migrated');
    assert.deepEqual(codes(seen), ['storage.migration-completed']);
  });

  it('a start whose upgrade is still blocked, behind the marker a stopped worker left, journals no second storage.migration-blocked and keeps the marker', async () => {
    // A worker that stopped while blocked leaves its marker and its journaled event; the next
    // start finds the same older page still open. (A stopped worker's own pending upgrade
    // goes with it in Chrome, which one shared fake IndexedDB can't do, so this start is
    // the first to ask for the upgrade.)
    let blocker;
    const { seen, local } = await restarts(1, async env => {
      await profileAt8(env);
      env.chrome.local.storageUpgradeBlocked = { at: 1 };
      blocker = await new Promise((resolve, reject) => {
        const request = env.indexedDB.open('CanvasTabDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      blocker.onversionchange = () => {};
    });
    assert.deepEqual(seen.events.filter(([code]) => code === 'storage.migration-blocked'), [], JSON.stringify(seen.events));
    assert.ok(local.storageUpgradeBlocked && local.storageUpgradeBlocked.at !== 1, 'the blocked run set its own marker');
    blocker.close();
  });
});
