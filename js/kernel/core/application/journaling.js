/**
 * A page's journaling (#35 slice 3b, the plan's item 9): the journaled commands a page sends,
 * each written to `NewTabNoteJournal` (domain/journal.js) in the task that sends it, just before
 * it, so a save still opens its transaction in its calling task (application/kernel.js), and the
 * coordinator's drain or the next page commits one this page didn't live to see answered.
 *
 * - The page holds Web Lock `journal.owner.<sessionId>` before its first entry, and for as long
 *   as it lives, so no drain or other page takes an entry of a page that's still open. Until it
 *   holds it, a command runs as it did before slice 3, unjournaled.
 * - A command the catalog journals gets an entry, unless its caller covered it: the closing save,
 *   whose close-time draft holds it under the same id (the plan's Q3). An editor save's entry
 *   holds its draft, in the close-time draft's format, and the pane that issued it.
 * - The entry goes once the command is committed, a conflict, or refused, and stays when it's
 *   unavailable or unanswered, for whoever replays it. Once a pane's save of a note commits, the
 *   pane's earlier entries for that note go too, since a pane's save carries everything the pane
 *   changed since its last commit within its load of the note (R182's S2). So does a covered
 *   save of the pane's, as its closing save, or one with nothing to keep since the pane's base.
 *   An editor's pane keeps its id on its base of the note, which each load makes anew, so no
 *   save takes an earlier load's entries, and the retry of a save written as the pane left the
 *   note names its save's pane id. A removal that fails is tried again with the next answer.
 * - A journal that can't take an entry leaves the command to run as before, and says so on the
 *   console, with the failure's code at most, and to `appendFailed` by the entry's note and the
 *   failure (#35 slice 4a), which the page's root journals as `journal.append-failed`. Nothing
 *   here throws into the page.
 * - A command that deletes notes for good takes their entries out of the journal once it's
 *   answered, whoever wrote them (`forget`), so a deleted note's text doesn't wait there for the
 *   next drain (the lead's call on 3b). The drain's sweep stays the retry, for a removal that
 *   fails and for a delete sent before the page's journal was in.
 *
 * Which entries closed pages left, and the drain's wake for them, are the journal chunk's start
 * (composition/journal-chunk.js). Nothing here touches a browser API: the ports come in.
 */

import { COMMANDS } from '../contracts/commands.js';
import { journalEntry, ownerLock } from '../domain/journal.js';

/** @typedef {import('../domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {import('../ports/journal.js').JournalStore} JournalStore */
/** @typedef {import('../contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/commands.js').PageCommandType} PageCommandType */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */

/**
 * The page's Web Locks: `request` for its owner lock, and `query` for the owners alive now
 * @typedef {object} JournalingLocks
 * @property {<T>(name: string, options: {mode: 'exclusive'}, callback: () => Promise<T>) => Promise<T>} request
 * @property {() => Promise<{held?: Array<{name?: string}>}>} [query]
 */

/**
 * What a caller tells the journaling of a command: `covered` when its own record holds it, as
 * the closing save's close-time draft does, an editor save's `draft`, and the `pane` that issued
 * an editor save, covered or not
 * @typedef {{covered?: boolean, draft?: CloseDraft, pane?: string}} JournalingOptions
 */

/**
 * @typedef {object} Journaling
 * @property {Promise<boolean>} ready - true once the owner lock is held, false when it can't be
 * @property {(command: Command, send: (command: Command) => Promise<Outcome | BulkOutcome>, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>} execute
 *   Writes `command`'s entry, then sends it with `send`, in the same task, and answers what the
 *   send does
 * @property {(noteIds: readonly string[]) => Promise<void>} forget - never rejects
 */

/** The answers that end a command for good, so its entry goes */
const ENDS = Object.freeze(['committed', 'conflict', 'rejected']);

/**
 * The commands whose commit covers the pane's earlier entries for the same note, by type: an
 * editor's save, which carries everything its pane changed since its last commit
 */
const PANE_SAVES = Object.freeze({ saveNoteContent: true });

/**
 * The codes of a committed command that deleted notes for good, whose changedIds are those notes,
 * as the new tab's root reads them for its close-time drafts (composition/newtab.js, NOTES_DELETED)
 */
const NOTES_DELETED = Object.freeze(['note-deleted', 'trash-emptied', 'trash-cleaned']);

/**
 * The notes `outcome` deleted for good, a bulk action's items included
 * @param {Outcome | BulkOutcome} outcome
 * @returns {string[]}
 */
const deletedBy = outcome => {
  if (outcome.kind === 'bulk') return outcome.items.flatMap(item => deletedBy(item.outcome));
  return outcome.kind === 'committed' && NOTES_DELETED.includes(outcome.code) ? outcome.changedIds : [];
};

/**
 * @param {{
 *   journal: JournalStore,
 *   locks: JournalingLocks | null,
 *   sessionId: string,
 *   surface: Surface,
 *   clock: {now(): number},
 *   warn?: (event: string, error: unknown) => void,
 *   appendFailed?: (noteId: string, error: unknown) => void,
 * }} options - `appendFailed` hears of each entry the journal couldn't take, by its note
 * @returns {Journaling}
 */
