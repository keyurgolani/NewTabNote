'use strict';

// #20 slice 1b: today's failure sites move onto the diagnostic journal. Background capture
// and the worker's storage open (js/background.js), the embedding model's load
// (js/embeddings.js), auto-backup (js/controllers/settings-controller.js), and the indexer's
// start (js/controllers/notes-manager.js, which gains an onerror) each send logger.event a
// registered code with value-free evidence, and the code's incident is raised in
// NewTabNoteTrust. Canaries seeded into each site's inputs (a note title, a URL, a
// credential, an error message) reach no journal event, record, settings entry, diagnostics
// export, or log line of trust code. And a trust store that's broken, missing, or refusing
// leaves each site doing exactly what it did: the same notifications, toasts, console lines,
// and notes.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { createLegacyEnv, createDatabase, dumpDatabase, note, block, plain, FakeDocument, startEditorClient } = require('./helpers/legacy-env');
const { loadBackground } = require('./helpers/load-background');

const TITLE = 'Canary title: plans for the divorce lawyer';
const URL_CANARY = 'https://canary.example.test/private/path?session=c4n4ry';
const CREDENTIAL = 'sk-canary-credential-7f3a9e';
const MESSAGE = 'Canary error message from the site';
const CANARIES = [TITLE, URL_CANARY, CREDENTIAL, MESSAGE, 'canary', 'Canary', 'c4n4ry'];

/** An error carrying every canary in its message, under `name` */
function canaryError(name = 'Error') {
  const error = new Error(`${MESSAGE}: ${TITLE} at ${URL_CANARY} with ${CREDENTIAL}`);
  error.name = name;
  return error;
}

/** @type {any} */
let trust;
/** @type {any} */
let lazy;
/** @type {any} */
let support;
/** @type {any} */
let core;

before(async () => {
  trust = await import('../js/kernel/composition/trust.js');
  lazy = await import('../js/kernel/composition/lazy-failure-events.js');
  support = await import('./kernel/trust-support.mjs');
  core = {
    ...(await import('../js/trust/core/trust-records.js')),
    ...(await import('../js/trust/core/journal.js')),
    ...(await import('../js/trust/core/diagnostics.js')),
    ...(await import('../js/kernel/adapters/indexeddb/trust.js')),
  };
});

/** A profile's trust host: its own fake IndexedDB, settings area, and locks */
function trustHost() {
  const indexedDB = new IDBFactory();
  const settings = support.settingsArea();
  const host = {
    indexedDB,
    keyRange: IDBKeyRange,
    settings,
    locks: support.lockManager(),
    clock: { now: () => Date.now() },
    ids: { next: () => crypto.randomUUID() },
  };
  return host;
}

/** A host whose IndexedDB won't open anything and whose settings area fails every call */
function brokenHost() {
  return {
    indexedDB: {
      open() {
        throw new DOMException(`${MESSAGE} ${URL_CANARY}`, 'UnknownError');
      },
    },
    keyRange: IDBKeyRange,
    settings: {
      get: async () => {
        throw canaryError();
      },
      set: async () => {
        throw canaryError();
      },
    },
    locks: null,
    clock: { now: () => Date.now() },
    ids: { next: () => crypto.randomUUID() },
  };
}

/**
 * What NewTabNoteTrust in `factory` holds, read through the records as the Trust Center
 * would, with the diagnostics export built from it, and every byte as text for canary searches
 * @param {IDBFactory} factory
 * @param {Map<string, unknown>} [settingsItems]
 */
async function inspect(factory, settingsItems = new Map()) {
  const store = core.createTrustDatabase({ indexedDB: factory, keyRange: IDBKeyRange });
  const settings = support.settingsArea();
  for (const [key, value] of settingsItems) settings.items.set(key, value);
  const clock = { now: () => Date.now() };
  const records = core.createTrustRecords({ store, settings, clock, ids: { next: () => crypto.randomUUID() } });
  await records.open();
  const journal = core.createDiagnosticJournal({ records, clock });
  const events = await records.events();
  const incidents = await records.incidents();
  const exported = await core.buildDiagnostics({
    records,
    journal,
    clock,
    versions: { extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 },
  });
  store.close();
  const text = [
    await support.dumpTrustDatabase(factory),
    JSON.stringify([...settingsItems]),
    JSON.stringify(exported),
  ].join('\n');
  return { events, incidents, exported, text };
}

/** Fails when any canary is in `text` */
function assertNoCanary(text, where) {
  for (const canary of CANARIES) assert.equal(text.includes(canary), false, `${where} holds ${JSON.stringify(canary)}`);
}

/** The failure codes' events in `events`, as [code, fields] */
const failures = events => events.filter(event => !event.code.startsWith('diagnostics.')).map(event => [event.code, event.fields]);

/** Each incident as [providerId, faultCode, subjectId, severity, occurrences] */
const incidentsOf = incidents => incidents.map(i => [i.providerId, i.faultCode, i.subjectId, i.severity, i.occurrences]);

