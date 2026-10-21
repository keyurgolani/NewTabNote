// How #17's IndexedDB adapter opens CanvasTabDB (#17 slice 1): it changes nothing about the
// database Storage.open wouldn't, a blocked or slow open answers within openWithinMs and keeps
// waiting, a connection another context's upgrade or Chrome closes answers reload-required,
// a newer database is refused and left alone, and startup maintenance writes what Storage
// writes on a first run.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { FIRST_RUN_SETTINGS, INITIALIZED_KEY } from '../../js/kernel/adapters/indexeddb/settings.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { adapterOn, closeAll, kernelOn, legacyEnv, profile } from './storage-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */
/** @typedef {import('./storage-fixture.mjs').IndexedDbAdapter} IndexedDbAdapter */
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
 * @param {Outcome} outcome
 * @returns {unknown}
 */
const unavailableAs = outcome =>
  outcome.kind === 'unavailable' ? [outcome.cause, outcome.code, outcome.retryable] : outcome;

/**
 * Whether `factory` can open CanvasTabDB at `version` without any connection blocking it
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

/** The shapes an older or damaged profile can leave, as #17's support matrix lists them */
const SHAPES = /** @type {const} */ ({
  'no database': undefined,
  'version 2 (1.0.0 to 1.1.5)': {
    version: 2,
    omit: ['search_index', 'folders', 'links', 'themes', 'vectors', 'snapshots'],
    records: { canvases: [legacyEnv.note('n1')], elements: [legacyEnv.block('b1', 'n1', 0)] },
  },
  'version 7 (1.2.0)': { version: 7, omit: ['snapshots'], records: { canvases: [legacyEnv.note('n1')] } },
  'version 8 (1.3.0 to 1.4.x)': { records: { canvases: [legacyEnv.note('n1')], folders: [{ id: 'f1', name: 'F' }] } },
  'version 8 without some stores': { omit: ['search_index', 'themes', 'snapshots'] },
  'version 8 without themes, holding a note, a setting, and an image': {
    omit: ['themes'],
    records: {
      canvases: [legacyEnv.note('n1', { name: 'Kept' })],
      elements: [legacyEnv.block('b1', 'n1', 0)],
      // Versions up to 1.1.2 kept the AI key here in plaintext, so no copy takes it
      settings: [{ key: 'llmApiKey', value: 'test-key-not-a-secret' }],
      media: [{ id: 'm1', canvasId: 'n1', blob: new Blob(['png bytes'], { type: 'image/png' }), createdAt: 1 }],
    },
  },
});

/**
 * chrome.storage.local with each recovery copy's key and time made stable, so two copies
 * written moments apart compare equal
 * @param {Profile} of
 * @returns {Record<string, unknown>}
 */
function settingsOf(of) {
  /** @type {Record<string, any>} */
  const local = legacyEnv.plain(of.chrome.local);
  /** @type {Record<string, unknown>} */
  const stable = {};
  for (const [key, value] of Object.entries(local)) {
    if (/^recovery_backup_\d+$/.test(key)) {
      assert.equal(typeof value.timestamp, 'number');
      stable['recovery_backup_<time>'] = { ...value, timestamp: '<time>' };
    } else if (key === 'recovery_copy_missing_stores') {
      assert.ok(Object.hasOwn(local, value.key), 'the marker names the copy it was written with');
      assert.equal(value.timestamp, local[value.key].timestamp);
      stable[key] = { ...value, key: 'recovery_backup_<time>', timestamp: '<time>' };
    } else {
      stable[key] = value;
    }
  }
  return stable;
}

/** @param {Profile} of */
const copiesIn = of => Object.keys(of.chrome.local).filter(key => /^recovery_backup_\d+$/.test(key));

/** The key that names the missing-stores copy, which Storage and the adapter both read first */
const MARKER = 'recovery_copy_missing_stores';

/**
 * Holds chrome.storage.local reads of the copy's marker until a second one arrives, or for 50
 * event-loop turns, so two pages that open together both look before either writes. Takes
 * Storage's callback reads and the adapter's promise reads alike.
 * @param {Profile} of
 */
