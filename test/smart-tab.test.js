'use strict';

// #12 slice 6, a declared privacy fix: the AI sidebar's Smart tab sends the note's text to the
// provider (extractInsights) only while the sidebar is open on it. 1.4.1 sent it on every edit
// while Smart was the last AI tab chosen, the sidebar closed or not. Opening the sidebar on
// Smart refreshes it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

const TEXT = 'Milk, eggs, and bread for the week, and the bakery on Sunday morning';

/** AIChatController on the page, with an editor holding a note and a stub provider */
function smartTab() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.load('js/utils.js', 'js/controllers/ai-chat-controller.js');
  env.document.stub(['ai-sidebar', 'ai-floating-btn', 'ai-chat-input']);
  const calls = [];
  const chat = new (env.get('AIChatController'))({
    storage: null,
    settings: null,
    domRefs: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      isConfigured: () => true,
      extractInsights: async (text) => {
        calls.push(text);
        return { todos: [] };
      },
    },
  });
  const editor = { noteId: 'A', noteData: { id: 'A', name: 'Groceries' }, getAllBlocksTextContent: () => TEXT, titleEl: null };
  Object.assign(chat, {
    getEditor: () => editor,
    searchEngine: null,
    renderSmartInsights: () => {},
    updateAISidebarState: () => {},
  });
  // Smart was the last AI tab chosen
  chat.aiActiveTab = 'smart';
  return { env, chat, calls };
}

/** What App's editor change handler runs after an edit */
const edit = (chat) => chat.updateSmartSuggestions();

describe('the Smart tab sends note text to the provider only while it shows', () => {
  it('with the AI sidebar closed, an edit makes no extractInsights call', async () => {
    const { chat, calls } = smartTab();
    chat.aiSidebarOpen = false;
    await edit(chat);
    assert.deepEqual(calls, []);
  });

  it('with the sidebar open on Smart, an edit extracts, as 1.4.x did', async () => {
    const { chat, calls } = smartTab();
    chat.aiSidebarOpen = true;
    await edit(chat);
    assert.deepEqual(calls, [TEXT]);
  });

  it('opening the sidebar on Smart refreshes it, and closing it again stops the next edit', async () => {
    const { chat, calls } = smartTab();
    chat.aiSidebarOpen = false;
    chat.openAISidebar();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [TEXT], 'opening it drew the Smart tab');

    chat.closeAISidebar();
    await edit(chat);
    assert.equal(calls.length, 1);
  });

  it('with the sidebar open on another tab, an edit makes no call', async () => {
    const { chat, calls } = smartTab();
    chat.aiSidebarOpen = true;
    chat.aiActiveTab = 'note';
    await edit(chat);
    assert.deepEqual(calls, []);
  });
});
