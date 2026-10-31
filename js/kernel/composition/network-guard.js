/**
 * The network guard (#21 slice 1b, "Guard"): the first code in every context, a page's first
 * script (js/network-guard.js, built as a classic script with the registry's rows inlined), the
 * service worker's first module, and the indexer's. installGuard wraps the context's fetch,
 * XMLHttpRequest, WebSocket, EventSource, and navigator.sendBeacon, so whatever loads after it,
 * first-party code and the libraries the loader puts in alike, reaches only:
 *
 * - a registry row, by its origin, path prefix, and methods, with the headers it takes and no
 *   credential in the query; loopback only with fetch, and only at the origin `loopback`
 *   answers, the stored Ollama URL's, or any loopback port where it answers ANY_LOOPBACK;
 * - this extension's own origin, blob:, and data:.
 *
 * A request with a credential, by its row's scheme or in the headers it sends, or a body,
 * follows no redirect: fetch sends it with `redirect: 'error'`, and an XHR, an EventSource, or a
 * beacon, which follow every redirect, is refused. What fetch sends is what the guard checked:
 * the caller's options copied once, with the header pairs it read (headerPairs).
 *
 * A refused call looks to its caller exactly like an offline failure: fetch rejects with a
 * TypeError, an XHR, a WebSocket, and an EventSource fire error, and sendBeacon returns false.
 * Each refusal is counted by kind, and reported to the context's one listener (onRefused) the
 * first time and then at most once an hour, with the count so far: `network.request-refused`
 * in the diagnostic journal (event-codes.js). Reports made before it connects wait for it.
 *
 * It wraps its own realm only. Another realm, a frame's window, one it opens, or the
 * Picture-in-Picture window, has its own APIs, which the extension's CSP covers (#21 PR 3).
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

/** The guard's mark: on each function it wraps, and on the context, where its handle is */
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
 * The guard's handle, on its context at `scope[GUARD]`
 * @typedef {object} GuardHandle
 * @property {string} surface
 * @property {(listener: (report: RefusalReport) => void) => void} onRefused - the context's one
 *   listener, which gets the reports that waited first
 * @property {() => void} refuseAll - refuse every destination from now on, reported once
 */

/**
 * The loopback origin a fetch may reach: the stored Ollama URL's, ANY_LOOPBACK, or null for
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
 * Install the guard on `scope`, once: a second call answers the first one's handle
 * @param {any} scope - the context's global
 * @param {GuardOptions} options
 * @returns {GuardHandle}
 */
