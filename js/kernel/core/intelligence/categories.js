/**
 * Categories and time (#7, "Categories and time"). A signal stores a time basis, never a
 * computed category: where it goes is worked out when it's read, from an injected `now` and the
 * user's IANA time zone, with REPORT input 12's windows (Now 2 hours, Soon 7 days, Resurface
 * after 14 days with no block edit) until #15's tuning lands.
 *
 * - Now: overdue, or `dueAt` within the Now window.
 * - Today: due on the current local date.
 * - Soon: due within the Soon window. Due after it, a signal is still Soon, but inactive until
 *   its window opens (`activeFrom`, local midnight Soon-window days before it's due).
 * - Undated (tasks, pins, undated inferences): Today when its note is today's Daily Note,
 *   Resurface once no block in the note has been edited for the Resurface window, and Soon
 *   otherwise, after every dated Soon item (ranking.js). The last edit is the latest block
 *   edit, which the producer reads from #17's content commits, never the note's `updatedAt`.
 * - A stored category (a recipe's, or a Connection) and a corrected one stand as they are.
 *
 * A placement's reason is a rule code and its parameters, which the view model renders, and
 * its `validUntil` is the next instant it changes by time alone, so an open surface knows when
 * to read it again without the `alarms` permission.
 */

import { CATEGORIES } from './records.js';
import { correctedSignal, effectiveStatus } from './lifecycle.js';
import { addLocalDays, addLocalDaysToInstant, localDateOf, localDaysBetween, startOfLocalDay } from './time.js';

/** @typedef {import('./records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('./records.js').SignalDecision} SignalDecision */
/** @typedef {import('./records.js').SignalCorrection} SignalCorrection */
/** @typedef {import('./records.js').Category} Category */
/** @typedef {import('./records.js').DecisionStatus} DecisionStatus */

/**
 * The windows categories are computed with
 * @typedef {{nowMs: number, soonDays: number, resurfaceDays: number}} Windows
 */

/** REPORT input 12's defaults, which ship until the owner changes them */
export const DEFAULT_WINDOWS = Object.freeze({ nowMs: 2 * 60 * 60 * 1000, soonDays: 7, resurfaceDays: 14 });

/** The order categories rank in */
export const CATEGORY_ORDER = CATEGORIES;

/**
 * The rule that placed a signal, which the view model renders as its reason. `stored` is the
 * producer's own reason, used when no time rule applies.
 * @typedef {{code: 'overdue', date: string}
 *   | {code: 'due-within', at: number}
 *   | {code: 'due-today', at: number | null}
 *   | {code: 'due-on', date: string}
 *   | {code: 'daily-note'}
 *   | {code: 'not-edited', date: string}
 *   | {code: 'stored'}} Rule
 */

/**
 * Where a signal goes at one instant
 * @typedef {object} Placement
 * @property {Category} category
 * @property {Rule} rule
 * @property {DecisionStatus} status - its effective status (lifecycle.js)
 * @property {boolean} inWindow - false while it's due beyond the Soon window
 * @property {boolean} active - in an active list: active status, in its window, and neither
 *   suspended nor invalidated
 * @property {number | null} activeFrom - when it becomes active by time alone, or null when
 *   it is active, or no time will make it so
 * @property {number | null} validUntil - the next instant this placement changes by time alone
 * @property {boolean} corrected
 * @property {IntelligenceSignal} effective - the signal with its corrections applied
 */

/**
 * @typedef {object} PlaceOptions
 * @property {number} now
 * @property {string} timeZone - IANA
 * @property {Windows} [windows]
 */

/**
 * @param {IntelligenceSignal} signal
 * @param {Category | null} override
 * @param {number} now
 * @param {string} timeZone
 * @param {Windows} windows
 * @returns {{category: Category, rule: Rule, inWindow: boolean, activeFrom: number | null}}
 */
function placeByTime(signal, override, now, timeZone, windows) {
  const today = localDateOf(now, timeZone);
  const time = signal.time;
  const dated = time && (time.dueAt !== undefined || time.dueDate !== undefined);
  /** @type {{category: Category, rule: Rule, inWindow: boolean, activeFrom: number | null}} */
  let placed;
  if (dated) {
    const dueDate = time.dueAt !== undefined ? localDateOf(time.dueAt, timeZone) : /** @type {string} */ (time.dueDate);
    const days = localDaysBetween(today, dueDate);
    if (time.dueAt !== undefined && time.dueAt < now) {
      placed = { category: 'now', rule: { code: 'overdue', date: dueDate }, inWindow: true, activeFrom: null };
    } else if (time.dueAt === undefined && days < 0) {
      placed = { category: 'now', rule: { code: 'overdue', date: dueDate }, inWindow: true, activeFrom: null };
    } else if (time.dueAt !== undefined && time.dueAt - now <= windows.nowMs) {
      placed = { category: 'now', rule: { code: 'due-within', at: time.dueAt }, inWindow: true, activeFrom: null };
    } else if (days === 0) {
      placed = {
        category: 'today',
        rule: { code: 'due-today', at: time.dueAt ?? null },
        inWindow: true,
        activeFrom: null,
      };
    } else if (days <= windows.soonDays) {
      placed = { category: 'soon', rule: { code: 'due-on', date: dueDate }, inWindow: true, activeFrom: null };
    } else {
      placed = {
        category: 'soon',
        rule: { code: 'due-on', date: dueDate },
        inWindow: false,
        activeFrom: startOfLocalDay(addLocalDays(dueDate, -windows.soonDays), timeZone),
      };
    }
  } else if (signal.category !== null) {
    placed = { category: signal.category, rule: { code: 'stored' }, inWindow: true, activeFrom: null };
  } else if (signal.context.dailyNoteDate === today) {
    placed = { category: 'today', rule: { code: 'daily-note' }, inWindow: true, activeFrom: null };
  } else {
    const lastEditAt = signal.context.lastEditAt;
    const resurfaceAt =
      time?.resurfaceAt ??
      (lastEditAt === null ? null : addLocalDaysToInstant(lastEditAt, windows.resurfaceDays, timeZone));
    if (resurfaceAt !== null && now >= resurfaceAt) {
      placed = {
        category: 'resurface',
        rule:
          lastEditAt === null ? { code: 'stored' } : { code: 'not-edited', date: localDateOf(lastEditAt, timeZone) },
        inWindow: true,
        activeFrom: null,
      };
    } else {
      placed = { category: 'soon', rule: { code: 'stored' }, inWindow: true, activeFrom: null };
    }
  }
  if (override) return { ...placed, category: override, inWindow: true, activeFrom: null };
  if (signal.kind === 'connection') return { ...placed, category: 'connection', inWindow: true, activeFrom: null };
  return placed;
}

