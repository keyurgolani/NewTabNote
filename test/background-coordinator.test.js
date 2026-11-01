'use strict';

// #35 slice 1a, the coordinator's host in the service worker (js/background.js and
// js/kernel/composition/coordinator.js). Every chrome.* listener registers before the
// coordinator is built, so one that can't be built still leaves the menus, the commands and
// #13's port listener working. It opens storage on the first event that needs it, never at
// load. Each welcome says whether it's starting, ready, or degraded and why, and a start writes
// first-run settings only: the read-only integrity check runs after an install or an update.
// Since #17 PR 1b its kernel runs #17's migration run first: a page's storage.migrate and
// #34's storageUpgrade start it as they reach it, and while an older build's open page blocks
// the run's upgrade it's migrating, not failed, until that page goes.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { IDBKeyRange } = require('fake-indexeddb');
const { block, createDatabase, note, plain, requestToPromise, waitFor } = require('./helpers/legacy-env');
const { loadBackground } = require('./helpers/load-background');

/** @type {any} */
let support;
/** @type {any} */
let core;
/** @type {any} */
let limits;

before(async () => {
  support = await import('./kernel/trust-support.mjs');
  core = {
    ...(await import('../js/trust/core/trust-records.js')),
    ...(await import('../js/kernel/adapters/indexeddb/trust.js')),
  };
  limits = await import('../js/kernel/core/contracts/limits.js');
});

/**
 * Every chrome.* listener the worker registers, and whether it needs storage, so starts the
 * coordinator. A listener added to js/background.js fails the first test until it's listed
 * here, and the second test then checks what it was listed as.
 */
const LISTENERS = Object.freeze({
  'runtime.onConnect': 'starts',
  'runtime.onMessage': 'no storage',
  'runtime.onInstalled': 'starts',
  'runtime.onStartup': 'starts',
  'action.onClicked': 'no storage',
  'contextMenus.onClicked': 'starts',
  'commands.onCommand': 'starts',
});

const SENDER_ID = 'test-extension';

/** A port one of the extension's pages opens to the worker's router, and the frames it gets back */
function pagePort(surface = 'popup') {
  /** @type {Array<(message: unknown) => void>} */
  const onMessage = [];
  /** @type {Array<() => void>} */
  const onDisconnect = [];
  /** @type {any[]} */
  const received = [];
  const port = {
    name: 'ntn-rpc',
    sender: { id: SENDER_ID, url: `chrome-extension://${SENDER_ID}/${surface}.html`, origin: `chrome-extension://${SENDER_ID}` },
    onMessage: { addListener: (listener) => onMessage.push(listener) },
    onDisconnect: { addListener: (listener) => onDisconnect.push(listener) },
    postMessage: (text) => received.push(JSON.parse(text)),
    disconnect: () => {},
  };
  return {
    port,
    received,
    /** Send `frame` to the worker, as the page's client would */
    send(frame) {
      for (const listener of onMessage) listener(JSON.stringify(frame));
    },
    /** Say hello, as #13's client does on its first send */
    hello(sessionId) {
      this.send({ frame: 'hello', protocol: { ...limits.PROTOCOL_VERSION }, extensionVersion: '1.4.1', surface, sessionId });
    },
  };
}

/** The welcome a hello on a new port gets, as {status, reason} */
async function welcomeOf(worker, sessionId) {
  const page = pagePort();
  await worker.dispatch('runtime.onConnect', page.port);
  page.hello(sessionId);
  await worker.drain();
  const welcome = page.received.find((frame) => frame.frame === 'welcome');
  assert.ok(welcome, JSON.stringify(page.received));
  return { status: welcome.status, reason: welcome.reason };
}

/** Each CanvasTabDB open the worker makes, from `setup` on */
function countOpens(env, opens) {
  const factory = env.indexedDB;
  const open = factory.open.bind(factory);
  factory.open = (name, ...rest) => {
    if (name === 'CanvasTabDB') opens.push(name);
    return open(name, ...rest);
  };
}

/** The codes of the events in the worker's NewTabNoteTrust, and its incidents */
async function trustOf(factory) {
  const store = core.createTrustDatabase({ indexedDB: factory, keyRange: IDBKeyRange });
  const records = core.createTrustRecords({
    store,
    settings: support.settingsArea(),
    clock: { now: () => Date.now() },
    ids: { next: () => crypto.randomUUID() },
  });
  await records.open();
  const events = (await records.events()).filter((event) => !event.code.startsWith('diagnostics.')).map((event) => event.code);
  const incidents = (await records.incidents()).map((incident) => [incident.providerId, incident.faultCode]);
  store.close();
  return { events, incidents };
}

