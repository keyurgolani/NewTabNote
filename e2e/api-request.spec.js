/**
 * The provider request proxy on Chromium (#21 slice 1a, js/kernel/composition/api-request.js):
 * the worker's API_REQUEST takes the stored Ollama URL on a custom localhost port through the
 * offscreen document, which is a module now, on the same policy, and refuses an origin off the
 * packaged list and a loopback port the Ollama URL doesn't name. Only the service worker reaches
 * the offscreen document, and no proxied request follows a redirect. The listeners are stand-ins
 * on 127.0.0.1 and ports the system picks, closed when each test ends. The offscreen document's
 * requests don't pass through Playwright's routes, so they have to be real listeners.
 */

const http = require('http');
const { test, expect, expectNoUncaught } = require('./harness');

const TAGS = { models: [{ name: 'fixture-model' }] };

/**
 * A stand-in on 127.0.0.1 that records each request and answers it with `answer`, TAGS as
 * JSON unless given
 */
async function standIn(answer = (request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(TAGS));
}) {
  /** @type {Array<{url: string, method: string, headers: Record<string, string | string[] | undefined>, body: string}>} */
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, method: request.method, headers: request.headers, body });
      answer(request, response);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  const origin = `http://localhost:${port}`;
  return { seen, port, origin, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Let the worker's own fetch reach `origin`, past the harness route that blocks the network */
const allow = (extension, origin) => extension.context.route(`${origin}/**`, route => route.continue());

test("API_REQUEST reaches the Ollama URL's own port through the offscreen module, and refuses the rest", async ({ extension }) => {
  const ollama = await standIn();
  try {
    const { seen } = ollama;
    const OLLAMA = ollama.origin;
    const OTHER = `http://localhost:${ollama.port + 1}`;
    await allow(extension, OLLAMA);
    const page = await extension.openSurface('popup');
    await page.evaluate(url => chrome.storage.local.set({ setting_ollamaUrl: url }), OLLAMA);
    const ask = message => page.evaluate(sent => chrome.runtime.sendMessage(sent), message);
    const askAsWorker = message => extension.worker.evaluate(sent => chrome.runtime.sendMessage(sent), message);

    // The worker sends it to the offscreen document, which answers it
    expect(await ask({ type: 'API_REQUEST', url: `${OLLAMA}/api/tags`, options: { method: 'GET' } }))
      .toEqual({ ok: true, status: 200, data: TAGS });
    // The offscreen module answers the worker on its own, so it loaded
    const offscreen = { type: 'OFFSCREEN_API_REQUEST', url: `${OLLAMA}/api/tags`, options: { method: 'GET' }, loopbackOrigin: OLLAMA };
    expect(await askAsWorker(offscreen)).toEqual({ ok: true, status: 200, data: TAGS });
    expect(seen.map(({ url, method }) => [url, method])).toEqual([['/api/tags', 'GET'], ['/api/tags', 'GET']]);
    for (const { headers } of seen) {
      expect(headers.authorization).toBeUndefined();
      expect(headers['content-type']).toBe('application/json');
    }

    // Off the list, another loopback port, userinfo, a header beyond Content-Type, and a page
    // asking the offscreen document itself: refused, and none of them is sent
    seen.length = 0;
    for (const message of [
      { type: 'API_REQUEST', url: 'https://example.test/v1/models', options: { method: 'GET' } },
      { type: 'API_REQUEST', url: `${OTHER}/api/tags`, options: { method: 'GET' } },
      { type: 'API_REQUEST', url: `http://user@localhost:${ollama.port}/api/tags`, options: { method: 'GET' } },
      { type: 'API_REQUEST', url: `${OLLAMA}/api/tags`, options: { method: 'GET', headers: { 'X-Extra': '1' } } },
      offscreen,
    ]) {
      expect(await ask(message), `${message.type} ${message.url}`).toEqual({ error: 'request-refused' });
    }
    expect(await askAsWorker({ ...offscreen, url: `${OTHER}/api/tags` })).toEqual({ error: 'request-refused' });
    expect(seen).toEqual([]);

    await expectNoUncaught(extension, page);
  } finally {
    await ollama.close();
  }
});

test('a proxied request follows no redirect, with or without a body', async ({ extension }) => {
  const elsewhere = await standIn();
  const ollama = await standIn((request, response) => {
    response.writeHead(request.method === 'POST' ? 307 : 302, { Location: `${elsewhere.origin}${request.url}`, 'Access-Control-Allow-Origin': '*' });
    response.end();
  });
  try {
    // Both reachable, so a request that followed the redirect would arrive
    await allow(extension, ollama.origin);
    await allow(extension, elsewhere.origin);
    const page = await extension.openSurface('popup');
    await page.evaluate(url => chrome.storage.local.set({ setting_ollamaUrl: url }), ollama.origin);
    const ask = message => page.evaluate(sent => chrome.runtime.sendMessage(sent), message);

    const post = await ask({ type: 'API_REQUEST', url: `${ollama.origin}/api/chat`, options: { method: 'POST', body: '{"model":"m"}' } });
    const get = await ask({ type: 'API_REQUEST', url: `${ollama.origin}/api/tags`, options: { method: 'GET' } });
    for (const answer of [post, get]) {
      expect(answer.ok).not.toBe(true);
      expect(answer.data).toBeUndefined();
    }
    expect(ollama.seen.length).toBeGreaterThan(0);
    expect(elsewhere.seen).toEqual([]);

    await expectNoUncaught(extension, page);
  } finally {
    await ollama.close();
    await elsewhere.close();
  }
});
