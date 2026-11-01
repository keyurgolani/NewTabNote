'use strict';

// #21 slice 1b, PR 2: the network guard (js/kernel/composition/network-guard.js). Loaded first in
// every page, the service worker, and the indexer, it wraps fetch, XHR, WebSocket, EventSource,
// and sendBeacon: a request reaches a registry row, this extension's own origin, blob:, or data:,
// and anything else is refused exactly as an offline failure looks to its caller. A request with
// a credential or a body follows no redirect, and what it sends is the request the guard checked.
// Refusals are counted, and reported first and then at most once an hour per kind.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** @type {any} */
let guard;
/** @type {any} */
let install;
/** @type {any} */
let refusals;
/** @type {any} */
let client;
before(async () => {
  guard = await import('../js/kernel/composition/network-guard.js');
  install = await import('../js/kernel/composition/network-guard-install.js');
  refusals = await import('../js/kernel/composition/network-refusals.js');
  client = await import('../js/kernel/composition/destinations.js');
});

const OWN = 'chrome-extension://test-extension';
/** Until the stand-ins' events, which fire as a task as a network failure's do, have fired */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A stand-in XMLHttpRequest whose send records what it would have sent */
function fakeXhr(sent) {
  return class FakeXhr extends EventTarget {
    get withCredentials() {
      return Boolean(this.cookies);
    }
    set withCredentials(value) {
      this.cookies = value;
    }
    open(method, url) {
      this.opened = { method, url, headers: {} };
    }
    setRequestHeader(name, value) {
      this.opened.headers[name] = value;
    }
    send(body) {
      sent.push({ api: 'xhr', ...this.opened, body });
    }
  };
}