describe('failure events (js/kernel/composition/trust.js)', () => {
  it('journals each failure code with value-free evidence and raises its incident', async () => {
    const host = trustHost();
    const events = trust.createFailureEvents({ surface: 'newtab', host: () => host });
    events.event('embeddings.load-failed', { durationMs: 12 }, canaryError('TypeError'));
    events.event('backup.auto-failed', {}, Object.assign(canaryError('QuotaExceededError'), { code: 'QUOTA' }));
    events.event('indexer.start-failed', {}, new DOMException(MESSAGE, 'SecurityError'));
    await events.flush();
    assert.deepEqual(await events.rejected(), {
      'unregistered-code': 0,
      'field-not-allowed': 0,
      'value-not-allowed': 0,
      'not-an-object': 0,
      'write-failed': 0,
    });
    const seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(failures(seen.events), [
      ['embeddings.load-failed', { exception: 'TypeError', surface: 'newtab', durationMs: 12 }],
      ['backup.auto-failed', { exception: 'QuotaExceededError', errorCode: 'quota' }],
      ['indexer.start-failed', { exception: 'SecurityError', surface: 'newtab' }],
    ]);
    assert.deepEqual(incidentsOf(seen.incidents).sort(), [
      ['backup', 'auto-backup-failed', null, 'data-risk', 1],
      ['index', 'indexer-start-failed', null, 'degraded', 1],
      ['local-inference', 'load-failed', null, 'degraded', 1],
    ]);
    assertNoCanary(seen.text, 'NewTabNoteTrust, the settings area, or the export');
  });

  it("keeps only a failure's registered name, code, cause, and retryable, never its message", () => {
    assert.deepEqual(trust.failureEvidence(canaryError('NotARegisteredName')), {});
    assert.deepEqual(trust.failureEvidence(Object.assign(new Error(MESSAGE), { code: 'OPEN_FAILED' })), {
      exception: 'Error',
      errorCode: 'open-failed',
    });
    assert.deepEqual(trust.failureEvidence(Object.assign(new Error(MESSAGE), { code: URL_CANARY })), { exception: 'Error' });
    assert.deepEqual(
      trust.failureEvidence({ kind: 'unavailable', cause: 'newer-schema', code: 'version-too-new', retryable: false, messageKey: TITLE }),
      { errorCode: 'version-too-new', cause: 'newer-schema', retryable: false },
    );
    assert.deepEqual(trust.failureEvidence({ cause: TITLE, code: CREDENTIAL, retryable: 'yes' }), {});
    const hostile = {};
    for (const name of ['name', 'code', 'cause', 'retryable', 'unavailableCause']) {
      Object.defineProperty(hostile, name, {
        get() {
          throw canaryError();
        },
      });
    }
    assert.deepEqual(trust.failureEvidence(hostile), {});
    assert.deepEqual(trust.failureEvidence(MESSAGE), {});
    assert.deepEqual(trust.failureEvidence(null), {});
  });

  it('drops and counts a refused event, and never throws for it', async () => {
    const host = trustHost();
    const events = trust.createFailureEvents({ surface: 'newtab', host: () => host });
    assert.equal(events.event('nothing.registered', {}), undefined);
    assert.equal(events.event('backup.auto-failed', { title: TITLE }), undefined);
    assert.equal(events.event('backup.auto-failed', { records: URL_CANARY }), undefined);
    assert.equal(events.event('backup.auto-failed', /** @type {any} */ (CREDENTIAL)), undefined);
    await events.flush();
    const rejected = await events.rejected();
    assert.equal(rejected['unregistered-code'], 1);
    assert.equal(rejected['field-not-allowed'], 1);
    assert.equal(rejected['value-not-allowed'], 1);
    assert.equal(rejected['not-an-object'], 1);
    const seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(failures(seen.events), []);
    assertNoCanary(seen.text, 'NewTabNoteTrust, the settings area, or the export');
  });

  it("gives the records the browser's timers, which bound reads of the settings copy", async () => {
    const { timers } = trust.browserTrustHost();
    let fired = false;
    const handle = timers.set(() => {
      fired = true;
    }, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fired, true);
    timers.clear(timers.set(assert.fail, 0));
    timers.clear(handle);
    await new Promise(resolve => setTimeout(resolve, 5));
  });

  it('opens nothing until the first event', async () => {
    let built = 0;
    const host = trustHost();
    const events = trust.createFailureEvents({
      surface: 'worker-internal',
      host: () => {
        built++;
        return host;
      },
    });
    await events.flush();
    assert.equal(built, 0);
    assert.equal(await events.rejected(), null);
    assert.deepEqual(await host.indexedDB.databases(), []);
    events.event('capture.failed', {}, canaryError());
    await events.flush();
    assert.equal(built, 1);
    assert.deepEqual((await host.indexedDB.databases()).map(db => db.name), ['NewTabNoteTrust']);
  });

  it('never throws when NewTabNoteTrust and the settings area both fail, or the host is missing', async () => {
    const broken = trust.createFailureEvents({ surface: 'worker-internal', host: brokenHost });
    for (const code of ['capture.failed', 'storage.open-failed', 'backup.auto-failed']) {
      assert.equal(broken.event(code, {}, canaryError()), undefined);
    }
    await broken.flush();
    const missing = trust.createFailureEvents({
      surface: 'newtab',
      host: () => {
        throw new ReferenceError('chrome is not defined');
      },
    });
    assert.equal(missing.event('indexer.start-failed', {}, canaryError()), undefined);
    await missing.flush();
    assert.equal(await missing.rejected(), null);
    // A field whose getter throws is the site's bug, and still never reaches it
    const hostile = Object.defineProperty({}, 'records', {
      enumerable: true,
      get() {
        throw canaryError();
      },
    });
    assert.equal(trust.createFailureEvents({ surface: 'newtab', host: brokenHost }).event('backup.auto-failed', hostile), undefined);
  });

  it('holds a storage incident in chrome.storage.local while NewTabNoteTrust won\'t open, without a canary', async () => {
    const host = { ...trustHost(), indexedDB: brokenHost().indexedDB };
    const events = trust.createFailureEvents({ surface: 'worker-internal', host: () => host });
    events.event('capture.failed', { commandId: '1730000000000-abc123def' }, canaryError());
    await events.flush();
    const copy = host.settings.items.get('trust.lastStorageIncident');
    assert.ok(copy, 'the fallback holds the capture incident');
    assert.ok(JSON.stringify(copy).includes('capture-failed'));
    assertNoCanary(JSON.stringify([...host.settings.items]), 'the settings area');
  });
});

