/**
 * Note placement and the two capture verbs (#1), as pure functions and contracts.
 * docs/product/continuity-canvas.md ("Placement and capture verbs") is the
 * contract. #17 (repositories) implements create and append atomically, and #2,
 * #3, #4, #5, and background capture call them.
 *
 * No I/O and no browser globals. Callers pass in the note and folder reads.
 */

import {
  fieldsIssue, invalid, isEntityId, isEntityIdOrNull, isOneOf, isRecord,
} from './validation.js';

/** @template T @typedef {import('./validation.js').Validation<T>} Validation */
/** @typedef {import('./topology.js').RouteId} RouteId */

/**
 * Where a note is listed. Filing changes placement, never identity. A collection
 * is a Projects collection, and folderId null is Unfiled, which sits under
 * Projects (open, Q2). dateKey is a local YYYY-MM-DD key.
 * @typedef {{kind: 'inbox'}
 *   | {kind: 'collection', folderId: string | null}
 *   | {kind: 'daily', dateKey: string}} Placement
 */

/**
 * The states kept apart from placement, as 1.4.0 keeps its flags
 * @typedef {object} NoteStates
 * @property {boolean} template
 * @property {boolean} archived
 * @property {boolean} trashed
 * @property {boolean} pinned
 */

/**
 * What #17's migration has to fix on a note: a folderId naming no live folder,
 * or an isDaily note with no usable dateStr
 * @typedef {{code: 'stale-folder'} | {code: 'daily-without-date'}} MigrationFinding
 */

/**
 * placementOf's answer for one note. dailyKey is a Daily Note's date, also when
 * a folder holds it, for #17's dailyKey. Both it and a daily placement's
 * dateKey copy 1.4.0's dateStr, a UTC date, which #17's migration re-keys to
 * the local date.
 * @typedef {object} NotePlacement
 * @property {Placement} placement
 * @property {NoteStates} states
 * @property {string | null} dailyKey
 * @property {MigrationFinding[]} findings
 */

/**
 * The 1.4.0 note fields placement reads
 * @typedef {object} LegacyNote
 * @property {unknown} [name]
 * @property {unknown} [folderId]
 * @property {unknown} [isDaily]
 * @property {unknown} [dateStr]
 * @property {unknown} [isTemplate]
 * @property {unknown} [archived]
 * @property {unknown} [trashed]
 * @property {unknown} [pinned]
 */

/**
 * The surface a capture comes from. Undo belongs to it: Moment's journaled
 * discardCapture (#2), and capture.undo for Popup and Side Panel (#4).
 * @typedef {'moment' | 'workspace' | 'popup' | 'side-panel' | 'background'} CaptureSurface
 */

/**
 * Create: a new note placed in a destination.
 *
 * - A Moment capture goes to Inbox. A Daily Note isn't created here: the append
 *   verb's daily target finds or creates it, so a date never gets two.
 * - Identity is allocated at the first meaningful input, so a create carries
 *   that input's blocks, and no surface creates an empty note ahead of input.
 * - An untitled capture still empty when its EditorSession ends, or a create
 *   undone in the creating surface, moves to Trash. It's never hard-deleted.
 * - Restoring it, or typing again in a restored tab, keeps the same ID.
 *
 * Blocks are #14's block records, opaque here.
 * @typedef {object} CreateRequest
 * @property {'create'} verb
 * @property {CaptureSurface} surface
 * @property {Placement} placement
 * @property {ReadonlyArray<Record<string, unknown>>} blocks
 */

/**
 * @typedef {object} CreateOutcome
 * @property {string} noteId the new note, which the creating surface's undo moves to Trash
 * @property {Placement} placement the request's placement
 */

/**
 * Append: the blocks of one capture added to an existing note, or to the Daily
 * Note for a local date key, found or created, in one transaction.
 *
 * - The target's ID and placement never change.
 * - Undo in the appending surface removes exactly the blocks of that append.
 * - An open target receives the append as an external operation (#6).
 *
 * @typedef {{kind: 'note', noteId: string} | {kind: 'daily', dateKey: string}} AppendTarget
 * @typedef {object} AppendRequest
 * @property {'append'} verb
 * @property {CaptureSurface} surface
 * @property {AppendTarget} target today's localDateKey for context-menu and command captures
 * @property {ReadonlyArray<Record<string, unknown>>} blocks
 */

