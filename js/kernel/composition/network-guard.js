/**
 * The network guard (#21 slice 1b, "Guard"): the first code in every context, a page's first
 * script (js/network-guard.js, built as a classic script with the registry inlined), the
 * service worker's first module, and the indexer's. installGuard wraps the context's fetch,
 * XMLHttpRequest, WebSocket, EventSource, and navigator.sendBeacon, so whatever loads after it,
 * first-party code and the libraries the loader puts in alike, reaches only:
 *
 * - a registry row (destinations.js), by its origin, path prefix, and methods, with the
 *   headers it takes and no credential in the query; loopback only at the origin `loopback`
 *   answers, the stored Ollama URL's, or any loopback port where it answers ANY_LOOPBACK;
 * - this extension's own origin, blob:, and data:.
 *
 * A request with a credential, by its row's scheme or in the headers it sends, or a body,
 * follows no redirect: fetch sends it with `redirect: 'error'`, and an XHR, an EventSource, or a
 * beacon, which follow every redirect, is refused. What fetch sends is what the guard checked:
 * the caller's options read once, and the header pairs it read (headerPairs).
 *
 * A refused call looks to its caller exactly like an offline failure: fetch rejects with a
 * TypeError, an XHR, a WebSocket, and an EventSource fire error, and sendBeacon returns false.
 * Each refusal is counted by kind, and reported to the context's listener (onRefused) the first
 * time and then at most once an hour, with the count so far: `network.request-refused` in the
 * diagnostic journal (event-codes.js). Reports made before a listener connects wait for it.
 *
 * It reads the registry's rows cut to what it checks (destination-match.js's guardRows), and
 * the rules from the same module the destination client uses. The page guard's build inlines
 * the rows already cut, after destinations.js has validated them, so it carries no validator: a
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

/** The guard's mark: on each function it wraps, and on the context, where its handle is */
export const GUARD = Symbol.for('ntn.networkGuard');

/** What `loopback` answers where any loopback port is allowed: the offscreen document's */
export const ANY_LOOPBACK = 'any-loopback';

/** The least time between two reports of one kind of refusal */
export const REFUSAL_REPORT_MS = 60 * 60 * 1000;

/** How many reports wait for a listener, at most */
const WAITING_REPORTS = 32;

/** The schemes a context reaches without a row */
const OWN_SCHEMES = Object.freeze(['blob:', 'data:']);

/** The options fetch reads, each read once */
const INIT_KEYS = Object.freeze([
  'method', 'headers', 'body', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy',
  'integrity', 'keepalive', 'signal', 'priority', 'duplex', 'window',
]);

/**
 * Why a call was refused, as the journal's error code (codes.js)
 * @typedef {'destination-refused' | 'headers-refused' | 'redirect-refused' | 'registry-unreadable'} RefusalCode
 */

/** @typedef {{surface: string, errorCode: RefusalCode, count: number}} RefusalReport */

/**
 * The guard's handle, on its context at `scope[GUARD]`
 * @typedef {object} GuardHandle
 * @property {string} surface
 * @property {(listener: (report: RefusalReport) => void) => void} onRefused - the reports that
 *   waited go to the first listener
 * @property {() => void} refuseAll - refuse every destination from now on, reported once
 */

/**
 * The loopback origin a request may reach: the stored Ollama URL's, ANY_LOOPBACK, or null for
 * none, now or once read
 * @typedef {() => string | null | Promise<string | null>} LoopbackSource
 */

/**
 * @typedef {object} GuardOptions
 * @property {string} surface - the context, as the journal names it (surfaces.js)
 * @property {LoopbackSource} [loopback]
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
 * Install the guard on `scope`, once: a second call answers the first one's handle
 * @param {any} scope - the context's global
 * @param {GuardOptions} options
 * @returns {GuardHandle}
 */