describe('the new tab loads its failure events lazily (js/kernel/composition/lazy-failure-events.js)', () => {
  it('imports them on the first event only, and passes each event through', async () => {
    const heard = [];
    let loads = 0;
    const events = lazy.lazyFailureEvents({
      surface: 'newtab',
      load: async () => {
        loads++;
        return {
          createFailureEvents: ({ surface }) => ({
            event: (code, fields, failure) => heard.push([surface, code, fields, failure && failure.name]),
            flush: async () => {},
          }),
        };
      },
    });
    await events.flush();
    assert.equal(loads, 0);
    events.event('indexer.start-failed', {}, canaryError('TypeError'));
    events.event('backup.auto-failed', {}, canaryError());
    await events.flush();
    assert.equal(loads, 1);
    assert.deepEqual(heard, [
      ['newtab', 'indexer.start-failed', {}, 'TypeError'],
      ['newtab', 'backup.auto-failed', {}, 'Error'],
    ]);
  });

  it('drops the event, and never throws, when the import fails', async () => {
    const events = lazy.lazyFailureEvents({
      surface: 'newtab',
      load: async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      },
    });
    assert.equal(events.event('indexer.start-failed', {}, canaryError()), undefined);
    await events.flush();
    const throwing = lazy.lazyFailureEvents({
      surface: 'newtab',
      load: () => {
        throw new TypeError('import() is disallowed');
      },
    });
    assert.equal(throwing.event('backup.auto-failed', {}), undefined);
    await throwing.flush();
  });
});

// ============ The worker: background capture and storage init ============

/**
 * A worker whose IndexedDB refuses to open NewTabNoteTrust and passes every other open
 * through, as a profile whose trust database is broken
 * @param {any} env
 */
function breakTrustDatabase(env) {
  const real = env.indexedDB;
  env.global.indexedDB = {
    open(name, version) {
      if (name === 'NewTabNoteTrust') throw new DOMException(`${MESSAGE} ${URL_CANARY}`, 'UnknownError');
      return version === undefined ? real.open(name) : real.open(name, version);
    },
    deleteDatabase: name => real.deleteDatabase(name),
    databases: () => real.databases(),
    cmp: (a, b) => real.cmp(a, b),
  };
}

/** Every capture's block write throws, with the canaries in its message */
function failEveryTransaction(worker) {
  worker.Storage.transaction = () => {
    throw canaryError();
  };
}

/** A capture of a canary page and selection from the context menu */
async function captureCanary(worker) {
  const tab = { id: 9, windowId: 1, url: URL_CANARY, title: TITLE };
  await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page', pageUrl: URL_CANARY }, tab);
  await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-selection', selectionText: CREDENTIAL }, tab);
  await worker.drain();
}

/** What the worker did that a user or another context sees: notifications, its console, its writes, and its notes */
async function observed(worker) {
  const writes = worker.env.chrome.writes().filter(call => !call.keys.some(key => key.startsWith('trust.')));
  const notes = await dumpDatabase(worker.indexedDB);
  return plain({
    notifications: worker.env.chrome.notifications,
    logs: worker.env.logs.map(({ level, args }) => [level, args.map(arg => (arg instanceof Error ? `${arg.name}: ${arg.message}` : arg))]),
    writes,
    notes,
  });
}

/** A CanvasTabDB a newer build upgraded, which this build refuses to open */
async function newerProfile(env) {
  await createDatabase(env.indexedDB, { version: 99 });
}