function holdMarkerReads(of) {
  const local = of.chrome.api.storage.local;
  const realGet = local.get.bind(local);
  /** @type {Array<() => void>} */
  let held = [];
  const release = () => {
    const run = held;
    held = [];
    run.forEach(read => read());
  };
  local.get = (/** @type {any} */ keys, /** @type {any} */ callback) => {
    const marker = keys === MARKER || (Array.isArray(keys) && keys.length === 1 && keys[0] === MARKER);
    if (!marker) return realGet(keys, callback);
    const read = new Promise(resolve => held.push(() => resolve(realGet(keys, callback))));
    if (held.length === 2) {
      release();
    } else {
      let turns = 0;
      const wait = () => {
        if (held.length === 0) return;
        if (++turns >= 50) release();
        else setImmediate(wait);
      };
      setImmediate(wait);
    }
    return callback ? undefined : read;
  };
}

/**
 * Storage.open in a page of `of`'s profile, as the new tab runs it today
 * @param {Profile} of
 * @param {{locks?: unknown}} [options]
 */
async function storageOpen(of, { locks } = {}) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome, locks });
  env.load('js/utils.js', 'js/storage.js');
  const storage = env.get('Storage');
  try {
    await storage.open();
  } finally {
    if (storage.db) storage.db.close();
  }
}