/**
 * The instants `signal`'s placement could change at by time alone, from `now` on
 * @param {IntelligenceSignal} signal
 * @param {SignalDecision | null} decision
 * @param {number} now
 * @param {string} timeZone
 * @param {Windows} windows
 * @returns {number[]}
 */
function boundaries(signal, decision, now, timeZone, windows) {
  /** @type {number[]} */
  const at = [];
  const time = signal.time;
  if (time?.dueAt !== undefined) {
    const dueDate = localDateOf(time.dueAt, timeZone);
    // Overdue starts just past dueAt, since a signal due at `now` is still within the window
    at.push(time.dueAt - windows.nowMs, time.dueAt + 1, startOfLocalDay(dueDate, timeZone));
    at.push(startOfLocalDay(addLocalDays(dueDate, -windows.soonDays), timeZone));
  } else if (time?.dueDate !== undefined) {
    at.push(startOfLocalDay(time.dueDate, timeZone), startOfLocalDay(addLocalDays(time.dueDate, 1), timeZone));
    at.push(startOfLocalDay(addLocalDays(time.dueDate, -windows.soonDays), timeZone));
  }
  if (time?.resurfaceAt !== undefined) at.push(time.resurfaceAt);
  if (signal.context.lastEditAt !== null) {
    at.push(addLocalDaysToInstant(signal.context.lastEditAt, windows.resurfaceDays, timeZone));
  }
  if (signal.context.dailyNoteDate !== null) {
    at.push(startOfLocalDay(signal.context.dailyNoteDate, timeZone));
    at.push(startOfLocalDay(addLocalDays(signal.context.dailyNoteDate, 1), timeZone));
  }
  if (decision?.status === 'snoozed' && decision.snoozedUntil !== null) at.push(decision.snoozedUntil);
  return [...new Set(at.filter(instant => instant > now))].sort((a, b) => a - b);
}

/**
 * @param {IntelligenceSignal} signal
 * @param {SignalDecision | null} decision
 * @param {readonly SignalCorrection[]} corrections
 * @param {PlaceOptions & {windows: Windows}} options
 */
function placeAt(signal, decision, corrections, { now, timeZone, windows }) {
  const { signal: effective, categoryOverride, corrected } = correctedSignal(signal, corrections);
  const placed = placeByTime(effective, categoryOverride, now, timeZone, windows);
  const status = effectiveStatus(signal, decision, now);
  const visible = signal.freshness.state !== 'suspended' && signal.freshness.state !== 'invalidated';
  let activeFrom = placed.activeFrom;
  if (status === 'snoozed') {
    const until = /** @type {number} */ (decision?.snoozedUntil);
    activeFrom = Math.max(until, activeFrom ?? until);
  } else if (status !== 'active') {
    activeFrom = null;
  }
  if (!visible) activeFrom = null;
  return {
    category: placed.category,
    rule: placed.rule,
    status,
    inWindow: placed.inWindow,
    active: visible && status === 'active' && placed.inWindow,
    activeFrom,
    corrected,
    effective,
  };
}

/**
 * Where `signal` goes at `now`, with its decision and corrections applied
 * @param {IntelligenceSignal} signal
 * @param {SignalDecision | null} decision
 * @param {readonly SignalCorrection[]} corrections
 * @param {PlaceOptions} options
 * @returns {Placement}
 */
export function placeSignal(signal, decision, corrections, { now, timeZone, windows = DEFAULT_WINDOWS }) {
  const here = placeAt(signal, decision, corrections, { now, timeZone, windows });
  const { effective } = here;
  let validUntil = null;
  for (const instant of boundaries(effective, decision, now, timeZone, windows)) {
    const there = placeAt(signal, decision, corrections, { now: instant, timeZone, windows });
    if (
      there.category !== here.category ||
      there.active !== here.active ||
      there.status !== here.status ||
      JSON.stringify(there.rule) !== JSON.stringify(here.rule)
    ) {
      validUntil = instant;
      break;
    }
  }
  return { ...here, validUntil };
}