describe('the worker reports background capture and storage init (js/background.js)', () => {
  it('a failed capture is a capture.failed event and capture incident, with no canary', async () => {
    const worker = await loadBackground({ mutate: failEveryTransaction });
    await captureCanary(worker);
    const seen = await inspect(worker.indexedDB);
    const captures = failures(seen.events);
    assert.equal(captures.length, 2, JSON.stringify(captures));
    for (const [code, fields] of captures) {
      assert.equal(code, 'capture.failed');
      assert.equal(fields.surface, 'worker-internal');
      assert.match(String(fields.commandId), /^[0-9]{13}-[a-z0-9]{0,9}$/);
      assert.deepEqual(
        Object.keys(fields).filter(name => !['surface', 'commandId', 'cause', 'errorCode', 'retryable', 'exception'].includes(name)),
        [],
      );
      assert.ok(typeof fields.cause === 'string', JSON.stringify(fields));
    }
    assert.deepEqual(incidentsOf(seen.incidents), [['capture', 'capture-failed', null, 'capture-risk', 2]]);
    assertNoCanary(seen.text, 'NewTabNoteTrust or the export');
    // The user still hears exactly what they did before
    assert.deepEqual(plain(worker.env.chrome.notifications), [
      { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Not captured', message: "Saving to today's note failed: the notes database couldn't store it" },
      { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Not captured', message: "Saving to today's note failed: the notes database couldn't store it" },
    ]);
  });

  it('a database that would not open is a storage.open-failed event at start, and each capture a capture.failed one', async () => {
    const worker = await loadBackground({ setup: newerProfile, opens: false });
    await worker.drain();
    let seen = await inspect(worker.indexedDB);
    const [opened] = failures(seen.events);
    assert.equal(opened[0], 'storage.open-failed');
    const { durationMs, ...rest } = opened[1];
    assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 0);
    assert.deepEqual(rest, {
      cause: 'newer-schema',
      errorCode: 'version-too-new',
      retryable: false,
      surface: 'worker-internal',
      subjectId: 'CanvasTabDB',
    });
    assert.deepEqual(incidentsOf(seen.incidents), [['storage', 'open-failed', 'CanvasTabDB', 'capture-risk', 1]]);

    await captureCanary(worker);
    seen = await inspect(worker.indexedDB);
    assert.deepEqual(failures(seen.events).slice(1), [
      ['capture.failed', { cause: 'newer-schema', errorCode: 'version-too-new', retryable: false, surface: 'worker-internal' }],
      ['capture.failed', { cause: 'newer-schema', errorCode: 'version-too-new', retryable: false, surface: 'worker-internal' }],
    ]);
    assert.deepEqual(incidentsOf(seen.incidents), [
      ['storage', 'open-failed', 'CanvasTabDB', 'capture-risk', 1],
      ['capture', 'capture-failed', null, 'capture-risk', 2],
    ]);
    assertNoCanary(seen.text, 'NewTabNoteTrust or the export');
  });

  for (const [what, options] of [
    ['a capture that fails', { mutate: failEveryTransaction }],
    ['a database that would not open', { setup: newerProfile, opens: false }],
    ['a capture that saves', {}],
  ]) {
    it(`with NewTabNoteTrust broken, ${what} notifies, logs, writes, and saves exactly as with it working`, async () => {
      const working = await loadBackground(options);
      await captureCanary(working);
      const broken = await loadBackground({
        ...options,
        setup: async env => {
          if (options.setup) await options.setup(env);
          breakTrustDatabase(env);
        },
      });
      await captureCanary(broken);
      const a = await observed(working);
      const b = await observed(broken);
      // Today's Daily Note's ids and times differ run to run; everything else is the same
      const shape = value => {
        const shaped = JSON.parse(JSON.stringify(value).replace(/[0-9]{13}-[a-z0-9]{0,9}/g, 'ID').replace(/"(createdAt|updatedAt|dateStr|lastOpenedAt|order)":[^,}]+/g, '"$1":0'));
        // Records come in key order, and keys differ run to run
        for (const { records } of Object.values(shaped.notes.stores)) records.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
        return shaped;
      };
      assert.deepEqual(shape(b), shape(a));
      assert.ok(a.notifications.length === 2);
      // No trust code wrote a console line in either
      for (const { logs } of [a, b]) {
        assertNoCanary(JSON.stringify(logs.filter(([, args]) => !/^(Failed to capture|Storage not opened|IndexedDB error)/.test(String(args[0])))), 'a log line');
      }
      assert.deepEqual(await broken.indexedDB.databases().then(list => list.map(db => db.name).filter(name => name === 'NewTabNoteTrust')), []);
    });
  }
});

// ============ The new tab: auto-backup, the indexer's start, and the embedding model's load ============

const PAGE_FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/controllers/settings-controller.js', 'js/controllers/notes-manager.js', 'js/embeddings.js'];

/** A new tab's legacy scripts on a profile with a canary note */
async function page() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('N', { name: TITLE })],
      elements: [block('b1', 'N', 0, `${CREDENTIAL} ${URL_CANARY}`)],
    },
  });
  env.load(...PAGE_FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  return { env, Storage };
}

/** A logger with only the level methods, and `event` when events are given */
function loggerWith(events) {
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  if (events) logger.event = events.event;
  return logger;
}

