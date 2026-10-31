/**
 * What commands and queries return (#12, "Required states and failure behavior"). Every
 * command returns one outcome of a closed union, and every query one state. #26 (shared
 * states) presents them, and #24 (accessibility) reads `severity` and `messageKey`.
 *
 * Outcomes carry codes, ids, a messageKey, and a severity, never content: no note text or
 * titles, no credentials, no URLs.
 */

/** @typedef {'success' | 'info' | 'warning' | 'error'} Severity */

/**
 * The command committed. `changedIds` lists what it changed: note, folder, or setting ids.
 * `revision` is the primary record's content revision, #13's `committedRevision`, from an
 * adapter with revisions. `commitSeq` is the commit's place in #17's change log, from an
 * adapter that keeps one.
 * @typedef {object} Committed
 * @property {'committed'} kind
 * @property {string} code
 * @property {string[]} changedIds
 * @property {number} [revision]
 * @property {number} [commitSeq]
 * @property {string} messageKey
 * @property {Severity} severity
 */

/** @typedef {'validation' | 'policy' | 'not-found'} RejectReason */

/** @type {readonly RejectReason[]} */
export const REJECT_REASONS = Object.freeze(['validation', 'policy', 'not-found']);

/**
 * The kernel refused the command and wrote nothing.
 * @typedef {object} Rejected
 * @property {'rejected'} kind
 * @property {RejectReason} reason
 * @property {string} code
 * @property {string} messageKey
 * @property {Severity} severity
 */

/**
 * The record changed since the version the command expected. The adapter keeps the command
 * and the committed record, and this outcome carries neither. Only adapters with revisions
 * return it, with one of two codes (#17, "Versions"):
 * - `revision-conflict`: a content command's `expectedRevision` is stale, and
 *   `currentRevision` is the note's content revision.
 * - `placement-conflict`: a placement command's `expectedPlacementVersion` is stale, and
 *   `currentRevision` holds the note's placement version, not its content revision. The
 *   outcome's fields are closed (#13), so the placement version takes this one.
 * @typedef {object} Conflict
 * @property {'conflict'} kind
 * @property {string} code
 * @property {number} currentRevision
 * @property {string} messageKey
 * @property {Severity} severity
 */

/** @typedef {'storage' | 'quota' | 'newer-schema' | 'adapter' | 'coordinator'} UnavailableCause */

/** @type {readonly UnavailableCause[]} */
export const UNAVAILABLE_CAUSES = Object.freeze(['storage', 'quota', 'newer-schema', 'adapter', 'coordinator']);

/**
 * Storage couldn't run the command. `retryable` says whether the same command, sent again,
 * can succeed.
 * @typedef {object} Unavailable
 * @property {'unavailable'} kind
 * @property {UnavailableCause} cause
 * @property {string} code
 * @property {boolean} retryable
 * @property {string} messageKey
 * @property {Severity} severity
 */

/**
 * The command was sent and no answer came. Only transports (#13, #35) return it, so the
 * caller can resend the same commandId.
 * @typedef {object} Unknown
 * @property {'unknown'} kind
 * @property {string} code
 * @property {string} commandId
 * @property {string} messageKey
 * @property {Severity} severity
 */

/** @typedef {Committed | Rejected | Conflict | Unavailable | Unknown} Outcome */

/**
 * One item of a bulk command, which returns an outcome per item.
 * @typedef {object} BulkItem
 * @property {string} id
 * @property {Outcome} outcome
 */

/**
 * A bulk command's result. Its message counts only `committedIds`.
 * @typedef {object} BulkOutcome
 * @property {'bulk'} kind
 * @property {string} code
 * @property {BulkItem[]} items
 * @property {string[]} committedIds
 * @property {string} messageKey
 * @property {Severity} severity
 */

export const OUTCOME_KINDS = Object.freeze(['committed', 'rejected', 'conflict', 'unavailable', 'unknown']);

/** @type {Readonly<Record<RejectReason, Severity>>} */
const REJECTED_SEVERITY = Object.freeze({ validation: 'warning', 'not-found': 'warning', policy: 'error' });

/**
 * @param {string} code
 * @param {string[]} changedIds
 * @param {{revision?: number, commitSeq?: number, severity?: Severity}} [options] -
 *   `severity: 'info'` for a command that committed without changing anything
 * @returns {Committed}
 */
export function committed(code, changedIds, options = {}) {
  /** @type {Committed} */
  const outcome = {
    kind: 'committed',
    code,
    changedIds: [...changedIds],
    messageKey: `committed.${code}`,
    severity: options.severity || 'success',
  };
  if (options.revision !== undefined) outcome.revision = options.revision;
  if (options.commitSeq !== undefined) outcome.commitSeq = options.commitSeq;
  return outcome;
}

/**
 * @param {RejectReason} reason
 * @param {string} code
 * @returns {Rejected}
 */
export function rejected(reason, code) {
  return { kind: 'rejected', reason, code, messageKey: `rejected.${code}`, severity: REJECTED_SEVERITY[reason] };
}

/**
 * @param {string} code
 * @param {number} currentRevision
 * @returns {Conflict}
 */
