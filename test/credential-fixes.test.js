'use strict';

// #21 slice 1a, the credential fixes in today's code: Gemini's key goes in the
// x-goog-api-key header, never the URL (KD-007's old test is its regression test in
// provider-secrets.test.js); switching providers never sends the previous provider's key to
// the new one, nor lists its models with it; sync's export skips the IndexedDB `settings`
// store, which held the plaintext key up to 1.1.2; and the key and Ollama hints say where the
// key is and name this extension's own origin. The keys are synthetic canaries, and no
// assertion message prints one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, createDatabase, FakeDocument, settingsOf, startEditorClient } = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
const canary = (slot) => `ntn-canary-${slot}-${Math.random().toString(16).slice(2, 10)}`;

/** The legacy page with LLM loaded, every request recorded and refused */
async function llmPage() {
  const env = createLegacyEnv();
  env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/llm.js');
  const storage = settingsOf(env);
  /** @type {Array<{url: string, headers: Record<string, string>}>} */
  const requests = [];
  env.global.fetch = async (url, options = {}) => {
    const headers = {};
    for (const [name, value] of Object.entries(options.headers || {})) headers[name.toLowerCase()] = String(value);
    requests.push({ url: String(url), headers });
    return { ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '' };
  };
  env.global.AbortController = AbortController;
  // No worker answers, so the proxy path falls back to the page's own fetch
  env.chrome.api.runtime.sendMessage = undefined;
  return { env, storage, llm: env.get('LLM'), requests };
}

describe("Gemini's key in the x-goog-api-key header (#21 slice 1a)", () => {
  it('every Gemini request sends the key in the header, and no URL holds it', async () => {
    const key = canary('gemini');
    const { storage, llm, requests } = await llmPage();
    await storage.setSetting('llmProvider', 'gemini');
    await storage.setSetting('llmApiKey', key);
    await storage.setSetting('llmModel', 'gemini-2.0-flash');
    await llm.init();
    const messages = [{ role: 'user', content: 'hello' }];
    await llm.fetchModels('gemini', key);
    await llm.chat(messages).catch(() => {});
    try {
      for await (const token of llm.chatStream(messages)) void token;
    } catch {
      // The refused request ends the stream
    }
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.url.includes(key)), [false, false, false], 'a URL holds the key');
    assert.deepEqual(requests.map((request) => request.headers['x-goog-api-key'] === key), [true, true, true], 'a request lacks the key header');
    for (const request of requests) assert.equal(new URL(request.url).origin, 'https://generativelanguage.googleapis.com');
  });
});

describe("a provider switch keeps each provider's key to itself (#21 slice 1a)", () => {
  it("switching providers sends the old provider's key nowhere: no model listing, no chat", async () => {
    const key = canary('openai');
    const { storage, llm, requests } = await llmPage();
    await storage.setSetting('llmProvider', 'openai');
    await storage.setSetting('llmApiKey', key);
    await llm.init();
    assert.equal(llm.apiKey, key, "the key works for the provider it was saved for");
    await llm.setProvider('anthropic');
    assert.equal(llm.apiKey, '', 'the new provider has no key yet');
    assert.equal(llm.isConfigured(), false);
    await llm.fetchModels('anthropic', llm.apiKey);
    await llm.chat([{ role: 'user', content: 'hi' }]).catch(() => {});
    assert.equal(JSON.stringify(requests).includes(key), false, "the old provider's key went to the new one");
    // Back on the provider it was saved for, it works again; nothing was deleted
    await llm.setProvider('openai');
    assert.equal(llm.apiKey, key);
  });

  it("a key saved with no owner yet (1.4.x) belongs to the provider it was used with, and stays with it after a reload", async () => {
    const key = canary('legacy');
    const { storage, llm, env } = await llmPage();
    await storage.setSetting('llmProvider', 'mistral');
    await storage.setSetting('llmApiKey', key);
    await llm.init();
    assert.equal(llm.apiKey, key);
    assert.equal(env.chrome.local.setting_llmApiKeyProvider, 'mistral');
    await llm.setProvider('groq');
    const reloaded = new (env.get('LLM').constructor)();
    await reloaded.init();
    assert.equal(reloaded.provider, 'groq');
    assert.equal(reloaded.apiKey, '', 'a reload hands the new provider the old key');
  });

  it('a key typed for the new provider is that provider\'s', async () => {
    const old = canary('old');
    const typed = canary('typed');
    const { storage, llm, requests } = await llmPage();
    await storage.setSetting('llmProvider', 'openai');
    await storage.setSetting('llmApiKey', old);
    await llm.init();
    await llm.setProvider('xai');
    await llm.setApiKey(typed);
    assert.equal(llm.apiKey, typed);
    await llm.fetchModels('xai', llm.apiKey);
    assert.equal(JSON.stringify(requests).includes(old), false);
    assert.ok(requests.some((request) => request.headers.authorization === `Bearer ${typed}`));
  });

  it("Settings' provider list and key field use the key of the provider shown, never another's", () => {
    const source = fs.readFileSync(path.join(ROOT, 'js/controllers/ai-chat-controller.js'), 'utf8');
    // The field and the model listing read the LLM's key for the provider, not the stored key
    assert.equal(/getSetting\('llmApiKey'/.test(source), false, 'Settings reads the stored key directly');
  });
});

describe("sync's export skips the IndexedDB settings store (#21 slice 1a)", () => {
  it('a 1.1.2-era key in the settings store never reaches the export', async () => {
    const key = canary('idb');
    const env = createLegacyEnv();
    await createDatabase(env.indexedDB, { records: { settings: [{ key: 'llmApiKey', value: key }, { key: 'theme', value: 'dark' }] } });
    env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/core/logger.js', 'js/services/sync-service.js');
    // Sync's handle, as the new tab's root gives it, whose export is getSyncData's (#17 PR 4b)
    await startEditorClient(env);
    const SyncService = env.get('SyncService');
    const service = new SyncService({ storage: env.stores.sync, logger: env.get('createLogger("error")') });
    const exported = await service._exportLocalData();
    assert.equal(JSON.stringify(exported).includes(key), false, 'the export holds the key');
    assert.equal(Object.hasOwn(exported, 'settings'), false);
    assert.ok(Array.isArray(exported.folders), 'the rest of the export is as it was');
  });
});

describe('the key and Ollama hints (#21 slice 1a, a declared copy fix)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'newtab.html'), 'utf8');
  it("the key hint doesn't claim IndexedDB, and says the key isn't encrypted", () => {
    const hint = /<p class="setting-hint api-key-warning[^"]*">([\s\S]*?)<\/p>/.exec(html);
    assert.ok(hint, 'the key hint is there');
    assert.equal(/IndexedDB/i.test(hint[1]), false);
    assert.match(hint[1], /chrome\.storage\.local|extension storage/);
    assert.match(hint[1], /not encrypted/);
  });

  it("no hint or error tells Ollama to trust every extension: they name this one's origin", () => {
    for (const file of ['newtab.html', 'js/llm.js']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.equal(text.includes('chrome-extension://*'), false, `${file} names chrome-extension://*`);
    }
    assert.match(html, /id="ollama-origins-command"/);
  });

  it('the copy has no em or en dash', () => {
    const hints = [...html.matchAll(/<p class="setting-hint (?:api-key-warning|llm-ollama-hint)[^"]*">([\s\S]*?)<\/p>/g)].map((match) => match[1]);
    assert.equal(hints.length, 2);
    for (const hint of hints) assert.equal(/[–—]/.test(hint), false);
  });
});