describe('opening CanvasTabDB on the IndexedDB adapter', () => {
  it("leaves each shape exactly as a page's Storage.open leaves it: the database, and chrome.storage.local with its recovery copy", async () => {
    for (const [name, spec] of Object.entries(SHAPES)) {
      // Storage.open, over its own copy of the shape
      const legacy = await made(spec);
      await storageOpen(legacy);
      // The adapter, over another
      const of = await made(spec);
      const adapter = adapterOn(of, { pageContext: true });
      await adapter.open();
      adapter.close();
      assert.deepEqual(
        await legacyEnv.dumpDatabase(of.real),
        await legacyEnv.dumpDatabase(legacy.real),
        `${name}: the adapter left another database than Storage.open`,
      );
      assert.deepEqual(settingsOf(of), settingsOf(legacy), `${name}: chrome.storage.local differs`);
    }
    // A version-8 database missing stores is the one shape that gets a copy
    const holding = await made(SHAPES['version 8 without themes, holding a note, a setting, and an image']);
    await adapterOn(holding, { pageContext: true }).open();
    const [key] = copiesIn(holding);
    const copy = /** @type {any} */ (holding.chrome.local[key]);
    assert.deepEqual([copy.reason, copy.missingStores, copy.settings], ['missing-stores', ['themes'], undefined]);
    assert.equal(copy.media[0].blob, `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`);
  });

  it('leaves the recovery copy to the next page when it opens in the service worker, as Storage does', async () => {
    const of = await made(SHAPES['version 8 without some stores']);
    // No document, as in the worker
    await adapterOn(of).open();
    await adapterOn(of, { pageContext: false }).open();
    assert.deepEqual(copiesIn(of), []);
  });

  it('writes one copy for the same missing stores however often it opens, and never reads all of chrome.storage.local', async () => {
    const of = await made(SHAPES['version 8 without some stores']);
    for (const time of [1, 2, 3]) {
      const adapter = adapterOn(of, { pageContext: true });
      await adapter.open();
      adapter.close();
      assert.equal(copiesIn(of).length, 1, `open ${time}`);
    }
    const fullReads = /** @type {Array<{method: string, keys: unknown}>} */ (of.chrome.calls).filter(
      call => call.method === 'get' && (call.keys === null || call.keys === undefined),
    );
    assert.deepEqual(fullReads, []);
  });

  it("pages opening at once write one copy between them, under Storage's lock, a legacy page included", async () => {
    const locks = legacyEnv.createLockManager();
    for (const pair of ['two adapters', 'Storage and the adapter']) {
      const of = await made(SHAPES['version 8 without some stores']);
      // Reading every store takes a while on a real profile, so each page looks for the copy
      // while the other still reads: hold each look until the other's arrives
      holdMarkerReads(of);
      const first =
        pair === 'two adapters' ? adapterOn(of, { pageContext: true, locks }).open() : storageOpen(of, { locks });
      await Promise.all([first, adapterOn(of, { pageContext: true, locks }).open()]);
      const writes = /** @type {Array<{method: string, keys: string[]}>} */ (of.chrome.calls).filter(
        call => call.method === 'set' && call.keys.some(key => key.startsWith('recovery_backup_')),
      );
      assert.equal(writes.length, 1, pair);
    }
  });

  it('copies a version-8 database missing its notes before it refuses it, as Storage does', async () => {
    const spec = { omit: ['elements'], records: { canvases: [legacyEnv.note('n1')] } };
    const legacy = await made(spec);
    await assert.rejects(storageOpen(legacy));
    const of = await made(spec);
    await assert.rejects(
      adapterOn(of, { pageContext: true }).open(),
      error => /** @type {any} */ (error).code === 'missing-core-stores',
    );
    assert.deepEqual(settingsOf(of), settingsOf(legacy));
    assert.equal(copiesIn(of).length, 1);
  });

  it("opens even when chrome.storage can't take the copy, and writes it on the next open", async () => {
    const of = await made(SHAPES['version 8 without some stores']);
    of.chrome.failNextSet();
    /** @type {Array<[string, Record<string, unknown>]>} */
    const warnings = [];
    const logger = {
      warn: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) =>
        warnings.push([event, detail]),
    };
    const adapter = adapterOn(of, { pageContext: true, logger });
    await adapter.open();
    assert.equal((await kernelOn(adapter).query({ type: 'listNotes', view: 'active' })).kind, 'empty');
    assert.deepEqual(copiesIn(of), []);
    assert.deepEqual(
      warnings.map(([event, { missingStores }]) => [event, missingStores]),
      [['recovery-copy-failed', ['search_index', 'themes', 'snapshots']]],
    );
    adapter.close();
    await adapterOn(of, { pageContext: true }).open();
    assert.equal(copiesIn(of).length, 1);
  });

  it('opens a database as it is for Popup and Side Panel: no upgrade, and no database made on a profile without one', async () => {
    const of = await made(SHAPES['version 7 (1.2.0)']);
    const before = await legacyEnv.dumpDatabase(of.real);
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const popup = kernelOn(adapter, undefined, CALLERS.popup);
    const list = await popup.query({ type: 'listNotes', view: 'active' });
    assert.deepEqual(list.kind === 'ready' && list.data.map(note => note.id), ['n1']);
    adapter.close();
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);

    const empty = await made();
    const none = adapterOn(empty, { mode: 'existing' });
    await assert.rejects(none.open(), error => {
      const { unavailableCause, code } = /** @type {any} */ (error);
      return unavailableCause === 'storage' && code === 'no-database';
    });
    assert.deepEqual(await empty.real.databases(), []);
  });

  it("reads Popup's insightsEnabled from IndexedDB's settings store, and serves no other key from it", async () => {
    const of = await made({
      records: {
        settings: [
          { key: 'insightsEnabled', value: true },
          { key: 'llmApiKey', value: 'test-only-value' },
        ],
      },
    });
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const state = await kernelOn(adapter, undefined, CALLERS.popup).query({ type: 'getPopupInsightsEnabled' });
    assert.deepEqual(state.kind === 'ready' && state.data, { insightsEnabled: true });
    // The store also holds 1.4.x's provider keys, which nothing in the kernel may read
    await assert.rejects(adapter.readSettings('idbSettings', ['llmApiKey']), { code: 'setting-not-served' });

    const without = await made({ omit: ['settings'] });
    const bare = adapterOn(without, { mode: 'existing' });
    await bare.open();
    const none = await kernelOn(bare, undefined, CALLERS.popup).query({ type: 'getPopupInsightsEnabled' });
    assert.deepEqual(none.kind === 'ready' && none.data, { insightsEnabled: false });
  });

  it('refuses a database a newer build upgraded, in both modes, closes it, and leaves it as it was', async () => {
    for (const mode of /** @type {const} */ (['versioned', 'existing'])) {
      const of = await made({
        version: 9,
        extraStores: { meta: { keyPath: 'key' } },
        records: { canvases: [legacyEnv.note('n1')] },
      });
      const before = await legacyEnv.dumpDatabase(of.real);
      const adapter = adapterOn(of, { mode });
      const ready = adapter.open();
      await assert.rejects(ready, error => {
        const { unavailableCause, code, retryable } = /** @type {any} */ (error);
        return unavailableCause === 'newer-schema' && code === 'version-too-new' && retryable === false;
      });
      const kernel = createKernel({
        adapter,
        policy: createBaselinePolicy(),
        caller: mode === 'versioned' ? CALLERS.newtab : CALLERS.popup,
        ids: testIds(),
        clock: testClock(),
        ready,
      });
      assert.deepEqual(unavailableAs(await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n2' })), [
        'newer-schema',
        'version-too-new',
        false,
      ]);
      // No connection it made is left open to hold up the newer build's next upgrade
      assert.equal(await upgradeTo(of.real, 10), 'opened', mode);
      const after = await legacyEnv.dumpDatabase(of.real);
      assert.deepEqual({ ...after, version: before.version }, before, mode);
    }
  });

  it('refuses a version-8 database without canvases or elements when it opens versioned, as Storage.open does', async () => {
    for (const missing of ['canvases', 'elements']) {
      const of = await made({ omit: [missing] });
      await assert.rejects(adapterOn(of).open(), error => /** @type {any} */ (error).code === 'missing-core-stores');
      assert.equal(await upgradeTo(of.real, 9), 'opened', `${missing}: the refused connection is closed`);
    }
  });

  it('a blocked upgrade answers blocked-upgrade within openWithinMs, keeps waiting, and commits once nothing blocks it', async () => {
    const of = await made(SHAPES['version 7 (1.2.0)']);
    // An older page's connection that never closes, as 1.4.x's Popup holds its own
    const blocker = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(of.real.open('CanvasTabDB')));
    const adapter = adapterOn(of, { openWithinMs: 50 });
    const ready = adapter.open();
    /** @type {import('../../js/kernel/core/application/kernel.js').Kernel} */
    let tab;
    // A failure here still closes the blocker, so the upgrade it holds up can't outlive the test
    try {
      assert.equal(await within(ready, 2000), undefined, 'open() answers while the upgrade waits');
      // A root that maintains as it opens still gets its first-run settings while blocked
      tab = createKernel({
        adapter,
        policy: createBaselinePolicy(),
        caller: CALLERS.newtab,
        ids: testIds(),
        clock: testClock(),
        ready,
        maintainOnOpen: true,
      });
      const blocked = await tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n2' });
      assert.deepEqual(unavailableAs(blocked), ['storage', 'blocked-upgrade', true]);
      assert.deepEqual(await tab.query({ type: 'listNotes', view: 'active' }), {
        kind: 'failed',
        cause: 'storage',
        code: 'blocked-upgrade',
      });
      assert.equal(of.chrome.local[INITIALIZED_KEY], true);
    } finally {
      // The page holding it closes, the upgrade lands, and the same command commits
      blocker.close();
    }
    const committed = await legacyEnv.waitFor(async () => {
      const outcome = await tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n2' });
      return outcome.kind === 'committed' ? outcome : null;
    });
    assert.equal(committed.code, 'note-created');
    const dump = await legacyEnv.dumpDatabase(of.real);
    assert.deepEqual([dump.version, Object.keys(dump.stores).includes('snapshots')], [8, true]);
  });

  it("an open that hasn't finished within openWithinMs answers open-pending, retryable, and never leaves a call waiting", async () => {
    // A factory whose open never answers
    const silent = /** @type {IDBFactory} */ (/** @type {unknown} */ ({ open: () => ({}) }));
    const chrome = legacyEnv.createChromeStub();
    const adapter = createIndexedDbAdapter({ indexedDB: silent, settings: chrome.api.storage.local, openWithinMs: 50 });
    assert.equal(await within(adapter.open(), 2000), undefined);
    const tab = kernelOn(adapter);
    assert.deepEqual(unavailableAs(await tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' })), [
      'storage',
      'open-pending',
      true,
    ]);
    assert.deepEqual(await tab.query({ type: 'getNote', noteId: 'n1' }), {
      kind: 'failed',
      cause: 'storage',
      code: 'open-pending',
    });
  });

  it("closes on another context's upgrade, so it never blocks it, and every call then answers reload-required", async () => {
    for (const mode of /** @type {const} */ (['versioned', 'existing'])) {
      const of = await made(SHAPES['version 8 (1.3.0 to 1.4.x)']);
      const adapter = adapterOn(of, { mode });
      await adapter.open();
      const kernel = kernelOn(adapter, undefined, mode === 'versioned' ? CALLERS.newtab : CALLERS.popup);
      assert.equal((await kernel.query({ type: 'listNotes', view: 'active' })).kind, 'ready');
      // A newer build's page upgrading past this build
      assert.equal(await within(upgradeTo(of.real, 9), 2000), 'opened', mode);
      for (const attempt of [1, 2]) {
        const outcome = await kernel.execute({ type: 'createNote', commandId: `c${attempt}`, noteId: 'n2' });
        assert.deepEqual(unavailableAs(outcome), ['storage', 'reload-required', false], `${mode}, attempt ${attempt}`);
      }
      assert.deepEqual(await kernel.query({ type: 'listFolders' }), {
        kind: 'failed',
        cause: 'storage',
        code: 'reload-required',
      });
    }
  });

  it('a connection Chrome closes itself, or one close() ends, answers reload-required', async () => {
    const of = await made(SHAPES['version 8 (1.3.0 to 1.4.x)']);
    const adapter = adapterOn(of);
    await adapter.open();
    const tab = kernelOn(adapter);
    assert.equal((await tab.query({ type: 'listNotes', view: 'active' })).kind, 'ready');
    forceCloseDatabase(/** @type {IDBDatabase} */ (of.faults.connections.at(-1)));
    await legacyEnv.settle();
    assert.deepEqual(unavailableAs(await tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n2' })), [
      'storage',
      'reload-required',
      false,
    ]);

    const other = adapterOn(of);
    await other.open();
    other.close();
    assert.deepEqual(await kernelOn(other).query({ type: 'listNotes', view: 'active' }), {
      kind: 'failed',
      cause: 'storage',
      code: 'reload-required',
    });
  });

  it('close() while an open still waits stays closed, whether that open then succeeds or fails', async () => {
    for (const ending of /** @type {const} */ (['succeeds', 'fails'])) {
      /** @type {any} */
      const request = {};
      let closed = false;
      const database = { version: 8, objectStoreNames: { contains: () => true }, close: () => (closed = true) };
      const factory = /** @type {IDBFactory} */ (/** @type {unknown} */ ({ open: () => request }));
      const chrome = legacyEnv.createChromeStub();
      const adapter = createIndexedDbAdapter({
        indexedDB: factory,
        settings: chrome.api.storage.local,
        openWithinMs: 20,
      });
      const opening = adapter.open();
      await opening;
      adapter.close();
      if (ending === 'succeeds') {
        request.result = database;
        request.onsuccess();
      } else {
        request.error = new DOMException('The open failed', 'UnknownError');
        request.onerror();
      }
      assert.equal(closed, ending === 'succeeds', `${ending}: a database it opened after close() is closed`);
      assert.deepEqual(
        unavailableAs(await kernelOn(adapter).execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' })),
        ['storage', 'reload-required', false],
      );
    }
  });

  it('an open that fails after open() answered fails every call from then on, not retryable, since nothing opens it again', async () => {
    /** @type {any} */
    const request = {};
    const factory = /** @type {IDBFactory} */ (/** @type {unknown} */ ({ open: () => request }));
    const chrome = legacyEnv.createChromeStub();
    const adapter = createIndexedDbAdapter({
      indexedDB: factory,
      settings: chrome.api.storage.local,
      openWithinMs: 20,
    });
    await adapter.open();
    request.error = new DOMException('The open failed', 'UnknownError');
    request.onerror();
    const tab = kernelOn(adapter);
    for (const attempt of [1, 2]) {
      const outcome = await tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
      assert.deepEqual(unavailableAs(outcome), ['storage', 'open-failed', false], `attempt ${attempt}`);
    }
    assert.deepEqual(await tab.query({ type: 'getNote', noteId: 'n1' }), {
      kind: 'failed',
      cause: 'storage',
      code: 'open-failed',
    });
  });

  it('close() before open() keeps it closed: open() opens nothing and answers reload-required', async () => {
    let opens = 0;
    const factory = /** @type {IDBFactory} */ (
      /** @type {unknown} */ ({
        open: () => {
          opens += 1;
          return {};
        },
      })
    );
    const chrome = legacyEnv.createChromeStub();
    const adapter = createIndexedDbAdapter({
      indexedDB: factory,
      settings: chrome.api.storage.local,
      openWithinMs: 20,
    });
    adapter.close();
    await assert.rejects(adapter.open(), error => {
      const { unavailableCause, code, retryable } = /** @type {any} */ (error);
      return unavailableCause === 'storage' && code === 'reload-required' && retryable === false;
    });
    assert.equal(opens, 0);
    assert.deepEqual(
      unavailableAs(await kernelOn(adapter).execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' })),
      ['storage', 'reload-required', false],
    );
  });
});

