/**
 * The provider request proxy on Chromium (#21 slice 1a, js/kernel/composition/api-request.js):
 * the worker's API_REQUEST takes the stored Ollama URL on a custom localhost port through the
 * offscreen document, which is a module now, on the same policy, and refuses an origin off the
 * packaged list and a loopback port the Ollama URL doesn't name. Ollama is a stand-in server on
 * 127.0.0.1 and a port the system picks, closed when the test ends. The offscreen document's
 * requests don't pass through Playwright's routes, so it has to be a real listener.
 */

const http = require('http');
const { test, expect, expectNoUncaught } = require('./harness');

const TAGS = { models: [{ name: 'fixture-model' }] };

/** A stand-in Ollama on 127.0.0.1 that answers every request with TAGS and records it */
async function standInOllama() {
  /** @type {Array<{url: string, method: string, headers: Record<string, string | string[] | undefined>}>} */
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, method: request.method, headers: request.headers });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    response.end(JSON.stringify(TAGS));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  return { seen, port, close: () => new Promise(resolve => server.close(resolve)) };
}

test("API_REQUEST reaches the Ollama URL's own port through the offscreen module, and refuses the rest", async ({ extension }) => {
  const ollama = await standInOllama();
  try {
    const { seen } = ollama;
    const OLLAMA = `http://localhost:${ollama.port}`;
    const OTHER = `http://localhost:${ollama.port + 1}`;
    // The worker's own fetch goes through Playwright, whose harness route blocks the network:
    // this one lets the stand-in's port through
    await extension.context.route(`${OLLAMA}/**`, route => route.continue());
    const page = await extension.openSurface('popup');
    await page.evaluate(url => chrome.storage.local.set({ setting_ollamaUrl: url }), OLLAMA);
    const ask = message => page.evaluate(sent => chrome.runtime.sendMessage(sent), message);

    // The worker sends it to the offscreen document, which answers it
    expect(await ask({ type: 'API_REQUEST', url: `${OLLAMA}/api/tags`, options: { method: 'GET' } }))
      .toEqual({ ok: true, status: 200, data: TAGS });
    // The offscreen module answers on its own, so it loaded, and its listener took this page
    expect(await ask({ type: 'OFFSCREEN_API_REQUEST', url: `${OLLAMA}/api/tags`, options: { method: 'GET' }, loopbackOrigin: OLLAMA }))
      .toEqual({ ok: true, status: 200, data: TAGS });
    expect(seen.map(({ url, method }) => [url, method])).toEqual([['/api/tags', 'GET'], ['/api/tags', 'GET']]);
    for (const { headers } of seen) {
      expect(headers.authorization).toBeUndefined();
      expect(headers['content-type']).toBe('application/json');
    }

    // Off the list, another loopback port, userinfo, and a header beyond Content-Type: refused,
    // and none of them is sent
    seen.length = 0;
    for (const message of [
      { type: 'API_REQUEST', url: 'https://example.test/v1/models', options: { method: 'GET' } },
      { type: 'API_REQUEST', url: `${OTHER}/api/tags`, options: { method: 'GET' } },
      { type: 'API_REQUEST', url: `http://user@localhost:${ollama.port}/api/tags`, options: { method: 'GET' } },
      { type: 'API_REQUEST', url: `${OLLAMA}/api/tags`, options: { method: 'GET', headers: { 'X-Extra': '1' } } },
      { type: 'OFFSCREEN_API_REQUEST', url: `${OTHER}/api/tags`, options: { method: 'GET' }, loopbackOrigin: OLLAMA },
    ]) {
      expect(await ask(message), message.url).toEqual({ error: 'request-refused' });
    }
    expect(seen).toEqual([]);

    await expectNoUncaught(extension, page);
  } finally {
    await ollama.close();
  }
});
