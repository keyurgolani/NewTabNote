/**
 * The policy of the two request proxies until #9 and #11 delete them (#21 slice 1a, "The
 * proxies"): `API_REQUEST` in the service worker (js/background.js) and `OFFSCREEN_API_REQUEST`
 * in the offscreen document (js/offscreen.js). Both fail closed:
 *
 * - only this extension's own senders: its id, and a sender URL on its own origin (an
 *   extension page or the worker), never a web page or another extension; the offscreen
 *   document takes the service worker only (isWorkerSender);
 * - only a URL the destination client (destinations.js) takes to a registry row the proxy may
 *   reach, under its path prefix and with one of its methods, or to the stored Ollama URL's
 *   origin when that's `http://localhost` or `http://127.0.0.1`, on any port; userinfo is
 *   refused, and nothing else is local because it says `localhost`;
 * - only `method` and a string `body` in the options, a body only with POST, and under
 *   MAX_BODY_BYTES in UTF-8;
 * - sent with `fetch`, no header but `Content-Type`, no cookies, and `redirect: 'error'`, so
 *   no redirect is followed.
 *
 * A refused request is final: the page doesn't fetch it itself instead (js/llm.js).
 *
 * The destinations are security/destinations.json's rows the proxy may reach (#21 slice 1b),
 * and DESTINATIONS lists the remote ones: every provider endpoint js/llm.js names, and the
 * `legacy` model hosts for GET, each with the issue that removes it. Loading this module
 * touches no browser API.
 */

import { DESTINATIONS as REGISTRY, destinationFor, queryProblems } from './destinations.js';
// The stored Ollama URL's loopback origin, which the network guard reads too
import { loopbackOrigin, storedLoopbackOrigin } from './destination-match.js';

export { loopbackOrigin, storedLoopbackOrigin };

/**
 * A remote destination the proxy may reach, as the registry has it
 * @typedef {import('./destinations.js').Destination} Destination
 */

/** @type {readonly Destination[]} */
export const DESTINATIONS = Object.freeze(REGISTRY.filter(row => row.proxy && row.location === 'remote'));

/** The largest body a proxied request may carry, in UTF-8 bytes: a long chat with its context */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The methods a body may go with */
const BODY_METHODS = Object.freeze(['POST']);

/**
 * `value` parsed with `URL`, or null
 * @param {unknown} value
 * @returns {URL | null}
 */