export function installGuard(scope, { surface, loopback = () => null, now = () => Date.now(), rows = DESTINATION_ROWS }) {
  if (scope[GUARD]) return scope[GUARD];

  /** @type {Map<RefusalCode, {count: number, reportedAt: number | null}>} */
  const kinds = new Map();
  /** @type {RefusalReport[]} */
  const waiting = [];
  /** @type {Array<(report: RefusalReport) => void>} */
  const listeners = [];

  /** @param {RefusalReport} report */
  const emit = report => {
    if (listeners.length === 0) {
      if (waiting.length < WAITING_REPORTS) waiting.push(report);
      return;
    }
    for (const listener of listeners) {
      try {
        listener(report);
      } catch {
        // A listener's failure is its own; the refusal stands
      }
    }
  };

  /**
   * Count a refusal, and report it the first time and then at most once an hour
   * @param {RefusalCode} code
   * @param {number} [by]
   */
  const refused = (code, by = 1) => {
    try {
      const kind = kinds.get(code) || { count: 0, reportedAt: null };
      kinds.set(code, kind);
      kind.count += by;
      const at = now();
      if (kind.reportedAt === null || at - kind.reportedAt >= REFUSAL_REPORT_MS) {
        kind.reportedAt = at;
        emit({ surface, errorCode: code, count: kind.count });
      }
    } catch {
      // Counting never stops a refusal
    }
  };

  const registry = guardRows(rows);
  let sound = registry !== null;
  const refuseAll = () => {
    if (!sound) return;
    sound = false;
    refused('registry-unreadable', 0);
  };

  /** @type {GuardHandle} */
  const handle = Object.freeze({
    surface,
    onRefused(listener) {
      if (typeof listener !== 'function') return;
      listeners.push(listener);
      if (listeners.length === 1) for (const report of waiting.splice(0)) emit(report);
    },
    refuseAll,
  });
  try {
    Object.defineProperty(scope, GUARD, { value: handle, writable: false, configurable: false, enumerable: false });
  } catch {
    // A context that won't hold the handle is still wrapped below
  }

  if (!sound) refused('registry-unreadable', 0);

  /** The last loopback origin `loopback` answered, for the calls that can't wait for it */
  /** @type {string | null} */
  let lastLoopback = null;

  /**
   * The loopback origin now, or a promise of it
   * @returns {string | null | Promise<string | null>}
   */
  const currentLoopback = () => {
    try {
      const value = loopback();
      if (value && typeof (/** @type {any} */ (value)).then === 'function') {
        return /** @type {Promise<string | null>} */ (value).then(
          read => {
            lastLoopback = typeof read === 'string' ? read : null;
            return lastLoopback;
          },
          () => null,
        );
      }
      lastLoopback = typeof value === 'string' ? value : null;
      return lastLoopback;
    } catch {
      return null;
    }
  };

  const Url = typeof scope.URL === 'function' ? scope.URL : null;

  /**
   * `raw` as a URL against the context's own location, or null
   * @param {unknown} raw
   * @returns {URL | null}
   */
  const parse = raw => {
    if (!Url) return null;
    try {
      const base = scope.location && typeof scope.location.href === 'string' ? scope.location.href : undefined;
      return new Url(String(raw), base);
    } catch {
      return null;
    }
  };

  /**
   * Whether `url` is this extension's own origin
   * @param {URL} url
   * @returns {boolean}
   */
  const isOwn = url => {
    if (url.protocol !== 'chrome-extension:' || url.username !== '' || url.password !== '') return false;
    const id = scope.chrome && scope.chrome.runtime ? scope.chrome.runtime.id : undefined;
    const here = scope.location && typeof scope.location.host === 'string' ? scope.location.host : undefined;
    return (typeof id === 'string' && id !== '' && url.host === id) || (here !== undefined && here !== '' && url.host === here);
  };

  /**
   * The check every call goes through
   * @param {{raw: unknown, method: string, pairs: Array<[string, string]> | null, body: boolean, loopback: string | null}} request
   * @returns {{ok: true, credentialed: boolean} | {ok: false, code: RefusalCode}}
   */
  const check = ({ raw, method, pairs, body, loopback: allowedLoopback }) => {
    try {
      const url = parse(raw);
      if (!url) return { ok: false, code: 'destination-refused' };
      if (OWN_SCHEMES.includes(url.protocol) || isOwn(url)) return { ok: true, credentialed: false };
      if (!sound || registry === null) return { ok: false, code: 'registry-unreadable' };
      if (pairs === null) return { ok: false, code: 'headers-refused' };
      const local = allowedLoopback === ANY_LOOPBACK
        ? (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) ? url.origin : null)
        : allowedLoopback;
      // An absolute URL as given, so a dot segment `URL` would resolve is still seen
      const given = typeof raw === 'string' && parse(raw) !== null && /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : url.href;
      const found = matchDestination(registry, given, { method, loopback: local });
      if (!found.ok) return { ok: false, code: 'destination-refused' };
      if (pairs.some(([name, value]) => headerRefusal(found.row, name, value) !== null) || queryCarriesCredential(url.href)) return { ok: false, code: 'headers-refused' };
      return { ok: true, credentialed: found.row.credential !== 'none' || carriesCredential(pairs) || body };
    } catch {
      return { ok: false, code: 'destination-refused' };
    }
  };

  /**
   * Whether a call to `raw` needs the loopback origin, so is worth reading it for
   * @param {unknown} raw
   * @returns {boolean}
   */
  const isLoopbackUrl = raw => {
    const url = parse(raw);
    return url !== null && LOOPBACK_HOSTS.includes(url.hostname);
  };

  /**
   * The loopback origin for a call that can't wait: the last one read, and a read started for
   * the next call
   * @param {unknown} raw
   * @returns {string | null}
   */
  const loopbackNow = raw => {
    if (!isLoopbackUrl(raw)) return null;
    const value = currentLoopback();
    return typeof value === 'string' || value === null ? value : lastLoopback;
  };

  /**
   * Fire `type` at `target` after the caller's code has run, as a network failure does, with
   * its on<type> handler for a stand-in that isn't an EventTarget's
   * @param {any} target
   * @param {string[]} types
   */
  const fireLater = (target, types) => {
    const Event = scope.Event;
    const later = typeof scope.setTimeout === 'function' ? scope.setTimeout.bind(scope) : (/** @type {() => void} */ fn) => Promise.resolve().then(fn);
    later(() => {
      for (const type of types) {
        try {
          const event = typeof Event === 'function' ? new Event(type) : { type };
          if (typeof target.dispatchEvent === 'function') target.dispatchEvent(event);
        } catch {
          // A handler's throw is the handler's
        }
      }
    }, 0);
  };

  wrapFetch(scope, { check, refused, currentLoopback, isLoopbackUrl });
  wrapXhr(scope, { check, refused, loopbackNow, fireLater });
  for (const name of ['WebSocket', 'EventSource']) replaceStream(scope, name, { check, refused, loopbackNow, fireLater });
  wrapBeacon(scope, { check, refused, loopbackNow });
  return handle;
}

