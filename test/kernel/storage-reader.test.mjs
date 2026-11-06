// #17's read-only reader (#35 slice 4b-0b): what a page that only reads opens CanvasTabDB with,
// once its writes go to the worker (4b on). It opens the database as it is, as #17's adapter's
// `existing` mode does, reads what that adapter reads and answers as it does, and holds nothing
// that writes: no commit, no recall, no export, no upgrade, and no module the architecture list
// (docs/architecture/committers.json) gives the role `writer`.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIndexedDbReader } from '../../js/kernel/adapters/indexeddb/reader.js';
import { DB_VERSION, IDB_STORES } from '../../js/kernel/adapters/indexeddb/schema.js';
import { IDB_SETTINGS_KEYS } from '../../js/kernel/core/ports/repository.js';
import { reachGraph } from './import-graph.mjs';
import { profileWith, synthesized } from './migration-support.mjs';
import { adapterOn, closeAll, kernelOn, legacyEnv, profile } from './storage-fixture.mjs';
import { CALLERS } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */
/** @typedef {import('../../js/kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../js/kernel/adapters/indexeddb/reader.js').IndexedDbReaderOptions} IndexedDbReaderOptions */
/** @typedef {{value?: unknown, failed?: unknown[]}} Settled */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEXEDDB = 'js/kernel/adapters/indexeddb';

/** @type {{forceCloseDatabase: (db: IDBDatabase) => void}} */
const fake = createRequire(import.meta.url)('fake-indexeddb');

/** Every store #17's adapter reads */
const STORE_NAMES = /** @type {StoreName[]} */ (Object.keys(IDB_STORES));

/** The settings areas a context reads from chrome.storage.local (ports/repository.js, SettingsArea) */
const AREAS = /** @type {const} */ (['preferences', 'session', 'jobs', 'chat', 'onboarding', 'backup', 'upgrade']);

/** The keys each area is read for: ones the builds write, and one none does */
const SETTING_KEYS = Object.freeze([
  'theme',
  'font',
  'trashRetention',
  'dailyNoteTemplate',
  'lastAutoTitleRun',
  'never-set',
]);

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

/**
 * A profile, with a database made from `spec` first when given
 * @param {object} [spec] - for legacyEnv.createDatabase
 */
async function made(spec) {
  const of = profile();
  profiles.push(of);
  if (spec) await legacyEnv.createDatabase(of.real, spec);
  return of;
}

/** A profile whose database a legacy build made, with one note */
const legacy = () => made({ records: { canvases: [legacyEnv.note('n1')] } });

/**
 * A profile whose database the worker's adapter made at this build's version, the ledger's store
 * included, on the profile's own factory, so no fault or close a case makes reaches it
 */
async function current() {
  const of = await made();
  const worker = adapterOn(of, { indexedDB: of.real });
  await worker.open();
  worker.close();
  return of;
}

/**
 * The reader over `of`, as a page's root would make it
 * @param {Profile} of
 * @param {Partial<import('../../js/kernel/adapters/indexeddb/reader.js').IndexedDbReaderOptions>} [options]
 */
function readerOn(of, options = {}) {
  const reader = createIndexedDbReader({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    ...options,
  });
  of.adapters.push(/** @type {any} */ (reader));
  return reader;
}

/**
 * What a page's query answers, on `store`, as Popup asks it
 * @param {any} store - the reader or #17's adapter, opened
 * @param {{type: string} & Record<string, unknown>} query
 */
const asPopup = (store, query) => kernelOn(store, undefined, CALLERS.popup).query(/** @type {any} */ (query));

/**
 * What `run` answers, or how it fails: by cause and code, or by name for IndexedDB's own, so
 * the reader's answers and #17's adapter's compare
 * @param {() => unknown} run
 * @returns {Promise<Settled>}
 */
async function settled(run) {
  try {
    return { value: await run() };
  } catch (error) {
    const { unavailableCause, code, retryable, name } = /** @type {any} */ (error);
    return { failed: [unavailableCause, code, retryable, name] };
  }
}

/**
 * Every read method's answer on `store`, in one read through `on`: the reader or #17's adapter
 * @param {any} on
 * @param {StoreName} store
 * @param {string} noteId - a note the database holds, for the reads by index
 */