/** A CanvasTabDB IndexedDB can't open at all, so neither the run nor the worker's kernel can */
function failingOpen(env) {
  const factory = env.indexedDB;
  const open = factory.open.bind(factory);
  factory.open = (name, ...rest) => {
    if (name === 'CanvasTabDB') throw new DOMException('test: the disk is gone', 'UnknownError');
    return open(name, ...rest);
  };
}

/** This extension's new tab page, as Chrome names it the sender of a message */
const OWN_PAGE = Object.freeze({ id: SENDER_ID, url: `chrome-extension://${SENDER_ID}/newtab.html`, origin: `chrome-extension://${SENDER_ID}` });

/** The global isOwnSender reads a sender's URL with, which legacy-env's sandbox leaves out */
function withUrl(env) {
  env.global.URL = URL;
}

/**
 * What the worker's one onMessage listener answers `request` from `sender` with, within
 * `withinMs` of real time: a run hashes what it copies off the main thread (webcrypto), which
 * drain() doesn't wait for
 */
async function ask(worker, request, sender, { withinMs = 10_000 } = {}) {
  /** @type {(answer: unknown) => void} */
  let answer = () => {};
  const answered = new Promise((resolve) => {
    answer = resolve;
  });
  await worker.dispatch('runtime.onMessage', request, sender, (response) => answer(plain(response)));
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(`no answer within ${withinMs} ms`), withinMs);
  });
  try {
    return await Promise.race([answered, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A worker client that throws as it's built, so the coordinator's kernel can't be: a `rewrite`
 * for loadBackground
 */
const KERNEL_THROWS = Object.freeze({
  'js/kernel/composition/background.js': (source) => source.replace(
    'export function createWorkerClient(host = workerHost()) {',
    "export function createWorkerClient(host = workerHost()) {\n  throw new Error('test: the worker client threw as it was built');",
  ),
});

describe("the worker's listeners and what starts its coordinator", () => {
  it('registers every listener the table lists, and no other', async () => {
    const worker = await loadBackground({ start: false });
    assert.deepEqual(Object.keys(worker.listenerCounts()).sort(), Object.keys(LISTENERS).sort());
  });

  for (const [name, kind] of Object.entries(LISTENERS)) {
    it(`${name} ${kind === 'starts' ? 'starts the coordinator, which opens the notes database' : "needs no storage, so opens nothing"}`, async () => {
      const opens = [];
      const worker = await loadBackground({ start: false, setup: (env) => countOpens(env, opens) });
      await worker.drain();
      assert.deepEqual(opens, [], 'nothing opens at load');
      if (name === 'runtime.onConnect') {
        const page = pagePort();
        await worker.dispatch(name, page.port);
        page.hello('session-1');
      } else if (name === 'runtime.onMessage') {
        // An API_REQUEST from another extension, which the worker refuses before it does anything
        await worker.dispatch(name, { type: 'API_REQUEST', url: 'https://example.test/', options: {} }, { id: 'another' }, () => {});
      } else if (name === 'runtime.onInstalled') {
        await worker.dispatch(name, { reason: 'install' });
      } else if (name === 'contextMenus.onClicked') {
        await worker.dispatch(name, { menuItemId: 'capture-page' }, worker.tab);
      } else if (name === 'commands.onCommand') {
        await worker.dispatch(name, 'capture-page');
      } else if (name === 'action.onClicked') {
        await worker.dispatch(name, worker.tab);
      } else {
        await worker.dispatch(name);
      }
      await worker.drain();
      if (kind === 'starts') assert.ok(opens.length > 0, 'it opened the notes database');
      else assert.deepEqual(opens, []);
    });
  }
});

describe("the coordinator's welcome", () => {
  it('says starting before the database is open, and ready once it is', async () => {
    const worker = await loadBackground({ start: false });
    assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'degraded', reason: 'starting' });
    assert.deepEqual(await welcomeOf(worker, 'session-2'), { status: 'ready', reason: undefined });
  });

  it("says newer-schema for a database a newer build upgraded, which it won't open", async () => {
    const worker = await loadBackground({ start: false, setup: (env) => createDatabase(env.indexedDB, { version: 99 }) });
    await worker.dispatch('runtime.onStartup');
    await worker.drain();
    assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'degraded', reason: 'newer-schema' });
  });
});