/** A context to guard: Node's fetch types, and stand-ins that record what would have gone out */
function context({ chrome = { runtime: { id: 'test-extension' } }, location = `${OWN}/newtab.html` } = {}) {
  /** @type {any[]} */
  const sent = [];
  const scope = {
    location: new URL(location),
    chrome,
    Request,
    Headers,
    Response,
    URL,
    EventTarget,
    Event,
    // As a page's: called on anything but its own global, it throws
    setTimeout(fn, ms) {
      if (this !== scope) throw new TypeError('Illegal invocation');
      return setTimeout(fn, ms);
    },
    fetch: async (input, init) => {
      sent.push({ api: 'fetch', input, init });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    XMLHttpRequest: fakeXhr(sent),
    WebSocket: class FakeSocket { static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3; constructor(url) { sent.push({ api: 'websocket', url }); } },
    EventSource: class FakeSource { static CONNECTING = 0; static OPEN = 1; static CLOSED = 2; constructor(url) { sent.push({ api: 'eventsource', url }); } },
    navigator: { sendBeacon: (url) => { sent.push({ api: 'beacon', url }); return true; } },
  };
  return { scope, sent };
}

/** Install the guard on a fresh context, with its reports recorded */
function guarded(options = {}, contextOptions = {}) {
  const { scope, sent } = context(contextOptions);
  /** @type {any[]} */
  const reports = [];
  const handle = guard.installGuard(scope, { surface: 'newtab', loopback: () => null, ...options });
  handle.onRefused((report) => reports.push(report));
  return { scope, sent, reports, handle };
}

describe('the network guard (js/kernel/composition/network-guard.js)', () => {
  it('installs once, marks the APIs it wraps, and leaves on the context a mark with its surface only: the handle is the installer\'s', () => {
    const { scope, handle } = guarded();
    assert.equal(scope.fetch[guard.GUARD], true);
    assert.equal(scope.XMLHttpRequest.prototype.send[guard.GUARD], true);
    assert.equal(scope.navigator.sendBeacon[guard.GUARD], true);
    assert.equal(guard.installGuard(scope, { surface: 'newtab' }), null);
    assert.deepEqual({ ...scope[guard.GUARD] }, { surface: 'newtab' });
    assert.equal(typeof handle.onRefused, 'function');
    assert.throws(() => { scope[guard.GUARD] = null; });
  });

  it('keeps its one listener: a second one changes nothing', async () => {
    const { scope, reports, handle } = guarded();
    const other = [];
    handle.onRefused((report) => other.push(report));
    await scope.fetch('https://example.test/x').catch(() => {});
    assert.equal(reports.length, 1);
    assert.deepEqual(other, []);
  });

  it("lets a registry row, this extension's own origin, blob:, and data: through", async () => {
    const { scope, sent } = guarded();
    assert.equal((await scope.fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer test' } })).status, 200);
    await scope.fetch(`${OWN}/build-info.json`);
    await scope.fetch('build-info.json');
    await scope.fetch('data:application/json,{}');
    assert.equal(sent.length, 4);
  });

  it('refuses any other origin as an offline fetch fails: a TypeError, and nothing goes', async () => {
    const { scope, sent } = guarded();
    for (const url of ['https://example.test/x', 'https://api.openai.com/v2/models', 'http://localhost:11434/api/tags', 'ftp://example.test/x']) {
      await assert.rejects(scope.fetch(url), TypeError, url);
    }
    await assert.rejects(scope.fetch(new Request('https://example.test/x')), TypeError);
    assert.deepEqual(sent, []);
  });

  it("takes loopback only at the Ollama URL's own origin, or at any loopback port where it's told any", async () => {
    let origin = 'http://localhost:8080';
    const { scope, sent } = guarded({ loopback: () => origin });
    await scope.fetch('http://localhost:8080/api/tags');
    await assert.rejects(scope.fetch('http://localhost:11434/api/tags'), TypeError);
    origin = null;
    await assert.rejects(scope.fetch('http://localhost:8080/api/tags'), TypeError);
    const any = guarded({ loopback: () => guard.ANY_LOOPBACK });
    await any.scope.fetch('http://127.0.0.1:9000/api/chat', { method: 'POST', body: '{}' });
    await assert.rejects(any.scope.fetch('http://192.168.1.5:9000/api/chat'), TypeError);
    assert.equal(sent.length + any.sent.length, 2);
  });

  it('a request with a credential or a body follows no redirect, and an uncredentialed GET follows as before', async () => {
    const { scope, sent } = guarded({ loopback: () => 'http://localhost:11434' });
    await scope.fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer test' } });
    await scope.fetch('http://localhost:11434/api/chat', { method: 'POST', body: '{}', redirect: 'follow' });
    await scope.fetch('https://huggingface.co/Xenova/model/resolve/main/config.json');
    await scope.fetch(new Request('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer test' } }));
    assert.deepEqual(sent.map(({ input }) => input.redirect), ['error', 'error', 'follow', 'error']);
    assert.deepEqual([...sent[3].input.headers], [['authorization', 'Bearer test']]);
  });

  it('follows the body that goes, and cookies count as a credential', async () => {
    const { scope, sent } = guarded({ loopback: () => 'http://localhost:11434' });
    // A Request with a body, its options naming none
    await scope.fetch(new Request('http://localhost:11434/api/chat', { method: 'POST', body: '{}' }), { body: null });
    await scope.fetch('https://huggingface.co/x', { credentials: 'include' });
    assert.deepEqual(sent.map(({ input }) => input.redirect), ['error', 'error']);
    const xhr = new scope.XMLHttpRequest();
    xhr.withCredentials = true;
    xhr.open('GET', 'https://huggingface.co/x');
    xhr.send();
    await settle();
    assert.equal(sent.length, 2, 'an XHR with cookies follows every redirect, so it is refused');
  });

  it('sends what it checked: the URL it converted once, as the platform\'s Request holds it', async () => {
    const { scope, sent } = guarded();
    let reads = 0;
    const shifting = { toString() { reads += 1; return reads === 1 ? 'https://huggingface.co/x' : 'https://example.test/x'; } };
    await scope.fetch(shifting);
    assert.equal(sent.at(-1).input.url, 'https://huggingface.co/x');
    // A Request whose own properties say another URL than the one it holds
    class Other extends Request {
      get url() { return 'https://huggingface.co/x'; }
    }
    await assert.rejects(scope.fetch(new Other('https://example.test/x')), TypeError);
    // The other APIs get the string it checked
    for (const send of [
      (url) => { const xhr = new scope.XMLHttpRequest(); xhr.open('GET', url); xhr.send(); },
    ]) {
      reads = 0;
      send(shifting);
    }
    // A beacon is a POST, which no uncredentialed row takes: its own origin, then
    let beacons = 0;
    assert.equal(scope.navigator.sendBeacon({ toString() { beacons += 1; return beacons === 1 ? `${OWN}/beacon` : 'https://example.test/x'; } }), true);
    await settle();
    assert.deepEqual(sent.slice(1).map(({ api, url }) => [api, url]), [['xhr', 'https://huggingface.co/x'], ['beacon', `${OWN}/beacon`]]);
  });

  it("takes a stored server on a host another remote row takes as no stored server", async () => {
    const { scope, sent } = guarded({ stored: () => 'https://api.openai.com' });
    await assert.rejects(scope.fetch('https://api.openai.com/v1/models', { method: 'PUT', headers: { Authorization: 'Basic dGVzdDp0ZXN0' }, body: '{}' }), TypeError);
    await assert.rejects(scope.fetch('https://api.openai.com/newtabnote-sync.json', { method: 'OPTIONS', headers: { Authorization: 'Basic dGVzdDp0ZXN0' } }), TypeError);
    assert.deepEqual(sent, []);
    const loopback = guarded({ stored: () => 'http://localhost:8080' });
    await loopback.scope.fetch('http://localhost:8080/newtabnote-sync.json', { method: 'OPTIONS', headers: { Authorization: 'Basic dGVzdDp0ZXN0' } });
    assert.equal(loopback.sent.length, 1, 'a loopback row is no remote row');
  });

  it('gives a WebSocket and an EventSource the URL it converted once', async () => {
    const { scope, sent } = guarded();
    let reads = 0;
    const shifting = (first) => ({ toString() { reads += 1; return reads === 1 ? first : 'https://example.test/x'; } });
    // The Hub's GET goes, as an EventSource with no credential
    new scope.EventSource(shifting('https://huggingface.co/events'));
    reads = 0;
    const socket = new scope.WebSocket(shifting('wss://unregistered.example.test/socket'));
    await settle();
    assert.deepEqual(sent.map(({ api, url }) => [api, url]), [['eventsource', 'https://huggingface.co/events']]);
    assert.equal(socket.url, 'wss://unregistered.example.test/socket');
  });

  it("resolves a relative URL against the document's base URL, and keeps the platform's URL and Request from install", async () => {
    const { scope, sent } = context();
    scope.document = { baseURI: `${OWN}/pages/` };
    guard.installGuard(scope, { surface: 'newtab' });
    await scope.fetch('notes.json');
    assert.equal(sent[0].input.url, `${OWN}/pages/notes.json`);
    // Replaced after install, they change nothing
    scope.URL = class { constructor() { this.protocol = 'chrome-extension:'; this.host = 'test-extension'; this.href = `${OWN}/x`; } };
    scope.Request = class extends Request { get url() { return `${OWN}/x`; } };
    await assert.rejects(scope.fetch('https://example.test/x'), TypeError);
    assert.equal(sent.length, 1);
  });

  it('refuses an XHR send with no open it saw', async () => {
    const { scope, sent, reports } = guarded();
    const xhr = new scope.XMLHttpRequest();
    const events = [];
    xhr.addEventListener('error', () => events.push('error'));
    xhr.send();
    await settle();
    assert.deepEqual(events, ['error']);
    assert.deepEqual(sent, []);
    assert.equal(reports.length, 1);
  });

  it("reaches the stored WebDAV server's origin only, with its four methods and Basic auth, remote or on loopback", async () => {
    let server = 'https://dav.example.test';
    const { scope, sent } = guarded({ stored: () => server });
    const auth = { Authorization: 'Basic dGVzdDp0ZXN0' };
    for (const [method, extra] of [['OPTIONS', {}], ['PUT', { headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' }], ['GET', {}], ['HEAD', {}]]) {
      await scope.fetch(`${server}/newtabnote-sync.json`, { method, headers: auth, ...extra });
    }
    assert.deepEqual(sent.map(({ input }) => [input.method, input.redirect]), [['OPTIONS', 'error'], ['PUT', 'error'], ['GET', 'error'], ['HEAD', 'error']]);
    for (const [url, init] of [
      ['https://other.example.test/newtabnote-sync.json', { headers: auth }],
      [`${server}/newtabnote-sync.json`, { method: 'DELETE', headers: auth }],
      [`${server}/newtabnote-sync.json`, { headers: { 'X-Other': '1' } }],
      ['http://dav.example.test/newtabnote-sync.json', { headers: auth }],
    ]) {
      await assert.rejects(scope.fetch(url, init), TypeError, url);
    }
    server = 'http://localhost:8080';
    await scope.fetch('http://localhost:8080/newtabnote-sync.json', { method: 'PUT', headers: auth, body: '{}' });
    server = null;
    await assert.rejects(scope.fetch('http://localhost:8080/newtabnote-sync.json', { headers: auth }), TypeError);
    assert.equal(sent.length, 5);
  });

  it("refuses a header the row doesn't take, and a credential in the query", async () => {
    const { scope, sent } = guarded();
    await assert.rejects(scope.fetch('https://api.openai.com/v1/models', { headers: { 'X-Other': '1' } }), TypeError);
    await assert.rejects(scope.fetch('https://huggingface.co/x', { headers: { Authorization: 'Bearer test' } }), TypeError);
    await assert.rejects(scope.fetch('https://api.openai.com/v1/models?api_key=test'), TypeError);
    assert.deepEqual(sent, []);
  });

  it('reads headers the way fetch does, and sends exactly the headers it checked', async () => {
    const { scope, sent } = guarded();
    const forms = [
      new Headers({ Authorization: 'Bearer test' }),
      [['Authorization', 'Bearer test']],
      new Set([['Authorization', 'Bearer test']]),
      (function* pairs() { yield ['Authorization', 'Bearer test']; })(),
      { Authorization: 'Bearer test' },
    ];
    for (const headers of forms) {
      await scope.fetch('https://api.openai.com/v1/models', { headers });
    }
    assert.equal(sent.length, forms.length);
    for (const { input } of sent) assert.deepEqual([...input.headers], [['authorization', 'Bearer test']]);
    // Headers that answer differently each time they're read are read once, and that is what goes
    let reads = 0;
    const shifting = { *[Symbol.iterator]() { reads += 1; yield ['Authorization', 'Bearer test']; if (reads > 1) yield ['X-Other', '1']; } };
    await scope.fetch('https://api.openai.com/v1/models', { headers: shifting });
    assert.equal(reads, 1);
    assert.deepEqual([...sent.at(-1).input.headers], [['authorization', 'Bearer test']]);
    // So are options that do
    let methods = 0;
    const options = { get method() { methods += 1; return methods > 1 ? 'DELETE' : 'GET'; }, headers: { Authorization: 'Bearer test' } };
    await scope.fetch('https://api.openai.com/v1/models', options);
    assert.equal(methods, 1);
    assert.equal(sent.at(-1).input.method, 'GET');
    // Headers fetch would refuse are refused
    await assert.rejects(scope.fetch('https://api.openai.com/v1/models', { headers: [['Authorization']] }), TypeError);
    assert.equal(sent.length, forms.length + 2);
  });

  it('refuses an XHR as an offline one fails: an error event, and nothing sent', async () => {
    const { scope, sent } = guarded();
    const refused = new scope.XMLHttpRequest();
    const events = [];
    refused.addEventListener('error', () => events.push('error'));
    refused.addEventListener('loadend', () => events.push('loadend'));
    refused.open('GET', 'https://example.test/x');
    refused.send();
    await settle();
    assert.deepEqual(events, ['error', 'loadend']);
    const allowed = new scope.XMLHttpRequest();
    allowed.open('GET', 'https://huggingface.co/x');
    allowed.send();
    // An XHR follows every redirect, so one with a credential or a body is refused
    const credentialed = new scope.XMLHttpRequest();
    credentialed.open('POST', 'https://api.openai.com/v1/chat/completions');
    credentialed.setRequestHeader('Authorization', 'Bearer test');
    credentialed.send('{}');
    await settle();
    assert.deepEqual(sent.map(({ api, url }) => [api, url]), [['xhr', 'https://huggingface.co/x']]);
  });

  it('refuses a WebSocket and an EventSource off the registry with an error event, and a beacon with false', async () => {
    const { scope, sent } = guarded();
    const socket = new scope.WebSocket('wss://example.test/socket');
    const source = new scope.EventSource('https://example.test/events');
    const events = [];
    socket.addEventListener('error', () => events.push('socket error'));
    socket.addEventListener('close', () => events.push('socket close'));
    source.addEventListener('error', () => events.push('source error'));
    await settle();
    assert.deepEqual(events, ['socket error', 'socket close', 'source error']);
    assert.equal(socket.readyState, 3);
    assert.equal(source.readyState, 2);
    assert.ok(socket instanceof scope.WebSocket);
    assert.ok(source instanceof scope.EventSource);
    assert.deepEqual([scope.WebSocket.CLOSED, scope.EventSource.CLOSED], [3, 2]);
    assert.equal(scope.navigator.sendBeacon('https://example.test/beacon', 'x'), false);
    assert.deepEqual(sent, []);
  });

  it('reports a kind of refusal the first time and then at most once an hour, with its count', async () => {
    let now = 1_000;
    const { scope, reports } = guarded({ now: () => now });
    for (let i = 0; i < 5; i += 1) await scope.fetch('https://example.test/x').catch(() => {});
    assert.deepEqual(reports, [{ surface: 'newtab', errorCode: 'destination-refused', count: 1 }]);
    now += guard.REFUSAL_REPORT_MS;
    await scope.fetch('https://example.test/x').catch(() => {});
    assert.deepEqual(reports.at(-1), { surface: 'newtab', errorCode: 'destination-refused', count: 6 });
    assert.equal(reports.length, 2);
  });

  it("keeps the refusals it saw before anything listened, and hands them to the first listener", async () => {
    const { scope } = context();
    const handle = guard.installGuard(scope, { surface: 'popup', loopback: () => null });
    await scope.fetch('https://example.test/x').catch(() => {});
    const reports = [];
    handle.onRefused((report) => reports.push(report));
    assert.deepEqual(reports, [{ surface: 'popup', errorCode: 'destination-refused', count: 1 }]);
  });

  it('with a registry it cannot read, refuses every destination, says so once at install, and still lets its own origin through', async () => {
    const { scope, sent } = context();
    const handle = guard.installGuard(scope, { surface: 'newtab', rows: [{ origin: 'not an origin' }] });
    const reports = [];
    handle.onRefused((report) => reports.push(report));
    assert.equal(scope.fetch[guard.GUARD], true);
    assert.equal(scope.XMLHttpRequest.prototype.send[guard.GUARD], true);
    await assert.rejects(scope.fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer test' } }), TypeError);
    await assert.rejects(scope.fetch('https://huggingface.co/x'), TypeError);
    await scope.fetch(`${OWN}/build-info.json`);
    assert.equal(sent.length, 1);
    assert.deepEqual(reports, [{ surface: 'newtab', errorCode: 'registry-unreadable', count: 0 }]);
  });

  it('refuses every destination once told to, as the worker tells it when the client finds a problem with the registry, and says so once', async () => {
    const { scope, sent, reports, handle } = guarded();
    await scope.fetch('https://huggingface.co/x');
    handle.refuseAll();
    handle.refuseAll();
    await assert.rejects(scope.fetch('https://huggingface.co/x'), TypeError);
    assert.equal(scope.navigator.sendBeacon(`${OWN}/beacon`, 'x'), true, "its own origin still goes");
    assert.equal(sent.length, 2);
    assert.deepEqual(reports, [{ surface: 'newtab', errorCode: 'registry-unreadable', count: 0 }]);
  });

  it('reads rows cut to what it checks, and refuses every destination when one is not the shape a row has', async () => {
    const { guardRows } = await import('../js/kernel/composition/destination-match.js');
    const rows = JSON.parse(read('security/destinations.json')).destinations;
    const cut = guardRows(rows);
    assert.equal(cut.length, rows.filter((row) => row.reachedBy === 'fetch').length);
    assert.deepEqual(Object.keys(cut[0]).sort(), ['credential', 'headers', 'location', 'methods', 'origin', 'pathPrefix']);
    assert.deepEqual(guardRows(cut), cut, 'cutting again changes nothing');
    // As the build inlines them, a field at its usual value left out, and read back the same
    const { compactRows } = await import('../js/kernel/composition/destination-match.js');
    const compact = compactRows(cut);
    assert.deepEqual(compact.compact[0], { origin: 'https://api.openai.com', pathPrefix: '/v1/' });
    assert.ok(JSON.stringify(compact).length < JSON.stringify(cut).length * 0.6);
    assert.deepEqual(guardRows(compact), cut);
    // Only the build's compact rows are read with the usual values: a full row missing one is refused
    const { methods, ...noMethods } = cut[0];
    const { headers, ...noHeaders } = cut[0];
    assert.ok(methods && headers);
    assert.equal(guardRows([noMethods]), null);
    assert.equal(guardRows([noHeaders]), null);
    assert.deepEqual(guardRows({ compact: [noMethods] })[0].methods, ['GET', 'POST']);
    const full = guarded({ rows: [noMethods, ...cut.slice(1)] });
    await assert.rejects(full.scope.fetch('https://huggingface.co/x'), TypeError);
    assert.deepEqual(full.reports, [{ surface: 'newtab', errorCode: 'registry-unreadable', count: 0 }, { surface: 'newtab', errorCode: 'registry-unreadable', count: 1 }].slice(0, 1));
    for (const bad of [null, {}, [null], [{ ...rows[0], origin: 'https://api.openai.com/v1' }], [{ ...rows[0], location: 'loopback' }], [{ ...rows[0], methods: 'GET' }], [{ ...rows[0], headers: [1] }]]) {
      assert.equal(guardRows(bad), null, JSON.stringify(bad));
    }
    const { scope, sent } = guarded({ rows: cut });
    await scope.fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer test' } });
    await assert.rejects(scope.fetch('https://www.google.com/s2/favicons?domain=example.test'), TypeError, 'an image row is no fetch row');
    assert.equal(sent.length, 1);
  });

  it("refuses a registry with a problem, or one it can't read, as it loads, without throwing", () => {
    const rows = JSON.parse(read('security/destinations.json')).destinations;
    assert.deepEqual(client.loadRegistry(rows).problems, []);
    assert.equal(client.loadRegistry(rows).destinations.length, rows.length);
    const bad = client.loadRegistry([...rows, { ...rows[0], id: 'openai-again' }]);
    assert.deepEqual(bad.destinations, []);
    assert.notDeepEqual(bad.problems, []);
    const unreadable = client.loadRegistry(new Proxy([], { get() { throw new Error('unreadable'); } }));
    assert.deepEqual(unreadable.destinations, []);
    assert.notDeepEqual(unreadable.problems, []);
    assert.deepEqual(client.REGISTRY_PROBLEMS, []);
  });
});

describe("each context's guard (js/kernel/composition/network-guard-install.js)", () => {
  /** A window that records its listeners, as the boot guard adds them */
  function bootGuardOn(window) {
    const listeners = new Map();
    window.addEventListener = (type, fn, capture) => listeners.set(`${type}${capture ? ' capture' : ''}`, fn);
    window.removeEventListener = (type, fn, capture) => {
      const key = `${type}${capture ? ' capture' : ''}`;
      if (listeners.get(key) === fn) listeners.delete(key);
    };
    return listeners;
  }

  it('never throws, so a page whose APIs it cannot wrap still runs its next script: the boot guard catches a failed start', () => {
    class Element {}
    class HTMLScriptElement extends Element {
      constructor(type) {
        super();
        this.type = type;
      }
    }
    const logged = [];
    const window = { location: new URL(`${OWN}/newtab.html`), URL, Request, Headers };
    // A fetch that can't be replaced, and an XMLHttpRequest and a navigator that throw when read
    Object.defineProperty(window, 'fetch', { value: async () => {}, writable: false, configurable: false, enumerable: true });
    Object.defineProperty(window, 'XMLHttpRequest', { get() { throw new Error('unavailable'); }, enumerable: true });
    Object.defineProperty(window, 'navigator', { get() { throw new Error('unavailable'); }, enumerable: true });
    const listeners = bootGuardOn(window);
    assert.doesNotThrow(() => install.installContextGuard(window));
    const context = vm.createContext({ window, Element, HTMLScriptElement, console: { error: (...args) => logged.push(args) } });
    vm.runInContext(read('js/entries/boot-guard.js'), context, { filename: 'js/entries/boot-guard.js' });
    listeners.get('error capture')({ type: 'error', target: new HTMLScriptElement('module') });
    assert.equal(logged.length, 1, 'the boot guard reported the failed start');
    assert.equal(logged[0][0], 'NewTabNote: the new tab did not start');
  });

  it('is the first script of every page, ahead of the boot guard and every library, and the first module of the worker and the indexer', () => {
    const { htmlTags } = require('../scripts/build/markup.js');
    for (const page of ['newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html']) {
      const tags = htmlTags(read(page)).filter((tag) => tag.name === 'script');
      assert.equal(tags[0].attributes.get('src'), 'js/network-guard.js', page);
      assert.equal(tags[0].attributes.has('vite-ignore'), true, page);
      assert.equal(tags[0].attributes.get('type'), undefined, page);
      assert.match(read(page), /<head>[\s\S]*<script vite-ignore src="js\/network-guard\.js"><\/script>[\s\S]*<\/head>/, page);
    }
    assert.match(read('js/network-guard.js'), /^import '\.\/kernel\/composition\/network-guard-first\.js';$/m);
    for (const [file, specifier] of [['js/background.js', './kernel/composition/network-guard-first.js'], ['js/workers/indexer.js', '../kernel/composition/network-guard-first.js']]) {
      const [first] = [...read(file).matchAll(/^import\s[^;]*?['"]([^'"]+)['"];?$/gm)].map(([, name]) => name);
      assert.equal(first, specifier, file);
    }
    const { CLASSIC_SCRIPTS } = require('../scripts/build/vite-config.js');
    assert.equal(CLASSIC_SCRIPTS['js/network-guard.js'], 'bundle');
  });

  it("names its surface by the page, and reads the stored Ollama URL for each loopback call where there's storage", async () => {
    assert.equal(install.surfaceOf({ location: new URL(`${OWN}/popup.html`) }), 'popup');
    assert.equal(install.surfaceOf({ location: new URL(`${OWN}/offscreen.html`) }), 'offscreen');
    assert.equal(install.surfaceOf({ location: new URL(`${OWN}/newtab.html`) }), 'newtab');
    assert.equal(install.surfaceOf({ location: new URL(`${OWN}/sidepanel.html`) }), 'sidepanel');
    assert.equal(install.surfaceOf({ location: new URL(`${OWN}/js/background.js`) }), 'worker-internal');
    assert.equal(install.surfaceOf({}), 'worker-internal');
    let stored = {};
    const storage = { local: { get: async () => stored } };
    const loopback = install.loopbackOf({ chrome: { runtime: { id: 'test-extension' }, storage } }, 'newtab');
    assert.equal(await loopback(), 'http://localhost:11434', "Ollama's default with nothing stored");
    stored = { setting_ollamaUrl: 'http://127.0.0.1:9000/' };
    assert.equal(await loopback(), 'http://127.0.0.1:9000');
    stored = { setting_ollamaUrl: 'http://192.168.1.5:9000' };
    assert.equal(await loopback(), null);
    assert.equal(install.loopbackOf({ chrome: { runtime: { id: 'x' } } }, 'offscreen')(), guard.ANY_LOOPBACK);
    // The server of the WebDAV config the sync service keeps before it connects: https anywhere, or loopback
    const dav = install.storedOf({ chrome: { storage } });
    for (const [serverUrl, origin] of [
      ['https://dav.example.test/remote.php/dav', 'https://dav.example.test'],
      ['http://localhost:8080/dav', 'http://localhost:8080'],
      ['http://dav.example.test/dav', null],
      ['https://user:secret@dav.example.test/', null],
      [undefined, null],
    ]) {
      stored = { setting_syncWebdavConfig: serverUrl === undefined ? null : { serverUrl, username: 'test', password: 'test' } };
      assert.equal(await dav(), origin, String(serverUrl));
    }
    assert.equal(install.storedOf({})(), null);
    assert.equal(install.loopbackOf({}, 'worker-internal')(), null);

    // Installed on a page, a call to a loopback host reads it then
    const { scope, sent } = context({ chrome: { runtime: { id: 'test-extension' }, storage } });
    install.installContextGuard(scope);
    stored = { setting_ollamaUrl: 'http://localhost:8080' };
    await scope.fetch('http://localhost:8080/api/tags');
    await assert.rejects(scope.fetch('http://localhost:11434/api/tags'), TypeError);
    assert.deepEqual(sent.map(({ input }) => input.url), ['http://localhost:8080/api/tags']);
  });

  it("sends a page's refusals to the service worker itself, so no later code can take them", async () => {
    const messages = [];
    const { scope } = context({ chrome: { runtime: { id: 'test-extension', sendMessage: async (message) => { messages.push(message); } } } });
    install.installContextGuard(scope);
    await scope.fetch('https://example.test/x').catch(() => {});
    assert.deepEqual(messages, [{ type: refusals.REFUSAL_MESSAGE, report: { surface: 'newtab', errorCode: 'destination-refused', count: 1 } }]);
    assert.deepEqual(Object.keys(scope[guard.GUARD]), ['surface']);
    // The worker journals only a report's own shape, with the surface of the page that sent it
    const popup = `${OWN}/popup.html`;
    assert.deepEqual(refusals.refusalFields({ surface: 'newtab', errorCode: 'headers-refused', count: 2 }, popup), { surface: 'popup', errorCode: 'headers-refused', count: 2 });
    assert.deepEqual(refusals.refusalFields({ errorCode: 'headers-refused', count: 2 }, `${OWN}/offscreen.html#x`), { surface: 'offscreen', errorCode: 'headers-refused', count: 2 });
    for (const [report, sender] of [
      [null, popup], [{}, popup], [{ errorCode: 'other', count: 1 }, popup], [{ errorCode: 'destination-refused', count: -1 }, popup], [{ errorCode: 'destination-refused', count: 1.5 }, popup],
      [{ errorCode: 'destination-refused', count: 1 }, `${OWN}/js/background.js`], [{ errorCode: 'destination-refused', count: 1 }, 'https://example.test/popup.html'], [{ errorCode: 'destination-refused', count: 1 }, undefined],
    ]) {
      assert.equal(refusals.refusalFields(report, sender), null, `${JSON.stringify(report)} ${sender}`);
    }
    const { EVENT_CODES } = await import('../js/trust/core/event-codes.js');
    const { checkEvidence } = await import('../js/trust/core/evidence.js');
    const entry = EVENT_CODES['network.request-refused'];
    assert.equal(entry.incident, undefined, 'a refusal raises no incident');
    for (const errorCode of ['destination-refused', 'headers-refused', 'redirect-refused', 'registry-unreadable']) {
      assert.equal(checkEvidence({ surface: 'newtab', errorCode, count: 1 }, entry.fields).ok, true, errorCode);
    }
  });
});

describe('the service worker, whose first module is the guard (js/background.js)', () => {
  const { IDBKeyRange } = require('fake-indexeddb');
  const { loadBackground } = require('./helpers/load-background');
  const SENDER = { id: 'test-extension', url: 'chrome-extension://test-extension/newtab.html' };

  /** The worker with Chrome's URL and Headers, its fetch recording what reached it */
  async function worker(options = {}) {
    const fetched = [];
    const started = await loadBackground({
      start: false,
      ...options,
      setup: (env) => {
        env.global.URL = URL;
        env.global.Headers = Headers;
        env.global.Request = Request;
        env.global.Response = Response;
        env.global.fetch = async (input) => {
          fetched.push(typeof input === 'string' ? input : input.url);
          return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' };
        };
        env.chrome.api.offscreen = { createDocument: async () => {} };
        env.chrome.api.runtime.getContexts = async () => [{}];
      },
    });
    await started.drain();
    const ask = async (url, init = {}) => {
      let answer;
      await started.dispatch('runtime.onMessage', { type: 'API_REQUEST', url, options: init }, SENDER, (response) => { answer = response; });
      await started.drain();
      return answer;
    };
    return { ...started, fetched, ask };
  }

  /** The codes and evidence of the events in the worker's NewTabNoteTrust */
  async function journal(factory) {
    const support = await import('./kernel/trust-support.mjs');
    const records = (await import('../js/trust/core/trust-records.js')).createTrustRecords({
      store: (await import('../js/kernel/adapters/indexeddb/trust.js')).createTrustDatabase({ indexedDB: factory, keyRange: IDBKeyRange }),
      settings: support.settingsArea(),
      clock: { now: () => Date.now() },
      ids: { next: () => crypto.randomUUID() },
    });
    await records.open();
    return (await records.events()).map((event) => [event.code, { ...event.fields }]);
  }

  it("wraps the worker's fetch before any other module runs, and lets a proxied request to a row through", async () => {
    const started = await worker();
    assert.equal(started.env.global.fetch[guard.GUARD], true);
    assert.equal(started.env.global[guard.GUARD].surface, 'worker-internal');
    assert.deepEqual(Object.keys(started.env.global[guard.GUARD]), ['surface']);
    assert.equal((await started.ask('https://api.z.ai/api/paas/v4/models', { method: 'GET' })).status, 200);
    assert.deepEqual(started.fetched, ['https://api.z.ai/api/paas/v4/models']);
  });

  it('with a registry row that has a problem, still registers every listener, refuses every proxied request, and journals why once', async () => {
    const sound = await worker();
    const broken = await worker({
      rewrite: { 'js/kernel/composition/destination-rows.js': (source) => source.replace('    "id": "openai",\n    "kind": "packaged",', '    "id": "openai",\n    "kind": "unknown",') },
    });
    assert.deepEqual(broken.listenerCounts(), sound.listenerCounts());
    assert.equal(broken.env.global.fetch[guard.GUARD], true);
    for (const url of ['https://api.z.ai/api/paas/v4/models', 'https://api.openai.com/v1/models', 'http://localhost:11434/api/tags']) {
      assert.ok((await broken.ask(url, { method: 'GET' })).error, url);
    }
    assert.deepEqual(broken.fetched, []);
    const refusals = (await journal(broken.indexedDB)).filter(([code]) => code === 'network.request-refused');
    assert.deepEqual(refusals, [['network.request-refused', { surface: 'worker-internal', errorCode: 'registry-unreadable', count: 0 }]]);
  });

  it("journals a page's refusal report from this extension, and nothing from anyone else or of another shape", async () => {
    const started = await worker();
    // Its surface is the sending page's (SENDER is the new tab), whatever the report says
    const report = { surface: 'popup', errorCode: 'destination-refused', count: 1 };
    const send = (message, sender) => started.dispatch('runtime.onMessage', message, sender, () => {});
    await send({ type: 'NETWORK_REFUSED', report }, SENDER);
    await send({ type: 'NETWORK_REFUSED', report: { ...report, surface: 'sidepanel' } }, { id: 'another', url: 'chrome-extension://another/x.html' });
    // Another extension's page with one of this one's page names: only the sender check stops it
    await send({ type: 'NETWORK_REFUSED', report }, { id: 'another', url: 'chrome-extension://another/sidepanel.html' });
    await send({ type: 'NETWORK_REFUSED', report: { ...report, errorCode: 'note text' } }, SENDER);
    await send({ type: 'NETWORK_REFUSED', report }, { id: 'test-extension', url: 'chrome-extension://test-extension/js/background.js' });
    await started.drain();
    const refusals = (await journal(started.indexedDB)).filter(([code]) => code === 'network.request-refused');
    assert.deepEqual(refusals, [['network.request-refused', { ...report, surface: 'newtab' }]]);
  });
});

describe('other realms, which the guard does not wrap and the CSP covers (PR 3)', () => {
  const { filesUnder } = require('./helpers/source-package');
  const API = '(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)';
  // The guard reaches its context's APIs through the scope it's handed
  const GUARD_FILES = ['js/kernel/composition/network-guard.js'];

  /** Each place a first-party file reaches a network API, or another realm, through anything but its own globals */
  function reaches(file, text) {
    const found = [];
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    // Its own globals, bare or through the names a page, a worker, and both call them by
    const own = ['window', 'self', 'globalThis', 'navigator', 'window.navigator', 'self.navigator', 'globalThis.navigator'];
    for (const match of code.matchAll(new RegExp(`([\\w$.\\]\\)]+)\\s*\\??\\.\\s*${API}\\b|\\[\\s*['"\`]${API}['"\`]\\s*\\]`, 'g'))) {
      const receiver = match[1];
      if (receiver && own.includes(receiver)) continue;
      found.push(`${file}: ${match[0]}`);
    }
    for (const match of code.matchAll(/\.\s*(?:contentWindow|contentDocument)\b|\bwindow\.open\s*\(|\bdocumentPictureInPicture\.window\b|\b(?:const|let|var)\s*\{[^}'"]*?\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*[,}:][^=]*=\s*(?!globalThis\b|window\b|self\b)[\w$.]+/g)) {
      found.push(`${file}: ${match[0]}`);
    }
    return found;
  }

  it("no first-party code reaches a network API through another realm: a frame's window, a window it opens, or the Picture-in-Picture window", () => {
    const files = filesUnder('js').filter((file) => /\.m?js$/.test(file) && !file.startsWith('js/lib/') && !GUARD_FILES.includes(file));
    assert.ok(files.length > 100, `${files.length} files`);
    assert.deepEqual(files.flatMap((file) => reaches(file, read(file))), []);
  });

  it('would catch a call through the Picture-in-Picture window, a frame, a window it opens, or a name read off one', () => {
    for (const text of [
      'this.pipWindow.fetch(url);',
      'documentPictureInPicture.window.fetch(url);',
      "frame.contentWindow.XMLHttpRequest;",
      "const opened = window.open('about:blank');",
      "new pip['WebSocket'](url);",
      'const { fetch } = pipWindow;',
      'pipWindow.navigator.sendBeacon(url);',
    ]) {
      assert.notDeepEqual(reaches('js/x.js', text), [], text);
    }
    for (const text of ['fetch(url);', 'window.fetch(url);', 'navigator.sendBeacon(url, data);', 'new XMLHttpRequest();', 'self.fetch(url)', 'globalThis.fetch(url)']) {
      assert.deepEqual(reaches('js/x.js', text), [], text);
    }
  });
});
