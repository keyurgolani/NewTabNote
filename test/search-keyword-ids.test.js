'use strict';

// A keyword match names its note (a 1.4.x fix, #22). Search entries carry the note's id as
// `noteId`, as the indexer writes them (js/workers/indexer.js), and every caller of
// SearchEngine.search reads a match's `id`. In 1.4.x and until this fix a Fuse.js match had no
// `id`, so the sidebar said "No matching notes" for a note it lists, the AI chat's All Notes found
// no note to answer from, and Related Notes drew one "Untitled" item for every keyword match. A
// match the model alone found looked its entry up by `id` too, and came back without its name.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Fuse = require('../js/lib/fuse.js');
const { createLegacyEnv, createDatabase, bootNewTab, NEW_TAB_FILES, FakeDocument, note, block, runUntil, plain } = require('./helpers/legacy-env');

/** The entries the indexer writes for notes A and B */
const ENTRIES = [
  { noteId: 'A', name: 'Camping trip', content: 'Pack the tent and the stove', tags: [], updatedAt: 1 },
  { noteId: 'B', name: 'Groceries', content: 'Milk and bread', tags: [], updatedAt: 1 },
];

const FILES = [...NEW_TAB_FILES, 'js/search.js', 'js/controllers/ai-chat-controller.js', 'js/app.js'];

/** A SearchEngine with the vendored Fuse.js, as the page's loader gives it */
function engineIn(env) {
  const SearchEngine = env.get('SearchEngine');
  return new SearchEngine({}, { loadLibrary: async () => ({ status: 'loaded', module: Fuse }) });
}

/** A new tab over notes A and B and their search entries */
async function page() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('A', { name: 'Camping trip' }), note('B', { name: 'Groceries' })],
      elements: [block('a1', 'A', 0, 'Pack the tent and the stove'), block('b1', 'B', 0, 'Milk and bread')],
      search_index: ENTRIES,
    },
  });
  const booted = await bootNewTab(env, { files: FILES });
  return { env, ...booted, searchEngine: engineIn(env) };
}

describe('a keyword match names its note (js/search.js)', () => {
  it("a match for a note's title, or a word in its text, is that note", async () => {
    const env = createLegacyEnv({ document: null });
    env.load('js/search.js');
    const searchEngine = engineIn(env);
    await searchEngine.updateIndex(ENTRIES);
    const ids = async (query) => plain((await searchEngine.search(query)).map((match) => match.id));
    assert.deepEqual(await ids('Camping'), ['A']);
    assert.deepEqual(await ids('tent'), ['A']);
    assert.deepEqual(await ids('bread'), ['B']);
  });

  it("a match the model alone found carries its note's entry, name included", async () => {
    const env = createLegacyEnv({ document: null });
    env.load('js/search.js', 'js/embeddings.js');
    const Embeddings = env.get('Embeddings');
    // The model, loaded: every text embeds as note B's vector does
    Embeddings.isReady = true;
    Embeddings.pipeline = async () => ({ data: [1, 0] });
    const searchEngine = engineIn(env);
    await searchEngine.updateIndex(ENTRIES);
    searchEngine.setVectors([{ noteId: 'B', vector: [1, 0] }]);
    const matches = plain(await searchEngine.search('zzz'));
    assert.deepEqual(matches.map((match) => [match.id, match.name, match.isSemantic]), [['B', 'Groceries', true]]);
  });

  it('a match whose entry already names its note as id keeps it', async () => {
    const env = createLegacyEnv({ document: null });
    env.load('js/search.js');
    const searchEngine = engineIn(env);
    await searchEngine.updateIndex([{ id: 'A', name: 'Camping trip', content: '' }]);
    assert.deepEqual(plain((await searchEngine.search('Camping')).map((match) => match.id)), ['A']);
  });

  it('the sidebar lists the note a title matches', async () => {
    const { env, searchEngine } = await page();
    env.document.stub(['sidebar-notes-list']);
    const sidebar = new (env.get('SidebarController'))({
      settings: env.settingsClient, domRefs: null, logger: null, documentClient: env.documentClient, storageState: { missingStores: [] },
    });
    sidebar.searchEngine = searchEngine;
    sidebar.getEditor = () => null;
    sidebar.noteList = env.noteList;
    sidebar.searchQuery = 'Camping';
    await runUntil(env, sidebar.renderNotesList());
    const list = env.document.getElementById('sidebar-notes-list');
    assert.deepEqual(list.querySelectorAll('.sidebar-note-name').map((name) => name.textContent), ['Camping trip']);
    assert.ok(list.querySelectorAll('.sidebar-empty').length === 0, 'no empty-list line');
  });

  it("All Notes answers from the note a word in its text matches", async () => {
    const { env, searchEngine } = await page();
    env.document.stub(['global-chat-messages', 'global-chat-loading', 'global-chat-loading-text', { id: 'global-chat-input', tag: 'textarea' }]);
    const chat = new (env.get('AIChatController'))({
      settings: env.settingsClient, domRefs: null, logger: null, llm: { isConfigured: () => true }, documentClient: env.documentClient,
    });
    chat.searchEngine = searchEngine;
    chat.saveGlobalChatHistory = async () => {};
    const asked = [];
    chat._streamResponse = async (container, messages) => {
      asked.push(messages);
      return true;
    };
    // A word its text starts with: All Notes keeps a match above 0.3, which Fuse.js gives a word near the start
    env.document.getElementById('global-chat-input').value = 'pack';
    await runUntil(env, chat.sendGlobalChatMessage());
    assert.equal(asked.length, 1, 'it answers, not "I couldn\'t find any notes"');
    assert.match(asked[0][0].content, /## Camping trip\nPack the tent and the stove/);
    assert.doesNotMatch(asked[0][0].content, /Groceries/);
  });

  it("Related Notes names the note a keyword matches, not one Untitled item, and leaves out the note that's open", async () => {
    const { env, searchEngine } = await page();
    env.document.stub(['ai-smart-empty', 'ai-smart-results', 'ai-suggested-tags', 'ai-extracted-actions', 'ai-related-notes']);
    const chat = new (env.get('AIChatController'))({
      settings: env.settingsClient, domRefs: null, logger: null,
      llm: { isConfigured: () => true, extractInsights: async () => ({ todos: [] }) }, documentClient: env.documentClient,
    });
    await searchEngine.updateIndex(ENTRIES);
    chat.searchEngine = searchEngine;
    chat.noteList = env.noteList;
    chat.aiSidebarOpen = true;
    chat.aiActiveTab = 'smart';
    const related = () => env.document.getElementById('ai-related-notes').querySelectorAll('.ai-related-title').map((title) => title.textContent);
    // The open note's text is word for word what note A holds
    const text = 'Pack the tent and the stove';
    chat.getEditor = () => ({ noteId: 'B', noteData: { id: 'B', name: 'Groceries' }, getAllBlocksTextContent: () => text, titleEl: null });
    await runUntil(env, chat.updateSmartSuggestions());
    assert.deepEqual(related(), ['Camping trip']);
    chat.getEditor = () => ({ noteId: 'A', noteData: { id: 'A', name: 'Camping trip' }, getAllBlocksTextContent: () => text, titleEl: null });
    await runUntil(env, chat.updateSmartSuggestions());
    assert.deepEqual(related(), [], "the open note isn't related to itself");
  });
});
