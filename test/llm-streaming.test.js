const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal stubs so llm.js can load in Node
global.window = {};
global.Storage = { getSetting: async () => '', setSetting: async () => {} };

const { ReadableStream } = require('node:stream/web');

// Load LLMService class
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'js', 'llm.js'), 'utf8');
const script = new vm.Script(src);
const ctx = vm.createContext({
  window: {},
  Storage: global.Storage,
  console,
  fetch: () => {},
  chrome: undefined,
  setTimeout,
  clearTimeout,
  AbortController,
  ReadableStream,
  TextDecoder,
  TextEncoder,
});
script.runInContext(ctx);
const LLMService = ctx.LLMService || ctx.window.LLM?.constructor;

/**
 * Helper: create a ReadableStream from an array of string chunks.
 */
function createMockStream(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Helper: collect all tokens from an async generator.
 */
async function collectTokens(gen) {
  const tokens = [];
  for await (const token of gen) {
    tokens.push(token);
  }
  return tokens;
}

// --- _parseSSEStream tests ---

test('_parseSSEStream yields tokens from OpenAI-format SSE data lines', async () => {
  const svc = new LLMService();
  const body = createMockStream([
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const tokens = await collectTokens(svc._parseSSEStream(body, new AbortController().signal));
  assert.deepEqual(tokens, ['Hello', ' world']);
});

test('_parseSSEStream handles chunks split across boundaries', async () => {
  const svc = new LLMService();
  // Split a single SSE message across two chunks
  const body = createMockStream([
    'data: {"choices":[{"delta":{"con',
    'tent":"split"}}]}\n\ndata: [DONE]\n\n',
  ]);

  const tokens = await collectTokens(svc._parseSSEStream(body, new AbortController().signal));
  assert.deepEqual(tokens, ['split']);
});

test('_parseSSEStream skips lines without delta content', async () => {
  const svc = new LLMService();
  const body = createMockStream([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const tokens = await collectTokens(svc._parseSSEStream(body, new AbortController().signal));
  assert.deepEqual(tokens, ['ok']);
});

test('_parseSSEStream skips malformed JSON gracefully', async () => {
  const svc = new LLMService();
  const body = createMockStream([
    'data: {bad json}\n\n',
    'data: {"choices":[{"delta":{"content":"good"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const tokens = await collectTokens(svc._parseSSEStream(body, new AbortController().signal));
  assert.deepEqual(tokens, ['good']);
});

// --- chatStream configuration tests ---

test('chatStream throws if provider is not configured', async () => {
  const svc = new LLMService();
  svc.provider = 'none';

  await assert.rejects(
    async () => { for await (const _ of svc.chatStream([])) {} },
    { message: /not configured/i }
  );
});

test('chatStream throws if no model is selected', async () => {
  const svc = new LLMService();
  svc.provider = 'openai';
  svc.apiKey = 'test-key';
  svc.model = '';

  await assert.rejects(
    async () => { for await (const _ of svc.chatStream([])) {} },
    { message: /no model/i }
  );
});

// --- abortStream tests ---

test('abortStream aborts an in-progress stream controller', () => {
  const svc = new LLMService();
  const ac = new AbortController();
  svc.streamAbortController = ac;

  svc.abortStream();

  assert.equal(ac.signal.aborted, true);
  assert.equal(svc.streamAbortController, null);
});

test('abortStream is safe to call when no stream is active', () => {
  const svc = new LLMService();
  svc.streamAbortController = null;

  // Should not throw
  svc.abortStream();
  assert.equal(svc.streamAbortController, null);
});

// --- _getOpenAICompatibleConfig tests ---

test('_getOpenAICompatibleConfig returns correct URL for openai', () => {
  const svc = new LLMService();
  svc.provider = 'openai';
  svc.apiKey = 'sk-test';
  const config = svc._getOpenAICompatibleConfig('openai');
  assert.equal(config.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(config.headers['Authorization'], 'Bearer sk-test');
});

test('_getOpenAICompatibleConfig returns correct URL for openrouter with extra headers', () => {
  const svc = new LLMService();
  svc.provider = 'openrouter';
  svc.apiKey = 'or-test';
  const config = svc._getOpenAICompatibleConfig('openrouter');
  assert.equal(config.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(config.headers['HTTP-Referer'], 'chrome-extension://new-tab-note');
  assert.equal(config.headers['X-Title'], 'New Tab Note');
});

test('_getOpenAICompatibleConfig uses baseUrl for qwen/glm/kimi', () => {
  const svc = new LLMService();
  svc.provider = 'qwen';
  svc.endpoint = 'intl';
  const config = svc._getOpenAICompatibleConfig('qwen');
  assert.ok(config.url.includes('dashscope-intl.aliyuncs.com'));
  assert.ok(config.url.endsWith('/chat/completions'));
});
