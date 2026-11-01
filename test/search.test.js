'use strict';

// SearchEngine names each result by its note's id, for keyword matches as for semantic ones:
// the sidebar, the All Notes chat and Related Notes look notes up by a result's id.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv } = require('./helpers/legacy-env');

/** An entry as the indexer and Storage.getSearchIndex give it */
const entry = (noteId, name, content = '', tags = []) => ({ noteId, name, content, tags, updatedAt: 1 });

function engine({ vectors = [], embeddings } = {}) {
  const env = createLegacyEnv();
  env.load('js/lib/fuse.js', 'js/search.js');
  if (embeddings) env.global.Embeddings = embeddings;
  const SearchEngine = env.get('SearchEngine');
  const search = new SearchEngine();
  search.setVectors(vectors);
  return search;
}

describe('search results name their notes', () => {
  it('a keyword match names the note it matched', async () => {
    const search = engine();
    await search.updateIndex([entry('n1', 'Groceries', 'Buy saffron and limes'), entry('n2', 'Errands', 'Return the library books')]);
    const results = await search.search('saffron');
    assert.deepEqual(Array.from(results, r => r.id), ['n1']);
  });

  it('every keyword match is its own result, by its own note', async () => {
    const search = engine();
    await search.updateIndex([entry('n1', 'Plan for Monday'), entry('n2', 'Plan for Tuesday'), entry('n3', 'Recipes')]);
    const ids = Array.from(await search.search('plan'), r => r.id).sort();
    assert.deepEqual(ids, ['n1', 'n2']);
  });

  it('a semantic match that no keyword matched gets its note from the index', async () => {
    const search = engine({
      vectors: [{ noteId: 'n2', vector: [1, 0] }],
      embeddings: { generateEmbedding: async () => [1, 0], cosineSimilarity: () => 0.9 },
    });
    await search.updateIndex([entry('n1', 'Groceries'), entry('n2', 'Errands')]);
    const [hit] = await search.search('zzz');
    assert.equal(hit.id, 'n2');
    assert.equal(hit.name, 'Errands');
  });
});
