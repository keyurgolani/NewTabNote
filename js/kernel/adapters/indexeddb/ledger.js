/**
 * #17's `operations` ledger (#17, "Identity and feed"; ports/idempotency-ledger.js): a row for
 * each command that committed or kept its conflict, under its commandId, which #17 calls its
 * opId, written in the transaction that commits the command (adapter.js). A row is `{opId,
 * digest, outcome, at}`: the SHA-256 of the command's canonical JSON (memory/fingerprint.js),
 * never the command, the outcome, which holds codes and ids only, and when it was written.
 * A resend of the same command gets the row's outcome back from commit, with nothing run
 * again, and another command under the same key is `idempotency-key-reuse`.
 *
 * Settings commands and startup maintenance keep no row: their writes go to
 * chrome.storage.local, outside any IndexedDB transaction, so a resend of one writes the same
 * values again. A database below version 10 has no `operations` store, so nothing there keeps
 * one either.
 *
 * Retention is the worker's alone (ledger-sweep.js, sweepLedger): it drops rows older than 90
 * days, and the oldest past 50,000, at most once a day. A resend older than that
 * reads as `absent` and runs again: a create is refused as `note-exists`, a capture's block,
 * stored already under its id, as `duplicate-block`, a placement command applies again, and from
 * #17 PR 4 a save carries its expected revision, so it conflicts and its text is kept. The
 * journal's drain replays an editor's save by #33's rules instead, which find it in already.
 */

import { isId } from '../../core/contracts/checks.js';
import { clone } from '../../core/contracts/clone.js';
import { UnavailableError, rejected } from '../../core/contracts/outcomes.js';
import { digestOf } from '../../core/memory/fingerprint.js';
import { failureOf } from './failures.js';
import { OPERATIONS_STORE } from './registry-names.js';
import { result } from './requests.js';

/** @typedef {import('../../core/contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../../core/contracts/outcomes.js').Conflict} Conflict */
/** @typedef {import('../../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../../core/ports/idempotency-ledger.js').KeyedCommand} KeyedCommand */
/** @typedef {import('../../core/ports/idempotency-ledger.js').LedgerRead} LedgerRead */
/** @typedef {import('../../core/ports/idempotency-ledger.js').LedgerStatus} LedgerStatus */

/**
 * A ledger row
 * @typedef {{opId: string, digest: string, outcome: Committed | Conflict, at: number}} LedgerRow
 */

/**
 * The row a command's outcome is kept as
 * @param {KeyedCommand} command
 * @param {Committed | Conflict} outcome
 * @param {number} at
 * @returns {LedgerRow}
 */
export function ledgerRow(command, outcome, at) {
  return { opId: command.commandId, digest: digestOf(command), outcome: clone(outcome), at };
}

/**
 * What a row answers a command sent again under its key: the row's outcome when it's the same
 * command, by its digest, and `idempotency-key-reuse` when it's another
 * @param {LedgerRow} row
 * @param {KeyedCommand} command
 * @returns {{outcome: Outcome, replayed: boolean}}
 */
export function replayFrom(row, command) {
  if (row.digest !== digestOf(command))
    return { outcome: rejected('validation', 'idempotency-key-reuse'), replayed: false };
  return { outcome: clone(row.outcome), replayed: true };
}

/**
 * What a row says, whatever command made it
 * @param {LedgerRow | undefined} row
 * @returns {LedgerStatus}
 */
function statusFrom(row) {
  if (!row) return { status: 'absent' };
  const outcome = clone(row.outcome);
  return outcome.kind === 'committed' ? { status: 'committed', outcome } : { status: 'conflict', outcome };
}

/**
 * @param {LedgerRow | undefined} row
 * @param {KeyedCommand} command
 * @returns {LedgerRead}
 */
const readFrom = (row, command) => (row && row.digest !== digestOf(command) ? { status: 'key-reuse' } : statusFrom(row));

/**
 * What a failed read or sweep answers: the adapter's says reload-required on a connection
 * that's gone or going (adapter.js), and failures.js's says what the failure means
 * @typedef {(error: unknown) => UnavailableError} FailureOf
 */

/**
 * The ledger's read port over a connection's database (ports/idempotency-ledger.js). A read
 * writes nothing, and a database without `operations` has no record of anything.
 * @param {{database: () => IDBDatabase, failure?: FailureOf}} options
 * @returns {IdempotencyLedger}
 */
export function createIndexedDbLedger({ database, failure = failureOf }) {
  /**
   * The key's row, read in a readonly transaction of its own, or none
   * @param {unknown} commandId
   * @returns {Promise<LedgerRow | undefined>}
   */
  const rowOf = async commandId => {
    if (!isId(commandId)) throw new UnavailableError('adapter', 'invalid-key', false);
    try {
      const db = database();
      if (!db.objectStoreNames.contains(OPERATIONS_STORE)) return undefined;
      const store = db.transaction(OPERATIONS_STORE, 'readonly').objectStore(OPERATIONS_STORE);
      return /** @type {LedgerRow | undefined} */ (await result(store.get(commandId)));
    } catch (error) {
      throw failure(error);
    }
  };
  return Object.freeze({
    read: async command => readFrom(await rowOf(/** @type {unknown} */ (command?.commandId)), command),
    status: async commandId => statusFrom(await rowOf(commandId)),
  });
}
