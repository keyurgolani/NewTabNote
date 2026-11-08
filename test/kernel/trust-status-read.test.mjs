// #20 slice 4c, PR 2: the worker's status read (js/kernel/composition/trust-status-read.js), one
// of its own messages on installWorkerNetwork. It answers the new tab, Popup and the Side Panel,
// by their page, with what a workspace root's trust.summary answers over the whole catalog,
// narrowed to what the status lines and cards read, from NewTabNoteTrust's records. It only
// reads: it never opens the records, writes nothing, makes no database, and runs no check
// (readOnlyTrustStore, js/kernel/adapters/indexeddb/trust.js). It keeps one store for the
// worker's life and builds the records over it at each ask, so two asks that overlap a cold
// open, and an ask after one whose open failed, each answer as the summary.
//
// The worker's read is new in this PR, so it loads inside each case.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseOn, fakeKeyRange, openRecords, trustProfile } from './trust-support.mjs';
import { reachGraph } from './import-graph.mjs';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { PENDING_RETRY_MS, createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { hexIds, lockManager, manualClock, realTimers, settingsArea } from './trust-support.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT}`;

/** A page of this extension's, as Chrome names a message's sender */
const page = (/** @type {string} */ file, /** @type {Record<string, unknown>} */ more = {}) => ({
  id: EXT,
  url: `${ORIGIN}/${file}`,
  origin: ORIGIN,
  ...more,
});

const READ = Object.freeze({ type: 'trust.status' });

/**
 * Records with problems in three groups, one of them dismissed and one a capture risk from the
 * background worker, and the use cases a workspace root runs over the whole catalog on them
 */
async function seeded() {
  const clock = manualClock();
  const store = createMemoryTrustStore();
  const settings = settingsArea();
  const records = createTrustRecords({ store, settings, clock, ids: hexIds(), locks: lockManager() });
  await records.open();
  const root = createRegistryRoot({ host: 'workspace' });
  root.register(health, PROVIDERS);
  const resolution = root.resolve();
  const runtime = createRuntime(resolution);
  await runtime.probe();
  const trust = createTrustUseCases({
    records,
    journal: createDiagnosticJournal({ records, clock, strict: true }),
    clock,
    timers: realTimers,
    locks: lockManager(),
    registry: { resolution, runtime, context: {} },
    versions: { extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 },
  });
  /** @type {string[]} */
  const ids = [];
  for (const [providerId, faultCode, severity, subjectId] of /** @type {const} */ ([
    ['storage', 'scan-findings', 'degraded', 'CanvasTabDB'],
    ['credentials', 'legacy-secret', 'data-risk', 'setting_llmApiKey'],
    ['coordinator', 'start-failed', 'capture-risk', null],
  ])) {
    clock.advance(1000);
    const raised = /** @type {any} */ (
      await trust.raise({
        type: 'recovery.raise',
        commandId: `c-${faultCode}`,
        providerId,
        faultCode,
        severity,
        subjectId,
      })
    );
    assert.equal(raised.kind, 'committed', JSON.stringify(raised));
    ids.push(raised.changedIds[0]);
  }
  const dismissed = /** @type {any} */ (
    await trust.dismiss({ type: 'recovery.dismiss', commandId: 'c-dismiss', incidentId: ids[1], occurrences: 1 })
  );
  assert.equal(dismissed.kind, 'committed', JSON.stringify(dismissed));
  return { clock, store, settings, trust };
}

/**
 * The worker's read's store over `store`, and the records it builds over that store, never
 * opened, with what they were asked to do kept: each store made, each store run by its mode, each
 * settings write, each open, and each records build
 * @param {import('../../js/trust/core/ports.js').TrustStore} store
 * @param {ReturnType<typeof settingsArea>} settings
 * @param {{now: () => number}} clock
 */
function watchedRecords(store, settings, clock) {
  const seen = { runs: /** @type {string[]} */ ([]), settingsWrites: 0, opens: 0, builds: 0, stores: 0 };
  /** @type {import('../../js/trust/core/ports.js').TrustStore} */
  const watchedStore = {
    open: () => store.open(),
    run: (stores, mode, unit) => {
      seen.runs.push(mode);
      return store.run(stores, mode, unit);
    },
    close: () => store.close(),
  };
  const watchedSettings = {
    get: (/** @type {string[]} */ keys) => settings.get(keys),
    set: async (/** @type {Record<string, unknown>} */ values) => {
      seen.settingsWrites += 1;
      return settings.set(values);
    },
  };
  /** The worker's one store */
  const makeStore = () => {
    seen.stores += 1;
    return watchedStore;
  };
  /** The records over `given`, the store the read made, or this one where it passes none */
  const build = (/** @type {import('../../js/trust/core/ports.js').TrustStore} */ given = watchedStore) => {
    seen.builds += 1;
    const records = createTrustRecords({
      store: given,
      settings: watchedSettings,
      clock,
      ids: hexIds('b2c3'),
      locks: lockManager(),
    });
    return {
      ...records,
      open: () => {
        seen.opens += 1;
        return records.open();
      },
    };
  };
  return { seen, store: makeStore, build };
}

describe("the worker's status read (#20 slice 4c)", () => {
  it("answers what a workspace root's trust.summary answers over the whole catalog, narrowed to what the lines and cards read", async () => {
    const { workerStatusRead, STATUS_ROWS } = await import('../../js/kernel/composition/trust-status-read.js');
    const { narrowStatus } = await import('../../js/trust/core/status-message.js');
    const { clock, store, settings, trust } = await seeded();
    const { seen, store: makeStore, build } = watchedRecords(store, settings, clock);
    const read = workerStatusRead({ store: makeStore, records: /** @type {any} */ (build), clock, extensionId: () => EXT });
    const summary = /** @type {any} */ (await trust.summary());
    assert.equal(summary.kind, 'ready');
    const expected = narrowStatus(summary.data);
    for (let ask = 0; ask < 2; ask++) {
      assert.deepEqual(await read(READ, page('newtab.html')), expected, `ask ${ask + 1}`);
    }
    assert.deepEqual([seen.stores, seen.builds], [1, 2], 'one store for the worker, and records over it at each ask');
    // What it answers: capture at risk from the worker, two groups needing action, the dismissed key in none
    assert.deepEqual(
      [expected.capture, expected.groups.filter(group => group.needsAction > 0).map(group => group.group)],
      ['at-risk', ['storage', 'platform']],
    );
    assert.deepEqual(
      STATUS_ROWS.map(row => row.id),
      PROVIDERS.map(descriptor => descriptor.id),
      "the new tab's rows: every provider runs there",
    );
  });

  it("answers what the page's full check takes, causes and all, after the JSON a message carries it as", async () => {
    const { workerStatusRead } = await import('../../js/kernel/composition/trust-status-read.js');
    const { statusFrom } = await import('../../js/trust/core/status-message.js');
    const { clock, store, settings } = await seeded();
    const { store: makeStore, build } = watchedRecords(store, settings, clock);
    const read = workerStatusRead({ store: makeStore, records: /** @type {any} */ (build), clock, extensionId: () => EXT });
    const sent = JSON.parse(JSON.stringify(await read(READ, page('newtab.html'))));
    assert.deepEqual(
      sent.groups.filter((/** @type {any} */ group) => group.cause !== null).map((/** @type {any} */ group) => group.group),
      ['storage', 'platform'],
      'with causes in it',
    );
    assert.deepEqual(statusFrom(sent), sent);
  });

  it("answers each of two asks sent before the store's first open settles as the summary, both waiting on its one connection", async () => {
    const { workerStatusRead } = await import('../../js/kernel/composition/trust-status-read.js');
    const { narrowStatus } = await import('../../js/trust/core/status-message.js');
    const { clock, store, settings, trust } = await seeded();
    // The store's first open settles only once it's let go, as a cold worker's first open of
    // NewTabNoteTrust takes its time, and every open waits on that one
    /** @type {() => void} */
    let letGo = () => {};
    const going = new Promise(resolve => {
      letGo = () => resolve(undefined);
    });
    /** @type {import('../../js/trust/core/ports.js').TrustStore} */
    const slow = {
      open: () => going.then(() => store.open()),
      run: (stores, mode, unit) => store.run(stores, mode, unit),
      close: () => store.close(),
    };
    const { seen, store: makeStore, build } = watchedRecords(slow, settings, clock);
    const read = workerStatusRead({ store: makeStore, records: /** @type {any} */ (build), clock, extensionId: () => EXT });
    const expected = narrowStatus(/** @type {any} */ (await trust.summary()).data);
    // Two tabs opened at a cold start, or a tab and Popup: neither waits for the other
    const asks = [read(READ, page('newtab.html')), read(READ, page('popup.html'))];
    await new Promise(resolve => setImmediate(resolve));
    letGo();
    assert.deepEqual(await Promise.all(asks), [expected, expected]);
    assert.equal(seen.stores, 1, 'both on the one store');
  });

  it('answers the ask after one whose open failed as the summary: an open that failed holds no later ask blind', async () => {
    const { workerStatusRead } = await import('../../js/kernel/composition/trust-status-read.js');
    const { narrowStatus } = await import('../../js/trust/core/status-message.js');
    const { UnavailableError } = await import('../../js/kernel/core/contracts/outcomes.js');
    const { clock, store, settings, trust } = await seeded();
    // A first open that answers open-pending, as one past TRUST_OPEN_WITHIN_MS at a cold start
    // does, and every open after it that opens
    let opens = 0;
    /** @type {import('../../js/trust/core/ports.js').TrustStore} */
    const flaky = {
      open: () => {
        opens += 1;
        return opens === 1 ? Promise.reject(new UnavailableError('storage', 'open-pending', true)) : store.open();
      },
      run: (stores, mode, unit) => store.run(stores, mode, unit),
      close: () => store.close(),
    };
    const { store: makeStore, build } = watchedRecords(flaky, settings, clock);
    const read = workerStatusRead({ store: makeStore, records: /** @type {any} */ (build), clock, extensionId: () => EXT });
    const first = /** @type {any} */ (await read(READ, page('newtab.html')));
    assert.deepEqual(
      [first.capture, first.route, first.records],
      ['unknown', 'recovery', 'fallback'],
      'the ask whose open failed reads blind',
    );
    // Past the wait before records try an open that was still connecting again, so only a state
    // that outlives its ask could hold the next one blind
    clock.advance(PENDING_RETRY_MS + 1);
    const expected = narrowStatus(/** @type {any} */ (await trust.summary()).data);
    assert.deepEqual(await read(READ, page('newtab.html')), expected, 'the next ask opens the store and reads it');
    assert.equal(opens, 2);
  });

  it('only reads: it never opens the records, writes nothing to their store or their settings copy, and reaches no check', async () => {
    const { workerStatusRead } = await import('../../js/kernel/composition/trust-status-read.js');
    const { clock, store, settings } = await seeded();
    const { seen, store: makeStore, build } = watchedRecords(store, settings, clock);
    const read = workerStatusRead({ store: makeStore, records: /** @type {any} */ (build), clock, extensionId: () => EXT });
    await read(READ, page('newtab.html'));
    await read(READ, page('popup.html'));
    assert.deepEqual([seen.opens, seen.settingsWrites, seen.runs.filter(mode => mode !== 'readonly')], [0, 0, []]);
    assert.ok(seen.runs.length > 0, 'it read the store');
    // What it loads: of the IndexedDB adapters NewTabNoteTrust's alone, and no check, registry,
    // use case or provider catalog
    const graph = [...reachGraph([path.join(ROOT, 'js', 'kernel', 'composition', 'trust-status-read.js')]).modules].map(
      file => path.relative(ROOT, file).split(path.sep).join('/'),
    );
    assert.deepEqual(graph.filter(file => file.startsWith('js/kernel/adapters/indexeddb/')).sort(), [
      'js/kernel/adapters/indexeddb/failures.js',
      'js/kernel/adapters/indexeddb/requests.js',
      'js/kernel/adapters/indexeddb/trust.js',
    ]);
    assert.deepEqual(
      graph.filter(file =>
        /^js\/trust\/core\/(?:checks|use-cases|families|remediation)|^js\/trust\/core\/providers\/(?!rows\.js$)|^js\/kernel\/registry\//.test(
          file,
        ),
      ),
      [],
    );
  });

  it('answers the new tab, Popup and the Side Panel by their page, with a tab or none, and refuses recovery.html, the offscreen document and any other sender', async () => {
    const { workerStatusRead } = await import('../../js/kernel/composition/trust-status-read.js');
    const { clock, store, settings } = await seeded();
    const { store: makeStore, build } = watchedRecords(store, settings, clock);
    const read = workerStatusRead({ store: makeStore, records: /** @type {any} */ (build), clock, extensionId: () => EXT });
    for (const sender of [
      page('newtab.html'),
      page('newtab.html', { tab: { id: 7 } }),
      page('newtab.html#/workspace'),
      page('popup.html'),
      page('sidepanel.html'),
    ]) {
      const answer = /** @type {any} */ (await read(READ, sender));
      assert.equal(answer.capture, 'at-risk', JSON.stringify(sender));
    }
    for (const sender of [
      page('recovery.html'),
      page('recovery.html#trust', { tab: { id: 7 } }),
      page('offscreen.html'),
      // A content script: this extension's id, on a web page
      { id: EXT, url: 'https://example.test/', origin: 'https://example.test', tab: { id: 7 } },
      // Another extension's new tab
      {
        id: 'zyxwvutsrqponmlkzyxwvutsrqponmlk',
        url: 'chrome-extension://zyxwvutsrqponmlkzyxwvutsrqponmlk/newtab.html',
      },
      { id: EXT },
      null,
    ]) {
      assert.deepEqual(await read(READ, sender), { error: 'request-refused' }, JSON.stringify(sender));
    }
  });

  it("builds the browser's records at each ask over the worker's one readOnlyTrustStore, with a settings copy that takes no write, and never opens them", async () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'kernel', 'composition', 'trust-status-read.js'), 'utf8');
    assert.match(source, /\n\s+store: makeStore = browserStore,\n\s+records: build = browserRecords,\n/);
    assert.match(source, /\n\s+if \(!store\) store = makeStore\(\);\n\s+const records = build\(store\);\n/);
    assert.match(source, /\nfunction browserStore\(\) \{\n\s+return readOnlyTrustStore\(\{ indexedDB: browserTrustHost\(\)\.indexedDB \}\);\n\}\n/);
    assert.match(source, /\n\s+store,\n\s+settings: \{ get: settings\.get, set: noWrite \},/);
    assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ''), /\.open\(/);
  });

  it("refuses a content script's sender before it reads anything, through the worker's network", async () => {
    const { workerStatusRead, TRUST_STATUS_MESSAGE } = await import('../../js/kernel/composition/trust-status-read.js');
    const network = await import('../../js/kernel/composition/worker-network.js');
    let asked = 0;
    const never = () => {
      asked += 1;
      throw new Error('never built');
    };
    const read = workerStatusRead({ store: never, records: /** @type {any} */ (never), extensionId: () => EXT });
    /** @type {any[]} */
    const listeners = [];
    const before = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    /** @type {any} */ (globalThis).chrome = {
      runtime: { id: EXT, onMessage: { addListener: (/** @type {any} */ l) => listeners.push(l) } },
    };
    try {
      network.installWorkerNetwork({ ownHandlers: { [TRUST_STATUS_MESSAGE]: read } });
    } finally {
      if (before) Object.defineProperty(globalThis, 'chrome', before);
      else delete (/** @type {any} */ (globalThis).chrome);
    }
    const [listener] = listeners;
    const answer = await new Promise(resolve => {
      listener(
        READ,
        { id: EXT, url: 'https://example.test/', origin: 'https://example.test', tab: { id: 7 } },
        resolve,
      );
    });
    assert.deepEqual([answer, asked], [{ error: 'request-refused' }, 0]);
  });

  it("answers that it's unavailable, with nothing of why, when the records can't be built, and builds them again at the next ask", async () => {
    const { workerStatusRead } = await import('../../js/kernel/composition/trust-status-read.js');
    const { clock, store, settings } = await seeded();
    const { store: makeStore, build } = watchedRecords(store, settings, clock);
    let tries = 0;
    const read = workerStatusRead({
      store: makeStore,
      records: /** @type {any} */ (
        (/** @type {any} */ given) => {
          tries += 1;
          if (tries === 1) throw new Error('no IndexedDB here');
          return build(given);
        }
      ),
      clock,
      extensionId: () => EXT,
    });
    assert.deepEqual(await read(READ, page('newtab.html')), { error: 'unavailable' });
    const second = /** @type {any} */ (await read(READ, page('newtab.html')));
    assert.equal(second.capture, 'at-risk');
  });

  it("answers that it's unavailable when the worker's store can't be made, and makes it at the next ask", async () => {
    const { workerStatusRead } = await import('../../js/kernel/composition/trust-status-read.js');
    const { clock, store, settings } = await seeded();
    const { seen, store: makeStore, build } = watchedRecords(store, settings, clock);
    let tries = 0;
    const read = workerStatusRead({
      store: () => {
        tries += 1;
        if (tries === 1) throw new Error('no IndexedDB here');
        return makeStore();
      },
      records: /** @type {any} */ (build),
      clock,
      extensionId: () => EXT,
    });
    assert.deepEqual(await read(READ, page('newtab.html')), { error: 'unavailable' });
    assert.equal(/** @type {any} */ (await read(READ, page('newtab.html'))).capture, 'at-risk');
    assert.equal(/** @type {any} */ (await read(READ, page('newtab.html'))).capture, 'at-risk');
    assert.deepEqual([tries, seen.stores], [2, 1], 'made once it was made');
  });
});

