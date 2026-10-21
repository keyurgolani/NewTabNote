/**
 * What IndexedDB and chrome.storage.local failures mean to the kernel (#17, "Transactions"):
 * each becomes an UnavailableError with #12's cause and a code, so every failed command
 * answers `unavailable` and every failed read `failed`, and none is ever reported as saved.
 * An AbortError or UnknownError is transient: a commit runs again once in a new transaction,
 * and answers `retries-exhausted` if that fails too.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';

/** DOMException names a commit retries once (#17: only these, and a closing connection, retry) */
export const TRANSIENT = Object.freeze(['AbortError', 'UnknownError']);

/**
 * @param {unknown} error
 * @returns {string | undefined} its DOMException name
 */
export function nameOf(error) {
  if (error === null || typeof error !== 'object') return undefined;
  const { name } = /** @type {{name?: unknown}} */ (error);
  return typeof name === 'string' ? name : undefined;
}

/**
 * Whether one more run in a new transaction can get past `error`
 * @param {unknown} error
 */
export function isTransient(error) {
  const name = nameOf(error);
  return name !== undefined && TRANSIENT.includes(name);
}

/**
 * @type {Readonly<Record<string, readonly [import('../../core/contracts/outcomes.js').UnavailableCause, string, boolean]>>}
 */
const BY_NAME = Object.freeze({
  QuotaExceededError: /** @type {const} */ (['quota', 'quota', false]),
  VersionError: /** @type {const} */ (['newer-schema', 'version-too-new', false]),
  // A request on a transaction that already finished: a unit awaited something else
  TransactionInactiveError: /** @type {const} */ (['adapter', 'transaction-inactive', false]),
  InvalidStateError: /** @type {const} */ (['adapter', 'transaction-inactive', false]),
  ReadOnlyError: /** @type {const} */ (['adapter', 'write-in-readonly-transaction', false]),
  DataCloneError: /** @type {const} */ (['adapter', 'not-cloneable', false]),
  DataError: /** @type {const} */ (['adapter', 'invalid-key', false]),
  // A store or index the database lacks, as a damaged one can
  NotFoundError: /** @type {const} */ (['storage', 'store-unavailable', false]),
  ConstraintError: /** @type {const} */ (['storage', 'constraint', false]),
  // A file under the database that can't be read back
  NotReadableError: /** @type {const} */ (['storage', 'unreadable', false]),
  TimeoutError: /** @type {const} */ (['storage', 'timed-out', true]),
  AbortError: /** @type {const} */ (['storage', 'transaction-failed', true]),
  UnknownError: /** @type {const} */ (['storage', 'transaction-failed', true]),
});

/**
 * The UnavailableError for what IndexedDB threw or aborted with. One that isn't a DOMException
 * is the adapter's own failure, as contracts/outcomes.js's unavailableFrom has it.
 * @param {unknown} error
 * @returns {UnavailableError}
 */
export function failureOf(error) {
  if (error instanceof UnavailableError) return error;
  const name = nameOf(error);
  const known = name !== undefined && Object.hasOwn(BY_NAME, name) ? BY_NAME[name] : undefined;
  if (known) return new UnavailableError(known[0], known[1], known[2]);
  // Another error from IndexedDB itself
  if (typeof DOMException === 'function' && error instanceof DOMException) {
    return new UnavailableError('storage', 'transaction-failed', true);
  }
  return new UnavailableError('adapter', 'adapter-failed', true);
}

/**
 * The UnavailableError for an open that failed
 * @param {unknown} error
 * @returns {UnavailableError}
 */
export function openFailureOf(error) {
  const name = nameOf(error);
  if (name === 'VersionError' || name === 'QuotaExceededError') return failureOf(error);
  return new UnavailableError('storage', 'open-failed', true);
}

/**
 * The UnavailableError for what chrome.storage.local threw or rejected with: its quota, or
 * anything else
 * @param {unknown} error
 * @param {'read' | 'write'} doing
 * @returns {UnavailableError}
 */
export function settingsFailureOf(error, doing) {
  const message =
    error !== null && typeof error === 'object' ? /** @type {{message?: unknown}} */ (error).message : error;
  if (nameOf(error) === 'QuotaExceededError' || /quota/i.test(String(message))) {
    return new UnavailableError('quota', 'quota', false);
  }
  return new UnavailableError('storage', doing === 'read' ? 'settings-read-failed' : 'settings-write-failed', true);
}
