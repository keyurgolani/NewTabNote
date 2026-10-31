'use strict';

// #21 slice 1b, PR 1: the destination registry (security/destinations.json) and its client
// (js/kernel/composition/destinations.js). Every place this build's code may reach is a row:
// its origin, path prefix, methods, credential scheme, the headers a request may carry, and the
// issue that owns it. The client takes a URL to its row or refuses it, checks a request's
// headers, and builds what a request goes with. Today's code is held to the registry: every
// provider endpoint, every URL in js/llm.js, and #20's list of uncovered egress.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** @type {any} */
let client;
/** @type {any} */
let egress;
/** @type {any} */
let registry;
before(async () => {
  client = await import('../js/kernel/composition/destinations.js');
  egress = await import('../js/trust/core/providers/egress.js');
  registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'security/destinations.json'), 'utf8'));
});

/** A valid packaged row to vary */
const row = (fields = {}) => ({
  id: 'example',
  kind: 'packaged',
  origin: 'https://api.example.test',
  pathPrefix: '/v1/',
  methods: ['GET', 'POST'],
  credential: 'bearer',
  headers: ['Authorization', 'Content-Type'],
  location: 'remote',
  reachedBy: 'fetch',
  proxy: true,
  owner: 11,
  ...fields,
});

describe('the destination registry (security/destinations.json)', () => {
  it('every row is valid, each id once, and the client reads the same rows', () => {
    assert.deepEqual(client.destinationProblems(registry.destinations), []);
    assert.equal(new Set(registry.destinations.map((entry) => entry.id)).size, registry.destinations.length);
    assert.deepEqual(client.DESTINATIONS.map((entry) => entry.id), registry.destinations.map((entry) => entry.id));
  });

  it('refuses a row that breaks a rule: a wildcard outside legacy, http off loopback, a legacy row with no removeWhen, a path or userinfo in the origin, an unknown credential or method, a header with a line break, a repeated id', () => {
    const cases = [
      row({ origin: 'https://*.example.test' }),
      row({ origin: 'http://api.example.test' }),
      row({ kind: 'legacy', credential: 'none', headers: [] }),
      row({ origin: 'https://api.example.test/v1' }),
      row({ origin: 'https://user@api.example.test' }),
      row({ credential: 'cookie' }),
      row({ methods: ['DELETE'] }),
      row({ headers: ['X-Bad\r\nInjected'] }),
      row({ pathPrefix: 'v1/' }),
      row({ location: 'loopback' }),
    ];
    for (const entry of cases) {
      assert.notDeepEqual(client.destinationProblems([entry]), [], JSON.stringify(entry));
    }
    assert.notDeepEqual(client.destinationProblems([row(), row()]), []);
    assert.deepEqual(client.destinationProblems([row()]), []);
  });

  it('has a row for every provider endpoint js/llm.js names, the proxy allowed', () => {
    const llm = fs.readFileSync(path.join(ROOT, 'js/llm.js'), 'utf8');
    const bases = [...new Set([...llm.matchAll(/baseUrl: '(https?:\/\/[^']+)'/g)].map(([, base]) => base))];
    assert.ok(bases.length >= 17, `${bases.length} endpoints`);
    const loopback = 'http://localhost:11434';
    for (const base of bases) {
      const found = client.destinationFor(`${base}/models`, { method: 'GET', loopback });
      assert.equal(found.ok, true, base);
      assert.equal(found.row.proxy, true, base);
    }
  });

  it('has a row for every URL js/llm.js reaches, origin and path', () => {
    const llm = fs.readFileSync(path.join(ROOT, 'js/llm.js'), 'utf8');
    const urls = [...new Set([...llm.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[A-Za-z0-9_./-]*)?/g)].map(([url]) => url))];
    const bases = new Set([...llm.matchAll(/baseUrl: '(https:\/\/[^']+)'/g)].map(([, base]) => base));
    assert.ok(urls.length > 20, `${urls.length} URLs`);
    for (const url of urls) {
      // An endpoint's base reaches the paths below it
      const probe = bases.has(url) || new URL(url).pathname === '/' ? `${url.replace(/\/$/, '')}/models` : url;
      assert.equal(client.destinationFor(probe, { method: 'GET', loopback: null }).ok, true, url);
    }
  });

  it("holds #20's uncovered egress to the registry: one list", () => {
    const fromRegistry = new Map();
    for (const entry of registry.destinations.filter((candidate) => candidate.egress)) {
      const seen = fromRegistry.get(entry.egress) || { origins: new Set(), reachedBy: new Set() };
      seen.origins.add(entry.origin);
      seen.reachedBy.add(entry.reachedBy);
      fromRegistry.set(entry.egress, seen);
    }
    assert.deepEqual([...fromRegistry.keys()].sort(), egress.UNCOVERED_EGRESS.map((entry) => entry.id).sort());
    for (const entry of egress.UNCOVERED_EGRESS) {
      const seen = fromRegistry.get(entry.id);
      assert.deepEqual([...seen.origins].sort(), [...entry.origins].sort(), entry.id);
      assert.deepEqual([...seen.reachedBy], [entry.reachedBy], entry.id);
    }
  });
});

describe('the destination client (js/kernel/composition/destinations.js)', () => {
  const take = (url, options = {}) => client.destinationFor(url, { method: 'GET', loopback: null, ...options });

  it('takes a URL to its row by origin, path prefix, and method', () => {
    assert.equal(take('https://api.openai.com/v1/chat/completions', { method: 'POST' }).row.id, 'openai');
    assert.equal(take('https://api.z.ai/api/coding/paas/v4/chat/completions', { method: 'POST' }).row.id, 'glm-coding');
    assert.equal(take('https://api.deepseek.com/chat/completions', { method: 'POST' }).row.id, 'deepseek');
    assert.equal(take('https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json').row.id, 'embedding-model');
  });

  it('refuses another origin, a look-alike, userinfo, http off loopback, a path outside the prefix, a method the row lacks, and a row reached another way', () => {
    for (const [url, options] of [
      ['https://api.example.test/v1/models', {}],
      ['https://api.openai.com.example.test/v1/models', {}],
      ['https://user@api.openai.com/v1/models', {}],
      ['http://api.openai.com/v1/models', {}],
      ['https://api.openai.com/v2/models', {}],
      ['https://api.openai.com/v1x', {}],
      ['https://api.openai.com/v1/models', { method: 'DELETE' }],
      ['https://huggingface.co/Xenova/model', { method: 'POST' }],
      ['https://www.google.com/s2/favicons?domain=example.test', {}],
      ['https://www.google.com/search?q=x', { reachedBy: 'image' }],
      ['not a url', {}],
    ]) {
      assert.equal(take(url, options).ok, false, `${url} ${JSON.stringify(options)}`);
    }
    assert.equal(take('https://www.google.com/s2/favicons?domain=example.test', { reachedBy: 'image' }).ok, true);
  });

  it('matches a legacy wildcard for subdomains only', () => {
    assert.equal(take('https://cdn-lfs.huggingface.co/repos/x').row.id, 'embedding-model-hub');
    assert.equal(take('https://cas-bridge.xethub.hf.co/x').row.id, 'embedding-model-cdn');
    for (const url of ['https://hf.co/x', 'https://evilhf.co/x', 'https://hf.co.example.test/x', 'https://xhuggingface.co/x']) {
      assert.equal(take(url).ok, false, url);
    }
  });

  it("takes loopback only at the stored Ollama URL's own origin", () => {
    assert.equal(take('http://localhost:8080/api/tags', { loopback: 'http://localhost:8080' }).row.id, 'ollama-localhost');
    assert.equal(take('http://127.0.0.1:11434/api/tags', { loopback: 'http://127.0.0.1:11434' }).row.id, 'ollama-127');
    assert.equal(take('http://localhost:9999/api/tags', { loopback: 'http://localhost:8080' }).ok, false);
    assert.equal(take('http://localhost:8080/api/tags', { loopback: null }).ok, false);
    assert.equal(take('http://192.168.1.5:8080/api/tags', { loopback: 'http://192.168.1.5:8080' }).ok, false);
  });

  it("checks a request's headers: the row's names only, no line breaks, and no credential in the URL", () => {
    const openai = take('https://api.openai.com/v1/models').row;
    assert.deepEqual(client.headerProblems(openai, { authorization: 'Bearer test', 'Content-Type': 'application/json' }, 'https://api.openai.com/v1/models'), []);
    for (const headers of [{ 'X-Other': '1' }, { Authorization: 'Bearer a\r\nX-Other: 1' }, { 'Content-Type\n': 'x' }]) {
      assert.notDeepEqual(client.headerProblems(openai, headers, 'https://api.openai.com/v1/models'), [], JSON.stringify(headers));
    }
    const model = take('https://huggingface.co/x').row;
    assert.notDeepEqual(client.headerProblems(model, { Authorization: 'Bearer test' }, 'https://huggingface.co/x'), []);
    const gemini = take('https://generativelanguage.googleapis.com/v1beta/models').row;
    for (const url of ['https://generativelanguage.googleapis.com/v1beta/models?key=test', 'https://api.openai.com/v1/models?api_key=test']) {
      assert.notDeepEqual(client.headerProblems(gemini, {}, url), [], url);
    }
  });

  it('every header js/llm.js sends is on some provider row', () => {
    const llm = fs.readFileSync(path.join(ROOT, 'js/llm.js'), 'utf8');
    const sent = new Set();
    for (const [, block] of llm.matchAll(/headers:\s*\{([^}]*)\}/g)) {
      for (const [, name] of block.matchAll(/'([A-Za-z-]+)'\s*:/g)) sent.add(name.toLowerCase());
    }
    const allowed = new Set(registry.destinations.flatMap((entry) => entry.headers.map((name) => name.toLowerCase())));
    assert.ok(sent.size >= 5);
    assert.deepEqual([...sent].filter((name) => !allowed.has(name)), []);
  });

  it('a request with a credential or a body goes with no cookies and no redirect followed, and a model download as before', () => {
    const openai = take('https://api.openai.com/v1/models').row;
    assert.deepEqual(client.requestInit(openai, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit', redirect: 'error',
    });
    assert.deepEqual(client.requestInit(openai, { method: 'GET' }), { method: 'GET', credentials: 'omit', redirect: 'error' });
    const model = take('https://huggingface.co/x').row;
    // The Hub answers a model file with a redirect to its CDN, which a download follows
    assert.deepEqual(client.requestInit(model, { method: 'GET' }), { method: 'GET', credentials: 'omit' });
  });
});
