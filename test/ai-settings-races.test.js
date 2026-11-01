'use strict';

// Settings' AI section when its answers land out of order (1.4.x, after #21 slice 1a): the last
// provider change wins the model list, however slowly an earlier provider's listing answers, and
// a delayed key save never overwrites what's typed in the key field while it writes. The keys
// are synthetic canaries.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument, connectStorageSettings, settingsOf } = require('./helpers/legacy-env');

const canary = (slot) => `ntn-canary-${slot}-${Math.random().toString(16).slice(2, 10)}`;

/** Let pending promise callbacks run */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * The new tab's AI settings on `provider`: the provider list, the key field, and the model list,
 * with LLMService.fetchModels answering each provider one model of its own, `slow` ones only once
 * `release` is called
 */
async function settingsPage(provider, { slow = [] } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.global.ResizablePanel = class {};
  env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/llm.js', 'js/controllers/ai-chat-controller.js');
  await connectStorageSettings(env);
  const storage = settingsOf(env);
  await storage.setSetting('llmProvider', provider);
  const llm = env.get('LLM');
  await llm.init();
  const doc = env.document;
  const element = (tag, id) => {
    const made = doc.createElement(tag);
    made.id = id;
    doc.body.appendChild(made);
    return made;
  };
  const select = element('select', 'llm-provider-select');
  const field = element('input', 'llm-api-key');
  const models = element('select', 'llm-model-select');
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  llm.fetchModels = async (listed) => {
    if (slow.includes(listed)) await gate;
    return [{ id: `${listed}-model`, name: `${listed}-model` }];
  };
  const AIChatController = env.get('AIChatController');
  const chat = new AIChatController({ domRefs: { get: () => null }, logger: { debug() {}, info() {}, warn() {}, error() {} }, llm });
  chat.updateLLMSettingsVisibility = () => {};
  chat.updateAISidebarState = () => {};
  chat.setupLLMSettings();
  return { env, llm, select, field, models, release };
}

describe("Settings' AI section when its answers land out of order", () => {
  it('the last provider change wins the model list, however slowly an earlier listing answers', async () => {
    const { env, llm, select, models, release } = await settingsPage('openai', { slow: ['anthropic'] });
    select.value = 'anthropic';
    select.dispatchEvent({ type: 'change' });
    await settle();
    select.value = 'groq';
    select.dispatchEvent({ type: 'change' });
    await settle();
    release();
    await settle();
    assert.equal(llm.provider, 'groq');
    assert.equal(llm.model, 'groq-model');
    assert.equal(env.chrome.local.setting_llmModel, 'groq-model');
    assert.equal(models.value, 'groq-model');
  });

  it('a delayed key save keeps a keystroke typed while it writes', async () => {
    const key = canary('typed');
    const { env, llm, field } = await settingsPage('openai');
    field.focus();
    field.value = key;
    field.dispatchEvent({ type: 'input' });
    env.clock.tick(800);
    // The save is writing: one more keystroke lands in the field
    field.value = `${key}x`;
    await settle();
    assert.equal(field.value, `${key}x`);
    // The next save takes it
    field.dispatchEvent({ type: 'input' });
    env.clock.tick(800);
    await settle();
    assert.equal(llm.apiKey, `${key}x`);
  });
});