/**
 * @typedef {object} Checks
 * @property {(request: {raw: unknown, method: string, pairs: Array<[string, string]> | null, body: boolean, loopback: string | null}) => ({ok: true, credentialed: boolean} | {ok: false, code: RefusalCode})} check
 * @property {(code: RefusalCode) => void} refused
 */

/**
 * The options fetch was given, each read once, as a plain object
 * @param {unknown} init
 * @returns {Record<string, unknown>}
 */
function readInit(init) {
  /** @type {Record<string, unknown>} */
  const given = {};
  if (init === null || init === undefined || typeof init !== 'object') return given;
  const options = /** @type {Record<string, unknown>} */ (init);
  for (const key of INIT_KEYS) if (key in options) given[key] = options[key];
  return given;
}

/**
 * Wrap fetch
 * @param {any} scope
 * @param {Checks & {currentLoopback: () => string | null | Promise<string | null>, isLoopbackUrl: (raw: unknown) => boolean}} checks
 */
function wrapFetch(scope, { check, refused, currentLoopback, isLoopbackUrl }) {
  try {
    const original = scope.fetch;
    if (typeof original !== 'function' || original[GUARD]) return;
    const Request = typeof scope.Request === 'function' ? scope.Request : null;
    const guarded = marked(function fetch(/** @type {unknown} */ input, /** @type {unknown} */ init) {
      return (async () => {
        const given = readInit(init);
        const request = Request && input instanceof Request ? /** @type {Request} */ (input) : null;
        const raw = request ? request.url : String(input);
        const method = String(given.method !== undefined ? given.method : request ? request.method : 'GET').toUpperCase();
        const pairs = given.headers !== undefined ? headerPairs(given.headers) : request ? headerPairs(request.headers) : [];
        const body = (given.body !== undefined && given.body !== null) || (request !== null && given.body === undefined && request.body !== null);
        const loopback = isLoopbackUrl(raw) ? await currentLoopback() : null;
        const verdict = check({ raw, method, pairs, body, loopback });
        if (!verdict.ok) {
          refused(verdict.code);
          throw new TypeError('Failed to fetch');
        }
        /** @type {Record<string, unknown>} */
        const sent = { ...given };
        // The pairs it checked, never the caller's object a second time
        if (given.headers !== undefined || request) sent.headers = pairs;
        if (verdict.credentialed) sent.redirect = 'error';
        if (request) return original.call(scope, new /** @type {any} */ (Request)(request, sent));
        return original.call(scope, raw, sent);
      })();
    });
    scope.fetch = guarded;
  } catch {
    // The other APIs are wrapped on their own
  }
}