export function installGuard(scope, { surface, loopback = () => null, now = () => Date.now(), rows = DESTINATION_ROWS }) {
  if (scope[GUARD]) return scope[GUARD];

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
    Object.defineProperty(scope, GUARD, { value: handle });
  } catch {
    // A context that won't hold the handle is still wrapped below
  }
  if (!registry) refused(REGISTRY, 0);

  /**
   * `raw` as a URL against the context's own location, or null
   * @param {unknown} raw
   * @returns {URL | null}
   */
  const parse = raw => {
    try {
      return new scope.URL(String(raw), scope.location && scope.location.href);
    } catch {
      return null;
    }
  };

  /**
   * Whether `raw` is on a loopback host, so worth reading the loopback origin for
   * @param {unknown} raw
   */
  const local = raw => {
    const url = parse(raw);
    return url !== null && LOOPBACK_HOSTS.includes(url.hostname);
  };

  /**
   * The check every call goes through: why it's refused, or whether it's credentialed (a
   * credential or a body), so follows no redirect
   * @param {unknown} raw
   * @param {string} method
   * @param {Array<[string, string]> | null} pairs
   * @param {boolean} body
   * @param {string | null} allowed - the loopback origin
   * @returns {RefusalCode | boolean}
   */
  const check = (raw, method, pairs, body, allowed) => {
    try {
      const url = parse(raw);
      if (!url) return DESTINATION;
      const own = url.protocol === 'chrome-extension:' && url.host !== '' && !url.username && !url.password
        && [scope.chrome && scope.chrome.runtime && scope.chrome.runtime.id, scope.location && scope.location.host].includes(url.host);
      if (url.protocol === 'blob:' || url.protocol === 'data:' || own) return false;
      if (!registry) return REGISTRY;
      if (!pairs) return HEADERS;
      const loopbackOrigin = allowed === ANY_LOOPBACK ? (url.protocol === 'http:' && local(url.href) ? url.origin : null) : allowed;
      // An absolute URL as given, so a dot segment `URL` would resolve is still seen
      const given = /^[a-z][a-z\d+.-]*:/i.test(String(raw)) ? String(raw) : url.href;
      const found = matchDestination(registry, given, { method, loopback: loopbackOrigin });
      if (!found.ok) return DESTINATION;
      if (pairs.some(([name, value]) => headerRefusal(found.row, name, value)) || queryCarriesCredential(url.href)) return HEADERS;
      return found.row.credential !== 'none' || carriesCredential(pairs) || body;
    } catch {
      return DESTINATION;
    }
  };

  /**
   * Fire each of `types` at `target` once the caller's code has run, as a network failure does
   * @param {any} target
   * @param {string[]} types
   */
  const fire = (target, types) => {
    scope.setTimeout(() => {
      for (const type of types) {
        try {
          target.dispatchEvent(new scope.Event(type));
        } catch {
          // A handler's throw is the handler's
        }
      }
    }, 0);
  };

  wrap(scope, 'fetch', original => function fetch(/** @type {any} */ input, /** @type {any} */ init) {
    return (async () => {
      // The caller's options, each read once, and what's sent
      /** @type {Record<string, any>} */
      const given = init && typeof init === 'object' ? { ...init } : {};
      const request = typeof scope.Request === 'function' && input instanceof scope.Request ? input : null;
      const raw = request ? request.url : String(input);
      const pairs = headerPairs(given.headers !== undefined ? given.headers : request ? request.headers : undefined);
      const body = given.body != null || (request !== null && given.body === undefined && request.body !== null);
      const allowed = local(raw) ? await Promise.resolve().then(loopback).catch(() => null) : null;
      const verdict = check(raw, String(given.method || (request ? request.method : 'GET')).toUpperCase(), pairs, body, allowed);
      if (typeof verdict === 'string') {
        refused(verdict);
        throw new TypeError('Failed to fetch');
      }
      if (given.headers !== undefined || request) given.headers = pairs;
      if (verdict) given.redirect = 'error';
      return original.call(scope, request || raw, given);
    })();
  });

  let xhr;
  try {
    xhr = scope.XMLHttpRequest.prototype;
  } catch {
    xhr = null;
  }
  /** @type {WeakMap<object, [string, unknown, Array<[string, string]>]>} */
  const opened = new WeakMap();
  wrap(xhr, 'open', open => /** @this {any} */ function (/** @type {any} */ method, /** @type {any} */ url, /** @type {any[]} */ ...rest) {
    opened.set(this, [String(method).toUpperCase(), url, []]);
    return open.call(this, method, url, ...rest);
  });
  wrap(xhr, 'setRequestHeader', set => /** @this {any} */ function (/** @type {any} */ name, /** @type {any} */ value) {
    const state = opened.get(this);
    if (state) state[2].push([String(name), String(value)]);
    return set.call(this, name, value);
  });
  wrap(xhr, 'send', send => /** @this {any} */ function (/** @type {any} */ body) {
    const state = opened.get(this);
    const verdict = state ? check(state[1], state[0], headerPairs(state[2]), body != null, null) : false;
    if (verdict === false) return send.call(this, body);
    // An XHR follows every redirect, so one that mustn't is refused
    refused(verdict === true ? REDIRECT : verdict);
    fire(this, ['error', 'loadend']);
  });

  for (const name of ['WebSocket', 'EventSource']) {
    const socket = name === 'WebSocket';
    wrap(scope, name, Original => class extends scope.EventTarget {
      /**
       * @param {unknown} url
       * @param {any} [options]
       */
      constructor(url, options) {
        const verdict = check(url, 'GET', [], false, null);
        // An EventSource follows every redirect, so a credentialed one is refused
        if (verdict === false && !(options && options.withCredentials)) return new Original(url, options);
        super();
        refused(typeof verdict === 'string' ? verdict : REDIRECT);
        /** @type {any} */
        const self = this;
        Object.assign(self, { url: String(url), readyState: socket ? 3 : 2 });
        // Each on<type> handler, as the platform runs it
        for (const type of ['error', 'close']) this.addEventListener(type, (/** @type {Event} */ event) => typeof self[`on${type}`] === 'function' && self[`on${type}`](event));
        fire(this, socket ? ['error', 'close'] : ['error']);
      }

      close() {}

      send() {}
    });
  }

  let beacon = null;
  try {
    for (beacon = scope.navigator; beacon && !Object.hasOwn(beacon, 'sendBeacon');) beacon = Object.getPrototypeOf(beacon);
  } catch {
    beacon = null;
  }
  wrap(beacon, 'sendBeacon', send => /** @this {any} */ function sendBeacon(/** @type {any} */ url, /** @type {any} */ data) {
    const verdict = check(url, 'POST', [], data != null, null);
    if (verdict === false) return send.call(this, url, data);
    // A beacon follows every redirect, so one with a body or a credential is refused
    refused(verdict === true ? REDIRECT : verdict);
    return false;
  });
  return handle;
}
