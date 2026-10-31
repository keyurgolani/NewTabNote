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

  it("the code's module of the registry matches it, and a registry edited without it fails", () => {
    const check = require('../scripts/check-destinations.js');
    const lines = [];
    assert.equal(check.main([], { log: (line) => lines.push(line), error: (line) => lines.push(line) }), 0, lines.join('\n'));
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-destinations-'));
    try {
      fs.mkdirSync(path.join(dir, 'security'));
      fs.mkdirSync(path.join(dir, 'js/kernel/composition'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, check.MODULE), path.join(dir, check.MODULE));
      const edited = { ...registry, destinations: registry.destinations.slice(1) };
      fs.writeFileSync(path.join(dir, check.REGISTRY), JSON.stringify(edited));
      assert.equal(check.main([], { root: dir, log: () => {}, error: () => {} }), 1);
      assert.equal(check.main(['--write'], { root: dir, log: () => {}, error: () => {} }), 0);
      assert.equal(check.main([], { root: dir, log: () => {}, error: () => {} }), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      row({ credential: 'none', headers: ['Authorization', 'Content-Type'] }),
      row({ credential: 'none', headers: ['x-api-key'] }),
      row({ credential: 'none', headers: ['Cookie'] }),
      row({ credential: 'none', headers: ['Proxy-Authorization'] }),
      row({ origin: 'https://api.example.test:443' }),
      row({ kind: 'legacy', removeWhen: 9, location: 'loopback', origin: 'http://localhost:80', credential: 'none', headers: [] }),
      row({ pathPrefix: '/v1/../' }),
      row({ pathPrefix: '/v1%2f' }),
      row({ reachedBy: 'image', credential: 'none', headers: [], proxy: true }),
      row({ reachedBy: 'frame', credential: 'none', headers: [], proxy: true }),
    ];
    for (const entry of cases) {
      assert.notDeepEqual(client.destinationProblems([entry]), [], JSON.stringify(entry));
    }
    assert.notDeepEqual(client.destinationProblems([row(), row()]), []);
    assert.deepEqual(client.destinationProblems([row()]), []);
    // Exactly one row for a request: rows of one origin whose prefixes nest and whose methods meet overlap
    assert.notDeepEqual(client.destinationProblems([row(), row({ id: 'nested', pathPrefix: '/v1/models/' })]), []);
    assert.notDeepEqual(client.destinationProblems([row(), row({ id: 'root', pathPrefix: '/' })]), []);
    assert.deepEqual(client.destinationProblems([row(), row({ id: 'beside', pathPrefix: '/v2/' })]), []);
    assert.deepEqual(client.destinationProblems([row({ methods: ['GET'] }), row({ id: 'posts', pathPrefix: '/', methods: ['POST'] })]), []);
  });

  it('has a row for every provider endpoint js/llm.js names', () => {
    const llm = fs.readFileSync(path.join(ROOT, 'js/llm.js'), 'utf8');
    const bases = [...new Set([...llm.matchAll(/baseUrl: '(https?:\/\/[^']+)'/g)].map(([, base]) => base))];
    assert.ok(bases.length >= 17, `${bases.length} endpoints`);
    const loopback = 'http://localhost:11434';
    for (const base of bases) {
      const found = client.destinationFor(`${base}/models`, { method: 'GET', loopback });
      assert.equal(found.ok, true, base);
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

  it('a row stays as the load checked it: its fields, lists and all, are frozen', () => {
    const [first] = client.DESTINATIONS;
    assert.throws(() => { first.methods.push('DELETE'); });
    assert.throws(() => { first.headers.push('Cookie'); });
    assert.throws(() => { first.origin = 'https://example.test'; });
    assert.deepEqual(client.destinationProblems(client.DESTINATIONS), []);
  });

  it("pins the proxied rows to the callers that proxy: fetchViaBackground's", () => {
    const { networkCalls } = require('./helpers/network-scan');
    const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'security/network-ledger.json'), 'utf8'));
    const proxied = registry.destinations.filter((entry) => entry.proxy).map((entry) => entry.id).sort();
    const viaBackground = ledger.calls.find((entry) => entry.function === 'fetchViaBackground');
    assert.deepEqual([...viaBackground.destinations].sort(), proxied);
    // Its callers, and the rows they reach
    const llm = fs.readFileSync(path.join(ROOT, 'js/llm.js'), 'utf8');
    const callers = [...llm.matchAll(/this\.fetchViaBackground\(`\$\{([a-zA-Z.]+)\}/g)].map(([, base]) => base);
    assert.deepEqual([...new Set(callers)].sort(), ['baseUrl', 'this.ollamaUrl']);
    assert.ok(networkCalls().has('js/llm.js#fetchViaBackground'));
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

  it('refuses encoded path separators and encoded dots, in any case', () => {
    for (const url of [
      'https://api.openai.com/v1%2fmodels',
      'https://api.openai.com/v1%2Fmodels',
      'https://api.openai.com/v1/%5cmodels',
      'https://api.openai.com/v1/%5Cx',
      'https://api.openai.com/v1/%2e%2e/models',
      'https://api.openai.com/v1/%2E./models',
      'https://api.openai.com/v1/.%2e/models',
    ]) {
      assert.equal(take(url).ok, false, url);
    }
    assert.equal(take('https://api.openai.com/v1/models').ok, true);
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
    for (const name of ['key', 'api_key', 'api-key', 'API-KEY', 'apikey', 'x-api-key', 'x-goog-api-key', 'X-Goog-Api-Key', 'token', 'access_token', 'auth', 'Auth']) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?${name}=test`;
      assert.notDeepEqual(client.headerProblems(gemini, {}, url), [], url);
    }
    assert.deepEqual(client.headerProblems(gemini, {}, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=10'), []);
  });

  it('reads every header form: a Headers instance, a list of pairs, and a record', () => {
    const openai = take('https://api.openai.com/v1/models').row;
    const url = 'https://api.openai.com/v1/models';
    for (const headers of [new Headers({ 'X-Other': '1' }), [['X-Other', '1']], { 'X-Other': '1' }]) {
      assert.notDeepEqual(client.headerProblems(openai, headers, url), [], String(headers.constructor.name));
    }
    for (const headers of [new Headers({ Authorization: 'Bearer test' }), [['Authorization', 'Bearer test']], { Authorization: 'Bearer test' }]) {
      assert.deepEqual(client.headerProblems(openai, headers, url), [], String(headers.constructor.name));
    }
    const model = take('https://huggingface.co/x').row;
    for (const headers of [new Headers({ Authorization: 'Bearer test' }), [['Authorization', 'Bearer test']], { Authorization: 'Bearer test' }]) {
      assert.notDeepEqual(client.headerProblems(model, headers, 'https://huggingface.co/x'), [], String(headers.constructor.name));
      // A credential in the headers sent is a credentialed request, whatever the row says
      assert.equal(client.requestInit(model, { method: 'GET', headers }).redirect, 'error', String(headers.constructor.name));
    }
  });

  it("lists for each provider row exactly the headers js/llm.js sends that provider", () => {
    const { sentHeaders } = require('./helpers/network-scan');
    const sent = sentHeaders();
    const providers = registry.destinations.filter((entry) => entry.kind === 'packaged' && entry.reachedBy === 'fetch');
    for (const entry of providers) {
      const expected = [...(sent.get(entry.id) || [])].sort();
      assert.deepEqual(entry.headers.map((name) => name.toLowerCase()).sort(), expected, entry.id);
    }
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
