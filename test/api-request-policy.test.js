'use strict';

// #21 slice 1a, the proxies until #9 and #11 delete them: API_REQUEST (js/background.js) and
// OFFSCREEN_API_REQUEST (js/offscreen.js) fail closed. Each takes only this extension's own
// senders (its id, and a sender URL on its own origin), only a URL that `URL` parses to an
// origin on one packaged list (js/kernel/composition/api-request.js: the providers' endpoints,
// and the legacy model hosts for GET), or the stored Ollama URL's origin when that's
// http://localhost or http://127.0.0.1 on any port; userinfo is refused, no "contains
// localhost" rule, and the request goes with no header but Content-Type, no cookies, and
// `redirect: 'error'` when it carries a body. Everything that works in 1.4.0 keeps working:
// each provider endpoint, and Ollama on its default and on a custom port.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv } = require('./helpers/legacy-env');
const { loadBackground } = require('./helpers/load-background');
const { loadPageModule } = require('./helpers/page-module');

const ROOT = path.join(__dirname, '..');
const OWN = 'chrome-extension://test-extension';

/** @type {any} */
let policy;
before(async () => {
  policy = await import('../js/kernel/composition/api-request.js');
});

/** An answer from the extension's realm as a plain object of this one, for deepEqual */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** `promise`, or 'no answer' when it hasn't settled within `ms` */
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('no answer'), ms))]);

const page = (file = 'newtab.html') => ({ id: 'test-extension', url: `${OWN}/${file}`, origin: OWN });

