'use strict';

// #35 slice 1a, the coordinator's host in the service worker (js/background.js and
// js/kernel/composition/coordinator.js). Every chrome.* listener registers before the
// coordinator is built, so one that can't be built still leaves the menus, the commands and
// #13's port listener working. It opens storage on the first event that needs it, never at
// load. Each welcome says whether it's starting, ready, or degraded and why, and a start writes
// first-run settings only: the read-only integrity check runs after an install or an update.
// Since #17 PR 1b its kernel runs #17's migration run first: a page's storage.migrate and
// #34's storageUpgrade start it as they reach it, and while an older build's open page blocks
// the run's upgrade it's migrating, not failed, until that page goes. Since #35 slice 3 a
// capture writes its journal entry before the coordinator starts, so one its notes can't take
// is kept and says so, and the coordinator's drain adds it, in the day it was made, once it's
// ready, which no welcome waits for.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { IDBKeyRange } = require('fake-indexeddb');
const { block, createDatabase, dumpDatabase, note, plain, recordsOf, requestToPromise, waitFor } = require('./helpers/legacy-env');
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
 * NewTabNoteJournal's adapter and the journal's entries (#35 slice 3), loaded by the cases that
 * read or seed the worker's journal
 * @returns {Promise<any>}
 */
async function journalModules() {
  return {
    ...(await import('../js/kernel/adapters/indexeddb/journal.js')),
    ...(await import('../js/kernel/core/domain/journal.js')),
  };
}

/** What a capture the notes can't take says now: it's kept (#35 slice 3, the lead's words) */
const KEPT = Object.freeze([
  "Kept for today's note",
  "NewTabNote couldn't save this to your notes yet. It's kept on this device and will be added when your notes open.",
]);

/** And one an older build's open page keeps from the notes, which says what will add it */
const KEPT_BLOCKED = Object.freeze([
  "Kept for today's note",
  "Close or reload your open NewTabNote tabs and windows to finish an update and add this. It's kept on this device until then.",
]);

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
    /** Close the port from the page's end, as a page that goes does */
    close() {
      for (const listener of onDisconnect) listener();
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

/** The codes of the events in the worker's NewTabNoteTrust, its incidents, and each event as [code, fields] */
async function trustOf(factory) {
  const store = core.createTrustDatabase({ indexedDB: factory, keyRange: IDBKeyRange });
  const records = core.createTrustRecords({
    store,
    settings: support.settingsArea(),
    clock: { now: () => Date.now() },
    ids: { next: () => crypto.randomUUID() },
  });
  await records.open();
  const journaled = (await records.events()).filter((event) => !event.code.startsWith('diagnostics.'));
  const events = journaled.map((event) => event.code);
  const incidents = (await records.incidents()).map((incident) => [incident.providerId, incident.faultCode]);
  store.close();
  return { events, incidents, fields: journaled.map((event) => [event.code, event.fields]) };
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

/** A NewTabNoteJournal IndexedDB can't open either, so no capture's entry can be written */
function failingJournal(env) {
  const factory = env.indexedDB;
  const open = factory.open.bind(factory);
  factory.open = (name, ...rest) => {
    if (name === 'NewTabNoteJournal') throw new DOMException('test: the disk is gone', 'UnknownError');
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
  it("waits for the start a page's hello sets off, and says ready once the database is open", async () => {
    const worker = await loadBackground({ start: false });
    assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'ready', reason: undefined });
    assert.deepEqual(await welcomeOf(worker, 'session-2'), { status: 'ready', reason: undefined });
  });

  it("says starting when the start hasn't answered by WELCOME_WAIT_MS, and nothing before", async () => {
    // A database open that never answers, so the start never does either
    const worker = await loadBackground({
      start: false,
      setup: (env) => {
        env.indexedDB.open = () => ({});
      },
    });
    const page = pagePort();
    await worker.dispatch('runtime.onConnect', page.port);
    page.hello('session-1');
    await worker.drain();
    assert.deepEqual(page.received, []);
    worker.env.clock.tick(limits.WELCOME_WAIT_MS - 1);
    await worker.drain();
    assert.deepEqual(page.received, []);
    worker.env.clock.tick(1);
    await worker.drain();
    const welcome = page.received.find((frame) => frame.frame === 'welcome');
    assert.deepEqual(welcome && [welcome.status, welcome.reason], ['degraded', 'starting']);
  });

  it("says newer-schema for a database a newer build upgraded, which it won't open", async () => {
    const worker = await loadBackground({ start: false, setup: (env) => createDatabase(env.indexedDB, { version: 99 }) });
    await worker.dispatch('runtime.onStartup');
    await worker.drain();
    assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'degraded', reason: 'newer-schema' });
  });
});

