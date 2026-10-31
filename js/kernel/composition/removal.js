/**
 * removeNotes (#12 slice 5): the one command every path that takes notes out of a new tab's
 * active set goes through, trash, archive, permanent delete, Empty trash, a bulk action, and
 * trash retention. It owns the order R0's #46 settled on, so no path copies it:
 *
 * 1. Leave. This tab's panes on the notes write what they have pending and move to other
 *    notes (TabController.leaveNotes). A pane with no other note to show waits on the note.
 * 2. Write, as one kernel command.
 * 3. Announce. Panes still on notes that left finish moving, to a new note when none is left;
 *    the other new tabs hear which notes left; and this tab's lists have the commit, from the
 *    commit feed, before the answer comes back.
 *
 * A write that doesn't commit leaves nothing half done: panes that moved go back where they
 * were, unless something moved them since, and no new note is made for them. The same goes for
 * the notes of a bulk action that failed, and a note Empty trash found restored elsewhere,
 * while the rest leave. A note another tab already deleted has left. The caller gets
 * the kernel's outcome and says what it means. Trash retention deletes what nobody asked to
 * delete just then, so it writes first and leaves after: a pane with unsaved text in an
 * expired note keeps it, with the editor's "Save as a new note".
 *
 * It lives here, not in kernel core, since it drives the page's panes and tabs through the
 * ports its root gives it. It reaches nothing else: no storage, no global.
 */

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../core/contracts/commands.js').BulkAction} BulkAction */

/**
 * What a leave did, so the rest of the sequence can finish it or undo it
 * @typedef {object} Departure
 * @property {(ids: readonly string[]) => Promise<unknown>} arrive
 *   The notes in `ids` left: panes still on them move, to a new note when there's no other
 * @property {(stayed: readonly string[]) => Promise<void>} restore
 *   The notes in `stayed` didn't leave: panes and tabs go back to where they were before the
 *   leave, when one of them showed such a note and nothing has moved them since. Notes that
 *   did leave then arrive from there.
 */

/**
 * What a page gives removeNotes: the pane and tab moves, the message to the other new tabs,
 * and when its lists have this tab's commits
 * @typedef {object} RemovalPorts
 * @property {(ids: readonly string[]) => Promise<Departure | null | undefined> | Departure | null | undefined} leave
 * @property {(ids: readonly string[]) => void} announce
 * @property {() => Promise<unknown>} [settled]
 * @property {{warn: (event: string, detail: Record<string, unknown>) => void}} [logger]
 *   Told when a pane move fails, with the ids and the error, never note content
 */

/**
 * What to take out of the active set
 * @typedef {{type: 'trashNote' | 'archiveNote' | 'deleteNotePermanently', noteId: string}
 *   | {type: 'emptyTrash', noteIds: readonly string[]}
 *   | {type: 'runBulkAction', action: BulkAction, noteIds: readonly string[]}
 *   | {type: 'runTrashCleanup'}} Removal
 *   Empty trash's `noteIds` are the notes in the trash as the page lists them, which leave first;
 *   the command deletes what's in the trash as committed.
 */

/** The bulk actions that take notes out of the active set */
export const LEAVING_ACTIONS = Object.freeze(/** @type {BulkAction[]} */ (['archive', 'trash', 'delete']));

/**
 * @typedef {object} NoteRemoval
 * @property {(removal: Removal) => Promise<Outcome | BulkOutcome>} removeNotes
 */

/**
 * Whether an outcome says the note was already gone, so it has left whatever the write did
 * @param {Outcome} outcome
 */
const alreadyGone = outcome => outcome.kind === 'rejected' && outcome.reason === 'not-found';

/**
 * Whether the outcome found note `id` already gone, deleted by another tab before the write
 * @param {Outcome | BulkOutcome} outcome
 * @param {string} id
 */
function goneBefore(outcome, id) {
  if (outcome.kind === 'bulk') return outcome.items.some(item => item.id === id && alreadyGone(item.outcome));
  return alreadyGone(outcome);
}

