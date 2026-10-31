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
 * - A path with an encoded separator, an encoded dot segment, or an encoded percent sign is
 *   refused before any prefix is matched, in any case.
 * - headerPairs(headers) reads a request's headers as fetch does, through the platform's own
 *   `new Headers(value)`: a Headers, a record, or any iterable of pairs, read once.
 *   headerProblems(row, headers, url) checks them: the row's names only, no line break in a name
 *   or value, and no credential in the URL's query (queryProblems, which the proxy runs too).
 * - requestInit(row, init) is what a request goes with: the header pairs it read, never the
 *   caller's object again, no cookies, and no redirect followed when it carries a credential, by
 *   its row's scheme or in the headers it sends, or a body. An uncredentialed GET, such as a
 *   model file the Hub answers with a redirect to its CDN, follows as before.
 * - Each row is checked and frozen, lists and all, as this module loads, and no two rows overlap.
 *   A registry with a problem doesn't throw: it has no rows, so every request is refused, and
 *   REGISTRY_PROBLEMS says it, for the network guard to report once (network-guard.js).
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
/** Query parameters that would carry a credential in the URL, which no request may, in any case */
const CREDENTIAL_PARAMS = Object.freeze(['key', 'api_key', 'api-key', 'apikey', 'x-api-key', 'x-goog-api-key', 'token', 'access_token', 'auth']);
/** Headers that carry a credential, which a row without one never lists, and which make a request credentialed */
const CREDENTIAL_CARRIERS = Object.freeze(['authorization', 'proxy-authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'cookie']);
/** The port each scheme answers on when it names none, which a row's origin never spells out */
const DEFAULT_PORTS = Object.freeze({ 'http:': '80', 'https:': '443' });
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
 * Whether `path` holds an encoded separator (%2F, %5C), an encoded percent sign (%25), or a
 * segment that's an encoded dot run (., .. spelled with %2E), in any case
 * @param {string} path
 * @returns {boolean}
 */
function encodedPathProblem(path) {
  // An encoded percent sign would decode to another escape, one of these among them
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
 * Whether two rows could take the same request: one origin and way, prefixes where one holds
 * the other, and a method in common
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {boolean}
 */
function overlaps(a, b) {
  if (a.origin !== b.origin || a.reachedBy !== b.reachedBy) return false;
  const [first, second] = [String(a.pathPrefix), String(b.pathPrefix)];
  if (!first.startsWith(second) && !second.startsWith(first)) return false;
  const methods = Array.isArray(a.methods) ? a.methods : [];
  return Array.isArray(b.methods) && b.methods.some(method => methods.includes(method));
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
      if (parts.port === DEFAULT_PORTS[/** @type {keyof typeof DEFAULT_PORTS} */ (parts.protocol)]) problem("an origin names no port its scheme answers on anyway");
    }
    if (typeof row.pathPrefix !== 'string' || !row.pathPrefix.startsWith('/') || /[?#\s\\]/.test(row.pathPrefix)) problem('a path prefix starting with /');
    else if (encodedPathProblem(row.pathPrefix) || /%2e/i.test(row.pathPrefix) || row.pathPrefix.split('/').some(segment => segment === '.' || segment === '..')) {
      problem('a path prefix with no dot segment or encoded separator');
    }
    if (!Array.isArray(row.methods) || row.methods.length === 0 || !row.methods.every(method => METHODS.includes(method))) problem(`methods of ${METHODS.join(', ')}`);
    if (!Array.isArray(row.headers) || !row.headers.every(header => typeof header === 'string' && HEADER_NAME.test(header))) problem('header names only');
    if (row.credential !== 'none' && row.credential !== undefined && Array.isArray(row.headers)) {
      const carrier = CREDENTIAL_HEADERS[/** @type {keyof typeof CREDENTIAL_HEADERS} */ (row.credential)];
      if (carrier && !row.headers.some(header => String(header).toLowerCase() === carrier)) problem(`the header its credential travels in, ${carrier}`);
    }
    if (row.credential === 'none' && Array.isArray(row.headers) && row.headers.some(header => CREDENTIAL_CARRIERS.includes(String(header).toLowerCase()))) {
      problem('a row without a credential lists no credential header');
    }
    if (typeof row.proxy !== 'boolean') problem('whether the proxy may reach it');
    else if (row.proxy && row.reachedBy !== 'fetch') problem('the proxy reaches fetch rows only');
    if (!Number.isSafeInteger(row.owner) || /** @type {number} */ (row.owner) <= 0) problem('an owning issue');
    if (row.kind === 'legacy' && (!Number.isSafeInteger(row.removeWhen) || /** @type {number} */ (row.removeWhen) <= 0)) problem('a legacy row names the issue that removes it');
  }
  // Exactly one row for any request
  const given = rows.filter(row => row && typeof row === 'object');
  for (const [index, a] of given.entries()) {
    for (const b of given.slice(index + 1)) {
      if (overlaps(a, b)) problems.push(`${String(a.id)} and ${String(b.id)}: rows that could take the same request`);
    }
  }
  return problems;
}

/**
 * `rows` checked and frozen, lists and all, so nothing widens a row after the check; with a
 * problem, or a check that throws, no rows and the problems. Never throws: the service worker
 * loads this module before its listeners, which a throw here would take down with it.
 * @param {unknown} rows
 * @returns {{destinations: readonly Destination[], problems: readonly string[]}}
 */
export function loadRegistry(rows) {
  try {
    const problems = destinationProblems(rows);
    if (problems.length > 0) return { destinations: Object.freeze([]), problems: Object.freeze(problems) };
    const destinations = /** @type {unknown[]} */ (rows).map(given => {
      const row = /** @type {Destination} */ (given);
      return /** @type {Destination} */ (Object.freeze({ ...row, methods: Object.freeze([...row.methods]), headers: Object.freeze([...row.headers]) }));
    });
    return { destinations: Object.freeze(destinations), problems: Object.freeze([]) };
  } catch {
    return { destinations: Object.freeze([]), problems: Object.freeze(['the registry could not be read']) };
  }
}

const REGISTRY = loadRegistry(DESTINATION_ROWS);

/**
 * Why the registry has no rows, or none when it's sound. With one, every request is refused.
 * @type {readonly string[]}
 */
export const REGISTRY_PROBLEMS = REGISTRY.problems;

/** @type {readonly Destination[]} */
export const DESTINATIONS = REGISTRY.destinations;

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
  // Before any prefix is matched: what `URL` resolves and what it keeps encoded alike
  if (encodedPathProblem(givenPath(String(url))) || encodedPathProblem(parsed.pathname)) return { ok: false, code: 'destination-refused' };
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
 * A request's headers as name and value pairs, read as fetch reads them, through the
 * platform's own `new Headers(value)`: a Headers, a record, or any iterable of pairs (a list, a
 * Set, a generator), each read once. Names come lowercased. Null for headers fetch would refuse,
 * or where the platform has no Headers.
 * @param {unknown} headers
 * @returns {Array<[string, string]> | null}
 */
export function headerPairs(headers) {
  if (headers === null || headers === undefined) return [];
  const Platform = globalThis.Headers;
  if (typeof Platform !== 'function') return null;
  try {
    /** @type {Array<[string, string]>} */
    const pairs = [];
    new Platform(/** @type {HeadersInit} */ (headers)).forEach((value, name) => pairs.push([name, value]));
    return pairs;
  } catch {
    return null;
  }
}

/**
 * The problems with `url`'s query: a parameter that would carry a credential, in any case
 * @param {unknown} url
 * @returns {string[]}
 */
export function queryProblems(url) {
  const parsed = parse(url);
  if (parsed && [...parsed.searchParams.keys()].some(key => CREDENTIAL_PARAMS.includes(key.toLowerCase()))) {
    return ['a credential in the URL'];
  }
  return [];
}

/**
 * The problems with a request to `url` on `row` carrying `headers`: a name the row doesn't
 * list, a line break in a name or value, or a credential in the URL's query
 * @param {Destination} row
 * @param {unknown} headers - anything fetch takes as headers (headerPairs)
 * @param {unknown} url
 * @returns {string[]}
 */
export function headerProblems(row, headers, url) {
  /** @type {string[]} */
  const problems = [];
  const allowed = new Set(row.headers.map(name => name.toLowerCase()));
  const pairs = headerPairs(headers);
  if (pairs === null) return ['headers fetch would refuse', ...queryProblems(url)];
  for (const [name, value] of pairs) {
    if (!HEADER_NAME.test(name)) problems.push('a header name that is not a token');
    else if (!allowed.has(name.toLowerCase())) problems.push(`a header ${row.id} doesn't take`);
    if (/[\r\n]/.test(value)) problems.push('a line break in a header value');
  }
  return [...problems, ...queryProblems(url)];
}

/**
 * What a request on `row` goes with: `init`, with the header pairs it holds read once
 * (headerPairs) and sent as read, never the caller's object a second time, no cookies, and no
 * redirect followed when it carries a credential, by the row's scheme or in the headers it
 * sends, or a body. A caller that checked `init.headers` passes the pairs it checked.
 * @param {Destination} row
 * @param {RequestInit} init
 * @returns {RequestInit}
 */
export function requestInit(row, init) {
  /** @type {RequestInit} */
  const built = { ...init, credentials: 'omit' };
  const pairs = init.headers === undefined ? [] : headerPairs(init.headers);
  if (pairs === null) throw new TypeError('headers fetch would refuse');
  if (init.headers !== undefined) built.headers = pairs;
  const credentialSent = pairs.some(([name]) => CREDENTIAL_CARRIERS.includes(name));
  if (row.credential !== 'none' || credentialSent || init.body !== undefined) built.redirect = 'error';
  return built;
}

/**
 * Whether `pairs` (headerPairs) carry a credential
 * @param {ReadonlyArray<readonly [string, string]>} pairs
 * @returns {boolean}
 */
export function carriesCredential(pairs) {
  return pairs.some(([name]) => CREDENTIAL_CARRIERS.includes(name.toLowerCase()));
}
