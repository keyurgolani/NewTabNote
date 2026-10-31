/**
 * Embedding Manager - handles local vector generation using transformers.js
 */
class EmbeddingManager {
    constructor() {
        this.modelName = 'Xenova/all-MiniLM-L6-v2';
        this.pipeline = null;
        this.isLoading = false;
        this.isReady = false;
        /**
         * The page's failure events (#20, "Diagnostic journal"), which App sets: a model that
         * won't load is an `embeddings.load-failed` event, with the error's name and never its
         * message. Null until set, and then a failed load does only what it did before.
         * @type {{event: (code: string, fields?: Object, failure?: unknown) => void} | null}
         */
        this.events = null;
        // generateEmbedding tries the load again for every note it embeds, so only the first
        // failure on this page is reported
        this.loadFailureReported = false;
        /**
         * The page loader's loadLibrary (js/runtime/lazy.js), which App sets: transformers.js loads
         * through it at the model's first load (#27 slice 3). Null until set, and then
         * transformers.js is the global its script defined, as before.
         * @type {((name: string) => Promise<any>) | null}
         */
        this.loadLibrary = null;
    }

    /**
     * Initialize the embedding pipeline.
     * @returns {Promise<void>}
     */
    async init() {
        if (this.pipeline || this.isLoading) return;

        this.isLoading = true;
        const startedAt = Date.now();
        console.debug('Embeddings: Loading model...', this.modelName);

        try {
            const { env, pipeline } = await this.transformersLibrary();

            // Configure for Chrome extension environment
            env.allowRemoteModels = true;
            // Disable ONNX worker proxying - blob: URLs are blocked by extension CSP
            env.backends.onnx.wasm.proxy = false;
            env.backends.onnx.wasm.numThreads = 1;
            this.pipeline = await pipeline('feature-extraction', this.modelName);
            this.isReady = true;
            console.debug('Embeddings: Model loaded successfully');
        } catch (error) {
            console.error('Embeddings: Failed to load model:', error);
            if (this.events && !this.loadFailureReported) {
                this.loadFailureReported = true;
                this.events.event('embeddings.load-failed', { durationMs: Math.max(0, Date.now() - startedAt) }, error);
            }
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * transformers.js: through the page's loader, or the global without it. One that didn't load
     * throws, so the model's load fails as it did before: an embeddings.load-failed event.
     * @returns {Promise<any>}
     */
    async transformersLibrary() {
        if (!this.loadLibrary) return transformers;
        const loaded = await this.loadLibrary('transformers');
        if (loaded.status === 'loaded') return loaded.module;
        throw new Error(`transformers.js didn't load (${loaded.reason})`);
    }

    /**
     * Generate embedding for a given text.
     * @param {string} text - Text to embed
     * @returns {Promise<Array<number>|null>} Embedding vector or null on failure
     */
    async generateEmbedding(text) {
        if (!this.isReady) await this.init();
        if (!this.pipeline) return null;

        try {
            // Mean pooling is usually better for sentence embeddings
            const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
            return Array.from(output.data);
        } catch (error) {
            console.error('Embeddings: Generation failed:', error);
            return null;
        }
    }

    /**
     * Calculate cosine similarity between two vectors.
     * @param {Array<number>} vecA - First vector
     * @param {Array<number>} vecB - Second vector
     * @returns {number} Cosine similarity (0-1)
     */
    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}

// Global instance
const Embeddings = new EmbeddingManager();
(typeof window !== 'undefined' ? window : self).Embeddings = Embeddings;
