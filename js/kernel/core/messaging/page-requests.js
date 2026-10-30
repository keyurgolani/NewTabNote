/**
 * #13's page-addressed requests (#13, "Topology" and AC4): a request on the hint channel for
 * one page, named by the session its handshake gave it or by a Web Lock it holds, as #35 asks
 * its offscreen document to run a job and #6 asks which page has a note open. They're catalog
 * entries of kind query, with idempotency none, and they carry ids only. BroadcastChannel has
 * no sender identity, so the addressed page checks the frame, the operation and its version,
 * the size, the payload schema, its entity ids, and the deadline, and an operation's allowed
 * surfaces apply only where a port or in-process caller exists. Every page hears what's
 * posted, so the requester runs the same operation, size, schema, and entity checks first and
 * posts nothing they refuse. Only the addressed page answers, a refusal included, and every
 * other page stays silent. A requester that hears no valid answer by its deadline gets a
 * failed state.
 */

import { encode, encodedBytes } from '../contracts/codec.js';
import { targetSchema } from '../contracts/hint-channel.js';
import { MAX_MESSAGE_BYTES } from '../contracts/limits.js';
import { queryFailure } from '../contracts/transport-codes.js';
import { check, checkRequest, checkResult, readChannelFrame } from '../contracts/validate.js';
import { silentLogger } from '../ports/runtime.js';
import { createScopeCheck } from './scope.js';

/** @typedef {import('../contracts/envelope.js').RequestFrame} RequestFrame */
/** @typedef {import('../contracts/hint-channel.js').Target} Target */
/** @typedef {import('../contracts/transport-codes.js').TransportCode} TransportCode */
/** @typedef {import('../contracts/validate.js').Operation} Operation */
/** @typedef {import('../ports/runtime.js').Clock} Clock */
/** @typedef {import('../ports/runtime.js').Ids} Ids */
/** @typedef {import('../ports/runtime.js').Logger} Logger */
/** @typedef {import('../ports/runtime.js').Timers} Timers */
/** @typedef {import('./client.js').CancelSignal} CancelSignal */
/** @typedef {import('./hints.js').Channel} Channel */
/** @typedef {import('./operations.js').Lookup} Lookup */

/**
 * @template T
 * @typedef {import('../contracts/outcomes.js').QueryState<T>} QueryState
 */

/**
 * Serves one page-addressed operation: answers the payload its schema took with a query
 * state, or a promise of one
 * @callback PageHandler
 * @param {unknown} payload
 * @param {{target: Target, deadline: number}} context - `deadline` is the request's, or its
 *   entry's `deadlineMs` from when it arrived when that comes first. No answer goes after it.
 * @returns {unknown}
 */

/**
 * Whether an operation can be addressed to a page: a query with idempotency none
 * @param {Operation} operation
 */
const addressable = operation => operation.entry.kind === 'query' && operation.entry.idempotency === 'none';

/**
 * Tells `logger`, whose own failure changes nothing
 * @param {Logger} logger
 * @param {string} event
 * @param {Record<string, unknown>} detail
 */
function warn(logger, event, detail) {
  try {
    logger.warn(event, detail);
  } catch {
    // Nothing to tell
  }
}

/**
 * A page's side: answers the requests addressed to its session, or to a lock it holds, for
 * as long as its channel is open
 * @param {object} options
 * @param {Channel} options.channel
 * @param {string} options.sessionId - its client's
 * @param {(lock: string) => boolean} [options.holds] - whether it holds a Web Lock by that name
 * @param {Lookup} options.lookup
 * @param {Readonly<Record<string, PageHandler>>} options.handlers - by operation name
 * @param {Clock} options.clock
 * @param {Logger} [options.logger]
 */
export function createPageResponder({
  channel,
  sessionId,
  holds = () => false,
  lookup,
  handlers,
  clock,
  logger = silentLogger,
}) {
  const inScope = createScopeCheck();

  /** @param {Target} target */
  const isMine = target => {
    if (target.kind === 'session') return target.sessionId === sessionId;
    try {
      return holds(target.lock) === true;
    } catch {
      return false;
    }
  };

  channel.onMessage(text => {
    const read = readChannelFrame(text);
    if (!read.ok || read.frame.frame !== 'page-request' || !isMine(read.frame.target)) return;
    const frame = read.frame;

    /** @param {unknown} result */
    const answer = result => {
      /** @type {string} */
      let message;
      try {
        message = encode({ frame: 'page-response', requestId: frame.requestId, result });
      } catch {
        // An answer its schema took can still hold what JSON can't, such as Infinity
        warn(logger, 'page-handler-unencodable-answer', { operation: frame.operation });
        message = encode({ frame: 'page-response', requestId: frame.requestId, result: queryFailure('unavailable') });
      }
      if (encodedBytes(message) > MAX_MESSAGE_BYTES) {
        message = encode({
          frame: 'page-response',
          requestId: frame.requestId,
          result: queryFailure('payload-too-large'),
        });
      }
      try {
        channel.post(message);
      } catch (error) {
        warn(logger, 'page-response-failed', { operation: frame.operation, error });
      }
    };
    /** @param {TransportCode} code */
    const refuse = code => answer(queryFailure(code));

    const checked = checkRequest(/** @type {RequestFrame} */ ({ ...frame, frame: 'request' }), read.bytes, lookup);
    if (!checked.ok) return refuse(checked.code);
    const { operation, payload } = checked;
    if (!addressable(operation)) return refuse('unknown-operation');
    const arrived = clock.now();
    if (frame.deadline <= arrived) return refuse('deadline-exceeded');
    if (!inScope(operation, payload)) return refuse('forbidden-for-surface');
    const handler = Object.hasOwn(handlers, frame.operation) ? handlers[frame.operation] : undefined;
    if (!handler) return refuse('unknown-operation');
    // The entry's deadline holds however far off the request puts its own, as in the router
    const deadline = Math.min(frame.deadline, arrived + operation.entry.deadlineMs);
    // The requester has stopped waiting by then, so an answer after it would only add noise
    const late = () => {
      if (clock.now() < deadline) return false;
      warn(logger, 'page-answer-too-late', { operation: frame.operation });
      return true;
    };
    Promise.resolve()
      .then(() => handler(payload, { target: frame.target, deadline }))
      .then(
        result => {
          if (late()) return;
          if (checkResult(operation, result).ok) return answer(result);
          warn(logger, 'page-handler-invalid-answer', { operation: frame.operation });
          refuse('unavailable');
        },
        error => {
          if (late()) return;
          warn(logger, 'page-handler-failed', { operation: frame.operation, error });
          refuse('unavailable');
        },
      );
  });
}

