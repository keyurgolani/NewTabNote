/**
 * The policy of the two request proxies until #9 and #11 delete them (#21 slice 1a, "The
 * proxies"): `API_REQUEST` in the service worker (js/background.js) and `OFFSCREEN_API_REQUEST`
 * in the offscreen document (js/offscreen.js). Both fail closed:
 *
 * - only this extension's own senders: its id, and a sender URL on its own origin (an
 *   extension page or the worker), never a web page or another extension;
 * - only a URL that `URL` parses to an origin on DESTINATIONS, with a method that row allows,
 *   or the stored Ollama URL's origin when that's `http://localhost` or `http://127.0.0.1`,
 *   on any port; userinfo is refused, and nothing else is local because it says `localhost`;
 * - only `method` and a string `body` in the options, under MAX_BODY_BYTES;
 * - sent with no header but `Content-Type`, no cookies, and `redirect: 'error'` when it
 *   carries a body.
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

/** The largest body a proxied request may carry: a long chat with its context */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

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
 * Whether `sender` is this extension: its id, and a URL on its own origin
 * @param {unknown} sender
 * @param {string} extensionId
 * @returns {boolean}
 */
export function isOwnSender(sender, extensionId) {
  if (sender === null || typeof sender !== 'object' || typeof extensionId !== 'string' || extensionId === '') return false;
  const { id, url } = /** @type {{id?: unknown, url?: unknown}} */ (sender);
  if (id !== extensionId) return false;
  const parsed = parse(url);
  // By scheme and host: `origin` of a chrome-extension: URL reads "null" outside Chrome
  return parsed !== null && parsed.protocol === 'chrome-extension:' && parsed.host === extensionId && parsed.username === '';
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
  if (body !== undefined && (typeof body !== 'string' || body.length > MAX_BODY_BYTES)) return { ok: false, code: 'invalid-body' };
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
 * redirect followed when it carries a body
 * @param {CheckedRequest} checked
 * @returns {RequestInit}
 */
export function fetchInit(checked) {
  /** @type {RequestInit} */
  const init = { method: checked.method, headers: { 'Content-Type': 'application/json' } };
  if (checked.body !== undefined) init.body = checked.body;
  init.credentials = 'omit';
  if (checked.body !== undefined) init.redirect = 'error';
  return init;
}
