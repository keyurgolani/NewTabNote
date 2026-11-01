/**
 * #17's conflict records (#17, "Merge"): what a command that lost to a newer version would
 * have written, kept in `conflicts` under its commandId, so a resend can't add a second one,
 * in the transaction that answers it `conflict` (adapter.js), which writes nothing else of it
 * but its ledger row. One the note has already, the same change sent again under a new
 * commandId, isn't kept again (R131). A remote change that replaced a 1.4.x note's text keeps
 * that text in one too, as a stale save's (application/remote.js). A record is
 * `{id, noteId, scope, expected, current, at, command}`: the
 * version the command expected and the one the note had, and the command itself, whose text
 * is the user's, kept by design so nothing typed is lost. It's the one new store that holds
 * note text (#17, "Security and privacy"). #6's conflict view reads it from #17 PR 4, and
 * deleting the note drops its records (#17 PR 2b).
 */

import { clone } from '../../core/contracts/clone.js';

/** @typedef {import('../../core/contracts/outcomes.js').Conflict} Conflict */
/** @typedef {import('../../core/ports/repository.js').Work} Work */

/**
 * A kept conflict
 * @typedef {object} ConflictRecord
 * @property {string} id - the commandId of the command that lost
 * @property {string | null} noteId
 * @property {'content' | 'placement' | 'derived'} scope
 * @property {number | null} expected - the version the command expected
 * @property {number} current - the version the note had: its content revision, or its placement version for `placement-conflict`
 * @property {number} at
 * @property {import('../../core/contracts/commands.js').Command} command
 */

/**
 * The record `work`'s conflict is kept as
 * @param {Work} work
 * @param {Conflict} outcome
 * @param {number} at
 * @returns {ConflictRecord}
 */
export function conflictRecord(work, outcome, at) {
  const primary = work.primary && work.primary();
  const fields = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (work.command));
  const expected = outcome.code === 'placement-conflict' ? fields.expectedPlacementVersion : fields.expectedRevision;
  return {
    id: work.commandId,
    noteId: primary && primary.store === 'notes' ? primary.key : null,
    scope: work.scope || 'content',
    expected: typeof expected === 'number' ? expected : null,
    current: outcome.currentRevision,
    at,
    command: clone(work.command),
  };
}
