// How #17's IndexedDB adapter opens CanvasTabDB (#17 slice 1, PR 1b): the worker's versioned
// open brings a database to 9 only through step 9, which keeps every record, while the new
// tab's Storage.open upgrades nothing; a page that finds no database or an older one waits on
// the worker first (Q12); a blocked or slow open answers within openWithinMs and keeps waiting;
// a connection another context's upgrade or Chrome closes answers reload-required; a newer
// database is refused and left alone; and startup maintenance writes what Storage writes on a
// first run.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { LATEST_STRUCTURAL } from '../../js/kernel/adapters/indexeddb/registry.js';
import { DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { detectShape, inspect } from '../../js/kernel/adapters/indexeddb/shapes.js';
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
 * Storage.open in a page of `of`'s profile, as the new tab runs it, with no worker to wake
 * (#17 PR 1b: it waits on the worker's run, here at once). Resolves what it threw, or null.
 * @param {Profile} of
 * @returns {Promise<unknown>}
 */
async function storageOpen(of) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome, worker: false });
  env.load('js/utils.js', 'js/storage.js');
  const storage = env.get('Storage');
  try {
    await storage.open();
    return null;
  } catch (error) {
    return error;
  } finally {
    if (storage.db) storage.db.close();
  }
}

/**
 * Each store's records in a dump, without the store shapes
 * @param {any} dump
 * @returns {Record<string, unknown>}
 */
const recordsIn = dump =>
  Object.fromEntries(Object.entries(dump.stores).map(([name, store]) => [name, /** @type {any} */ (store).records]));

