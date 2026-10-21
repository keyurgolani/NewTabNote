/**
 * #13's router (#13, "Topology", "Handshake and compatibility", "Cancellation, deadlines,
 * payloads", and "Outcomes and authorization"): the coordinator's one way in for contract
 * traffic. Each transport hands it a connection with the surface it verified for the other
 * end: from the sender a runtime port reports, or from the composition root that made an
 * in-process pair. A connection opens with the handshake, and then every request passes the
 * same checks before a handler sees it, deny by default, whichever transport carried it:
 *
 * 1. the connection said hello, in a protocol whose major version matches this one's;
 * 2. the message, its operation and version, its size, and its payload schema
 *    (contracts/validate.js);
 * 3. its deadline hasn't come;
 * 4. #12's PolicyPort allows the verified caller, `{surface, contextId}`, whose contextId is
 *    the session the hello named;
 * 5. every entity id it carries is of a type its catalog entry declares, and every
 *    destination one the entry lists (messaging/scope.js);
 * 6. a handler serves it.
 *
 * A refusal is an error frame with its transport code. A request that passes gets one answer:
 * its handler's, once the operation's result schema takes it and it encodes within
 * MAX_MESSAGE_BYTES, or else an error frame. A command whose handler had begun its transaction
 * gets `outcome-unknown` then, since it may have committed. A message it can't read as a frame
 * gets nothing, since nothing in it can be trusted to name a request.
 *
 * The router enforces each request's deadline, and its entry's when the request sets a later
 * one. A query stops there or when it's cancelled, as does a command that hasn't opened its
 * transaction. A command that has runs to its outcome: a cancel gets `too-late` with that
 * outcome, then the response. A connection that closes stops what it asked for the same way.
 */

import { encode, encodedBytes } from '../contracts/codec.js';
import { code } from '../contracts/fields.js';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '../contracts/limits.js';
import { check, checkRequest, checkResult, readFrame } from '../contracts/validate.js';
import { silentLogger } from '../ports/runtime.js';
import { createLookup } from './operations.js';
import { createScopeCheck } from './scope.js';

/** @typedef {import('../contracts/envelope.js').HelloFrame} HelloFrame */
/** @typedef {import('../contracts/envelope.js').RequestFrame} RequestFrame */
/** @typedef {import('../contracts/envelope.js').WelcomeFrame} WelcomeFrame */
/** @typedef {import('../contracts/transport-codes.js').TransportCode} TransportCode */
/** @typedef {import('../contracts/validate.js').Operation} Operation */
/** @typedef {import('../ports/policy.js').Caller} Caller */
/** @typedef {import('../ports/policy.js').PolicyPort} PolicyPort */
/** @typedef {import('../ports/runtime.js').Clock} Clock */
/** @typedef {import('../ports/runtime.js').Logger} Logger */
/** @typedef {import('../ports/runtime.js').Timers} Timers */
/** @typedef {import('./link.js').Connection} Connection */
/** @typedef {import('./link.js').Link} Link */
/** @typedef {import('./operations.js').Lookup} Lookup */

/**
 * What a handler is told about the request it serves
 * @typedef {object} Dispatch
 * @property {Caller} caller - the principal the router verified
 * @property {number} deadline - when the router stops waiting for its answer
 * @property {() => boolean} begin
 *   A command's handler calls it just before it opens its transaction, and opens none if it
 *   answers false: the request was cancelled, its deadline came, or its connection closed.
 *   From then on the command runs to its outcome, whatever happens to the request, so a
 *   commit is never cut off halfway.
 * @property {(listener: () => void) => void} onCancel
 *   Tells `listener` once if the router stops waiting for the answer: a query, or a command
 *   that hasn't begun, was cancelled, its deadline came, or its connection closed
 */

/**
 * Serves one operation: answers the payload its schema took with a command's outcome or a
 * query's state, or a promise of one
 * @callback Handler
 * @param {unknown} payload
 * @param {Dispatch} context
 * @returns {unknown}
 */

