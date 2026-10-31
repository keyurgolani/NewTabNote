/**
 * The destination rules a request is held to (#21 slice 1b), in one small module that both the
 * destination client (destinations.js, the full checker the proxies use) and the network guard
 * (network-guard.js, every context's first code) import, so the rule is written once:
 *
 * - matchDestination: a URL to the row whose origin, path prefix and method take it, `URL`-parsed,
 *   userinfo refused, an encoded separator, dot segment, or percent sign in the path refused
 *   before any prefix is matched; a loopback row only at the stored Ollama URL's origin, and a
 *   stored row only at the stored WebDAV server's, which the caller passes;
 * - headerPairs: a request's headers read as fetch reads them, through the platform Headers;
 *   headerRefusal: a name that isn't a token or that the row doesn't list, or a line break;
 *   queryCarriesCredential: a credential in the URL's query; carriesCredential: one in a header;
 * - guardRows: rows cut to what the guard reads, after a structural check, or null;
 * - the stored Ollama URL's loopback origin and the stored WebDAV server's origin.
 *
 * It parses with the platform's URL and Headers as they were when it loaded, which in each
 * context is before any other code runs (the network guard imports it first), so code that
 * runs later can't hand it others.
 *
 * It holds no registry and no problem text: destinations.js validates the registry and says
 * what's wrong with it. Loading this module touches no browser API.
 */

/** The only hosts that are local */
export const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1']);

/** Query parameters that would carry a credential in the URL, which no request may, in any case */
export const CREDENTIAL_PARAMS = Object.freeze(['key', 'api_key', 'api-key', 'apikey', 'x-api-key', 'x-goog-api-key', 'token', 'access_token', 'auth']);