describe('startup maintenance on the IndexedDB adapter', () => {
  /**
   * What Storage.initializeDefaultSettings writes on a first run, from production js/storage.js
   * @returns {Promise<Record<string, unknown>>}
   */
  const storageFirstRun = async () => {
    const env = legacyEnv.createLegacyEnv({ context: 'page' });
    env.load('js/utils.js', 'js/storage.js');
    await env.get('Storage').initializeDefaultSettings();
    await legacyEnv.settle();
    return legacyEnv.plain(env.chrome.local);
  };

  it('writes what Storage writes on a first run, and nothing once it has run', async () => {
    const of = await made();
    const adapter = adapterOn(of);
    await adapter.open();
    const worker = kernelOn(adapter, undefined, CALLERS['worker-internal']);
    const opened = of.faults.transactions.length;
    assert.equal((await worker.execute({ type: 'runStartupMaintenance', commandId: 'm1' })).kind, 'committed');
    assert.deepEqual(legacyEnv.plain(of.chrome.local), await storageFirstRun());
    assert.deepEqual(
      Object.keys(FIRST_RUN_SETTINGS).sort(),
      Object.keys(await storageFirstRun())
        .filter(key => key !== INITIALIZED_KEY)
        .sort(),
    );
    const writes = of.chrome.writes().length;
    assert.equal((await worker.execute({ type: 'runStartupMaintenance', commandId: 'm2' })).kind, 'committed');
    assert.equal(of.chrome.writes().length, writes);
    // It reads no store, so a new tab's first render waits on no scan
    assert.equal(of.faults.transactions.length, opened);
  });

  it('keeps a setting stored before its first run, where Storage writes the default over it', async () => {
    const of = await made();
    of.chrome.local.setting_theme = 'dark';
    const adapter = adapterOn(of);
    await adapter.open();
    await kernelOn(adapter, undefined, CALLERS['worker-internal']).execute({
      type: 'runStartupMaintenance',
      commandId: 'm1',
    });
    assert.deepEqual([of.chrome.local.setting_theme, of.chrome.local.setting_font], ['dark', 'default']);
  });

  it("doesn't stop the page when chrome.storage fails it, as Storage doesn't, and the next start writes the defaults", async () => {
    const of = await made();
    of.chrome.failNextSet();
    const adapter = adapterOn(of);
    const ready = adapter.open();
    // A root that maintains as it opens, as the new tab's does
    const tab = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds(),
      clock: testClock(),
      ready,
      maintainOnOpen: true,
    });
    assert.equal((await tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' })).kind, 'committed');
    assert.equal(of.chrome.local[INITIALIZED_KEY], undefined);
    // Asked again, it says so: committed, so a maintaining root runs on, but not as done
    const worker = kernelOn(adapter, undefined, CALLERS['worker-internal']);
    of.chrome.failNextSet();
    /** @param {Outcome} outcome */
    const codeOf = outcome => outcome.kind === 'committed' && [outcome.code, outcome.severity];
    const deferred = await worker.execute({ type: 'runStartupMaintenance', commandId: 'm2' });
    assert.deepEqual(codeOf(deferred), ['maintenance-deferred', 'warning']);
    const ran = await worker.execute({ type: 'runStartupMaintenance', commandId: 'm3' });
    assert.deepEqual(codeOf(ran), ['maintenance-ran', 'success']);
    assert.deepEqual(legacyEnv.plain(of.chrome.local), await storageFirstRun());

    // One that can't read what's stored writes nothing, so no default lands over a setting
    const other = await made();
    other.chrome.local.setting_theme = 'dark';
    const unreadable = {
      get: () => Promise.reject(new Error('The read failed')),
      set: other.chrome.api.storage.local.set,
    };
    const reading = adapterOn(other, { settings: unreadable });
    await reading.open();
    const outcome = await kernelOn(reading, undefined, CALLERS['worker-internal']).execute({
      type: 'runStartupMaintenance',
      commandId: 'm1',
    });
    assert.deepEqual(codeOf(outcome), ['maintenance-deferred', 'warning']);
    assert.deepEqual(other.chrome.writes(), []);
  });

  it('never runs on a database opened as it is', async () => {
    const of = await made(SHAPES['version 8 (1.3.0 to 1.4.x)']);
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    // The policy already keeps Popup and Side Panel from asking, so ask from a new-tab caller
    const outcome = await kernelOn(adapter).execute({ type: 'runStartupMaintenance', commandId: 'm1' });
    assert.deepEqual(unavailableAs(outcome), ['adapter', 'maintenance-needs-versioned-open', false]);
    assert.deepEqual(of.chrome.writes(), []);
  });
});
