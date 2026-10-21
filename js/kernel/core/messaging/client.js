/**
 * #13's client (#13, "Topology", "Handshake and compatibility", "Cancellation, deadlines,
 * payloads", and "Outcomes and authorization"): how a page, or the worker's own code, reaches
 * the router. It opens one connection, through whichever transport its composition root chose,
 * only once it has something to send, and keeps its session, made once when it's built,
 * across reconnects. Every call answers with #12's outcome union or a query state, however it
 * ended, so a caller handles one union whichever way its request traveled:
 *
 * - A request goes once the coordinator has welcomed this client, and waits until then. One
 *   it can't send at all, for an operation it doesn't know, a payload the codec can't carry,
 *   or one over its operation's size, is refused without a message.
 * - Each request carries its deadline, from when it's sent, which the router enforces. The
 *   client waits DEADLINE_GRACE_MS past it before it gives up, so no client timeout is
 *   shorter, and giving up never starts a second way to run it.
 * - A command whose answer didn't come and that may have started is unknown, and #13 slice 3
 *   resolves it by its commandId before anything shows saved or failed. A command that was
 *   never sent is definitely unavailable.
 * - An answer counts once its operation's result schema takes it, so a reply is as strict as
 *   a request.
 *
 * Its connection state is what the status region (adapters/messaging/status-region.js)
 * announces ("Product and interaction requirements"). Connecting is silent. Reconnecting shows
 * once a user-visible request has waited RECONNECTING_AFTER_MS with no welcome, or at once when
 * the coordinator can't be woken, and when the first attempt and one more after each wait in
 * RECONNECT_DELAYS_MS have all failed, the coordinator is unavailable and what waits is
 * refused. A coordinator whose protocol has another major version gets nothing more, and the
 * page offers Reload only while reloading loses nothing. A worker that stops while nothing
 * waits changes nothing, and no keep-alive runs: the next request reconnects.
 */

import { encode, encodedBytes } from '../contracts/codec.js';
import {
  DEADLINE_GRACE_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RECONNECTING_AFTER_MS,
  RECONNECT_DELAYS_MS,
} from '../contracts/limits.js';
import { commandOutcome, queryFailure } from '../contracts/transport-codes.js';
import { checkResult, readFrame } from '../contracts/validate.js';
import { silentLogger } from '../ports/runtime.js';

/** @typedef {import('../contracts/envelope.js').Frame} Frame */
/** @typedef {import('../contracts/envelope.js').WelcomeFrame} WelcomeFrame */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../contracts/transport-codes.js').TransportCode} TransportCode */
/** @typedef {import('../contracts/validate.js').Operation} Operation */
/** @typedef {import('../ports/runtime.js').Clock} Clock */
/** @typedef {import('../ports/runtime.js').Ids} Ids */
/** @typedef {import('../ports/runtime.js').Logger} Logger */
/** @typedef {import('../ports/runtime.js').Timers} Timers */
/** @typedef {import('./link.js').CloseReason} CloseReason */
/** @typedef {import('./link.js').Link} Link */
/** @typedef {import('./link.js').Transport} Transport */
/** @typedef {import('./operations.js').Lookup} Lookup */

/**
 * @template T
 * @typedef {import('../contracts/outcomes.js').QueryState<T>} QueryState
 */

/**
 * What a caller passes to cancel a call: an AbortSignal, or anything shaped like one
 * @typedef {object} CancelSignal
 * @property {boolean} aborted
 * @property {(type: 'abort', listener: () => void) => void} addEventListener
 * @property {(type: 'abort', listener: () => void) => void} removeEventListener
 */

/**
 * @typedef {object} CallOptions
 * @property {CancelSignal} [signal]
 * @property {boolean} [userVisible] - whether the user waits on it, which only such a call
 *   shows Reconnecting for. True unless a caller says otherwise.
 */

/**
 * A command as its schema takes it, which the router checks: its `type` names its operation
 * @typedef {{type: string, commandId: string} & Record<string, unknown>} CommandInput
 */