describe("the coordinator's health (system.coordinatorHealth)", () => {
  it("answers a page with what its welcome says, when its start began, and the commands it ran by outcome", async () => {
    const worker = await loadBackground();
    await worker.dispatch('commands.onCommand', 'capture-page');
    await worker.drain();
    const page = pagePort();
    await worker.dispatch('runtime.onConnect', page.port);
    page.hello('session-1');
    page.send({
      frame: 'request',
      requestId: 'r1',
      operation: 'system.coordinatorHealth',
      version: 1,
      deadline: Date.now() + 10_000,
      payload: { type: 'system.coordinatorHealth' },
    });
    await worker.drain();
    const [welcome, response] = page.received;
    assert.deepEqual([response.frame, response.requestId, response.result.kind], ['response', 'r1', 'ready']);
    const { startedAt, ...health } = response.result.data;
    assert.ok(Number.isSafeInteger(startedAt) && startedAt <= Date.now(), String(startedAt));
    assert.deepEqual(health, {
      status: 'ready',
      coordinatorId: welcome.coordinatorId,
      commands: [{ outcome: 'committed', count: 1 }],
      oldestOrphanedEntryAt: null,
    });
  });
});

describe('a worker whose storage can\'t be reached', () => {
  it('keeps every listener, creates the menus, and answers a capture and a hello with why', async () => {
    const worker = await loadBackground({ start: false, opens: false, setup: failingOpen });
    assert.deepEqual(Object.keys(worker.listenerCounts()).sort(), Object.keys(LISTENERS).sort());

    await worker.dispatch('runtime.onInstalled', { reason: 'install' });
    assert.deepEqual(worker.contextMenus().map((menu) => menu.id), ['capture-page', 'capture-selection']);

    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    // Today's words for a database the worker couldn't open
    assert.deepEqual(plain(worker.env.chrome.notifications), [{
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Not captured',
      message: "NewTabNote couldn't open your notes, so nothing was saved.",
    }]);
    assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'degraded', reason: 'storage-unavailable' });

    const seen = await trustOf(worker.indexedDB);
    // The run that couldn't read the database first, as its own migration event (#20, which
    // raises no incident), then the coordinator's failed open, then the capture
    assert.deepEqual(seen.events, ['storage.migration-failed', 'storage.open-failed', 'capture.failed']);
  });
});

