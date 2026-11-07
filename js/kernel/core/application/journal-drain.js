/**
 * The journal's drain (#35 slice 3, "The drain"): what the coordinator does with the entries in
 * `NewTabNoteJournal` (domain/journal.js) that no context lived to see answered. It runs in the
 * service worker, on its kernel, under Web Lock `journal.replay` (composition/journal.js), once
 * the coordinator is ready and whenever a page wakes it, never inside the coordinator's start,
 * so it never holds a welcome. Nothing here touches a browser API: the ports come in.
 *
 * In order:
 * 1. The sweep. Every entry, whatever its state or owner, whose note was deleted for good
 *    (findTombstones) for one of SWEPT_REASONS is deleted, unreplayed, so a note deleted for good
 *    never comes back from the journal and no text of it stays there. An entry whose note has a
 *    tombstone for any other reason is kept, and its incident raised.
 * 2. The replays, oldest first: each `submitted` entry whose owner is gone, its Web Lock
 *    `journal.owner.<ownerSessionId>` free, and each of the coordinator's own that isn't in
 *    flight. A `draft` entry is #2's, and never replayed. Each is upcast to the catalog's version
 *    (contracts/upcast.js), then judged as the surface that wrote it (`permits`, #35 slice 4b-1):
 *    a replay runs only if that surface could have sent it itself, as the port router would judge
 *    its request, never with the worker's rights. Then it's sent under its persisted opId, so
 *    #17's ledger answers one that committed already with its outcome and nothing runs twice:
 *    - a note's creation, an append, and a capture as written; a capture lands in the Daily Note
 *      of the day it was made (its `at`), and a block already stored is refused;
 *    - an editor's save is the pages': they apply the close-time draft its entry holds, by #33's
 *      rules, under `<opId>-apply` (slice 3b, the lead's call on #182). The worker carries the
 *      applier only for Popup's own apply over the port (#35 slice 4b-2, rule 6), so the drain
 *      leaves the save, and still sweeps it after a delete for good. A
 *      save with no draft can't be replayed safely by anyone, so it's kept as a conflict record.
 *      One a newer build wrote, or one under a tombstone the sweep keeps for, is held, and its
 *      incident raised (the lead's answer to Q6): the code on its mark is what the pages leave it
 *      by.
 * 3. What each answer does with its entry:
 *    - committed, a conflict (whose command the kernel kept), or a refusal that says the work is
 *      in (`note-exists`, `duplicate-block`, `block-of-another-note`): the entry goes;
 *    - the note isn't there (`note-not-found`), or a policy refusal, the kernel's or its surface's
 *      (the router's code: `unknown-operation` for a command the surface's catalog doesn't have,
 *      `forbidden-for-surface` for one it isn't granted): the entry stays, and its incident is
 *      raised;
 *    - any other refusal, or an entry this build can't read (`invalid-payload`): the entry is kept
 *      as a #17 conflict record (keepJournalEntry), its incident raised, and then it goes;
 *    - an entry a newer build wrote (`unsupported-version`), or one naming an operation this build
 *      doesn't journal (`unknown-operation`): it stays for that build, and its incident is raised
 *      (the lead's answer to Q6);
 *    - unavailable, or no answer: the entry stays for the next drain. A code that says storage
 *      itself can't answer (STORAGE_WIDE), or a throw at no entry, stops the drain there, with
 *      every entry left. Any other holds back only the entry's note (the lead's call on 3b's
 *      plan): its later entries wait behind it, so a note's entries still go oldest first, while
 *      another note's go on past it. The drain answers `stopped`, with the stop's code, and names
 *      each note it held back (`held`), which system.coordinatorHealth says. A stop it can't
 *      retry, an `unavailable` that says so or a throw (`drain-failed`), would stop every drain
 *      at that entry, so it raises the entry's incident too, as a stop: the entry is still kept,
 *      so a capture is told nothing more. A stop it can retry raises it the same way on the third
 *      drain in a row that stops at the entry, and never before.
 *
 * An incident is raised once for each entry and code: the entry keeps the code it was raised for
 * (`unreplayable`), and a drain that finds the same one again says nothing more. The drains in a
 * row that stopped at an entry on a code it can retry are counted on the same mark, as `{code,
 * at, count}`, until the third raises it, and an incident raised there for anything else starts
 * the count again. Where that mark can't be written, as on a full disk, the context remembers
 * what it raised and counted for its life (`raised`, `stops`), so its next drain doesn't raise it
 * again, and still counts. An entry that isn't a journal record has no mark, so a stop for good
 * at its keep is raised once in the context's life, by `raised` alone (probe E4, #35 slice 4a), and
 * the stops in a row at its keep that it can retry are counted in `stops` alone, the third raising
 * it as a stop, once in the context's life (#35 slice 4b-1, Q6): a later worker counts from 1 again,
 * and a drain that gets past it starts the count again. The mark never keeps an entry from
 * replaying: a build that can read it replays it.
 *
 * What it answers holds counts, codes and note ids. `oldestOrphanedEntryAt` is when the oldest
 * entry it left whose owner is gone was written, an editor save's the pages haven't taken yet
 * included, and `stuck` the last stop it made at an entry, with the count of drains in a row that
 * stopped there where it's counted, which system.coordinatorHealth says (Q6).
 */