/**
 * Wrap XMLHttpRequest's open, setRequestHeader, and send
 * @param {any} scope
 * @param {Checks & {loopbackNow: (raw: unknown) => string | null, fireLater: (target: any, types: string[]) => void}} checks
 */
function wrapXhr(scope, { check, refused, loopbackNow, fireLater }) {
  try {
    const Xhr = scope.XMLHttpRequest;
    if (typeof Xhr !== 'function' || !Xhr.prototype) return;
    const proto = Xhr.prototype;
    const { open, setRequestHeader, send } = proto;
    if (typeof open !== 'function' || typeof send !== 'function' || send[GUARD]) return;
    /** @type {WeakMap<object, {method: string, url: unknown, headers: Array<[string, string]>}>} */
    const opened = new WeakMap();
        proto.open = marked(/** @this {any} */ function (/** @type {unknown} */ method, /** @type {unknown} */ url, /** @type {unknown[]} */ ...rest) {
      opened.set(this, { method: String(method).toUpperCase(), url, headers: [] });
      return open.call(this, method, url, ...rest);
    });
    if (typeof setRequestHeader === 'function') {
            proto.setRequestHeader = marked(/** @this {any} */ function (/** @type {unknown} */ name, /** @type {unknown} */ value) {
        const state = opened.get(this);
        if (state) state.headers.push([String(name), String(value)]);
        return setRequestHeader.call(this, name, value);
      });
    }
        proto.send = marked(/** @this {any} */ function (/** @type {unknown} */ body) {
      const state = opened.get(this);
      if (!state) return send.call(this, body);
      const raw = state.url;
      const verdict = check({ raw, method: state.method, pairs: headerPairs(state.headers), body: body !== undefined && body !== null, loopback: loopbackNow(raw) });
      // An XHR follows every redirect, so one that mustn't is refused
      const code = !verdict.ok ? verdict.code : verdict.credentialed ? 'redirect-refused' : null;
      if (code === null) return send.call(this, body);
      refused(code);
      fireLater(this, ['error', 'loadend']);
      return undefined;
    });
  } catch {
    // The other APIs are wrapped on their own
  }
}