describe("a worker whose coordinator can't serve", () => {
  /** Every database the worker opens, by name; NewTabNoteTrust's throws when `failTrust` */
  function recordOpens(env, opens, { failTrust = false } = {}) {
    const factory = env.indexedDB;
    const open = factory.open.bind(factory);
    factory.open = (name, ...rest) => {
      opens.push(name);
      if (failTrust && name === 'NewTabNoteTrust') throw new Error("test: the journal won't open");
      return open(name, ...rest);
    };
  }

  /** An install, a menu capture and an Alt+P capture, then a page's hello, and what each got */
  async function useWorker(worker) {
    await worker.dispatch('runtime.onInstalled', { reason: 'install' });
    await worker.drain();
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    await worker.dispatch('commands.onCommand', 'capture-page');
    await worker.drain();
    return {
      menus: worker.contextMenus().map((menu) => menu.id),
      notes: plain(worker.env.chrome.notifications).map((note) => [note.title, note.message]),
      welcome: await welcomeOf(worker, 'session-1'),
    };
  }

  // Today's words for a database the worker couldn't open, for each capture
  const UNAVAILABLE = {
    menus: ['capture-page', 'capture-selection'],
    notes: [
      ['Not captured', "NewTabNote couldn't open your notes, so nothing was saved."],
      ['Not captured', "NewTabNote couldn't open your notes, so nothing was saved."],
    ],
    welcome: { status: 'degraded', reason: 'coordinator-unavailable' },
  };

  /** The coordinator's start failure and each capture's, and the incidents they raise (#20) */
  function assertUnavailableJournaled({ events, incidents }) {
    assert.deepEqual(events, ['coordinator.start-failed', 'capture.failed', 'capture.failed']);
    assert.deepEqual([...incidents].sort(), [
      ['capture', 'capture-failed'],
      ['coordinator', 'start-failed'],
    ]);
  }

  for (const failTrust of [false, true]) {
    it(`whose kernel can't be built keeps its menus, and answers each capture and a hello as unavailable${failTrust ? ", with a journal that won't open" : ''}`, async () => {
      const opens = [];
      const worker = await loadBackground({
        start: false,
        opens: false,
        setup: (env) => recordOpens(env, opens, { failTrust }),
        rewrite: KERNEL_THROWS,
      });
      await worker.drain();
      assert.deepEqual(opens, [], 'nothing opens at load');
      assert.deepEqual(Object.keys(worker.listenerCounts()).sort(), Object.keys(LISTENERS).sort());
      assert.deepEqual(await useWorker(worker), UNAVAILABLE);
      assert.equal(opens.includes('CanvasTabDB'), false);
      if (!failTrust) assertUnavailableJournaled(await trustOf(worker.indexedDB));
    });
  }

  it('whose coordinator throws while js/background.js builds it keeps the stand-in, and every listener', async () => {
    const worker = await loadBackground({
      start: false,
      opens: false,
      rewrite: {
        'js/kernel/composition/coordinator.js': (source) => source.replace(
          'export function createCoordinator({',
          "export function createCoordinator() {\n  throw new Error('test: building the coordinator threw');\n}\n\nfunction createCoordinatorAsWritten({",
        ),
      },
    });
    await worker.drain();
    assert.deepEqual(Object.keys(worker.listenerCounts()).sort(), Object.keys(LISTENERS).sort());
    assert.deepEqual(await useWorker(worker), UNAVAILABLE);
    assertUnavailableJournaled(await trustOf(worker.indexedDB));
    const errors = worker.env.logs.filter((log) => log.level === 'error').map((log) => String(log.args[0]));
    assert.ok(errors.includes("NewTabNote: the background coordinator couldn't be built"), JSON.stringify(errors));
  });

  it("opens no database for an API_REQUEST from the extension's own page, or a toolbar click", async () => {
    const opens = [];
    const fetched = [];
    const worker = await loadBackground({
      start: false,
      setup: (env) => {
        recordOpens(env, opens);
        // Chrome's URL and Headers, which the worker's request check and its network guard read
        // a request with, and a fetch that answers
        env.global.URL = URL;
        env.global.Headers = Headers;
        env.global.Request = Request;
        env.global.fetch = async (input) => {
          fetched.push(typeof input === 'string' ? input : input.url);
          return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' };
        };
      },
    });
    await worker.drain();
    let answer;
    // A destination row the worker's proxy may reach (security/destinations.json)
    await worker.dispatch(
      'runtime.onMessage',
      { type: 'API_REQUEST', url: 'https://api.z.ai/api/paas/v4/models', options: { method: 'GET' } },
      { id: SENDER_ID, url: `chrome-extension://${SENDER_ID}/newtab.html` },
      (response) => {
        answer = response;
      },
    );
    await worker.drain();
    await worker.dispatch('action.onClicked', worker.tab);
    await worker.drain();
    assert.deepEqual(fetched, ['https://api.z.ai/api/paas/v4/models']);
    assert.equal(answer && answer.status, 200);
    assert.deepEqual(opens, []);
  });
});

