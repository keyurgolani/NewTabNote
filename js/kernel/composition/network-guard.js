/**
 * The network guard (#21 slice 1b, "Guard"): the first code in every context, a page's first
 * script (js/network-guard.js, built as a classic script with the registry's rows inlined), the
 * service worker's first module, and the indexer's. installGuard wraps the context's fetch,
 * XMLHttpRequest, WebSocket, EventSource, and navigator.sendBeacon, so whatever loads after it,
 * first-party code and the libraries the loader puts in alike, reaches only:
 *
 * - a registry row, by its origin, path prefix, and methods, with the headers it takes and no
 *   credential in the query; a loopback row only with fetch, at the origin `loopback` answers,
 *   the stored Ollama URL's, or any loopback port where it answers ANY_LOOPBACK; a stored row
 *   only with fetch, at the origin `stored` answers, the stored WebDAV server's;
 * - this extension's own origin, blob:, and data:.
 *
 * What goes is what was checked. fetch builds one Request from the caller's input and options
 * with the platform's Request as it was at install, checks that Request's URL, method, headers,
 * body, and credentials through the platform's own getters, and sends it. The other APIs get the
 * URL the guard converted and checked, and a header the string it recorded. A relative URL
 * resolves against the document's base URL, as the platform's own does.
 *
 * A call with a credential (by its row's scheme, in a header it sends, or cookies: credentials
 * 'include', an XHR's withCredentials) or a body follows no redirect: fetch sends it with
 * `redirect: 'error'`, and an XHR, an EventSource, or a beacon, which follow every redirect, is
 * refused. An XHR send with no open the guard saw is refused.
 *
 * A refused call looks to its caller exactly like an offline failure: fetch rejects with a
 * TypeError, an XHR, a WebSocket, and an EventSource fire error, and sendBeacon returns false.
 * Each refusal is counted by kind, and reported to the installer's listener the first time and
 * then at most once an hour, with the count so far: `network.request-refused` in the diagnostic
 * journal (event-codes.js). Only the installer holds the handle that listens (onRefused) and
 * refuses everything (refuseAll); the context's global carries a mark with the surface only.
 *
 * It's a layer against first-party code and libraries calling the network as they normally
 * do. It wraps its own realm only: another realm (a frame's window, one the page opens, the
 * Picture-in-Picture window), an API it doesn't wrap, and code that takes the page apart are
 * the extension's CSP's to stop (#21 PR 3).
 *
 * It reads the registry's rows cut to what it checks (destination-match.js's guardRows), with
 * the rules the destination client uses, from the same module. The page guard's build inlines
 * the rows already cut, once destinations.js has validated them, so it carries no validator: a
 * row that isn't a row's shape makes it refuse every destination, as does refuseAll(), which
 * the service worker calls when the client finds a problem with the registry. Either is
 * reported once. installGuard never throws, and wraps each API on its own, so one it can't wrap
 * leaves the others wrapped. Loading this module touches no browser API.
 */

import { DESTINATION_ROWS } from './destination-rows.js';
import {
  LOOPBACK_HOSTS,
  carriesCredential,
  guardRows,
  headerPairs,
  headerRefusal,
  matchDestination,
  queryCarriesCredential,
} from './destination-match.js';

/** The guard's mark: on each function it wraps, and on the context, with the surface */
export const GUARD = Symbol.for('ntn.networkGuard');

/** What `loopback` answers where any loopback port is allowed: the offscreen document's */
export const ANY_LOOPBACK = 'any-loopback';

/** The least time between two reports of one kind of refusal */
export const REFUSAL_REPORT_MS = 60 * 60 * 1000;

const DESTINATION = 'destination-refused';
const HEADERS = 'headers-refused';
const REDIRECT = 'redirect-refused';
const REGISTRY = 'registry-unreadable';

/**
 * Why a call was refused, as the journal's error code (codes.js)
 * @typedef {'destination-refused' | 'headers-refused' | 'redirect-refused' | 'registry-unreadable'} RefusalCode
 */

/** @typedef {{surface: string, errorCode: RefusalCode, count: number}} RefusalReport */

/**
 * The guard's handle, which only its installer holds
 * @typedef {object} GuardHandle
 * @property {string} surface
 * @property {(listener: (report: RefusalReport) => void) => void} onRefused - the one listener,
 *   which gets the reports that waited first; a second call changes nothing
 * @property {() => void} refuseAll - refuse every destination from now on, reported once
 */