import { isId, isRecord } from '../contracts/checks.js';
import { upcastJournalEntry } from '../contracts/upcast.js';
import { PAGES_APPLY, SAVE_VERSION, SWEPT_REASONS, isJournalRecord } from '../domain/journal.js';

/** @typedef {import('../domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../ports/journal.js').JournalStore} JournalStore */
/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../messaging/operations.js').Lookup} Lookup */
/** @typedef {import('../ports/policy.js').Caller} Caller */

/**
 * The worker's kernel, as the drain sends through it
 * @typedef {object} DrainClient
 * @property {(command: Command) => Promise<Outcome | BulkOutcome>} execute - it sends no bulk command
 * @property {(query: import('../contracts/queries.js').Query) => Promise<import('../contracts/outcomes.js').QueryState<unknown>>} query
 */

/**
 * @typedef {object} DrainPorts
 * @property {JournalStore} journal
 * @property {DrainClient} client
 * @property {Lookup} lookup - the journaled commands (messaging/journaled-operations.js)
 * @property {() => Promise<ReadonlySet<string> | null>} liveOwners
 *   The sessions whose owner lock is held now, or null when that can't be told, which leaves
 *   every other owner's entries alone
 * @property {{sessionId: string, inFlight: () => ReadonlySet<string>}} own
 *   The coordinator's own session, whose entries it replays unless their command is in flight
 * @property {{now(): number}} clock
 * @property {(command: Command, caller: Caller) => string | null} permits
 *   The code that refuses `command` from `caller`, the surface that wrote its entry and the entry's
 *   owner session, as #13's router would refuse that surface's own request, or null when that
 *   surface could have sent it (#35 slice 4b-1)
 * @property {(entry: JournalRecord, code: string, how?: {stop?: boolean}) => void} [unreplayable]
 *   Told once for each entry and code that keeps it from replaying as written, with `stop` when
 *   it's a stop for good at an entry that's still kept. Never in the drain's way: what it throws
 *   is dropped.
 * @property {{has(key: string): boolean, add(key: string): unknown}} [raised]
 *   What this context raised already, by entry and code, which it keeps for its life
 * @property {{get(opId: string): number | undefined, set(opId: string, count: number): unknown, delete(opId: string): unknown}} [stops]
 *   How many drains in a row stopped at each entry on a code it can retry, by opId, which this
 *   context keeps for its life
 * @property {(entry: JournalRecord) => void} [replayed]
 *   Told of each entry whose command is in now, once it's gone from the journal, as unreplayable
 *   is told
 */

/**
 * A note a drain held back, and the code it stopped at, at the note's oldest entry left
 * @typedef {{noteId: string, code: string}} HeldNote
 */

/**
 * What a drain did
 * @typedef {object} DrainResult
 * @property {'empty' | 'drained' | 'stopped'} status
 *   `stopped`: storage or the kernel couldn't answer, for the whole drain or at a note it held back
 * @property {string | null} code - why it stopped
 * @property {number} replayed - entries whose command is in now, run by this drain or before it
 * @property {number} swept - entries of notes deleted for good
 * @property {number} kept - entries kept as conflict records
 * @property {number} left - entries still in the journal
 * @property {number | null} oldestOrphanedEntryAt
 * @property {HeldNote[]} held
 *   The notes a stop at one of their entries held back, oldest first. A stop of the whole drain
 *   names none: its code says why.
 * @property {Stuck | null} stuck
 *   The last stop it made at an entry, and null when it made none (#35 slice 4b-1, Q6)
 */

