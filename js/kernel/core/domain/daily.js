/**
 * A Daily Note's key (#17 PR 3b; the plan's sections 1 to 3, Q1, Q2, Q4, Q7): the local date
 * it's found by, which the kernel writes beside 1.4.x's `isDaily` and `dateStr`
 * (placement.js's DAILY_FIELDS).
 * - `dailyKey`: the note's local `YYYY-MM-DD` date. A new or re-keyed Daily Note's `dateStr` is
 *   the same (Q2).
 * - `dailyTimeZone`: the IANA zone a new one's key was taken in, null for a 1.4.x note, whose
 *   zone is unknown (Q4)
 * - `dailyDuplicateOf`: the note that holds the key, on a Daily Note whose key another holds,
 *   else null. Every duplicate is kept, and the earliest made holds the key (Q7).
 *
 * 1.4.x keyed the Daily Note it made for "today" by the UTC date, and named it with the local
 * one, so from local midnight to UTC midnight "today" opened the wrong day's note: a capture
 * after about 5 PM in the Pacific landed in tomorrow's. #1's placementOf finds those notes (its
 * `daily-utc-key` finding), and #17 moves each to the local date its name gives, when no other
 * Daily Note holds that date (Q1). Kernel core can't import js/product/, so utcKeyedLocalKey
 * keeps #1's rule, and test/kernel/daily.test.mjs holds the two to the same answer.
 */

import { isDateKey, isPlacement } from './placement.js';

// ensureDailyNote's name, with the local date in en-US short form ("Daily Note - Jan 14, 2026")
const DAILY_NAME = /^Daily Note - (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The largest timestamp a Date holds
const MAX_TIME = 8.64e15;

/** @typedef {Record<string, unknown> & {id: string}} DailyRecord */

/** @type {Map<string, Intl.DateTimeFormat>} */
const FORMATS = new Map();

/**
 * A formatter of Gregorian dates in `zone`, made once per zone
 * @param {string} zone
 * @returns {Intl.DateTimeFormat}
 */
function formatIn(zone) {
  let format = FORMATS.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    FORMATS.set(zone, format);
  }
  return format;
}

/**
 * The local `YYYY-MM-DD` date of the instant `at` in the IANA zone `zone`: the key a Daily Note
 * is found by, as #1's localDateKey gives it in the host's zone
 * @param {number} at - ms since the epoch
 * @param {string} zone
 * @returns {string}
 */
export function localKeyIn(at, zone) {
  /** @type {Record<string, string>} */
  const part = {};
  for (const { type, value } of formatIn(zone).formatToParts(new Date(at))) part[type] = value;
  return `${part.year.padStart(4, '0')}-${part.month}-${part.day}`;
}

/**
 * The date in ensureDailyNote's name ("Daily Note - Jan 14, 2026") as a key, or null when the
 * note was renamed (#1's nameDateKey)
 * @param {unknown} name
 * @returns {string | null}
 */