const everyRead = (on, store, noteId) =>
  settled(() =>
    on.read([store], async (/** @type {any} */ tx) => {
      const keys = await settled(() => tx.getAllKeys(store));
      const key = Array.isArray(keys.value) && keys.value.length > 0 ? keys.value[0] : 'none';
      const index = store === 'snapshots' ? 'noteId' : 'canvasId';
      return {
        has: await settled(() => tx.has(store)),
        getAll: await settled(() => tx.getAll(store)),
        keys,
        get: await settled(() => tx.get(store, key)),
        getKey: await settled(() => tx.getKey(store, key)),
        revision: await settled(() => tx.revision(store, key)),
        versions: await settled(() => tx.versions(store, key)),
        unread: await settled(() => tx.versions(store, 'never-read')),
        byIndex: await settled(() => tx.getAllByIndex(store, index, noteId)),
        keysByIndex: await settled(() => tx.getKeysByIndex(store, index, noteId)),
        dailyAnswer: await settled(() => tx.dailyAnswer()),
      };
    }),
  );

/**
 * A read, a settings read and a ledger read through `on`, each one's answer or failure
 * @param {any} on - the reader or #17's adapter
 */
const threeReads = async on => [
  await settled(() => on.read(['notes'], (/** @type {any} */ tx) => tx.getAll('notes'))),
  await settled(() => on.readSettings('idbSettings', IDB_SETTINGS_KEYS)),
  await settled(() => on.ledger.status('c-any')),
];

/**
 * Opens CanvasTabDB at `version` on `factory`, as another context's upgrade does, once every
 * other connection has closed for it
 * @param {IDBFactory} factory
 * @param {number} version
 */
const upgradeElsewhere = (factory, version) =>
  new Promise((resolve, reject) => {
    const request = factory.open('CanvasTabDB', version);
    request.onsuccess = () => {
      request.result.close();
      resolve(undefined);
    };
    request.onerror = () => reject(request.error);
  });

/**
 * A way the read half fails, with the code each of its reads answers: what makes each context's
 * profile, the options both get, what runs before the reads (the open, by default), and the
 * reads (threeReads, by default)
 * @typedef {object} Failure
 * @property {string} code
 * @property {string} why
 * @property {() => Promise<Profile>} make
 * @property {Partial<IndexedDbReaderOptions>} [options]
 * @property {(context: any, of: Profile) => Promise<unknown>} [ready]
 * @property {(context: any, of: Profile) => Promise<Settled[]>} [ask]
 */

/** Opens `context`, whatever the open answers, which its reads answer after it */
const opened = (/** @type {any} */ context) => context.open().catch(() => {});

/**
 * Closes each connection `of`'s factory opened, as `close` does
 * @param {Profile} of
 * @param {(connection: IDBDatabase) => void} close
 */
const closeEach = (of, close) => of.faults.connections.forEach(connection => close(connection));

/** chrome.storage.local, with a get that fails with `message` */
const failingGet = (/** @type {string} */ message) => ({
  get: async () => {
    throw new Error(message);
  },
});

/** A settings read from chrome.storage.local */
const preferences = async (/** @type {any} */ context) => [
  await settled(() => context.readSettings('preferences', ['theme'])),
];

