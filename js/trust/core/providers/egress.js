/**
 * The packaged list of uncovered egress (#20, "Providers", Permissions and destinations): the
 * places this build's pages reach that no Chrome permission covers, so chrome.permissions
 * can't show them. Each is a fixed origin in shipped code, with how it's reached, what it
 * sends, and the files that reach it. The words a view shows for each are slice 4's.
 * test/kernel/trust-permissions.test.mjs fails when the manifest's CSP lets a page reach an
 * origin that's neither a host permission nor on this list, or when one of these files stops
 * naming its origin.
 *
 * Destinations a user enters (a WebDAV server, an Ollama URL) aren't fixed, so they're not
 * here: #21 adds user origins.
 */

/**
 * @typedef {Readonly<{
 *   id: string,
 *   origins: readonly string[],
 *   reachedBy: 'image' | 'frame' | 'fetch',
 *   sends: 'hostname' | 'video-id' | 'model-request',
 *   sources: readonly string[],
 * }>} Egress
 */

/** @type {readonly Egress[]} */
export const UNCOVERED_EGRESS = Object.freeze([
  Object.freeze({
    id: 'favicons',
    origins: Object.freeze(['https://www.google.com']),
    reachedBy: /** @type {const} */ ('image'),
    sends: /** @type {const} */ ('hostname'),
    sources: Object.freeze(['js/utils.js', 'js/editor.js']),
  }),
  Object.freeze({
    id: 'video-embeds',
    origins: Object.freeze(['https://www.youtube.com', 'https://player.vimeo.com']),
    reachedBy: /** @type {const} */ ('frame'),
    sends: /** @type {const} */ ('video-id'),
    sources: Object.freeze(['js/blocks.js']),
  }),
  Object.freeze({
    id: 'embedding-model',
    origins: Object.freeze(['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co']),
    reachedBy: /** @type {const} */ ('fetch'),
    sends: /** @type {const} */ ('model-request'),
    sources: Object.freeze(['js/embeddings.js', 'js/lib/transformers.js']),
  }),
  Object.freeze({
    id: 'model-runtime',
    origins: Object.freeze(['https://cdn.jsdelivr.net']),
    reachedBy: /** @type {const} */ ('fetch'),
    sends: /** @type {const} */ ('model-request'),
    sources: Object.freeze(['js/lib/transformers.js']),
  }),
]);

/** Every origin on the list */
export const UNCOVERED_ORIGINS = Object.freeze(UNCOVERED_EGRESS.flatMap(egress => egress.origins));
