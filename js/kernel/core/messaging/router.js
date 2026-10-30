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
 *
 * The `sessions` hooks hear of each connection's session as the router welcomes it in this
 * major, and again when that connection closes, by its surface and sessionId alone, so #35's
 * coordinator knows which pages are there and when one goes.
 *
 * It answers system.messagingHealth itself, from counters only (#13, "Security and privacy"):
 * connections, handshakes, reconnects, requests by the catalog's operation names, outcomes and
 * refusals by code, and answers by latency bucket. Nothing a sender chose is counted by name,
 * and no payload, result, or schema issue reaches its counters or its logger.
 */

import { encode, encodedBytes } from '../contracts/codec.js';
import { code } from '../contracts/fields.js';
import { LATENCY_BUCKETS_MS, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '../contracts/limits.js';
import { ready } from '../contracts/outcomes.js';
import { POLICY_CODES, VALIDATION_CODES } from '../contracts/transport-codes.js';
import { check, checkRequest, checkResult, readFrame } from '../contracts/validate.js';
import { silentLogger } from '../ports/runtime.js';
import { createLookup } from './operations.js';
import { SYSTEM_OPERATIONS } from './system-operations.js';
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
 * @typedef {import('../../../lib/valibot/index.mjs').InferOutput<
 *   typeof import('../contracts/operations/system-messaging-health.js').messagingHealth
 * >} MessagingHealth
 */

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
 *   that hasn't begun, was cancelled, its deadline came, or its connection closed. A listener
 *   added after that is told at once.
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
 * The session one connection's hello named
 * @typedef {object} Session
 * @property {import('../contracts/surfaces.js').Surface} surface - what its transport verified
 * @property {string} sessionId - its hello's, the contextId of every request it sends
 */

/**
 * What #35's coordinator hears of the sessions its pages open. `opened` is told once the
 * router welcomes a connection's hello in this major, and `closed` once when that connection
 * closes, from either end or by close(), with the same frozen Session. A connection that
 * never opened is told of neither. Each connection is told apart, so a session that
 * reconnects can open its next connection before its last one's close arrives. A hook that
 * throws changes no answer.
 * @typedef {object} SessionHooks
 * @property {(session: Session) => void} [opened]
 * @property {(session: Session) => void} [closed]
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
 * @property {SessionHooks} [sessions]
 * @property {Logger} [logger]
 */

/**
 * @typedef {object} Router
 * @property {(connection: Connection) => void} accept
 * @property {() => void} close - closes every connection, as the worker stopping would
 * @property {() => MessagingHealth} health - what system.messagingHealth answers with
 */

/**
 * A request the router is waiting on its handler for
 * @typedef {object} Running
 * @property {boolean} isCommand
 * @property {boolean} begun - a command's handler has opened its transaction
 * @property {boolean} ended - the router has stopped waiting for its answer
 * @property {boolean} cancelAsked - a cancel came after the command began
 * @property {boolean} stopped - it ended unanswered, and its handler was told to stop
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
 * @property {Session | null} session - what the session hooks were told it opened, if they were
 * @property {Map<string, Running>} running - by requestId
 */

/**
 * What a policy denial answers as. `unknown-caller` is a sender the router can't name and
 * `unknown-operation` one the policy has no entry for, and every other denial, #21's
 * included, is a surface the operation isn't for.
 * @type {Readonly<Record<string, TransportCode>>}
 */
const DENIALS = Object.freeze({ 'unknown-caller': 'unauthorized-sender', 'unknown-operation': 'unknown-operation' });

/** The most outcome codes it counts apart. Any after them count as `other`. */
const MAX_OUTCOME_CODES = 64;

/** The most sessions it remembers, to count a hello from one it has seen as a reconnect */
const MAX_SESSIONS = 256;

/**
 * @param {Map<string | number | null, number>} counts
 * @param {string | number | null} key
 */
const tally = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

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
  sessions = {},
  logger = silentLogger,
}) {
  /** @type {Lookup} the coordinator's own queries first, which nothing it's given replaces */
  const find = name => (Object.hasOwn(SYSTEM_OPERATIONS, name) ? SYSTEM_OPERATIONS[name] : lookup(name));
  const inScope = createScopeCheck();
  /** @type {Set<Peer>} */
  const peers = new Set();
  /** @type {Set<string>} the sessions it has seen, by sessionId */
  const seen = new Set();
  const counts = {
    handshakes: 0,
    reconnects: 0,
    /** @type {Map<string, number>} by operation */
    requests: new Map(),
    /** @type {Map<string, number>} by code */
    outcomes: new Map(),
    /** @type {Map<TransportCode, number>} by code */
    refusals: new Map(),
    /** @type {Map<number | null, number>} by bucket */
    latency: new Map(),
  };

  /** @returns {MessagingHealth} */
  const health = () => ({
    protocol: { ...PROTOCOL_VERSION },
    coordinatorId,
    connections: peers.size,
    handshakes: counts.handshakes,
    reconnects: counts.reconnects,
    requests: [...counts.requests].map(([operation, count]) => ({ operation, count })),
    outcomes: [...counts.outcomes].map(([outcome, count]) => ({ code: outcome, count })),
    rejections: [...counts.refusals].map(([refusal, count]) => ({ reason: reasonOf(refusal), code: refusal, count })),
    latency: [...LATENCY_BUCKETS_MS, null]
      .filter(bucket => counts.latency.has(bucket))
      .map(bucket => ({ underMs: bucket, count: /** @type {number} */ (counts.latency.get(bucket)) })),
  });

  /** @type {Readonly<Record<string, Handler>>} */
  const ownHandlers = Object.freeze({ 'system.messagingHealth': () => ready(clock.now(), health()) });

  /**
   * @param {TransportCode} refusal
   * @returns {'validation' | 'policy' | 'coordinator'}
   */
  const reasonOf = refusal => {
    if (/** @type {readonly string[]} */ (VALIDATION_CODES).includes(refusal)) return 'validation';
    return /** @type {readonly string[]} */ (POLICY_CODES).includes(refusal) ? 'policy' : 'coordinator';
  };

  /** @param {unknown} name - an outcome's code */
  const countOutcome = name => {
    const known = typeof name === 'string' && check(code, name).ok ? name : 'other';
    tally(counts.outcomes, counts.outcomes.has(known) || counts.outcomes.size < MAX_OUTCOME_CODES ? known : 'other');
  };

  /**
   * Counts an answer by its outcome's code, or a query state's kind when it has none, and by
   * how long it took
   * @param {unknown} result
   * @param {number} since - when its request arrived
   */
  const countAnswer = (result, since) => {
    const { code: outcome, kind } = /** @type {{code?: unknown, kind?: unknown}} */ (result);
    countOutcome(typeof outcome === 'string' ? outcome : kind);
    const took = clock.now() - since;
    tally(counts.latency, LATENCY_BUCKETS_MS.find(bound => took < bound) ?? null);
  };

  /** @param {Peer} peer */
  const countHandshake = peer => {
    counts.handshakes += 1;
    if (seen.has(peer.sessionId)) {
      counts.reconnects += 1;
      return;
    }
    seen.add(peer.sessionId);
    if (seen.size > MAX_SESSIONS) seen.delete(/** @type {string} */ (seen.values().next().value));
  };

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
   * Tells a session hook, whose failure changes no answer either
   * @param {'opened' | 'closed'} event
   * @param {Session} session
   */
  const tellSessions = (event, session) => {
    const hook = sessions[event];
    if (typeof hook !== 'function') return;
    try {
      hook(session);
    } catch (error) {
      warn('router-session-hook-failed', { event, error });
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
    tally(counts.refusals, failure);
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
    running.stopped = true;
    for (const listener of running.listeners) stop(listener);
  };

  /**
   * Tells a handler its request was stopped
   * @param {() => void} listener
   */
  const stop = listener => {
    try {
      listener();
    } catch (error) {
      warn('router-cancel-listener-failed', { error });
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
    if (peer.session) tellSessions('closed', peer.session);
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
      tally(counts.refusals, peer.phase === 'new' ? 'unauthorized-sender' : 'invalid-payload');
      close(peer);
      return;
    }
    peer.sessionId = frame.sessionId;
    peer.phase = frame.protocol.major === PROTOCOL_VERSION.major ? 'open' : 'incompatible';
    countHandshake(peer);
    send(peer, { frame: 'welcome', protocol: PROTOCOL_VERSION, extensionVersion, coordinatorId, ...statusNow() });
    if (peer.phase !== 'open') return;
    peer.session = Object.freeze({ surface: peer.surface, sessionId: peer.sessionId });
    tellSessions('opened', peer.session);
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
    if (peer.running.has(requestId)) {
      tally(counts.refusals, 'invalid-payload');
      return;
    }
    const checked = checkRequest(frame, bytes, find);
    if (!checked.ok) return refuse(peer, requestId, checked.code);
    const { operation, payload } = checked;
    // A name the lookup found is the catalog's, so this counts nothing a sender chose
    tally(counts.requests, frame.operation);
    const now = clock.now();
    if (frame.deadline <= now) return refuse(peer, requestId, 'deadline-exceeded');
    /** @type {Caller} */
    const caller = { surface: peer.surface, contextId: peer.sessionId };
    const denied = denial(payload, caller);
    if (denied) return refuse(peer, requestId, denied);
    if (!inScope(operation, payload)) return refuse(peer, requestId, 'forbidden-for-surface');
    const handler = handlerOf(frame.operation);
    if (!handler) return refuse(peer, requestId, 'unknown-operation');
    dispatch(peer, frame, operation, handler, caller, now);
  };

  /**
   * The handler for an operation: the router's own for the coordinator's queries, which no
   * handler it's given replaces
   * @param {string} name
   * @returns {Handler | undefined}
   */
  const handlerOf = name => {
    if (Object.hasOwn(ownHandlers, name)) return ownHandlers[name];
    return Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  };

  /**
   * Runs a request's handler and answers it once. The router stops waiting at the request's
   * deadline, or its entry's when the request puts its own later.
   * @param {Peer} peer
   * @param {RequestFrame} frame
   * @param {Operation} operation
   * @param {Handler} handler
   * @param {Caller} caller
   * @param {number} arrived
   */
  const dispatch = (peer, frame, operation, handler, caller, arrived) => {
    const { requestId } = frame;
    const deadline = Math.min(frame.deadline, arrived + operation.entry.deadlineMs);
    /** @type {Running} */
    const running = {
      isCommand: operation.entry.kind === 'command',
      begun: false,
      ended: false,
      cancelAsked: false,
      stopped: false,
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
        // A handler that listens once its request was stopped hears it at once
        if (running.stopped) stop(listener);
        else if (!running.ended) running.listeners.push(listener);
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
      if (encodedBytes(text) > MAX_MESSAGE_BYTES) {
        return fail(running.isCommand ? 'outcome-unknown' : 'payload-too-large');
      }
      end(peer, requestId, running, false);
      countAnswer(result, arrived);
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
    countOutcome('cancelled');
    send(peer, { frame: 'cancelled', requestId });
  };

  /**
   * @param {Peer} peer
   * @param {unknown} text
   */
  const hear = (peer, text) => {
    if (peer.phase === 'closed') return;
    const read = readFrame(text);
    if (!read.ok) {
      tally(counts.refusals, read.code);
      return;
    }
    const { frame, bytes } = read;
    if (frame.frame === 'hello') greet(peer, frame);
    else if (frame.frame === 'request') receive(peer, frame, bytes);
    else if (frame.frame === 'cancel') cancel(peer, frame.requestId);
    // Anything else is a frame only the router sends
    else tally(counts.refusals, 'invalid-payload');
  };

  return Object.freeze({
    accept({ link, surface }) {
      /** @type {Peer} */
      const peer = { link, surface, phase: 'new', sessionId: '', session: null, running: new Map() };
      peers.add(peer);
      link.onMessage(text => hear(peer, text));
      link.onClose(() => drop(peer));
    },
    close() {
      for (const peer of [...peers]) close(peer);
    },
    health,
  });
}