/** @type {Failure[]} */
const FAILURES = [
  { code: 'no-database', why: 'no database', make: () => made() },
  {
    code: 'version-too-new',
    why: 'one a newer build upgraded',
    make: () =>
      made({
        records: { canvases: [legacyEnv.note('n1')] },
        version: DB_VERSION + 1,
        extraStores: { meta: { keyPath: 'key' } },
      }),
  },
  {
    code: 'missing-core-stores',
    why: 'none of its core stores',
    make: () => made({ omit: ['canvases'] }),
    options: { requireCore: true },
  },
  {
    code: 'open-pending',
    why: "an open that waits on the worker's run, which never ends here",
    make: legacy,
    options: { awaitUpgrade: () => new Promise(() => {}) },
    ready: async context => void context.open().catch(() => {}),
  },
  { code: 'not-open', why: 'no open', make: legacy, ready: async () => {} },
  {
    code: 'open-failed',
    why: 'an open IndexedDB fails',
    make: legacy,
    ready: (context, of) => {
      of.faults.failNextOpen('CanvasTabDB', 'UnknownError');
      return opened(context);
    },
  },
  {
    code: 'reload-required',
    why: "a connection another context's upgrade closed",
    make: legacy,
    ready: async (context, of) => {
      await opened(context);
      await upgradeElsewhere(of.real, 9);
    },
  },
  {
    code: 'reload-required',
    why: 'a connection the browser closed',
    make: legacy,
    ready: async (context, of) => {
      await opened(context);
      closeEach(of, fake.forceCloseDatabase);
    },
  },
  {
    code: 'reload-required',
    why: 'a connection closing, on which no transaction starts',
    make: current,
    ready: async (context, of) => {
      await opened(context);
      closeEach(of, connection => connection.close());
    },
  },
  {
    code: 'reload-required',
    why: 'a read that fails as its connection closes',
    make: current,
    ask: async (context, of) => [
      await settled(() =>
        context.read(['notes'], async (/** @type {any} */ tx) => {
          closeEach(of, connection => connection.close());
          of.faults.failNextRead(IDB_STORES.notes, 'UnknownError');
          return tx.getAll('notes');
        }),
      ),
    ],
  },
  {
    code: 'reload-required',
    why: 'a read once the browser closed its connection',
    make: current,
    ask: async (context, of) => [
      await settled(() =>
        context.read(['notes'], async (/** @type {any} */ tx) => {
          const closes = of.faults.connections.map(
            connection => new Promise(resolve => connection.addEventListener('close', resolve)),
          );
          closeEach(of, fake.forceCloseDatabase);
          // The browser closes it once its transactions end, this one's included
          await Promise.all(closes);
          return tx.getAll('notes');
        }),
      ),
    ],
  },
  {
    code: 'unknown-store',
    why: 'a store it has no name for',
    make: legacy,
    ask: async context => [await settled(() => context.read(['nope'], async () => 'read'))],
  },
  {
    code: 'setting-not-served',
    why: "a setting IndexedDB's store holds that no kernel code reads",
    make: legacy,
    ask: async context => [await settled(() => context.readSettings('idbSettings', ['llmApiKey']))],
  },
  {
    code: 'adapter-failed',
    why: 'a read whose body fails as no IndexedDB call does',
    make: legacy,
    ask: async context => [
      await settled(() =>
        context.read(['notes'], async () => {
          throw new TypeError('a body that failed');
        }),
      ),
    ],
  },
  {
    code: 'settings-read-failed',
    why: "chrome.storage.local's get failing",
    make: legacy,
    options: { settings: failingGet('a get that failed') },
    ask: preferences,
  },
  {
    code: 'quota',
    why: "chrome.storage.local's get failing for its quota",
    make: legacy,
    options: { settings: failingGet('QUOTA_BYTES quota exceeded') },
    ask: preferences,
  },
];

/**
 * How `failure`'s reads settle on #17's adapter in existing mode and on the reader, each on a
 * profile of its own, with each one's open state after them
 * @param {Failure} failure
 */
async function bothFail(failure) {
  const answers = [];
  /** @type {Array<(of: Profile, options?: Partial<IndexedDbReaderOptions>) => any>} */
  const contexts = [(of, options) => adapterOn(of, /** @type {any} */ ({ mode: 'existing', ...options })), readerOn];
  for (const contextOn of contexts) {
    const of = await failure.make();
    const context = contextOn(of, failure.options);
    await (failure.ready ?? opened)(context, of);
    const asked = await (failure.ask ?? threeReads)(context, of);
    answers.push({ asked, state: context.openState() });
  }
  return answers;
}