/**
 * Whether the coordinator is ready, or degraded and why, which the welcome says
 * @typedef {{status: 'ready'} | {status: 'degraded', reason?: string}} CoordinatorStatus
 */

/**
 * @typedef {object} RouterOptions
 * @property {Lookup} [lookup] - the operations it knows besides the coordinator's own queries
 * @property {Readonly<Record<string, Handler>>} [handlers] - by operation name
 * @property {PolicyPort} policy
 * @property {Clock} clock
 * @property {Timers} timers
 * @property {string} coordinatorId - this instance's id, new each time the worker starts
 * @property {string} extensionVersion
 * @property {() => CoordinatorStatus} [status]
 * @property {Logger} [logger]
 */

/**
 * @typedef {object} Router
 * @property {(connection: Connection) => void} accept
 * @property {() => void} close - closes every connection, as the worker stopping would
 */

/**
 * A request the router is waiting on its handler for
 * @typedef {object} Running
 * @property {boolean} isCommand
 * @property {boolean} begun - a command's handler has opened its transaction
 * @property {boolean} ended - the router has stopped waiting for its answer
 * @property {boolean} cancelAsked - a cancel came after the command began
 * @property {unknown} timer
 * @property {Array<() => void>} listeners - told if it ends unanswered
 */

/**
 * What the router knows of one connection
 * @typedef {object} Peer
 * @property {Link} link
 * @property {import('../contracts/surfaces.js').Surface} surface
 * @property {'new' | 'open' | 'incompatible' | 'closed'} phase
 * @property {string} sessionId
 * @property {Map<string, Running>} running - by requestId
 */

/**
 * What a policy denial answers as. `unknown-caller` is a sender the router can't name and
 * `unknown-operation` one the policy has no entry for, and every other denial, #21's
 * included, is a surface the operation isn't for.
 * @type {Readonly<Record<string, TransportCode>>}
 */
const DENIALS = Object.freeze({ 'unknown-caller': 'unauthorized-sender', 'unknown-operation': 'unknown-operation' });

/**
 * @param {RouterOptions} options
 * @returns {Router}
 */
