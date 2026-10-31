/**
 * The intelligence repository (#7, "Record rules"): signals, decisions, and corrections in
 * their own stores, apart from notes, so nothing the domain writes can touch a note record, a
 * note revision, or `updatedAt`. Slice 1 has the in-memory one (memory/intelligence.js); slice
 * 2 adds #17's IndexedDB stores behind the same shape, with a shared suite.
 *
 * `transact(work)` runs `work` over one transaction, after every transaction opened before it,
 * with no `await` inside: it reads, decides, and stages writes, and either all of them commit
 * or none do. A commit that writes anything takes one commitSeq in #17's change log, with one
 * change per signal it touched, and answers the typed events it made (events.js). A record
 * that fails its schema on read is quarantined and counted, and reads as absent.
 *
 * The in-memory repository answers `signalsOfNote`, `signalsCiting`, and `everySignal` by
 * scanning. Slice 2's IndexedDB stores need indexes for them instead: one on the signal's own
 * note id, and a multi-entry one on every note id its sources cite.
 */

export {};

/** @typedef {import('./records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('./records.js').SignalDecision} SignalDecision */
/** @typedef {import('./records.js').SignalCorrection} SignalCorrection */
/** @typedef {import('./events.js').IntelligenceEvent} IntelligenceEvent */
/** @typedef {import('./operations.js').IntelligenceOutcome} IntelligenceOutcome */

/**
 * A kept outcome, keyed by commandId: the digest of the command that got it, never the command
 * @typedef {{fingerprint: string, outcome: IntelligenceOutcome}} KeptOutcome
 */

/**
 * The note command a task's complete or reopen sent, keyed by its commandId, with the digest
 * of the lifecycle command. It names ids, a revision, and a boolean, never content.
 * @typedef {{fingerprint: string, noteCommand: {commandId: string, noteId: string, blockId: string, checked: boolean, expectedRevision: number | null}}} PendingNote
 */

/**
 * One transaction's view. Reads see the transaction's own staged writes.
 * @typedef {object} IntelligenceTx
 * @property {(signalId: string) => IntelligenceSignal | null} signal
 * @property {(noteId: string) => IntelligenceSignal[]} signalsOfNote
 * @property {(noteId: string) => IntelligenceSignal[]} signalsCiting - another note's signals that cite this one
 * @property {() => IntelligenceSignal[]} everySignal - for the hook, which runs in the worker
 * @property {(signalId: string) => SignalDecision | null} decision
 * @property {(noteId: string) => SignalDecision[]} decisionsOfNote
 * @property {(signalId: string) => SignalCorrection[]} corrections - in the order appended
 * @property {(noteId: string) => string[]} correctedSignalsOfNote - the ids with corrections
 * @property {(commandId: string) => KeptOutcome | null} kept
 * @property {(commandId: string) => PendingNote | null} pendingNote - the note command a task's
 *   complete or reopen sent under this commandId, which a retry sends again unchanged
 * @property {(commandId: string, pending: PendingNote) => void} keepPendingNote
 * @property {(signal: IntelligenceSignal) => void} putSignal
 * @property {(signalId: string) => void} deleteSignal
 * @property {(decision: SignalDecision) => void} putDecision
 * @property {(signalId: string) => void} deleteDecision
 * @property {(correction: SignalCorrection) => void} appendCorrection
 * @property {(signalId: string) => void} deleteCorrections
 * @property {(commandId: string, fingerprint: string, outcome: (commitSeq: number | null) => IntelligenceOutcome) => void} keep
 *   Keeps the outcome a commandId got, made once the commit's commitSeq is known
 */

/**
 * @typedef {{signals: number, decisions: number, corrections: number}} QuarantineCounts
 */

/**
 * @typedef {object} IntelligenceRepository
 * @property {<T>(work: (tx: IntelligenceTx) => T) => Promise<{result: T, commitSeq: number | null, asOf: number, events: IntelligenceEvent[]}>} transact
 *   `commitSeq` is the commit's, or null when it wrote nothing, and `asOf` the last commitSeq
 *   of an intelligence commit as of the transaction, read no later than its records, which a
 *   surface reports as its `asOfCommitSeq`
 * @property {() => QuarantineCounts} quarantined - how many records each store has refused on read
 */
