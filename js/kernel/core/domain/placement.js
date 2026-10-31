/**
 * Where a note is listed, what it is, and where it is in its life (#17 PR 3a; #1's Placement):
 * the group of fields #17's transform derives from the flags 1.4.x stores, which the kernel's
 * commands keep in step beside those flags from PR 3 on.
 * - `placement`: #1's Placement, `{kind: 'inbox'}`, `{kind: 'collection', folderId}`, or
 *   `{kind: 'daily', dateKey}` with a local `YYYY-MM-DD` key (js/product/placement.js)
 * - `kind`: `note` or `template`, apart from `placement.kind`
 * - `lifecycle`: `active`, `archived`, or `trashed`
 *
 * The flags stay what every list reads until PR 4 (#17 PR 3, Q5), and every legacy field stays
 * (#17, "Compatibility"). Kernel core can't import js/product/, so placementGroupOf keeps #1's
 * placementOf rules, and test/kernel/placement.test.mjs holds the two to the same answer for
 * every combination of flags.
 */

/**
 * @typedef {{kind: 'inbox'} | {kind: 'collection', folderId: string | null} | {kind: 'daily', dateKey: string}} Placement
 * @typedef {'note' | 'template'} NoteKind
 * @typedef {'active' | 'archived' | 'trashed'} Lifecycle
 * @typedef {{placement: Placement, kind: NoteKind, lifecycle: Lifecycle}} PlacementGroup
 */

/**
 * The fields 1.4.x doesn't know, which #17 PR 3 adds to notes: the group (PR 3a), and a Daily
 * Note's key (PR 3b, domain/daily.js). A legacy path that writes notes from outside the kernel
 * (Settings' import), Export JSON, and a point's export drop them, so a trip through 1.4.x,
 * which keeps a field it doesn't know while it changes the flags, can't bring one back stale.
 */
export const PLACEMENT_FIELDS = Object.freeze(['placement', 'kind', 'lifecycle']);

/** A Daily Note's key, its zone, and the note that holds the key when another does (domain/daily.js) */
export const DAILY_FIELDS = Object.freeze(['dailyKey', 'dailyTimeZone', 'dailyDuplicateOf']);

/** Every field #17 PR 3 adds to a note */
export const NEW_NOTE_FIELDS = Object.freeze([...PLACEMENT_FIELDS, ...DAILY_FIELDS]);

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNTITLED = /^untitled\s*\d*$/;

/**
 * Whether a value is a YYYY-MM-DD key naming a real calendar date, as #1's isDateKey has it
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
 * #1's isNoteUntitled: no name, a blank one, or "Untitled" and an optional number, in any case.
 * A name that isn't a string counts as none.
 * @param {{name?: unknown}} note
 */
function untitled(note) {
  if (typeof note.name !== 'string') return true;
  const name = note.name.toLowerCase().trim();
  return name === '' || UNTITLED.test(name);
}

/**
 * @param {{isTemplate?: unknown}} note
 * @returns {NoteKind}
 */
export function kindOf(note) {
  return note.isTemplate ? 'template' : 'note';
}

/**
 * Trash before archive, as the sidebar lists a note that has both flags
 * @param {{trashed?: unknown, archived?: unknown}} note
 * @returns {Lifecycle}
 */
export function lifecycleOf(note) {
  if (note.trashed) return 'trashed';
  return note.archived ? 'archived' : 'active';
}

/**
 * Whether `value` is a Placement
 * @param {unknown} value
 * @returns {value is Placement}
 */
export function isPlacement(value) {
  if (!value || typeof value !== 'object') return false;
  const placement = /** @type {Record<string, unknown>} */ (value);
  if (placement.kind === 'inbox') return true;
  if (placement.kind === 'collection') return placement.folderId === null || typeof placement.folderId === 'string';
  return placement.kind === 'daily' && isDateKey(placement.dateKey);
}

/**
 * Whether `note` has its group: a placement, which #17's transform or a command wrote
 * @param {{placement?: unknown}} note
 */
export function hasPlacementGroup(note) {
  return isPlacement(note.placement);
}

/**
 * The group #17's transform first gives a note, by #1's placementOf rules, which win in this
 * order:
 * 1. a `folderId` naming a live folder: that collection, even for a Daily Note;
 * 2. `isDaily` with a valid `dateStr`: daily, `dateStr` as the key;
 * 3. a stale `folderId`: Unfiled;
 * 4. a root note: Inbox when it's untitled, else Unfiled, so the upgrade doesn't flood Inbox.
 * @param {Record<string, unknown>} note
 * @param {ReadonlySet<string>} liveFolderIds
 * @returns {PlacementGroup}
 */
