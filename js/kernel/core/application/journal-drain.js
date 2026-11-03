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
 *    (contracts/upcast.js), then sent under its persisted opId, so #17's ledger answers one that
 *    committed already with its outcome and nothing runs twice:
 *    - a note's creation, an append, and a capture as written; a capture lands in the Daily Note
 *      of the day it was made (its `at`), and a block already stored is refused;
 *    - an editor's save as the close-time draft its entry holds, by #33's rules (the lead's
 *      answer to the plan's Q1), under `<opId>-apply`: dropped when the note holds it already,
 *      saved where its blocks are as the editor saw them, and one recovered note where another
 *      writer changed them since. A save with no draft can't be replayed safely, so it's kept.
 * 3. What each answer does with its entry:
 *    - committed, a conflict (whose command the kernel kept), or a refusal that says the work is
 *      in (`note-exists`, `duplicate-block`, `block-of-another-note`): the entry goes;
 *    - the note isn't there (`note-not-found`, or a draft's `close-draft-gone` with no tombstone
 *      found), or a policy refusal: the entry stays, and its incident is raised;
 *    - any other refusal, or an entry this build can't read (`invalid-payload`): the entry is kept
 *      as a #17 conflict record (keepJournalEntry), its incident raised, and then it goes;
 *    - an entry a newer build wrote (`unsupported-version`), or one naming an operation this build
 *      doesn't journal (`unknown-operation`): it stays for that build, and its incident is raised
 *      (the lead's answer to Q6);
 *    - unavailable, or no answer: the drain stops, and every entry left stays for the next one.
 *
 * An incident is raised once for each entry and code: the entry keeps the code it was raised for
 * (`unreplayable`), and a drain that finds the same one again says nothing more. The mark never
 * keeps an entry from replaying: a build that can read it replays it.
 *
 * What it answers holds counts, codes, and the ids of the notes a draft entry recovered or saved
 * into a note in the Trash, which slice 3's page wake shows as the close-time drafts' are shown.
 * `oldestOrphanedEntryAt` is when the oldest entry it left whose owner is gone was written, which
 * system.coordinatorHealth says.
 */

import { isId, isRecord } from '../contracts/checks.js';
import { upcastJournalEntry } from '../contracts/upcast.js';
import { isCloseDraft } from '../domain/close-draft.js';
import { SWEPT_REASONS, isJournalRecord } from '../domain/journal.js';

/** @typedef {import('../domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../ports/journal.js').JournalStore} JournalStore */
/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../messaging/operations.js').Lookup} Lookup */

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
 * @property {(entry: JournalRecord, code: string) => void} [unreplayable]
 *   Told once for each entry and code that keeps it from replaying as written. Never in the
 *   drain's way: what it throws is dropped.
 * @property {(entry: JournalRecord) => void} [replayed]
 *   Told of each entry whose command is in now, once it's gone from the journal, as unreplayable
 *   is told
 */

/**
 * What a drain did
 * @typedef {object} DrainResult
 * @property {'empty' | 'drained' | 'stopped'} status - `stopped`: storage or the kernel couldn't answer
 * @property {string | null} code - why it stopped
 * @property {number} replayed - entries whose command is in now, run by this drain or before it
 * @property {number} swept - entries of notes deleted for good
 * @property {number} kept - entries kept as conflict records
 * @property {number} left - entries still in the journal
 * @property {Array<{id: string, of: string}>} recovered - each recovered note a draft entry made, and its original
 * @property {string[]} savedInTrash - each note in the Trash a draft entry was saved into
 * @property {number | null} oldestOrphanedEntryAt
 */

/**
 * The refusals that say an entry's work is in already: its note made, or its blocks stored, in
 * its note or in one they were moved to since, since each block's id is new when it's sent
 */
const ALREADY_IN = Object.freeze(['note-exists', 'duplicate-block', 'block-of-another-note']);

/** What a refusal of a replay keeps in the journal: the note isn't there to write to */
const NOT_THERE = 'note-not-found';

/** A draft entry whose note is gone with no tombstone found */
const DRAFT_GONE = 'close-draft-gone';

/** A draft entry that made its recovered note now, or that an earlier apply made */
const DRAFT_RECOVERED = 'close-draft-recovered';

/** A draft entry saved into a note in the Trash */
const DRAFT_IN_TRASH = 'close-draft-saved-in-trash';

/**
 * How the drain replays each journaled command, by its type: as written, under its own key,
 * but an editor's save, which goes as the close-time draft its entry holds (#33's rules), or not
 * at all without one. A type this table lacks has no replay in this build.
 * @type {Readonly<Record<string, (command: Record<string, unknown>, entry: JournalRecord) => Command | null>>}
 */
const REPLAYS = Object.freeze({
  createNote: command => /** @type {Command} */ ({ ...command, type: 'createNote' }),
  insertBlocks: command => /** @type {Command} */ ({ ...command, type: 'insertBlocks' }),
  captureToDailyNote: command => /** @type {Command} */ ({ ...command, type: 'captureToDailyNote' }),
  saveNoteContent: (command, { opId, draft }) =>
    isCloseDraft(draft) ? { type: 'applyCloseDraft', commandId: `${opId}-apply`, draft } : null,
});

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
export async function drainJournal({ journal, client, lookup, liveOwners, own, clock, unreplayable, replayed }) {
  /** @type {DrainResult} */
  const result = {
    status: 'drained',
    code: null,
    replayed: 0,
    swept: 0,
    kept: 0,
    left: 0,
    recovered: [],
    savedInTrash: [],
    oldestOrphanedEntryAt: null,
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
   * Raises `entry`'s incident for `code` once, and keeps the code on the entry so a later drain
   * doesn't raise it again. Only an entry no live context holds is marked, so a mark never puts
   * back an entry its owner removed meanwhile.
   * @param {JournalRecord} entry
   * @param {string} code
   */
  const raise = async (entry, code) => {
    if (entry.unreplayable && entry.unreplayable.code === code) return;
    try {
      if (unreplayable) unreplayable(entry, code);
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
      result.status = 'stopped';
      result.code = outcome.code;
      return false;
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

    // 2. The replays, oldest first
    for (const entry of listed) {
      if (!isJournalRecord(entry)) {
        // Malformed: kept as a conflict record when it has a key to keep it under
        const opId = isRecord(entry) ? entry.opId : undefined;
        if (isId(opId) && !(await keep(/** @type {any} */ (entry), 'invalid-payload'))) break;
        continue;
      }
      if (gone.has(entry.opId) || entry.state !== 'submitted' || !orphaned(entry)) continue;
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
      const sent = command.commandId === entry.opId && replay ? replay(command, entry) : null;
      if (!sent) {
        if (!(await keep(entry, 'invalid-payload'))) break;
        continue;
      }
      const outcome = await client.execute(sent);
      if (outcome.kind === 'unavailable' || outcome.kind === 'unknown') {
        result.status = 'stopped';
        result.code = outcome.code;
        break;
      }
      if (outcome.kind === 'committed' && outcome.code === DRAFT_GONE) {
        await raise(entry, NOT_THERE);
        continue;
      }
      if (outcome.kind === 'rejected' && !ALREADY_IN.includes(outcome.code)) {
        if (outcome.code === NOT_THERE || outcome.reason === 'policy') await raise(entry, outcome.code);
        else if (!(await keep(entry, 'replay-refused'))) break;
        continue;
      }
      if (outcome.kind === 'committed' && outcome.code === DRAFT_RECOVERED && isId(outcome.changedIds[0])) {
        result.recovered.push({ id: outcome.changedIds[0], of: entry.noteId });
      }
      if (outcome.kind === 'committed' && outcome.code === DRAFT_IN_TRASH) result.savedInTrash.push(entry.noteId);
      await journal.remove([entry.opId]);
      gone.add(entry.opId);
      result.replayed += 1;
      try {
        if (replayed) replayed(entry);
      } catch {
        // Best effort, as unreplayable is
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