/**
 * The requester's side, a page's or the coordinator's as worker-internal
 * @param {{channel: Channel, lookup: Lookup, ids: Ids, clock: Clock, timers: Timers, logger?: Logger}} options
 */
export function createPageRequester({ channel, lookup, ids, clock, timers, logger = silentLogger }) {
  const inScope = createScopeCheck();
  /**
   * @typedef {object} Waiting
   * @property {string} requestId
   * @property {Operation} operation
   * @property {unknown} timer
   * @property {(state: unknown) => void} resolve
   * @property {() => void} unlisten
   */
  /** @type {Map<string, Waiting>} */
  const waiting = new Map();

  /**
   * @param {Waiting} call
   * @param {unknown} state
   */
  const settle = (call, state) => {
    if (!waiting.delete(call.requestId)) return;
    timers.clear(call.timer);
    call.unlisten();
    call.resolve(state);
  };

  // Any page can post on the channel, so an answer that isn't valid doesn't end the wait
  channel.onMessage(text => {
    const read = readChannelFrame(text);
    if (!read.ok || read.frame.frame !== 'page-response') return;
    const call = waiting.get(read.frame.requestId);
    if (!call) return;
    if (!checkResult(call.operation, read.frame.result).ok) {
      warn(logger, 'page-response-invalid', { requestId: call.requestId });
      return;
    }
    settle(call, read.frame.result);
  });

  return Object.freeze({
    /**
     * Asks the page `target` names, and answers with its state, or a failed one when no valid
     * answer comes by the deadline, the call is cancelled, or it can't be sent at all
     * @param {{type: string} & Record<string, unknown>} query
     * @param {Target} target
     * @param {{signal?: CancelSignal}} [options]
     * @returns {Promise<QueryState<unknown>>}
     */
    request(query, target, { signal } = {}) {
      return new Promise(resolve => {
        const name = typeof query?.type === 'string' ? query.type : '';
        const operation = name === '' ? undefined : lookup(name);
        if (!operation || !addressable(operation)) return resolve(queryFailure('unknown-operation'));
        if (!check(targetSchema, target).ok) return resolve(queryFailure('invalid-payload'));
        if (signal?.aborted) return resolve(queryFailure('cancelled'));
        const requestId = ids.next();
        const { deadlineMs, maxBytes, version } = operation.entry;
        /** @type {string} */
        let text;
        try {
          text = encode({
            frame: 'page-request',
            requestId,
            operation: name,
            version,
            deadline: clock.now() + deadlineMs,
            target,
            payload: query,
          });
        } catch {
          return resolve(queryFailure('invalid-payload'));
        }
        const bytes = encodedBytes(text);
        if (bytes > Math.min(maxBytes, MAX_MESSAGE_BYTES)) return resolve(queryFailure('payload-too-large'));
        // Every page hears what's posted, so what the addressed page would refuse never goes
        const checked = checkRequest(
          { frame: 'request', requestId, operation: name, version, deadline: 0, payload: query },
          bytes,
          lookup,
        );
        if (!checked.ok) return resolve(queryFailure(checked.code));
        if (!inScope(operation, query)) return resolve(queryFailure('forbidden-for-surface'));
        /** @type {Waiting} */
        const call = {
          requestId,
          operation,
          timer: undefined,
          resolve: state => resolve(/** @type {QueryState<unknown>} */ (state)),
          unlisten: () => {},
        };
        waiting.set(requestId, call);
        call.timer = timers.set(() => settle(call, queryFailure('deadline-exceeded')), deadlineMs);
        if (signal) {
          const cancel = () => settle(call, queryFailure('cancelled'));
          signal.addEventListener('abort', cancel);
          call.unlisten = () => signal.removeEventListener('abort', cancel);
        }
        try {
          channel.post(text);
        } catch (error) {
          warn(logger, 'page-request-failed', { operation: name, error });
          settle(call, queryFailure('unavailable'));
        }
      });
    },
  });
}
