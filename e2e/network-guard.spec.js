/**
 * The network guard on Chromium (#21 slice 1b, "Guard"): the first code in every context. Each
 * page's first script, js/network-guard.js, and the first module of the service worker and the
 * indexer, mark fetch, XMLHttpRequest, WebSocket, EventSource, and sendBeacon as theirs. In the
 * new tab a call through any of them to an origin no registry row takes fails as an offline one
 * does, no request is made, and the refusal is journaled once. What the registry takes still
 * goes: a library the loader puts in (transformers.js) reaching the Hub, the Hub's CDN host,
 * the runtime host, a provider's model listing, and Ollama at the stored URL's own port, where a
 * call with a body follows no redirect. Routed responses and stand-ins on 127.0.0.1 answer;
 * nothing reaches the network. A routed response is never a redirect to another host, since
 * Playwright doesn't route the request that follows one: that the guard leaves an uncredentialed
 * GET's redirect alone is test/network-guard.test.js's.
 */

const http = require('http');
const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** The guard's mark (js/kernel/composition/network-guard.js's GUARD) */
const MARK = 'ntn.networkGuard';

/** An origin no registry row takes */
const UNREGISTERED = 'https://unregistered.example.test';

/** Which of the APIs the guard wraps carry its mark in the context `target` evaluates in, and its surface */
const marks = target => target.evaluate(mark => {
  const guard = Symbol.for(mark);
  const scope = /** @type {any} */ (globalThis);
  const marked = name => (scope[name] === undefined ? 'absent' : scope[name][guard] === true);
  return {
    surface: scope[guard] ? scope[guard].surface : null,
    fetch: marked('fetch'),
    xhr: typeof XMLHttpRequest === 'function' ? XMLHttpRequest.prototype.send[guard] === true : 'absent',
    websocket: marked('WebSocket'),
    eventsource: marked('EventSource'),
    beacon: typeof navigator.sendBeacon === 'function' ? navigator.sendBeacon[guard] === true : 'absent',
  };
}, MARK);

