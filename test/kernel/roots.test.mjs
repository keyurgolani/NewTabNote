// What each composition root builds (#12, "Where the kernel runs"; #17 PR 1b): one kernel per
// context, with its surface as the caller the policy checks. The worker's runs #17's migration
// run first, then opens #17's adapter, and Popup's and Side Panel's open #17's adapter as it is.
// So does the new tab's since #17 PR 4a, once the worker's run has had its 5 seconds, its one
// connection since #17 PR 4b, which connects production js/storage.js's shell to its kernel,
// in test/helpers/legacy-env.js. The worker's maintenance leaves out the integrity check, which
// it runs when asked (#35 slice 1).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import { DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { UPGRADE_RECORD_KEY, createWorkerClient } from '../../js/kernel/composition/background.js';
import { PURGE_MESSAGE, waitForWorkerUpgrade, wakeWorkerToPurge } from '../../js/kernel/composition/host.js';
import {
  connectNewTabStorage,
  createNewTabAdapter,
  createNewTabClient,
  createNewTabLegacyStores,
  createNewTabStorageState,
  withPurgeWake,
} from '../../js/kernel/composition/newtab.js';
import { createPopupClient } from '../../js/kernel/composition/popup.js';
import { createSidePanelClient } from '../../js/kernel/composition/sidepanel.js';
import { closeAll, legacyContext, legacyEnv } from './legacy-fixture.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('../../js/kernel/composition/host.js').Client} Client */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */

/** @type {{IDBKeyRange: typeof globalThis.IDBKeyRange}} */
const { IDBKeyRange: KeyRange } = createRequire(import.meta.url)('fake-indexeddb');

/**
 * What the new tab's root reads from its context's globals (newtab.js, newTabHost): the page's
 * IndexedDB, chrome.storage.local, its wait on the worker's run, its Web Locks, where it hears of
 * settings changes, and the Storage global
 * @param {LegacyContext} context
 * @returns {import('../../js/kernel/composition/newtab.js').NewTabHost}
 */
const hostOf = context => ({
  indexedDB: context.env.indexedDB,
  settings: context.env.chrome.api.storage.local,
  awaitUpgrade: () => waitForWorkerUpgrade({ runtime: context.env.chrome.api.runtime }),
  locks: context.env.global.navigator.locks || null,
  changes: listener => () => {},
  storage: context.storage,
});

/**
 * The new tab's adapter and client, as its root builds them, with the Storage global's shell
 * connected to the client
 * @param {LegacyContext} context
 */