describe("the coordinator while its run upgrades a 1.4.x database (#35 slice 2)", () => {
  it('welcomes a hello as migrating while the run upgrades: at the cap for the hello that starts it, at once after, and ready once the run is in', async () => {
    /** @type {() => void} */
    let release = () => {};
    const roomy = new Promise((resolve) => {
      release = () => resolve({ quota: 10 * 1024 ** 3, usage: 1024 ** 2 });
    });
    const asked = { count: 0 };
    const worker = await loadBackground({
      start: false,
      setup: async (env) => {
        await createDatabase(env.indexedDB, { records: { canvases: [note('n1')] } });
        // The run asks it right after it measures the stores for its point, and waits there
        env.global.navigator.storage = {
          estimate: () => {
            asked.count++;
            return roomy;
          },
        };
      },
    });
    const first = pagePort();
    await worker.dispatch('runtime.onConnect', first.port);
    first.hello('session-1');
    await worker.drain();
    assert.equal(asked.count, 1, 'the run reached its space check');
    assert.deepEqual(first.received, [], 'its welcome is held');
    worker.env.clock.tick(limits.WELCOME_WAIT_MS);
    await worker.drain();
    const held = first.received.find((frame) => frame.frame === 'welcome');
    assert.deepEqual(held && [held.status, held.reason], ['degraded', 'migrating']);
    // A hello during the run isn't held: the coordinator isn't starting, it's migrating
    assert.deepEqual(await welcomeOf(worker, 'session-2'), { status: 'degraded', reason: 'migrating' });
    release();
    // The run checks its point with Web Crypto, which drain() doesn't wait for, so from here
    // this waits in real time, as the blocked upgrade's cases do
    const upgrade = await worker.env.global.storageUpgrade;
    assert.equal(upgrade && upgrade.status, 'migrated');
    const after = pagePort();
    await worker.dispatch('runtime.onConnect', after.port);
    after.hello('session-3');
    const welcome = await waitFor(() => after.received.find((frame) => frame.frame === 'welcome'), {
      withinMs: 10_000,
      message: 'the welcome once the run is in',
    });
    assert.deepEqual([welcome.status, welcome.reason], ['ready', undefined]);
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
      migration: null,
    });
  });
});

