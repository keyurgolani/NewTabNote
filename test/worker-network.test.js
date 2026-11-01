'use strict';

// #21 slice 1b, PR 3: the service worker's network (js/kernel/composition/worker-network.js),
// which the security baseline hashes in place of js/background.js. It owns the worker's one
// runtime.onMessage listener: the request proxy, the pages' refusal reports, and each handler
// js/background.js hands it, which it runs only for this extension's own senders. The worker
// installs it in one call and handles none of its messages itself.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBackground } = require('./helpers/load-background');

const ROOT = path.join(__dirname, '..');
const MODULE = 'js/kernel/composition/worker-network.js';
const OWN = { id: 'test-extension', url: 'chrome-extension://test-extension/newtab.html' };

/** @type {any} */
let network;
before(async () => {
  network = await import(`../${MODULE}`);
});

/**
 * chrome.runtime stubbed on globalThis, which the module reads itself, recording the listeners
 * added to it: `run` installs with it in place, and puts back what was there
 */
function withRuntime(run) {
  const listeners = [];
  const chrome = { runtime: { id: 'test-extension', onMessage: { addListener: (listener) => listeners.push(listener) } } };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  globalThis.chrome = chrome;
  try {
    run();
  } finally {
    if (before) Object.defineProperty(globalThis, 'chrome', before);
    else delete globalThis.chrome;
  }
  return { listeners };
}

/** What the listener answers `message` from `sender` with, and whether it kept the channel open */
function ask(listener, message, sender) {
  return new Promise((resolve) => {
    let kept;
    kept = listener(message, sender, (answer) => resolve({ answer, kept }));
    if (kept !== true) setImmediate(() => resolve({ answer: undefined, kept }));
  });
}

describe("the worker's network (js/kernel/composition/worker-network.js)", () => {
  it("listens on chrome.runtime itself, whatever runtime it's handed", async () => {
    const handed = [];
    const chrome = withRuntime(() => network.installWorkerNetwork({ runtime: { id: 'another', onMessage: { addListener: (listener) => handed.push(listener) } } }));
    assert.deepEqual([handed.length, chrome.listeners.length], [0, 1]);
  });

  it("adds the worker's one onMessage listener, and runs a handler it's given for this extension's own senders only", async () => {
    const asked = [];
    const chrome = withRuntime(() => network.installWorkerNetwork({ ownHandlers: { 'an.own.message': async (request) => (asked.push(request.value), { ok: request.value }) } }));
    assert.equal(chrome.listeners.length, 1);
    const [listener] = chrome.listeners;
    assert.deepEqual(await ask(listener, { type: 'an.own.message', value: 1 }, OWN), { answer: { ok: 1 }, kept: true });
    for (const sender of [{ id: 'another', url: 'chrome-extension://another/newtab.html' }, { id: 'test-extension', url: 'https://example.test/', tab: { id: 1 } }, { id: 'test-extension' }]) {
      assert.deepEqual((await ask(listener, { type: 'an.own.message', value: 2 }, sender)).answer, { error: 'request-refused' }, JSON.stringify(sender));
    }
    assert.deepEqual(asked, [1]);
  });

  it('answers a handler that throws or rejects with its error, and leaves a message nobody handles alone', async () => {
    const chrome = withRuntime(() => network.installWorkerNetwork({
      ownHandlers: {
        throws: () => { throw new Error('thrown'); },
        rejects: async () => { throw new Error('rejected'); },
      },
    }));
    const [listener] = chrome.listeners;
    assert.deepEqual((await ask(listener, { type: 'throws' }, OWN)).answer, { error: 'thrown' });
    assert.deepEqual((await ask(listener, { type: 'rejects' }, OWN)).answer, { error: 'rejected' });
    assert.deepEqual(await ask(listener, { type: 'nobody' }, OWN), { answer: undefined, kept: undefined });
    assert.deepEqual(await ask(listener, null, OWN), { answer: undefined, kept: undefined });
  });

  it("never lets a handler it's given take one of its own messages", async () => {
    const taken = [];
    const handlers = Object.fromEntries(network.MESSAGE_TYPES.map((type) => [type, () => { taken.push(type); return {}; }]));
    const chrome = withRuntime(() => network.installWorkerNetwork({ ownHandlers: handlers, quiet: true }));
    const [listener] = chrome.listeners;
    // From this extension's own page, so the sender check lets each through to whoever takes it
    for (const type of network.MESSAGE_TYPES) await ask(listener, { type, report: {}, url: 'https://example.test/', options: {} }, OWN);
    assert.deepEqual(taken, []);
    assert.deepEqual([...network.MESSAGE_TYPES].sort(), ['API_REQUEST', 'NETWORK_REFUSED', 'OFFSCREEN_API_REQUEST']);
  });
});

describe('js/background.js installs it, and handles none of its messages itself', () => {
  const source = fs.readFileSync(path.join(ROOT, 'js/background.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it('calls installWorkerNetwork once, and adds no onMessage listener, proxy or offscreen document of its own', () => {
    assert.equal(code.match(/\binstallWorkerNetwork\(/g)?.length, 1);
    // With the guard, the journal, and the worker's own handlers (#17 PR 1b: a page's wait on
    // the migration), and nothing else
    assert.match(
      code,
      /\binstallWorkerNetwork\(\{ guard: contextGuard, events: failureEvents, ownHandlers: \{ \[MIGRATE_MESSAGE\]: migrationStatus \} \}\);/,
    );
    assert.match(code, /import \{[^}]*\binstallWorkerNetwork\b[^}]*\} from '\.\/kernel\/composition\/worker-network\.js';/);
    for (const pattern of [/onMessage\s*\.\s*addListener/, /\bonMessage\b/, /API_REQUEST/, /NETWORK_REFUSED|REFUSAL_MESSAGE/, /createDocument/, /\bcheckRequest\b/, /\bsend\(/, /api-request\.js/, /network-refusals\.js/, /\brefuseAll\b/, /\bonRefused\b/]) {
      assert.doesNotMatch(code, pattern);
    }
  });

  it("leaves the worker with that one onMessage listener", async () => {
    const worker = await loadBackground({ start: false });
    assert.equal(worker.listenerCounts()['runtime.onMessage'], 1);
    assert.equal(worker.env.chrome.api.runtime.onMessage.listeners.length, 1);
  });
});
