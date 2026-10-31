/**
 * The policy of the two request proxies until #9 and #11 delete them (#21 slice 1a, "The
 * proxies"): `API_REQUEST` in the service worker (js/background.js) and `OFFSCREEN_API_REQUEST`
 * in the offscreen document (js/offscreen.js). Both fail closed:
 *
 * - only this extension's own senders: its id, and a sender URL on its own origin (an
 *   extension page or the worker), never a web page or another extension; the offscreen
 *   document takes the service worker only (isWorkerSender);
 * - only a URL that `URL` parses to an origin on DESTINATIONS, with a method that row allows,
 *   or the stored Ollama URL's origin when that's `http://localhost` or `http://127.0.0.1`,
 *   on any port; userinfo is refused, and nothing else is local because it says `localhost`;
 * - only `method` and a string `body` in the options, a body only with POST, and under
 *   MAX_BODY_BYTES in UTF-8;
 * - sent with `fetch`, no header but `Content-Type`, no cookies, and `redirect: 'error'`, so
 *   no redirect is followed.
 *
 * A refused request is final: the page doesn't fetch it itself instead (js/llm.js).
 *
 * DESTINATIONS is the one packaged list both read: every provider endpoint js/llm.js names,
 * and the `legacy` model hosts for GET, each with the issue that removes it
 * (test/api-request-policy.test.js holds llm.js to it). #21 slice 1b moves them into
 * `security/destinations.json`. Loading this module touches no browser API.
 */

/**
 * @typedef {Readonly<{origin: string, methods: readonly string[], kind: 'provider' | 'legacy', removeWhen?: number}>} Destination
 */

const PROVIDER_METHODS = Object.freeze(['GET', 'POST']);

/**
 * @param {string} origin
 * @returns {Destination}
 */
const provider = origin => Object.freeze({ origin, methods: PROVIDER_METHODS, kind: /** @type {const} */ ('provider') });

/** @type {readonly Destination[]} */
export const DESTINATIONS = Object.freeze([
  provider('https://api.openai.com'),
  provider('https://api.anthropic.com'),
  provider('https://generativelanguage.googleapis.com'),
  provider('https://openrouter.ai'),
  provider('https://api.x.ai'),
  provider('https://api.deepseek.com'),
  provider('https://api.mistral.ai'),
  provider('https://api.groq.com'),
  provider('https://dashscope-intl.aliyuncs.com'),
  provider('https://dashscope.aliyuncs.com'),
  provider('https://api.z.ai'),
  provider('https://open.bigmodel.cn'),
  provider('https://api.moonshot.ai'),
  provider('https://api.moonshot.cn'),
  provider('https://api.minimax.io'),
  provider('https://api.minimax.chat'),
  // The embedding model and its runtime, which 1.4.0 loads; #9's model library replaces them
  Object.freeze({ origin: 'https://huggingface.co', methods: Object.freeze(['GET']), kind: /** @type {const} */ ('legacy'), removeWhen: 9 }),
  Object.freeze({ origin: 'https://cdn.jsdelivr.net', methods: Object.freeze(['GET']), kind: /** @type {const} */ ('legacy'), removeWhen: 9 }),
]);

/** Ollama's URL with nothing stored, as js/llm.js defaults it */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** How long the worker waits for the stored Ollama URL before it answers no loopback origin */
const OLLAMA_URL_READ_MS = 2000;

/** The largest body a proxied request may carry, in UTF-8 bytes: a long chat with its context */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The methods a body may go with */
const BODY_METHODS = Object.freeze(['POST']);

/** The only hosts that are local */
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1']);

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
 * The origin of a stored Ollama URL when it's loopback http with no userinfo, any port, or null
 * @param {unknown} ollamaUrl
 * @returns {string | null}
 */
export function loopbackOrigin(ollamaUrl) {
  const url = parse(ollamaUrl);
  if (!url || url.protocol !== 'http:' || url.username !== '' || url.password !== '') return null;
  return LOOPBACK_HOSTS.includes(url.hostname) ? url.origin : null;
}

/**
 * The stored Ollama URL's loopback origin (loopbackOrigin), the one local origin a request may
 * reach, or null. The worker reads it per request, so a URL changed in Settings applies to the
 * next one; the offscreen document has no chrome.storage and takes the origin the worker checked.
 * A read that fails, or takes longer than `timeoutMs`, answers null, so a loopback request is
 * refused rather than left waiting.
 * @param {{get(keys: string[]): Promise<Record<string, unknown>>}} [settings] - chrome.storage.local
 *   unless a test passes another
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<string | null>}
 */
export async function storedLoopbackOrigin(settings = { get: keys => chrome.storage.local.get(keys) }, { timeoutMs = OLLAMA_URL_READ_MS } = {}) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('read-timeout')), timeoutMs); });
    const stored = /** @type {Record<string, unknown>} */ (await Promise.race([settings.get(['setting_ollamaUrl']), late]));
    const url = stored && stored.setting_ollamaUrl !== undefined ? stored.setting_ollamaUrl : DEFAULT_OLLAMA_URL;
    return loopbackOrigin(url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
 * Whether `sender` is this extension's service worker: its id, the manifest's
 * background.service_worker URL, and no tab. The offscreen document takes only the worker, which
 * checked the request and the Ollama URL first.
 * @param {unknown} sender
 * @param {{id?: string, getURL?: (path: string) => string, getManifest?: () => unknown}} [runtime]
 *   chrome.runtime unless a test passes another
 * @returns {boolean}
 */
export function isWorkerSender(sender, runtime = globalThis.chrome?.runtime) {
  if (!runtime || typeof runtime.getURL !== 'function' || typeof runtime.getManifest !== 'function') return false;
  if (sender === null || typeof sender !== 'object') return false;
  const { id, url, tab } = /** @type {{id?: unknown, url?: unknown, tab?: unknown}} */ (sender);
  if (tab !== undefined || !isOwnSender(sender, runtime.id)) return false;
  const manifest = /** @type {{background?: {service_worker?: unknown}} | undefined} */ (runtime.getManifest());
  const script = manifest?.background?.service_worker;
  return typeof script === 'string' && id === runtime.id && url === runtime.getURL(script);
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
  const url = parse(raw);
  if (!url || url.username !== '' || url.password !== '') return { ok: false, code: 'destination-refused' };
  const upper = method.toUpperCase();
  if (loopback !== null && url.origin === loopback && url.protocol === 'http:') {
    if (!PROVIDER_METHODS.includes(upper)) return { ok: false, code: 'invalid-method' };
    return withBody({ ok: true, url: url.href, method: upper, loopback: true }, body);
  }
  if (url.protocol !== 'https:') return { ok: false, code: 'destination-refused' };
  const row = DESTINATIONS.find(destination => destination.origin === url.origin);
  if (!row) return { ok: false, code: 'destination-refused' };
  if (!row.methods.includes(upper)) return { ok: false, code: 'invalid-method' };
  return withBody({ ok: true, url: url.href, method: upper, loopback: false }, body);
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
