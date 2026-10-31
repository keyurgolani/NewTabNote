// What each composition root builds (#12, "Where the kernel runs"; #17 PR 1b): one kernel per
// context, with its surface as the caller the policy checks. The new tab's is on the legacy
// adapter over production js/storage.js in test/helpers/legacy-env.js, and opens the database
// as it is once the worker's run has had its 5 seconds. The worker's runs #17's migration run
// first, then opens #17's adapter, and Popup's and Side Panel's open #17's adapter as it is.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import { UPGRADE_RECORD_KEY, createWorkerClient } from '../../js/kernel/composition/background.js';
import { createNewTabClient, createNewTabLegacyStores } from '../../js/kernel/composition/newtab.js';
import { createPopupClient } from '../../js/kernel/composition/popup.js';
import { createSidePanelClient } from '../../js/kernel/composition/sidepanel.js';
import { closeAll, legacyContext, legacyEnv } from './legacy-fixture.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('../../js/kernel/composition/host.js').Client} Client */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */

/** @type {{IDBKeyRange: typeof globalThis.IDBKeyRange}} */
const { IDBKeyRange: KeyRange } = createRequire(import.meta.url)('fake-indexeddb');

/**
 * What the new tab's root reads from its context's globals: the Storage global and chrome.storage.local
 * @param {LegacyContext} context
 */
const hostOf = context => ({ storage: context.storage, settings: context.env.chrome.api.storage.local });

/**
 * What Popup's and Side Panel's roots read from a page's globals, `waits` counting their waits
 * on the worker
 * @param {LegacyContext} context
 * @param {{count: number}} [waits]
 */
const pageHostOf = (context, waits = { count: 0 }) => ({
  indexedDB: context.env.indexedDB,
  settings: context.env.chrome.api.storage.local,
  awaitUpgrade: async () => {
    waits.count++;
  },
});

/**
 * What the worker's root reads from its globals
 * @param {LegacyContext} context
 */
const workerHostOf = context => ({
  indexedDB: context.env.indexedDB,
  keyRange: KeyRange,
  settings: context.env.chrome.api.storage.local,
  locks: legacyEnv.createLockManager(),
  estimate: null,
  crypto: /** @type {any} */ (webcrypto),
});

/** @param {Outcome} outcome */
const policyRefusal = outcome => outcome.kind === 'rejected' && [outcome.reason, outcome.code];

/** @param {IDBFactory} factory */
const databases = async factory =>
  (await factory.databases()).map((/** @type {IDBDatabaseInfo} */ db) => [db.name, db.version]).sort();

