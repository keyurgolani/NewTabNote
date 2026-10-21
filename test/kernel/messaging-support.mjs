// Shared by #13's messaging tests: timers on a clock the test moves, a way to let messages
// already sent arrive, the catalog as the router and client look it up, a raw end of a
// connection that speaks frames to the router, as a client would, and a coordinator the test
// plays for a client.

import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { decode, encode } from '../../js/kernel/core/contracts/codec.js';
import { PROTOCOL_VERSION } from '../../js/kernel/core/contracts/limits.js';
import { QUERIES } from '../../js/kernel/core/contracts/queries.js';
import { linkPair } from '../../js/kernel/core/messaging/in-process.js';
import { createLookup, operationOf } from '../../js/kernel/core/messaging/operations.js';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/kernel/core/contracts/validate.js').Operation} Operation */
/** @typedef {import('../../js/kernel/core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../../js/kernel/core/messaging/link.js').Connection} Connection */
/** @typedef {import('../../js/kernel/core/messaging/link.js').Link} Link */
/** @typedef {import('../../js/kernel/core/ports/runtime.js').Timers} Timers */

/** The extension version the tests' peers run */
export const VERSION = '2.0.0';

/**
 * Lets every message already sent arrive, and whatever each one set off in turn
 * @returns {Promise<void>}
 */
export const settle = () => new Promise(resolve => setImmediate(resolve));

/** The most timers one advance() runs before it fails the test */
const MAX_TIMERS_PER_ADVANCE = 1000;

/**
 * A clock and timers the test moves. Nothing runs until advance() reaches its time, and timers
 * due together run in the order they were set, with messages settling between each.
 * @param {number} [start]
 */