const newTabOf = context => {
  const host = hostOf(context);
  const adapter = createNewTabAdapter(host);
  const client = createNewTabClient(adapter);
  connectNewTabStorage(client, host, createNewTabStorageState(adapter));
  return { adapter, client };
};

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
    const { client: newtab } = newTabOf(tab);
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

  it("on a fresh profile only the worker makes the database, at this build's version; Popup and Side Panel wait on it, then make none", async () => {
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
    const refused = await newTabOf(fresh).client.whenReady();
    assert.deepEqual(refused && [refused.cause, refused.code], ['storage', 'no-database']);
    assert.deepEqual(await fresh.env.indexedDB.databases(), []);

    // The worker's run makes it at this build's version, then the worker maintains it, and records the run
    const worker = createWorkerClient(workerHostOf(fresh));
    assert.equal(await worker.whenReady(), null);
    assert.equal((await worker.migration.done).status, 'migrated');
    assert.deepEqual(await databases(fresh.env.indexedDB), [['CanvasTabDB', DB_VERSION]]);
    assert.equal(fresh.env.chrome.local.setting_storageInitialized, true);
    assert.deepEqual(
      { .../** @type {any} */ (fresh.env.chrome.local[UPGRADE_RECORD_KEY]), at: 0 },
      // A fresh profile's run read no store, so it never holds back another (costly: false)
      { status: 'migrated', code: null, at: 0, version: null, costly: false },
    );
    // And a new tab that wakes it then opens the database as it is, and maintains it
    const next = legacyContext(fresh.env);
    const opened = newTabOf(next);
    assert.equal(await opened.client.whenReady(), null);
    assert.equal(opened.adapter.upgraded(), true);
    // Through its one connection: the Storage global's shell opens none (#17 PR 4b)
    assert.equal('db' in next.storage, false);
    closeAll([fresh, next]);
  });

  it("watches the new tab's connection, and the worker's opens again once a newer build's upgrade closes it", async () => {
    // Another context's upgrade never waits on either: the new tab's editor keeps its text while
    // it asks for a reload, and the worker's next command opens the database again
    const tab = legacyContext();
    const { adapter, client: newtab } = newTabOf(tab);
    assert.equal(await newtab.whenReady(), null);
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
    // A newer build's upgrade: the new tab's one connection doesn't block it, #17's adapter's,
    // since the Storage global's shell opens none (#17 PR 4b), nor the worker's, and the
    // worker's next open finds it too new
    const upgraded = await new Promise((resolve, reject) => {
      const request = tab.env.indexedDB.open('CanvasTabDB', DB_VERSION + 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('a connection the new tab or the worker held blocked the upgrade'));
    });
    /** @type {IDBDatabase} */ (upgraded).close();
    assert.deepEqual([adapter.openState(), adapter.upgraded()], ['version-changed', false]);
    const reload = await newtab.execute({
      type: 'createNote',
      commandId: newtab.ids.next(),
      noteId: newtab.ids.next(),
    });
    assert.deepEqual(reload.kind === 'unavailable' && [reload.cause, reload.code], ['storage', 'reload-required']);
    const refused = await capture('second');
    assert.deepEqual(refused.kind === 'unavailable' && [refused.cause, refused.code], [
      'newer-schema',
      'version-too-new',
    ]);
    closeAll([tab]);
  });

  it('checks integrity in the worker only when asked, as runIntegrityCheck (#35), and not as the new tab starts (#17 PR 4a)', async () => {
    /** @param {LegacyContext} context */
    const reported = context =>
      context.env.logs.filter((/** @type {{args: unknown[]}} */ log) =>
        String(log.args[0]).includes('Integrity check (read-only) found orphaned records'),
      ).length;
    /** A profile whose one block has no note, which the check reports */
    const withOrphan = async () => {
      const profile = legacyContext();
      await legacyEnv.createDatabase(profile.env.indexedDB, {
        records: { elements: [legacyEnv.block('orphan', 'missing-note', 0)] },
      });
      return profile;
    };

    // Both starts write first-run settings only: the new tab's, whose maintenance is on #17's
    // adapter since #17 PR 4a, and the worker's, whose kernel is on it since #17 PR 1b. #17's
    // adapter's check reports to the console of the context it runs in, as Storage's did
    /** @type {unknown[][]} */
    const said = [];
    const info = console.info;
    console.info = (/** @type {unknown[]} */ ...args) => {
      said.push(args);
    };
    const tab = await withOrphan();
    const profile = await withOrphan();
    try {
      assert.equal(await newTabOf(tab).client.whenReady(), null);
      assert.deepEqual(said, [], "the new tab's start checks nothing");
      const worker = createWorkerClient(workerHostOf(profile));
      assert.equal(await worker.whenReady(), null);
      assert.equal(profile.env.chrome.local.setting_storageInitialized, true);
      assert.deepEqual(said, []);
      const checked = await worker.execute({ type: 'runIntegrityCheck', commandId: worker.ids.next() });
      assert.deepEqual(checked.kind === 'committed' && [checked.code, checked.changedIds], ['integrity-checked', []]);
    } finally {
      console.info = info;
    }
    assert.deepEqual(said, [['Integrity check (read-only) found orphaned records:', { orphanedElements: 1 }]]);
    assert.equal(reported(tab), 0, "and nothing on the new tab's page");
    assert.equal(reported(profile), 0, "and nothing on the profile's pages");
    const elements = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(profile.env.indexedDB), 'elements');
    assert.ok(elements.orphan, 'the orphaned block is still there');
    closeAll([tab, profile]);
  });

  it("hands NotesManager, GraphView and SyncService only their own calls, each on the new tab's kernel (#17 PR 4b)", async () => {
    const tab = legacyContext();
    const host = hostOf(tab);
    const { adapter, client } = newTabOf(tab);
    assert.equal(await client.whenReady(), null);
    const stores = createNewTabLegacyStores(client, host, createNewTabStorageState(adapter));
    assert.deepEqual(Object.keys(stores.searchIndex).sort(), [
      'getAllVectors',
      'hasStore',
      'removeSearchIndexEntry',
      'saveVector',
      'setSearchIndex',
      'setSearchIndexEntry',
    ]);
    assert.deepEqual(Object.keys(stores.graph).sort(), ['getAllNotes', 'listLinks']);
    // Sync has never applied a remote note: its handle has no importAll, importNote, or saveElement
    assert.deepEqual(Object.keys(stores.sync).sort(), ['exportAll', 'getSetting', 'setSetting']);
    for (const store of Object.values(stores)) {
      assert.ok(Object.isFrozen(store));
      for (const name of [
        'db',
        'transaction',
        'getStore',
        'createNote',
        'updateNote',
        'importData',
        'importAll',
        'importNote',
        'saveElement',
      ]) {
        assert.equal(/** @type {Record<string, unknown>} */ (store)[name], undefined, name);
      }
    }
    // Each call is the kernel's: the notes are listNotes', and the database is the adapter's
    const created = await client.execute({
      type: 'createNote',
      commandId: client.ids.next(),
      noteId: client.ids.next(),
      name: 'Graph',
    });
    assert.equal(created.kind, 'committed');
    const listed = await client.query({ type: 'listNotes', view: 'withArchived' });
    assert.deepEqual(await stores.graph.getAllNotes(true), listed.kind === 'ready' ? listed.data : null);
    assert.deepEqual(
      [stores.searchIndex.hasStore('vectors'), stores.searchIndex.hasStore('no-such-store')],
      [true, false],
    );
    closeAll([tab]);
  });

  it("connects the Storage global's shell to the new tab's kernel, with only llm.js's and App's reconnect's settings, and before it does every call rejects (#17 PR 4b)", async () => {
    const tab = legacyContext();
    const shell = tab.storage;
    // Unconnected, as on a page the root never started
    await assert.rejects(shell.getSetting('llmProvider', 'none'), /until the new tab connects it/);
    assert.equal(shell.hasStore('vectors'), false);
    const { client } = newTabOf(tab);
    assert.equal(await client.whenReady(), null);
    // Its settings are where 1.4.x kept them, and it reaches no other holder's or the kernel's
    await shell.setSetting('llmModel', 'gpt-4o');
    assert.equal(tab.env.chrome.local.setting_llmModel, 'gpt-4o');
    assert.equal(await shell.getSetting('llmProvider', 'none'), 'none');
    tab.env.chrome.local.setting_syncWebdavConfig = { serverUrl: 'https://dav.example.test' };
    assert.deepEqual(await shell.getSetting('syncWebdavConfig'), { serverUrl: 'https://dav.example.test' });
    for (const key of ['theme', 'syncProvider', 'dailyNoteTemplate']) {
      await assert.rejects(shell.setSetting(key, 'x'), TypeError, key);
    }
    // Its other calls are the facade's, on the kernel
    const created = await client.execute({
      type: 'createNote',
      commandId: client.ids.next(),
      noteId: client.ids.next(),
      name: 'Shell',
    });
    assert.equal(created.kind, 'committed');
    const listed = await client.query({ type: 'listNotes', view: 'withArchived' });
    assert.deepEqual(await shell.getAllNotes(true), listed.kind === 'ready' ? listed.data : null);
    assert.equal(shell.hasStore('vectors'), true);
    closeAll([tab]);
  });
});

