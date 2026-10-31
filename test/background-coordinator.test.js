'use strict';

// #35 slice 1a, the coordinator's host in the service worker (js/background.js and
// js/kernel/composition/coordinator.js). Every chrome.* listener registers before the
// coordinator is built, so one that can't be built still leaves the menus, the commands and
// #13's port listener working. It opens storage on the first event that needs it, never at
// load. Each welcome says whether it's starting, ready, or degraded and why, and a start writes
// first-run settings only: the read-only integrity check runs after an install or an update.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { IDBKeyRange } = require('fake-indexeddb');
const { createDatabase, plain } = require('./helpers/legacy-env');
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
    /** Say hello, as #13's client does on its first send */
    hello(sessionId) {
      const frame = { frame: 'hello', protocol: { ...limits.PROTOCOL_VERSION }, extensionVersion: '1.4.1', surface, sessionId };
      for (const listener of onMessage) listener(JSON.stringify(frame));
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

/** No Storage global for the worker's kernel, so its database can't be opened at all */
function noStorage(env) {
  Object.defineProperty(env.global, 'Storage', { configurable: true, get: () => undefined, set() {} });
}

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

describe('a worker whose storage can\'t be reached', () => {
  it('keeps every listener, creates the menus, and answers a capture and a hello with why', async () => {
    const worker = await loadBackground({ start: false, opens: false, setup: noStorage });
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
    assert.deepEqual(seen.events, ['storage.open-failed', 'capture.failed']);
  });
});

describe("a worker whose coordinator can't serve", () => {
  /** After load, a Storage global that throws when it's read, so building the worker's kernel throws */
  function storageThrows(global) {
    Object.defineProperty(global, 'Storage', {
      configurable: true,
      get() {
        throw new Error('test: Storage unreachable');
      },
      set() {},
    });
  }

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

  for (const failTrust of [false, true]) {
    it(`whose kernel can't be built keeps its menus, and answers each capture and a hello as unavailable${failTrust ? ", with a journal that won't open" : ''}`, async () => {
      const opens = [];
      const worker = await loadBackground({
        start: false,
        opens: false,
        setup: (env) => recordOpens(env, opens, { failTrust }),
        mutate: storageThrows,
      });
      await worker.drain();
      assert.deepEqual(opens, [], 'nothing opens at load');
      assert.deepEqual(Object.keys(worker.listenerCounts()).sort(), Object.keys(LISTENERS).sort());
      assert.deepEqual(await useWorker(worker), UNAVAILABLE);
      assert.equal(opens.includes('CanvasTabDB'), false);
      if (!failTrust) assert.deepEqual((await trustOf(worker.indexedDB)).events, ['capture.failed', 'capture.failed']);
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
    assert.deepEqual((await trustOf(worker.indexedDB)).events, ['capture.failed', 'capture.failed']);
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
        // Chrome's URL, which the worker's request check parses with, and a fetch that answers
        env.global.URL = URL;
        env.global.fetch = async (url) => {
          fetched.push(String(url));
          return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' };
        };
      },
    });
    await worker.drain();
    let answer;
    await worker.dispatch(
      'runtime.onMessage',
      { type: 'API_REQUEST', url: 'https://api.openai.com/v1/models', options: { method: 'GET' } },
      { id: SENDER_ID, url: `chrome-extension://${SENDER_ID}/newtab.html` },
      (response) => {
        answer = response;
      },
    );
    await worker.drain();
    await worker.dispatch('action.onClicked', worker.tab);
    await worker.drain();
    assert.deepEqual(fetched, ['https://api.openai.com/v1/models']);
    assert.equal(answer && answer.status, 200);
    assert.deepEqual(opens, []);
  });
});

describe('the read-only integrity check', () => {
  /** A worker that counts its integrity checks, and the CanvasTabDB opens it makes */
  async function counting() {
    const opens = [];
    const worker = await loadBackground({ start: false, setup: (env) => countOpens(env, opens) });
    const storage = worker.env.global.Storage;
    const checks = [];
    const validate = storage.validateDatabase.bind(storage);
    storage.validateDatabase = async () => {
      checks.push('check');
      return validate();
    };
    return { worker, checks, opens };
  }

  it('leaves the start: a browser start and a capture write first-run settings and check nothing', async () => {
    const { worker, checks, opens } = await counting();
    await worker.dispatch('runtime.onStartup');
    await worker.drain();
    const started = opens.length;
    assert.ok(started > 0, 'the start opened the notes database');
    const settings = await new Promise((resolve) => worker.env.chrome.api.storage.local.get(['setting_storageInitialized'], resolve));
    assert.equal(settings.setting_storageInitialized, true, 'the start wrote first-run settings');

    await worker.dispatch('commands.onCommand', 'capture-page');
    await worker.drain();
    assert.equal(worker.env.chrome.notifications.at(-1).title, 'Captured to New Tab Note');
    assert.equal(opens.length, started, 'the capture used the start\'s open');
    assert.deepEqual(checks, []);
  });

  for (const reason of ['install', 'update']) {
    it(`runs once after an ${reason}`, async () => {
      const { worker, checks } = await counting();
      await worker.dispatch('runtime.onInstalled', { reason });
      await worker.drain();
      assert.deepEqual(checks, ['check']);
    });
  }

  it("doesn't run after Chrome itself updates", async () => {
    const { worker, checks } = await counting();
    await worker.dispatch('runtime.onInstalled', { reason: 'chrome_update' });
    await worker.drain();
    assert.deepEqual(checks, []);
  });
});
