/**
 * Search Engine - handles fuzzy search and result ranking
 */
class SearchEngine {
    constructor(options = {}) {
        this.fuse = null;
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
     * Initialize or update the index with new data
     */
    async updateIndex(data) {
        this.fuse = new Fuse(data, this.options);
    }

    /**
     * Set vectors for semantic search
     */
    setVectors(vectors) {
        this.vectors = vectors || [];
    }

    /**
     * Perform hybrid search (Keyword + Semantic)
     */
    async search(query) {
        if (!query) return [];

        // 1. Keyword Search (Fuse.js)
        let keywordResults = [];
        if (this.fuse) {
            keywordResults = this.fuse.search(query).map(result => ({
                ...result.item,
                keywordScore: 1 - result.score, // Convert 0 (perfect) to 1 (perfect)
                matches: result.matches
            }));
        }

        // 2. Semantic Search (Vectors)
        let semanticResults = [];
        if (typeof Embeddings !== 'undefined' && this.vectors.length > 0) {
            const queryVector = await Embeddings.generateEmbedding(query);
            if (queryVector) {
                semanticResults = this.vectors.map(item => {
                    const similarity = Embeddings.cosineSimilarity(queryVector, item.vector);
                    return {
                        id: item.noteId,
                        semanticScore: similarity
                    };
                }).filter(r => r.semanticScore > 0.6); // Threshold for semantic relevance
            }
        }

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
        const item = this.fuse._docs.find(doc => doc.id === id);
        return item || { id };
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
