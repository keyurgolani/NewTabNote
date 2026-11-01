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
        // Try again can fail again, and only the first failure on this page is reported
        this.loadFailureReported = false;
        /**
         * The page loader's loadLibrary (js/runtime/lazy.js), which App sets: transformers.js loads
         * through it at the model's first load (#27 slice 3). Null until set, and then
         * transformers.js is the global its script defined, as before.
         * @type {((name: string) => Promise<any>) | null}
         */
        this.loadLibrary = null;
        /**
         * Told true while the model's files come from the network, its first download, and
         * false when the load ends, which App passes to the places that show the model's status
         * (#27 slice 3b). Null until set.
         * @type {((downloading: boolean) => void) | null}
         */
        this.onDownload = null;
        /** @type {Promise<any> | null} The load, held until Try again runs its retry */
        this._loading = null;
        /** @type {(() => Promise<any>) | null} A failed transformers.js load's retry, which the loader holds it for */
        this._libraryRetry = null;
        this._downloading = false;
    }

    /**
     * Load the model: transformers.js through the page's loader, then its pipeline, whose files
     * come from the network the first time and from the browser's cache after. Answers a Result
     * (#27 slice 3b): loaded, or failed with a reason and a retry. A failure holds until its retry
     * runs, which a place's Try again does, so a query or a note to embed never starts the load
     * again, and search and Related Notes show one state.
     * @returns {Promise<any>}
     */
    init() {
        if (!this._loading) this._loading = this._load();
        return this._loading;
    }

    /**
     * @returns {Promise<any>}
     */
    async _load() {
        this.isLoading = true;
        const startedAt = Date.now();
        console.debug('Embeddings: Loading model...', this.modelName);

        try {
            const library = await this.transformersLibrary();
            if (library.status !== 'loaded') {
                this._libraryRetry = library.retry || null;
                return this._failed(library.reason, startedAt, new Error(`transformers.js didn't load (${library.reason})`));
            }
            const { env, pipeline } = library.module;

            // Configure for Chrome extension environment
            env.allowRemoteModels = true;
            // Disable ONNX worker proxying - blob: URLs are blocked by extension CSP
            env.backends.onnx.wasm.proxy = false;
            env.backends.onnx.wasm.numThreads = 1;
            this.pipeline = await pipeline('feature-extraction', this.modelName, {
                progress_callback: (progress) => this._progress(progress, env),
            });
            this.isReady = true;
            console.debug('Embeddings: Model loaded successfully');
            return { status: 'loaded', module: this.pipeline };
        } catch (error) {
            // The model's files didn't come, or its runtime didn't start: Try again can help
            return this._failed('model-failed', startedAt, error);
        } finally {
            this.isLoading = false;
            this._setDownloading(false);
        }
    }

    /**
     * A failed load: the embeddings.load-failed event once per page, and the Result whose retry
     * loads the model again
     * @param {string} reason
     * @param {number} startedAt
     * @param {unknown} error
     * @returns {{status: 'failed', reason: string, retry: () => Promise<any>}}
     */
    _failed(reason, startedAt, error) {
        console.error('Embeddings: Failed to load model:', error);
        if (this.events && !this.loadFailureReported) {
            this.loadFailureReported = true;
            this.events.event('embeddings.load-failed', { durationMs: Math.max(0, Date.now() - startedAt) }, error);
        }
        return { status: 'failed', reason, retry: () => this.retry() };
    }

    /**
     * Try again: the model's load once more, and the held failure goes
     * @returns {Promise<any>}
     */
    retry() {
        if (this.isReady) return this.init();
        this._loading = null;
        return this.init();
    }

    /**
     * transformers.js: through the page's loader, or the global without it. After a failed load
     * it's the failure's retry, since the loader holds the failure until that runs.
     * @returns {Promise<any>} the loader's Result
     */
    async transformersLibrary() {
        const retry = this._libraryRetry;
        this._libraryRetry = null;
        if (retry) return retry();
        if (!this.loadLibrary) return { status: 'loaded', module: transformers };
        return this.loadLibrary('transformers');
    }

    /**
     * pipeline()'s progress: a file it starts that the browser's cache doesn't hold comes from the
     * network, which is the model's first download
     * @param {any} progress
     * @param {any} env - transformers.js's
     * @returns {void}
     */
    _progress(progress, env) {
        if (!progress || progress.status !== 'initiate' || this._downloading) return;
        this._fromNetwork(progress.file, env).then((network) => {
            if (network && this.isLoading) this._setDownloading(true);
        }, () => {});
    }

    /**
     * Whether transformers.js's cache misses `file`, so it comes from the network
     * @param {string} file
     * @param {any} env
     * @returns {Promise<boolean>}
     */
    async _fromNetwork(file, env) {
        if (typeof caches === 'undefined' || !file || !env.useBrowserCache) return false;
        const cache = await caches.open('transformers-cache');
        const path = String(env.remotePathTemplate).split('{model}').join(this.modelName).split('{revision}').join('main');
        const url = [String(env.remoteHost), path, file].map((part, i) => (i === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, ''))).join('/');
        return !(await cache.match(url));
    }

    /**
     * @param {boolean} downloading
     * @returns {void}
     */
    _setDownloading(downloading) {
        if (this._downloading === downloading) return;
        this._downloading = downloading;
        if (this.onDownload) this.onDownload(downloading);
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
