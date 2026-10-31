/**
 * The destination client (#21 slice 1b, Network): security/destinations.json, the one list of
 * every place this build's code may reach, read through its written module (destination-rows.js,
 * which `npm run check:destinations` holds to it) and checked as this module loads, and the checks
 * a request goes through against it.
 *
 * - destinationFor(url, options) takes a URL to its row, or refuses it: `URL`-parsed, userinfo
 *   refused, `https` except loopback, the row's origin (a legacy row's `*.` wildcard matches
 *   subdomains only), its path prefix, one of its methods, and how it's reached. Loopback is only
 *   the stored Ollama URL's own origin, which the caller passes.
 * - headerProblems(row, headers, url) checks a request's headers: the row's names only, no line
 *   break in a name or value, and no credential in the URL's query.
 * - requestInit(row, init) is what a request goes with: no cookies, and no redirect followed
 *   when it carries a credential or a body. An uncredentialed GET, such as a model file the Hub
 *   answers with a redirect to its CDN, follows as before.
 *
 * #94's proxy policy (api-request.js) resolves its destinations here. Loading this module
 * touches no browser API.
 */

// security/destinations.json's rows, as `npm run check:destinations -- --write` writes them
import { DESTINATION_ROWS } from './destination-rows.js';

/**
 * One registry row (security/destinations.json)
 * @typedef {Readonly<{
 *   id: string,
 *   kind: 'packaged' | 'user' | 'legacy',
 *   origin: string,
 *   pathPrefix: string,
 *   methods: readonly string[],
 *   credential: 'none' | 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'basic',
 *   headers: readonly string[],
 *   location: 'remote' | 'loopback',
 *   reachedBy: 'fetch' | 'image' | 'frame',
 *   proxy: boolean,
 *   owner: number,
 *   removeWhen?: number,
 *   egress?: string,
 *   note?: string,
 * }>} Destination
 */

const KINDS = Object.freeze(['packaged', 'user', 'legacy']);
const CREDENTIALS = Object.freeze(['none', 'bearer', 'x-api-key', 'x-goog-api-key', 'basic']);
const METHODS = Object.freeze(['GET', 'POST']);
const LOCATIONS = Object.freeze(['remote', 'loopback']);
const REACHED_BY = Object.freeze(['fetch', 'image', 'frame']);
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1']);
/** The header each credential scheme travels in */
const CREDENTIAL_HEADERS = Object.freeze({ bearer: 'authorization', 'x-api-key': 'x-api-key', 'x-goog-api-key': 'x-goog-api-key', basic: 'authorization' });
/** Query parameters that would carry a credential in the URL, which no request may */
const CREDENTIAL_PARAMS = Object.freeze(['key', 'api_key', 'apikey', 'token', 'access_token']);
/** A header name as RFC 9110 defines a token */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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
 * A row's origin split into scheme, host (a leading `*.` for subdomains), and port (`*` for
 * any loopback port), or null when it isn't one
 * @param {unknown} origin
 * @returns {{protocol: string, host: string, wildcard: boolean, port: string} | null}
 */
function originParts(origin) {
  if (typeof origin !== 'string') return null;
  const match = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\*|\d+))?$/.exec(origin);
  if (!match) return null;
  const [, scheme, star, host, port = ''] = match;
  // Labels of letters, digits, and inner dashes, as `URL` writes a host back; read without
  // `URL`, so a check at load never depends on it
  const labels = host.split('.');
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  if (port !== '' && port !== '*' && (Number(port) > 65535 || String(Number(port)) !== port)) return null;
  return { protocol: `${scheme}:`, host, wildcard: Boolean(star), port };
}

/**
 * The problems with `rows`, one string each; none for a valid registry
 * @param {unknown} rows
 * @returns {string[]}
 */