/** @typedef {{type: string} & Record<string, unknown>} QueryInput */

/**
 * What the last welcome said of the coordinator: its instance, which changes when the worker
 * restarted, and whether it's ready or degraded and why
 * @typedef {{coordinatorId: string, status: 'ready' | 'degraded', reason?: string}} CoordinatorInfo
 */

/**
 * What a surface shows of its connection. `idle` and `connecting` show nothing, and
 * `connected` shows only as the end of a problem shown before.
 * @typedef {'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'unsupported'} ConnectionState
 */

/**
 * @typedef {object} ClientOptions
 * @property {Transport} transport
 * @property {Surface} surface - the surface this client's context is, which the router checks
 * @property {string} extensionVersion
 * @property {Lookup} lookup - the operations it may send, and the coordinator's own queries
 * @property {Ids} ids - for its session and its requests
 * @property {Clock} clock
 * @property {Timers} timers
 * @property {Logger} [logger]
 * @property {() => boolean} [isComposing] - whether an IME composition is open on the page
 * @property {() => boolean} [hasPendingCommit] - whether the page holds input not yet committed
 */

/**
 * @typedef {object} Client
 * @property {string} sessionId - this context's, which the router takes as its contextId
 * @property {(command: CommandInput, options?: CallOptions) => Promise<Outcome | BulkOutcome>} execute
 * @property {(query: QueryInput, options?: CallOptions) => Promise<QueryState<unknown>>} query
 * @property {() => ConnectionState} state
 * @property {(listener: (state: ConnectionState) => void) => () => void} subscribe
 *   Tells `listener` each new state, until the function it returns is called
 * @property {() => void} retry
 *   Connects now when nothing is connecting, as the status region's Retry does
 * @property {() => boolean} canReload
 *   Whether reloading the page loses nothing: no IME composition, no input the page hasn't
 *   committed, and no command of this client's waiting for its answer
 * @property {() => CoordinatorInfo | null} coordinator
 * @property {() => void} close - settles every call and refuses any after
 */

/**
 * One call, until it settles
 * @typedef {object} Call
 * @property {'command' | 'query'} kind
 * @property {string} name
 * @property {Operation} operation
 * @property {Record<string, unknown>} payload
 * @property {string} commandId
 * @property {string} requestId
 * @property {boolean} visible - the user waits on it
 * @property {number} since - when it was made
 * @property {boolean} sent
 * @property {unknown} timer
 * @property {(answer: unknown) => void} resolve
 * @property {() => void} unlisten
 */

/**
 * @param {ClientOptions} options
 * @returns {Client}
 */