/**
 * A stop at an entry: its code, and how many drains in a row stopped at that entry on a code it can
 * retry, where they're counted. A stop for good, one storage-wide, or one at an entry whose incident
 * the count raised already, has no count.
 * @typedef {{code: string, count?: number}} Stuck
 */

/**
 * The refusals that say an entry's work is in already: its note made, or its blocks stored, in
 * its note or in one they were moved to since, since each block's id is new when it's sent
 */
const ALREADY_IN = Object.freeze(['note-exists', 'duplicate-block', 'block-of-another-note']);

/** What a refusal of a replay keeps in the journal: the note isn't there to write to */
const NOT_THERE = 'note-not-found';

/**
 * The codes that say storage itself can't answer, so a stop on one stops the whole drain, at
 * whichever entry it comes (the lead's call on 3b's plan). Any other code holds back only the
 * entry's note.
 */
const STORAGE_WIDE = Object.freeze([
  'quota',
  'transaction-failed',
  'transaction-inactive',
  'database-closed',
  'open-failed',
]);

/** How many drains in a row stop at an entry on a code it can retry before its incident is raised */
const STOPS_TO_RAISE = 3;

/**
 * How the drain replays each journaled command, by its type: as written, under its own key. A
 * type this table lacks has no replay in the worker.
 * @type {Readonly<Record<string, (command: Record<string, unknown>) => Command>>}
 */
const REPLAYS = Object.freeze({
  createNote: command => /** @type {Command} */ ({ ...command, type: 'createNote' }),
  insertBlocks: command => /** @type {Command} */ ({ ...command, type: 'insertBlocks' }),
  captureToDailyNote: command => /** @type {Command} */ ({ ...command, type: 'captureToDailyNote' }),
});

/**
 * Whether a drain stopped by `error` may get through next time: an UnavailableError that says
 * so. Anything else thrown would stop every drain at the same place.
 * @param {unknown} error
 */
const retryable = error => isRecord(error) && error.retryable === true;

/**
 * The code an UnavailableError, or anything thrown, stops a drain with
 * @param {unknown} error
 * @returns {string}
 */
const stopCode = error =>
  error && typeof error === 'object' && typeof (/** @type {{code?: unknown}} */ (error).code) === 'string'
    ? /** @type {{code: string}} */ (error).code
    : 'drain-failed';

/**
 * Drains the journal once. It never rejects: storage that fails stops it, and what's left
 * stays for the next drain.
 * @param {DrainPorts} ports
 * @returns {Promise<DrainResult>}
 */