export function createJournaling({
  journal,
  locks,
  sessionId,
  surface,
  clock,
  warn = () => {},
  appendFailed = () => {},
}) {
  let held = false;
  let seq = 0;
  /** @type {Map<string, {noteId: string, pane: string | undefined, seq: number}>} this page's entries still in the journal */
  const own = new Map();
  /** @type {Set<string>} the entries whose removal failed, which the next answer removes */
  const unremoved = new Set();

  /** @type {Promise<boolean>} */
  const ready = new Promise(resolve => {
    try {
      if (!locks) {
        resolve(false);
        return;
      }
      Promise.resolve(
        locks.request(ownerLock(sessionId), { mode: 'exclusive' }, () => {
          held = true;
          resolve(true);
          // Held for as long as the page lives
          return new Promise(() => {});
        }),
      ).catch(() => resolve(false));
    } catch {
      resolve(false);
    }
  });

  /**
   * Removes `opIds`, and those an earlier removal couldn't, keeping any that fail for the next
   * @param {string[]} opIds
   */
  const remove = async opIds => {
    const going = [...new Set([...opIds, ...unremoved])];
    try {
      await journal.remove(going);
      for (const opId of going) {
        unremoved.delete(opId);
        own.delete(opId);
      }
    } catch (error) {
      for (const opId of going) unremoved.add(opId);
      warn('entry-not-removed', error);
    }
  };

  /**
   * The entries a pane's save of `noteId` covers once it commits: the pane's own for the note
   * that the page issued before `bound`, since the save carries everything the pane changed
   * since its last commit within its load of the note, kept or still out. A pane's id lasts one
   * load of the note, so they're that load's.
   * @param {string} type
   * @param {unknown} noteId
   * @param {string | undefined} pane
   * @param {number} bound - the seq of the first entry issued after the save
   * @returns {string[]}
   */
  const coveredBy = (type, noteId, pane, bound) => {
    /** @type {string[]} */
    const going = [];
    if (!Object.hasOwn(PANE_SAVES, type) || pane === undefined) return going;
    for (const [opId, other] of own) {
      if (other.pane === pane && other.noteId === noteId && other.seq < bound) going.push(opId);
    }
    return going;
  };

  /**
   * Removes the entries of `noteIds`, notes deleted for good, whoever wrote them
   * @param {readonly string[]} noteIds
   */
  const forget = async noteIds => {
    try {
      const deleted = new Set(noteIds);
      const going = (await journal.list()).filter(entry => deleted.has(entry.noteId)).map(entry => entry.opId);
      if (going.length > 0) await remove(going);
    } catch (error) {
      // The drain's sweep deletes them
      warn('entry-not-removed', error);
    }
  };

  return Object.freeze({
    ready,
    execute(command, send, { covered = false, draft, pane } = {}) {
      const type = /** @type {string} */ (command.type);
      const entry = Object.hasOwn(COMMANDS, type) ? COMMANDS[/** @type {PageCommandType} */ (type)] : null;
      const noteId = /** @type {{noteId?: unknown}} */ (command).noteId;
      if (!held || covered || !entry || !entry.journaled || typeof noteId !== 'string') {
        const answer = send(command);
        const bound = seq + 1;
        // A delete for good takes its notes' entries with it once it's answered, and a pane's
        // covered save that commits takes what it covers. The caller gets the answer as it came,
        // whatever the journal does.
        Promise.resolve(answer).then(
          outcome => {
            const deleted = deletedBy(outcome);
            if (deleted.length > 0) forget(deleted);
            const going = outcome.kind === 'committed' ? coveredBy(type, noteId, pane, bound) : [];
            if (going.length > 0) remove(going);
          },
          () => {},
        );
        return answer;
      }
      seq += 1;
      const record = journalEntry({
        command: /** @type {JournalRecord['command']} */ (/** @type {unknown} */ (command)),
        v: entry.version,
        noteId,
        surface,
        ownerSessionId: sessionId,
        seq,
        createdAt: clock.now(),
        draft,
        pane,
      });
      /** @type {Promise<void>} */
      let written;
      try {
        // Its transaction opens before anything is awaited, in the command's own task
        written = Promise.resolve(journal.put(record));
      } catch (error) {
        written = Promise.reject(error);
      }
      own.set(record.opId, { noteId, pane, seq });
      const answer = send(command);
      return (async () => {
        let kept = true;
        try {
          await written;
        } catch (error) {
          kept = false;
          own.delete(record.opId);
          warn('entry-not-written', error);
          try {
            appendFailed(noteId, error);
          } catch {
            // Best effort: nothing it throws reaches the page
          }
        }
        const outcome = await answer;
        if (!kept || !ENDS.includes(outcome.kind)) return outcome;
        const going = [record.opId, ...(outcome.kind === 'committed' ? coveredBy(type, noteId, pane, record.seq) : [])];
        await remove(going);
        return outcome;
      })();
    },
    forget,
  });
}