export function conflict(code, currentRevision) {
  return { kind: 'conflict', code, currentRevision, messageKey: `conflict.${code}`, severity: 'warning' };
}

/**
 * @param {UnavailableCause} cause
 * @param {string} code
 * @param {boolean} retryable
 * @returns {Unavailable}
 */
export function unavailable(cause, code, retryable) {
  return { kind: 'unavailable', cause, code, retryable, messageKey: `unavailable.${code}`, severity: 'error' };
}

/**
 * @param {string} code
 * @param {string} commandId
 * @returns {Unknown}
 */
export function unknown(code, commandId) {
  return { kind: 'unknown', code, commandId, messageKey: `unknown.${code}`, severity: 'warning' };
}

/**
 * @param {string} code
 * @param {BulkItem[]} items
 * @returns {BulkOutcome}
 */
export function bulk(code, items) {
  const committedIds = items.filter(item => item.outcome.kind === 'committed').map(item => item.id);
  /** @type {Severity} */
  let severity = 'success';
  if (committedIds.length < items.length) severity = committedIds.length === 0 ? 'error' : 'warning';
  return {
    kind: 'bulk',
    code,
    items: items.map(item => ({ ...item })),
    committedIds,
    messageKey: `bulk.${code}`,
    severity,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Outcome}
 */
export function isOutcome(value) {
  if (value === null || typeof value !== 'object') return false;
  const kind = /** @type {{kind?: unknown}} */ (value).kind;
  return typeof kind === 'string' && OUTCOME_KINDS.includes(kind);
}

/**
 * What a port throws when storage can't do what was asked. The kernel turns it into an
 * `unavailable` outcome, or a `failed` query state. Its message holds only the cause and
 * the code, and `cause`, when given, what storage threw, so a log can say what happened. An
 * outcome never carries it.
 */
export class UnavailableError extends Error {
  /**
   * @param {UnavailableCause} unavailableCause
   * @param {string} code
   * @param {boolean} retryable
   * @param {{cause?: unknown}} [options] - what storage threw
   */
  constructor(unavailableCause, code, retryable, options) {
    super(`${unavailableCause}: ${code}`, options);
    this.name = 'UnavailableError';
    this.unavailableCause = unavailableCause;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * The outcome for an error a port or a use case threw. An error that isn't an
 * UnavailableError is the adapter's own failure.
 * @param {unknown} error
 * @returns {Unavailable}
 */
export function unavailableFrom(error) {
  if (error instanceof UnavailableError) return unavailable(error.unavailableCause, error.code, error.retryable);
  return unavailable('adapter', 'adapter-failed', true);
}

// ============ Query states ============

/**
 * @typedef {object} Loading
 * @property {'loading'} kind
 */

/**
 * @template T
 * @typedef {object} Ready
 * @property {'ready'} kind
 * @property {number} asOf - how fresh the data is: #13's `asOfCommitSeq` from an adapter
 *   with a change log (#17), and until then when it was read, on the kernel's clock
 * @property {T} data
 */

/**
 * @typedef {object} Empty
 * @property {'empty'} kind
 * @property {number} asOf
 */

/**
 * Data a projection still shows after a newer read failed.
 * @template T
 * @typedef {object} Stale
 * @property {'stale'} kind
 * @property {number} asOf
 * @property {T} data
 */

/** @typedef {UnavailableCause | 'policy' | 'validation'} FailCause */

/** @type {readonly FailCause[]} */
export const FAIL_CAUSES = Object.freeze([...UNAVAILABLE_CAUSES, 'policy', 'validation']);

/**
 * @typedef {object} Failed
 * @property {'failed'} kind
 * @property {FailCause} cause
 * @property {string} code
 */

/**
 * Before deferred init finishes a query is `loading`. Optimistic projections show their
 * own `pending` items until each outcome arrives.
 * @template T
 * @typedef {Loading | Ready<T> | Empty | Stale<T> | Failed} QueryState
 */

export const QUERY_STATES = Object.freeze(['loading', 'ready', 'empty', 'stale', 'failed']);

/** @returns {Loading} */
export function loading() {
  return { kind: 'loading' };
}

/**
 * @template T
 * @param {number} asOf
 * @param {T} data
 * @returns {Ready<T>}
 */
export function ready(asOf, data) {
  return { kind: 'ready', asOf, data };
}

/**
 * @param {number} asOf
 * @returns {Empty}
 */
export function empty(asOf) {
  return { kind: 'empty', asOf };
}

/**
 * @template T
 * @param {number} asOf
 * @param {T} data
 * @returns {Stale<T>}
 */
export function stale(asOf, data) {
  return { kind: 'stale', asOf, data };
}

/**
 * @param {FailCause} cause
 * @param {string} code
 * @returns {Failed}
 */
export function failed(cause, code) {
  return { kind: 'failed', cause, code };
}

/**
 * The failed state for an error a port threw while reading.
 * @param {unknown} error
 * @returns {Failed}
 */
export function failedFrom(error) {
  const outcome = unavailableFrom(error);
  return failed(outcome.cause, outcome.code);
}
