'use strict';

// Related Notes keeps its keyword query short (a 1.4.x fix, #126, ported). Fuse splits a pattern
// over 32 characters into 32-character pieces and runs each one over every entry, so Related
// Notes hands it at most 32: the open note's name, or the start of its text when the note has no
// name of its own (empty, or the default). The semantic half still compares the note's whole
// text. Both ways drawRelatedNotes draws hold to it: ranked together once the model is loaded, and
// keyword matches first while it loads.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Fuse = require('../js/lib/fuse.js');
const { createLegacyEnv, plain } = require('./helpers/legacy-env');

/** A long note's text, as the editor gives it */
const TEXT = '  Planning notes for the quarter, with every open question. '.repeat(40);

/**
 * Related Notes on the open note named `name` with TEXT, against an index of one other note, with
 * the model loaded or still loading; answers the patterns Fuse was given, the texts the semantic
 * half compared, and the notes each draw listed
 */
async function relatedNotes(name, { modelLoaded = true } = {}) {
  const env = createLegacyEnv({ document: null });
  const compared = [];
  env.global.Embeddings = {
    isReady: modelLoaded,
    init: async () => ({ status: 'loaded' }),
    generateEmbedding: async (text) => {
      compared.push(text);
      return [1, 0];
    },
    cosineSimilarity: () => 0.9,
  };
  env.load('js/search.js', 'js/controllers/ai-chat-controller.js');
  const SearchEngine = env.get('SearchEngine');
  const search = new SearchEngine({}, { loadLibrary: async () => ({ status: 'loaded', module: Fuse }) });
  await search.updateIndex([{ noteId: 'n2', name: 'Roadmap', content: 'Planning for the quarter', tags: [], updatedAt: 1 }]);
  search.setVectors([{ noteId: 'n2', vector: [1, 0] }]);
  const patterns = [];
  const fuseSearch = search.fuse.search.bind(search.fuse);
  search.fuse.search = (pattern, ...rest) => {
    patterns.push(pattern);
    return fuseSearch(pattern, ...rest);
  };
  const drawn = [];
  const chat = Object.create(env.get('AIChatController').prototype);
  Object.assign(chat, {
    _relatedTurn: 0,
    searchEngine: search,
    // Related Notes' line for the model's status; the model loads at once when asked
    relatedPlace: () => ({ clear() {}, fail() {}, loading: async (load) => load() }),
    renderRelatedNotes: (related) => drawn.push(Array.from(related, (note) => note.id)),
  });
  await chat.drawRelatedNotes({ noteId: 'n1', noteData: { id: 'n1', name } }, TEXT);
  return plain({ patterns, compared, drawn });
}

for (const modelLoaded of [true, false]) {
  describe(`Related Notes keeps its keyword query short, ${modelLoaded ? 'with the model loaded' : 'while the model loads'}`, () => {
    it("a long note's keyword query is its name, cut to 32 characters, and the semantic half gets the whole text", async () => {
      const name = 'Quarterly planning notes for the design team';
      const { patterns, compared, drawn } = await relatedNotes(name, { modelLoaded });
      assert.deepEqual(patterns, [name.slice(0, 32)]);
      assert.deepEqual(compared, [TEXT]);
      assert.deepEqual(drawn[drawn.length - 1], ['n2']);
    });

    it('a note with no name of its own, empty or the default, uses the first 32 characters of its text', async () => {
      for (const name of ['', '   ', 'Untitled']) {
        const { patterns, compared } = await relatedNotes(name, { modelLoaded });
        assert.deepEqual(patterns, [TEXT.trim().slice(0, 32)], JSON.stringify(name));
        assert.deepEqual(compared, [TEXT], JSON.stringify(name));
      }
    });

    it('a short name is the whole query', async () => {
      const { patterns } = await relatedNotes('Roadmap', { modelLoaded });
      assert.deepEqual(patterns, ['Roadmap']);
    });
  });
}
