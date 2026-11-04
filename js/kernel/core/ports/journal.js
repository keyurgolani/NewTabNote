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
 * #35's journal implements it (slice 3): `NewTabNoteJournal` on IndexedDB
 * (adapters/indexeddb/journal.js), and a memory copy for the tests (memory/journal.js). The
 * client reads only each entry's `v`, the catalog version of its command when it was written,
 * and the command, which contracts/upcast.js takes to the current version. The entry's other
 * fields are #35's (domain/journal.js), and so are writing and removing entries
 * (JournalStore): a context writes one before it sends, and removes it once the command is
 * answered, and the coordinator's drain replays and removes what no context lived to answer.
 */

/**
 * @typedef {{v: number, command: Record<string, unknown>}} JournalEntry
 */

/**
 * @typedef {object} JournalReader
 * @property {() => Promise<JournalEntry[]>} inFlight - rejects with an UnavailableError when storage fails
 */

/** @typedef {import('../domain/journal.js').JournalRecord} JournalRecord */

/**
 * The journal as the contexts that write it, and the drain, use it. Each call is one strict
 * transaction, and answers once it has committed, or rejects with an UnavailableError.
 * @typedef {object} JournalStore
 * @property {() => Promise<void>} open
 * @property {(entry: JournalRecord) => Promise<void>} put - writes the entry, or replaces the one under its opId
 * @property {(opIds: readonly string[]) => Promise<void>} remove - the entries under these opIds, those there are
 * @property {(opId: string, unreplayable: {code: string, at: number, count?: number}) => Promise<void>} mark
 *   Sets the entry's `unreplayable` (domain/journal.js) in the transaction that reads it, so an
 *   entry removed meanwhile stays removed
 * @property {() => Promise<JournalRecord[]>} list - every entry, oldest first (domain/journal.js, inJournalOrder)
 */

export {};
