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

  it('takes the Ollama URL only on loopback http, any port, without userinfo', () => {
    assert.equal(policy.loopbackOrigin('http://localhost:11434'), 'http://localhost:11434');
    assert.equal(policy.loopbackOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
    assert.equal(policy.loopbackOrigin('http://localhost'), 'http://localhost');
    for (const url of ['http://192.168.1.5:11434', 'https://localhost:11434', 'http://u:p@localhost:11434', 'http://localhost.evil.example', '', null, 7]) {
      assert.equal(policy.loopbackOrigin(url), null, `${url} was taken`);
    }
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

  it('builds the request with Content-Type only, no cookies, and redirect error when it carries a body', () => {
    const post = policy.checkRequest({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/chat/completions', options: { method: 'POST', body: '{}' } }, { loopback: null });
    assert.deepEqual(policy.fetchInit(post), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'omit',
      redirect: 'error',
    });
    const get = policy.checkRequest({ type: 'API_REQUEST', url: 'https://api.openai.com/v1/models', options: {} }, { loopback: null });
    assert.deepEqual(policy.fetchInit(get), { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'omit' });
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
async function worker() {
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
      return { ok: true, status: 200, data: { models: [] } };
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
          resolve(response);
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
    const opened = [];
    env.global.XMLHttpRequest = class {
      constructor() {
        this.headers = {};
        opened.push(this);
      }
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(name, value) {
        this.headers[name] = value;
      }
      send(body) {
        this.body = body;
        this.status = 200;
        this.responseText = '{"models":[]}';
        setImmediate(() => this.onload());
      }
    };
    await loadPageModule(env, 'js/offscreen.js');
    const ask = (message, sender) =>
      new Promise((resolve) => {
        for (const listener of env.chrome.api.runtime.onMessage.listeners) {
          if (listener(message, sender, resolve) === true) return;
        }
        setImmediate(() => resolve(undefined));
      });
    return { opened, ask };
  }

  const worker = { id: 'test-extension', url: `${OWN}/js/background.js` };

  it("takes only this extension's senders and the loopback origin the worker checked, and sends Content-Type only", async () => {
    const { opened, ask } = await offscreenPage();
    const message = { type: 'OFFSCREEN_API_REQUEST', url: 'http://localhost:8080/api/chat', options: { method: 'POST', body: '{}' }, loopbackOrigin: 'http://localhost:8080' };
    assert.ok((await ask(message, { id: 'another-extension', url: 'chrome-extension://another-extension/x' })).error);
    assert.ok((await ask({ ...message, url: 'http://localhost:9999/api/chat' }, worker)).error);
    assert.ok((await ask({ ...message, url: 'https://evil.example/' }, worker)).error);
    assert.ok((await ask({ ...message, loopbackOrigin: 'http://192.168.1.5:8080', url: 'http://192.168.1.5:8080/api/chat' }, worker)).error);
    assert.equal(opened.length, 0);
    const answer = await ask(message, worker);
    assert.equal(answer.ok, true);
    assert.equal(opened.length, 1);
    assert.deepEqual([opened[0].method, opened[0].url, opened[0].headers, opened[0].body], ['POST', 'http://localhost:8080/api/chat', { 'Content-Type': 'application/json' }, '{}']);
  });
});
