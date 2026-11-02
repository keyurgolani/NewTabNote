// #17 PR 4a, what the new tab takes from #17's IndexedDB adapter once its root opens it instead of
// DatabaseManager (js/storage.js): startup maintenance on its `existing` open, the flush before
// another context's upgrade closes the connection, the connection's state in the words App and
// the export notice read, and the legacy stores a degraded database lacks. Each is held to what
// js/storage.js did on the same profile, or to the frozen 1.4.1's. What the holders read of the
// new tab's writes is the facade's since #17 PR 4b, which storage-facade.test.mjs holds, with
// getSyncData's export, without the six fields, in storage-backups.test.mjs.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { INITIALIZED_KEY } from '../../js/kernel/adapters/indexeddb/settings.js';
import { createKernel } from './test-kernel.mjs';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { adapterOn, closeAll, kernelOn, legacyEnv, profile, recordsOf } from './storage-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */

/** @type {{forceCloseDatabase: (db: IDBDatabase) => void}} */
const { forceCloseDatabase } = createRequire(import.meta.url)('fake-indexeddb');

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

/**
 * A profile whose database the worker's run made at this build's version
 * @returns {Promise<Profile>}
 */
async function atThisVersion() {
  const of = await made();
  const worker = adapterOn(of);
  await worker.open();
  worker.close();
  return of;
}

/** A database 1.3.0 to 1.4.x left at 8, which the worker's run didn't get to */
const AT_8 = { records: { canvases: [legacyEnv.note('n1')], elements: [legacyEnv.block('b1', 'n1', 0)] } };

/**
 * @param {Outcome} outcome
 * @returns {unknown}
 */
const unavailableAs = outcome =>
  outcome.kind === 'unavailable' ? [outcome.cause, outcome.code, outcome.retryable] : outcome;

/**
 * Opens CanvasTabDB at `version`, as a newer build's page would, once nothing blocks it
 * @param {IDBFactory} factory
 * @param {number} version
 * @returns {Promise<'opened' | 'blocked'>}
 */
function upgradeTo(factory, version) {
  return new Promise((resolve, reject) => {
    const request = factory.open('CanvasTabDB', version);
    request.onblocked = () => resolve('blocked');
    request.onsuccess = () => {
      request.result.close();
      resolve('opened');
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | 'still waiting'>}
 */
const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(/** @type {const} */ ('still waiting')), ms)),
  ]);

/**
 * The new tab's adapter, as its root makes it in #17 PR 4a: the database as it is, with
 * startup maintenance, and the notes and blocks required
 * @param {Profile} of
 */
const newTabAdapter = of => adapterOn(of, { mode: 'existing', maintains: true, requireCore: true });

/**
 * The frozen v1.4.1's Storage in a page of `of`'s profile, opened with init as its pages opened it
 * @param {Profile} of
 * @returns {Promise<any>}
 */
async function release141On(of) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome, worker: false });
  env.load('test/fixtures/storage/releases/v1.4.1/js/utils.js', 'test/fixtures/storage/releases/v1.4.1/js/storage.js');
  const storage = env.get('Storage');
  await storage.init();
  return storage;
}

describe("the new tab's startup maintenance on #17's adapter (#17 PR 4a)", () => {
  it("an existing open that maintains writes a new profile's first-run settings, on a database at this version and on one left at 8", async () => {
    /**
     * What Storage.initializeDefaultSettings writes on a first run, from the frozen v1.4.1, since
     * js/storage.js's copy went with #17 PR 4b
     * @returns {Promise<Record<string, unknown>>}
     */
    const storageFirstRun = async () => {
      const env = legacyEnv.createLegacyEnv({ context: 'page', worker: false });
      env.load(
        'test/fixtures/storage/releases/v1.4.1/js/utils.js',
        'test/fixtures/storage/releases/v1.4.1/js/storage.js',
      );
      await env.get('Storage').initializeDefaultSettings();
      await legacyEnv.settle();
      return legacyEnv.plain(env.chrome.local);
    };
    for (const [shape, of] of /** @type {const} */ ([
      ['at this version', await atThisVersion()],
      ['at 8', await made(AT_8)],
    ])) {
      const adapter = newTabAdapter(of);
      const ready = adapter.open();
      const tab = createKernel({
        adapter,
        policy: createBaselinePolicy(),
        caller: CALLERS.newtab,
        ids: testIds(),
        clock: testClock(),
        ready,
        maintainOnOpen: true,
      });
      assert.equal(await tab.whenReady(), null, shape);
      assert.deepEqual(legacyEnv.plain(of.chrome.local), await storageFirstRun(), shape);
      // Once it has run, a start writes nothing
      const writes = of.chrome.writes().length;
      const again = await tab.execute({ type: 'runStartupMaintenance', commandId: 'm2' });
      assert.equal(again.kind, 'committed', shape);
      assert.equal(of.chrome.writes().length, writes, shape);
      assert.equal(of.chrome.local[INITIALIZED_KEY], true, shape);
    }
  });

  it("Popup's and Side Panel's open, which doesn't maintain, still refuses it and writes nothing", async () => {
    const of = await atThisVersion();
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const outcome = await kernelOn(adapter).execute({ type: 'runStartupMaintenance', commandId: 'm1' });
    assert.deepEqual(unavailableAs(outcome), ['adapter', 'maintenance-needs-versioned-open', false]);
    assert.deepEqual(of.chrome.writes(), []);
  });
});