describe('the packaged destinations (js/kernel/composition/api-request.js)', () => {
  it("holds every provider origin today's code reaches, and the legacy model hosts", () => {
    const llm = fs.readFileSync(path.join(ROOT, 'js/llm.js'), 'utf8');
    const origins = new Set([...llm.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/g)].map(([url]) => new URL(url).origin));
    const listed = new Set(policy.DESTINATIONS.map((row) => row.origin));
    assert.deepEqual([...origins].filter((origin) => !listed.has(origin)).sort(), []);
    const legacy = policy.DESTINATIONS.filter((row) => row.kind === 'legacy');
    assert.deepEqual(legacy.map((row) => [row.origin, row.methods.join()]).sort(), [
      ['https://cdn.jsdelivr.net', 'GET'],
      ['https://huggingface.co', 'GET'],
    ]);
    for (const row of policy.DESTINATIONS) {
      assert.equal(new URL(row.origin).origin, row.origin, `${row.origin} isn't an origin`);
      assert.equal(new URL(row.origin).protocol, 'https:');
    }
  });

  it('refuses another origin, a look-alike, userinfo, a scheme other than https, and loopback unless it is the Ollama URL', () => {
    const loopback = policy.loopbackOrigin('http://localhost:11434');
    const check = (url, options = { method: 'POST', body: '{}' }) => policy.checkRequest({ type: 'API_REQUEST', url, options }, { loopback }).ok;
    assert.equal(check('https://api.openai.com/v1/chat/completions'), true);
    for (const url of [
      'https://evil.example/v1',
      'https://api.openai.com.evil.example/v1',
      'https://evil.example/?u=https://api.openai.com',
      'https://user:pass@api.openai.com/v1',
      'https://user@api.openai.com/v1',
      'http://api.openai.com/v1',
      'http://localhost.evil.example/api/tags',
      'http://evil.example/localhost',
      'http://localhost:9999/api/tags',
      'http://127.0.0.1:11434/api/tags',
      'http://user@localhost:11434/api/tags',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'file:///etc/passwd',
      'not a url',
    ]) {
      assert.equal(check(url), false, `${url} was allowed`);
    }
    assert.equal(check('http://localhost:11434/api/chat'), true);
    // GET only on the legacy model hosts
    assert.equal(check('https://huggingface.co/Xenova/model', { method: 'GET' }), true);
    assert.equal(check('https://huggingface.co/Xenova/model', { method: 'POST', body: '{}' }), false);
  });

  it("refuses a path outside its row's prefix, and a registry row the proxy may not reach", () => {
    const check = (url, method = 'GET') => policy.checkRequest({ type: 'API_REQUEST', url, options: { method } }, { loopback: null }).ok;
    assert.equal(check('https://api.openai.com/v1/models'), true);
    assert.equal(check('https://api.groq.com/openai/v1/models'), true);
    for (const url of [
      'https://api.openai.com/v2/models',
      'https://api.openai.com/models',
      'https://api.groq.com/v1/models',
      'https://api.z.ai/api/other/v4/models',
      'https://cdn-lfs.huggingface.co/repos/x',
      'https://www.google.com/s2/favicons?domain=example.test',
      'https://www.youtube.com/embed/x',
    ]) {
      assert.equal(check(url), false, `${url} was allowed`);
    }
  });

  it('takes the Ollama URL only on loopback http, any port, without userinfo', () => {
    assert.equal(policy.loopbackOrigin('http://localhost:11434'), 'http://localhost:11434');
    assert.equal(policy.loopbackOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
    assert.equal(policy.loopbackOrigin('http://localhost'), 'http://localhost');
    for (const url of ['http://192.168.1.5:11434', 'https://localhost:11434', 'http://u:p@localhost:11434', 'http://localhost.evil.example', '', null, 7]) {
      assert.equal(policy.loopbackOrigin(url), null, `${url} was taken`);
    }
  });

  it("reads the stored Ollama URL's loopback origin per request, Ollama's default with none stored, and null when the read fails", async () => {
    const settings = (stored) => ({ get: async (keys) => (assert.deepEqual(keys, ['setting_ollamaUrl']), stored) });
    assert.equal(await policy.storedLoopbackOrigin(settings({})), 'http://localhost:11434');
    assert.equal(await policy.storedLoopbackOrigin(settings({ setting_ollamaUrl: 'http://127.0.0.1:8080' })), 'http://127.0.0.1:8080');
    assert.equal(await policy.storedLoopbackOrigin(settings({ setting_ollamaUrl: 'http://192.168.1.5:11434' })), null);
    assert.equal(await policy.storedLoopbackOrigin({ get: async () => { throw new Error('read failed'); } }), null);
  });

  it('refuses a method outside the list, a body that is not a string or is too large, and any option but method and body', () => {
    const check = (options) => policy.checkRequest({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/models', options }, { loopback: null }).ok;
    assert.equal(check({ method: 'GET' }), true);
    assert.equal(check({}), true);
    assert.equal(check({ method: 'DELETE' }), false);
    assert.equal(check({ method: 'POST', body: { a: 1 } }), false);
    assert.equal(check({ method: 'POST', body: 'x'.repeat(policy.MAX_BODY_BYTES + 1) }), false);
    assert.equal(check({ method: 'GET', headers: { Authorization: 'Bearer x' } }), false);
    assert.equal(check(null), false);
  });

  it('builds the request with Content-Type only, no cookies, and no redirect followed', () => {
    const post = policy.checkRequest({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/chat/completions', options: { method: 'POST', body: '{}' } }, { loopback: null });
    assert.deepEqual(policy.fetchInit(post), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'omit',
      redirect: 'error',
    });
    const get = policy.checkRequest({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/models', options: {} }, { loopback: null });
    assert.deepEqual(policy.fetchInit(get), { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', redirect: 'error' });
  });

  it("measures a body's size in UTF-8 bytes", () => {
    const check = (body) => policy.checkRequest({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/chat/completions', options: { method: 'POST', body } }, { loopback: null }).ok;
    assert.equal(check('x'.repeat(policy.MAX_BODY_BYTES)), true);
    // Three bytes each in UTF-8, one unit each in UTF-16
    assert.equal(check('\u20ac'.repeat(Math.floor(policy.MAX_BODY_BYTES / 3) + 1)), false);
  });

  it('refuses a GET with a body', () => {
    const check = (options) => policy.checkRequest({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/models', options }, { loopback: null }).ok;
    assert.equal(check({ method: 'GET', body: '{}' }), false);
    assert.equal(check({ body: '{}' }), false);
    assert.equal(check({ method: 'POST', body: '{}' }), true);
  });

  it('answers no loopback origin when the stored Ollama URL takes too long to read', async () => {
    assert.equal(await within(policy.storedLoopbackOrigin({ get: () => new Promise(() => {}) }, { timeoutMs: 20 }), 1000), null);
  });

  it('takes only the service worker as the sender of an offscreen request', () => {
    const workerUrl = `${OWN}/js/background.js`;
    const own = { id: 'test-extension', workerUrl };
    assert.equal(policy.isWorkerSender({ id: 'test-extension', url: workerUrl }, own), true);
    for (const sender of [
      undefined,
      page(),
      page('offscreen.html'),
      { id: 'test-extension', url: workerUrl, tab: { id: 1 } },
      { id: 'another-extension', url: 'chrome-extension://another-extension/js/background.js' },
      { id: 'test-extension', url: `${workerUrl}?x` },
    ]) {
      assert.equal(policy.isWorkerSender(sender, own), false, JSON.stringify(sender));
    }
    assert.equal(policy.isWorkerSender({ id: 'test-extension', url: workerUrl }, { id: 'test-extension', workerUrl: null }), false);
  });

  it("finds the worker's script URL in the manifest, read from the package where the runtime has no getManifest", async () => {
    const getURL = (file) => `${OWN}/${file}`;
    const manifest = { background: { service_worker: 'js/background.js' } };
    assert.equal(await policy.workerScriptUrl({ getURL, getManifest: () => manifest }), `${OWN}/js/background.js`);
    const read = [];
    const offscreenRuntime = { getURL };
    assert.equal(await policy.workerScriptUrl(offscreenRuntime, async (url) => (read.push(url), manifest)), `${OWN}/js/background.js`);
    assert.deepEqual(read, [`${OWN}/manifest.json`]);
    assert.equal(await policy.workerScriptUrl(offscreenRuntime, async () => { throw new Error('unreadable'); }), null);
    assert.equal(await policy.workerScriptUrl({ getURL, getManifest: () => ({}) }), null);
  });

  it('every file that asks the proxy for a request names only listed origins', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const file = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (file !== 'js/lib') walk(file);
        } else if (/\.m?js$/.test(entry.name)) files.push(file);
      }
    };
    walk('js');
    const proxy = new Set(['js/background.js', 'js/offscreen.js', 'js/kernel/composition/api-request.js']);
    const callers = files.filter((file) => !proxy.has(file) && /API_REQUEST|fetchViaBackground\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    assert.ok(callers.includes('js/llm.js'), callers.join());
    const listed = new Set(policy.DESTINATIONS.map((row) => row.origin));
    for (const file of callers) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const origins = new Set([...text.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/g)].map(([url]) => new URL(url).origin));
      assert.deepEqual([...origins].filter((origin) => !listed.has(origin)).sort(), [], file);
    }
  });

  it("takes only this extension's own senders", () => {
    assert.equal(policy.isOwnSender(page(), 'test-extension'), true);
    assert.equal(policy.isOwnSender({ id: 'test-extension', url: `${OWN}/js/background.js` }, 'test-extension'), true);
    for (const sender of [
      undefined,
      {},
      { id: 'another-extension', url: 'chrome-extension://another-extension/page.html' },
      { id: 'test-extension', url: 'https://evil.example/page', tab: { id: 3 } },
      { id: 'test-extension' },
      { id: 'test-extension', url: 'chrome-extension://another-extension/page.html' },
    ]) {
      assert.equal(policy.isOwnSender(sender, 'test-extension'), false, JSON.stringify(sender));
    }
  });
});

/**
 * The worker, its fetches recorded, answering each message as Chrome's onMessage does
 */
async function worker({ offscreenAnswer = async () => ({ ok: true, status: 200, data: { models: [] } }) } = {}) {
  // URL is a global in every extension context; legacy-env's sandbox leaves it out
  const started = await loadBackground({ setup: (env) => { env.global.URL = URL; } });
  const env = started.env;
  const fetches = [];
  env.global.fetch = async (url, init) => {
    fetches.push({ url: String(url), init: JSON.parse(JSON.stringify(init || {})) });
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
  };
  const offscreen = [];
  const send = env.chrome.api.runtime.sendMessage;
  env.chrome.api.runtime.sendMessage = async (message) => {
    if (message && message.type === 'OFFSCREEN_API_REQUEST') {
      offscreen.push(JSON.parse(JSON.stringify(message)));
      return offscreenAnswer(message);
    }
    return send(message);
  };
  env.chrome.api.offscreen = { createDocument: async () => {} };
  env.chrome.api.runtime.getContexts = async () => [{}];
  const ask = (message, sender) =>
    new Promise((resolve) => {
      let answered = false;
      for (const listener of env.chrome.api.runtime.onMessage.listeners) {
        const keep = listener(message, sender, (response) => {
          answered = true;
          resolve(plain(response));
        });
        if (keep === true) return;
      }
      if (!answered) setImmediate(() => resolve(undefined));
    });
  return { env, fetches, offscreen, ask };
}

describe('API_REQUEST in the worker (js/background.js)', () => {
  it("refuses another extension's or a web page's message, and fetches nothing", async () => {
    const { fetches, ask } = await worker();
    const message = { type: 'API_REQUEST', url: 'https://api.openai.com/v1/models', options: {} };
    for (const sender of [{ id: 'another-extension', url: 'chrome-extension://another-extension/a.html' }, { id: 'test-extension', url: 'https://evil.example/', tab: { id: 1 } }]) {
      const answer = await ask(message, sender);
      assert.ok(answer && answer.error, JSON.stringify(sender));
    }
    assert.deepEqual(fetches, []);
  });

  it('refuses a destination off the list, and a header it was asked to send never goes', async () => {
    const { fetches, ask } = await worker();
    assert.ok((await ask({ type: 'API_REQUEST', url: 'https://evil.example/collect', options: { method: 'POST', body: '{}' } }, page())).error);
    assert.ok((await ask({ type: 'API_REQUEST', url: 'http://localhost.evil.example/', options: {} }, page())).error);
    assert.ok((await ask({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/models', options: { headers: { Authorization: 'x' } } }, page())).error);
    assert.deepEqual(fetches, []);
  });

  it('a GET goes with no redirect followed', async () => {
    const { fetches, ask } = await worker();
    assert.equal((await ask({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/models', options: { method: 'GET' } }, page())).ok, true);
    assert.deepEqual(fetches.map(({ init }) => init), [{ method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', redirect: 'error' }]);
  });

  it('answers a loopback request it cannot check in time with request-refused', async () => {
    const { env, offscreen, ask } = await worker();
    env.chrome.api.storage.local.get = () => new Promise(() => {});
    const pending = ask({ type: 'API_REQUEST', url: 'http://localhost:11434/api/tags', options: { method: 'GET' } }, page());
    // The worker's timers run on the test's fake clock
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    env.clock.tick(5000);
    const answer = await within(pending, 1000);
    assert.deepEqual(answer, { error: 'request-refused' });
    assert.deepEqual(offscreen, []);
  });

  it("takes the offscreen document's answer as final, an error included, and fetches itself only when the document can't be reached or doesn't answer", async () => {
    const message = { type: 'API_REQUEST', url: 'http://localhost:11434/api/chat', options: { method: 'POST', body: '{}' } };
    const answered = await worker({ offscreenAnswer: async () => ({ error: 'Failed to fetch' }) });
    assert.deepEqual(await answered.ask(message, page()), { error: 'Failed to fetch' });
    assert.equal(answered.offscreen.length, 1);
    assert.deepEqual(answered.fetches, [], 'the worker reached the loopback origin again');
    for (const offscreenAnswer of [async () => { throw new Error('Could not establish connection'); }, async () => undefined]) {
      const unreachable = await worker({ offscreenAnswer });
      assert.equal((await unreachable.ask(message, page())).ok, true);
      assert.deepEqual(unreachable.fetches.map(({ url }) => url), ['http://localhost:11434/api/chat']);
    }
  });

  it('every provider endpoint, as llm.js names it, still goes, with Content-Type only', async () => {
    const { fetches, ask } = await worker();
    const llm = fs.readFileSync(path.join(ROOT, 'js/llm.js'), 'utf8');
    const bases = [...new Set([...llm.matchAll(/baseUrl: '(https:\/\/[^']+)'/g)].map(([, base]) => base))];
    assert.ok(bases.length >= 15, `${bases.length} endpoints`);
    for (const base of bases) {
      const answer = await ask({ type: 'API_REQUEST', url: `${base}/chat/completions`, options: { method: 'POST', body: '{"model":"m"}' } }, page());
      assert.equal(answer && answer.ok, true, base);
    }
    assert.equal(fetches.length, bases.length);
    for (const { init } of fetches) {
      assert.deepEqual(init, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"m"}', credentials: 'omit', redirect: 'error' });
    }
  });

  it('Ollama on its default and on a custom localhost port goes to the offscreen document, with its origin', async () => {
    const { env, offscreen, ask } = await worker();
    assert.equal((await ask({ type: 'API_REQUEST', url: 'http://localhost:11434/api/tags', options: { method: 'GET' } }, page())).ok, true);
    env.chrome.local.setting_ollamaUrl = 'http://localhost:8080';
    assert.equal((await ask({ type: 'API_REQUEST', url: 'http://localhost:8080/api/chat', options: { method: 'POST', body: '{}' } }, page())).ok, true);
    // The default port is no longer the Ollama URL, so it's refused
    assert.ok((await ask({ type: 'API_REQUEST', url: 'http://localhost:11434/api/tags', options: {} }, page())).error);
    assert.deepEqual(offscreen.map((message) => [message.url, message.loopbackOrigin]), [
      ['http://localhost:11434/api/tags', 'http://localhost:11434'],
      ['http://localhost:8080/api/chat', 'http://localhost:8080'],
    ]);
    assert.deepEqual(offscreen.map((message) => Object.keys(message.options).sort()), [['method'], ['body', 'method']]);
  });
});

describe('OFFSCREEN_API_REQUEST in the offscreen document (js/offscreen.js)', () => {
  async function offscreenPage() {
    const env = createLegacyEnv();
    env.global.URL = URL;
    env.chrome.api.runtime.getManifest = () => ({ background: { service_worker: 'js/background.js' } });
    const fetches = [];
    env.global.fetch = async (url, init) => {
      fetches.push({ url: String(url), init: JSON.parse(JSON.stringify(init || {})) });
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ models: [] }), text: async () => '' };
    };
    env.global.XMLHttpRequest = class {
      constructor() {
        throw new Error('the offscreen document sends with fetch');
      }
    };
    await loadPageModule(env, 'js/offscreen.js');
    const ask = (message, sender) =>
      new Promise((resolve) => {
        for (const listener of env.chrome.api.runtime.onMessage.listeners) {
          if (listener(message, sender, (response) => resolve(plain(response))) === true) return;
        }
        setImmediate(() => resolve(undefined));
      });
    return { fetches, ask };
  }

  const worker = { id: 'test-extension', url: `${OWN}/js/background.js` };
  const message = { type: 'OFFSCREEN_API_REQUEST', url: 'http://localhost:8080/api/chat', options: { method: 'POST', body: '{}' }, loopbackOrigin: 'http://localhost:8080' };

  it('takes only the service worker, and only the loopback origin the worker checked', async () => {
    const { fetches, ask } = await offscreenPage();
    for (const sender of [{ id: 'another-extension', url: 'chrome-extension://another-extension/x' }, page(), page('popup.html'), { ...worker, tab: { id: 2 } }]) {
      assert.deepEqual(await ask(message, sender), { error: 'request-refused' }, JSON.stringify(sender));
    }
    assert.ok((await ask({ ...message, url: 'http://localhost:9999/api/chat' }, worker)).error);
    assert.ok((await ask({ ...message, url: 'https://api.openai.com/v1/models' }, worker)).error);
    assert.ok((await ask({ ...message, loopbackOrigin: 'http://192.168.1.5:8080', url: 'http://192.168.1.5:8080/api/chat' }, worker)).error);
    assert.deepEqual(fetches, []);
  });

  it('sends with fetch: Content-Type only, no cookies, and no redirect followed', async () => {
    const { fetches, ask } = await offscreenPage();
    assert.deepEqual(await ask(message, worker), { ok: true, status: 200, data: { models: [] } });
    assert.deepEqual(fetches, [{
      url: 'http://localhost:8080/api/chat',
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit', redirect: 'error' },
    }]);
  });
});

describe("the page's proxy call (LLMService.fetchViaBackground)", () => {
  /** The page with LLM loaded, the worker answering `answer`, and its own fetches recorded */
  function llmWith(answer) {
    const env = createLegacyEnv();
    env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/llm.js');
    const fetches = [];
    env.global.fetch = async (url) => {
      fetches.push(String(url));
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
    };
    env.chrome.api.runtime.sendMessage = (sent, callback) => answer(callback, env);
    return { llm: env.get('LLM'), fetches };
  }

  it('a refused request is final: no direct fetch follows it', async () => {
    const { llm, fetches } = llmWith((callback) => callback({ error: 'request-refused' }));
    await assert.rejects(llm.fetchViaBackground('https://api.openai.com/v1/models', { method: 'GET', headers: { Authorization: 'Bearer test' } }));
    assert.deepEqual(fetches, []);
  });

  it('a worker that cannot be reached still falls back to a direct fetch', async () => {
    const { llm, fetches } = llmWith((callback, env) => {
      env.chrome.api.runtime.lastError = { message: 'Could not establish connection' };
      callback(undefined);
      env.chrome.api.runtime.lastError = undefined;
    });
    assert.equal((await llm.fetchViaBackground('https://api.openai.com/v1/models', { method: 'GET' })).ok, true);
    assert.deepEqual(fetches, ['https://api.openai.com/v1/models']);
  });
});