function parse(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Whether `sender` is this extension: its id, and a URL on its own origin
 * @param {unknown} sender
 * @param {string | undefined} [extensionId] - chrome.runtime.id unless a test passes another
 * @returns {boolean}
 */
export function isOwnSender(sender, extensionId = globalThis.chrome?.runtime?.id) {
  if (sender === null || typeof sender !== 'object' || typeof extensionId !== 'string' || extensionId === '') return false;
  const { id, url } = /** @type {{id?: unknown, url?: unknown}} */ (sender);
  if (id !== extensionId) return false;
  const parsed = parse(url);
  // By scheme and host: `origin` of a chrome-extension: URL reads "null" outside Chrome
  return parsed !== null && parsed.protocol === 'chrome-extension:' && parsed.host === extensionId && parsed.username === '';
}

/**
 * The service worker's script URL, from the manifest's background.service_worker: through
 * getManifest where the runtime has it, and read from the package's manifest.json where it
 * hasn't, as in the offscreen document. Null when neither tells.
 * @param {{getURL?: (path: string) => string, getManifest?: () => unknown}} [runtime] - chrome.runtime
 *   unless a test passes another
 * @param {(url: string) => Promise<unknown>} [read] - reads a JSON file in the package
 * @returns {Promise<string | null>}
 */
export async function workerScriptUrl(runtime = globalThis.chrome?.runtime, read = url => fetch(url).then(response => response.json())) {
  try {
    if (!runtime || typeof runtime.getURL !== 'function') return null;
    const manifest = /** @type {{background?: {service_worker?: unknown}} | undefined} */ (
      typeof runtime.getManifest === 'function' ? runtime.getManifest() : await read(runtime.getURL('manifest.json')));
    const script = manifest?.background?.service_worker;
    return typeof script === 'string' && script !== '' ? runtime.getURL(script) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `sender` is this extension's service worker: its id, its script URL (workerScriptUrl),
 * and no tab. The offscreen document takes only the worker, which checked the request and the
 * Ollama URL first.
 * @param {unknown} sender
 * @param {{id?: string, workerUrl: string | null}} worker - `id` is chrome.runtime.id unless a test passes another
 * @returns {boolean}
 */
export function isWorkerSender(sender, { id = globalThis.chrome?.runtime?.id, workerUrl }) {
  if (typeof workerUrl !== 'string' || sender === null || typeof sender !== 'object') return false;
  const { url, tab } = /** @type {{url?: unknown, tab?: unknown}} */ (sender);
  return tab === undefined && isOwnSender(sender, id) && url === workerUrl;
}

/**
 * A request the policy took
 * @typedef {{ok: true, url: string, method: string, body?: string, loopback: boolean}} CheckedRequest
 */

/**
 * Checks a proxy message's URL and options. `loopback` is the one local origin allowed, the
 * stored Ollama URL's (loopbackOrigin), or null for none.
 * @param {unknown} request
 * @param {{loopback: string | null}} options
 * @returns {CheckedRequest | {ok: false, code: string}}
 */
export function checkRequest(request, { loopback }) {
  if (request === null || typeof request !== 'object') return { ok: false, code: 'not-a-request' };
  const { url: raw, options = {} } = /** @type {{url?: unknown, options?: unknown}} */ (request);
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return { ok: false, code: 'invalid-options' };
  const given = /** @type {Record<string, unknown>} */ (options);
  if (Object.keys(given).some(name => name !== 'method' && name !== 'body')) return { ok: false, code: 'invalid-options' };
  const method = given.method === undefined ? 'GET' : given.method;
  if (typeof method !== 'string') return { ok: false, code: 'invalid-method' };
  const { body } = given;
  if (body !== undefined && (typeof body !== 'string' || utf8Bytes(body) > MAX_BODY_BYTES)) return { ok: false, code: 'invalid-body' };
  if (body !== undefined && !BODY_METHODS.includes(method.toUpperCase())) return { ok: false, code: 'invalid-body' };
  const upper = method.toUpperCase();
  const found = destinationFor(raw, { method: upper, loopback, reachedBy: 'fetch' });
  if (!found.ok) return { ok: false, code: found.code };
  if (!found.row.proxy) return { ok: false, code: 'destination-refused' };
  // The proxy sends no header of the caller's, so a credential could only ride in the query
  if (queryProblems(found.url.href).length > 0) return { ok: false, code: 'destination-refused' };
  return withBody({ ok: true, url: found.url.href, method: upper, loopback: found.row.location === 'loopback' }, body);
}

/**
 * `text`'s length in UTF-8 bytes, as it goes on the wire
 * @param {string} text
 * @returns {number}
 */
function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * @param {CheckedRequest} checked
 * @param {unknown} body
 * @returns {CheckedRequest}
 */
function withBody(checked, body) {
  if (typeof body === 'string') checked.body = body;
  return checked;
}

/**
 * The fetch options a checked request goes with: Content-Type only, no cookies, and no
 * redirect followed
 * @param {CheckedRequest} checked
 * @returns {RequestInit}
 */
export function fetchInit(checked) {
  /** @type {RequestInit} */
  const init = { method: checked.method, headers: { 'Content-Type': 'application/json' } };
  if (checked.body !== undefined) init.body = checked.body;
  init.credentials = 'omit';
  init.redirect = 'error';
  return init;
}

/**
 * A proxied response as the page reads it: its status, and its body as JSON when it says it's
 * JSON, as text otherwise
 * @param {Response} response
 * @returns {Promise<{ok: boolean, status: number, data: unknown}>}
 */
export async function answerOf(response) {
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { ok: response.ok, status: response.status, data };
}

/**
 * Send a checked request with fetch (fetchInit), and read its answer (answerOf). Both proxies
 * send through this one call. It rejects as fetch does, a refused redirect included.
 * @param {CheckedRequest} checked
 * @returns {Promise<{ok: boolean, status: number, data: unknown}>}
 */
export async function send(checked) {
  return answerOf(await fetch(checked.url, fetchInit(checked)));
}