/** The three ways the tab's failure events can be: working, broken, or not there */
function variants() {
  const host = trustHost();
  return {
    host,
    working: trust.createFailureEvents({ surface: 'newtab', host: () => host }),
    broken: trust.createFailureEvents({ surface: 'newtab', host: brokenHost }),
    unloadable: lazy.lazyFailureEvents({
      surface: 'newtab',
      load: async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      },
    }),
    none: null,
  };
}

/** Toasts the page shows and its console lines, as text */
function pageObserved(env) {
  return plain({
    logs: env.logs.map(({ level, args }) => [level, args.map(arg => (arg && typeof arg === 'object' && 'message' in arg ? `${arg.name}: ${arg.message}` : arg))]),
    toasts: env.document && env.document.body ? String(env.document.body.textContent || '') : '',
  });
}

describe('auto-backup reports a failed backup (js/controllers/settings-controller.js)', () => {
  /**
   * A due backup whose chrome.storage.local write fails, with the canaries in lastError, or
   * that fails as `fail` makes it
   */
  async function failedBackup(events, fail = ({ env }) => env.chrome.failNextSet(canaryError())) {
    const { env, Storage } = await page();
    await Storage.setSetting('autoBackupEnabled', true);
    // The page's settings port, which runs the auto-backup command (#12 slice 6)
    await startEditorClient(env);
    const SettingsController = env.get('SettingsController');
    const settings = new SettingsController({
      settings: env.settingsClient,
      documentClient: env.documentClient,
      validateBackup: env.validateBackup,
      domRefs: null,
      logger: loggerWith(events),
    });
    fail({ env, Storage });
    await settings.checkBackupStatus();
    if (events) await events.flush();
    return { env, Storage };
  }

  it('is a backup.auto-failed event and data-risk incident, with no canary', async () => {
    const { host, working } = variants();
    await failedBackup(working);
    const seen = await inspect(host.indexedDB, host.settings.items);
    // chrome.runtime.lastError holds only a message; the createAutoBackup outcome the event
    // reads it through carries its cause and whether a retry can work, and nothing of the message
    assert.deepEqual(failures(seen.events), [['backup.auto-failed', { cause: 'storage', errorCode: 'transaction-failed', retryable: true }]]);
    assert.deepEqual(incidentsOf(seen.incidents), [['backup', 'auto-backup-failed', null, 'data-risk', 1]]);
    assertNoCanary(seen.text, 'NewTabNoteTrust, the settings area, or the export');
  });

  it("an IndexedDB failure keeps the exception's name, so an UnknownError and an AbortError stay apart", async () => {
    const seenFor = async (name) => {
      const { host, working } = variants();
      await failedBackup(working, ({ Storage }) => {
        // The export reads every store first, so a failing database fails it there
        Storage.exportAll = async () => {
          throw new DOMException(`${MESSAGE}: ${TITLE} at ${URL_CANARY} with ${CREDENTIAL}`, name);
        };
      });
      const seen = await inspect(host.indexedDB, host.settings.items);
      assertNoCanary(seen.text, `NewTabNoteTrust, the settings area, or the export, after ${name}`);
      return failures(seen.events);
    };
    assert.deepEqual(await seenFor('UnknownError'), [
      ['backup.auto-failed', { exception: 'UnknownError', cause: 'storage', errorCode: 'transaction-failed', retryable: true }],
    ]);
    assert.deepEqual(await seenFor('AbortError'), [
      ['backup.auto-failed', { exception: 'AbortError', cause: 'storage', errorCode: 'transaction-failed', retryable: true }],
    ]);
  });

  it('warns, toasts, and stores nothing exactly as before, whatever the failure events are', async () => {
    const all = variants();
    const runs = [];
    for (const name of ['none', 'working', 'broken', 'unloadable']) {
      const { env } = await failedBackup(all[name]);
      runs.push([name, pageObserved(env), Object.keys(env.chrome.local).filter(key => key.startsWith('auto_backup_') || key === 'setting_lastBackupAt')]);
    }
    const [, before, stored] = runs[0];
    assert.ok(before.logs.some(([level, args]) => level === 'warn' && args[0] === 'Auto-backup failed:'));
    assert.deepEqual(stored, []);
    for (const [name, seen, keys] of runs.slice(1)) {
      assert.deepEqual(seen, before, name);
      assert.deepEqual(keys, stored, name);
    }
  });
});