describe('NewTabNoteTrust read only (#20 slice 4c, readOnlyTrustStore)', () => {
  /** The records a reader builds over `store`, as the worker's read does */
  const reader = (/** @type {any} */ store, /** @type {any} */ profile) =>
    createTrustRecords({
      store,
      settings: profile.settings,
      clock: manualClock(),
      ids: hexIds('c3d4'),
      locks: profile.locks,
    });

  /** @param {IDBFactory} factory */
  const names = async factory => (await factory.databases()).map(database => database.name);

  it("finds every store empty where there's no NewTabNoteTrust yet, and makes none", async () => {
    const { readOnlyTrustStore } = await import('../../js/kernel/adapters/indexeddb/trust.js');
    const profile = trustProfile();
    const records = reader(readOnlyTrustStore({ indexedDB: profile.real, keyRange: fakeKeyRange }), profile);
    assert.deepEqual(await records.latestReceipts(), []);
    assert.deepEqual(await records.incidentsRead(), { incidents: [], copyRead: true, recordsRead: true });
    assert.deepEqual(await names(profile.real), []);
  });

  it('reads what a context that writes the records left, a database made after its first read included, and takes no write', async () => {
    const { readOnlyTrustStore } = await import('../../js/kernel/adapters/indexeddb/trust.js');
    const profile = trustProfile();
    const store = readOnlyTrustStore({ indexedDB: profile.real, keyRange: fakeKeyRange });
    const records = reader(store, profile);
    assert.deepEqual((await records.incidentsRead()).incidents, []);
    // A writing context makes the database, and raises a problem in it
    const writer = databaseOn(profile);
    const { records: writing } = await openRecords(writer, profile);
    const raised = await writing.raise({
      providerId: 'storage',
      faultCode: 'scan-findings',
      severity: 'degraded',
      subjectId: 'CanvasTabDB',
    });
    assert.equal(raised.recorded, true, 'the writer raised it');
    const read = await records.incidentsRead();
    assert.deepEqual(
      [read.recordsRead, read.incidents.map(incident => incident.id)],
      [true, [/** @type {any} */ (raised.incident).id]],
    );
    await assert.rejects(
      store.run(['incidents'], 'readwrite', async () => undefined),
      (/** @type {any} */ error) => error.code === 'write-in-readonly-transaction',
    );
    writer.close();
  });

  it('makes no database even where the factory says it has one: the open that would make it aborts', async () => {
    const { readOnlyTrustStore } = await import('../../js/kernel/adapters/indexeddb/trust.js');
    const profile = trustProfile();
    const real = profile.real;
    // A factory that says NewTabNoteTrust is there when it isn't
    const lying = /** @type {IDBFactory} */ (
      /** @type {unknown} */ ({
        open: (/** @type {string} */ name, /** @type {number} */ version) => real.open(name, version),
        databases: async () => [{ name: 'NewTabNoteTrust', version: 1 }],
        deleteDatabase: (/** @type {string} */ name) => real.deleteDatabase(name),
        cmp: (/** @type {unknown} */ a, /** @type {unknown} */ b) => real.cmp(a, b),
      })
    );
    const records = reader(readOnlyTrustStore({ indexedDB: lying, keyRange: fakeKeyRange }), profile);
    const read = await records.incidentsRead();
    assert.equal(read.recordsRead, false, "a read it couldn't make");
    assert.deepEqual(await names(real), []);
  });

  it('reads no database where the factory lists NewTabNoteTrust below its version, as an aborted first upgrade may leave it, and opens none', async () => {
    const { readOnlyTrustStore } = await import('../../js/kernel/adapters/indexeddb/trust.js');
    const profile = trustProfile();
    const real = profile.real;
    let opens = 0;
    // A factory that lists NewTabNoteTrust at version 0, as Chrome may once an open that would have
    // made it aborted its upgrade
    const below = /** @type {IDBFactory} */ (
      /** @type {unknown} */ ({
        open: (/** @type {string} */ name, /** @type {number} */ version) => {
          opens += 1;
          return real.open(name, version);
        },
        databases: async () => [{ name: 'NewTabNoteTrust', version: 0 }],
        deleteDatabase: (/** @type {string} */ name) => real.deleteDatabase(name),
        cmp: (/** @type {unknown} */ a, /** @type {unknown} */ b) => real.cmp(a, b),
      })
    );
    const records = reader(readOnlyTrustStore({ indexedDB: below, keyRange: fakeKeyRange }), profile);
    assert.deepEqual(await records.latestReceipts(), []);
    assert.deepEqual(await records.incidentsRead(), { incidents: [], copyRead: true, recordsRead: true });
    assert.deepEqual([opens, await names(real)], [0, []]);
  });
});