describe('each composition root', () => {
  it('builds a kernel whose caller is its surface', async () => {
    const tab = legacyContext();
    const newtab = createNewTabClient(hostOf(tab));
    assert.equal(await newtab.whenReady(), null);
    const popup = createPopupClient(pageHostOf(tab));
    const panel = createSidePanelClient(pageHostOf(tab));
    const worker = createWorkerClient(workerHostOf(tab));
    /** @param {Client} client */
    const ids = client => ({ commandId: client.ids.next(), noteId: client.ids.next() });

    // The new tab may do anything Popup and Side Panel can't, but read Popup's setting
    const created = await newtab.execute({ type: 'createNote', ...ids(newtab), name: 'From the new tab' });
    assert.equal(created.kind, 'committed');
    assert.deepEqual(await newtab.query({ type: 'getPopupInsightsEnabled' }), {
      kind: 'failed',
      cause: 'policy',
      code: 'not-on-surface',
    });
    // Popup saves a quick note, and renames nothing
    assert.equal((await popup.execute({ type: 'createNote', ...ids(popup), name: 'Quick note' })).kind, 'committed');
    const [noteId] = created.kind === 'committed' ? created.changedIds : [];
    const renamed = await popup.execute({ type: 'renameNote', commandId: popup.ids.next(), noteId, name: 'Renamed' });
    assert.deepEqual(policyRefusal(renamed), ['policy', 'not-on-surface']);
    // Side Panel reads, and writes nothing
    const listed = await panel.query({ type: 'listNotes', view: 'sidePanel' });
    assert.deepEqual(listed.kind === 'ready' && listed.data.map(note => note.name).sort(), [
      'From the new tab',
      'Quick note',
    ]);
    const fromPanel = await panel.execute({ type: 'createNote', ...ids(panel) });
    assert.deepEqual(policyRefusal(fromPanel), ['policy', 'not-on-surface']);
    // The worker captures, and does nothing else
    const captured = await worker.execute({
      type: 'captureToDailyNote',
      ...ids(worker),
      blockId: worker.ids.next(),
      capture: { type: 'text', content: 'Captured' },
    });
    assert.equal(captured.kind, 'committed');
    assert.deepEqual(policyRefusal(await worker.execute({ type: 'createNote', ...ids(worker) })), [
      'policy',
      'not-on-surface',
    ]);
    assert.deepEqual(await worker.query({ type: 'listNotes', view: 'active' }), {
      kind: 'failed',
      cause: 'policy',
      code: 'not-on-surface',
    });
    closeAll([tab]);
  });

  it('on a fresh profile only the worker makes the database, at 9; Popup and Side Panel wait on it, then make none', async () => {
    const fresh = legacyContext(undefined, { worker: false });
    // On a profile with no database, Popup and Side Panel wait on the worker first, then make none
    const waits = { count: 0 };
    for (const create of [createPopupClient, createSidePanelClient]) {
      const failure = await create(pageHostOf(fresh, waits)).whenReady();
      assert.deepEqual(failure && [failure.cause, failure.code], ['storage', 'no-database']);
    }
    assert.equal(waits.count, 2);
    assert.deepEqual(await fresh.env.indexedDB.databases(), []);
    assert.deepEqual(fresh.env.chrome.writes(), []);
    // So does the new tab, whose wake reaches no worker here (worker: false): it opens what's
    // there, which is nothing, so it refuses, and makes nothing
    const refused = await createNewTabClient(hostOf(fresh)).whenReady();
    assert.deepEqual(refused && [refused.cause, refused.code], ['storage', 'no-database']);
    assert.deepEqual(await fresh.env.indexedDB.databases(), []);

    // The worker's run makes it at 9, then the worker maintains it, and records the run
    const worker = createWorkerClient(workerHostOf(fresh));
    assert.equal(await worker.whenReady(), null);
    assert.equal((await worker.migration.done).status, 'migrated');
    assert.deepEqual(await databases(fresh.env.indexedDB), [['CanvasTabDB', 9]]);
    assert.equal(fresh.env.chrome.local.setting_storageInitialized, true);
    assert.deepEqual(
      { .../** @type {any} */ (fresh.env.chrome.local[UPGRADE_RECORD_KEY]), at: 0 },
      { status: 'migrated', code: null, at: 0 },
    );
    // And a new tab that wakes it then opens the database as it is, and maintains it
    const next = legacyContext(fresh.env);
    assert.equal(await createNewTabClient(hostOf(next)).whenReady(), null);
    assert.equal(next.storage.db.version, 9);
    closeAll([fresh, next]);
  });

  it("watches the new tab's connection, and the worker's opens again once a newer build's upgrade closes it", async () => {
    // Another context's upgrade never waits on either: the new tab's editor keeps its text while
    // it asks for a reload, and the worker's next command opens the database again
    const tab = legacyContext();
    assert.equal(await createNewTabClient(hostOf(tab)).whenReady(), null);
    const db = /** @type {IDBDatabase} */ (tab.storage.db);
    assert.deepEqual(
      [db.onversionchange, db.onclose].map(handler => typeof handler === 'function'),
      [true, true],
    );
    const worker = createWorkerClient(workerHostOf(tab));
    assert.equal(await worker.whenReady(), null);
    const capture = (/** @type {string} */ id) =>
      worker.execute({
        type: 'captureToDailyNote',
        commandId: `c-${id}`,
        noteId: `d-${id}`,
        blockId: `b-${id}`,
        capture: { type: 'text', content: id },
      });
    assert.equal((await capture('first')).kind, 'committed');
    // A newer build's upgrade: nothing blocks it, and the worker's next open finds it too new
    const upgraded = await legacyEnv.requestToPromise(tab.env.indexedDB.open('CanvasTabDB', 10));
    /** @type {IDBDatabase} */ (upgraded).close();
    assert.equal(tab.storage.openState, 'version-changed');
    const refused = await capture('second');
    assert.deepEqual(refused.kind === 'unavailable' && [refused.cause, refused.code], [
      'newer-schema',
      'version-too-new',
    ]);
    closeAll([tab]);
  });

  it("hands NotesManager, GraphView and SyncService only their own calls on the new tab's Storage", async () => {
    const tab = legacyContext();
    assert.equal(await createNewTabClient(hostOf(tab)).whenReady(), null);
    const stores = createNewTabLegacyStores(hostOf(tab));
    assert.deepEqual(Object.keys(stores.searchIndex).sort(), [
      'getAllVectors', 'hasStore', 'removeSearchIndexEntry', 'saveVector', 'setSearchIndex', 'setSearchIndexEntry',
    ]);
    assert.deepEqual(Object.keys(stores.graph).sort(), ['getAllNotes', 'getStore']);
    // Storage defines no importAll or importNote, so sync finds neither on its handle, as on Storage
    assert.deepEqual(Object.keys(stores.sync).sort(), ['exportAll', 'getSetting', 'getStore', 'saveElement', 'setSetting']);
    for (const store of Object.values(stores)) {
      assert.ok(Object.isFrozen(store));
      for (const name of ['db', 'transaction', 'createNote', 'updateNote', 'deleteNote', 'importData']) {
        assert.equal(/** @type {Record<string, unknown>} */ (store)[name], undefined, name);
      }
    }
    // Each call is Storage's own
    assert.deepEqual(await stores.graph.getAllNotes(true), await tab.storage.getAllNotes(true));
    assert.equal(stores.searchIndex.hasStore('vectors'), tab.storage.hasStore('vectors'));
    closeAll([tab]);
  });
});
