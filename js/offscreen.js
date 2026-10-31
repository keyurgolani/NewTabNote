/**
 * Offscreen document for New Tab Note
 * Handles the worker's requests to the Ollama URL with XMLHttpRequest, to get past CORS.
 *
 * It fails closed (#21 slice 1a, js/kernel/composition/api-request.js): only this extension's
 * own senders, and only the loopback origin the worker checked against the stored Ollama URL,
 * which it checks again here, sent with Content-Type only and no cookies.
 */

import { checkRequest, isOwnSender, loopbackOrigin } from './kernel/composition/api-request.js';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.type === 'OFFSCREEN_API_REQUEST') {
    if (!isOwnSender(sender, chrome.runtime.id)) {
      sendResponse({ error: 'request-refused' });
      return false;
    }
    const checked = checkRequest(request, { loopback: loopbackOrigin(request.loopbackOrigin) });
    // Only the loopback origin: anything else the worker fetches itself
    if (!checked.ok || !checked.loopback) {
      sendResponse({ error: 'request-refused' });
      return false;
    }
    handleApiRequest(checked)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

/**
 * Handle a checked request using XMLHttpRequest to bypass CORS.
 * @param {{url: string, method: string, body?: string}} request - the checked request
 * @returns {Promise<{ok: boolean, status: number, data: *}>} Response object
 */
async function handleApiRequest(request) {
  console.debug('Offscreen: Making XHR request to', request.url);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.url, true);

    // Content-Type is the one header a proxied request carries
    xhr.setRequestHeader('Content-Type', 'application/json');

    xhr.timeout = 60000; // 60 second timeout

    xhr.onload = function() {
      console.debug('Offscreen: XHR response status:', xhr.status);

      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        data = xhr.responseText;
      }

      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        data: data
      });
    };

    xhr.onerror = function() {
      console.error('Offscreen: XHR network error');
      reject(new Error('Network error'));
    };

    xhr.ontimeout = function() {
      console.error('Offscreen: XHR timeout');
      reject(new Error('Request timeout'));
    };

    xhr.send(request.body !== undefined ? request.body : null);
  });
}