/**
 * An origin a fetch may reach beyond the rows' own: now or once read, or null for none
 * @typedef {() => string | null | Promise<string | null>} OriginSource
 */

/**
 * @typedef {object} GuardOptions
 * @property {string} surface - the context, as the journal names it (surfaces.js)
 * @property {OriginSource} [loopback] - the stored Ollama URL's origin, or ANY_LOOPBACK
 * @property {OriginSource} [stored] - the stored WebDAV server's origin
 * @property {() => number} [now]
 * @property {unknown} [rows] - the registry's rows (destination-rows.js)
 */

/**
 * Mark `fn` as the guard's
 * @template {object} T
 * @param {T} fn
 * @returns {T}
 */
function marked(fn) {
  Object.defineProperty(fn, GUARD, { value: true });
  return fn;
}

/**
 * Replace `owner[key]` with what `make` makes of it, marked, unless it's missing or the guard's
 * already. Never throws.
 * @param {any} owner
 * @param {string} key
 * @param {(original: any) => any} make
 */
function wrap(owner, key, make) {
  try {
    const original = owner[key];
    if (typeof original === 'function' && !original[GUARD]) owner[key] = marked(make(original));
  } catch {
    // The other APIs are wrapped on their own
  }
}

/**
 * The getter `name` on `proto`, as it is now, or null
 * @param {any} proto
 * @param {string} name
 * @returns {any}
 */
function getter(proto, name) {
  try {
    return /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(proto, name)).get || null;
  } catch {
    return null;
  }
}

/**
 * Install the guard on `scope`, once. Answers its handle, which only the installer gets, or
 * null when the context has a guard already.
 * @param {any} scope - the context's global
 * @param {GuardOptions} options
 * @returns {GuardHandle | null}
 */