describe('the read-only integrity check', () => {
  /**
   * A worker on a profile whose one block has no note, which the check reports, with what each
   * check reported, from its console (#17's adapter reports as Storage did), and the CanvasTabDB
   * opens it makes
   */
  async function counting() {
    const opens = [];
    const worker = await loadBackground({
      start: false,
      setup: async (env) => {
        await createDatabase(env.indexedDB, { records: { elements: [block('orphan', 'missing-note', 0)] } });
        countOpens(env, opens);
      },
    });
    const checks = () => worker.env.logs
      .filter((log) => log.level === 'info' && String(log.args[0]) === 'Integrity check (read-only) found orphaned records:')
      .map((log) => plain(log.args[1]));
    /** Wait for the run, then everything after it */
    const settled = async () => {
      await worker.env.global.storageUpgrade;
      await worker.drain();
    };
    return { worker, checks, opens, settled };
  }

  it('leaves the start: a browser start and a capture write first-run settings and check nothing', async () => {
    const { worker, checks, opens, settled } = await counting();
    await worker.dispatch('runtime.onStartup');
    await settled();
    const started = opens.length;
    assert.ok(started > 0, 'the start opened the notes database');
    const settings = await new Promise((resolve) => worker.env.chrome.api.storage.local.get(['setting_storageInitialized'], resolve));
    assert.equal(settings.setting_storageInitialized, true, 'the start wrote first-run settings');

    await worker.dispatch('commands.onCommand', 'capture-page');
    await worker.drain();
    assert.equal(worker.env.chrome.notifications.at(-1).title, 'Captured to New Tab Note');
    assert.equal(opens.length, started, 'the capture used the start\'s open');
    assert.deepEqual(checks(), []);
  });

  for (const reason of ['install', 'update']) {
    it(`runs once after an ${reason}, on #17's adapter, and reports what Storage reported`, async () => {
      const { worker, checks, settled } = await counting();
      await worker.dispatch('runtime.onInstalled', { reason });
      await settled();
      assert.deepEqual(checks(), [{ orphanedElements: 1 }]);
    });
  }

  it("doesn't run after Chrome itself updates", async () => {
    const { worker, checks, settled } = await counting();
    await worker.dispatch('runtime.onInstalled', { reason: 'chrome_update' });
    await settled();
    assert.deepEqual(checks(), []);
  });
});

describe("a page's storage.migrate and #34's storageUpgrade (#17 PR 1b)", () => {
  // Every event reaches the worker once its modules have run, the coordinator's build
  // included, and both start it before they read its run, so neither ever finds the stand-in
  it("reach the coordinator built at load: a page's wait, the worker's first event, starts it and hears its run", async () => {
    const opens = [];
    const worker = await loadBackground({ start: false, setup: (env) => { withUrl(env); countOpens(env, opens); } });
    await worker.drain();
    assert.deepEqual(opens, [], 'nothing opens at load');
    assert.deepEqual(await ask(worker, { type: 'storage.migrate' }, OWN_PAGE), { status: 'migrated' });
    assert.ok(opens.length > 0, 'it started the coordinator, whose kernel ran the run');
    await worker.drain();
    assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'ready', reason: undefined });
  });

  it("answers another sender request-refused, and starts nothing for it", async () => {
    const opens = [];
    const worker = await loadBackground({ start: false, setup: (env) => { withUrl(env); countOpens(env, opens); } });
    for (const sender of [
      { id: 'another', url: 'chrome-extension://another/newtab.html', origin: 'chrome-extension://another' },
      { id: SENDER_ID, url: 'https://example.test/', origin: 'https://example.test', tab: { id: 1 }, frameId: 0 },
      {},
    ]) {
      assert.deepEqual(await ask(worker, { type: 'storage.migrate' }, sender), { error: 'request-refused' }, JSON.stringify(sender));
    }
    await worker.drain();
    assert.deepEqual(opens, [], 'no coordinator start, and no run');
  });

  it('storageUpgrade starts it too, and reads as the run before any other event', async () => {
    const opens = [];
    const worker = await loadBackground({ start: false, setup: (env) => countOpens(env, opens) });
    await worker.drain();
    assert.deepEqual(opens, []);
    const upgrade = await worker.env.global.storageUpgrade;
    assert.equal(upgrade && upgrade.status, 'migrated');
    assert.ok(opens.length > 0);
  });

  it("answers failed, and storageUpgrade null, when the kernel can't be built, with nothing rejected unhandled", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const worker = await loadBackground({ start: false, opens: false, setup: withUrl, rewrite: KERNEL_THROWS });
      assert.equal(worker.env.global.storageUpgrade, null);
      assert.deepEqual(await ask(worker, { type: 'storage.migrate' }, OWN_PAGE), { status: 'failed' });
      assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'degraded', reason: 'coordinator-unavailable' });
      await worker.drain();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });
});