/** Every journal record #20's trust database holds, or none when it was never made */
function journal(page) {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some(db => db.name === 'NewTabNoteTrust')) return [];
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('NewTabNoteTrust');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains('journal')) return [];
      return await new Promise((resolve, reject) => {
        const request = db.transaction('journal').objectStore('journal').getAll();
        request.onsuccess = () => resolve(request.result.map(record => ({ code: record.code, fields: record.fields })));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

/** The requests the session made to `origin`, as Chromium issued them */
function requestsTo(extension, origin) {
  const seen = [];
  extension.context.on('request', request => {
    if (request.url().startsWith(origin)) seen.push(`${request.method()} ${request.url()}`);
  });
  return seen;
}

/** A stand-in on 127.0.0.1 that records each request and answers it with `answer` */
async function standIn(answer = (request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  response.end('{"models":[]}');
}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(`${request.method} ${request.url}`);
      answer(request, response);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  return { seen, port, origin: `http://localhost:${port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('the guard is the first code in every context: each page, the offscreen document, the service worker, and the indexer', async ({ extension }) => {
  const all = { fetch: true, xhr: true, websocket: true, eventsource: true, beacon: true };
  await extension.seedOnboarded();
  const newtab = await driver.openNewTab(extension);
  expect(await marks(newtab)).toEqual({ surface: 'newtab', ...all });
  for (const surface of ['popup', 'sidepanel']) {
    const page = await extension.openSurface(surface);
    expect(await marks(page), surface).toEqual({ surface, ...all });
  }
  // The offscreen document's own entry, opened as a tab: Playwright can't reach the document itself
  const offscreen = await extension.context.newPage();
  await offscreen.goto(extension.url('offscreen.html'));
  expect(await marks(offscreen)).toEqual({ surface: 'offscreen', ...all });
  await offscreen.close();

  // A worker has no XMLHttpRequest, and a service worker no sendBeacon
  const worker = await marks(extension.worker);
  expect(worker.surface).toBe('worker-internal');
  expect(worker.fetch).toBe(true);
  for (const name of ['websocket', 'eventsource', 'beacon', 'xhr']) expect([true, 'absent'], name).toContain(worker[name]);

  await expect.poll(() => newtab.workers().length, { timeout: 15_000 }).toBeGreaterThan(0);
  const indexer = newtab.workers().find(candidate => /\/assets\/indexer-[^/]+\.js$/.test(candidate.url()));
  expect(indexer, newtab.workers().map(candidate => candidate.url()).join(', ')).toBeTruthy();
  const inIndexer = await marks(indexer);
  expect(inIndexer.surface).toBe('worker-internal');
  expect(inIndexer.fetch).toBe(true);
  expect(inIndexer.xhr).toBe(true);
  await expectNoUncaught(extension, newtab);
});

test('in the new tab, fetch, XHR, WebSocket, EventSource and sendBeacon to an unregistered origin fail as offline, make no request, and journal once', async ({ extension }) => {
  const leaked = requestsTo(extension, UNREGISTERED);
  const sockets = [];
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  page.on('websocket', socket => sockets.push(socket.url()));
  const outcomes = await page.evaluate(async base => {
    const failed = error => (error instanceof TypeError ? 'TypeError' : String(error));
    const event = (target, ok, bad) => new Promise(resolve => {
      target.addEventListener(ok, () => resolve(ok));
      target.addEventListener(bad, () => resolve(bad));
    });
    const xhr = new XMLHttpRequest();
    const xhrDone = event(xhr, 'load', 'error');
    xhr.open('GET', `${base}/xhr`);
    xhr.send();
    const socket = new WebSocket(`${base.replace('https:', 'wss:')}/socket`);
    const source = new EventSource(`${base}/events`);
    return {
      fetch: await fetch(`${base}/fetch`).then(() => 'sent', failed),
      again: await fetch(`${base}/fetch`, { method: 'POST', body: 'x' }).then(() => 'sent', failed),
      xhr: await xhrDone,
      websocket: await event(socket, 'open', 'error'),
      eventsource: await event(source, 'open', 'error'),
      beacon: navigator.sendBeacon(`${base}/beacon`, 'x'),
    };
  }, UNREGISTERED);
  expect(outcomes).toEqual({ fetch: 'TypeError', again: 'TypeError', xhr: 'error', websocket: 'error', eventsource: 'error', beacon: false });
  expect(leaked).toEqual([]);
  expect(sockets).toEqual([]);

  // One kind of refusal, so one event, the first time, with the count then
  await expect.poll(async () => (await journal(page)).filter(record => record.code === 'network.request-refused'), { timeout: 15_000 })
    .toEqual([{ code: 'network.request-refused', fields: { surface: 'newtab', errorCode: 'destination-refused', count: 1 } }]);
  await expectNoUncaught(extension, page);
});

test("what the registry takes still goes: transformers.js reaching the Hub, the Hub's CDN host, the runtime host, and a provider listing", async ({ extension }) => {
  const hub = [];
  for (const host of ['https://huggingface.co', 'https://cas-bridge.xethub.hf.co']) {
    await extension.context.route(`${host}/**`, route => {
      hub.push(route.request().url());
      return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
    });
  }
  await extension.context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ status: 200, headers: { 'Content-Type': 'application/wasm', 'Access-Control-Allow-Origin': '*' }, body: '' }));
  const listing = [];
  await extension.context.route('https://api.openai.com/v1/models', route => {
    listing.push(Boolean(route.request().headers().authorization));
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ data: [{ id: 'gpt-routed' }] }) });
  });

  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  // A library the loader puts in runs under the guard: transformers.js's fetch is the guarded one
  await page.evaluate(() => Embeddings.init());
  expect(await page.evaluate(() => typeof transformers)).toBe('object');
  expect((await marks(page)).fetch).toBe(true);
  expect(hub.some(url => url.startsWith('https://huggingface.co/Xenova/'))).toBe(true);
  expect(await page.evaluate(() => fetch('https://cas-bridge.xethub.hf.co/routed/config.json').then(response => response.status))).toBe(404);
  expect(hub.filter(url => url.startsWith('https://cas-bridge.xethub.hf.co/'))).toEqual(['https://cas-bridge.xethub.hf.co/routed/config.json']);

  expect(await page.evaluate(() => fetch('https://cdn.jsdelivr.net/npm/@xenova/transformers/dist/ort-wasm-simd.wasm').then(response => response.status))).toBe(200);
  // A made-up key, never a real one
  expect(await page.evaluate(() => LLM.fetchOpenAIModels('ntn-e2e-canary'))).toEqual([{ id: 'gpt-routed', name: 'gpt-routed' }]);
  expect(listing).toEqual([true]);
  await expectNoUncaught(extension, page);
});

test("Ollama at the stored URL's own port goes, another loopback port doesn't, and a call with a body follows no redirect", async ({ extension }) => {
  const elsewhere = await standIn();
  const ollama = await standIn((request, response) => {
    if (request.method === 'POST') {
      response.writeHead(307, { Location: `${elsewhere.origin}${request.url}`, 'Access-Control-Allow-Origin': '*' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    response.end('{"models":[]}');
  });
  try {
    for (const origin of [ollama.origin, elsewhere.origin]) await extension.context.route(`${origin}/**`, route => route.continue());
    await extension.seedOnboarded();
    const page = await driver.openNewTab(extension);
    await page.evaluate(url => chrome.storage.local.set({ setting_ollamaUrl: url }), ollama.origin);
    const outcomes = await page.evaluate(async ({ stored, other }) => {
      const failed = error => (error instanceof TypeError ? 'TypeError' : String(error));
      return {
        tags: await fetch(`${stored}/api/tags`).then(response => response.status, failed),
        other: await fetch(`${other}/api/tags`).then(response => response.status, failed),
        chat: await fetch(`${stored}/api/chat`, { method: 'POST', body: '{}' }).then(response => response.status, failed),
      };
    }, { stored: ollama.origin, other: elsewhere.origin });
    expect(outcomes).toEqual({ tags: 200, other: 'TypeError', chat: 'TypeError' });
    expect(ollama.seen).toEqual(['GET /api/tags', 'POST /api/chat']);
    expect(elsewhere.seen).toEqual([]);

    // Through the worker and the offscreen document, under their guards, as before
    expect(await page.evaluate(url => chrome.runtime.sendMessage({ type: 'API_REQUEST', url: `${url}/api/tags`, options: { method: 'GET' } }), ollama.origin))
      .toEqual({ ok: true, status: 200, data: { models: [] } });
    await expectNoUncaught(extension, page);
  } finally {
    await ollama.close();
    await elsewhere.close();
  }
});
