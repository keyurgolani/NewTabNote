/**
 * #13's client (#13, "Topology", "Handshake and compatibility", "Cancellation, deadlines,
 * payloads", and "Outcomes and authorization"): how a page, or the worker's own code, reaches
 * the router. It opens one connection, through whichever transport its composition root chose,
 * only once it has something to send, and keeps its session, made once when it's built,
 * across reconnects. Every call answers with #12's outcome union or a query state, however it
 * ended, so a caller handles one union whichever way its request traveled:
 *
 * - A request goes once the coordinator has welcomed this client, and waits until then, with
 *   its payload as it was when it was called. One it can't send at all, for an operation it
 *   doesn't know, a payload the codec can't carry, or one over its operation's size, is
 *   refused without a message.
 * - Each request carries its deadline, from when it's sent, which the router enforces. The
 *   client waits DEADLINE_GRACE_MS past it before it gives up, so no client timeout is
 *   shorter, and giving up never starts a second way to run it.
 * - A command whose answer didn't come and that may have started is unknown: its reply was
 *   lost to a dropped connection, a deadline, or an answer it can't take. Given an
 *   IdempotencyLedger, the client resolves it by its commandId before its caller hears
 *   anything, so nothing shows saved or failed first ("Idempotency and catch-up"): a record of
 *   it committed answers the original outcome, a conflict reads back, and none allows one
 *   resend with the same key. Only the coordinator's own answer to that resend counts, and
 *   anything else that ends it reads the ledger again, since the first send may have committed.
 *   A command still without a record then stays unknown, and so does one whose ledger can't be
 *   read. A cancel after its reply was lost changes nothing. A command that was never sent is
 *   definitely unavailable.
 * - resume() resolves what a page had in flight when it went, from its journal: each journaled
 *   command by its key the same way, and one that isn't journaled by reading the ledger only,
 *   never sending it again, since its outcome comes from reading the projection (#13, AC3).
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

import { decode, encode, encodedBytes } from '../contracts/codec.js';
import {
  DEADLINE_GRACE_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RECONNECTING_AFTER_MS,
  RECONNECT_DELAYS_MS,
} from '../contracts/limits.js';
import { isRecord } from '../contracts/checks.js';
import { rejected, unknown } from '../contracts/outcomes.js';
import { commandOutcome, queryFailure } from '../contracts/transport-codes.js';
import { upcastJournalEntry } from '../contracts/upcast.js';
import { checkResult, readFrame } from '../contracts/validate.js';
import { silentLogger } from '../ports/runtime.js';

/** @typedef {import('../contracts/envelope.js').Frame} Frame */
/** @typedef {import('../contracts/envelope.js').WelcomeFrame} WelcomeFrame */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../contracts/outcomes.js').Unknown} Unknown */
/** @typedef {import('../ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../ports/idempotency-ledger.js').KeyedCommand} KeyedCommand */
/** @typedef {import('../ports/idempotency-ledger.js').LedgerRead} LedgerRead */
/** @typedef {import('../ports/journal.js').JournalEntry} JournalEntry */
/** @typedef {import('../ports/journal.js').JournalReader} JournalReader */
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
 * @property {IdempotencyLedger} [ledger]
 *   #17's ledger, read in-process, by which a command whose reply was lost resolves. Without
 *   one, such a command answers unknown at once.
 * @property {JournalReader} [journal] - #17's journal, which resume() reads
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
 *   Connects now, as the status region's Retry does: from idle, once the coordinator was
 *   unavailable, or instead of waiting out the pause before the next attempt. It does nothing
 *   while a connection opens or is open.
 * @property {() => boolean} canReload
 *   Whether reloading the page loses nothing: no IME composition, no input the page hasn't
 *   committed, and no command of this client's waiting for its answer
 * @property {() => CoordinatorInfo | null} coordinator
 * @property {() => Promise<Array<{commandId: string, outcome: Outcome | BulkOutcome}>>} resume
 *   Resolves each command the journal holds once the page reloaded or came back, by its key.
 *   It reads every record first, in the journal's order, by the command as the journal wrote
 *   it, so a record answers whatever the client's state. Then it sends again each journaled
 *   command that has none, once, in that order, each after the one before it answered. Only
 *   to send it is a command taken to the catalog's current version (contracts/upcast.js), and
 *   one that can't be is refused with its code, unsent. One that can't go now, as once the
 *   client closed or the coordinator speaks another major version, stays unknown. A command
 *   still open in this client is waited on, not sent again. Without a journal and a ledger, or
 *   when the journal can't be read, it resolves nothing.
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
 * @property {boolean} resent - a command whose reply was lost, sent again or never to be
 * @property {boolean} settled
 * @property {Unknown | null} lost - what it answers if it can't be resolved, once its reply was lost
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
  ledger,
  journal,
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
  /** @type {Set<Call>} commands whose reply was lost, while the ledger is read */
  const verifying = new Set();
  /** @type {Map<string, Promise<unknown>>} each command still open, by commandId */
  const open = new Map();
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
    if (call.settled) return;
    call.settled = true;
    timers.clear(call.timer);
    sent.delete(call.requestId);
    waiting = waiting.filter(other => other !== call);
    verifying.delete(call);
    call.unlisten();
    call.resolve(answer);
  };

  /**
   * Ends a call with `result`. A command answered unknown goes to the ledger first, and so
   * does a resend that anything but the coordinator's own answer ends, since the first send
   * may have committed.
   * @param {Call} call
   * @param {unknown} result
   * @param {boolean} answered - it's the coordinator's answer: a response, or too-late
   */
  const conclude = (call, result, answered) => {
    if (call.kind !== 'command' || !ledger) return settle(call, result);
    const { kind, code } = /** @type {{kind?: unknown, code?: unknown}} */ (result);
    if (kind !== 'unknown' && (answered || !call.resent)) return settle(call, result);
    const lost =
      kind === 'unknown'
        ? /** @type {Unknown} */ (result)
        : unknown(typeof code === 'string' ? code : 'outcome-unknown', call.commandId);
    if (phase === 'closed') return settle(call, lost);
    verify(call, lost);
  };

  /**
   * Ends a call with a transport code
   * @param {Call} call
   * @param {TransportCode} code
   * @param {boolean} mayHaveStarted
   */
  const end = (call, code, mayHaveStarted) => conclude(call, answerFor(call, code, mayHaveStarted), false);

  /**
   * Whether `read` is an answer a ledger gives, whose outcome the command's result schema takes
   * @param {Operation} operation
   * @param {unknown} read
   * @returns {read is LedgerRead}
   */
  const isLedgerRead = (operation, read) => {
    if (!isRecord(read)) return false;
    const { status, outcome } = read;
    if (status === 'absent' || status === 'key-reuse') return true;
    if (status !== 'committed' && status !== 'conflict') return false;
    return isRecord(outcome) && outcome.kind === status && checkResult(operation, outcome).ok;
  };

  /**
   * What the ledger has of a command, or null when it can't say
   * @param {Operation} operation
   * @param {Record<string, unknown>} command
   * @returns {Promise<LedgerRead | null>}
   */
  const readLedger = (operation, command) =>
    Promise.resolve()
      .then(() => /** @type {IdempotencyLedger} */ (ledger).read(/** @type {KeyedCommand} */ (command)))
      .then(
        read => {
          if (isLedgerRead(operation, read)) return read;
          warn('client-ledger-invalid-read', { operation: command.type });
          return null;
        },
        error => {
          warn('client-ledger-read-failed', { operation: command.type, error });
          return null;
        },
      );

  /**
   * Resolves a command whose reply was lost by its key: what the ledger has of it, or with no
   * record, one resend with the same key. Until then its caller hears nothing.
   * @param {Call} call
   * @param {Unknown} lost - what it answers if the ledger can't settle it
   */
  const verify = (call, lost) => {
    timers.clear(call.timer);
    sent.delete(call.requestId);
    waiting = waiting.filter(other => other !== call);
    call.sent = false;
    call.lost = lost;
    verifying.add(call);
    void readLedger(call.operation, call.payload).then(read => {
      if (call.settled) return;
      verifying.delete(call);
      if (read?.status === 'committed' || read?.status === 'conflict') return settle(call, read.outcome);
      if (read?.status === 'key-reuse') return settle(call, rejected('validation', 'idempotency-key-reuse'));
      if (read?.status === 'absent' && !call.resent && phase !== 'closed' && phase !== 'unsupported') {
        return resend(call);
      }
      settle(call, lost);
    });
  };

  /**
   * Sends a command the ledger has no record of once more, with the same key, as a new request
   * @param {Call} call
   */
  const resend = call => {
    call.resent = true;
    call.requestId = ids.next();
    call.since = clock.now();
    waiting.push(call);
    if (phase === 'open') flush();
    else begin();
    watch();
  };

  /**
   * Ends every call still waiting to be sent, which definitely never started, unless it's a
   * resend
   * @param {TransportCode} code
   */
  const refuseWaiting = code => {
    for (const call of [...waiting]) end(call, code, false);
  };

  /**
   * Ends every call sent on the connection that just went, since none of their answers can
   * come: a command's reply was lost, and a query's coordinator went
   */
  const loseSent = () => {
    for (const call of [...sent.values()]) {
      end(call, call.kind === 'command' ? 'outcome-unknown' : 'unavailable', true);
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
   * Sends a call on the open connection. A frame that can't be encoded settles the call, which
   * definitely never went, and a link that closed under it leaves it waiting for the next one.
   * @param {Call} call
   * @param {string} [text] - its request frame, if it was just encoded
   * @returns {boolean} whether it's done waiting: sent, or settled
   */
  const transmit = (call, text) => {
    let frame = text;
    if (frame === undefined) {
      try {
        frame = frameOf(call);
      } catch {
        end(call, 'invalid-payload', false);
        return true;
      }
    }
    try {
      /** @type {Link} */ (link).send(frame);
    } catch {
      return false;
    }
    call.sent = true;
    sent.set(call.requestId, call);
    call.timer = timers.set(
      () => end(call, 'deadline-exceeded', true),
      call.operation.entry.deadlineMs + DEADLINE_GRACE_MS,
    );
    return true;
  };

  /** Sends every call that was waiting for the welcome, in order, each with its deadline from now */
  const flush = () => {
    while (waiting.length > 0 && phase === 'open') {
      const call = /** @type {Call} */ (waiting.shift());
      if (!transmit(call)) {
        waiting.unshift(call);
        return;
      }
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
    if (checkResult(call.operation, result).ok) return conclude(call, result, true);
    warn('client-invalid-answer', { operation: call.name });
    end(call, call.kind === 'command' ? 'outcome-unknown' : 'unavailable', true);
  };

  /** @param {Frame} frame */
  const hear = frame => {
    if (frame.frame === 'welcome') return welcome(frame);
    if (!('requestId' in frame)) return;
    const call = sent.get(frame.requestId);
    if (!call) return;
    if (frame.frame === 'response') return answer(call, frame.result);
    if (frame.frame === 'too-late' && call.kind === 'command') return answer(call, frame.outcome);
    if (frame.frame === 'cancelled') return end(call, 'cancelled', false);
    // The router refused it before it could start
    if (frame.frame === 'error') end(call, frame.code, false);
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
   * How a call starts: sent, or for a journaled command resume() found no record of, sent as
   * the one resend its key allows. Anything that ends a resend but the coordinator's answer,
   * a refusal before it goes included, leaves it unknown, since the first send may have
   * committed.
   * @typedef {'send' | 'resend'} Start
   */

  /**
   * @param {'command' | 'query'} kind
   * @param {{type?: unknown, commandId?: unknown}} input
   * @param {CallOptions} options
   * @param {Start} [start]
   * @returns {Promise<unknown>}
   */
  const ask = (kind, input, { signal, userVisible = true } = {}, start = 'send') =>
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
        resent: start === 'resend',
        settled: false,
        lost: null,
        timer: undefined,
        resolve,
        unlisten: () => {},
      };
      /** @param {TransportCode} code */
      const refuse = code => resolve(start === 'resend' ? unknown(code, call.commandId) : answerFor(call, code, false));
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
      // A call keeps the payload as it was called, as kernel.execute() copies a command, so
      // nothing its caller changes after reaches the coordinator, a resend, or the ledger
      call.payload = /** @type {{payload: Record<string, unknown>}} */ (decode(text)).payload;
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
    // A command whose reply was lost may have committed, so its outcome comes by its key
    if (call.resent || verifying.has(call)) return;
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

  /**
   * Keeps a command's promise by its commandId while it's open, so resume() waits on it
   * rather than sending it twice
   * @param {unknown} commandId
   * @param {Promise<unknown>} promise
   */
  const track = (commandId, promise) => {
    if (typeof commandId !== 'string' || commandId === '' || open.has(commandId)) return promise;
    open.set(commandId, promise);
    void promise.then(() => {
      if (open.get(commandId) === promise) open.delete(commandId);
    });
    return promise;
  };

  /**
   * One journal entry, once its record was read: settled, or to send again
   * @typedef {{commandId: string, outcome: Outcome | BulkOutcome}
   *   | {commandId: string, entry: JournalEntry, operation: Operation}} ReadEntry
   */

  /**
   * Reads one journal entry's record, by its command as the journal wrote it, before anything
   * could refuse it: a record answers whatever the client's state, and the command is taken to
   * the catalog's current version only to send it again
   * @param {unknown} entry
   * @returns {Promise<ReadEntry>}
   */
  const readEntry = async entry => {
    const command = isRecord(entry) ? entry.command : undefined;
    if (!isRecord(command)) return { commandId: '', outcome: rejected('validation', 'invalid-payload') };
    const commandId = typeof command.commandId === 'string' ? command.commandId : '';
    const operation = typeof command.type === 'string' ? lookup(command.type) : undefined;
    // A query is never journaled
    if (!operation || operation.entry.kind !== 'command') {
      return { commandId, outcome: rejected('validation', 'unknown-operation') };
    }
    if (commandId === '') return { commandId, outcome: rejected('validation', 'invalid-payload') };
    const pending = open.get(commandId);
    if (pending) return { commandId, outcome: /** @type {Outcome | BulkOutcome} */ (await pending) };
    const read = await readLedger(operation, command);
    if (read?.status === 'committed' || read?.status === 'conflict') return { commandId, outcome: read.outcome };
    if (read?.status === 'key-reuse') return { commandId, outcome: rejected('validation', 'idempotency-key-reuse') };
    if (!read) return { commandId, outcome: unknown('outcome-unknown', commandId) };
    return { commandId, entry: /** @type {JournalEntry} */ (entry), operation };
  };

  /**
   * Sends again a journaled command the ledger had no record of, once. One that isn't
   * journaled is never sent again: its outcome comes from reading the projection.
   * @param {ReadEntry} read
   * @returns {Promise<Outcome | BulkOutcome>}
   */
  const resendEntry = async read => {
    if ('outcome' in read) return read.outcome;
    const { commandId, entry, operation } = read;
    const pending = open.get(commandId);
    if (pending) return /** @type {Outcome | BulkOutcome} */ (await pending);
    if (!operation.entry.journaled) return unknown('outcome-unknown', commandId);
    const upcast = upcastJournalEntry(entry, lookup);
    if (!upcast.ok) return rejected('validation', upcast.code);
    return /** @type {Promise<Outcome | BulkOutcome>} */ (
      track(commandId, ask('command', upcast.command, { userVisible: false }, 'resend'))
    );
  };

  return Object.freeze({
    sessionId,
    execute: (command, options) =>
      /** @type {Promise<Outcome | BulkOutcome>} */ (track(command?.commandId, ask('command', command, options))),
    query: (query, options) => /** @type {Promise<QueryState<unknown>>} */ (ask('query', query, options)),
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      if (phase !== 'retrying') {
        begin();
        return;
      }
      // Instead of the wait before the next attempt, which it counts as
      timers.clear(retryTimer);
      connect();
    },
    canReload() {
      try {
        if (isComposing() || hasPendingCommit()) return false;
      } catch {
        return false;
      }
      return ![...waiting, ...sent.values(), ...verifying].some(call => call.kind === 'command');
    },
    coordinator: () => (coordinator ? { ...coordinator } : null),
    async resume() {
      if (!journal || !ledger) return [];
      /** @type {unknown} */
      let entries;
      try {
        entries = await journal.inFlight();
      } catch (error) {
        warn('client-journal-read-failed', { error });
        return [];
      }
      if (!Array.isArray(entries)) return [];
      // Every record first, in the journal's order, then each resend once the one before it
      // answered, so a save never goes before the createNote it follows
      /** @type {ReadEntry[]} */
      const reads = [];
      for (const entry of entries) reads.push(await readEntry(entry));
      /** @type {Array<{commandId: string, outcome: Outcome | BulkOutcome}>} */
      const resolved = [];
      for (const read of reads) resolved.push({ commandId: read.commandId, outcome: await resendEntry(read) });
      return resolved;
    },
    close() {
      if (phase === 'closed') return;
      stopConnecting();
      phase = 'closed';
      hangUp();
      loseSent();
      refuseWaiting('unavailable');
      for (const call of [...verifying]) settle(call, call.lost);
      tell();
    },
  });
}