describe("the indexer's start reports a worker that won't start (js/controllers/notes-manager.js)", () => {
  /** A fake Worker the test drives: its error and message handlers, and what it was sent */
  function fakeWorkers(env, { throws = null } = {}) {
    const made = [];
    env.global.Worker = class {
      constructor(url) {
        if (throws) throw throws;
        this.url = url;
        this.sent = [];
        made.push(this);
      }
      postMessage(message) {
        this.sent.push(message);
      }
      terminate() {}
    };
    return made;
  }

  async function manager(events, options) {
    const { env, Storage } = await page();
    const made = fakeWorkers(env, options);
    const NotesManager = env.get('NotesManager');
    // App hands NotesManager the composition root's starter (js/kernel/composition/workers.js)
    const startIndexer = () => new env.global.Worker('js/workers/indexer.js', { type: 'module' });
    const notes = new NotesManager({ storage: Storage, domRefs: null, logger: loggerWith(events), llm: null, startIndexer });
    notes.initIndexer();
    await new Promise(resolve => setImmediate(resolve));
    return { env, notes, made };
  }

  it('a Worker that throws as it is made is an indexer.start-failed event, with no canary', async () => {
    const { host, working } = variants();
    await manager(working, { throws: new DOMException(`${MESSAGE} ${URL_CANARY}`, 'SecurityError') });
    await working.flush();
    const seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(failures(seen.events), [['indexer.start-failed', { exception: 'SecurityError', surface: 'newtab' }]]);
    assert.deepEqual(incidentsOf(seen.incidents), [['index', 'indexer-start-failed', null, 'degraded', 1]]);
    assertNoCanary(seen.text, 'NewTabNoteTrust, the settings area, or the export');
  });

  it('gains an onerror: the first error before its first answer is the event, and later ones are not', async () => {
    const { host, working } = variants();
    const { made } = await manager(working);
    assert.equal(made.length, 1);
    const [worker] = made;
    assert.equal(typeof worker.onerror, 'function');
    const errorEvent = () => ({ type: 'error', message: MESSAGE, filename: URL_CANARY, lineno: 1, error: canaryError('SyntaxError'), preventDefault: assert.fail });
    // It never calls preventDefault, so the browser reports the error as it did before
    worker.onerror(errorEvent());
    worker.onerror(errorEvent());
    await working.flush();
    let seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(failures(seen.events), [['indexer.start-failed', { exception: 'SyntaxError', surface: 'newtab' }]]);

    // A second manager's worker answers, and then throws: it started, so that's not a start failure
    const later = await manager(working);
    await later.made[0].onmessage({ data: { type: 'UNKNOWN' } });
    later.made[0].onerror(errorEvent());
    await working.flush();
    seen = await inspect(host.indexedDB, host.settings.items);
    assert.equal(failures(seen.events).length, 1);
    assertNoCanary(seen.text, 'NewTabNoteTrust, the settings area, or the export');
  });

  it('warns and indexes exactly as before, whatever the failure events are', async () => {
    const all = variants();
    for (const options of [{ throws: canaryError() }, {}]) {
      const runs = [];
      for (const name of ['none', 'working', 'broken', 'unloadable']) {
        const { env, notes, made } = await manager(all[name], options);
        if (made[0]) made[0].onerror({ message: MESSAGE, error: canaryError() });
        if (all[name]) await all[name].flush();
        runs.push([name, pageObserved(env), made.map(worker => plain(worker.sent)), Boolean(notes.indexerWorker)]);
      }
      const [, ...first] = runs[0];
      for (const [name, ...rest] of runs.slice(1)) assert.deepEqual(rest, first, name);
    }
  });
});

describe("the embedding model's load reports a model that won't load (js/embeddings.js)", () => {
  async function failingModel(events) {
    const env = createLegacyEnv({ document: null });
    env.load('js/embeddings.js');
    env.global.transformers = {
      env: { backends: { onnx: { wasm: {} } } },
      pipeline: async () => {
        throw canaryError('TypeError');
      },
    };
    const Embeddings = env.get('Embeddings');
    if (events) Embeddings.events = events;
    await Embeddings.init();
    // The failure holds until Try again (#27 slice 3b): the notes it embeds after it don't load again
    const vectors = [await Embeddings.generateEmbedding(TITLE), await Embeddings.generateEmbedding(CREDENTIAL)];
    if (events) await events.flush();
    return { env, Embeddings, vectors };
  }

  it('is one embeddings.load-failed event and local-inference incident per page, with no canary', async () => {
    const { host, working } = variants();
    await failingModel(working);
    const seen = await inspect(host.indexedDB, host.settings.items);
    const events = failures(seen.events);
    assert.equal(events.length, 1);
    const [[code, { durationMs, ...fields }]] = events;
    assert.equal(code, 'embeddings.load-failed');
    assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 0);
    assert.deepEqual(fields, { exception: 'TypeError', surface: 'newtab' });
    assert.deepEqual(incidentsOf(seen.incidents), [['local-inference', 'load-failed', null, 'degraded', 1]]);
    assertNoCanary(seen.text, 'NewTabNoteTrust, the settings area, or the export');
  });

  it('logs and answers exactly as before, whatever the failure events are', async () => {
    const all = variants();
    const runs = [];
    for (const name of ['none', 'working', 'broken', 'unloadable']) {
      const { env, Embeddings, vectors } = await failingModel(all[name]);
      runs.push([name, pageObserved(env).logs, vectors, Embeddings.isReady, Embeddings.isLoading]);
    }
    const [, logs, vectors] = runs[0];
    assert.deepEqual(vectors, [null, null]);
    assert.equal(logs.filter(([level, args]) => level === 'error' && args[0] === 'Embeddings: Failed to load model:').length, 1);
    for (const [name, ...rest] of runs.slice(1)) assert.deepEqual(rest, runs[0].slice(1), name);
  });
});