/** Let pending promise callbacks run */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * The new tab's AI settings on `provider`, its key `key` saved for it: the provider list and
 * the key field, with each model listing recorded as [provider, key]
 */
async function settingsPage(provider, key) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.global.ResizablePanel = class {};
  env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/llm.js', 'js/controllers/ai-chat-controller.js');
  const storage = settingsOf(env);
  await storage.setSetting('llmProvider', provider);
  if (key) {
    await storage.setSetting('llmApiKey', key);
    await storage.setSetting('llmApiKeyProvider', provider);
  }
  const llm = env.get('LLM');
  await llm.init();
  const doc = env.document;
  const select = doc.createElement('select');
  select.id = 'llm-provider-select';
  const field = doc.createElement('input');
  field.id = 'llm-api-key';
  doc.body.appendChild(select);
  doc.body.appendChild(field);
  const AIChatController = env.get('AIChatController');
  const chat = new AIChatController({ domRefs: { get: () => null }, logger: { debug() {}, info() {}, warn() {}, error() {} }, llm });
  /** @type {Array<[string, string]>} */
  const listed = [];
  chat.loadAndPopulateModels = async (shown, apiKey) => { listed.push([shown, apiKey]); };
  chat.updateLLMSettingsVisibility = () => {};
  chat.updateAISidebarState = () => {};
  chat.setupLLMSettings();
  return { env, storage, llm, select, field, listed };
}