/**
 * Replace WebSocket or EventSource with one that checks its URL first, and stands in for a
 * refused one: closed, with error (and close, for a WebSocket) fired
 * @param {any} scope
 * @param {string} name
 * @param {Checks & {loopbackNow: (raw: unknown) => string | null, fireLater: (target: any, types: string[]) => void}} checks
 */
function replaceStream(scope, name, { check, refused, loopbackNow, fireLater }) {
  try {
    const Original = scope[name];
    if (typeof Original !== 'function' || Original[GUARD]) return;
    const Target = typeof scope.EventTarget === 'function' ? scope.EventTarget : null;
    const socket = name === 'WebSocket';
    const closed = socket ? 3 : 2;
    const Base = Target || class {};
    class Refused extends Base {
      /**
       * @param {unknown} url
       * @param {unknown} [options]
       */
      constructor(url, options) {
        const credentialed = !socket && options !== null && typeof options === 'object' && Boolean(/** @type {{withCredentials?: unknown}} */ (options).withCredentials);
        const verdict = check({ raw: url, method: 'GET', pairs: [], body: false, loopback: loopbackNow(url) });
        // An EventSource follows every redirect, so one that mustn't is refused
        const code = !verdict.ok ? verdict.code : verdict.credentialed || credentialed ? 'redirect-refused' : null;
        if (code === null) return new Original(url, options);
        super();
        refused(code);
        this.url = String(url);
        this.readyState = closed;
        if (socket) Object.assign(this, { protocol: '', extensions: '', bufferedAmount: 0, binaryType: 'blob' });
        else this.withCredentials = credentialed;
        /** @type {Record<string, any>} */
        const self = this;
        // Each on<type> handler, as the platform's own runs it
        if (!Target) self.dispatchEvent = (/** @type {{type: string}} */ event) => { if (typeof self[`on${event.type}`] === 'function') self[`on${event.type}`](event); };
        else for (const type of socket ? ['error', 'close'] : ['error']) this.addEventListener(type, (/** @type {Event} */ event) => { if (typeof self[`on${type}`] === 'function') self[`on${type}`](event); });
        fireLater(this, socket ? ['error', 'close'] : ['error']);
      }

      close() {}

      send() {}
    }
    for (const [key, value] of Object.entries(socket ? { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } : { CONNECTING: 0, OPEN: 1, CLOSED: 2 })) {
      Object.defineProperty(Refused, key, { value });
      Object.defineProperty(Refused.prototype, key, { value });
    }
    Object.defineProperty(Refused, 'name', { value: name });
    scope[name] = marked(Refused);
  } catch {
    // The other APIs are wrapped on their own
  }
}

/**
 * Wrap navigator.sendBeacon, where it's defined
 * @param {any} scope
 * @param {Checks & {loopbackNow: (raw: unknown) => string | null}} checks
 */
function wrapBeacon(scope, { check, refused, loopbackNow }) {
  try {
    const navigator = scope.navigator;
    if (!navigator) return;
    let owner = navigator;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, 'sendBeacon')) owner = Object.getPrototypeOf(owner);
    if (!owner) return;
    const original = owner.sendBeacon;
    if (typeof original !== 'function' || original[GUARD]) return;
        owner.sendBeacon = marked(/** @this {any} */ function sendBeacon(/** @type {unknown} */ url, /** @type {unknown} */ data) {
      const verdict = check({ raw: url, method: 'POST', pairs: [], body: data !== undefined && data !== null, loopback: loopbackNow(url) });
      // A beacon follows every redirect, so one with a body or a credential is refused
      const code = !verdict.ok ? verdict.code : verdict.credentialed ? 'redirect-refused' : null;
      if (code === null) return original.call(this, url, data);
      refused(code);
      return false;
    });
  } catch {
    // The other APIs are wrapped on their own
  }
}