describe('opening CanvasTabDB on the IndexedDB adapter', () => {
  it("leaves each shape as it was in a page's Storage.open and in the worker's versioned open, which makes 9 only where there's no database (review R79)", async () => {
    for (const [name, spec] of Object.entries(SHAPES)) {
      // The new tab's Storage.open upgrades nothing, and makes no database (#17 PR 1b)
      const page = await made(spec);
      const before = spec ? await legacyEnv.dumpDatabase(page.real) : null;
      const thrown = /** @type {any} */ (await storageOpen(page));
      if (before) {
        assert.deepEqual(await legacyEnv.dumpDatabase(page.real), before, `${name}: Storage.open changed it`);
      } else {
        assert.equal(thrown && thrown.code, 'NO_DATABASE', name);
        assert.deepEqual(await page.real.databases(), [], `${name}: Storage.open made one`);
      }
      // The worker's versioned open, after its run, finds nothing to upgrade. One that finds an
      // older database (made or replaced since the run) never upgrades it, since every step
      // needs a verified point first: it's refused, retryable, for the worker to run the runner
      // again, and the connection it opened is closed
      const of = await made(spec);
      const adapter = adapterOn(of);
      if (before) {
        await assert.rejects(
          adapter.open(),
          error => {
            const { unavailableCause, code, retryable } = /** @type {any} */ (error);
            return unavailableCause === 'storage' && code === 'migration-required' && retryable === true;
          },
          name,
        );
        assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before, `${name}: the versioned open changed it`);
        assert.equal(await upgradeTo(of.real, 9), 'opened', `${name}: the refused connection is closed`);
      } else {
        // With nothing to keep, it makes the database at 9 through the registry's steps
        await adapter.open();
        adapter.close();
        assert.deepEqual(
          detectShape(await inspect(of.real)),
          { kind: 'current', structuralVersion: 9, logicalVersion: 1 },
          name,
        );
      }
      assert.deepEqual(of.chrome.writes(), [], `${name}: no copy, and no setting`);
    }
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
        version: 10,
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
      assert.equal(await upgradeTo(of.real, 11), 'opened', mode);
      const after = await legacyEnv.dumpDatabase(of.real);
      assert.deepEqual({ ...after, version: before.version }, before, mode);
    }
  });

  it('refuses a version-8 database without canvases or elements when it opens versioned, and gives it no step (Q13)', async () => {
    for (const missing of ['canvases', 'elements']) {
      const of = await made({ omit: [missing] });
      await assert.rejects(adapterOn(of).open(), error => /** @type {any} */ (error).code === 'missing-core-stores');
      assert.equal((await legacyEnv.dumpDatabase(of.real)).version, 8, `${missing}: no step ran`);
      assert.equal(await upgradeTo(of.real, 9), 'opened', `${missing}: the refused connection is closed`);
    }
  });

  it('a blocked open answers blocked-upgrade within openWithinMs, keeps waiting, and refuses the older database it then finds, which it leaves as it was', async () => {
    const of = await made(SHAPES['version 7 (1.2.0)']);
    const before = await legacyEnv.dumpDatabase(of.real);
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
      // The page holding it closes, and the open goes on
      blocker.close();
    }
    // It finds version 7, which only the runner upgrades after its point (review R79): the same
    // command answers migration-required. This adapter never opens again, so it isn't
    // retryable here; the worker's client starts another attempt on that code and builds a new one
    const refused = await legacyEnv.waitFor(async () => {
      const outcome = await tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n2' });
      return outcome.kind === 'unavailable' && outcome.code !== 'blocked-upgrade' ? outcome : null;
    });
    assert.deepEqual(unavailableAs(refused), ['storage', 'migration-required', false]);
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
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
      // The worker opens versioned only on the database its run made at 9; Popup opens 8 as it is
      const of = await made(mode === 'versioned' ? undefined : SHAPES['version 8 (1.3.0 to 1.4.x)']);
      const adapter = adapterOn(of, { mode });
      await adapter.open();
      const kernel = kernelOn(adapter, undefined, mode === 'versioned' ? CALLERS.newtab : CALLERS.popup);
      // The fresh database holds no note yet; version 8 holds n1
      assert.equal(
        (await kernel.query({ type: 'listNotes', view: 'active' })).kind,
        mode === 'versioned' ? 'empty' : 'ready',
      );
      // A newer build's page upgrading past this build
      assert.equal(await within(upgradeTo(of.real, 10), 2000), 'opened', mode);
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
    // The database the worker's run made at 9
    const of = await made();
    const adapter = adapterOn(of);
    await adapter.open();
    const tab = kernelOn(adapter);
    assert.equal((await tab.query({ type: 'listNotes', view: 'active' })).kind, 'empty');
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

describe('a page that finds no database, or an older one, waits on the worker first (#17 PR 1b, Q12)', () => {
  it("Popup's and Side Panel's open waits on awaitUpgrade below 9, and not at 9, then opens what's there", async () => {
    /** @type {Array<[string, number]>} */
    const waits = [];
    for (const [name, spec] of /** @type {const} */ ([
      ['no database', undefined],
      ['version 8', SHAPES['version 8 (1.3.0 to 1.4.x)']],
      ['version 9', 'nine'],
    ])) {
      const of = await made(spec === 'nine' ? undefined : spec);
      if (spec === 'nine')
        await adapterOn(of)
          .open()
          .then(() => of.adapters.at(-1)?.close());
      let count = 0;
      const adapter = adapterOn(of, {
        mode: 'existing',
        awaitUpgrade: async () => {
          count++;
        },
      });
      const opened = await adapter.open().then(
        () => 'open',
        error => /** @type {any} */ (error).code,
      );
      waits.push([name, count]);
      assert.equal(opened, name === 'no database' ? 'no-database' : 'open', name);
    }
    assert.deepStrictEqual(waits, [
      ['no database', 1],
      ['version 8', 1],
      ['version 9', 0],
    ]);
  });

  it("the new tab's Storage.open wakes the worker below 9, waits at most 5 seconds, then opens what's there", async () => {
    const of = await made(SHAPES['version 8 (1.3.0 to 1.4.x)']);
    const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome, worker: false });
    /** @type {unknown[]} */
    const sent = [];
    // A worker that never answers
    env.chrome.api.runtime.answerMigrate = () => {
      sent.push('storage.migrate');
      return new Promise(() => {});
    };
    env.load('js/utils.js', 'js/storage.js');
    const storage = env.get('Storage');
    let settled = false;
    const opening = storage.open().then(() => {
      settled = true;
    });
    await legacyEnv.waitFor(() => env.clock.pending() > 0, { message: 'the wait' });
    assert.deepStrictEqual(sent, ['storage.migrate']);
    assert.equal(settled, false, 'it waits for the worker');
    env.clock.tick(5000);
    await opening;
    assert.equal(storage.openState, 'open');
    assert.equal(storage.db.version, 8, 'and opens version 8 as it is');
    storage.db.close();

    // At 9 it sends nothing
    const nine = await made();
    await adapterOn(nine).open();
    nine.adapters.at(-1)?.close();
    const page = legacyEnv.createLegacyEnv({
      context: 'page',
      indexedDB: nine.real,
      chrome: nine.chrome,
      worker: false,
    });
    let asked = 0;
    page.chrome.api.runtime.answerMigrate = async () => {
      asked++;
    };
    page.load('js/utils.js', 'js/storage.js');
    const current = page.get('Storage');
    await current.open();
    assert.equal(asked, 0);
    assert.equal(current.db.version, 9);
    current.db.close();
  });
});

it("this build's version is the registry's newest, schema.js's DB_VERSION, and Storage's dbVersion, all 9 (#17 PR 1b)", () => {
  const env = legacyEnv.createLegacyEnv({ context: 'page', worker: false });
  env.load('js/utils.js', 'js/storage.js');
  assert.deepStrictEqual([LATEST_STRUCTURAL, DB_VERSION, env.get('Storage').dbVersion], [9, 9, 9]);
});