describe('a worker whose storage can\'t be reached', () => {
  it('keeps every listener, creates the menus, and answers a capture and a hello with why', async () => {
    const worker = await loadBackground({ start: false, opens: false, setup: failingOpen });
    assert.deepEqual(Object.keys(worker.listenerCounts()).sort(), Object.keys(LISTENERS).sort());

    await worker.dispatch('runtime.onInstalled', { reason: 'install' });
    assert.deepEqual(worker.contextMenus().map((menu) => menu.id), ['capture-page', 'capture-selection']);

    const clickedFrom = Date.now();
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    const clickedBy = Date.now();
    await worker.drain();
    // Its entry is kept for the drain, and it says so (#35 slice 3)
    assert.deepEqual(plain(worker.env.chrome.notifications), [{
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: KEPT[0],
      message: KEPT[1],
    }]);
    const [kept] = await journalOf(worker.indexedDB);
    assert.deepEqual(
      [kept.command.type, kept.command.capture, kept.state, kept.surface],
      ['captureToDailyNote', { type: 'bookmark', url: worker.tab.url, title: worker.tab.title }, 'submitted', 'worker-internal'],
    );
    // It carries the click's time, whose day it lands in however late the drain adds it
    assert.ok(kept.command.at >= clickedFrom && kept.command.at <= clickedBy, String(kept.command.at));
    assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'degraded', reason: 'storage-unavailable' });

    const seen = await trustOf(worker.indexedDB);
    // The run that couldn't read the database first, as its own migration event (#20, which
    // raises no incident), then the coordinator's failed open, then the capture
    assert.deepEqual(seen.events, ['storage.migration-failed', 'storage.open-failed', 'capture.failed']);
  });

  it("says a capture whose entry can't be written isn't captured, in today's words, and never that it's kept (#35 slice 3)", async () => {
    const worker = await loadBackground({
      start: false,
      opens: false,
      setup: (env) => {
        failingOpen(env);
        failingJournal(env);
      },
    });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    assert.deepEqual(plain(worker.env.chrome.notifications), [{
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Not captured',
      message: "NewTabNote couldn't open your notes, so nothing was saved.",
    }]);
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

  // Each capture kept for a later start's drain, which says so (#35 slice 3)
  const UNAVAILABLE = {
    menus: ['capture-page', 'capture-selection'],
    notes: [[...KEPT], [...KEPT]],
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

/**
 * The entries in the worker's journal, oldest first, or none when it has no journal
 * @param {IDBFactory} factory
 */
async function journalOf(factory) {
  const journals = await journalModules();
  if (!(await journals.journalExists(factory))) return [];
  const store = journals.createJournalDatabase({ indexedDB: factory });
  try {
    await store.open();
    return plain(await store.list());
  } finally {
    store.close();
  }
}

/** A day, in ms */
const DAY = 24 * 60 * 60 * 1000;

/** The host's local date of `at`, as the worker's kernel keys a Daily Note by it (#17 PR 3b) */
function localDate(at) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Puts a capture an earlier worker kept into `env`'s journal, as that worker wrote it
 * @param {any} env
 * @param {{opId: string, at: number, v?: number}} entry
 */
async function keptEarlier(env, { opId, at, v = 1, extra = {} }) {
  const journals = await journalModules();
  const store = journals.createJournalDatabase({ indexedDB: env.indexedDB });
  await store.open();
  await store.put(journals.journalEntry({
    command: {
      type: 'captureToDailyNote',
      commandId: opId,
      noteId: `${opId}-daily`,
      blockId: `${opId}-block`,
      capture: { type: 'bookmark', url: 'https://example.test/kept', title: 'Kept page' },
      at,
      ...extra,
    },
    v,
    noteId: `${opId}-daily`,
    surface: 'worker-internal',
    ownerSessionId: 'an-earlier-worker',
    seq: 1,
    createdAt: at,
  }));
  store.close();
}

describe("captures through the worker's journal (#35 slice 3)", () => {
  it("writes a capture's entry before the coordinator starts, and removes it once the capture is in", async () => {
    const opens = [];
    const worker = await loadBackground({
      start: false,
      setup: (env) => {
        const factory = env.indexedDB;
        const open = factory.open.bind(factory);
        factory.open = (name, ...rest) => {
          opens.push(name);
          return open(name, ...rest);
        };
      },
    });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    assert.equal(worker.env.chrome.notifications.at(-1).title, 'Captured to New Tab Note');
    assert.ok(opens.includes('CanvasTabDB') && opens.indexOf('NewTabNoteJournal') < opens.indexOf('CanvasTabDB'), JSON.stringify(opens));
    // One connection to the journal, which the drain after the start shares
    assert.equal(opens.filter((name) => name === 'NewTabNoteJournal').length, 1);
    assert.deepEqual(await journalOf(worker.indexedDB), []);
  });

  it('adds a capture an earlier worker kept to the Daily Note of the day it was made, at the next start, with no notification', async () => {
    const at = Date.now() - 2 * DAY;
    const worker = await loadBackground({ start: false, setup: (env) => keptEarlier(env, { opId: 'c-kept', at }) });
    await worker.dispatch('runtime.onStartup');
    await worker.drain();
    const dump = await dumpDatabase(worker.indexedDB);
    const daily = Object.values(recordsOf(dump, 'canvases')).find((record) => record.isDaily);
    assert.ok(daily, 'a Daily Note');
    assert.deepEqual([daily.id, daily.dateStr], ['c-kept-daily', localDate(at)]);
    assert.deepEqual(
      Object.values(recordsOf(dump, 'elements')).filter((element) => element.canvasId === daily.id).map((element) => [element.id, element.url]),
      [['c-kept-block', 'https://example.test/kept']],
    );
    assert.deepEqual(await journalOf(worker.indexedDB), []);
    assert.deepEqual(worker.env.chrome.notifications, []);
  });

  it('says once that a capture a newer build kept waits for an update, raises its incident, and keeps it for a build that can add it', async () => {
    const at = Date.now() - DAY;
    const worker = await loadBackground({ start: false, setup: (env) => keptEarlier(env, { opId: 'c-newer', at, v: 2 }) });
    await worker.dispatch('runtime.onStartup');
    await worker.drain();
    assert.deepEqual(plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]), [[
      'Kept for your notes',
      "Update NewTabNote to add a capture from a newer version. It's kept on this device until then.",
    ]]);
    const [entry, ...rest] = await journalOf(worker.indexedDB);
    assert.deepEqual([entry.opId, entry.unreplayable && entry.unreplayable.code, rest], ['c-newer', 'unsupported-version', []]);
    const seen = await trustOf(worker.indexedDB);
    assert.ok(seen.events.includes('journal.entry-unreplayable'), JSON.stringify(seen.events));
    assert.deepEqual(seen.incidents.filter(([providerId]) => providerId === 'coordinator'), [['coordinator', 'entry-unreplayable']]);
  });

  it("says a kept capture no build can read isn't captured, once, and keeps its text as a conflict record", async () => {
    const at = Date.now() - DAY;
    // A field its version's schema doesn't hold: malformed, whatever wrote it
    const worker = await loadBackground({
      start: false,
      setup: (env) => keptEarlier(env, { opId: 'c-malformed', at, extra: { later: true } }),
    });
    await worker.dispatch('runtime.onStartup');
    await worker.drain();
    assert.deepEqual(plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]), [[
      'Not captured',
      "NewTabNote couldn't add a kept capture to today's note.",
    ]]);
    assert.deepEqual(await journalOf(worker.indexedDB), []);
  });

  it('welcomes a hello at once while its drain waits, which no welcome holds for', async () => {
    /** @type {() => void} */
    let release = () => {};
    const worker = await loadBackground({
      start: false,
      setup: async (env) => {
        await keptEarlier(env, { opId: 'c-kept', at: Date.now() - DAY });
        // Another drain holds the replay lock, so this worker's waits
        env.global.navigator.locks.request('journal.replay', { mode: 'exclusive' }, () => new Promise((resolve) => {
          release = () => resolve(undefined);
        }));
      },
    });
    await worker.dispatch('runtime.onStartup');
    await worker.drain();
    assert.equal((await journalOf(worker.indexedDB)).length, 1, 'the drain waits');
    assert.deepEqual(await welcomeOf(worker, 'session-1'), { status: 'ready', reason: undefined });
    release();
    await worker.drain();
    assert.deepEqual(await journalOf(worker.indexedDB), []);
  });

  it('answers a page that wakes it to drain with what the drain did, and only this extension', async () => {
    const worker = await loadBackground({ start: false, setup: async (env) => {
      withUrl(env);
      await keptEarlier(env, { opId: 'c-kept', at: Date.now() - DAY });
    } });
    assert.deepEqual(await ask(worker, { type: 'journal.drain' }, { id: 'another' }), { error: 'request-refused' });
    assert.equal((await journalOf(worker.indexedDB)).length, 1, 'nothing ran for another sender');
    const answer = await ask(worker, { type: 'journal.drain' }, OWN_PAGE);
    // The drain the start set off, or the one asked for once it was in: counts and codes only
    assert.deepEqual(Object.keys(answer).sort(), ['replayed', 'status']);
    assert.ok(['drained', 'empty'].includes(answer.status), JSON.stringify(answer));
    assert.deepEqual(await journalOf(worker.indexedDB), []);
  });
});