describe("App gives the tab's failure events to the controllers' logger and to Embeddings (js/app.js)", () => {
  const APP_FILES = [
    'js/utils.js', 'js/core/storage-error.js', 'js/core/dom-refs.js', 'js/core/logger.js',
    'js/ui/export-notice.js', 'js/storage.js', 'js/search.js', 'js/embeddings.js', 'js/app.js',
  ];

  it('as logger.event and Embeddings.events, and leaves both alone without them', () => {
    const env = createLegacyEnv({ document: new FakeDocument() });
    env.load(...APP_FILES);
    const App = env.get('App');
    const Embeddings = env.get('Embeddings');
    const events = { event() {}, flush: async () => {} };
    const app = new App({ events });
    app.logger = env.get('createLogger')();
    app.attachFailureEvents();
    assert.equal(app.logger.event, events.event);
    assert.equal(Embeddings.events, events);

    Embeddings.events = null;
    const bare = new App({});
    bare.logger = env.get('createLogger')();
    bare.attachFailureEvents();
    assert.equal('event' in bare.logger, false);
    assert.equal(Embeddings.events, null);
  });
});

describe("#20's before-slice-4 follow-ups: success events at the sites, and the worker's reconcile", () => {
  /** The trust events a page's or the worker's sites report into, over `host` */
  const eventsOver = host => trust.createFailureEvents({ surface: 'newtab', host: () => host });

  it("the indexer's first INDEX_COMPLETE is an indexer.started event, which resolves an earlier start failure", async () => {
    const { env, Storage } = await page();
    const host = trustHost();
    const events = eventsOver(host);
    const made = [];
    env.global.Worker = class {
      constructor() {
        this.sent = [];
        made.push(this);
      }
      postMessage(message) {
        this.sent.push(message);
      }
      terminate() {}
    };
    const NotesManager = env.get('NotesManager');
    // The composition root hands NotesManager the indexer's starter (js/kernel/composition/workers.js)
    const startIndexer = () => new env.global.Worker('js/workers/indexer.js', { type: 'module' });
    const notes = new NotesManager({ storage: Storage, domRefs: null, logger: loggerWith(events), llm: null, startIndexer });
    notes.initIndexer();
    made[0].onerror({ message: MESSAGE, error: canaryError('SyntaxError') });
    await events.flush();
    let seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(incidentsOf(seen.incidents), [['index', 'indexer-start-failed', null, 'degraded', 1]]);
    // Another tab's indexer starts and answers: a later success at the same site
    const later = new NotesManager({ storage: Storage, domRefs: null, logger: loggerWith(events), llm: null, startIndexer });
    later.initIndexer();
    await made[1].onmessage({ data: { type: 'INDEX_COMPLETE', data: [] } });
    await made[1].onmessage({ data: { type: 'INDEX_COMPLETE', data: [] } });
    await events.flush();
    seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(seen.incidents.map(incident => [incident.key, incident.state]), [['index/indexer-start-failed/-', 'resolved']]);
    assert.deepEqual(failures(seen.events), [
      ['indexer.start-failed', { exception: 'SyntaxError', surface: 'newtab' }],
      ['indexer.started', { surface: 'newtab' }],
    ]);
    assertNoCanary(seen.text, 'NewTabNoteTrust, the settings area, or the export');
  });

  it('a backup that saves after one that failed is a backup.auto-succeeded event, which resolves it', async () => {
    const { env, Storage } = await page();
    const host = trustHost();
    const events = eventsOver(host);
    await Storage.setSetting('autoBackupEnabled', true);
    await startEditorClient(env);
    const SettingsController = env.get('SettingsController');
    const settings = new SettingsController({
      settings: env.settingsClient,
      documentClient: env.documentClient,
      validateBackup: env.validateBackup,
      domRefs: null,
      logger: loggerWith(events),
    });
    env.chrome.failNextSet(canaryError());
    await settings.checkBackupStatus();
    await events.flush();
    await settings.checkBackupStatus();
    await events.flush();
    const seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(seen.incidents.map(incident => [incident.key, incident.state]), [['backup/auto-backup-failed/-', 'resolved']]);
    assert.deepEqual(
      failures(seen.events).map(([code]) => code),
      ['backup.auto-failed', 'backup.auto-succeeded'],
    );
    assert.deepEqual(failures(seen.events)[1], ['backup.auto-succeeded', {}]);
  });

  it('a capture that commits after one that failed is a capture.committed event, which resolves it', async () => {
    let failing = true;
    const worker = await loadBackground({
      mutate: global => {
        const transaction = global.Storage.transaction.bind(global.Storage);
        global.Storage.transaction = (...args) => {
          if (failing) throw canaryError();
          return transaction(...args);
        };
      },
    });
    const tab = { id: 9, windowId: 1, url: URL_CANARY, title: TITLE };
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page', pageUrl: URL_CANARY }, tab);
    await worker.drain();
    failing = false;
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page', pageUrl: URL_CANARY }, tab);
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(seen.incidents.map(incident => [incident.key, incident.state]), [['capture/capture-failed/-', 'resolved']]);
    const codes = failures(seen.events).map(([code]) => code);
    assert.deepEqual(codes, ['capture.failed', 'capture.committed']);
    assertNoCanary(seen.text, 'NewTabNoteTrust or the export');
  });

  it('a worker start reconciles the held failures of a context whose NewTabNoteTrust would not open', async () => {
    const worker = await loadBackground({
      setup: async env => {
        // An earlier context held NewTabNoteTrust's own incidents in chrome.storage.local
        const settings = support.settingsArea();
        const records = core.createTrustRecords({
          store: core.createTrustDatabase({ indexedDB: support.brokenFactory }),
          settings,
          clock: { now: () => Date.now() - 60_000 },
          ids: { next: () => crypto.randomUUID() },
        });
        await records.open();
        env.chrome.local['trust.lastStorageIncident'] = settings.items.get('trust.lastStorageIncident');
      },
    });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(seen.incidents.map(incident => [incident.key, incident.state]), [
      ['storage/open-failed/NewTabNoteTrust', 'resolved'],
    ]);
    assert.equal(worker.env.chrome.local['trust.lastStorageIncident'], null);
  });

  it('a database that stays broken journals one storage.open-failed per open incident, whatever the worker starts', async () => {
    const worker = await loadBackground({
      opens: false,
      setup: async env => {
        await newerProfile(env);
        // An earlier worker start already raised it
        const settings = support.settingsArea();
        const store = core.createTrustDatabase({ indexedDB: env.indexedDB, keyRange: IDBKeyRange });
        const records = core.createTrustRecords({ store, settings, clock: { now: () => Date.now() - 60_000 }, ids: { next: () => crypto.randomUUID() } });
        await records.open();
        const journal = core.createDiagnosticJournal({ records, clock: { now: () => Date.now() - 60_000 } });
        journal.event('storage.open-failed', { subjectId: 'CanvasTabDB', errorCode: 'version-too-new' });
        await journal.flush();
        store.close();
      },
    });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(failures(seen.events).map(([code]) => code), ['storage.open-failed']);
    assert.deepEqual(incidentsOf(seen.incidents), [['storage', 'open-failed', 'CanvasTabDB', 'capture-risk', 2]]);
  });

  it("App reconciles the tab's trust store when it attaches the failure events", () => {
    const env = createLegacyEnv({ document: new FakeDocument() });
    env.load(
      'js/utils.js', 'js/core/storage-error.js', 'js/core/dom-refs.js', 'js/core/logger.js',
      'js/ui/export-notice.js', 'js/storage.js', 'js/search.js', 'js/embeddings.js', 'js/app.js',
    );
    const App = env.get('App');
    let reconciled = 0;
    const app = new App({ events: { event() {}, flush: async () => {}, reconcile: async () => { reconciled++; } } });
    app.logger = env.get('createLogger')();
    app.attachFailureEvents();
    assert.equal(reconciled, 1);
  });
});

