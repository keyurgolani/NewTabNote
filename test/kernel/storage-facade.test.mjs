// js/storage.js's calls as a facade over the new tab's kernel (#17 PR 4b, Q7): NotesManager's
// search index and embeddings, GraphView's notes and links, and sync's upload, each a command
// or a query on #17's adapter as the new tab's root opens it, and the settings llm.js and sync
// keep outside the kernel, the key and the WebDAV password among them (holder-settings.js).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

import { SECRET_SETTING_KEYS, createLegacySecretReader } from '../../js/kernel/adapters/indexeddb/legacy-secrets.js';
import {
  DEFAULT_LIMITS,
  RECOVERY_DB_NAME,
  copyPoint,
  openRecovery,
  startPoint,
  storesToCopy,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { openWithoutUpgrade } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { PROVIDER_SETTING_KEYS, SYNC_SETTING_KEYS } from '../../js/kernel/composition/holder-settings.js';
import { NEWTAB_HANDLERS } from '../../js/kernel/core/application/handlers-all.js';
import { encodedBytes } from '../../js/kernel/core/contracts/codec.js';
import { empty, failed, ready } from '../../js/kernel/core/contracts/outcomes.js';
import { kernelClient, waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import {
  connectNewTabStorage,
  createNewTabAdapter,
  createNewTabLegacyStores,
  createNewTabStorageState,
} from '../../js/kernel/composition/newtab.js';
import { StorageFacadeError, createStorageFacade } from '../../js/kernel/composition/storage-facade.js';

/** @typedef {import('../../js/kernel/composition/host.js').Client} Client */
/** @typedef {import('../../js/kernel/core/domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../../js/kernel/core/domain/note.js').VectorRecord} VectorRecord */
/** @typedef {import('../../js/kernel/core/ports/repository.js').ExportData} ExportData */

const requireCommonJs = createRequire(import.meta.url);
/** @type {any} */
const legacyEnv = requireCommonJs('../helpers/legacy-env.js');
/** @type {any} */
const writePaths = requireCommonJs('../../scripts/write-paths.js');

/**
 * A new tab on #17's adapter as its root opens it, on a fresh profile the worker's run made, or
 * on a version-8 database without the `omit` stores. `sent` is every command and query the
 * holders' handles send, in order, and each of their commands waits for `beforeExecute` first,
 * so a case can run another command just before one goes. A query `fails` names answers failed,
 * as one whose answer was over the cap would.
 * @param {{omit?: string[], beforeExecute?: (command: unknown) => Promise<void>, fails?: (query: {type: string}) => boolean}} [options]
 */
async function newTab({ omit = [], beforeExecute = async () => {}, fails = () => false } = {}) {
  const env = legacyEnv.createLegacyEnv({ context: 'page' });
  if (omit.length > 0) await legacyEnv.createDatabase(env.indexedDB, { omit });
  const host = {
    indexedDB: env.indexedDB,
    settings: env.chrome.api.storage.local,
    awaitUpgrade: () => waitForWorkerUpgrade({ runtime: env.chrome.api.runtime }),
    locks: env.global.navigator.locks || null,
  };
  const adapter = createNewTabAdapter(host);
  const client = kernelClient({ adapter, surface: 'newtab', handlers: NEWTAB_HANDLERS, maintainOnOpen: true });
  assert.equal(await client.whenReady(), null);
  /** @type {unknown[]} */
  const sent = [];
  /** @type {Client} */
  const spying = Object.freeze({
    ...client,
    execute: /** @type {Client['execute']} */ (
      /** @type {unknown} */ (
        async (/** @type {any} */ command) => {
          sent.push(command);
          await beforeExecute(command);
          return client.execute(command);
        }
      )
    ),
    query: /** @type {Client['query']} */ (
      query => {
        sent.push(query);
        return fails(query) ? Promise.resolve(failed('coordinator', 'payload-too-large')) : client.query(query);
      }
    ),
  });
  const stores = createNewTabLegacyStores(spying, host, createNewTabStorageState(adapter));
  // js/storage.js's shell, the Storage global llm.js calls, connected as the root connects it
  env.load('js/storage.js');
  const shell = env.get('Storage');
  connectNewTabStorage(spying, { settings: host.settings, storage: shell }, createNewTabStorageState(adapter));
  /**
   * Sends a command on the tab's own client, as another part of the page does
   * @param {Record<string, unknown>} fields
   */
  const run = async fields => {
    const outcome = await client.execute(/** @type {any} */ ({ commandId: client.ids.next(), ...fields }));
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    return outcome;
  };
  /** @param {string} name */
  const note = async name => {
    const noteId = client.ids.next();
    await run({ type: 'createNote', noteId, name });
    return noteId;
  };
  /**
   * @template {import('../../js/kernel/core/contracts/queries.js').QueryType} T
   * @param {import('../../js/kernel/core/contracts/queries.js').QueryOf<T>} query
   */
  const data = async query => {
    const state = await client.query(query);
    if (state.kind === 'empty') return [];
    assert.equal(state.kind, 'ready', JSON.stringify(state));
    return state.kind === 'ready' ? state.data : [];
  };
  return { env, host, adapter, client, stores, shell, sent, run, note, data, close: () => adapter.close() };
}

/**
 * Puts `record` into one of CanvasTabDB's stores as it is, beside the tab's own connection, as a
 * record another build wrote would be
 * @param {any} env
 * @param {string} store
 * @param {Record<string, unknown>} record
 */
async function putRaw(env, store, record) {
  const db = await new Promise((resolve, reject) => {
    const request = env.indexedDB.open('CanvasTabDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * A search entry as the indexer makes it (js/workers/indexer.js)
 * @param {string} noteId
 * @param {string} content
 */
const entry = (noteId, content) => ({ noteId, name: 'Note', content, tags: [], updatedAt: 1 });

/** The most one batch of the whole index holds (#262): entries, and bytes of their JSON as UTF-8 */
const BATCH_ENTRIES = 100;
const BATCH_BYTES = 256 * 1024;

/** Lets the facade send whatever it sends before the next answer comes */
async function settled() {
  for (let round = 0; round < 5; round++) await new Promise(resolve => setImmediate(resolve));
}

/**
 * The facade on a client that answers each command only when the case says, so a case sees what
 * goes before an answer. `stored` is what its read of the stored entries' note ids answers, and
 * `sent` is every query and command, in order.
 * @param {string[]} stored
 */
function heldFacade(stored) {
  /** @type {Array<Record<string, any>>} */
  const sent = [];
  /** @type {Array<() => void>} */
  const answers = [];
  let next = 0;
  const client = /** @type {Client} */ (
    /** @type {unknown} */ ({
      ids: { next: () => `c-${(next += 1)}` },
      whenReady: async () => null,
      query: async (/** @type {Record<string, any>} */ query) => {
        sent.push(query);
        return stored.length > 0 ? ready(1, [...stored]) : empty(1);
      },
      execute: (/** @type {Record<string, any>} */ command) =>
        new Promise(resolve => {
          sent.push(command);
          answers.push(() =>
            resolve({ kind: 'committed', code: 'search-index-updated', changedIds: [], severity: 'success' }),
          );
        }),
    })
  );
  const facade = createStorageFacade(client, { openDatabase: { openState: 'open', missingStores: [] } });
  const commands = () => sent.filter(item => item.type === 'updateSearchIndex');
  return { facade, sent, answers, commands };
}

/**
 * A command of the whole index as [entries it carries, whether it replaces the index, entries it removes]
 * @param {Record<string, any>} command
 */
const shapeOf = command => [command.entries.length, command.replaceAll === true, (command.removed || []).length];

describe("js/storage.js's calls as a facade over the new tab's kernel (#17 PR 4b, Q7)", () => {
  it("NotesManager's index is updateSearchIndex's: the whole index, one entry, and a removal, each one command", async () => {
    const tab = await newTab();
    const [a, b] = [await tab.note('Alpha'), await tab.note('Beta')];
    // The whole index: a note deleted since the indexer read it keeps no entry, and a note
    // named twice keeps its last, as Storage's puts one after another left it
    assert.equal(
      await tab.stores.searchIndex.setSearchIndex([
        entry(a, 'first'),
        entry(b, 'beta'),
        entry('gone', 'x'),
        entry(a, 'milk'),
      ]),
      undefined,
    );
    /** @param {{noteId: string}} one @param {{noteId: string}} other */
    const byNote = (one, other) => (one.noteId < other.noteId ? -1 : 1);
    const stored = async () => [...(await tab.data({ type: 'listSearchEntries' }))].sort(byNote);
    assert.deepEqual(await stored(), [entry(a, 'milk'), entry(b, 'beta')].sort(byNote));
    await tab.stores.searchIndex.setSearchIndexEntry(entry(b, 'eggs'));
    await tab.stores.searchIndex.removeSearchIndexEntry(a);
    assert.deepEqual(await stored(), [entry(b, 'eggs')]);
    // The whole index again drops the entry of every note it doesn't name
    await tab.stores.searchIndex.setSearchIndex([entry(a, 'back')]);
    assert.deepEqual(await stored(), [entry(a, 'back')]);
    assert.deepEqual(
      tab.sent.map(command => {
        const { type, removed, replaceAll } = /** @type {Record<string, unknown>} */ (command);
        return [type, replaceAll === true, Array.isArray(removed) ? removed.length : 0];
      }),
      [
        ['updateSearchIndex', true, 0],
        ['updateSearchIndex', false, 0],
        ['updateSearchIndex', false, 1],
        ['updateSearchIndex', true, 0],
      ],
    );
    await tab.close();
  });

  it('sends the whole index as batches of at most 100 entries, each once the one before it answers, none replacing the index, and removes last the stored entries it names none of (#262)', async () => {
    const { facade, sent, answers, commands } = heldFacade(['n-0', 'stale-1', 'stale-2']);
    const entries = Array.from({ length: BATCH_ENTRIES * 2 + 1 }, (_, index) => entry(`n-${index}`, `text ${index}`));
    const run = facade.setSearchIndex(entries);
    await settled();
    assert.deepEqual(commands().map(shapeOf), [[BATCH_ENTRIES, false, 0]], 'the first batch, alone until it answers');
    answers[0]();
    await settled();
    assert.deepEqual(
      commands().map(shapeOf),
      [
        [BATCH_ENTRIES, false, 0],
        [BATCH_ENTRIES, false, 0],
      ],
      'the second, once the first answered',
    );
    answers[1]();
    await settled();
    assert.deepEqual(
      commands().map(shapeOf).slice(2),
      [[1, false, 2]],
      'the last, with the stored entries it names none of',
    );
    answers[2]();
    assert.equal(await run, undefined);
    assert.deepEqual(commands()[2].removed, ['stale-1', 'stale-2']);
    assert.deepEqual(
      commands().flatMap(command => command.entries.map((/** @type {{noteId: string}} */ one) => one.noteId)),
      entries.map(one => one.noteId),
      'every entry once, in order',
    );
    // What was stored is read before the first batch goes, keys alone
    assert.deepEqual(sent[0], { type: 'listSearchEntryIds' });
  });

  it("counts a batch's bytes as its entries' JSON in UTF-8, at most 256 KiB, and sends an entry over that alone (#262)", async () => {
    const { facade, answers, commands } = heldFacade([]);
    // 'é' is one code unit and two bytes, so two of these fit by code units and not by bytes
    const wide = 'é'.repeat(70_000);
    const entries = [
      entry('w-1', wide),
      entry('w-2', wide),
      entry('big', 'x'.repeat(BATCH_BYTES)),
      entry('small', 'y'),
    ];
    const run = facade.setSearchIndex(entries);
    let done = false;
    void run.then(() => {
      done = true;
    });
    for (let answered = 0; !done && answered < 10; answered++) {
      await settled();
      answers[answered]?.();
    }
    assert.equal(await run, undefined);
    assert.deepEqual(
      commands().map(command => command.entries.map((/** @type {{noteId: string}} */ one) => one.noteId)),
      [['w-1'], ['w-2'], ['big'], ['small']],
    );
    for (const command of commands()) {
      const bytes = command.entries.reduce(
        (/** @type {number} */ sum, /** @type {unknown} */ one) => sum + encodedBytes(JSON.stringify(one)),
        0,
      );
      assert.ok(command.entries.length === 1 || bytes <= BATCH_BYTES, `${bytes} bytes in one batch`);
    }
  });

  it("keeps an entry another command writes once the whole index's write began, and drops one stored when it began that the write names none of (#262)", async () => {
    /** @type {(() => Promise<unknown>) | null} */
    let meanwhile = null;
    const tab = await newTab({
      // Another tab makes a note once this write has begun, just before its first batch goes, and
      // the note's entry goes with it
      beforeExecute: async () => {
        const write = meanwhile;
        meanwhile = null;
        if (write) await write();
      },
    });
    const [a, b, c] = [await tab.note('Alpha'), await tab.note('Beta'), await tab.note('Gamma')];
    await tab.run({ type: 'updateSearchIndex', entries: [entry(a, 'old'), entry(c, 'stale')] });
    /** @type {string | null} */
    let made = null;
    meanwhile = async () => {
      made = await tab.note('Made meanwhile');
    };
    // Two entries too large to share a batch, so the write takes two
    const long = 'x'.repeat(BATCH_BYTES / 2 + 1);
    await tab.stores.searchIndex.setSearchIndex([entry(a, long), entry(b, long)]);
    assert.ok(made, 'the other command ran');
    const stored = /** @type {Array<{noteId: string, name: string, content: string}>} */ (
      await tab.data({ type: 'listSearchEntries' })
    );
    assert.deepEqual(
      stored.map(one => [one.noteId, one.noteId === made ? one.name : one.content]).sort(),
      [
        [a, long],
        [b, long],
        [made, 'Made meanwhile'],
      ].sort(),
      'the entry another tab wrote meanwhile stays, and the stale one goes',
    );
    await tab.close();
  });

  it("still sends every batch when its read of the stored entries' ids fails, as one over the answer cap would, and removes nothing (#262)", async () => {
    const tab = await newTab({ fails: query => query.type === 'listSearchEntryIds' });
    const [a, b, c] = [await tab.note('Alpha'), await tab.note('Beta'), await tab.note('Gamma')];
    await tab.run({ type: 'updateSearchIndex', entries: [entry(c, 'stored before')] });
    const long = 'x'.repeat(BATCH_BYTES / 2 + 1);
    assert.equal(await tab.stores.searchIndex.setSearchIndex([entry(a, long), entry(b, long)]), undefined);
    const stored = /** @type {Array<{noteId: string, content: string}>} */ (
      await tab.data({ type: 'listSearchEntries' })
    );
    assert.deepEqual(
      stored.map(one => [one.noteId, one.content]).sort(),
      [
        [a, long],
        [b, long],
        [c, 'stored before'],
      ].sort(),
    );
    assert.deepEqual(
      tab.sent
        .filter(item => /** @type {{type: string}} */ (item).type === 'updateSearchIndex')
        .map(item => shapeOf(/** @type {Record<string, any>} */ (item))),
      [
        [1, false, 0],
        [1, false, 0],
      ],
    );
    await tab.close();
  });

  it("its embeddings are saveVector's and listVectors': a note's lands, and one for a note gone since is false, never a throw", async () => {
    const tab = await newTab();
    const a = await tab.note('Alpha');
    assert.equal(await tab.stores.searchIndex.saveVector(a, [0.25, 0.5]), true);
    assert.equal(await tab.stores.searchIndex.saveVector('gone', [1]), false);
    /** @type {VectorRecord[]} */
    const vectors = await tab.stores.searchIndex.getAllVectors();
    assert.deepEqual(
      vectors.map(({ id, noteId, vector }) => ({ id, noteId, vector })),
      [{ id: a, noteId: a, vector: [0.25, 0.5] }],
    );
    // A vector that isn't one is the job's mistake, which rejects with its codes and no content
    await assert.rejects(
      () => tab.stores.searchIndex.saveVector(a, /** @type {any} */ (['secret text'])),
      error =>
        error instanceof StorageFacadeError &&
        error.message === "NewTabNote couldn't run saveVector (rejected: invalid-command)" &&
        !JSON.stringify({ ...error, message: error.message }).includes('secret text'),
    );
    await tab.close();
  });

  it('on a database without the vectors and search_index stores, hasStore says so, and the writes skip as Storage did', async () => {
    const full = await newTab();
    assert.deepEqual(
      ['search_index', 'vectors', 'links', 'conflicts'].map(name => full.stores.searchIndex.hasStore(name)),
      [true, true, true, false],
      "conflicts is #17's store, not one js/storage.js kept",
    );
    await full.close();
    const tab = await newTab({ omit: ['vectors', 'search_index'] });
    assert.deepEqual(
      ['search_index', 'vectors', 'canvases'].map(name => tab.stores.searchIndex.hasStore(name)),
      [false, false, true],
    );
    const a = await tab.note('Alpha');
    assert.equal(await tab.stores.searchIndex.saveVector(a, [1, 2]), false);
    await tab.stores.searchIndex.setSearchIndexEntry(entry(a, 'kept nowhere'));
    await tab.stores.searchIndex.setSearchIndex([entry(a, 'kept nowhere')]);
    assert.deepEqual(await tab.stores.searchIndex.getAllVectors(), []);
    await tab.close();
  });

  it("GraphView's notes are listNotes', and its links listLinks', none without the links store", async () => {
    const tab = await newTab();
    const [active, archived, trashed, template] = [
      await tab.note('Active'),
      await tab.note('Archived'),
      await tab.note('Trashed'),
      await tab.note('Template'),
    ];
    await tab.run({ type: 'archiveNote', noteId: archived });
    await tab.run({ type: 'trashNote', noteId: trashed });
    await tab.run({ type: 'convertNoteToTemplate', noteId: template });
    assert.deepEqual(await tab.stores.graph.getAllNotes(), await tab.data({ type: 'listNotes', view: 'active' }));
    assert.deepEqual(
      await tab.stores.graph.getAllNotes(true),
      await tab.data({ type: 'listNotes', view: 'withArchived' }),
    );
    /** @type {NoteRecord[]} */
    const drawn = await tab.stores.graph.getAllNotes(true);
    assert.deepEqual(drawn.map(note => note.id).sort(), [active, archived].sort());
    const link = { id: 'link-1', fromNoteId: active, toNoteId: archived };
    await putRaw(tab.env, 'links', link);
    assert.deepEqual(await tab.stores.graph.listLinks(), [link]);
    await tab.close();
    const bare = await newTab({ omit: ['links'] });
    assert.deepEqual(await bare.stores.graph.listLinks(), []);
    await bare.close();
  });

  it("what sync uploads is getSyncData's export, every folder in it, and its handle can't apply a remote note", async () => {
    const tab = await newTab();
    await tab.note('Plan');
    await tab.run({ type: 'createFolder', folderId: tab.client.ids.next(), name: 'Work', parentId: null });
    /** @type {ExportData} */
    const exported = await tab.stores.sync.exportAll();
    const fresh = await tab.client.query({ type: 'getSyncData' });
    assert.equal(fresh.kind, 'ready');
    const { exportedAt, ...rest } = /** @type {Record<string, unknown>} */ (fresh.kind === 'ready' ? fresh.data : {});
    assert.equal(typeof exported.exportedAt, 'number');
    assert.deepEqual({ ...exported, exportedAt: undefined }, { ...rest, exportedAt: undefined });
    assert.deepEqual(
      exported.folders.map(folder => folder.name),
      ['Work'],
    );
    assert.deepEqual(
      ['importAll', 'importNote', 'saveElement', 'getStore'].filter(name => name in tab.stores.sync),
      [],
    );
    await tab.close();
  });

  it('a write that does not commit rejects with its command and codes, never what it carried', async () => {
    const tab = await newTab();
    const a = await tab.note('Alpha');
    // A newer build's upgrade closes the tab's connection, so every command answers reload-required
    const upgraded = await new Promise((resolve, reject) => {
      const request = tab.env.indexedDB.open('CanvasTabDB', DB_VERSION + 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    /** @type {IDBDatabase} */ (upgraded).close();
    for (const write of [
      () => tab.stores.searchIndex.setSearchIndexEntry(entry(a, 'pending text')),
      () => tab.stores.searchIndex.setSearchIndex([entry(a, 'pending text')]),
      () => tab.stores.searchIndex.saveVector(a, [3]),
    ]) {
      await assert.rejects(write, error => {
        assert.ok(error instanceof StorageFacadeError);
        assert.match(
          error.message,
          /^NewTabNote couldn't run (updateSearchIndex|saveVector) \(unavailable: reload-required\)$/,
        );
        assert.equal(error.message.includes('pending text'), false);
        return true;
      });
    }
  });
});

describe('the settings llm.js and sync keep outside the kernel (#17 PR 4b)', () => {
  it("are the write-path map's provider and sync keys, the two secrets #20's reader names among them", () => {
    assert.deepEqual([...PROVIDER_SETTING_KEYS], writePaths.PROVIDER_KEYS);
    assert.deepEqual([...SYNC_SETTING_KEYS], writePaths.SYNC_KEYS);
    const secrets = SECRET_SETTING_KEYS.map(key => key.slice('setting_'.length));
    assert.deepEqual(secrets, ['llmApiKey', 'syncWebdavConfig']);
    assert.ok(PROVIDER_SETTING_KEYS.includes(secrets[0]) && SYNC_SETTING_KEYS.includes(secrets[1]));
  });

  it('each is setting_<key> in chrome.storage.local, read and written as Storage did, and a holder reaches only its own', async () => {
    const tab = await newTab();
    const sync = tab.stores.sync;
    const local = tab.env.chrome.local;
    await sync.setSetting('syncProvider', 'webdav');
    await sync.setSetting('syncLastSyncAt', 12345);
    assert.deepEqual([local.setting_syncProvider, local.setting_syncLastSyncAt], ['webdav', 12345]);
    assert.deepEqual(
      [await sync.getSetting('syncProvider'), await sync.getSetting('syncLastSyncAt')],
      ['webdav', 12345],
    );
    // Nothing stored is the default, null unless given, and a stored null is null
    assert.deepEqual(
      [await sync.getSetting('syncWebdavConfig'), await sync.getSetting('syncWebdavConfig', 'none')],
      [null, 'none'],
    );
    await sync.setSetting('syncProvider', null);
    assert.equal(await sync.getSetting('syncProvider', 'webdav'), null);
    // Sync's handle reaches neither the key nor a preference, and reads nothing trying
    const before = tab.env.chrome.calls.length;
    await assert.rejects(() => sync.getSetting('llmApiKey'), TypeError);
    await assert.rejects(() => sync.setSetting('theme', 'dark'), TypeError);
    assert.equal(tab.env.chrome.calls.length, before);
    assert.deepEqual(tab.sent, [], 'no setting went through the kernel');
    await tab.close();
  });

  it('a read that fails answers the default and a write that fails rejects, each logged by the key and the error name only', async () => {
    const tab = await newTab();
    const sync = tab.stores.sync;
    const logged = captureConsole();
    try {
      tab.env.chrome.failNextGet(new Error('read failed for hunter2'));
      assert.equal(await sync.getSetting('syncProvider', 'fallback'), 'fallback');
      const failure = new Error('write failed for hunter2');
      tab.env.chrome.failNextSet(failure);
      await assert.rejects(
        () => sync.setSetting('syncProvider', 'hunter2'),
        error => error === failure,
      );
    } finally {
      logged.restore();
    }
    assert.deepEqual(logged.lines, [
      ['warn', "NewTabNote couldn't read the syncProvider setting:", 'Error'],
      ['error', "NewTabNote couldn't save the syncProvider setting:", 'Error'],
    ]);
    await tab.close();
  });

  it('neither secret reaches a command, a query, a store, a hash, or a log, and each stays where #20 looks for it (#21)', async () => {
    const tab = await newTab();
    const key = `sk-canary-${tab.client.ids.next()}`;
    const password = `pw-canary-${tab.client.ids.next()}`;
    // llm.js's settings, through the Storage global's shell, as LLMService reads and writes them
    const provider = tab.shell;
    const logged = captureConsole();
    try {
      await provider.setSetting('llmApiKey', key);
      await provider.setSetting('llmApiKeyProvider', 'openai');
      assert.equal(await provider.getSetting('llmApiKey', ''), key);
      await tab.stores.sync.setSetting('syncWebdavConfig', {
        serverUrl: 'https://dav.example.test',
        username: 'me',
        password,
      });
      assert.equal(/** @type {any} */ (await tab.stores.sync.getSetting('syncWebdavConfig')).password, password);
      // Failures log no value either, nor a message that could quote one
      tab.env.chrome.failNextSet(new Error(`quota, writing ${key}`));
      await assert.rejects(() => provider.setSetting('llmApiKey', key));
      tab.env.chrome.failNextGet(new Error(`read, reading ${password}`));
      assert.equal(await tab.stores.sync.getSetting('syncWebdavConfig', null), null);
    } finally {
      logged.restore();
    }
    // A command after them, so the operations ledger holds a row to look in
    await tab.note('After');
    // And a recovery point made now, as the worker makes one before a repair, so the recovery
    // database holds a copy of every store to look in (R131)
    await recoveryPointOf(tab.env.indexedDB);
    /** @type {string[]} */
    const databases = (await tab.env.indexedDB.databases()).map((/** @type {{name: string}} */ { name }) => name);
    assert.deepEqual(databases.sort(), ['CanvasTabDB', RECOVERY_DB_NAME]);
    const dumps = await Promise.all(databases.map(name => legacyEnv.dumpDatabase(tab.env.indexedDB, name)));
    assert.ok(JSON.stringify(dumps).includes('"pointId":"p-canary"'), 'the point holds its copy');
    const secrets = [key, password];
    const hashes = secrets.map(secret => createHash('sha256').update(secret).digest('hex'));
    // Every chrome.storage.local key but the two 1.4.x keeps them in, and each of those two
    // holds its own secret alone
    const { setting_llmApiKey: keyed, setting_syncWebdavConfig: config, ...others } = tab.env.chrome.local;
    assert.ok(Object.keys(others).length > 0);
    const held = JSON.stringify([tab.sent, logged.lines, dumps, others]);
    for (const value of [...secrets, ...hashes]) assert.equal(held.includes(value), false);
    assert.deepEqual([JSON.stringify(keyed).includes(password), JSON.stringify(config).includes(key)], [false, false]);
    assert.deepEqual(tab.sent, [], 'no setting went through the kernel');
    // Where 1.4.x keeps them, which #20's reader and remover name, and nowhere else
    assert.equal(keyed, key);
    assert.equal(config.password, password);
    const reader = createLegacySecretReader({ indexedDB: tab.env.indexedDB, settings: tab.host.settings });
    assert.deepEqual([...(await reader.present())].sort(), ['setting_llmApiKey', 'setting_syncWebdavConfig']);
    await tab.close();
  });
});

/**
 * A recovery point of CanvasTabDB as it is, made as the worker makes one before a repair
 * @param {IDBFactory} factory
 */
async function recoveryPointOf(factory) {
  const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(factory, 'CanvasTabDB'));
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(factory, { create: true }));
  try {
    const { point, progress } = await startPoint(recovery, {
      id: 'p-canary',
      kind: 'pre-repair',
      sourceShape: 'current',
      sourceVersion: source.version,
      structuralVersion: null,
      logicalVersion: null,
      target: null,
      stores: storesToCopy(source),
      createdAt: Date.now(),
    });
    const io = {
      keyRange: requireCommonJs('fake-indexeddb').IDBKeyRange,
      crypto: /** @type {any} */ (webcrypto),
      limits: DEFAULT_LIMITS,
    };
    await copyPoint({ source, recovery, point, progress, io });
  } finally {
    source.close();
    recovery.close();
  }
}

/**
 * What the console is handed until `restore`, as [level, ...args], each error with its message
 */
function captureConsole() {
  /** @type {unknown[][]} */
  const lines = [];
  const levels = /** @type {const} */ (['log', 'info', 'debug', 'warn', 'error']);
  const saved = levels.map(level => console[level]);
  for (const level of levels) {
    console[level] = (/** @type {unknown[]} */ ...args) => {
      lines.push([level, ...args.map(arg => (arg instanceof Error ? { name: arg.name, message: arg.message } : arg))]);
    };
  }
  return {
    lines,
    restore() {
      levels.forEach((level, index) => {
        console[level] = saved[index];
      });
    },
  };
}