/**
 * What a capture says that the coordinator couldn't start by its deadline: it's kept, and the
 * coordinator's drain adds it once its queue lets it (#35 slice 4a, the director's words). They
 * promise no time, since the queue may not free before the worker's next start.
 */
const KEPT_BUSY = Object.freeze([
  "Kept for today's note",
  "NewTabNote couldn't save this to your notes yet. It's kept on this device and will be added as soon as NewTabNote can.",
]);

/**
 * What a capture says whose turn the coordinator's queue cut (#35 slice 4c, the lead's words of
 * 2026-11-07 04:45:59 PST): with no journal entry, that it failed because it took too long; kept,
 * that it's added later, since only the drain after the cut adds it and no time can be named
 */
const CUT_NOT_CAPTURED = Object.freeze(['Not captured', "Saving to today's note failed: it took too long"]);
const KEPT_CUT = Object.freeze([
  "Kept for today's note",
  "NewTabNote couldn't save this to your notes yet. It's kept on this device and will be added later.",
]);

/**
 * The kernel's capture waits `ms` on the worker's fake clock before its transaction, so it holds
 * the coordinator's queue as a slow command would (#204's review, its probes)
 * @param {number} ms
 */
const slowCapture = (ms) => ({
  'js/kernel/core/application/capture.js': (source) => source.replace(
    "const { dailyNoteTemplate: templateId } = await adapter.readSettings('preferences', ['dailyNoteTemplate']);",
    `await new Promise((resolve) => setTimeout(resolve, ${ms}));\n    const { dailyNoteTemplate: templateId } = await adapter.readSettings('preferences', ['dailyNoteTemplate']);`,
  ),
});

/** A NewTabNoteJournal that can't be opened, so no capture's entry is written */
function unwritableJournal(env) {
  const factory = env.indexedDB;
  const open = factory.open.bind(factory);
  factory.open = (name, ...rest) => {
    if (name === 'NewTabNoteJournal') throw new DOMException('test: the disk is gone', 'UnknownError');
    return open(name, ...rest);
  };
}

/** The urls of the blocks in the worker's Daily Notes */
async function dailyUrls(worker) {
  const dump = await dumpDatabase(worker.indexedDB);
  const dailies = Object.values(recordsOf(dump, 'canvases')).filter((record) => record.isDaily);
  return Object.values(recordsOf(dump, 'elements'))
    .filter((element) => element.url && dailies.some((daily) => daily.id === element.canvasId))
    .map((element) => element.url);
}

/** Moves the worker's fake clock past a held capture's deadline and its end, draining at each step */
async function pastTheHold(worker) {
  for (const step of [31_000, 10_000, 40_000, 40_000]) {
    worker.env.clock.tick(step);
    await worker.drain();
  }
}

