'use strict';

// Related Notes keeps its keyword query short. Fuse splits a pattern over 32 characters into
// 32-character pieces and runs each one over every entry, so Related Notes hands it at most 32:
// the open note's name, or the start of its text when the note has no name of its own (empty,
// or the default). The semantic half still compares the note's whole text.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv } = require('./helpers/legacy-env');

/** A long note's text, as the editor gives it */
const TEXT = '  Planning notes for the quarter, with every open question. '.repeat(40);

/**
 * Related Notes on the open note named `name` with TEXT, against an index of one other note;
 * returns the patterns Fuse was given, the texts the semantic half compared, and what it showed
 */
async function relatedNotes(name) {
  const env = createLegacyEnv();
  const compared = [];
  env.global.Embeddings = {
    generateEmbedding: async (text) => {
      compared.push(text);
      return [1, 0];
    },
    cosineSimilarity: () => 0.9,
  };
  env.load('js/utils.js', 'js/lib/fuse.js', 'js/search.js', 'js/controllers/ai-chat-controller.js');
  const search = new (env.get('SearchEngine'))();
  search.setVectors([{ noteId: 'n2', vector: [1, 0] }]);
  await search.updateIndex([{ noteId: 'n2', name: 'Roadmap', content: 'Planning for the quarter', tags: [], updatedAt: 1 }]);
  const patterns = [];
  const fuseSearch = search.fuse.search.bind(search.fuse);
  search.fuse.search = (pattern, ...rest) => {
    patterns.push(pattern);
    return fuseSearch(pattern, ...rest);
  };
  const shown = [];
  const chat = Object.create(env.get('AIChatController').prototype);
  Object.assign(chat, {
    // The Insights tab, in the open AI sidebar
    aiSidebarOpen: true,
    aiActiveTab: 'smart',
    searchEngine: search,
    getEditor: () => ({ noteId: 'n1', noteData: { id: 'n1', name }, getAllBlocksTextContent: () => TEXT, titleEl: { textContent: name } }),
    llm: { extractInsights: async () => null },
    renderSmartInsights: (insights, related) => shown.push(Array.from(related, note => note.id)),
  });
  await chat.updateSmartSuggestions(true);
  return { patterns, compared, shown };
}

describe('Related Notes keeps its keyword query short', () => {
  it("a long note's keyword query is its name, cut to 32 characters, and the semantic half gets the whole text", async () => {
    const name = 'Quarterly planning notes for the design team';
    const { patterns, compared, shown } = await relatedNotes(name);
    assert.deepEqual(patterns, [name.slice(0, 32)]);
    assert.deepEqual(compared, [TEXT]);
    assert.deepEqual(shown, [['n2']]);
  });

  it('a note with no name of its own, empty or the default, uses the first 32 characters of its text', async () => {
    for (const name of ['', '   ', 'Untitled']) {
      const { patterns, compared } = await relatedNotes(name);
      assert.deepEqual(patterns, [TEXT.trim().slice(0, 32)], JSON.stringify(name));
      assert.deepEqual(compared, [TEXT], JSON.stringify(name));
    }
  });

  it('a short name is the whole query', async () => {
    const { patterns } = await relatedNotes('Roadmap');
    assert.deepEqual(patterns, ['Roadmap']);
  });
});
