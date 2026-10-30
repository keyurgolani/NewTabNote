/**
 * The journal port, as #13's client reads it (#13, "Idempotency and catch-up"): the commands
 * a page wrote to #17's journal before their first send and that no acknowledgement has
 * removed yet. A journaled command persists its commandId there before it goes, so once the
 * page reloads, or comes back after a discard, the client resolves each by that key instead
 * of guessing. A coalesced commit is one entry, holding the coalesced command under the
 * commandId #6 stamps on it, so it resolves, and goes again, as one command. A command that
 * isn't journaled keeps its key in memory only, and after a reload its outcome comes from
 * reading the projection again, never a resend.
 *
 * #17's journal client implements it (its slice 2), and tests use a double until then. The
 * journal record's schema stays #17's: this reads only each entry's `v`, the catalog version
 * of its command when it was written, and the command, which contracts/upcast.js takes to the
 * current version. Writing and acknowledging entries are #17's and #35's.
 */

/**
 * @typedef {{v: number, command: Record<string, unknown>}} JournalEntry
 */

/**
 * @typedef {object} JournalReader
 * @property {() => Promise<JournalEntry[]>} inFlight - rejects with an UnavailableError when storage fails
 */

export {};