describe("captures through the worker's own client and the coordinator's queue (#35 slice 4a)", () => {
  it("waits its turn and saves a capture whose entry wasn't written, past its deadline, as 1.5.0 does: two captures behind a held queue both land and say so (#204's review, F1)", async () => {
    // No journal, so neither capture has an entry the drain could replay; the first holds the
    // queue for 40 s, past the 30 s deadline of both
    const worker = await loadBackground({ setup: (env) => unwritableJournal(env), rewrite: slowCapture(40_000) });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, { ...worker.tab, url: 'https://example.test/second' });
    await worker.drain();
    await pastTheHold(worker);
    assert.deepEqual(plain(worker.env.chrome.notifications).map((shown) => shown.title), [
      'Captured to New Tab Note',
      'Captured to New Tab Note',
    ]);
    assert.deepEqual((await dailyUrls(worker)).sort(), [worker.tab.url, 'https://example.test/second'].sort());
  });

  it("keeps a journaled capture that started and ran past its deadline, asks the drain, and adds it once, with its entry gone (#204's review, T1)", async () => {
    // The capture holds the queue for 40 s, so the worker's own client gives up on it at 31 s
    // (unknown), while it still runs; the drain's replay waits behind it on the same queue
    const worker = await loadBackground({ rewrite: slowCapture(40_000) });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    await pastTheHold(worker);
    assert.deepEqual(plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]), [[...KEPT_BUSY]]);
    assert.deepEqual(await dailyUrls(worker), [worker.tab.url], 'it lands once');
    assert.deepEqual(await journalOf(worker.indexedDB), [], 'its entry goes');
  });

  it("saves a capture over 1 MiB, as 1.5.0 does: no message limit applies to the worker's own capture (the lead's ruling for 4a)", async () => {
    const worker = await loadBackground({ start: false });
    const content = 'x'.repeat(2 * limits.MAX_MESSAGE_BYTES);
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-selection', selectionText: content }, worker.tab);
    await worker.drain();
    assert.deepEqual(plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]), [
      ['Captured to New Tab Note', 'Saved selected text'],
    ]);
    const dump = await dumpDatabase(worker.indexedDB);
    const captured = Object.values(recordsOf(dump, 'elements')).filter((element) => element.type === 'text' && String(element.content).startsWith(content));
    assert.equal(captured.length, 1);
    assert.deepEqual(await journalOf(worker.indexedDB), []);
  });

  it("keeps a capture the coordinator couldn't start by its deadline, says so without promising a time, and adds it once the queue lets it", async () => {
    // A deadline that has always passed, so the worker's own router refuses the capture at once,
    // as it would one that waited out a held queue; the drain's replay takes no deadline. The
    // worker started first and its start's drain is done, as when pages' commands hold the queue,
    // so only the drain the capture asks for adds it.
    const worker = await loadBackground({
      rewrite: {
        'js/kernel/core/contracts/limits.js': (source) => source.replace(
          'export const COMMAND_DEADLINE_MS = 30_000;',
          'export const COMMAND_DEADLINE_MS = 0;',
        ),
      },
    });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    assert.deepEqual(plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]), [[...KEPT_BUSY]]);
    const dump = await dumpDatabase(worker.indexedDB);
    const daily = Object.values(recordsOf(dump, 'canvases')).find((record) => record.isDaily);
    assert.ok(daily, 'the drain made the Daily Note');
    assert.deepEqual(
      Object.values(recordsOf(dump, 'elements')).filter((element) => element.canvasId === daily.id).map((element) => element.url),
      [worker.tab.url],
    );
    assert.deepEqual(await journalOf(worker.indexedDB), []);
  });
});

/**
 * The worker's kernel answers the first capture it's sent `reload-required`, as one whose connection
 * went before its transaction began, and keeps the type of each capture's `live` in `liveSeen` on the
 * worker's global: a `rewrite` for loadBackground
 */
const FIRST_CAPTURE_RELOADS = Object.freeze({
  'js/kernel/core/application/kernel.js': (source) => source.replace(
    '  function execute(input, options) {\n',
    [
      '  function execute(input, options) {',
      "    if (isRecord(input) && input.type === 'captureToDailyNote') {",
      '      const seen = (globalThis.liveSeen ||= []);',
      '      seen.push(typeof options?.live);',
      "      if (seen.length === 1) return Promise.resolve(unavailable('storage', 'reload-required', false));",
      '    }',
      '',
    ].join('\n'),
  ),
});

