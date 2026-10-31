/**
 * Offscreen document for New Tab Note
 * Handles the worker's requests to the Ollama URL. It's an extension page with the
 * http://localhost/* host permission, so its fetch gets past CORS.
 *
 * It fails closed (#21 slice 1a, js/kernel/composition/api-request.js): only the service
 * worker, and only the loopback origin the worker checked against the stored Ollama URL, which
 * it checks again here, sent with fetch, Content-Type only, no cookies, and no redirect followed.
 */

import { checkRequest, isWorkerSender, loopbackOrigin, send, workerScriptUrl } from './kernel/composition/api-request.js';

// The worker's script URL, read once: this document's chrome.runtime has no getManifest
const workerUrl = workerScriptUrl();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.type === 'OFFSCREEN_API_REQUEST') {
    workerUrl
      .then(/** @returns {Promise<{ok: boolean, status: number, data: unknown} | {error: string}>} */ async url => {
        if (!isWorkerSender(sender, { workerUrl: url })) return { error: 'request-refused' };
        const checked = checkRequest(request, { loopback: loopbackOrigin(request.loopbackOrigin) });
        // Only the loopback origin: anything else the worker fetches itself
        if (!checked.ok || !checked.loopback) return { error: 'request-refused' };
        return handleApiRequest(checked);
      })
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

/**
 * Send a checked request
 * @param {import('./kernel/composition/api-request.js').CheckedRequest} checked
 * @returns {Promise<{ok: boolean, status: number, data: unknown}>}
 */
async function handleApiRequest(checked) {
  console.debug('Offscreen: Making fetch to', checked.url);
  return send(checked);
}
