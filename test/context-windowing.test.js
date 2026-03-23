const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal stubs so AIChatController can be constructed
global.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerText: '',
      style: {},
      _innerHTML: '',
      appendChild: () => {},
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      remove: () => {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      dataset: {},
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._innerHTML; },
      set(v) {
        el._innerHTML = v;
        // Approximate: strip tags for textContent
        el.textContent = v.replace(/<[^>]*>/g, '');
        el.innerText = el.textContent;
      },
    });
    return el;
  },
};
global.window = {};
global.Utils = { showToast: () => {}, parseMarkdown: (s) => s };
global.sanitizeHtml = (s) => s;
global.ResizablePanel = class {};

const { AIChatController } = require('../js/controllers/ai-chat-controller.js');

function makeController() {
  return new AIChatController({
    storage: { getSetting: async () => null, setSetting: async () => {} },
    eventBus: { on: () => () => {}, emit: () => {} },
    domRefs: { get: () => null },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    llm: { isConfigured: () => false },
  });
}

function makeBlock(type, content, opts = {}) {
  return {
    id: opts.id || String(Math.random()),
    type,
    content: content || '',
    updatedAt: opts.updatedAt || 0,
  };
}

test('buildContextWindow returns all content when under token limit', () => {
  const ctrl = makeController();
  const blocks = [
    makeBlock('h1', 'Title'),
    makeBlock('text', 'Short paragraph.'),
  ];

  const result = ctrl.buildContextWindow(blocks, -1);

  assert.equal(result.isWindowed, false);
  assert.equal(result.percentage, 100);
  assert.ok(result.content.includes('Title'));
  assert.ok(result.content.includes('Short paragraph.'));
});

test('buildContextWindow applies windowing when content exceeds token limit', () => {
  const ctrl = makeController();
  // Create blocks that exceed 6000 tokens (24000 chars)
  const blocks = [];
  for (let i = 0; i < 50; i++) {
    blocks.push(makeBlock('text', 'A'.repeat(600), { updatedAt: Date.now() - i * 1000 }));
  }
  // Total = 50 * 600 = 30000 chars > 24000 char limit

  const result = ctrl.buildContextWindow(blocks, 25);

  assert.equal(result.isWindowed, true);
  assert.ok(result.percentage < 100);
  assert.ok(result.percentage > 0);
  assert.ok(result.content.length > 0);
  assert.ok(result.content.length < 30000);
});

test('buildContextWindow prioritizes headings', () => {
  const ctrl = makeController();
  const blocks = [];
  // Add a heading
  blocks.push(makeBlock('h1', 'Important Heading'));
  // Fill with large text blocks to exceed limit
  for (let i = 0; i < 60; i++) {
    blocks.push(makeBlock('text', 'X'.repeat(500)));
  }
  // Total > 30000 chars, limit is 24000

  const result = ctrl.buildContextWindow(blocks, -1);

  assert.equal(result.isWindowed, true);
  assert.ok(result.content.includes('Important Heading'));
});

test('buildContextWindow prioritizes blocks near cursor', () => {
  const ctrl = makeController();
  const blocks = [];
  // 60 blocks of 500 chars each = 30000 chars > 24000 limit
  for (let i = 0; i < 60; i++) {
    blocks.push(makeBlock('text', `Block${i}_` + 'Y'.repeat(490), { id: `b${i}` }));
  }

  // Cursor at block 30
  const result = ctrl.buildContextWindow(blocks, 30);

  assert.equal(result.isWindowed, true);
  // Blocks near cursor (25-35) should be included
  assert.ok(result.content.includes('Block30_'));
  assert.ok(result.content.includes('Block29_'));
  assert.ok(result.content.includes('Block31_'));
});

test('buildContextWindow prioritizes recently edited blocks', () => {
  const ctrl = makeController();
  const now = Date.now();
  const blocks = [];
  // 60 blocks, most with old timestamps
  for (let i = 0; i < 60; i++) {
    blocks.push(makeBlock('text', `Block${i}_` + 'Z'.repeat(490), {
      id: `b${i}`,
      updatedAt: i === 55 ? now : now - 100000,
    }));
  }

  const result = ctrl.buildContextWindow(blocks, 0);

  assert.equal(result.isWindowed, true);
  // Block 55 was recently edited, should be included
  assert.ok(result.content.includes('Block55_'));
});

test('buildContextWindow returns percentage reflecting included content', () => {
  const ctrl = makeController();
  const blocks = [];
  for (let i = 0; i < 100; i++) {
    blocks.push(makeBlock('text', 'W'.repeat(400)));
  }
  // Total = 40000 chars, limit = 24000

  const result = ctrl.buildContextWindow(blocks, 50);

  assert.equal(result.isWindowed, true);
  assert.ok(result.percentage >= 1);
  assert.ok(result.percentage <= 99);
});

test('buildContextWindow handles empty blocks array', () => {
  const ctrl = makeController();
  const result = ctrl.buildContextWindow([], -1);

  assert.equal(result.isWindowed, false);
  assert.equal(result.percentage, 100);
  assert.equal(result.content, '');
});

test('buildContextWindow respects custom token limit', () => {
  const ctrl = makeController();
  const blocks = [
    makeBlock('text', 'A'.repeat(2000)),
    makeBlock('text', 'B'.repeat(2000)),
  ];
  // Total = 4000 chars. Default limit = 24000 chars, so no windowing.
  // But with tokenLimit=500 (2000 chars), should window.
  const result = ctrl.buildContextWindow(blocks, -1, { tokenLimit: 500 });

  assert.equal(result.isWindowed, true);
  assert.ok(result.percentage < 100);
});