describe("a turn the coordinator's queue cuts, through the worker (#35 slice 4b-1)", () => {
  it("commits nothing of a capture whose turn was cut when it resumes after the cut, and journals the cut with its type (#224's review, T1)", async () => {
    // The kernel's capture waits 130 s before its work, so the queue cuts its turn at 120 s while it
    // still waits. The worker's client gave it the turn's live, so when it resumes at 130 s the
    // kernel commits nothing. Its entry stays for the drain, whose replay starts at the cut.
    const worker = await loadBackground({ rewrite: slowCapture(130_000) });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    for (const step of [31_000, 90_000, 10_000]) {
      worker.env.clock.tick(step);
      await worker.drain();
    }
    assert.deepEqual(await dailyUrls(worker), [], 'the cut capture committed nothing when it resumed at 130 s');
    const { fields } = await trustOf(worker.indexedDB);
    assert.deepEqual(
      fields.filter(([code]) => code === 'coordinator.turn-stuck').map(([, journaled]) => journaled.commandType),
      ['captureToDailyNote'],
      'the cut is journaled once, with its command type',
    );
  });

  it("gives the turn's live to both of a capture's attempts when the first answers reload-required (#224's review, T1)", async () => {
    const worker = await loadBackground({ rewrite: FIRST_CAPTURE_RELOADS });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    assert.deepEqual(plain(worker.env.global.liveSeen), ['function', 'function'], "the turn's live went with each attempt");
    assert.deepEqual(await dailyUrls(worker), [worker.tab.url], 'the second attempt saved it');
  });

  it("says Not captured at 240 s, because it took too long, for a capture with no entry whose rerun is cut, and its capture.failed evidence names turn-exceeded (#224's review, F1; #35 slice 4c's words)", async () => {
    // The journal can't open, so the capture has no entry, and the kernel's capture waits 130 s
    // before its work. The worker's client gives up on it at 31 s, so it runs again on the queue
    // with no client deadline, behind its own first turn. The queue cuts that turn at 120 s, the
    // rerun's turn starts then, and the queue cuts it at 240 s, so the capture answers the cut.
    // The fake clock runs what a timer starts once its tick ends, so a tick ends at the first cut.
    const worker = await loadBackground({ setup: (env) => unwritableJournal(env), rewrite: slowCapture(130_000) });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    const titles = () => plain(worker.env.chrome.notifications).map((shown) => shown.title);
    for (const step of [31_000, 89_000, 119_000]) {
      worker.env.clock.tick(step);
      await worker.drain();
    }
    assert.deepEqual(titles(), [], 'nothing is said while the rerun waits and runs');
    worker.env.clock.tick(1_000);
    await worker.drain();
    assert.deepEqual(
      plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]),
      [[...CUT_NOT_CAPTURED]],
      "the rerun's cut says Not captured, and why",
    );
    const { fields } = await trustOf(worker.indexedDB);
    const failed = fields.filter(([code]) => code === 'capture.failed').map(([, journaled]) => journaled);
    assert.equal(failed.length, 1, JSON.stringify(failed));
    const { commandId, ...evidence } = failed[0];
    assert.equal(typeof commandId, 'string');
    assert.deepEqual(
      evidence,
      { cause: 'coordinator', errorCode: 'turn-exceeded', retryable: true, surface: 'worker-internal' },
      'its evidence says the turn limit was why',
    );
  });

  it("says Kept for today's note, to be added later, for a kept capture the queue cuts at 120 s when the worker's own client couldn't be built (#35 slice 4c's words)", async () => {
    // With no client of its own, the worker runs a capture on the queue with no client deadline,
    // so the cut answers it. Its entry stays, and only the drain after the cut adds it.
    const worker = await loadBackground({
      rewrite: {
        ...slowCapture(130_000),
        'js/background.js': (source) => source.replace(
          'ownClient = createWorkerInternalClient({ router });',
          "throw new Error('test: building the worker client threw');",
        ),
      },
    });
    await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page' }, worker.tab);
    await worker.drain();
    const notices = () => plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]);
    worker.env.clock.tick(119_000);
    await worker.drain();
    assert.deepEqual(notices(), [], 'nothing is said while its turn runs');
    worker.env.clock.tick(1_000);
    await worker.drain();
    assert.deepEqual(notices(), [[...KEPT_CUT]], "the cut says it's kept, and added later");
    assert.equal((await journalOf(worker.indexedDB)).length, 1, 'its entry stays for the drain');
    // Past the 130 s the capture waits, so it ends, having committed nothing
    worker.env.clock.tick(11_000);
    await worker.drain();
    assert.deepEqual(await dailyUrls(worker), []);
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

  /** The welcome a hello on a new port gets, and what system.coordinatorHealth answers it then */
  async function healthNow(worker, sessionId) {
    const page = pagePort();
    await worker.dispatch('runtime.onConnect', page.port);
    page.hello(sessionId);
    const welcome = await waitFor(() => page.received.find((frame) => frame.frame === 'welcome'), { withinMs: 5000, message: 'the welcome' });
    page.send({
      frame: 'request',
      requestId: `${sessionId}-health`,
      operation: 'system.coordinatorHealth',
      version: 1,
      deadline: Date.now() + 10_000,
      payload: { type: 'system.coordinatorHealth' },
    });
    const answer = await waitFor(() => page.received.find((frame) => frame.frame === 'response' || frame.frame === 'error'), { withinMs: 5000, message: 'the health' });
    assert.equal(answer.frame, 'response', JSON.stringify(answer));
    const { reason, migration } = answer.result.data;
    return { welcome: [welcome.status, welcome.reason], health: [reason, migration] };
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

      // A capture meanwhile answers at once: it's kept until the upgrade is in (#35 slice 3)
      await worker.dispatch('commands.onCommand', 'capture-page');
      await waitFor(() => worker.env.chrome.notifications.length === 1, { withinMs: 10_000, message: 'the capture notification' });
      assert.deepEqual(plain(worker.env.chrome.notifications).map((shown) => [shown.title, shown.message]), [[...KEPT_BLOCKED]]);
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
      // The drain added the capture kept while it was blocked, with no word more
      const kept = Object.values(recordsOf(await dumpDatabase(worker.indexedDB), 'canvases')).filter((record) => record.isDaily);
      assert.equal(kept.length, 1);
      assert.deepEqual(await journalOf(worker.indexedDB), []);
      assert.equal(worker.env.chrome.notifications.length, 1);
      await worker.dispatch('commands.onCommand', 'capture-page');
      await worker.drain();
      assert.equal(worker.env.chrome.notifications.at(-1).title, 'Captured to New Tab Note');
    } finally {
      if (blocker) blocker.close();
    }
  });

  it('makes system.coordinatorHealth say blocked while it stays, then running once it closes, until the worker is ready (#35 slice 2)', async () => {
    /** @type {IDBDatabase | null} */
    let blocker = null;
    const seen = { marked: false, recording: false };
    /** @type {() => void} */
    let record = () => {};
    const recorded = new Promise((resolve) => {
      record = () => resolve(undefined);
    });
    const worker = await loadBackground({
      start: false,
      opens: false,
      setup: async (env) => {
        await createDatabase(env.indexedDB, { records: { canvases: [note('n1')] } });
        // 1.4.1's new tab holds its connection and never closes it on versionchange
        blocker = await requestToPromise(env.indexedDB.open('CanvasTabDB'));
        const local = env.chrome.api.storage.local;
        const set = local.set.bind(local);
        local.set = (items, ...rest) => {
          // The worker marks the upgrade blocked as its run hears the page hold it
          if (items && items.storageUpgradeBlocked) seen.marked = true;
          // It records the run's outcome once the run ends, and that waits for the test here,
          // so the attempt isn't in
          if (items && Object.hasOwn(items, 'setting_storageUpgrade')) {
            seen.recording = true;
            return recorded.then(() => set(items, ...rest));
          }
          return set(items, ...rest);
        };
      },
    });
    try {
      await worker.dispatch('runtime.onStartup');
      await waitFor(() => seen.marked, { withinMs: 10_000, message: "the run's upgrade to be blocked" });
      assert.deepEqual(await healthNow(worker, 'blocked'), { welcome: ['degraded', 'migrating'], health: ['migrating', 'blocked'] });

      // The page closes: the upgrade goes on, no longer blocked, until the attempt is in
      blocker.close();
      blocker = null;
      await waitFor(() => seen.recording, { withinMs: 10_000, message: "the run's record" });
      assert.deepEqual(await healthNow(worker, 'running'), { welcome: ['degraded', 'migrating'], health: ['migrating', 'running'] });

      record();
      assert.deepEqual(await welcomeOnce(worker, 'ready'), { status: 'ready', reason: undefined });
      assert.deepEqual(await healthNow(worker, 'ready'), { welcome: ['ready', undefined], health: [undefined, null] });
    } finally {
      record();
      if (blocker) blocker.close();
    }
  });
});