export async function drainJournal({
  journal,
  client,
  lookup,
  liveOwners,
  own,
  clock,
  permits,
  unreplayable,
  raised,
  stops,
  replayed,
}) {
  /** @type {DrainResult} */
  const result = {
    status: 'drained',
    code: null,
    replayed: 0,
    swept: 0,
    kept: 0,
    left: 0,
    oldestOrphanedEntryAt: null,
    held: [],
    stuck: null,
  };
  /** @type {unknown[]} */
  let listed;
  try {
    listed = await journal.list();
  } catch (error) {
    return { ...result, status: 'stopped', code: stopCode(error) };
  }
  if (listed.length === 0) return { ...result, status: 'empty' };
  /** @type {Set<string>} each entry gone from the journal, by opId */
  const gone = new Set();
  /** @type {Set<string>} each note a stop at one of its entries holds back, by id */
  const heldNotes = new Set();
  /** @type {ReadonlySet<string> | null} */
  let live = null;
  try {
    live = await liveOwners();
  } catch {
    live = null;
  }
  const inFlight = own.inFlight();
  /**
   * Whether no live context holds `entry`: its owner's lock is free, or it's the coordinator's
   * own and its command isn't in flight
   * @param {JournalRecord} entry
   */
  const orphaned = entry =>
    entry.ownerSessionId === own.sessionId
      ? !inFlight.has(entry.opId)
      : live !== null && !live.has(entry.ownerSessionId);

  /**
   * Whether `entry`'s incident for `code` is raised already: on its mark, which a count of stops
   * isn't, or in what this context raised
   * @param {JournalRecord} entry
   * @param {string} code
   */
  const raisedFor = (entry, code) =>
    (isRecord(entry.unreplayable) && entry.unreplayable.code === code && entry.unreplayable.count === undefined) ||
    (raised !== undefined && raised.has(JSON.stringify([entry.opId, code])));

  /**
   * Raises `entry`'s incident for `code` once, and keeps the code on the entry so a later drain
   * doesn't raise it again, and in `raised`, where the mark can't be written. Only an entry no
   * live context holds is marked, so a mark never puts back an entry its owner removed meanwhile.
   * The mark it writes starts the count of stops at the entry again, as it does in `stops`.
   * @param {JournalRecord} entry
   * @param {string} code
   * @param {{stop?: boolean}} [how] - `stop` for a stop for good at an entry that's still kept
   */
  const raise = async (entry, code, how = {}) => {
    if (raisedFor(entry, code)) return;
    if (raised) raised.add(JSON.stringify([entry.opId, code]));
    if (stops) stops.delete(entry.opId);
    try {
      if (unreplayable) unreplayable(entry, code, how);
    } catch {
      // The incident is best effort, and the entry stays either way
    }
    try {
      await journal.mark(entry.opId, { code, at: clock.now() });
    } catch {
      // Without the mark, the next drain raises it again
    }
  };

  /**
   * Raises the incident of `entry`, which isn't a journal record, for `code`, as a stop, once in
   * this context's life (probe E4, #35 slice 4a): with no record to mark, only what this context
   * raised keeps its next drain from raising it again, so a later worker raises it once more
   * @param {Record<string, unknown> & {opId: string}} entry
   * @param {string} code
   */
  const raiseUnmarked = (entry, code) => {
    const key = JSON.stringify([entry.opId, code]);
    if (raised !== undefined && raised.has(key)) return;
    if (raised) raised.add(key);
    // What unreplayable reads of a record, its surface and its command, it reads as it is here
    const unread = /** @type {JournalRecord} */ (/** @type {unknown} */ (entry));
    try {
      if (unreplayable) unreplayable(unread, code, { stop: true });
    } catch {
      // Best effort, as raise() is
    }
  };

  /**
   * Counts a drain that stopped at `entry` on `code`, which it can retry, and raises the entry's
   * incident for it, as a stop, on the third in a row (the lead's call on 3b's plan). The count is
   * the mark's or this context's, whichever is higher, so it holds where the mark can't be written.
   * @param {JournalRecord} entry
   * @param {string} code
   * @returns {Promise<number | undefined>} the count, or undefined once its incident is raised
   */
  const counted = async (entry, code) => {
    if (raisedFor(entry, code)) return undefined;
    const mark = entry.unreplayable;
    const marked = isRecord(mark) && Number.isSafeInteger(mark.count) ? Number(mark.count) : 0;
    const count = Math.max(marked, (stops && stops.get(entry.opId)) || 0) + 1;
    if (count >= STOPS_TO_RAISE) {
      await raise(entry, code, { stop: true });
      return count;
    }
    if (stops) stops.set(entry.opId, count);
    try {
      await journal.mark(entry.opId, { code, at: clock.now(), count });
    } catch {
      // This context's count still holds
    }
    return count;
  };

  /**
   * Counts a drain that stopped at `entry`, which isn't a journal record, on `code`, which it can
   * retry, and raises its incident, as a stop, on the third in a row (#35 slice 4b-1, Q6). With no
   * record to mark, the count is this context's alone, in `stops`, and the raise is once in its life,
   * as E4's is
   * @param {Record<string, unknown> & {opId: string}} entry
   * @param {string} code
   * @returns {number | undefined} the count, or undefined where it can't be counted or once it's raised
   */
  const countedUnmarked = (entry, code) => {
    if (!stops || (raised !== undefined && raised.has(JSON.stringify([entry.opId, code])))) return undefined;
    const count = (stops.get(entry.opId) || 0) + 1;
    if (count >= STOPS_TO_RAISE) {
      stops.delete(entry.opId);
      raiseUnmarked(entry, code);
      return count;
    }
    stops.set(entry.opId, count);
    return count;
  };

  /**
   * `stuck` for a stop on `code`, with `count` when it's counted
   * @param {string} code
   * @param {number | undefined} count
   * @returns {Stuck}
   */
  const stuckAt = (code, count) => (count === undefined ? { code } : { code, count });

  /**
   * A stop at `entry` on `code`: one that says storage itself can't answer stops the drain, and
   * any other holds back the entry's note, which an entry with no note can't be. A stop it can't
   * retry raises the entry's incident, as a stop, and one it can is counted. An entry that isn't
   * a journal record, whose keep stopped, stops the drain: a stop it can't retry raises its
   * incident once in this context's life, since it has no mark (raiseUnmarked), and one it can is
   * counted in this context alone (Q6). Either way, it's the drain's `stuck`. Answers true when
   * the drain has to stop.
   * @param {unknown} entry
   * @param {string} code
   * @param {boolean} canRetry
   * @returns {Promise<boolean>}
   */
  const stopAt = async (entry, code, canRetry) => {
    result.status = 'stopped';
    result.code = code;
    const wide = STORAGE_WIDE.includes(code);
    /** @type {number | undefined} */
    let count;
    if (!isJournalRecord(entry)) {
      if (isRecord(entry) && isId(entry.opId)) {
        const unread = /** @type {Record<string, unknown> & {opId: string}} */ (entry);
        if (!canRetry) raiseUnmarked(unread, code);
        else if (!wide) count = countedUnmarked(unread, code);
      }
      result.stuck = stuckAt(code, count);
      return true;
    }
    if (!canRetry) await raise(entry, code, { stop: true });
    else if (!wide) count = await counted(entry, code);
    result.stuck = stuckAt(code, count);
    if (wide || !isId(entry.noteId)) return true;
    heldNotes.add(entry.noteId);
    result.held.push({ noteId: entry.noteId, code });
    return false;
  };

  /**
   * Keeps `entry` as a conflict record, raises its incident, and removes it once it's kept.
   * Answers false when the drain has to stop.
   * @param {Record<string, unknown> & {opId: string}} entry
   * @param {string} code
   * @returns {Promise<boolean>}
   */
  const keep = async (entry, code) => {
    const { opId, noteId, command } = entry;
    const outcome = await client.execute({
      type: 'keepJournalEntry',
      commandId: `${opId}-keep`,
      opId,
      ...(isId(noteId) ? { noteId } : {}),
      command: isRecord(command) ? command : {},
    });
    if (outcome.kind === 'unavailable' || outcome.kind === 'unknown') {
      return !(await stopAt(entry, outcome.code, outcome.kind === 'unknown' || outcome.retryable));
    }
    if (outcome.kind !== 'committed') {
      // Nowhere to keep it, so it stays where it is
      if (isJournalRecord(entry)) await raise(entry, code);
      return true;
    }
    try {
      if (unreplayable) unreplayable(/** @type {JournalRecord} */ (/** @type {unknown} */ (entry)), code);
    } catch {
      // Best effort, as raise() is
    }
    await journal.remove([opId]);
    gone.add(opId);
    result.kept += 1;
    return true;
  };

  /** @type {JournalRecord | null} the entry being replayed or kept, whose incident a throw raises */
  let deciding = null;
  try {
    // 1. The sweep, before anything replays
    const entries = /** @type {JournalRecord[]} */ (listed.filter(isJournalRecord));
    const noteIds = [...new Set(entries.map(entry => entry.noteId).filter(isId))];
    /** @type {Map<string, string>} each note deleted for good, by id, and why */
    const tombstones = new Map();
    if (noteIds.length > 0) {
      const state = await client.query({ type: 'findTombstones', noteIds });
      if (state.kind === 'failed') return { ...result, status: 'stopped', code: state.code, left: listed.length };
      if (state.kind === 'ready') {
        const { tombstones: found } = /** @type {{tombstones: Array<{id: string, reason: string}>}} */ (state.data);
        for (const { id, reason } of found) tombstones.set(id, reason);
      }
    }
    const swept = entries.filter(entry => SWEPT_REASONS.includes(/** @type {string} */ (tombstones.get(entry.noteId))));
    if (swept.length > 0) {
      await journal.remove(swept.map(entry => entry.opId));
      for (const entry of swept) gone.add(entry.opId);
      result.swept = swept.length;
    }

    // 2. The replays, oldest first, each note's behind any stop at its own
    for (const entry of listed) {
      deciding = null;
      try {
        if (!isJournalRecord(entry)) {
          // Malformed: kept as a conflict record when it has a key to keep it under
          const opId = isRecord(entry) ? entry.opId : undefined;
          if (isId(opId)) {
            if (!(await keep(/** @type {any} */ (entry), 'invalid-payload'))) break;
            // This drain got past it, so the stops in a row at it start again (Q6)
            if (stops) stops.delete(opId);
          }
          continue;
        }
        if (gone.has(entry.opId) || entry.state !== 'submitted' || !orphaned(entry)) continue;
        if (heldNotes.has(entry.noteId)) continue;
        deciding = entry;
        // An editor's save is the pages' to replay, unless no one can: one with no draft or no
        // version is kept as a conflict record, and one under a tombstone the sweep keeps for, or
        // one a newer build wrote, is held. An entry with no command goes on to the upcast, which
        // reads it as malformed
        if (isRecord(entry.command) && Object.hasOwn(PAGES_APPLY, String(entry.command.type))) {
          if (!isRecord(entry.draft) || !Number.isSafeInteger(entry.v) || entry.v < 1) {
            if (!(await keep(entry, 'invalid-payload'))) break;
          } else if (tombstones.has(entry.noteId)) {
            await raise(entry, 'note-deleted');
          } else if (entry.v > SAVE_VERSION) {
            await raise(entry, 'unsupported-version');
          }
          continue;
        }
        if (tombstones.has(entry.noteId)) {
          await raise(entry, 'note-deleted');
          continue;
        }
        const upcast = upcastJournalEntry({ v: entry.v, command: entry.command }, lookup);
        if (!upcast.ok) {
          if (upcast.code === 'invalid-payload') {
            if (!(await keep(entry, 'invalid-payload'))) break;
          } else {
            await raise(entry, upcast.code);
          }
          continue;
        }
        const { command } = upcast;
        const replay = Object.hasOwn(REPLAYS, String(command.type)) ? REPLAYS[String(command.type)] : null;
        const sent = command.commandId === entry.opId && replay ? replay(command) : null;
        if (!sent) {
          if (!(await keep(entry, 'invalid-payload'))) break;
          continue;
        }
        // Only what the entry's own surface could have sent, judged as it and its session: a
        // refusal is a policy rejection, so the entry stays, and its incident is raised
        const refused = permits(sent, { surface: entry.surface, contextId: entry.ownerSessionId });
        if (refused) {
          await raise(entry, refused);
          continue;
        }
        const outcome = await client.execute(sent);
        if (outcome.kind === 'unavailable' || outcome.kind === 'unknown') {
          if (await stopAt(entry, outcome.code, outcome.kind === 'unknown' || outcome.retryable)) break;
          continue;
        }
        if (outcome.kind === 'rejected' && !ALREADY_IN.includes(outcome.code)) {
          if (outcome.code === NOT_THERE || outcome.reason === 'policy') await raise(entry, outcome.code);
          else if (!(await keep(entry, 'replay-refused'))) break;
          continue;
        }
        // Its command is in, so a removal that throws leaves it for the next drain's ledger answer
        deciding = null;
        await journal.remove([entry.opId]);
        gone.add(entry.opId);
        result.replayed += 1;
        try {
          if (replayed) replayed(entry);
        } catch {
          // Best effort, as unreplayable is
        }
      } catch (error) {
        // A throw at no entry, as a removal once its command is in, stops the drain below
        if (!deciding) throw error;
        if (await stopAt(deciding, stopCode(error), retryable(error))) break;
      }
    }
  } catch (error) {
    result.status = 'stopped';
    result.code = stopCode(error);
  }

  // What it leaves, and the oldest of that no live context holds
  for (const entry of listed) {
    if (!isJournalRecord(entry)) {
      if (!(isRecord(entry) && gone.has(/** @type {string} */ (entry.opId)))) result.left += 1;
      continue;
    }
    if (gone.has(entry.opId)) continue;
    result.left += 1;
    if (orphaned(entry) && (result.oldestOrphanedEntryAt === null || entry.createdAt < result.oldestOrphanedEntryAt)) {
      result.oldestOrphanedEntryAt = entry.createdAt;
    }
  }
  return result;
}
