'use strict';

// Known defects in how production code keeps and sends provider secrets: the WebDAV password
// (js/services/sync-service.js) and the Gemini API key (js/llm.js). Each is an expected
// failure under its test/known-defects.json entry, so the run fails once the defect is fixed
// and the entry stays. The secrets are synthetic canaries, and no assertion message prints
// one. A step that goes wrong for another reason throws a plain Error, not an assertion.

const assert = require('node:assert/strict');
const { createLegacyEnv, dumpDatabase } = require('./helpers/legacy-env');
const { expectFailure } = require('./helpers/expect-failure');

/** A synthetic secret, new each run */
const canary = (slot) => `ntn-canary-${slot}-${Math.random().toString(16).slice(2, 10)}`;

expectFailure('KD-006 connecting WebDAV stores no plaintext copy of the password', async () => {
  const env = createLegacyEnv();
  env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/core/event-bus.js', 'js/core/logger.js', 'js/services/sync-service.js');
  const storage = env.get('Storage');
  await storage.init();
  // The server answers the connection check
  env.global.fetch = async () => ({ status: 200, ok: true });
  const SyncService = env.get('SyncService');
  const service = new SyncService({ storage, eventBus: env.get('createEventBus()'), logger: env.get('createLogger("error")') });
  await service.init();

  const password = canary('webdav');
  await service.connect('webdav', { serverUrl: 'https://dav.example.test/files', username: 'synthetic-user', password });
  if (env.chrome.local.setting_syncProvider !== 'webdav') throw new Error('WebDAV did not connect');

  const atRest = JSON.stringify(env.chrome.local) + JSON.stringify(await dumpDatabase(env.indexedDB));
  assert.equal(atRest.includes(password), false, 'the password is stored as typed');
});

expectFailure('KD-007 Gemini requests carry the API key outside their URL', async () => {
  const key = canary('gemini');
  const env = createLegacyEnv();
  env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/llm.js');
  const storage = env.get('Storage');
  await storage.init();
  // As Settings saves a Gemini key and model
  await storage.setSetting('llmProvider', 'gemini');
  await storage.setSetting('llmApiKey', key);
  await storage.setSetting('llmModel', 'gemini-2.0-flash');
  /** @type {string[]} */
  const urls = [];
  // Every request is refused, so each call stops at its first request
  env.global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: false, status: 400, json: async () => ({}) };
  };
  env.global.AbortController = AbortController;
  const llm = env.get('LLM');
  await llm.init();
  if (llm.provider !== 'gemini' || llm.apiKey !== key) throw new Error('the Gemini settings did not load');

  const messages = [{ role: 'user', content: 'hello' }];
  await llm.fetchModels('gemini', key);
  await llm.chat(messages).then(() => { throw new Error('chat should have failed on the refused request'); }, () => {});
  try {
    for await (const token of llm.chatStream(messages)) void token;
    throw new Error('chatStream should have failed on the refused request');
  } catch (error) {
    if (/should have failed/.test(error.message)) throw error;
  }
  if (urls.length !== 3) throw new Error(`expected 3 Gemini requests, saw ${urls.length}`);

  // Each URL that holds the key, by its path only
  const leaking = urls.filter((url) => url.includes(key)).map((url) => new URL(url).pathname);
  assert.deepEqual(leaking, [], 'Gemini requests put the API key in the URL');
});