/** Popup's quick note, as its client sends it over the port */
const QUICK_NOTE = Object.freeze({
  type: 'createNote',
  commandId: 'c-quick',
  noteId: 'n-quick',
  name: 'Quick',
  blocks: [{ id: 'b-quick', type: 'text', content: 'A quick note' }],
});

/** A request frame for `payload` on `page`'s port, by its type */
function requestOn(page, requestId, payload) {
  page.send({ frame: 'request', requestId, operation: payload.type, version: 1, deadline: Date.now() + 10_000, payload });
}

/**
 * Puts a quick note Popup journaled into `env`'s journal, as its journal writes one before it sends
 * the command, under the session its hello names
 * @param {any} env
 * @param {{sessionId: string}} options
 */
async function journaledByPopup(env, { sessionId }) {
  const journals = await journalModules();
  const store = journals.createJournalDatabase({ indexedDB: env.indexedDB });
  await store.open();
  await store.put(journals.journalEntry({
    command: { ...QUICK_NOTE },
    v: 1,
    noteId: QUICK_NOTE.noteId,
    surface: 'popup',
    ownerSessionId: sessionId,
    seq: 1,
    createdAt: Date.now(),
  }));
  store.close();
}

/** Whether `worker`'s CanvasTabDB holds the note `id` */
async function holdsNote(worker, id) {
  return Object.values(recordsOf(await dumpDatabase(worker.indexedDB), 'canvases')).some((record) => record.id === id);
}

