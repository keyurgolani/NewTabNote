/**
 * The IdempotencyLedger port (#13, "Idempotency and catch-up"): what a client reads, by a
 * command's key, once the command's reply was lost to a worker stop, a dropped port, or a
 * deadline. #12's `commandId` and #17's `opId` are one key, made once when the intent forms
 * and reused by every retry. #17's persisted idempotency records are the dedupe authority:
 * each is written in the transaction that commits its command, or keeps its conflict, with a
 * fingerprint of the command. A read answers one of:
 *
 * - `committed`, with the outcome the command committed with, which the client answers as
 *   the original outcome, never sending the command again;
 * - `conflict`, with the conflict outcome the command was kept with;
 * - `absent`: no record, so the command never committed. A validation or policy rejection, and
 *   an `unavailable` outcome, leave none either, so the one resend the client then allows, with
 *   the same key, gets the same rejection;
 * - `key-reuse`: the key has a record of another command, which fails closed as
 *   `idempotency-key-reuse`.
 *
 * A read writes nothing. The kernel adapter's recall reserves a bulk command's key when it
 * has none (ports/repository.js), so the lost-reply read never goes through recall: a read
 * here leaves the key for whichever command commits it first. Reads are async, since #17's
 * ledger is in IndexedDB, and a read that fails rejects with an UnavailableError, never an
 * answer: the client then can't tell, and the outcome stays unknown.
 *
 * Writing a record is the adapter's, in its commit transaction, so the port has no write.
 * test/kernel/idempotency-ledger-suite.mjs is the suite #17's durable ledger runs.
 */

/** @typedef {import('../contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../contracts/outcomes.js').Conflict} Conflict */

/**
 * A command as a client sent it: its `type` names its operation, and its `commandId` is its key
 * @typedef {{type: string, commandId: string} & Record<string, unknown>} KeyedCommand
 */

/**
 * @typedef {{status: 'absent'}
 *   | {status: 'committed', outcome: Committed}
 *   | {status: 'conflict', outcome: Conflict}
 *   | {status: 'key-reuse'}} LedgerRead
 */

/**
 * @typedef {object} IdempotencyLedger
 * @property {(command: KeyedCommand) => Promise<LedgerRead>} read
 *   What the command's key has a record of, told apart from another command under the same
 *   key by the record's fingerprint. A command whose commandId isn't a non-empty string
 *   rejects with an UnavailableError, cause `adapter`, code `invalid-key`.
 */

export {};
