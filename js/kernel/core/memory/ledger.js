/**
 * The in-memory IdempotencyLedger (ports/idempotency-ledger.js). The in-memory adapter writes
 * it when it's given one (memory/adapter.js), in the task that commits, and tests keep it
 * outside a fake worker, as #17's ledger outlives the worker. Everything goes in and out as a
 * copy, and the first record for a key stands.
 */

import { isId } from '../contracts/checks.js';
import { clone } from '../contracts/clone.js';
import { UnavailableError } from '../contracts/outcomes.js';
import { fingerprintOf } from './fingerprint.js';

/** @typedef {import('../contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../contracts/outcomes.js').Conflict} Conflict */
/** @typedef {import('../ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../ports/idempotency-ledger.js').KeyedCommand} KeyedCommand */
/** @typedef {import('../ports/idempotency-ledger.js').LedgerRead} LedgerRead */

/**
 * @typedef {IdempotencyLedger & {
 *   record: (command: KeyedCommand, outcome: Committed | Conflict) => LedgerRead,
 *   size: () => number,
 * }} MemoryLedger
 *   `record` keeps an outcome for the command's key unless the key has one, and answers what
 *   the ledger then holds for that command. `size` is how many keys have records.
 */

/**
 * @param {{beforeRead?: () => void}} [options] - `beforeRead` runs before each read, and a
 *   throw fails it, as a failing IndexedDB request would
 * @returns {MemoryLedger}
 */
export function createMemoryLedger({ beforeRead = () => {} } = {}) {
  /** @type {Map<string, {fingerprint: string, outcome: Committed | Conflict}>} */
  const records = new Map();

  /**
   * @param {KeyedCommand} command
   * @returns {string}
   */
  const keyOf = command => {
    const commandId = /** @type {unknown} */ (command?.commandId);
    if (!isId(commandId)) throw new UnavailableError('adapter', 'invalid-key', false);
    return commandId;
  };

  /**
   * @param {KeyedCommand} command
   * @param {string} commandId
   * @returns {LedgerRead}
   */
  const answer = (command, commandId) => {
    const kept = records.get(commandId);
    if (!kept) return { status: 'absent' };
    if (kept.fingerprint !== fingerprintOf(command)) return { status: 'key-reuse' };
    const outcome = clone(kept.outcome);
    return outcome.kind === 'committed' ? { status: 'committed', outcome } : { status: 'conflict', outcome };
  };

  return Object.freeze({
    async read(command) {
      const commandId = keyOf(command);
      beforeRead();
      return answer(command, commandId);
    },
    record(command, outcome) {
      const commandId = keyOf(command);
      if (outcome?.kind !== 'committed' && outcome?.kind !== 'conflict') {
        throw new TypeError('only a committed or conflict outcome has a record');
      }
      if (!records.has(commandId)) {
        records.set(commandId, { fingerprint: fingerprintOf(command), outcome: clone(outcome) });
      }
      return answer(command, commandId);
    },
    size: () => records.size,
  });
}
