/**
 * The journal's entries and names (#35 slice 3, "The journal"): what a context writes to
 * `NewTabNoteJournal` before it sends a journaled command, so a command its context didn't
 * live to see answered commits once the coordinator drains it (application/journal-drain.js).
 * Nothing here reads a store or a browser API.
 *
 * An entry is `{opId, v, command, noteId, draft?, pane?, seq, surface, createdAt,
 * ownerSessionId, state, unreplayable?}`:
 * - `opId` is the command's commandId, the entry's key, which the replay sends again, so #17's
 *   ledger answers a command that committed already with its outcome and runs nothing twice.
 * - `v` and `command` are #13's journal entry (ports/journal.js): the catalog version of the
 *   command as it was written, which contracts/upcast.js takes to the current one, and the
 *   command as its context sent it.
 * - `noteId` is the note it writes: a capture's is the id its Daily Note gets if it makes one.
 * - `draft` is an editor save's edit in the close-time draft's format (domain/close-draft.js),
 *   which the drain applies by #33's rules, the lead's answer to the plan's Q1: dropped when the
 *   note holds it already, saved where its blocks are as the editor saw them, and one recovered
 *   note where another writer changed them since. `pane` is the editor pane that issued it.
 * - `seq` counts up within its writer's session, so entries written in one millisecond keep
 *   their order.
 * - `surface` is the #13 surface that sent it, and `ownerSessionId` its session: the page's
 *   client's, or the coordinator's instance id for the worker's own captures. A live owner holds
 *   Web Lock `journal.owner.<ownerSessionId>`, and the drain leaves its entries alone.
 * - `state` is `submitted` for a command sent, which the drain commits, or `draft` for input
 *   not yet sent (#2's), which it never does.
 * - `unreplayable` is set once the drain has raised its incident: `{code, at}`. Before that, it's
 *   `{code, at, count}` while the drain counts the drains in a row that stopped at the entry on a
 *   code it can retry, the third of which raises it (slice 3b).
 *
 * An entry holds what the user wrote, as a close-time draft and a conflict record do. It's
 * session state: never in a backup, an export, sync, or diagnostics, and it's deleted once its
 * command is answered, or its note is deleted for good.
 */

import { isId, isRecord } from '../contracts/checks.js';

/** @typedef {import('../contracts/surfaces.js').Surface} Surface */
/** @typedef {import('./close-draft.js').CloseDraft} CloseDraft */

/**
 * @typedef {object} JournalRecord
 * @property {string} opId
 * @property {number} v
 * @property {{type: string, commandId: string} & Record<string, unknown>} command
 * @property {string} noteId
 * @property {CloseDraft} [draft]
 * @property {string} [pane]
 * @property {number} seq
 * @property {Surface} surface
 * @property {number} createdAt
 * @property {string} ownerSessionId
 * @property {'draft' | 'submitted'} state
 * @property {{code: string, at: number, count?: number}} [unreplayable]
 */

/** The Web Lock the drain holds while it replays, which #2's Moment and #13's resume take too */
export const REPLAY_LOCK = 'journal.replay';

/**
 * What a page sends to wake the service worker to drain the journal (#35 slice 3, the lead's
 * answer to the plan's Q4), as `storage.purge` wakes it to purge: it carries nothing, and the
 * worker answers with counts and codes only
 */
export const DRAIN_MESSAGE = 'journal.drain';

/** The start of each owner's Web Lock */
export const OWNER_LOCK_PREFIX = 'journal.owner.';

/**
 * The Web Lock a live owner holds
 * @param {string} sessionId
 * @returns {string}
 */
export const ownerLock = sessionId => `${OWNER_LOCK_PREFIX}${sessionId}`;

/**
 * The tombstone reasons the drain's sweep deletes a note's entries for: each a permanent
 * deletion (domain/tombstone.js). An entry under any other reason, as #20's restore and reset
 * will write, is kept, and its incident raised.
 */
export const SWEPT_REASONS = Object.freeze(['deleted', 'trash-emptied', 'trash-expired', 'empty-note']);

/**
 * A `submitted` entry for `command`, as its context writes it before the send
 * @param {{
 *   command: JournalRecord['command'],
 *   v: number,
 *   noteId: string,
 *   surface: Surface,
 *   ownerSessionId: string,
 *   seq: number,
 *   createdAt: number,
 *   draft?: CloseDraft,
 *   pane?: string,
 * }} fields
 * @returns {JournalRecord}
 */
export function journalEntry({ command, v, noteId, surface, ownerSessionId, seq, createdAt, draft, pane }) {
  /** @type {JournalRecord} */
  const entry = {
    opId: command.commandId,
    v,
    command,
    noteId,
    seq,
    surface,
    createdAt,
    ownerSessionId,
    state: 'submitted',
  };
  if (draft !== undefined) entry.draft = draft;
  if (pane !== undefined) entry.pane = pane;
  return entry;
}

/**
 * Whether `value` has what the drain reads of an entry: its key, owner, state, and times. One
 * without them is malformed, whatever its command holds.
 * @param {unknown} value
 * @returns {value is JournalRecord}
 */
export function isJournalRecord(value) {
  if (!isRecord(value) || !isId(value.opId) || !isId(value.ownerSessionId)) return false;
  if (value.state !== 'submitted' && value.state !== 'draft') return false;
  return Number.isFinite(value.createdAt) && Number.isFinite(value.seq);
}

/**
 * `entries` oldest first: by when each was written, then by its writer's count, then by key,
 * so every drain reads them in one order
 * @template {{createdAt: number, seq: number, opId: string}} T
 * @param {readonly T[]} entries
 * @returns {T[]}
 */
export function inJournalOrder(entries) {
  return [...entries].sort(
    (a, b) => a.createdAt - b.createdAt || a.seq - b.seq || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0),
  );
}