/**
 * @typedef {object} AppendOutcome
 * @property {string} noteId the target note, or the Daily Note found or created
 * @property {boolean} createdTarget whether the transaction created that Daily Note
 * @property {string[]} blockIds the appended blocks in order, which undo removes and nothing else
 */

/** @type {ReadonlyArray<CaptureSurface>} */
export const CAPTURE_SURFACES = Object.freeze(['moment', 'workspace', 'popup', 'side-panel', 'background']);

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNTITLED = /^untitled\s*\d*$/;
const CREATE_FIELDS = Object.freeze(['verb', 'surface', 'placement', 'blocks']);
const APPEND_FIELDS = Object.freeze(['verb', 'surface', 'target', 'blocks']);

// ============ Placement ============

/**
 * Whether a value is a YYYY-MM-DD key naming a real calendar date
 * @param {unknown} value
 * @returns {value is string}
 */
export function isDateKey(value) {
  const match = typeof value === 'string' ? DATE_KEY.exec(value) : null;
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

/**
 * The local YYYY-MM-DD key for a moment in time, the key a Daily Note is found
 * by. 1.4.0 used the UTC date (toISOString), which names the wrong day near
 * midnight away from UTC.
 * @param {Date | number} when a Date or ms since the epoch
 * @returns {string}
 */
export function localDateKey(when) {
  const date = typeof when === 'number' ? new Date(when) : when;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('localDateKey: needs a valid date');
  const pad = (/** @type {number} */ value, /** @type {number} */ width) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/**
 * 1.4.0's isNoteUntitled rule: no name, a blank one, or "Untitled" and an
 * optional number, in any case. A name that isn't a string counts as none.
 * @param {{name?: unknown} | null | undefined} note
 * @returns {boolean}
 */
export function isNoteUntitled(note) {
  if (!note || typeof note.name !== 'string') return true;
  const name = note.name.toLowerCase().trim();
  return name === '' || UNTITLED.test(name);
}

/**
 * Where a 1.4.0 note is listed, plus the states kept apart from placement
 * (AC7). The first rule that applies wins:
 *
 * 1. A folderId naming a live folder: that collection, even for a Daily Note,
 *    which keeps its date as dailyKey.
 * 2. isDaily with a dateStr: daily, dateStr copied as dateKey.
 * 3. A stale folderId: Unfiled.
 * 4. A root note: Inbox when it's untitled, else Unfiled, so the upgrade
 *    doesn't flood Inbox.
 *
 * A stale folderId, which 1.4.0's sidebar never shows, gives a `stale-folder`
 * finding whatever the placement. Templates take placement like any note, and
 * Inbox and Projects views leave them out, as getAllNotes does.
 * @param {LegacyNote} note
 * @param {Iterable<string>} liveFolderIds the IDs in the folders store
 * @returns {NotePlacement}
 */
export function placementOf(note, liveFolderIds) {
  const live = liveFolderIds instanceof Set ? liveFolderIds : new Set(liveFolderIds);
  /** @type {MigrationFinding[]} */
  const findings = [];

  const dailyKey = note.isDaily && isDateKey(note.dateStr) ? note.dateStr : null;
  if (note.isDaily && dailyKey === null) findings.push({ code: 'daily-without-date' });

  // 1.4.0 files a note in a folder when folderId is truthy, as the sidebar does
  const filed = Boolean(note.folderId);
  const liveFolderId = typeof note.folderId === 'string' && live.has(note.folderId) ? note.folderId : null;
  if (filed && liveFolderId === null) findings.push({ code: 'stale-folder' });

  /** @type {Placement} */
  let placement;
  if (liveFolderId !== null) placement = { kind: 'collection', folderId: liveFolderId };
  else if (dailyKey !== null) placement = { kind: 'daily', dateKey: dailyKey };
  else if (filed || !isNoteUntitled(note)) placement = { kind: 'collection', folderId: null };
  else placement = { kind: 'inbox' };

  return {
    placement,
    states: {
      template: Boolean(note.isTemplate),
      archived: Boolean(note.archived),
      trashed: Boolean(note.trashed),
      pinned: Boolean(note.pinned),
    },
    dailyKey,
    findings,
  };
}

/**
 * The collection a note opens in: Trash, Archive, or Templates for those
 * states, else its placement's (rule 7's home collection, for homeRoute)
 * @param {{placement: Placement, states: NoteStates}} note
 * @returns {RouteId}
 */
export function homeRouteOf({ placement, states }) {
  if (states.trashed) return 'trash';
  if (states.archived) return 'archive';
  if (states.template) return 'templates';
  if (placement.kind === 'inbox') return 'inbox';
  if (placement.kind === 'daily') return 'daily';
  return 'projects';
}

/**
 * Check a Placement, and return a copy
 * @param {unknown} value
 * @returns {Validation<Placement>}
 */
export function validatePlacement(value) {
  if (!isRecord(value)) return invalid('placement is not an object');
  const { kind } = value;
  if (kind !== 'inbox' && kind !== 'collection' && kind !== 'daily') return invalid('placement kind is unknown');
  const fields = kind === 'inbox' ? ['kind'] : kind === 'collection' ? ['kind', 'folderId'] : ['kind', 'dateKey'];
  const issue = fieldsIssue(value, fields);
  if (issue !== null) return invalid(`placement has ${issue}`);

  if (kind === 'inbox') return { ok: true, value: { kind } };
  if (kind === 'collection') {
    const { folderId } = value;
    if (!isEntityIdOrNull(folderId)) return invalid('placement folderId is not a folder ID or null');
    return { ok: true, value: { kind, folderId } };
  }
  const { dateKey } = value;
  if (!isDateKey(dateKey)) return invalid('placement dateKey is not a YYYY-MM-DD date');
  return { ok: true, value: { kind, dateKey } };
}

/**
 * @param {Placement} a
 * @param {Placement} b
 * @returns {boolean}
 */
function samePlacement(a, b) {
  if (a.kind === 'collection') return b.kind === 'collection' && a.folderId === b.folderId;
  if (a.kind === 'daily') return b.kind === 'daily' && a.dateKey === b.dateKey;
  return b.kind === 'inbox';
}

// ============ Capture verbs ============

/**
 * Check a create request (CreateRequest has the contract), and return a copy
 * that keeps the block records
 * @param {unknown} value
 * @returns {Validation<CreateRequest>}
 */
export function validateCreateRequest(value) {
  if (!isRecord(value)) return invalid('create request is not an object');
  const issue = fieldsIssue(value, CREATE_FIELDS);
  if (issue !== null) return invalid(`create request has ${issue}`);
  if (value.verb !== 'create') return invalid('create request verb is not "create"');
  const { surface } = value;
  if (!isOneOf(CAPTURE_SURFACES, surface)) return invalid('create request surface is unknown');

  const placement = validatePlacement(value.placement);
  if (placement.ok === false) return invalid(`create request ${placement.reason}`);
  if (placement.value.kind === 'daily') {
    return invalid('create request places a note in Daily, which only an append to a daily target does');
  }
  if (surface === 'moment' && placement.value.kind !== 'inbox') return invalid('a Moment capture is created in Inbox');

  const blocks = checkBlocks(value.blocks);
  if (blocks.ok === false) return invalid(`create request ${blocks.reason}`);
  return { ok: true, value: { verb: 'create', surface, placement: placement.value, blocks: blocks.value } };
}

/**
 * Check what a create returned against its request
 * @param {CreateRequest} request
 * @param {unknown} outcome
 * @returns {Validation<CreateOutcome>}
 */
export function validateCreateOutcome(request, outcome) {
  if (!isRecord(outcome)) return invalid('create outcome is not an object');
  const issue = fieldsIssue(outcome, ['noteId', 'placement']);
  if (issue !== null) return invalid(`create outcome has ${issue}`);
  const { noteId } = outcome;
  if (!isEntityId(noteId)) return invalid('create outcome noteId is not a note ID');
  const placement = validatePlacement(outcome.placement);
  if (placement.ok === false) return invalid(`create outcome ${placement.reason}`);
  if (!samePlacement(placement.value, request.placement)) return invalid('create outcome placement isn\'t the request\'s');
  return { ok: true, value: { noteId, placement: placement.value } };
}

/**
 * Check an append request (AppendRequest has the contract), and return a copy
 * that keeps the block records
 * @param {unknown} value
 * @returns {Validation<AppendRequest>}
 */
export function validateAppendRequest(value) {
  if (!isRecord(value)) return invalid('append request is not an object');
  const issue = fieldsIssue(value, APPEND_FIELDS);
  if (issue !== null) return invalid(`append request has ${issue}`);
  if (value.verb !== 'append') return invalid('append request verb is not "append"');
  const { surface } = value;
  if (!isOneOf(CAPTURE_SURFACES, surface)) return invalid('append request surface is unknown');

  const target = checkAppendTarget(value.target);
  if (target.ok === false) return invalid(`append request ${target.reason}`);
  const blocks = checkBlocks(value.blocks);
  if (blocks.ok === false) return invalid(`append request ${blocks.reason}`);
  return { ok: true, value: { verb: 'append', surface, target: target.value, blocks: blocks.value } };
}

/**
 * Check what an append returned against its request: a note target keeps its
 * ID and creates nothing, and blockIds names each appended block once
 * @param {AppendRequest} request
 * @param {unknown} outcome
 * @returns {Validation<AppendOutcome>}
 */
export function validateAppendOutcome(request, outcome) {
  if (!isRecord(outcome)) return invalid('append outcome is not an object');
  const issue = fieldsIssue(outcome, ['noteId', 'createdTarget', 'blockIds']);
  if (issue !== null) return invalid(`append outcome has ${issue}`);
  const { noteId, createdTarget, blockIds } = outcome;
  if (!isEntityId(noteId)) return invalid('append outcome noteId is not a note ID');
  if (typeof createdTarget !== 'boolean') return invalid('append outcome createdTarget is not a boolean');
  if (request.target.kind === 'note' && (noteId !== request.target.noteId || createdTarget)) {
    return invalid('an append to a note keeps that note\'s ID and creates no note');
  }
  if (!Array.isArray(blockIds) || !blockIds.every(isEntityId) || new Set(blockIds).size !== blockIds.length) {
    return invalid('append outcome blockIds is not a list of distinct block IDs');
  }
  if (blockIds.length !== request.blocks.length) return invalid('append outcome blockIds doesn\'t match the appended blocks');
  return { ok: true, value: { noteId, createdTarget, blockIds: [...blockIds] } };
}

/**
 * @param {unknown} value
 * @returns {Validation<AppendTarget>}
 */
function checkAppendTarget(value) {
  if (!isRecord(value)) return invalid('target is not an object');
  if (value.kind === 'note') {
    const { noteId } = value;
    if (fieldsIssue(value, ['kind', 'noteId']) !== null || !isEntityId(noteId)) return invalid('note target is malformed');
    return { ok: true, value: { kind: 'note', noteId } };
  }
  if (value.kind === 'daily') {
    const { dateKey } = value;
    if (fieldsIssue(value, ['kind', 'dateKey']) !== null || !isDateKey(dateKey)) return invalid('daily target is malformed');
    return { ok: true, value: { kind: 'daily', dateKey } };
  }
  return invalid('target kind is not note or daily');
}

/**
 * @param {unknown} value
 * @returns {Validation<Array<Record<string, unknown>>>}
 */
function checkBlocks(value) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) {
    return invalid('blocks is not a non-empty list of block records');
  }
  return { ok: true, value: [...value] };
}