/** Headers that carry a credential, which a row without one never lists, and which make a request credentialed */
export const CREDENTIAL_CARRIERS = Object.freeze(['authorization', 'proxy-authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'cookie']);

/** A header name as RFC 9110 defines a token */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Ollama's URL with nothing stored, as js/llm.js defaults it */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** How long a read of a stored URL may take before it answers none */
const OLLAMA_URL_READ_MS = 2000;

/** The platform's URL and Headers, as this module loaded */
const NativeURL = globalThis.URL;
const NativeHeaders = globalThis.Headers;
const headersForEach = NativeHeaders && NativeHeaders.prototype.forEach;

/**
 * A row as the rules read it
 * @typedef {Readonly<{origin: string, pathPrefix: string, methods: readonly string[], credential: string,
 *   headers: readonly string[], location: string, reachedBy?: string}>} MatchRow
 */

/**
 * `value` parsed with `URL`, or null
 * @param {unknown} value
 * @returns {URL | null}
 */
export function parse(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new (NativeURL || URL)(value);
  } catch {
    return null;
  }
}

/**
 * A row's origin split into scheme, host (a leading `*.` for subdomains, or `*` alone for any
 * host, which only a stored row has), and port (`*` for any loopback port), or null when it
 * isn't one's shape. Read without `URL`, so a check at load never depends on it.
 * destinations.js's validator holds the host's labels and the port's range to more.
 * @param {unknown} origin
 * @returns {{protocol: string, host: string, wildcard: boolean, port: string} | null}
 */
export function originParts(origin) {
  const match = typeof origin === 'string' ? /^(https?):\/\/(?:\*|(\*\.)?([a-z0-9.-]+))(?::(\*|\d+))?$/.exec(origin) : null;
  if (!match) return null;
  const [, scheme, star, host = '*', port = ''] = match;
  return { protocol: `${scheme}:`, host, wildcard: Boolean(star), port };
}

/**
 * Whether `path` holds an encoded separator (%2F, %5C), an encoded percent sign (%25), which
 * would decode to another escape, or a segment that's an encoded dot run, in any case
 * @param {string} path
 * @returns {boolean}
 */
export function encodedPathProblem(path) {
  if (/%(?:2f|5c|25)/i.test(path)) return true;
  return path.split('/').some(segment => /%2e/i.test(segment) && /^\.{1,2}$/.test(segment.replace(/%2e/gi, '.')));
}

/**
 * The path of a URL as it was given, before `URL` resolves its dot segments
 * @param {string} raw
 * @returns {string}
 */
function givenPath(raw) {
  const afterScheme = raw.indexOf('//');
  const start = afterScheme === -1 ? 0 : raw.indexOf('/', afterScheme + 2);
  if (start === -1) return '/';
  return raw.slice(start).split(/[?#]/)[0];
}

/**
 * Whether `url`'s host and port are `row`'s origin; a loopback row's only at `loopback`, and a
 * stored row's only at `stored`
 * @param {MatchRow} row
 * @param {URL} url
 * @param {string | null} loopback
 * @param {string | null} stored
 * @returns {boolean}
 */
function originMatches(row, url, loopback, stored) {
  const parts = originParts(row.origin);
  if (!parts || url.protocol !== parts.protocol) return false;
  if (row.location === 'loopback') return loopback !== null && url.origin === loopback && url.hostname === parts.host;
  if (row.location === 'stored') return stored !== null && url.origin === stored && (parts.host === '*' || url.hostname === parts.host);
  if (parts.wildcard) return url.hostname.endsWith(`.${parts.host}`) && url.port === parts.port;
  return url.hostname === parts.host && url.port === parts.port;
}

/**
 * Whether `pathname` is under `prefix`: a prefix ending in / takes the paths below it, and any
 * other the path itself and the paths below it
 * @param {string} prefix
 * @param {string} pathname
 * @returns {boolean}
 */
function underPrefix(prefix, pathname) {
  if (prefix.endsWith('/')) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The row of `rows` that `url` reaches with `method`, or why it's refused. A row with no
 * `reachedBy`, as guardRows cuts them, is a fetch row.
 * @template {MatchRow} R
 * @param {readonly R[]} rows
 * @param {unknown} url
 * @param {{method?: string, loopback?: string | null, stored?: string | null, reachedBy?: string}} [options]
 *   `loopback` is the stored Ollama URL's origin and `stored` the stored WebDAV server's, or null
 * @returns {{ok: true, row: R, url: URL} | {ok: false, code: 'destination-refused' | 'invalid-method'}}
 */
export function matchDestination(rows, url, { method = 'GET', loopback = null, stored = null, reachedBy = 'fetch' } = {}) {
  const parsed = parse(url);
  if (!parsed || parsed.username !== '' || parsed.password !== '') return { ok: false, code: 'destination-refused' };
  // Before any prefix is matched: what `URL` resolves and what it keeps encoded alike
  if (encodedPathProblem(givenPath(String(url))) || encodedPathProblem(parsed.pathname)) return { ok: false, code: 'destination-refused' };
  const upper = typeof method === 'string' ? method.toUpperCase() : '';
  let methodRefused = false;
  for (const row of rows) {
    if ((row.reachedBy || 'fetch') !== reachedBy || !originMatches(row, parsed, loopback, stored) || !underPrefix(row.pathPrefix, parsed.pathname)) continue;
    if (row.methods.includes(upper)) return { ok: true, row, url: parsed };
    methodRefused = true;
  }
  return { ok: false, code: methodRefused ? 'invalid-method' : 'destination-refused' };
}

/**
 * A request's headers as name and value pairs, read as fetch reads them, through the
 * platform's own `new Headers(value)`: a Headers, a record, or any iterable of pairs (a list, a
 * Set, a generator), each read once. Names come lowercased. Null for headers fetch would refuse,
 * or where the platform has no Headers.
 * @param {unknown} headers
 * @returns {Array<[string, string]> | null}
 */
export function headerPairs(headers) {
  if (headers === null || headers === undefined) return [];
  const Platform = NativeHeaders || globalThis.Headers;
  if (typeof Platform !== 'function') return null;
  try {
    /** @type {Array<[string, string]>} */
    const pairs = [];
    (headersForEach || Platform.prototype.forEach).call(new Platform(/** @type {HeadersInit} */ (headers)), (/** @type {string} */ value, /** @type {string} */ name) => pairs.push([name, value]));
    return pairs;
  } catch {
    return null;
  }
}

/**
 * Why `row` won't take the header `name: value`: a name that isn't a token, one the row
 * doesn't list, or a line break in the value; null when it takes it
 * @param {MatchRow} row
 * @param {string} name
 * @param {string} value
 * @returns {'not-a-token' | 'not-listed' | 'line-break' | null}
 */
export function headerRefusal(row, name, value) {
  if (!HEADER_NAME.test(name)) return 'not-a-token';
  if (!row.headers.some(listed => listed.toLowerCase() === name.toLowerCase())) return 'not-listed';
  if (/[\r\n]/.test(value)) return 'line-break';
  return null;
}

/**
 * Whether `url`'s query has a parameter that would carry a credential, in any case
 * @param {unknown} url
 * @returns {boolean}
 */
export function queryCarriesCredential(url) {
  const parsed = parse(url);
  return parsed !== null && [...parsed.searchParams.keys()].some(key => CREDENTIAL_PARAMS.includes(key.toLowerCase()));
}

/**
 * Whether `pairs` (headerPairs) carry a credential
 * @param {ReadonlyArray<readonly [string, string]>} pairs
 * @returns {boolean}
 */
export function carriesCredential(pairs) {
  return pairs.some(([name]) => CREDENTIAL_CARRIERS.includes(name.toLowerCase()));
}

/**
 * Whether `list` is an array of strings
 * @param {unknown} list
 * @returns {list is string[]}
 */
const strings = list => Array.isArray(list) && list.every(item => typeof item === 'string');

/**
 * What most rows hold, which the rows the build inlines in the page guard leave out
 * (compactRows) and guardRows puts back
 */
const USUAL = Object.freeze({ methods: Object.freeze(['GET', 'POST']), credential: 'bearer', headers: Object.freeze(['Authorization', 'Content-Type']), location: 'remote' });

/**
 * `rows` (guardRows' cut) with each field that holds its usual value left out, as the build
 * inlines them in the page guard, marked compact: only such rows are read with the usual values
 * @param {readonly MatchRow[]} rows
 * @returns {{compact: Array<Record<string, unknown>>}}
 */
export function compactRows(rows) {
  return { compact: rows.map(row => Object.fromEntries(Object.entries(row).filter(([key, value]) => JSON.stringify(USUAL[/** @type {keyof typeof USUAL} */ (key)]) !== JSON.stringify(value)))) };
}

/**
 * `rows`' fetch rows cut to what the guard reads (origin, path prefix, methods, credential,
 * headers, location), copied, or null when one isn't the shape a row has: then the guard
 * refuses every destination. Only rows compactRows marked compact are read with a missing
 * field at its usual value; a full row missing one is refused. The build cuts the rows it
 * inlines in the page guard this way, once destinations.js has validated them.
 * @param {unknown} rows
 * @returns {readonly MatchRow[] | null}
 */
export function guardRows(rows) {
  try {
    const compact = rows !== null && typeof rows === 'object' && !Array.isArray(rows) ? /** @type {{compact?: unknown}} */ (rows).compact : undefined;
    const list = compact === undefined ? rows : compact;
    if (!Array.isArray(list)) return null;
    /** @type {Record<string, unknown>} */
    const usual = compact === undefined ? {} : USUAL;
    /** @type {MatchRow[]} */
    const cut = [];
    for (const row of list) {
      if (row === null || typeof row !== 'object') return null;
      const { origin, pathPrefix, methods = usual.methods, credential = usual.credential, headers = usual.headers, location = usual.location, reachedBy = 'fetch' } = row;
      const parts = originParts(origin);
      const local = parts !== null && parts.protocol === 'http:' && LOOPBACK_HOSTS.includes(parts.host);
      const shaped = parts !== null && (location === 'loopback' ? local
        : location === 'stored' ? local || (parts.protocol === 'https:' && parts.host === '*')
          : location === 'remote' && parts.protocol === 'https:' && parts.host !== '*');
      if (!shaped) return null;
      if (typeof pathPrefix !== 'string' || !pathPrefix.startsWith('/') || !strings(methods) || methods.length === 0 || typeof credential !== 'string' || !strings(headers)) return null;
      if (reachedBy !== 'fetch') continue;
      // Copies, which only the guard that asked for them holds
      cut.push({ origin, pathPrefix, methods: [...methods], credential, headers: [...headers], location });
    }
    return cut;
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
 * reach, or null. Read per request, so a URL changed in Settings applies to the next one. A
 * read that fails, or takes longer than `timeoutMs`, answers null, so a loopback request is
 * refused rather than left waiting.
 * @param {{get(keys: string[]): Promise<Record<string, unknown>>}} [settings] - chrome.storage.local
 *   unless a test passes another
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<string | null>}
 */
export async function storedLoopbackOrigin(settings = { get: keys => chrome.storage.local.get(keys) }, { timeoutMs = OLLAMA_URL_READ_MS } = {}) {
  const stored = await readStored(settings, 'setting_ollamaUrl', timeoutMs);
  if (stored === UNREAD) return null;
  return loopbackOrigin(stored === undefined ? DEFAULT_OLLAMA_URL : stored);
}

/** What readStored answers for a read that failed or took too long */
const UNREAD = Symbol('unread');

/**
 * What chrome.storage.local holds under `key`, undefined when it holds nothing, or UNREAD when
 * the read fails or takes longer than `timeoutMs`
 * @param {{get(keys: string[]): Promise<Record<string, unknown>>}} settings
 * @param {string} key
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function readStored(settings, key, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('read-timeout')), timeoutMs); });
    const stored = /** @type {Record<string, unknown>} */ (await Promise.race([settings.get([key]), late]));
    return stored ? stored[key] : undefined;
  } catch {
    return UNREAD;
  } finally {
    clearTimeout(timer);
  }
}

/** Where js/services/sync-service.js keeps the WebDAV config, its server's URL in it, before it connects */
export const WEBDAV_CONFIG_KEY = 'setting_syncWebdavConfig';

/**
 * The origin of a stored WebDAV server URL: https with no userinfo, or http on loopback, or null
 * @param {unknown} serverUrl
 * @returns {string | null}
 */
export function webdavOrigin(serverUrl) {
  const url = parse(serverUrl);
  if (!url || url.username !== '' || url.password !== '') return null;
  return url.protocol === 'https:' ? url.origin : loopbackOrigin(serverUrl);
}

/**
 * The stored WebDAV server's origin (webdavOrigin), the one origin the WebDAV rows reach, or
 * null. Read per request, so a server set in Settings applies to the next one.
 * @param {{get(keys: string[]): Promise<Record<string, unknown>>}} settings - chrome.storage.local
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<string | null>}
 */
export async function storedWebdavOrigin(settings, { timeoutMs = OLLAMA_URL_READ_MS } = {}) {
  const config = await readStored(settings, WEBDAV_CONFIG_KEY, timeoutMs);
  // The server's URL only: nothing else of the config is read out of it
  return config !== null && typeof config === 'object' ? webdavOrigin(/** @type {{serverUrl?: unknown}} */ (config).serverUrl) : null;
}
