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
 *   changed since its last commit (R182's S2). A removal that fails is tried again with the next
 *   answer.
 * - A journal that can't take an entry leaves the command to run as before, and says so on the
 *   console, with the failure's code at most. Nothing here throws into the page.
 *
 * `forget` removes the entries of notes deleted for good, whoever wrote them, which the drain's
 * sweep does too, and `orphaned` says whether the journal holds an entry no live context holds,
 * for the page to wake the drain. Nothing here touches a browser API: the ports come in.
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
 * the closing save's close-time draft does, and an editor save's `draft` and `pane`
 * @typedef {{covered?: boolean, draft?: CloseDraft, pane?: string}} JournalingOptions
 */

/**
 * @typedef {object} Journaling
 * @property {Promise<boolean>} ready - true once the owner lock is held, false when it can't be
 * @property {(command: Command, send: (command: Command) => Promise<Outcome | BulkOutcome>, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>} execute
 *   Writes `command`'s entry, then sends it with `send`, in the same task, and answers what the
 *   send does
 * @property {(noteIds: readonly string[]) => Promise<void>} forget - never rejects
 * @property {() => Promise<boolean>} orphaned - never rejects; false when it can't tell
 */

/** The answers that end a command for good, so its entry goes */
const ENDS = Object.freeze(['committed', 'conflict', 'rejected']);

/**
 * The commands whose commit covers the pane's earlier entries for the same note, by type: an
 * editor's save, which carries everything its pane changed since its last commit
 */
const PANE_SAVES = Object.freeze({ saveNoteContent: true });

/**
 * @param {{
 *   journal: JournalStore,
 *   locks: JournalingLocks | null,
 *   sessionId: string,
 *   surface: Surface,
 *   clock: {now(): number},
 *   warn?: (event: string, error: unknown) => void,
 * }} options
 * @returns {Journaling}
 */
export function createJournaling({ journal, locks, sessionId, surface, clock, warn = () => {} }) {
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

  return Object.freeze({
    ready,
    execute(command, send, { covered = false, draft, pane } = {}) {
      const type = /** @type {string} */ (command.type);
      const entry = Object.hasOwn(COMMANDS, type) ? COMMANDS[/** @type {PageCommandType} */ (type)] : null;
      const noteId = /** @type {{noteId?: unknown}} */ (command).noteId;
      if (!held || covered || !entry || !entry.journaled || typeof noteId !== 'string') return send(command);
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
        }
        const outcome = await answer;
        if (!kept || !ENDS.includes(outcome.kind)) return outcome;
        /** @type {string[]} */
        const going = [record.opId];
        // A pane's committed save carries everything the pane changed since its last commit
        if (outcome.kind === 'committed' && Object.hasOwn(PANE_SAVES, type) && pane !== undefined) {
          for (const [opId, other] of own) {
            if (other.pane === pane && other.noteId === noteId && other.seq < seq) going.push(opId);
          }
        }
        await remove(going);
        return outcome;
      })();
    },
    async forget(noteIds) {
      try {
        const deleted = new Set(noteIds);
        const going = (await journal.list()).filter(entry => deleted.has(entry.noteId)).map(entry => entry.opId);
        if (going.length > 0) await remove(going);
      } catch (error) {
        // The drain's sweep deletes them
        warn('entry-not-removed', error);
      }
    },
    async orphaned() {
      try {
        if (!locks || typeof locks.query !== 'function') return false;
        const entries = await journal.list();
        const { held: holding = [] } = (await locks.query()) || {};
        const live = new Set(holding.map(lock => lock && lock.name));
        // This page's own are never orphaned: it holds their lock while it lives
        return entries.some(entry => !live.has(ownerLock(entry.ownerSessionId)));
      } catch {
        return false;
      }
    },
  });
}