describe("the new tab's wake of the worker's purge (#17 PR 2b)", () => {
  it('wakes the worker after each command that deleted something for good, and after nothing else', async () => {
    const tab = legacyContext();
    /** @type {string[]} */
    const wakes = [];
    const newtab = withPurgeWake(newTabOf(tab).client, () => wakes.push('wake'));
    assert.equal(await newtab.whenReady(), null);
    /**
     * @param {Record<string, unknown>} fields
     * @returns {Promise<any>}
     */
    const send = fields => newtab.execute(/** @type {any} */ ({ commandId: newtab.ids.next(), ...fields }));
    /** @param {Record<string, unknown>} [fields] */
    const make = async (fields = {}) => {
      const noteId = newtab.ids.next();
      assert.equal((await send({ type: 'createNote', noteId, ...fields })).kind, 'committed');
      return noteId;
    };
    const kept = await make({
      name: 'Kept',
      blocks: [{ id: newtab.ids.next(), type: 'text', content: 'Milk', order: 0 }],
    });
    const deleted = await make({
      name: 'Deleted',
      blocks: [{ id: newtab.ids.next(), type: 'text', content: 'Eggs', order: 0 }],
    });
    const empty = await make();
    const steps = [
      // A trash, an archive, a rename, and a refused delete delete nothing
      [{ type: 'trashNote', noteId: deleted }, 0],
      [{ type: 'archiveNote', noteId: kept }, 0],
      [{ type: 'renameNote', noteId: kept, name: 'Still kept' }, 0],
      [{ type: 'deleteNotePermanently', noteId: kept }, 0],
      // A permanent delete, and a trash of an empty untitled note, which deletes it
      [{ type: 'deleteNotePermanently', noteId: deleted }, 1],
      [{ type: 'trashNote', noteId: empty }, 1],
      // Empty trash and trash retention with nothing to delete, then a folder's delete
      [{ type: 'emptyTrash' }, 0],
      [{ type: 'runTrashCleanup' }, 0],
      [{ type: 'createFolder', folderId: 'f1', name: 'Folder', parentId: null }, 0],
      [{ type: 'deleteFolder', folderId: 'f1' }, 1],
    ];
    for (const [fields, wanted] of steps) {
      const before = wakes.length;
      await send(/** @type {Record<string, unknown>} */ (fields));
      assert.equal(wakes.length - before, wanted, JSON.stringify(fields));
    }
    // A bulk delete wakes it once, when any item deleted
    await send({ type: 'unarchiveNote', noteId: kept });
    await send({ type: 'trashNote', noteId: kept });
    const before = wakes.length;
    const bulk = await send({ type: 'runBulkAction', action: 'delete', noteIds: [kept] });
    assert.equal(bulk.kind, 'bulk');
    assert.equal(wakes.length - before, 1);
    closeAll([tab]);
  });

  it("sends storage.purge and nothing else, and a worker that can't be reached changes nothing", async () => {
    /** @type {unknown[]} */
    const sent = [];
    wakeWorkerToPurge({
      runtime: {
        sendMessage: async message => {
          sent.push(message);
          throw new Error('no worker');
        },
      },
    });
    wakeWorkerToPurge({ runtime: undefined });
    wakeWorkerToPurge({
      runtime: {
        sendMessage: () => {
          throw new Error('not now');
        },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, [{ type: PURGE_MESSAGE }]);
    assert.equal(PURGE_MESSAGE, 'storage.purge');
  });
});
