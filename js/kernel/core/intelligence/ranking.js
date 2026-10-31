/**
 * Ranking (#7, "Ranking"): a pure comparator over rank keys. Signals sort by category (Now,
 * Today, Soon, Resurface, Connection), then objective before inferred, then time basis (the
 * earliest due first, and undated after every dated one), then tasks in pinned notes, then the
 * latest block edit, the most recent first, and last by `id`, so the order is total and the
 * same on every surface. #36's priority and #8's rank hints slot in later, after provenance.
 */

import { CATEGORY_ORDER } from './categories.js';
import { startOfLocalDay } from './time.js';

/** @typedef {import('./categories.js').Placement} Placement */

/**
 * What a signal sorts by
 * @typedef {object} RankKey
 * @property {number} category - its category's place in CATEGORY_ORDER
 * @property {number} provenance - 0 objective, 1 inferred
 * @property {number} time - the instant it's due (a floating date's local midnight), or
 *   Infinity when undated
 * @property {number} pinnedTask - 0 for a task in a pinned note, else 1
 * @property {number} lastEditAt - the latest block edit, or -Infinity when unknown
 * @property {string} id
 */

/**
 * The rank key of a placed signal
 * @param {Placement} placement - from placeSignal, whose `effective` signal it ranks
 * @param {string} timeZone
 * @returns {RankKey}
 */
export function rankKeyOf(placement, timeZone) {
  const signal = placement.effective;
  const time = signal.time;
  let due = Infinity;
  if (time?.dueAt !== undefined) due = time.dueAt;
  else if (time?.dueDate !== undefined) due = startOfLocalDay(time.dueDate, timeZone);
  return {
    category: CATEGORY_ORDER.indexOf(placement.category),
    provenance: signal.provenance === 'objective' ? 0 : 1,
    time: due,
    pinnedTask: signal.kind === 'task' && signal.context.notePinned ? 0 : 1,
    lastEditAt: signal.context.lastEditAt ?? -Infinity,
    id: signal.id,
  };
}

/**
 * @param {number} a
 * @param {number} b
 */
const ascending = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Orders two rank keys: negative when `a` comes first
 * @param {RankKey} a
 * @param {RankKey} b
 * @returns {number}
 */
export function compareRankKeys(a, b) {
  return (
    ascending(a.category, b.category) ||
    ascending(a.provenance, b.provenance) ||
    ascending(a.time, b.time) ||
    ascending(a.pinnedTask, b.pinnedTask) ||
    ascending(b.lastEditAt, a.lastEditAt) ||
    (a.id === b.id ? 0 : a.id < b.id ? -1 : 1)
  );
}