describe("#17's read-only reader (#35 slice 4b-0b)", () => {
  it("opens a database as it is, and answers Popup's queries and setting reads as #17's adapter does in existing mode", async () => {
    const of = await made({
      records: {
        canvases: [legacyEnv.note('n1', { name: 'Kept' })],
        settings: [
          { key: 'insightsEnabled', value: true },
          { key: 'llmApiKey', value: 'test-only-value' },
        ],
      },
    });
    const before = await legacyEnv.dumpDatabase(of.real);
    const adapter = adapterOn(of, { mode: 'existing' });
    const reader = readerOn(of);
    await adapter.open();
    await reader.open();
    for (const query of [{ type: 'listNotes', view: 'popup' }, { type: 'getPopupInsightsEnabled' }]) {
      assert.deepEqual(await asPopup(reader, query), await asPopup(adapter, query), query.type);
    }
    // The settings store also holds 1.4.x's provider keys, which nothing in the kernel may read
    await assert.rejects(reader.readSettings('idbSettings', ['llmApiKey']), { code: 'setting-not-served' });
    reader.close();
    adapter.close();
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });

  it('never upgrades and never makes a database: one at version 7 stays as it was, and a profile without one gets none', async () => {
    const of = await made({ version: 7, omit: ['snapshots'], records: { canvases: [legacyEnv.note('n1')] } });
    const before = await legacyEnv.dumpDatabase(of.real);
    const reader = readerOn(of);
    await reader.open();
    const list = await asPopup(reader, { type: 'listNotes', view: 'popup' });
    assert.deepEqual(list.kind === 'ready' && /** @type {Array<{id: string}>} */ (list.data).map(note => note.id), [
      'n1',
    ]);
    reader.close();
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);

    const empty = await made();
    await assert.rejects(readerOn(empty).open(), error => {
      const { unavailableCause, code } = /** @type {any} */ (error);
      return unavailableCause === 'storage' && code === 'no-database';
    });
    assert.deepEqual(await empty.real.databases(), []);
  });

  it('refuses a database a newer build upgraded, as the adapter does, and leaves it as it was', async () => {
    const of = await made({
      version: DB_VERSION + 1,
      extraStores: { meta: { keyPath: 'key' } },
      records: { canvases: [legacyEnv.note('n1')] },
    });
    const before = await legacyEnv.dumpDatabase(of.real);
    await assert.rejects(readerOn(of).open(), error => {
      const { unavailableCause, code, retryable } = /** @type {any} */ (error);
      return unavailableCause === 'newer-schema' && code === 'version-too-new' && retryable === false;
    });
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });

  it("holds nothing that writes: no commit, recall or export, and its ledger answers a command's status as the adapter's does", async () => {
    // The worker's adapter makes the database at this build's version, with its ledger
    const of = await made();
    const reader = readerOn(of);
    for (const name of ['commit', 'recall', 'exportBackup', 'exportData']) {
      assert.equal(Object.hasOwn(reader, name), false, name);
    }
    const adapter = adapterOn(of);
    await adapter.open();
    const kernel = kernelOn(adapter);
    const block = (/** @type {string} */ content) => ({ id: 'b1', type: 'text', content, order: 0 });
    /** @type {any} */
    const create = { type: 'createNote', commandId: 'c-made', noteId: 'n2', name: 'Made', blocks: [block('One')] };
    assert.equal((await kernel.execute(create)).kind, 'committed');
    const save = { type: 'saveNoteContent', commandId: 'c-newer', noteId: 'n2', blocks: [block('Two')] };
    assert.equal((await kernel.execute(/** @type {any} */ (save))).kind, 'committed');
    /** @type {any} */
    const stale = { ...save, commandId: 'c-stale', blocks: [block('Stale')], expectedRevision: 1 };
    assert.equal((await kernel.execute(stale)).kind, 'conflict');
    await reader.open();
    for (const commandId of ['c-made', 'c-newer', 'c-stale', 'c-never-sent']) {
      assert.deepEqual(await reader.ledger.status(commandId), await adapter.ledger.status(commandId), commandId);
    }
    // Its read compares the command too: another under a kept commandId is key reuse
    for (const command of [create, stale, { ...create, name: 'Another' }]) {
      const label = `${command.commandId} ${command.name ?? ''}`;
      assert.deepEqual(await reader.ledger.read(command), await adapter.ledger.read(command), label);
    }
    assert.deepEqual(await reader.ledger.read({ ...create, name: 'Another' }), { status: 'key-reuse' });
  });

  it("answers every read, Popup's queries, every settings read and the ledger as #17's adapter in existing mode does, on every synthesized fixture, and leaves each as it was", async () => {
    const fixtures = synthesized();
    assert.ok(fixtures.size >= 20, `${fixtures.size} fixtures`);
    /**
     * The fixtures both opened, so their reads answered more than the open's failure
     * @type {string[]}
     */
    const read = [];
    for (const [id, fixture] of fixtures) {
      const of = /** @type {Profile} */ ({ ...(await profileWith(/** @type {any} */ (fixture))), adapters: [] });
      profiles.push(of);
      const had = (await of.real.databases()).some(database => database.name === 'CanvasTabDB');
      const before = had ? await legacyEnv.dumpDatabase(of.real) : null;
      const adapter = adapterOn(of, { mode: 'existing' });
      const reader = readerOn(of);
      const opened = await settled(() => adapter.open());
      assert.deepEqual(await settled(() => reader.open()), opened, `${id}: the open`);
      if (!('failed' in opened)) read.push(id);
      const notes = await settled(() => adapter.read(['notes'], tx => tx.getAllKeys('notes')));
      const noteId = Array.isArray(notes.value) && notes.value.length > 0 ? notes.value[0] : 'none';
      for (const store of STORE_NAMES) {
        assert.deepEqual(
          await everyRead(reader, store, noteId),
          await everyRead(adapter, store, noteId),
          `${id}: ${store}`,
        );
      }
      for (const query of [{ type: 'listNotes', view: 'popup' }, { type: 'getPopupInsightsEnabled' }]) {
        assert.deepEqual(await asPopup(reader, query), await asPopup(adapter, query), `${id}: ${query.type}`);
      }
      /** @type {Array<[import('../../js/kernel/core/ports/repository.js').ReadableSettingsArea, readonly string[]]>} */
      const settingReads = [
        ['idbSettings', IDB_SETTINGS_KEYS],
        ['idbSettings', ['llmApiKey']],
        ...AREAS.map(area => /** @type {[typeof area, readonly string[]]} */ ([area, SETTING_KEYS])),
      ];
      for (const [area, keys] of settingReads) {
        const answer = await settled(() => adapter.readSettings(area, keys));
        assert.deepEqual(await settled(() => reader.readSettings(area, keys)), answer, `${id}: ${area} ${keys}`);
      }
      /** @type {any} */
      const never = { type: 'createNote', commandId: 'c-never-sent', noteId: 'n-never', name: 'Never' };
      const status = await settled(() => adapter.ledger.status(never.commandId));
      assert.deepEqual(await settled(() => reader.ledger.status(never.commandId)), status, `${id}: status`);
      const kept = await settled(() => adapter.ledger.read(never));
      assert.deepEqual(await settled(() => reader.ledger.read(never)), kept, `${id}: the ledger's read`);
      reader.close();
      adapter.close();
      if (before) assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before, `${id}: left as it was`);
      else assert.deepEqual(await of.real.databases(), [], `${id}: no database made`);
    }
    // Both open every fixture as it is, an empty database at version 1 included, but the profile
    // with no database and the one a later build upgraded to 12
    assert.deepEqual(
      [...fixtures.keys()].filter(id => !read.includes(id)),
      ['none.basic', 'v9.newer'],
    );
  });

  it("fails as #17's adapter in existing mode does, in every way the read half can fail, each on a profile of its own", async () => {
    for (const failure of FAILURES) {
      const [adapter, reader] = await bothFail(failure);
      assert.deepEqual(reader, adapter, failure.why);
      assert.deepEqual(
        adapter.asked.map(answer => answer.failed?.[1]),
        adapter.asked.map(() => failure.code),
        `${failure.why}: what each read fails with`,
      );
    }
  });

  it('reaches no module the architecture list gives the role writer', () => {
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'architecture', 'committers.json'), 'utf8'));
    const writers = new Set(
      Object.entries(list.indexeddb)
        .filter(([, role]) => role === 'writer')
        .map(([file]) => `${INDEXEDDB}/${file}`),
    );
    const { modules } = reachGraph([path.join(ROOT, INDEXEDDB, 'reader.js')], {
      readFile: file => fs.readFileSync(file, 'utf8'),
    });
    const reached = [...modules]
      .map(file => path.relative(ROOT, file).split(path.sep).join('/'))
      .filter(file => writers.has(file));
    assert.deepEqual(reached, []);
  });
});
