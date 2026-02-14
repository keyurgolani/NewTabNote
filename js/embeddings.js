/**
 * Embedding Manager - handles local vector generation using transformers.js
 */
class EmbeddingManager {
    constructor() {
        this.modelName = 'Xenova/all-MiniLM-L6-v2';
        this.pipeline = null;
        this.isLoading = false;
        this.isReady = false;
    }

    /**
     * Initialize the embedding pipeline
     */
    async init() {
        if (this.pipeline || this.isLoading) return;

        this.isLoading = true;
        console.log('Embeddings: Loading model...', this.modelName);

        try {
            const { env, pipeline } = transformers;

            // Configure for Chrome extension environment
            env.allowRemoteModels = true;
            // Disable ONNX worker proxying - blob: URLs are blocked by extension CSP
            env.backends.onnx.wasm.proxy = false;
            env.backends.onnx.wasm.numThreads = 1;
            this.pipeline = await pipeline('feature-extraction', this.modelName);
            this.isReady = true;
            console.log('Embeddings: Model loaded successfully');
        } catch (error) {
            console.error('Embeddings: Failed to load model:', error);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Generate embedding for a given text
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
     * Calculate cosine similarity between two vectors
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