describe("the new tab's connection on #17's adapter (#17 PR 4a)", () => {
  it("a write a flush opens as another context's upgrade closes the connection still commits", async () => {
    const of = await atThisVersion();
    const adapter = newTabAdapter(of);
    await adapter.open();
    const tab = kernelOn(adapter);
    assert.equal((await tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' })).kind, 'committed');
    /** @type {string[]} */
    const ran = [];
    /** @type {Promise<Outcome> | null} */
    let flushed = null;
    adapter.beforeClose(() => {
      ran.push('throws');
      throw new Error('A flush that throws');
    });
    adapter.beforeClose(() => {
      ran.push('saves');
      flushed = tab.execute({
        type: 'saveNoteContent',
        commandId: 's1',
        noteId: 'n1',
        blocks: [{ id: 'b1', type: 'text', content: 'Typed just before the upgrade' }],
        preview: 'Typed just before the upgrade',
      });
    });
    const stop = adapter.beforeClose(() => ran.push('stopped'));
    stop();
    assert.equal(adapter.openState(), 'open');

    // A newer build's page upgrading past this build: the close lets the save finish first
    assert.equal(await within(upgradeTo(of.real, DB_VERSION + 1), 2000), 'opened');
    assert.deepEqual(ran, ['throws', 'saves']);
    assert.equal((await /** @type {Promise<Outcome>} */ (/** @type {unknown} */ (flushed))).kind, 'committed');
    const blocks = /** @type {any[]} */ (await recordsOf(of, 'elements'));
    assert.deepEqual(
      blocks.map(block => block.content),
      ['Typed just before the upgrade'],
    );
    assert.equal(adapter.openState(), 'version-changed');
    // Whatever comes after asks for a reload, and no flush runs again
    const later = await tab.execute({ type: 'createNote', commandId: 'c2', noteId: 'n2' });
    assert.deepEqual(unavailableAs(later), ['storage', 'reload-required', false]);
    assert.deepEqual(ran, ['throws', 'saves']);
  });

  it("a connection Chrome closes itself runs no flush, as Storage's doesn't, and says so", async () => {
    const of = await atThisVersion();
    const adapter = newTabAdapter(of);
    await adapter.open();
    /** @type {string[]} */
    const ran = [];
    adapter.beforeClose(() => ran.push('flushed'));
    forceCloseDatabase(/** @type {IDBDatabase} */ (of.faults.connections.at(-1)));
    await legacyEnv.settle();
    assert.deepEqual(ran, []);
    assert.equal(adapter.openState(), 'closed-by-browser');
  });

  it("openState and missingStores answer as Storage's did, for every way the new tab's open goes", async () => {
    /**
     * Each case: the profile, then what happens to the open connection, if anything, and the
     * words js/storage.js's openState and missingStores gave for it, which App reads
     * @type {Array<[string, () => Promise<Profile>, ((of: Profile, connection: IDBDatabase) => Promise<void>) | null, string, string[]]>}
     */
    const cases = [
      ['at this version', atThisVersion, null, 'open', []],
      ['at 8, without some stores', () => made({ ...AT_8, omit: ['search_index', 'themes'] }), null, 'open', ['search_index', 'themes']],
      [
        'upgraded by a newer build',
        async () => {
          const of = await atThisVersion();
          await upgradeTo(of.real, DB_VERSION + 1);
          return of;
        },
        null,
        'newer-version',
        [],
      ],
      ['at 8, without its blocks', () => made({ omit: ['elements'] }), null, 'missing-core-stores', ['elements']],
      [
        'closed by an upgrade',
        atThisVersion,
        async of => {
          await upgradeTo(of.real, DB_VERSION + 1);
        },
        'version-changed',
        [],
      ],
      [
        'closed by Chrome',
        atThisVersion,
        async (of, connection) => {
          forceCloseDatabase(connection);
          await legacyEnv.settle();
        },
        'closed-by-browser',
        [],
      ],
    ];
    for (const [name, make, then, openState, missingStores] of cases) {
      const ours = await make();
      const adapter = newTabAdapter(ours);
      assert.equal(adapter.openState(), 'closed', name);
      await adapter.open().catch(() => {});
      if (then) await then(ours, /** @type {IDBDatabase} */ (ours.faults.connections.at(-1)));
      assert.equal(adapter.openState(), openState, name);
      assert.deepEqual(adapter.missingStores(), missingStores, name);
    }

    // close() leaves it closed, as before it opened
    const of = await atThisVersion();
    const adapter = newTabAdapter(of);
    await adapter.open();
    adapter.close();
    assert.equal(adapter.openState(), 'closed');
  });

  it("missingStores names the legacy stores a database at 8 lacks, in Storage's order, and none at this version", async () => {
    const of = await made({ ...AT_8, omit: ['themes', 'folders', 'snapshots'] });
    const adapter = newTabAdapter(of);
    assert.deepEqual(adapter.missingStores(), []);
    await adapter.open();
    assert.deepEqual(adapter.missingStores(), ['folders', 'themes', 'snapshots']);
    // A copy, which the caller can't change
    adapter.missingStores().push('canvases');
    assert.deepEqual(adapter.missingStores(), ['folders', 'themes', 'snapshots']);

    const current = await atThisVersion();
    const opened = newTabAdapter(current);
    await opened.open();
    assert.deepEqual(opened.missingStores(), []);
  });
});

describe("#33's recovery copy, before the new tab opens a database at 8 that lacks a store (#17 PR 4a)", () => {
  /** A database 1.4.x left at 8 without themes, holding a note, a block, an image, and a key in settings */
  const WITHOUT_THEMES = {
    omit: ['themes'],
    records: {
      canvases: [legacyEnv.note('n1', { name: 'Kept' })],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Kept text')],
      // Versions up to 1.1.2 kept the AI key here in plaintext, so no copy takes it
      settings: [{ key: 'llmApiKey', value: 'test-key-not-a-secret' }],
      media: [{ id: 'm1', canvasId: 'n1', blob: new Blob(['png bytes'], { type: 'image/png' }), createdAt: 1 }],
    },
  };

  /**
   * The new tab's adapter as its root makes it, copying first
   * @param {Profile} of
   * @param {object} [options]
   */
  const copying = (of, options = {}) =>
    adapterOn(of, { mode: 'existing', maintains: true, requireCore: true, copiesMissingStores: true, ...options });

  /**
   * Each recovery copy in `of`'s chrome.storage.local, by key
   * @param {Profile} of
   * @returns {Array<[string, any]>}
   */
  const copiesIn = of =>
    Object.entries(legacyEnv.plain(of.chrome.local)).filter(([key]) => key.startsWith('recovery_backup_'));

  /** @param {Profile} of */
  const copyWrites = of =>
    of.chrome.calls.filter(
      (/** @type {any} */ call) =>
        call.method === 'set' && call.keys.some((/** @type {string} */ key) => key.startsWith('recovery_backup_')),
    );

  it("writes what 1.4.1's page open writes, once, leaving the database as it was, and the page opens", async () => {
    const ours = await made(WITHOUT_THEMES);
    const before = await legacyEnv.dumpDatabase(ours.real);
    const adapter = copying(ours);
    await adapter.open();
    assert.deepEqual([adapter.openState(), adapter.missingStores()], ['open', ['themes']]);
    assert.deepEqual(await legacyEnv.dumpDatabase(ours.real), before);

    const theirs = await made(WITHOUT_THEMES);
    const storage = await release141On(theirs);
    storage.db.close();

    const [mine, storages] = [copiesIn(ours), copiesIn(theirs)];
    assert.equal(mine.length, 1);
    assert.equal(storages.length, 1);
    const [[key, copy]] = mine;
    assert.match(key, /^recovery_backup_\d+$/);
    /** @param {any} value */
    const timeless = value => ({ ...value, timestamp: 0 });
    assert.deepEqual(timeless(copy), timeless(storages[0][1]));
    assert.deepEqual(copy.missingStores, ['themes']);
    assert.equal(copy.settings, undefined, 'settings left out');
    assert.ok(!JSON.stringify(copy).includes('test-key-not-a-secret'), 'no plaintext key in the copy');
    assert.equal(copy.media[0].blob, `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`);
    // The marker names the copy and the stores it was made for, so the next start reads one value
    const marker = legacyEnv.plain(ours.chrome.local).recovery_copy_missing_stores;
    assert.deepEqual(marker, { key, missingStores: ['themes'], timestamp: copy.timestamp });
    assert.deepEqual(
      { ...marker, key: '', timestamp: 0 },
      { ...legacyEnv.plain(theirs.chrome.local).recovery_copy_missing_stores, key: '', timestamp: 0 },
    );
  });

  it('a later open writes no second copy for the same missing stores, and no open reads all of chrome.storage.local', async () => {
    const of = await made(WITHOUT_THEMES);
    // Backups already stored, which a full read would load into memory before the page renders
    of.chrome.local.auto_backup_1 = { version: 1, canvases: [], elements: [] };
    of.chrome.local.recovery_backup_1 = { recoveryBackup: true, reason: 'pre-import-replace', canvases: [] };
    const first = copying(of);
    await first.open();
    first.close();
    const second = copying(of);
    await second.open();
    assert.equal(copyWrites(of).length, 1);
    assert.equal(copiesIn(of).filter(([, copy]) => copy.reason === 'missing-stores').length, 1);
    const fullReads = of.chrome.calls.filter(
      (/** @type {any} */ call) => call.method === 'get' && (call.keys === null || call.keys === undefined),
    );
    assert.deepEqual(fullReads, []);
  });

  it('two tabs opening at once write one copy between them, and without Web Locks an open still writes it', async () => {
    const of = await made(WITHOUT_THEMES);
    const locks = legacyEnv.createLockManager();
    // Each look for the marker waits a little, so without the lock the two would overlap
    const local = of.chrome.api.storage.local;
    const realGet = local.get.bind(local);
    local.get = (/** @type {any} */ keys, /** @type {any} */ callback) =>
      Array.isArray(keys) && keys.includes('recovery_copy_missing_stores')
        ? new Promise(resolve => setTimeout(resolve, 20)).then(() => realGet(keys, callback))
        : realGet(keys, callback);
    await Promise.all([copying(of, { locks }).open(), copying(of, { locks }).open()]);
    assert.equal(copyWrites(of).length, 1);

    const unlocked = await made(WITHOUT_THEMES);
    await copying(unlocked, { locks: null }).open();
    assert.equal(copiesIn(unlocked).length, 1);
  });

  it("a database at this version, or at 8 with every store, gets none, and neither does an open that doesn't copy", async () => {
    for (const [shape, of] of /** @type {const} */ ([
      ['at this version', await atThisVersion()],
      ['at 8 with every store', await made(AT_8)],
    ])) {
      await copying(of).open();
      assert.deepEqual(copiesIn(of), [], shape);
    }
    const popup = await made(WITHOUT_THEMES);
    await adapterOn(popup, { mode: 'existing' }).open();
    assert.deepEqual(copiesIn(popup), []);
  });

  it("a copy that can't be written leaves the page to open, and the next open writes it", async () => {
    const of = await made(WITHOUT_THEMES);
    of.chrome.failNextSet();
    const first = copying(of);
    await first.open();
    assert.equal(first.openState(), 'open');
    assert.deepEqual(copiesIn(of), []);
    assert.equal(of.chrome.local.recovery_copy_missing_stores, undefined);
    first.close();
    await copying(of).open();
    assert.equal(copiesIn(of).length, 1);
  });

  it("is written for a database at 8 without its blocks too, which the page then refuses, as Storage's is", async () => {
    const of = await made({ omit: ['elements'], records: { canvases: [legacyEnv.note('n1', { name: 'Kept' })] } });
    const adapter = copying(of);
    await adapter.open().catch(() => {});
    assert.equal(adapter.openState(), 'missing-core-stores');
    const [[, copy]] = copiesIn(of);
    assert.deepEqual(copy.missingStores, ['elements']);
  });
});
