'use strict';

// #13's API_REQUEST row (#13, "Current problem" and "Security and privacy"): a message to the
// service worker never carries a raw credential. fetchGLMModels used to put `Authorization:
// Bearer <key>` in its API_REQUEST message, which the worker drops anyway. The direct-fetch
// fallback, which calls the provider from the page itself, keeps the header. The key is a
// synthetic canary, and no assertion message prints it. The rest of API_REQUEST and
// OFFSCREEN_API_REQUEST goes to #9, #11, and #21.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { connectStorageSettings, createLegacyEnv } = require('./helpers/legacy-env');

const canary = () => `ntn-canary-glm-${Math.random().toString(16).slice(2, 10)}`;

/** The legacy page with LLM loaded, and the worker's answer to each message `answer` gives */
async function setup(answer) {
  const env = createLegacyEnv();
  env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/llm.js');
  await connectStorageSettings(env);
  const messages = [];
  env.chrome.api.runtime.sendMessage = (message, callback) => {
    messages.push(JSON.parse(JSON.stringify(message)));
    setImmediate(() => answer(callback, env.chrome.api.runtime));
  };
  const fetches = [];
  env.global.fetch = async (url, options) => {
    fetches.push({ url: String(url), options: JSON.parse(JSON.stringify(options || {})) });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ data: [{ id: 'glm-direct' }] }),
    };
  };
  return { env, llm: env.get('LLM'), messages, fetches };
}

/** Header names, lowercased */
const headerNames = (options) => Object.keys((options && options.headers) || {}).map((name) => name.toLowerCase());

describe('API_REQUEST carries no credential (#13)', () => {
  it("leaves the GLM key out of the worker's message, and gets the models it answers with", async () => {
    const key = canary();
    const { llm, messages, fetches } = await setup((callback) => callback({ ok: true, status: 200, data: { data: [{ id: 'glm-4' }] } }));
    const models = await llm.fetchModels('glm', key);
    assert.deepEqual(JSON.parse(JSON.stringify(models)), [{ id: 'glm-4', name: 'glm-4' }]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'API_REQUEST');
    assert.equal(headerNames(messages[0].options).includes('authorization'), false, 'the message names an Authorization header');
    assert.equal(JSON.stringify(messages).includes(key), false, 'the message holds the key');
    assert.deepEqual(fetches, []);
  });

  it('sends the worker only the method and body, whatever headers a caller names and however it shapes them', async () => {
    const key = canary();
    const { llm, messages } = await setup((callback) => callback({ ok: true, status: 200, data: {} }));
    await llm.fetchViaBackground('https://provider.example.test/v1/chat', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: '{"model":"m"}',
    });
    await llm.fetchViaBackground('https://provider.example.test/v1/models', { headers: [['api-key', key]] });
    assert.deepEqual(messages.map((message) => message.options), [
      { method: 'POST', body: '{"model":"m"}' },
      {},
    ]);
    assert.equal(JSON.stringify(messages).includes(key), false, 'a message holds the key');
  });

  it('keeps the header on the direct fetch it falls back to when the worker is unreachable', async () => {
    const key = canary();
    const { llm, fetches } = await setup((callback, runtime) => {
      runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
      try {
        callback(undefined);
      } finally {
        runtime.lastError = undefined;
      }
    });
    const models = await llm.fetchModels('glm', key);
    assert.deepEqual(JSON.parse(JSON.stringify(models)), [{ id: 'glm-direct', name: 'glm-direct' }]);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].options.headers.Authorization === `Bearer ${key}`, true, 'the direct fetch lost its Authorization header');
  });
});
