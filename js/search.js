/**
 * Search Engine - handles fuzzy search and result ranking
 */
class SearchEngine {
    /**
     * @param {Object} [options] - Fuse.js's, over these defaults
     * @param {{loadLibrary?: Function|null}} [ports] - App's: the page loader's loadLibrary, which
     *   Fuse.js loads through at the first index (#27 slice 3). Without it, Fuse.js is the global
     *   its script defined, as before.
     */
    constructor(options = {}, { loadLibrary = null } = {}) {
        this.fuse = null;
        this.loadLibrary = loadLibrary;
        /** @type {Array<{noteId: string, vector: Array<number>}>} */
        this.vectors = [];
        this.options = {
            keys: [
                { name: 'name', weight: 0.7 },
                { name: 'content', weight: 0.3 },
                { name: 'tags', weight: 0.5 }
            ],
            threshold: 0.4,
            includeScore: true,
            includeMatches: true,
            ...options
        };
    }

    /**
     * Initialize or update the search index with new data. Answers the loader's Result for
     * Fuse.js (#27 slice 3b): loaded, or failed with its reason and retry, when the index stays
     * as it was and each caller says so where its results go.
     * @param {Array<Object>} data - Array of indexable items
     * @returns {Promise<any>}
     */
    async updateIndex(data) {
        const loaded = await this.fuseLibrary();
        if (loaded.status === 'loaded') this.fuse = new loaded.module(data, this.options);
        return loaded;
    }

    /**
     * Fuse.js: through the page's loader, at the first index, or the global without it
     * @returns {Promise<any>} the loader's Result
     */
    async fuseLibrary() {
        if (!this.loadLibrary) return { status: 'loaded', module: Fuse };
        return this.loadLibrary('fuse');
    }

    /**
     * Set vectors for semantic search.
     * @param {Array<{noteId: string, vector: Array<number>}>} vectors - Embedding vectors
     * @returns {void}
     */
    setVectors(vectors) {
        this.vectors = vectors || [];
    }

    /**
     * Whether the model's matches join the keyword ones: the notes have vectors to match
     * @returns {boolean}
     */
    get semantic() {
        return typeof Embeddings !== 'undefined' && this.vectors.length > 0;
    }

    /**
     * Keyword matches from the index Fuse.js built, best first; none without an index
     * @param {string} query
     * @returns {Array<any>}
     */
    keywordSearch(query) {
        if (!query || !this.fuse) return [];
        return this.fuse.search(query).map(result => ({
            ...result.item,
            // Search entries name their note as noteId, as the indexer writes them
            id: result.item.noteId ?? result.item.id,
            keywordScore: 1 - result.score, // Convert 0 (perfect) to 1 (perfect)
            matches: result.matches
        }));
    }

    /**
     * The model's matches for `query`, by its vectors: none while the model isn't loaded or the
     * notes have none
     * @param {string} query
     * @returns {Promise<Array<{id: string, semanticScore: number}>>}
     */
    async semanticSearch(query) {
        if (!query || !this.semantic) return [];
        const queryVector = await Embeddings.generateEmbedding(query);
        if (!queryVector) return [];
        return this.vectors.map(item => {
            const similarity = Embeddings.cosineSimilarity(queryVector, item.vector);
            return {
                id: item.noteId,
                semanticScore: similarity
            };
        }).filter(r => r.semanticScore > 0.6); // Threshold for semantic relevance
    }

    /**
     * Perform hybrid search combining keyword and semantic results.
     * @param {string} query - Search query
     * @returns {Promise<Array<{id: string, score: number, isSemantic?: boolean}>>} Ranked search results
     */
    async search(query) {
        if (!query) return [];

        // 1. Keyword Search (Fuse.js)
        const keywordResults = this.keywordSearch(query);

        // 2. Semantic Search (Vectors)
        const semanticResults = await this.semanticSearch(query);

        // 3. Combine and Rank
        const combined = new Map();

        // Add keyword results
        keywordResults.forEach(r => {
            combined.set(r.id, { ...r, score: r.keywordScore, isSemantic: false });
        });

        // Add/Update with semantic results
        semanticResults.forEach(r => {
            if (combined.has(r.id)) {
                const existing = combined.get(r.id);
                // Hybrid score: Weighted average
                existing.score = (existing.keywordScore * 0.4) + (r.semanticScore * 0.6);
                existing.isSemantic = true;
                existing.semanticScore = r.semanticScore;
            } else {
                // Pure semantic result (finds the note even if keywords don't match)
                // We need to find the item data from vectors if it wasn't in keyword results
                combined.set(r.id, {
                    id: r.id,
                    score: r.semanticScore * 0.8, // Slightly penalize pure semantic vs hybrid
                    isSemantic: true,
                    semanticScore: r.semanticScore
                });
            }
        });

        return Array.from(combined.values())
            .sort((a, b) => b.score - a.score)
            .map(item => ({
                ...item,
                // Ensure name and other fields are present if it was a pure semantic hit
                ...(item.name ? {} : this.getItemDataById(item.id))
            }));
    }

    /**
     * Helper to get note data if it didn't come from Fuse results
     */
    getItemDataById(id) {
        if (!this.fuse) return { id };
        // Its entry, which names the note as noteId, as a keyword match does
        const item = this.fuse._docs.find(doc => (doc.noteId ?? doc.id) === id);
        return item ? { ...item, id } : { id };
    }

    /**
     * Extract tags from text content (#tag format)
     */
    static extractTags(text) {
        if (!text) return [];
        const tagRegex = /#([\w-]+)/g;
        const matches = text.matchAll(tagRegex);
        const tags = new Set();
        for (const match of matches) {
            tags.add(match[1].toLowerCase());
        }
        return Array.from(tags);
    }
}

(typeof window !== 'undefined' ? window : self).SearchEngine = SearchEngine;