export function installGuard(scope, { surface, loopback = () => null, stored = () => null, now = () => Date.now(), rows = DESTINATION_ROWS }) {
  if (scope[GUARD]) return null;

  // The platform's own, as they are now, before any later code could replace them
  const NativeURL = scope.URL;
  const NativeRequest = scope.Request;
  const NativeEvent = scope.Event;
  const setTimer = scope.setTimeout;
  // Called on its own global, as the platform's timers have to be
  const later = (/** @type {() => void} */ fn) => setTimer.call(scope, fn, 0);
  const request = NativeRequest && NativeRequest.prototype;
  /** @type {Record<string, any>} */
  const read = {
    url: getter(request, 'url'),
    method: getter(request, 'method'),
    headers: getter(request, 'headers'),
    body: getter(request, 'body'),
    credentials: getter(request, 'credentials'),
  };

  /** @type {Map<RefusalCode, {count: number, at: number | null}>} */
  const kinds = new Map();
  /** @type {RefusalReport[]} */
  const waiting = [];
  /** @type {((report: RefusalReport) => void) | null} */
  let listener = null;

  /** @param {RefusalReport} report */
  const emit = report => {
    if (!listener) {
      if (waiting.length < 32) waiting.push(report);
      return;
    }
    try {
      listener(report);
    } catch {
      // A listener's failure is its own; the refusal stands
    }
  };

  /**
   * Count a refusal, and report it the first time and then at most once an hour
   * @param {RefusalCode} code
   * @param {number} [by]
   */
  const refused = (code, by = 1) => {
    try {
      const kind = kinds.get(code) || { count: 0, at: null };
      kinds.set(code, kind);
      kind.count += by;
      const at = now();
      if (kind.at === null || at - kind.at >= REFUSAL_REPORT_MS) {
        kind.at = at;
        emit({ surface, errorCode: code, count: kind.count });
      }
    } catch {
      // Counting never stops a refusal
    }
  };

  let registry = guardRows(rows);

  /** @type {GuardHandle} */
  const handle = Object.freeze({
    surface,
    onRefused(/** @type {(report: RefusalReport) => void} */ fn) {
      if (typeof fn !== 'function' || listener) return;
      listener = fn;
      waiting.splice(0).forEach(emit);
    },
    refuseAll() {
      if (!registry) return;
      registry = null;
      refused(REGISTRY, 0);
    },
  });
  try {
    Object.defineProperty(scope, GUARD, { value: Object.freeze({ surface }) });
  } catch {
    // A context that won't hold the mark is still wrapped below
  }
  if (!registry) refused(REGISTRY, 0);

  /**
   * `raw` as a URL against the document's base URL (the location's, where there's no
   * document), or null. `raw` is converted to a string once, here.
   * @param {string} raw
   * @returns {URL | null}
   */
  const parse = raw => {
    try {
      const base = (scope.document && scope.document.baseURI) || (scope.location && scope.location.href);
      return new NativeURL(raw, base);
    } catch {
      return null;
    }
  };

  /**
   * Whether `url` is on a loopback host, so worth reading the loopback origin for
   * @param {URL | null} url
   */
  const local = url => url !== null && LOOPBACK_HOSTS.includes(url.hostname);

  /**
   * The check every call goes through: why it's refused, or whether it's credentialed (a
   * credential, cookies, or a body), so follows no redirect
   * @param {string} raw - the URL as given, converted once
   * @param {URL | null} url - `raw` parsed
   * @param {string} method
   * @param {Array<[string, string]> | null} pairs
   * @param {boolean} credentialed - a body or cookies
   * @param {string | null} allowed - the loopback origin
   * @param {string | null} [storedOrigin] - the stored WebDAV server's origin
   * @returns {RefusalCode | boolean}
   */
  const check = (raw, url, method, pairs, credentialed, allowed, storedOrigin = null) => {
    try {
      if (!url) return DESTINATION;
      const own = url.protocol === 'chrome-extension:' && url.host !== '' && !url.username && !url.password
        && [scope.chrome && scope.chrome.runtime && scope.chrome.runtime.id, scope.location && scope.location.host].includes(url.host);
      if (url.protocol === 'blob:' || url.protocol === 'data:' || own) return false;
      if (!registry) return REGISTRY;
      if (!pairs) return HEADERS;
      const loopbackOrigin = allowed === ANY_LOOPBACK ? (url.protocol === 'http:' && local(url) ? url.origin : null) : allowed;
      // An absolute URL as given, so a dot segment `URL` would resolve is still seen
      const given = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : url.href;
      const found = matchDestination(registry, given, { method, loopback: loopbackOrigin, stored: storedOrigin });
      if (!found.ok || found.url.href !== url.href) return DESTINATION;
      if (pairs.some(([name, value]) => headerRefusal(found.row, name, value)) || queryCarriesCredential(url.href)) return HEADERS;
      return found.row.credential !== 'none' || carriesCredential(pairs) || credentialed;
    } catch {
      return DESTINATION;
    }
  };

  /**
   * An origin a source answers, or null, never a throw
   * @param {OriginSource} source
   * @returns {Promise<string | null>}
   */
  const origin = async source => {
    try {
      const value = await source();
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  /**
   * Fire each of `types` at `target` once the caller's code has run, as a network failure does
   * @param {any} target
   * @param {string[]} types
   */
  const fire = (target, types) => {
    later(() => {
      for (const type of types) {
        try {
          target.dispatchEvent(new NativeEvent(type));
        } catch {
          // A handler's throw is the handler's
        }
      }
    });
  };

  wrap(scope, 'fetch', original => function fetch(/** @type {any} */ input, /** @type {any} */ init) {
    return (async () => {
      if (!NativeRequest || !read.url) {
        refused(DESTINATION);
        throw new TypeError('Failed to fetch');
      }
      // One Request, from the caller's input and options read once: what's checked is what goes
      const given = input instanceof NativeRequest ? null : String(input);
      const parsed = given === null ? null : parse(given);
      /** @type {Request} */
      const built = new NativeRequest(given === null ? input : parsed ? parsed.href : given, init);
      const raw = given === null ? read.url.call(built) : given;
      const url = parse(read.url.call(built));
      const method = read.method.call(built);
      const pairs = headerPairs(read.headers.call(built));
      const credentialed = read.body.call(built) !== null || read.credentials.call(built) === 'include';
      const allowed = local(url) ? await origin(loopback) : null;
      let verdict = check(raw, url, method, pairs, credentialed, allowed);
      // The stored WebDAV server, read only for a call no other row takes
      if (verdict === DESTINATION) {
        const server = await origin(stored);
        if (server) verdict = check(raw, url, method, pairs, credentialed, allowed, server);
      }
      if (typeof verdict === 'string') {
        refused(verdict);
        throw new TypeError('Failed to fetch');
      }
      return original.call(scope, verdict ? new NativeRequest(built, { redirect: 'error' }) : built);
    })();
  });

  let xhr;
  try {
    xhr = scope.XMLHttpRequest.prototype;
  } catch {
    xhr = null;
  }
  const withCredentials = getter(xhr, 'withCredentials');
  /** @type {WeakMap<object, [string, string, URL | null, Array<[string, string]>]>} */
  const opened = new WeakMap();
  wrap(xhr, 'open', open => /** @this {any} */ function (/** @type {any} */ method, /** @type {any} */ url, /** @type {any[]} */ ...rest) {
    const verb = String(method);
    const raw = String(url);
    const parsed = parse(raw);
    opened.set(this, [verb.toUpperCase(), raw, parsed, []]);
    return open.call(this, verb, parsed ? parsed.href : raw, ...rest);
  });
  wrap(xhr, 'setRequestHeader', set => /** @this {any} */ function (/** @type {any} */ name, /** @type {any} */ value) {
    const pair = /** @type {[string, string]} */ ([String(name), String(value)]);
    const state = opened.get(this);
    if (state) state[3].push(pair);
    return set.call(this, ...pair);
  });
  wrap(xhr, 'send', send => /** @this {any} */ function (/** @type {any} */ body) {
    const state = opened.get(this);
    const cookies = withCredentials !== null && withCredentials.call(this) === true;
    // A send with no open the guard saw is refused
    const verdict = state ? check(state[1], state[2], state[0], headerPairs(state[3]), body != null || cookies, null) : DESTINATION;
    if (verdict === false) return send.call(this, body);
    // An XHR follows every redirect, so one that mustn't is refused
    refused(verdict === true ? REDIRECT : verdict);
    fire(this, ['error', 'loadend']);
  });

  for (const name of ['WebSocket', 'EventSource']) {
    const socket = name === 'WebSocket';
    wrap(scope, name, Original => {
      const Refused = class extends scope.EventTarget {
        /**
         * @param {unknown} url
         * @param {any} [options]
         */
        constructor(url, options) {
          const raw = String(url);
          const parsed = parse(raw);
          const verdict = check(raw, parsed, 'GET', [], !socket && Boolean(options && options.withCredentials), null);
          // An EventSource follows every redirect, so a credentialed one is refused
          if (verdict === false && parsed) return new Original(parsed.href, options);
          super();
          refused(typeof verdict === 'string' ? verdict : REDIRECT);
          /** @type {any} */
          const self = this;
          Object.assign(self, { url: raw, readyState: socket ? 3 : 2 });
          // Each on<type> handler, as the platform runs it
          for (const type of ['error', 'close']) this.addEventListener(type, (/** @type {Event} */ event) => typeof self[`on${type}`] === 'function' && self[`on${type}`](event));
          fire(this, socket ? ['error', 'close'] : ['error']);
        }

        close() {}

        send() {}
      };
      // A socket or a source the platform made is still one of these, and the constants stay
      Object.defineProperty(Refused, Symbol.hasInstance, { value: (/** @type {any} */ value) => value instanceof Original || Object.prototype.isPrototypeOf.call(Refused.prototype, value) });
      for (const constant of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) if (constant in Original) Object.defineProperty(Refused, constant, { value: Original[constant] });
      return Refused;
    });
  }

  let beacon = null;
  try {
    for (beacon = scope.navigator; beacon && !Object.hasOwn(beacon, 'sendBeacon');) beacon = Object.getPrototypeOf(beacon);
  } catch {
    beacon = null;
  }
  wrap(beacon, 'sendBeacon', send => /** @this {any} */ function sendBeacon(/** @type {any} */ url, /** @type {any} */ data) {
    const raw = String(url);
    const parsed = parse(raw);
    const verdict = check(raw, parsed, 'POST', [], data != null, null);
    if (verdict === false && parsed) return send.call(this, parsed.href, data);
    // A beacon follows every redirect, so one with a body or a credential is refused
    refused(verdict === true ? REDIRECT : typeof verdict === 'string' ? verdict : DESTINATION);
    return false;
  });
  return handle;
}