export function destinationProblems(rows) {
  if (!Array.isArray(rows)) return ['the registry has no destinations list'];
  /** @type {string[]} */
  const problems = [];
  const ids = new Set();
  for (const [index, given] of rows.entries()) {
    const row = /** @type {Record<string, unknown>} */ (given && typeof given === 'object' ? given : {});
    const name = typeof row.id === 'string' && row.id !== '' ? row.id : `row ${index}`;
    const problem = (/** @type {string} */ text) => problems.push(`${name}: ${text}`);
    if (typeof row.id !== 'string' || !/^[a-z0-9-]+$/.test(row.id)) problem('an id of lowercase letters, digits, and dashes');
    if (ids.has(row.id)) problem('an id another row has');
    ids.add(row.id);
    if (!KINDS.includes(/** @type {string} */ (row.kind))) problem(`a kind of ${KINDS.join(', ')}`);
    if (!LOCATIONS.includes(/** @type {string} */ (row.location))) problem(`a location of ${LOCATIONS.join(', ')}`);
    if (!REACHED_BY.includes(/** @type {string} */ (row.reachedBy))) problem(`reached by ${REACHED_BY.join(', ')}`);
    if (!CREDENTIALS.includes(/** @type {string} */ (row.credential))) problem(`a credential of ${CREDENTIALS.join(', ')}`);
    const parts = originParts(row.origin);
    if (!parts) {
      problem('an origin: a scheme and a host, and no path, query, or userinfo');
    } else {
      if (row.location === 'loopback') {
        if (parts.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(parts.host) || parts.wildcard) problem('loopback is http on localhost or 127.0.0.1');
      } else if (parts.protocol !== 'https:' || parts.port === '*' || LOOPBACK_HOSTS.includes(parts.host)) {
        problem('a remote origin is https, on no loopback host or port wildcard');
      }
      if ((parts.wildcard || parts.port === '*') && row.kind !== 'legacy') problem('only a legacy row has a wildcard');
    }
    if (typeof row.pathPrefix !== 'string' || !row.pathPrefix.startsWith('/') || /[?#\s]/.test(row.pathPrefix)) problem('a path prefix starting with /');
    if (!Array.isArray(row.methods) || row.methods.length === 0 || !row.methods.every(method => METHODS.includes(method))) problem(`methods of ${METHODS.join(', ')}`);
    if (!Array.isArray(row.headers) || !row.headers.every(header => typeof header === 'string' && HEADER_NAME.test(header))) problem('header names only');
    if (row.credential !== 'none' && row.credential !== undefined && Array.isArray(row.headers)) {
      const carrier = CREDENTIAL_HEADERS[/** @type {keyof typeof CREDENTIAL_HEADERS} */ (row.credential)];
      if (carrier && !row.headers.some(header => String(header).toLowerCase() === carrier)) problem(`the header its credential travels in, ${carrier}`);
    }
    if (typeof row.proxy !== 'boolean') problem('whether the proxy may reach it');
    if (!Number.isSafeInteger(row.owner) || /** @type {number} */ (row.owner) <= 0) problem('an owning issue');
    if (row.kind === 'legacy' && (!Number.isSafeInteger(row.removeWhen) || /** @type {number} */ (row.removeWhen) <= 0)) problem('a legacy row names the issue that removes it');
  }
  return problems;
}

const PROBLEMS = destinationProblems(DESTINATION_ROWS);
if (PROBLEMS.length > 0) throw new Error(`security/destinations.json: ${PROBLEMS.join('; ')}`);

/** @type {readonly Destination[]} */
export const DESTINATIONS = Object.freeze(
  DESTINATION_ROWS.map(row => /** @type {Destination} */ (Object.freeze({ .../** @type {object} */ (row) }))),
);

/**
 * Whether `url`'s host and port are `row`'s origin; a loopback row's only at `loopback`
 * @param {Destination} row
 * @param {URL} url
 * @param {string | null} loopback
 * @returns {boolean}
 */
function originMatches(row, url, loopback) {
  const parts = /** @type {NonNullable<ReturnType<typeof originParts>>} */ (originParts(row.origin));
  if (url.protocol !== parts.protocol) return false;
  if (row.location === 'loopback') return loopback !== null && url.origin === loopback && url.hostname === parts.host;
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
 * The row `url` reaches with `method`, or why it's refused
 * @param {unknown} url
 * @param {{method?: string, loopback?: string | null, reachedBy?: Destination['reachedBy']}} [options]
 *   `loopback` is the stored Ollama URL's origin (api-request.js's loopbackOrigin), the one local
 *   origin allowed, or null for none
 * @returns {{ok: true, row: Destination, url: URL} | {ok: false, code: 'destination-refused' | 'invalid-method'}}
 */
export function destinationFor(url, { method = 'GET', loopback = null, reachedBy = 'fetch' } = {}) {
  const parsed = parse(url);
  if (!parsed || parsed.username !== '' || parsed.password !== '') return { ok: false, code: 'destination-refused' };
  const upper = typeof method === 'string' ? method.toUpperCase() : '';
  let methodRefused = false;
  for (const row of DESTINATIONS) {
    if (row.reachedBy !== reachedBy || !originMatches(row, parsed, loopback) || !underPrefix(row.pathPrefix, parsed.pathname)) continue;
    if (row.methods.includes(upper)) return { ok: true, row, url: parsed };
    methodRefused = true;
  }
  return { ok: false, code: methodRefused ? 'invalid-method' : 'destination-refused' };
}

/**
 * The problems with a request to `url` on `row` carrying `headers`: a name the row doesn't
 * list, a line break in a name or value, or a credential in the URL's query
 * @param {Destination} row
 * @param {Record<string, unknown> | undefined} headers
 * @param {unknown} url
 * @returns {string[]}
 */
export function headerProblems(row, headers, url) {
  /** @type {string[]} */
  const problems = [];
  const allowed = new Set(row.headers.map(name => name.toLowerCase()));
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HEADER_NAME.test(name)) problems.push('a header name that is not a token');
    else if (!allowed.has(name.toLowerCase())) problems.push(`a header ${row.id} doesn't take`);
    if (/[\r\n]/.test(String(value))) problems.push('a line break in a header value');
  }
  const parsed = parse(url);
  if (parsed && [...parsed.searchParams.keys()].some(key => CREDENTIAL_PARAMS.includes(key.toLowerCase()))) {
    problems.push('a credential in the URL');
  }
  return problems;
}

/**
 * What a request on `row` goes with: `init`, with no cookies, and no redirect followed when it
 * carries a credential or a body
 * @param {Destination} row
 * @param {RequestInit} init
 * @returns {RequestInit}
 */
export function requestInit(row, init) {
  /** @type {RequestInit} */
  const built = { ...init, credentials: 'omit' };
  if (row.credential !== 'none' || init.body !== undefined) built.redirect = 'error';
  return built;
}