/**
 * The notes an outcome took out of the active set: the ones it committed, and the ones it
 * found already gone
 * @param {Outcome | BulkOutcome} outcome
 * @param {readonly string[]} leaving
 * @returns {string[]}
 */
function leftBy(outcome, leaving) {
  if (outcome.kind === 'bulk') {
    return outcome.items
      .filter(item => item.outcome.kind === 'committed' || alreadyGone(item.outcome))
      .map(item => item.id);
  }
  if (outcome.kind === 'committed') return [...new Set([...outcome.changedIds])];
  return alreadyGone(outcome) ? [...leaving] : [];
}

/**
 * @param {Client} client - the page's kernel client
 * @param {RemovalPorts} ports
 * @returns {NoteRemoval}
 */
export function createNoteRemoval(client, { leave, announce, settled = async () => {}, logger }) {
  /**
   * Run one of the page's pane steps. A failure there is reported and never stops the write
   * or its answer, as App.notesLeaving always had it.
   * @template T
   * @param {string} step
   * @param {readonly string[]} ids
   * @param {() => T | Promise<T>} run
   * @returns {Promise<T | null>}
   */
  const step = async (step, ids, run) => {
    try {
      return await run();
    } catch (error) {
      try {
        if (logger) logger.warn('pane-move-failed', { step, ids: [...ids], error });
      } catch {
        // A logger that throws changes nothing
      }
      return null;
    }
  };

  /**
   * The kernel command for `removal`, and the notes that leave before it runs
   * @param {Removal} removal
   * @returns {{command: Record<string, unknown>, leaving: readonly string[]}}
   */
  const planOf = removal => {
    const commandId = client.ids.next();
    switch (removal.type) {
      case 'emptyTrash':
        return { command: { type: 'emptyTrash', commandId }, leaving: removal.noteIds };
      case 'runBulkAction': {
        const { action, noteIds } = removal;
        return {
          command: { type: 'runBulkAction', commandId, action, noteIds: [...noteIds] },
          leaving: LEAVING_ACTIONS.includes(action) ? noteIds : [],
        };
      }
      case 'runTrashCleanup':
        return { command: { type: 'runTrashCleanup', commandId }, leaving: [] };
      default:
        return { command: { type: removal.type, commandId, noteId: removal.noteId }, leaving: [removal.noteId] };
    }
  };

  return Object.freeze({
    async removeNotes(removal) {
      const { command, leaving } = planOf(removal);
      const departure = leaving.length > 0 ? await step('leave', leaving, () => leave(leaving)) : null;
      const outcome = /** @type {Outcome | BulkOutcome} */ (
        await client.execute(/** @type {import('../core/contracts/commands.js').Command} */ (command))
      );
      // A bulk restore or unarchive brings notes in, so nothing leaves
      const cleanup = removal.type === 'runTrashCleanup';
      const left = leaving.length > 0 || cleanup ? leftBy(outcome, leaving) : [];
      // Notes that left the page's list for the trash but are still active: a bulk item that
      // failed, or a note Empty trash found restored by another tab
      const stayed = leaving.filter(id => !left.includes(id));
      if (departure) {
        // Panes that moved for a note that stayed go back first, then the ones on notes that
        // left move again, so the panes end as if only those had left
        if (stayed.length > 0) await step('restore', stayed, () => departure.restore(stayed));
        if (left.length > 0) await step('arrive', left, () => departure.arrive(left));
      } else if (cleanup && left.length > 0) {
        // Deleted first, so panes on them leave now, keeping any text they couldn't save
        await step('leave', left, async () => {
          const after = await leave(left);
          if (after) await after.arrive(left);
        });
      }
      // The other new tabs hear of the notes this write took out, not ones another tab had
      // already deleted, which that tab announced
      const taken = left.filter(id => !goneBefore(outcome, id));
      if (taken.length > 0) await step('announce', taken, () => announce(taken));
      await step('settle', left, () => settled());
      return outcome;
    },
  });
}