function nameDateKey(name) {
  const match = typeof name === 'string' ? DAILY_NAME.exec(name) : null;
  if (match === null) return null;
  const month = MONTHS.indexOf(match[1].slice(0, 3)) + 1;
  const key = `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  return isDateKey(key) ? key : null;
}

/**
 * The local date of a Daily Note 1.4.x's ensureDailyNote keyed by a UTC date that wasn't the
 * local one, or null for any other note: #1's `daily-utc-key` finding. Such a note's `dateStr`
 * is the UTC date of its `createdAt`, and its local date is the one its untouched name gives,
 * else its `createdAt`'s in `zone`, which stands in for the zone it was made in.
 * @param {Record<string, unknown>} note
 * @param {string} zone
 * @returns {string | null}
 */
export function utcKeyedLocalKey(note, zone) {
  if (!note.isDaily || !isDateKey(note.dateStr)) return null;
  const { createdAt } = note;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || Math.abs(createdAt) > MAX_TIME) return null;
  if (new Date(createdAt).toISOString().slice(0, 10) !== note.dateStr) return null;
  const localKey = nameDateKey(note.name) || localKeyIn(createdAt, zone);
  return localKey === note.dateStr || !isDateKey(localKey) ? null : localKey;
}

/**
 * Whether a Daily Note can hold its key: 1.4.x never opened one in the trash or a template as a
 * day's Daily Note, so those get a key and hold none
 * @param {Record<string, unknown>} note
 */
export const canHoldKey = note => !note.trashed && !note.isTemplate;

/**
 * Whether logical 3 marked `note` as the duplicate of another note, which it keeps naming in
 * `dailyDuplicateOf`
 * @param {Record<string, unknown>} note
 */
const markedDuplicate = note => typeof note.dailyDuplicateOf === 'string' && note.dailyDuplicateOf !== note.id;

/**
 * Whether `note` holds `key`: a Daily Note with that key that can hold it, and isn't marked as
 * another's duplicate. A note the daily index names for `key` is the day's only while this is
 * true.
 * @param {Record<string, unknown> | undefined} note
 * @param {string} key
 */
export const holdsKey = (note, key) =>
  note !== undefined && Boolean(note.isDaily) && canHoldKey(note) && note.dailyKey === key && !markedDuplicate(note);

/**
 * Whether `a` was made before `b`, which decides who holds a key two claim: the earlier
 * `createdAt`, then the lower id. A note without a usable `createdAt` comes after every note
 * with one.
 * @param {DailyRecord} a
 * @param {DailyRecord} b
 */
export function madeBefore(a, b) {
  const time = (/** @type {DailyRecord} */ note) =>
    typeof note.createdAt === 'number' && Number.isFinite(note.createdAt) ? note.createdAt : Infinity;
  const diff = time(a) - time(b);
  if (diff !== 0 && !Number.isNaN(diff)) return diff < 0;
  return a.id < b.id;
}

/**
 * A Daily Note's key as #17 assigns it: the key, whether the note moved off its UTC `dateStr`
 * to its local date, and the note that holds the key when another does
 * @typedef {{dailyKey: string, rekeyed: boolean, duplicateOf: string | null}} DailyAssignment
 */

/**
 * @param {{note: DailyRecord}} a
 * @param {{note: DailyRecord}} b
 */
const inMadeOrder = (a, b) => (madeBefore(a.note, b.note) ? -1 : madeBefore(b.note, a.note) ? 1 : 0);

/**
 * Each Daily Note's key, by #17's rules, in two phases, so the answer doesn't depend on the
 * order the notes come in:
 * 1. Claims: a note with a `dailyKey` claims it, and one with a valid `dateStr` that 1.4.x
 *    didn't key by its UTC date (utcKeyedLocalKey) claims that. A key two claim goes to the
 *    earlier made (madeBefore, Q7).
 * 2. Re-keys, for each note 1.4.x keyed by its UTC date, earliest made first: every one whose
 *    local date no note holds moves there, and then each of the rest stays on its `dateStr`,
 *    where 1.4.x showed it, and holds it when no note does. Moves come first, so a note that
 *    stays never keeps a later one off its own date: someone who opened Daily every morning and
 *    evening has an evening note for each day, and one that stays on the next day's date would
 *    otherwise hold every later evening note where 1.4.x showed it.
 * A note in the trash or a template gets its key by the same rules, so it moves only to a date no
 * note holds (#1's contract), and holds none. A note logical 3 marked as another's duplicate
 * keeps its key and never counts as a claim: it holds its date only when, after the rest, no note
 * does, as when the note it names went to the trash. So a lookup keeps what the run decided, the
 * one exception to Q7 included, whether the run is done or a lookup comes between two of its
 * batches, with some notes keyed and some not. Every Daily Note whose key another holds names
 * that note as `duplicateOf`. One without a valid `dateStr` or `dailyKey` gets no key.
 * @param {Iterable<DailyRecord>} notes
 * @param {string} zone
 * @returns {Map<string, DailyAssignment>}
 */
export function assignDailyKeys(notes, zone) {
  /** @type {Array<{note: DailyRecord, key: string}>} */
  const claims = [];
  /** @type {Array<{note: DailyRecord, localKey: string}>} */
  const rekeys = [];
  /** @type {Array<{note: DailyRecord, key: string}>} */
  const duplicates = [];
  for (const note of notes) {
    if (!note.isDaily) continue;
    if (isDateKey(note.dailyKey)) (markedDuplicate(note) ? duplicates : claims).push({ note, key: note.dailyKey });
    else if (isDateKey(note.dateStr)) {
      const localKey = utcKeyedLocalKey(note, zone);
      if (localKey === null) claims.push({ note, key: note.dateStr });
      else rekeys.push({ note, localKey });
    }
  }
  claims.sort(inMadeOrder);
  rekeys.sort(inMadeOrder);
  duplicates.sort(inMadeOrder);

  /** @type {Map<string, DailyRecord>} */
  const holders = new Map();
  /** @type {Map<string, {dailyKey: string, rekeyed: boolean}>} */
  const keys = new Map();
  /**
   * @param {DailyRecord} note
   * @param {string} key
   */
  const claim = (note, key) => {
    const holder = holders.get(key);
    if (canHoldKey(note) && (holder === undefined || madeBefore(note, holder))) holders.set(key, note);
  };
  for (const { note, key } of claims) {
    keys.set(note.id, { dailyKey: key, rekeyed: false });
    claim(note, key);
  }
  /** @type {DailyRecord[]} */
  const stay = [];
  for (const { note, localKey } of rekeys) {
    if (holders.has(localKey)) {
      stay.push(note);
    } else {
      keys.set(note.id, { dailyKey: localKey, rekeyed: true });
      if (canHoldKey(note)) holders.set(localKey, note);
    }
  }
  for (const note of stay) {
    const dateStr = /** @type {string} */ (note.dateStr);
    keys.set(note.id, { dailyKey: dateStr, rekeyed: false });
    if (canHoldKey(note) && !holders.has(dateStr)) holders.set(dateStr, note);
  }
  for (const { note, key } of duplicates) {
    keys.set(note.id, { dailyKey: key, rekeyed: false });
    if (canHoldKey(note) && !holders.has(key)) holders.set(key, note);
  }

  /** @type {Map<string, DailyAssignment>} */
  const assigned = new Map();
  for (const [id, { dailyKey, rekeyed }] of keys) {
    const holder = holders.get(dailyKey);
    assigned.set(id, { dailyKey, rekeyed, duplicateOf: holder !== undefined && holder.id !== id ? holder.id : null });
  }
  return assigned;
}

/**
 * The note that holds `key` among `notes`, by assignDailyKeys, with its assignment, or undefined
 * when none does
 * @template {DailyRecord} T
 * @param {readonly T[]} notes - every stored note
 * @param {string} key
 * @param {string} zone
 * @returns {{note: T, assignment: DailyAssignment} | undefined}
 */
export function dailyHolder(notes, key, zone) {
  const assigned = assignDailyKeys(notes, zone);
  for (const note of notes) {
    const assignment = assigned.get(note.id);
    if (assignment && assignment.dailyKey === key && assignment.duplicateOf === null && canHoldKey(note)) {
      return { note, assignment };
    }
  }
  return undefined;
}

/**
 * `notes` as logical 3's kept answer will leave them, for a lookup between two of its batches
 * (#17 PR 4a, F10): each Daily Note the run read gets the key fields the answer gives it
 * (withAssignedKey), as its batch writes them, and every other note is as it is. A lookup over
 * them then finds the note it will find once the run is done. A note that changed since the run
 * read it, restored from the trash or renamed to another day, keeps the key the run gives it,
 * and a note a page made since claims its own, the earlier made holding a key both claim. A
 * note a command keyed to another day since the run read it keeps that key, as its batch leaves
 * it. With no answer, no run is going, and the notes are as they are.
 * @template {DailyRecord} T
 * @param {readonly T[]} notes
 * @param {ReadonlyMap<string, DailyAssignment> | null} answer
 * @returns {T[]}
 */
export function underAnswer(notes, answer) {
  if (!answer) return [...notes];
  return notes.map(note => {
    const assignment = answer.get(note.id);
    if (!assignment || !note.isDaily) return note;
    if (isDateKey(note.dailyKey) && note.dailyKey !== assignment.dailyKey) return note;
    return withAssignedKey(note, assignment);
  });
}

/**
 * `note` with the key `assignment` gives it, or `note` itself when it has it all: its
 * `dailyKey`, a `dailyTimeZone` (null for a 1.4.x note, Q4), and its `dailyDuplicateOf`. A note
 * that moved to its local date gets that date as `dateStr` (Q2), and as its daily placement's
 * date when it has one. Its name and blocks stay.
 * @template {Record<string, unknown>} T
 * @param {T} note
 * @param {DailyAssignment} assignment
 * @returns {T}
 */
export function withAssignedKey(note, { dailyKey, rekeyed, duplicateOf }) {
  /** @type {Record<string, unknown>} */
  const next = { ...note, dailyKey, dailyDuplicateOf: duplicateOf };
  if (typeof note.dailyTimeZone !== 'string') next.dailyTimeZone = null;
  if (rekeyed) {
    next.dateStr = dailyKey;
    const { placement } = note;
    if (isPlacement(placement) && placement.kind === 'daily') next.placement = { kind: 'daily', dateKey: dailyKey };
  }
  const placed = /** @type {{dateKey?: unknown} | undefined} */ (next.placement);
  const before = /** @type {{dateKey?: unknown} | undefined} */ (note.placement);
  const changed =
    note.dailyKey !== next.dailyKey ||
    note.dailyDuplicateOf !== next.dailyDuplicateOf ||
    note.dailyTimeZone !== next.dailyTimeZone ||
    note.dateStr !== next.dateStr ||
    placed?.dateKey !== before?.dateKey;
  return changed ? /** @type {T} */ (next) : note;
}