describe("the background coordinator's start (js/kernel/composition/coordinator.js, #35)", () => {
  /** A worker instance's coordinator on `makeKernel`, started, with failure events over `host` */
  async function coordinatorOver(host, makeKernel) {
    const { createCoordinator } = await import('../js/kernel/composition/coordinator.js');
    const events = trust.createFailureEvents({ surface: 'worker-internal', host: () => host });
    const coordinator = createCoordinator({ instanceId: crypto.randomUUID(), makeKernel, events, report: () => {} });
    await coordinator.start();
    await events.flush();
    return coordinator;
  }

  it("a kernel the worker can't build is coordinator.start-failed and its incident, and the next start that opens resolves it", async () => {
    const host = trustHost();
    const unbuilt = await coordinatorOver(host, () => {
      throw canaryError('TypeError');
    });
    assert.deepEqual(unbuilt.status(), { status: 'degraded', reason: 'coordinator-unavailable' });
    let seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(incidentsOf(seen.incidents), [['coordinator', 'start-failed', null, 'capture-risk', 1]]);
    assert.deepEqual(failures(seen.events), [['coordinator.start-failed', { exception: 'TypeError', surface: 'worker-internal' }]]);

    // The next worker instance builds its kernel, and it opens
    const kernel = {
      execute: async () => ({ kind: 'committed', code: 'test', changedIds: [] }),
      query: async () => ({ kind: 'empty', asOf: 0 }),
      subscribe: () => () => {},
      whenReady: async () => null,
      ids: { next: () => crypto.randomUUID() },
    };
    const started = await coordinatorOver(host, () => kernel);
    assert.deepEqual(started.status(), { status: 'ready' });
    seen = await inspect(host.indexedDB, host.settings.items);
    assert.deepEqual(seen.incidents.map(incident => [incident.key, incident.state]), [['coordinator/start-failed/-', 'resolved']]);
    assert.deepEqual(failures(seen.events).map(([code]) => code), ['coordinator.start-failed', 'coordinator.started']);
    assertNoCanary(seen.text, 'NewTabNoteTrust or the export');
  });
});