export function createRouter({
  lookup = createLookup(),
  handlers = {},
  policy,
  clock,
  timers,
  coordinatorId,
  extensionVersion,
  status = () => ({ status: 'ready' }),
  logger = silentLogger,
}) {
  const inScope = createScopeCheck();
  /** @type {Set<Peer>} */
  const peers = new Set();

  /**
   * Tells the logger, whose own failure changes no answer
   * @param {string} event
   * @param {Record<string, unknown>} detail
   */
  const warn = (event, detail) => {
    try {
      logger.warn(event, detail);
    } catch {
      // Nothing to tell
    }
  };

  /**
   * @param {Peer} peer
   * @param {string} text
   */
  const sendText = (peer, text) => {
    if (peer.phase === 'closed') return;
    try {
      peer.link.send(text);
    } catch {
      // The other end went: its link tells the router, which drops the connection
    }
  };

  /**
   * @param {Peer} peer
   * @param {object} frame
   */
  const send = (peer, frame) => sendText(peer, encode(frame));

  /**
   * @param {Peer} peer
   * @param {string} requestId
   * @param {TransportCode} failure
   */
  const refuse = (peer, requestId, failure) => {
    send(peer, { frame: 'error', requestId, code: failure });
  };

  /**
   * Stops waiting for a request's answer. `tell` its handler to stop too, unless it's a
   * command that has begun, which runs to its outcome.
   * @param {Peer} peer
   * @param {string} requestId
   * @param {Running} running
   * @param {boolean} tell
   */
  const end = (peer, requestId, running, tell) => {
    running.ended = true;
    timers.clear(running.timer);
    peer.running.delete(requestId);
    if (!tell) return;
    for (const listener of running.listeners) {
      try {
        listener();
      } catch (error) {
        warn('router-cancel-listener-failed', { error });
      }
    }
  };

  /**
   * Ends a connection the other end closed, or the router did
   * @param {Peer} peer
   */
  const drop = peer => {
    if (peer.phase === 'closed') return;
    peer.phase = 'closed';
    peers.delete(peer);
    for (const [requestId, running] of [...peer.running]) {
      end(peer, requestId, running, !(running.isCommand && running.begun));
    }
  };

  /** @param {Peer} peer */
  const close = peer => {
    drop(peer);
    peer.link.close();
  };

  /**
   * The welcome's status: what `status` says when it's one a welcome can carry, and degraded
   * otherwise, so a broken status never turns a client away
   * @returns {Pick<WelcomeFrame, 'status' | 'reason'>}
   */
  const statusNow = () => {
    /** @type {unknown} */
    let current;
    try {
      current = status();
    } catch {
      current = null;
    }
    const { status: said, reason } = /** @type {{status?: unknown, reason?: unknown}} */ (current ?? {});
    if (said === 'ready') return { status: 'ready' };
    if (said === 'degraded' && reason === undefined) return { status: 'degraded' };
    if (said === 'degraded' && check(code, reason).ok) {
      return { status: 'degraded', reason: /** @type {string} */ (reason) };
    }
    return { status: 'degraded', reason: 'status-unknown' };
  };

  /**
   * @param {Peer} peer
   * @param {HelloFrame} frame
   */
  const greet = (peer, frame) => {
    // A second hello, or one claiming a surface the transport didn't verify, ends the connection
    if (peer.phase !== 'new' || frame.surface !== peer.surface) {
      close(peer);
      return;
    }
    peer.sessionId = frame.sessionId;
    peer.phase = frame.protocol.major === PROTOCOL_VERSION.major ? 'open' : 'incompatible';
    send(peer, { frame: 'welcome', protocol: PROTOCOL_VERSION, extensionVersion, coordinatorId, ...statusNow() });
  };

  /**
   * The policy's answer: only `allowed: true` allows, and a policy that throws denies
   * @param {unknown} payload
   * @param {Caller} caller
   * @returns {TransportCode | null} the code that refuses it, or null
   */
  const denial = (payload, caller) => {
    try {
      const decision = /** @type {unknown} */ (policy.authorize(/** @type {{type?: unknown}} */ (payload), caller));
      if (decision !== null && typeof decision === 'object') {
        const { allowed, code: denied } = /** @type {{allowed?: unknown, code?: unknown}} */ (decision);
        if (allowed === true) return null;
        if (typeof denied === 'string' && Object.hasOwn(DENIALS, denied)) return DENIALS[denied];
      }
    } catch {
      // Denied, below
    }
    return 'forbidden-for-surface';
  };

  /**
   * @param {Peer} peer
   * @param {RequestFrame} frame
   * @param {number} bytes
   */
  const receive = (peer, frame, bytes) => {
    const { requestId } = frame;
    if (peer.phase === 'new') return refuse(peer, requestId, 'unauthorized-sender');
    if (peer.phase !== 'open') return refuse(peer, requestId, 'unsupported-version');
    // An answer by a running request's id would be ambiguous, so the second gets none
    if (peer.running.has(requestId)) return;
    const checked = checkRequest(frame, bytes, lookup);
    if (!checked.ok) return refuse(peer, requestId, checked.code);
    const { operation, payload } = checked;
    const now = clock.now();
    if (frame.deadline <= now) return refuse(peer, requestId, 'deadline-exceeded');
    /** @type {Caller} */
    const caller = { surface: peer.surface, contextId: peer.sessionId };
    const denied = denial(payload, caller);
    if (denied) return refuse(peer, requestId, denied);
    if (!inScope(operation, payload)) return refuse(peer, requestId, 'forbidden-for-surface');
    const handler = Object.hasOwn(handlers, frame.operation) ? handlers[frame.operation] : undefined;
    if (!handler) return refuse(peer, requestId, 'unknown-operation');
    dispatch(peer, frame, operation, handler, caller, Math.min(frame.deadline, now + operation.entry.deadlineMs));
  };

  /**
   * Runs a request's handler and answers it once
   * @param {Peer} peer
   * @param {RequestFrame} frame
   * @param {Operation} operation
   * @param {Handler} handler
   * @param {Caller} caller
   * @param {number} deadline
   */
  const dispatch = (peer, frame, operation, handler, caller, deadline) => {
    const { requestId } = frame;
    /** @type {Running} */
    const running = {
      isCommand: operation.entry.kind === 'command',
      begun: false,
      ended: false,
      cancelAsked: false,
      timer: undefined,
      listeners: [],
    };
    peer.running.set(requestId, running);
    running.timer = timers.set(() => {
      if (running.ended || (running.isCommand && running.begun)) return;
      end(peer, requestId, running, true);
      refuse(peer, requestId, 'deadline-exceeded');
    }, deadline - clock.now());

    /** @type {Dispatch} */
    const context = Object.freeze({
      caller,
      deadline,
      begin: () => {
        if (running.ended) return false;
        running.begun = true;
        return true;
      },
      onCancel: (/** @type {() => void} */ listener) => {
        if (!running.ended) running.listeners.push(listener);
      },
    });

    /**
     * Ends the request with a code: a command that may have committed is unknown
     * @param {TransportCode} failure - what a query, or a command that didn't begin, gets
     */
    const fail = failure => {
      end(peer, requestId, running, false);
      refuse(peer, requestId, running.isCommand && running.begun ? 'outcome-unknown' : failure);
    };

    /** @param {unknown} error */
    const failed = error => {
      if (running.ended) return;
      warn('router-handler-failed', { operation: frame.operation, error });
      fail('unavailable');
    };

    /** @param {unknown} result */
    const answer = result => {
      if (running.ended) return;
      if (!checkResult(operation, result).ok) {
        warn('router-invalid-answer', { operation: frame.operation });
        return fail(running.isCommand ? 'outcome-unknown' : 'unavailable');
      }
      /** @type {string} */
      let text;
      try {
        text = encode({ frame: 'response', requestId, result });
      } catch {
        warn('router-unencodable-answer', { operation: frame.operation });
        return fail(running.isCommand ? 'outcome-unknown' : 'unavailable');
      }
      // A query's answer too large for one message stays that way, so it isn't retryable
      if (encodedBytes(text) > MAX_MESSAGE_BYTES)
        return fail(running.isCommand ? 'outcome-unknown' : 'payload-too-large');
      end(peer, requestId, running, false);
      if (running.cancelAsked) send(peer, { frame: 'too-late', requestId, outcome: result });
      sendText(peer, text);
    };

    /** @type {unknown} */
    let result;
    try {
      result = handler(frame.payload, context);
    } catch (error) {
      failed(error);
      return;
    }
    Promise.resolve(result).then(answer, failed);
  };

  /**
   * A cancel: a query, or a command that hasn't begun, stops at once. A command that has
   * begun gets too-late with its outcome once it has one.
   * @param {Peer} peer
   * @param {string} requestId
   */
  const cancel = (peer, requestId) => {
    const running = peer.running.get(requestId);
    if (!running) return;
    if (running.isCommand && running.begun) {
      running.cancelAsked = true;
      return;
    }
    end(peer, requestId, running, true);
    send(peer, { frame: 'cancelled', requestId });
  };

  /**
   * @param {Peer} peer
   * @param {unknown} text
   */
  const hear = (peer, text) => {
    if (peer.phase === 'closed') return;
    const read = readFrame(text);
    if (!read.ok) return;
    const { frame, bytes } = read;
    if (frame.frame === 'hello') greet(peer, frame);
    else if (frame.frame === 'request') receive(peer, frame, bytes);
    else if (frame.frame === 'cancel') cancel(peer, frame.requestId);
    // Anything else is a frame only the router sends
  };

  return Object.freeze({
    accept({ link, surface }) {
      /** @type {Peer} */
      const peer = { link, surface, phase: 'new', sessionId: '', running: new Map() };
      peers.add(peer);
      link.onMessage(text => hear(peer, text));
      link.onClose(() => drop(peer));
    },
    close() {
      for (const peer of [...peers]) close(peer);
    },
  });
}
