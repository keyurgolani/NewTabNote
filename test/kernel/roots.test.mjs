// What each composition root builds (#12, "Where the kernel runs"): one kernel on the legacy
// adapter, over the storage its context loaded, with its surface as the caller the policy
// checks. The new tab's and the worker's open the database versioned and maintain it first,
// Popup's and Side Panel's open it as it is, and in slice 4a only the worker's watches its
// connection. Each root takes the storage and settings it would read from its context's
// globals, here production js/storage.js in test/helpers/legacy-env.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerClient } from '../../js/kernel/composition/background.js';
import { createNewTabClient, createNewTabLegacyStores } from '../../js/kernel/composition/newtab.js';
import { createPopupClient } from '../../js/kernel/composition/popup.js';
import { createSidePanelClient } from '../../js/kernel/composition/sidepanel.js';
import { closeAll, legacyContext } from './legacy-fixture.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('../../js/kernel/composition/host.js').Client} Client */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */

/**
 * What a root reads from its context's globals: the Storage global and chrome.storage.local
 * @param {LegacyContext} context
 */
const hostOf = context => ({ storage: context.storage, settings: context.env.chrome.api.storage.local });

/** @param {Outcome} outcome */
const policyRefusal = outcome => outcome.kind === 'rejected' && [outcome.reason, outcome.code];

describe('each composition root', () => {
  it('builds a kernel whose caller is its surface', async () => {
    const tab = legacyContext();
    const others = [legacyContext(tab.env), legacyContext(tab.env), legacyContext(tab.env)];
    const newtab = createNewTabClient(hostOf(tab));
    assert.equal(await newtab.whenReady(), null);
    const [popup, panel, worker] = [createPopupClient, createSidePanelClient, createWorkerClient].map((create, i) =>
      create(hostOf(others[i])),
    );
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
    closeAll([tab, ...others]);
  });

  it("opens the new tab's and the worker's versioned and maintains them first, and Popup's and Side Panel's as they are", async () => {
    const fresh = legacyContext();
    const panes = [legacyContext(fresh.env), legacyContext(fresh.env)];
    // On a profile with no database, Popup and Side Panel make none and change nothing
    for (const [i, create] of [createPopupClient, createSidePanelClient].entries()) {
      const failure = await create(hostOf(panes[i])).whenReady();
      assert.deepEqual(failure && [failure.cause, failure.code], ['storage', 'no-database']);
    }
    assert.deepEqual(await fresh.env.indexedDB.databases(), []);
    assert.deepEqual(fresh.env.chrome.writes(), []);
    // The new tab makes it at this build's version, with startup maintenance before anything else
    assert.equal(await createNewTabClient(hostOf(fresh)).whenReady(), null);
    const databases = await fresh.env.indexedDB.databases();
    assert.deepEqual(
      databases.map((/** @type {IDBDatabaseInfo} */ db) => [db.name, db.version]),
      [['CanvasTabDB', 8]],
    );
    assert.equal(fresh.env.chrome.local.setting_storageInitialized, true);

    // And so does the worker, on a profile of its own
    const workerProfile = legacyContext();
    assert.equal(await createWorkerClient(hostOf(workerProfile)).whenReady(), null);
    assert.equal(workerProfile.env.chrome.local.setting_storageInitialized, true);
    closeAll([fresh, ...panes, workerProfile]);
  });

  it("watches the new tab's and the worker's versioned connections", async () => {
    // Another context's upgrade never waits on either: the worker opens again on its next
    // capture, and the new tab's editor keeps its text while it asks for a reload
    const tab = legacyContext();
    assert.equal(await createNewTabClient(hostOf(tab)).whenReady(), null);
    const worker = legacyContext();
    assert.equal(await createWorkerClient(hostOf(worker)).whenReady(), null);
    /** @param {LegacyContext} context */
    const handled = context => {
      const db = /** @type {IDBDatabase} */ (context.storage.db);
      return [db.onversionchange, db.onclose].map(handler => typeof handler === 'function');
    };
    assert.deepEqual(handled(tab), [true, true]);
    assert.deepEqual(handled(worker), [true, true]);
    closeAll([tab, worker]);
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