export function testScheduler(start = NOW) {
  let now = start;
  let sequence = 0;
  /** @type {Map<number, {at: number, run: () => void}>} */
  const due = new Map();
  /** @type {Timers} */
  const timers = {
    set(run, ms) {
      sequence += 1;
      due.set(sequence, { at: now + Math.max(0, ms), run });
      return sequence;
    },
    clear(handle) {
      due.delete(/** @type {number} */ (handle));
    },
  };
  return {
    clock: { now: () => now },
    timers,
    /** How many timers are waiting */
    get waiting() {
      return due.size;
    },
    /**
     * Moves the clock `ms` on, running each timer as its time comes
     * @param {number} ms
     */
    async advance(ms) {
      const until = now + ms;
      await settle();
      // Timers that keep setting each other with no time passing would never let advance() end
      for (let ran = 0; ; ran += 1) {
        let next = /** @type {[number, {at: number, run: () => void}] | undefined} */ (undefined);
        for (const timer of due) if (timer[1].at <= until && (!next || timer[1].at < next[1].at)) next = timer;
        if (!next) break;
        if (ran >= MAX_TIMERS_PER_ADVANCE) {
          throw new Error(`more than ${MAX_TIMERS_PER_ADVANCE} timers ran in one advance()`);
        }
        due.delete(next[0]);
        now = next[1].at;
        next[1].run();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

const CATALOG_URL = new URL('../../js/kernel/core/contracts/commands.js', import.meta.url);

/**
 * Every kernel operation, as a composition root hands them to createLookup
 * @type {Readonly<Record<string, Operation>>}
 */
export const OPERATIONS = Object.freeze(
  Object.fromEntries(
    await Promise.all(
      [...Object.entries(COMMANDS), ...Object.entries(QUERIES)].map(async ([name, entry]) => [
        name,
        operationOf(entry, await import(new URL(entry.schema, CATALOG_URL).href)),
      ]),
    ),
  ),
);

/** Finds every kernel operation and the coordinator's own queries */
export const lookup = createLookup(OPERATIONS);

/**
 * A hello from `surface`, for the session `sessionId`
 * @param {Surface} surface
 * @param {string} [sessionId]
 * @param {{major: number, minor: number}} [protocol]
 */
export const hello = (surface, sessionId = `${surface}-session`, protocol = PROTOCOL_VERSION) => ({
  frame: /** @type {const} */ ('hello'),
  protocol,
  extensionVersion: VERSION,
  surface,
  sessionId,
});

/**
 * A raw client end of a new connection to `router`: it sends frames as text and keeps the
 * frames that come back, decoded
 * @param {{accept(connection: Connection): void}} router
 * @param {Surface} surface - the surface the transport verified
 */
export function rawConnection(router, surface) {
  const [near, far] = linkPair();
  router.accept({ link: far, surface });
  /** @type {Array<Record<string, any>>} */
  const frames = [];
  let closed = false;
  near.onMessage(text => frames.push(/** @type {Record<string, any>} */ (decode(text))));
  near.onClose(() => {
    closed = true;
  });
  return {
    frames,
    /** @param {unknown} frame */
    send: frame => near.send(encode(frame)),
    /** @param {string} text */
    sendText: text => near.send(text),
    get closed() {
      return closed;
    },
    close: () => near.close(),
    /**
     * The frames that came back for `requestId`
     * @param {string} requestId
     */
    framesFor: requestId => frames.filter(frame => frame.requestId === requestId),
  };
}

/**
 * A request frame for `payload`, which names its operation by its `type`
 * @param {string} requestId
 * @param {{type: string} & Record<string, unknown>} payload
 * @param {{version?: number, deadline?: number}} [options]
 */
export const request = (requestId, payload, { version = 1, deadline = NOW + 10_000 } = {}) => ({
  frame: 'request',
  requestId,
  operation: payload.type,
  version,
  deadline,
  payload,
});

/**
 * A link whose other end was never there, as a runtime port is when waking the worker
 * fails: it takes what's sent until it closes, on a later microtask, as unreachable
 * @returns {Link}
 */
function unreachableLink() {
  /** @type {Array<(reason: import('../../js/kernel/core/messaging/link.js').CloseReason) => void>} */
  const closes = [];
  let open = true;
  Promise.resolve().then(() => {
    open = false;
    for (const listener of closes) listener('unreachable');
  });
  return {
    send() {
      if (!open) throw new Error('The link is closed');
    },
    onMessage() {},
    onClose: listener => closes.push(listener),
    close() {
      open = false;
    },
  };
}

/**
 * One connection a client opened to a scriptedCoordinator(), which the test answers
 * @typedef {object} Scripted
 * @property {Array<Record<string, any>>} frames - what the client sent, decoded
 * @property {() => Array<Record<string, any>>} requests - the request frames among them
 * @property {(frame: unknown) => void} send
 * @property {(fields?: Record<string, unknown>) => void} welcome - a welcome, with `fields` over a ready one's
 * @property {() => void} close
 * @property {boolean} closed - the client closed it
 */

/**
 * A transport whose far end the test plays, for what a router wouldn't do on its own: a
 * welcome that never comes or speaks another protocol, an answer out of order or outside its
 * schema, a worker that stops. `reach` says what each connect() finds: the coordinator, no
 * coordinator (the link closes as unreachable), or a page whose extension context is gone
 * (connect() throws, as chrome.runtime.connect() does once the extension has reloaded).
 */
export function scriptedCoordinator() {
  /** @type {'open' | 'unreachable' | 'throws'} */
  let reach = 'open';
  /** @type {Scripted[]} */
  const connections = [];
  let attempts = 0;
  /** @type {import('../../js/kernel/core/messaging/link.js').Transport} */
  const transport = {
    connect() {
      attempts += 1;
      if (reach === 'throws') throw new Error('Extension context invalidated.');
      if (reach === 'unreachable') return unreachableLink();
      const [near, far] = linkPair();
      /** @type {Array<Record<string, any>>} */
      const frames = [];
      let closed = false;
      far.onMessage(text => frames.push(/** @type {Record<string, any>} */ (decode(text))));
      far.onClose(() => {
        closed = true;
      });
      connections.push({
        frames,
        requests: () => frames.filter(frame => frame.frame === 'request'),
        send: frame => far.send(encode(frame)),
        welcome: (fields = {}) =>
          far.send(
            encode({
              frame: 'welcome',
              protocol: PROTOCOL_VERSION,
              extensionVersion: VERSION,
              coordinatorId: 'coordinator-1',
              status: 'ready',
              ...fields,
            }),
          ),
        close: () => far.close(),
        get closed() {
          return closed;
        },
      });
      return near;
    },
  };
  return {
    transport,
    connections,
    /** How many times connect() was called, whatever it found */
    get attempts() {
      return attempts;
    },
    /** The connection opened last */
    get last() {
      return /** @type {Scripted} */ (connections.at(-1));
    },
    /** @param {'open' | 'unreachable' | 'throws'} value */
    set reach(value) {
      reach = value;
    },
  };
}