export function placementGroupOf(note, liveFolderIds) {
  const dateKey = note.isDaily && isDateKey(note.dateStr) ? note.dateStr : null;
  const folderId = typeof note.folderId === 'string' && liveFolderIds.has(note.folderId) ? note.folderId : null;
  /** @type {Placement} */
  let placement;
  if (folderId !== null) placement = { kind: 'collection', folderId };
  else if (dateKey !== null) placement = { kind: 'daily', dateKey };
  else if (note.folderId || !untitled(note)) placement = { kind: 'collection', folderId: null };
  else placement = { kind: 'inbox' };
  return { placement, kind: kindOf(note), lifecycle: lifecycleOf(note) };
}

/**
 * What #1's placementOf finds on a note that its placement leaves as it is, as codes: a
 * `folderId` naming no live folder (`stale-folder`), and a Daily Note without a valid `dateStr`
 * (`daily-without-date`). #17's transform counts them in its receipt. The third, a Daily Note
 * keyed by its UTC date (`daily-utc-key`), is daily.js's utcKeyedLocalKey, which #17 PR 3b's
 * logical 3 re-keys by.
 * @param {Record<string, unknown>} note
 * @param {ReadonlySet<string>} liveFolderIds
 * @returns {Array<'daily-without-date' | 'stale-folder'>}
 */
export function placementFindingsOf(note, liveFolderIds) {
  /** @type {Array<'daily-without-date' | 'stale-folder'>} */
  const findings = [];
  if (note.isDaily && !isDateKey(note.dateStr)) findings.push('daily-without-date');
  const live = typeof note.folderId === 'string' && liveFolderIds.has(note.folderId);
  if (note.folderId && !live) findings.push('stale-folder');
  return findings;
}

/**
 * The placement a note's folder and daily state give it when a command sets them: its folder's
 * collection, which the command checked, else daily for a Daily Note, else Unfiled. Inbox is
 * Moment's to give (#2), so no command here puts a note there (#17 PR 3, Q3).
 * @param {Record<string, unknown>} note
 * @returns {Placement}
 */
function placementFor(note) {
  if (typeof note.folderId === 'string' && note.folderId !== '') return { kind: 'collection', folderId: note.folderId };
  if (note.isDaily && isDateKey(note.dateStr)) return { kind: 'daily', dateKey: note.dateStr };
  return { kind: 'collection', folderId: null };
}

/**
 * A note the kernel makes, with its group (#17 PR 3a)
 * @template {Record<string, unknown>} T
 * @param {T} note
 * @returns {T & PlacementGroup}
 */
export function withNewPlacement(note) {
  return { ...note, placement: placementFor(note), kind: kindOf(note), lifecycle: lifecycleOf(note) };
}

/**
 * `after`, what a placement command made of `before`, with its group kept in step: `kind` and
 * `lifecycle` from its flags, and its placement changed only when the command changed its
 * folder or its daily state, so the transform's Inbox or Unfiled stands. A note without its
 * group yet stays without it: #17's transform fills it, from the flags as they are then.
 * @template {Record<string, unknown>} T
 * @param {Record<string, unknown>} before
 * @param {T} after
 * @returns {T}
 */
export function withPlacementGroup(before, after) {
  if (!hasPlacementGroup(after)) return after;
  // A field a 1.4.x record lacks reads as the command's empty value, so a root note a command
  // sets `folderId: null` on hasn't moved
  const moved =
    (after.folderId || null) !== (before.folderId || null) ||
    Boolean(after.isDaily) !== Boolean(before.isDaily) ||
    (after.dateStr ?? null) !== (before.dateStr ?? null);
  return {
    ...after,
    placement: moved ? placementFor(after) : after.placement,
    kind: kindOf(after),
    lifecycle: lifecycleOf(after),
  };
}

/**
 * A note without its fields of #17 PR 3 (NEW_NOTE_FIELDS), as 1.4.x stores one
 * @template {Record<string, unknown>} T
 * @param {T} note
 * @returns {T}
 */
export function withoutPlacement(note) {
  const copy = { ...note };
  for (const field of NEW_NOTE_FIELDS) delete copy[field];
  return copy;
}