describe("Popup's commands over the port, in the worker (#35 slice 4b-2)", () => {
  it("commits Popup's quick note in the worker: its createNote over the port answers committed, and the note is in CanvasTabDB (#35 slice 4b-2, rule 5)", async () => {
    const worker = await loadBackground();
    const page = pagePort('popup');
    await worker.dispatch('runtime.onConnect', page.port);
    page.hello('popup-quick');
    requestOn(page, 'q1', QUICK_NOTE);
    await worker.drain();
    const answer = page.received.find((frame) => frame.requestId === 'q1');
    assert.deepEqual(answer && [answer.frame, answer.result && answer.result.kind], ['response', 'committed'], JSON.stringify(answer));
    assert.equal(await holdsNote(worker, 'n-quick'), true);
  });

  it("drains a Popup port's session once the port closes and the page's owner lock goes: a quick note it journaled lands then, not at the next start (#35 slice 4b-2, rule 7)", async () => {
    /** @type {() => void} */
    let goes = () => {};
    const lives = new Promise((resolve) => {
      goes = () => resolve(undefined);
    });
    const worker = await loadBackground({ start: false, setup: async (env) => {
      await journaledByPopup(env, { sessionId: 'popup-closing' });
      // The open Popup holds its owner lock for as long as it lives
      void env.global.navigator.locks.request('journal.owner.popup-closing', { mode: 'exclusive' }, () => lives);
    } });
    const page = pagePort('popup');
    await worker.dispatch('runtime.onConnect', page.port);
    page.hello('popup-closing');
    await worker.drain();
    // The start's drain leaves it while its owner lives
    assert.equal(await holdsNote(worker, 'n-quick'), false, 'not while Popup is open');
    page.close();
    await worker.drain();
    assert.equal(await holdsNote(worker, 'n-quick'), false, 'not while its owner lock is held');
    goes();
    await worker.drain();
    assert.equal(await holdsNote(worker, 'n-quick'), true, 'once its owner lock goes');
    assert.deepEqual(await journalOf(worker.indexedDB), []);
  });
});

describe("Side Panel's command over the port, in the worker (#35 slice 4c)", () => {
  it("commits Side Panel's apply of a closing tab's edit on its own kernel, and refuses its createNote at the router, as the catalog has it (#35 slice 4c, G4)", async () => {
    const at = 1700000000000;
    const worker = await loadBackground({
      setup: (env) => createDatabase(env.indexedDB, { records: { canvases: [note('n-side', { name: 'Side', updatedAt: at })] } }),
    });
    const page = pagePort('sidepanel');
    await worker.dispatch('runtime.onConnect', page.port);
    page.hello('sidepanel-apply');
    // Its client sends once welcomed, which waits for the worker's run on the 1.4.x profile
    await worker.drain();
    assert.ok(page.received.some((frame) => frame.frame === 'welcome'), JSON.stringify(page.received));
    // A closing tab's edit with no block digests, as 1.4.3 left one, on Side's updatedAt
    const content = 'side, edited as its tab closed';
    requestOn(page, 'a1', {
      type: 'applyCloseDraft',
      commandId: 'draft-side-apply',
      draft: {
        v: 1, id: 'draft-side', page: 'page-1', noteId: 'n-side', at: at + 5,
        base: { updatedAt: at, issued: [], name: 'Side' },
        blocks: [{ id: 'b-side', canvasId: 'n-side', type: 'text', content, order: 0 }],
        deletedBlockIds: [], preview: content, todoProgress: null, linkedNames: [],
      },
    });
    requestOn(page, 'q1', { ...QUICK_NOTE, commandId: 'c-side-quick', noteId: 'n-side-quick' });
    await worker.drain();
    const answer = (requestId) => page.received.find((frame) => frame.requestId === requestId) || {};
    const applied = answer('a1');
    assert.deepEqual([applied.frame, applied.result && applied.result.kind, applied.result && applied.result.code], ['response', 'committed', 'close-draft-saved'], JSON.stringify(applied));
    const made = answer('q1');
    assert.deepEqual([made.frame, made.code], ['error', 'forbidden-for-surface'], JSON.stringify(made));
    assert.equal(await holdsNote(worker, 'n-side-quick'), false);
    const elements = Object.values(recordsOf(await dumpDatabase(worker.indexedDB), 'elements'));
    assert.deepEqual(elements.filter((element) => element.id === 'b-side').map((element) => element.content), [content]);
  });
});