describe("an older build's page that keeps the upgrade blocked (#17 PR 1b)", () => {
  // While the upgrade waits, fake-indexeddb keeps the open it blocks queued, so the worker is
  // never idle and drain() can't tell when it's done: these wait in real time instead

  /** The welcome a hello on a new port gets */
  async function welcomeNow(worker, sessionId) {
    const page = pagePort();
    await worker.dispatch('runtime.onConnect', page.port);
    page.hello(sessionId);
    const welcome = await waitFor(() => page.received.find((frame) => frame.frame === 'welcome'), { withinMs: 5000, message: 'the welcome' });
    return { status: welcome.status, reason: welcome.reason };
  }

  /** The welcome once it says `wanted` (status or reason), within 10 s */
  async function welcomeOnce(worker, wanted) {
    const deadline = Date.now() + 10_000;
    for (let i = 0; ; i++) {
      const welcome = await welcomeNow(worker, `waiting-${i}`);
      if (welcome.status === wanted || welcome.reason === wanted || Date.now() > deadline) return welcome;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** `n` rounds of the worker's queued work */
  async function turns(n) {
    for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  it('is migrating for as long as it stays, with no failed open and no repeated asks, and ready once it closes', async () => {
    const opens = [];
    /** chrome.storage.local reads of the run's record: one for each migration attempt */
    const recordReads = [];
    /** @type {IDBDatabase | null} */
    let blocker = null;
    const worker = await loadBackground({
      start: false,
      opens: false,
      setup: async (env) => {
        withUrl(env);
        await createDatabase(env.indexedDB, { records: { canvases: [note('n1')] } });
        // 1.4.1's new tab holds its connection and never closes it on versionchange
        blocker = await requestToPromise(env.indexedDB.open('CanvasTabDB'));
        countOpens(env, opens);
        const local = env.chrome.api.storage.local;
        const get = local.get.bind(local);
        local.get = (keys, ...rest) => {
          if ([].concat(keys).includes('setting_storageUpgrade')) recordReads.push(keys);
          return get(keys, ...rest);
        };
      },
    });
    try {
      await worker.dispatch('runtime.onStartup');
      // A page that waits on the run meanwhile hears it once the run ends, however long that is
      const waiting = ask(worker, { type: 'storage.migrate' }, OWN_PAGE, { withinMs: 120_000 });
      // The run reads the stores and makes its point, then its upgrade waits on the page
      assert.deepEqual(await welcomeOnce(worker, 'migrating'), { status: 'degraded', reason: 'migrating' });

      // A capture meanwhile answers at once, with why
      await worker.dispatch('commands.onCommand', 'capture-page');
      await waitFor(() => worker.env.chrome.notifications.length === 1, { withinMs: 10_000, message: 'the capture notification' });
      assert.deepEqual(plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]), [[
        'Not captured',
        'NewTabNote is updating how your notes are stored, and an open NewTabNote tab or window is holding them. Close or reload it, then try again.',
      ]]);
      // Its event lands in the journal in its own time, before the clock below races ahead of
      // the journal's reads
      await waitFor(async () => (await trustOf(worker.indexedDB)).events.includes('capture.failed'), {
        withinMs: 5000,
        message: "the refused capture's event",
      });

      // Half an hour passes on the worker's clock, past every retry it has: nothing asks again
      const [opened, reads] = [opens.length, recordReads.length];
      assert.equal(reads, 1, 'one attempt');
      for (let minute = 0; minute < 31; minute++) {
        worker.env.clock.tick(60_000);
        await turns(20);
      }
      assert.deepEqual([opens.length, recordReads.length], [opened, reads], 'no new open, and no new attempt');
      assert.deepEqual(await welcomeNow(worker, 'still-blocked'), { status: 'degraded', reason: 'migrating' });
      const meanwhile = (await trustOf(worker.indexedDB)).events;
      assert.ok(!meanwhile.includes('storage.open-failed'), `a blocked upgrade is no failed open: ${JSON.stringify(meanwhile)}`);

      // The page closes: the upgrade goes on, the run ends, and the worker is ready
      blocker.close();
      blocker = null;
      assert.deepEqual(await waiting, { status: 'migrated' });
      assert.deepEqual(await welcomeOnce(worker, 'ready'), { status: 'ready', reason: undefined });
      await worker.drain();
      // (coordinator.started is journaled only over an open start-failed incident, which
      // test/kernel/coordinator.test.mjs covers)
      const { events } = await trustOf(worker.indexedDB);
      assert.ok(!events.includes('storage.open-failed'), `no failed open, ever: ${JSON.stringify(events)}`);
      await worker.dispatch('commands.onCommand', 'capture-page');
      await worker.drain();
      assert.equal(worker.env.chrome.notifications.at(-1).title, 'Captured to New Tab Note');
    } finally {
      if (blocker) blocker.close();
    }
  });
});