export function createClient({
  transport,
  surface,
  extensionVersion,
  lookup,
  ids,
  clock,
  timers,
  logger = silentLogger,
  isComposing = () => false,
  hasPendingCommit = () => false,
}) {
  const sessionId = ids.next();
  /**
   * - idle: no connection, and nothing to send
   * - connecting: a connection open, and its welcome not yet come
   * - retrying: waiting to try again after an attempt failed
   * - open: welcomed
   * - unavailable: every attempt failed, until the next request or retry()
   * - unsupported: the coordinator speaks another major version
   * - closed: close() was called
   * @type {'idle' | 'connecting' | 'retrying' | 'open' | 'unavailable' | 'unsupported' | 'closed'}
   */
  let phase = 'idle';
  /** @type {Link | null} */
  let link = null;
  /** @type {CoordinatorInfo | null} */
  let coordinator = null;
  /** How many attempts have failed since the last welcome */
  let failures = 0;
  /** Whether Reconnecting shows while it connects */
  let showing = false;
  /** @type {unknown} */
  let handshakeTimer;
  /** @type {unknown} */
  let retryTimer;
  /** @type {unknown} */
  let showTimer = null;
  /** @type {Call[]} calls waiting for the welcome, oldest first */
  let waiting = [];
  /** @type {Map<string, Call>} calls sent, by requestId */
  const sent = new Map();
  /** @type {Set<(state: ConnectionState) => void>} */
  const listeners = new Set();
  /** @type {ConnectionState} */
  let told = 'idle';

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

  /** @returns {ConnectionState} */
  const state = () => {
    if (phase === 'open') return 'connected';
    if (phase === 'unavailable' || phase === 'unsupported') return phase;
    if (phase === 'connecting' || phase === 'retrying') return showing ? 'reconnecting' : 'connecting';
    return 'idle';
  };

  /** Tells the listeners the state, when it changed */
  const tell = () => {
    const now = state();
    if (now === told) return;
    told = now;
    for (const listener of [...listeners]) {
      try {
        listener(now);
      } catch (error) {
        warn('client-status-listener-failed', { error });
      }
    }
  };

  /**
   * The answer a transport code gives a call: for a call that may have started, a command
   * whose answer didn't come is unknown
   * @param {Call} call
   * @param {TransportCode} code
   * @param {boolean} mayHaveStarted
   */
  const answerFor = (call, code, mayHaveStarted) =>
    call.kind === 'command' ? commandOutcome(code, { commandId: call.commandId, mayHaveStarted }) : queryFailure(code);

  /**
   * @param {Call} call
   * @param {unknown} answer
   */
  const settle = (call, answer) => {
    timers.clear(call.timer);
    sent.delete(call.requestId);
    waiting = waiting.filter(other => other !== call);
    call.unlisten();
    call.resolve(answer);
  };

  /**
   * Settles every call still waiting to be sent, which definitely never started
   * @param {TransportCode} code
   */
  const refuseWaiting = code => {
    for (const call of [...waiting]) settle(call, answerFor(call, code, false));
  };

  /**
   * Ends every call sent on the connection that just went, since none of their answers can
   * come: a command's reply was lost, and a query's coordinator went
   */
  const loseSent = () => {
    for (const call of [...sent.values()]) {
      settle(call, answerFor(call, call.kind === 'command' ? 'outcome-unknown' : 'unavailable', true));
    }
  };

  /** Stops the waits that belong to connecting, once it's over */
  const stopConnecting = () => {
    timers.clear(handshakeTimer);
    timers.clear(retryTimer);
    timers.clear(showTimer);
    showTimer = null;
    showing = false;
    failures = 0;
  };

  /** Closes the connection from this end, which tells only the other */
  const hangUp = () => {
    const open = link;
    link = null;
    open?.close();
  };

  /**
   * The request frame for a call, with its deadline from now
   * @param {Call} call
   */
  const frameOf = call =>
    encode({
      frame: 'request',
      requestId: call.requestId,
      operation: call.name,
      version: call.operation.entry.version,
      deadline: clock.now() + call.operation.entry.deadlineMs,
      payload: call.payload,
    });

  /**
   * Sends a call on the open connection. A link that has closed under it leaves it waiting,
   * since it definitely didn't go.
   * @param {Call} call
   * @param {string} [text] - its request frame, if it was just encoded
   * @returns {boolean} whether it went
   */
  const transmit = (call, text = frameOf(call)) => {
    try {
      /** @type {Link} */ (link).send(text);
    } catch {
      return false;
    }
    call.sent = true;
    sent.set(call.requestId, call);
    call.timer = timers.set(
      () => settle(call, answerFor(call, 'deadline-exceeded', true)),
      call.operation.entry.deadlineMs + DEADLINE_GRACE_MS,
    );
    return true;
  };

  /** Sends every call that was waiting for the welcome, in order */
  const flush = () => {
    while (waiting.length > 0 && phase === 'open') {
      if (!transmit(waiting[0])) return;
      waiting.shift();
    }
  };

  /**
   * Shows Reconnecting once the oldest user-visible call waiting has waited
   * RECONNECTING_AFTER_MS, unless a welcome comes first
   */
  const watch = () => {
    if (showing || showTimer !== null || (phase !== 'connecting' && phase !== 'retrying')) return;
    const oldest = waiting.find(call => call.visible);
    if (!oldest) return;
    showTimer = timers.set(
      () => {
        showTimer = null;
        if (phase !== 'connecting' && phase !== 'retrying') return;
        const first = waiting.find(call => call.visible);
        if (!first) return;
        if (clock.now() - first.since < RECONNECTING_AFTER_MS) {
          watch();
          return;
        }
        showing = true;
        tell();
      },
      Math.max(0, oldest.since + RECONNECTING_AFTER_MS - clock.now()),
    );
  };

  /**
   * An attempt that ended without a welcome. Waking the worker failing shows Reconnecting at
   * once. After the last retry, the coordinator is unavailable.
   * @param {CloseReason} reason
   */
  const failed = reason => {
    timers.clear(handshakeTimer);
    warn('client-connection-failed', { reason, failures });
    if (reason === 'unreachable') showing = true;
    if (failures >= RECONNECT_DELAYS_MS.length) {
      stopConnecting();
      phase = 'unavailable';
      refuseWaiting('unavailable');
      tell();
      return;
    }
    phase = 'retrying';
    retryTimer = timers.set(connect, RECONNECT_DELAYS_MS[failures]);
    failures += 1;
    tell();
  };

  /**
   * The connection went: before its welcome, an attempt failed, and after it, whatever was
   * sent on it has no answer coming
   * @param {Link} gone
   * @param {CloseReason} reason
   */
  const closed = (gone, reason) => {
    if (gone !== link) return;
    link = null;
    if (phase === 'connecting') {
      failed(reason);
      return;
    }
    if (phase !== 'open') return;
    phase = 'idle';
    loseSent();
    if (waiting.length > 0) begin();
    else tell();
  };

  /** @param {WelcomeFrame} frame */
  const welcome = frame => {
    if (phase !== 'connecting') return;
    coordinator = { coordinatorId: frame.coordinatorId, status: frame.status };
    if (frame.reason !== undefined) coordinator.reason = frame.reason;
    stopConnecting();
    if (frame.protocol.major !== PROTOCOL_VERSION.major) {
      phase = 'unsupported';
      hangUp();
      refuseWaiting('unsupported-version');
      tell();
      return;
    }
    phase = 'open';
    flush();
    tell();
  };

  /**
   * @param {Call} call
   * @param {unknown} result
   */
  const answer = (call, result) => {
    if (checkResult(call.operation, result).ok) return settle(call, result);
    warn('client-invalid-answer', { operation: call.name });
    settle(call, answerFor(call, call.kind === 'command' ? 'outcome-unknown' : 'unavailable', true));
  };

  /** @param {Frame} frame */
  const hear = frame => {
    if (frame.frame === 'welcome') return welcome(frame);
    if (!('requestId' in frame)) return;
    const call = sent.get(frame.requestId);
    if (!call) return;
    if (frame.frame === 'response') return answer(call, frame.result);
    if (frame.frame === 'too-late' && call.kind === 'command') return answer(call, frame.outcome);
    if (frame.frame === 'cancelled') return settle(call, answerFor(call, 'cancelled', false));
    // The router refused it before it could start
    if (frame.frame === 'error') settle(call, answerFor(call, frame.code, false));
  };

  /** Opens a connection and says hello */
  function connect() {
    phase = 'connecting';
    /** @type {Link} */
    let opened;
    try {
      opened = transport.connect();
    } catch (error) {
      // As chrome.runtime.connect() throws once the extension context is gone
      warn('client-connect-threw', { error });
      failed('unreachable');
      return;
    }
    link = opened;
    opened.onMessage(text => {
      if (opened !== link) return;
      const read = readFrame(text);
      if (read.ok) hear(read.frame);
      else warn('client-unreadable-frame', { code: read.code });
    });
    opened.onClose(reason => closed(opened, reason));
    try {
      opened.send(encode({ frame: 'hello', protocol: PROTOCOL_VERSION, extensionVersion, surface, sessionId }));
    } catch {
      // It closed already, and its close counts the attempt
    }
    handshakeTimer = timers.set(() => {
      if (opened !== link || phase !== 'connecting') return;
      hangUp();
      failed('closed');
    }, HANDSHAKE_TIMEOUT_MS);
    tell();
  }

  /**
   * Starts connecting, from idle or once the coordinator was unavailable, which a surface has
   * shown, so connecting again shows Reconnecting
   */
  function begin() {
    if (phase !== 'idle' && phase !== 'unavailable') return;
    showing = phase === 'unavailable';
    failures = 0;
    connect();
    watch();
  }

  /**
   * @param {'command' | 'query'} kind
   * @param {{type?: unknown, commandId?: unknown}} input
   * @param {CallOptions} options
   * @returns {Promise<unknown>}
   */
  const ask = (kind, input, { signal, userVisible = true } = {}) =>
    new Promise(resolve => {
      const name = typeof input?.type === 'string' ? input.type : '';
      const operation = name === '' ? undefined : lookup(name);
      /** @type {Call} */
      const call = {
        kind,
        name,
        operation: /** @type {Operation} */ (operation),
        payload: /** @type {Record<string, unknown>} */ (input),
        commandId: typeof input?.commandId === 'string' ? input.commandId : '',
        requestId: '',
        visible: userVisible,
        since: clock.now(),
        sent: false,
        timer: undefined,
        resolve,
        unlisten: () => {},
      };
      /** @param {TransportCode} code */
      const refuse = code => resolve(answerFor(call, code, false));
      if (!operation || operation.entry.kind !== kind) return refuse('unknown-operation');
      if (phase === 'closed') return refuse('unavailable');
      if (phase === 'unsupported') return refuse('unsupported-version');
      if (signal?.aborted) return refuse('cancelled');
      call.requestId = ids.next();
      // Checked as it would be sent, so a call that can't go is refused before it waits
      /** @type {string} */
      let text;
      try {
        text = frameOf(call);
      } catch {
        return refuse('invalid-payload');
      }
      if (encodedBytes(text) > Math.min(operation.entry.maxBytes, MAX_MESSAGE_BYTES)) {
        return refuse('payload-too-large');
      }
      if (signal) {
        const cancel = () => cancelCall(call);
        signal.addEventListener('abort', cancel);
        call.unlisten = () => signal.removeEventListener('abort', cancel);
      }
      if (phase === 'open' && transmit(call, text)) return;
      waiting.push(call);
      begin();
      watch();
    });

  /**
   * A call not yet sent is cancelled at once, since it definitely never started. One that was
   * sent asks the router, which answers cancelled, or too-late with the command's outcome.
   * @param {Call} call
   */
  const cancelCall = call => {
    if (!call.sent) {
      settle(call, answerFor(call, 'cancelled', false));
      return;
    }
    try {
      link?.send(encode({ frame: 'cancel', requestId: call.requestId }));
    } catch {
      // The connection went, and its close settles the call
    }
  };

  return Object.freeze({
    sessionId,
    execute: (command, options) => /** @type {Promise<Outcome | BulkOutcome>} */ (ask('command', command, options)),
    query: (query, options) => /** @type {Promise<QueryState<unknown>>} */ (ask('query', query, options)),
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: begin,
    canReload() {
      try {
        if (isComposing() || hasPendingCommit()) return false;
      } catch {
        return false;
      }
      return ![...waiting, ...sent.values()].some(call => call.kind === 'command');
    },
    coordinator: () => (coordinator ? { ...coordinator } : null),
    close() {
      if (phase === 'closed') return;
      stopConnecting();
      phase = 'closed';
      hangUp();
      loseSent();
      refuseWaiting('unavailable');
      tell();
    },
  });
}