describe("a key's provider is recorded safely (#21 slice 1a)", () => {
  it("a failed write of the key's provider at start leaves the start working, the provider held in memory", async () => {
    const key = canary('owner-write');
    const { env, storage, llm } = await llmPage();
    await storage.setSetting('llmProvider', 'openai');
    await storage.setSetting('llmApiKey', key);
    await storage.setSetting('llmModel', 'gpt-4o');
    env.chrome.failNextSet();
    await llm.init();
    assert.equal(llm.provider, 'openai');
    assert.equal(llm.apiKey, key);
    assert.equal(llm.model, 'gpt-4o');
    assert.equal(llm.keyProvider, 'openai');
  });

  it('a key is saved for the provider it was typed for, when the provider changes before the save', async () => {
    const key = canary('typed-before-switch');
    const env = createLegacyEnv({ document: new FakeDocument() });
    env.global.ResizablePanel = class {};
    env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/llm.js', 'js/controllers/ai-chat-controller.js');
    const storage = settingsOf(env);
    await storage.setSetting('llmProvider', 'openai');
    const llm = env.get('LLM');
    await llm.init();
    const doc = env.document;
    const select = doc.createElement('select');
    select.id = 'llm-provider-select';
    const input = doc.createElement('input');
    input.id = 'llm-api-key';
    doc.body.appendChild(select);
    doc.body.appendChild(input);
    const AIChatController = env.get('AIChatController');
    const chat = new AIChatController({ domRefs: { get: () => null }, logger: { debug() {}, info() {}, warn() {}, error() {} }, llm });
    /** @type {Array<[string, string]>} */
    const listed = [];
    chat.loadAndPopulateModels = async (provider, apiKey) => { listed.push([provider, apiKey]); };
    chat.updateLLMSettingsVisibility = () => {};
    chat.updateAISidebarState = () => {};
    chat.setupLLMSettings();

    input.value = key;
    input.dispatchEvent({ type: 'input' });
    select.value = 'anthropic';
    select.dispatchEvent({ type: 'change' });
    await settle();
    env.clock.tick(800);
    await settle();

    assert.equal(llm.provider, 'anthropic');
    assert.equal(llm.apiKey, '', 'the provider shown has no key');
    assert.equal(env.chrome.local.setting_llmApiKeyProvider, 'openai');
    assert.equal(listed.some(([provider, apiKey]) => provider === 'anthropic' && apiKey === key), false, 'the key was used for the provider shown');
    await llm.setProvider('openai');
    assert.equal(llm.apiKey, key);
  });

  it("a provider change never sends another provider's key, however fast the changes come", async () => {
    const key = canary('quick-changes');
    const { env, llm, select, listed, field } = await settingsPage('openai', key);
    for (const sequence of [['anthropic', 'openai'], ['openai', 'groq', 'openai'], ['mistral', 'openai', 'anthropic']]) {
      for (const provider of sequence) {
        select.value = provider;
        select.dispatchEvent({ type: 'change' });
      }
      await settle();
      env.clock.tick(10);
      await settle();
      assert.deepEqual(listed.filter(([provider, apiKey]) => apiKey === key && provider !== 'openai'), [], sequence.join(' > '));
      assert.equal(field.value, llm.keyFor(llm.provider), `${sequence.join(' > ')}: the field shows the shown provider's key`);
    }
  });

  it('a saved key that is not a string is no key, and the start goes on', async () => {
    const { storage, llm } = await llmPage();
    await storage.setSetting('llmProvider', 'openai');
    await storage.setSetting('llmApiKey', 12345);
    await llm.init();
    assert.equal(llm.provider, 'openai');
    assert.equal(llm.apiKey, '');
  });

  it("after a switch away and back before the key's save lands, the field shows the key once it does", async () => {
    const key = canary('away-and-back');
    const { env, llm, select, field } = await settingsPage('openai', '');
    field.value = key;
    field.dispatchEvent({ type: 'input' });
    for (const provider of ['anthropic', 'openai']) {
      select.value = provider;
      select.dispatchEvent({ type: 'change' });
      await settle();
    }
    env.clock.tick(800);
    await settle();
    assert.equal(llm.apiKey, key);
    assert.equal(field.value, key);
  });

  it('a saved key with no provider yet is given the one its prefix names, before the provider in use', async () => {
    for (const [prefix, owner, inUse] of [
      ['sk-ant-', 'anthropic', 'groq'],
      ['AIza', 'gemini', 'none'],
      ['sk-or-', 'openrouter', 'openai'],
      ['gsk_', 'groq', 'none'],
      ['xai-', 'xai', 'mistral'],
    ]) {
      const key = `${prefix}${canary('prefix')}`;
      const { env, storage, llm } = await llmPage();
      await storage.setSetting('llmProvider', inUse);
      await storage.setSetting('llmApiKey', key);
      await llm.init();
      assert.equal(llm.keyProvider, owner, prefix);
      assert.equal(env.chrome.local.setting_llmApiKeyProvider, owner, prefix);
      assert.equal(llm.apiKey === key, inUse === owner, prefix);
      await llm.setProvider(owner);
      assert.equal(llm.apiKey === key, true, `${prefix}: its provider has it`);
    }
  });

  it('a saved key no prefix tells apart goes to the provider in use, and stays unowned while none is', async () => {
    const key = `sk-${canary('plain')}`;
    {
      const { storage, llm } = await llmPage();
      await storage.setSetting('llmProvider', 'deepseek');
      await storage.setSetting('llmApiKey', key);
      await llm.init();
      assert.equal(llm.keyProvider, 'deepseek');
    }
    {
      const { env, storage, llm } = await llmPage();
      await storage.setSetting('llmProvider', 'none');
      await storage.setSetting('llmApiKey', key);
      await llm.init();
      assert.equal(llm.keyProvider, null);
      assert.equal(env.chrome.local.setting_llmApiKeyProvider, undefined);
    }
  });

  it("another tab reloads its provider settings when the key's provider changes", () => {
    const source = fs.readFileSync(path.join(ROOT, 'js/controllers/settings-controller.js'), 'utf8');
    const list = /\[([^\]]*'llmApiKey'[^\]]*)\]\.some/.exec(source);
    assert.ok(list, 'the provider settings list');
    assert.match(list[1], /'llmApiKeyProvider'/);
  });
});
