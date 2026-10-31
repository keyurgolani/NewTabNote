/**
 * The user's side of a signal (#7, "Records and identity" and "One completion authority"):
 * which lifecycle actions each kind takes, what status a signal has once its decision and,
 * for a task, its block's `checked` are read together, the next decision a lifecycle commit
 * writes, and what a signal looks like once its corrections apply.
 *
 * An objective task has one completion authority, its todo block's `checked`. Its decision
 * never says `completed`: the signal mirrors the committed `checked`, and its status reads
 * from that. Completing an inferred signal writes only the decision.
 */

import { HISTORY_MAX, RECORD_VERSION } from './records.js';

/** @typedef {import('./records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('./records.js').SignalDecision} SignalDecision */
/** @typedef {import('./records.js').SignalCorrection} SignalCorrection */
/** @typedef {import('./records.js').DecisionStatus} DecisionStatus */
/** @typedef {import('./records.js').DismissReason} DismissReason */
/** @typedef {import('./records.js').Kind} Kind */
/** @typedef {import('./records.js').Category} Category */
/** @typedef {import('./records.js').TimeBasis} TimeBasis */
/** @typedef {import('./records.js').SourceRef} SourceRef */
/** @typedef {import('./records.js').HistoryEntry} HistoryEntry */
/** @typedef {import('./identity.js').Identity} Identity */

/** @typedef {'complete' | 'reopen' | 'dismiss' | 'snooze' | 'correct'} LifecycleAction */

/**
 * The lifecycle commands each kind takes (#7's action table). Reopen is every kind's, since
 * Undo issues it. A task has no Correct: "Edit in note" stands in for it.
 * @type {Readonly<Record<Kind, readonly LifecycleAction[]>>}
 */
export const LIFECYCLE_ACTIONS = Object.freeze({
  task: Object.freeze(/** @type {LifecycleAction[]} */ (['complete', 'reopen', 'snooze', 'dismiss'])),
  pin: Object.freeze(/** @type {LifecycleAction[]} */ (['reopen', 'snooze', 'dismiss'])),
  'inferred-task': Object.freeze(
    /** @type {LifecycleAction[]} */ (['complete', 'reopen', 'snooze', 'dismiss', 'correct']),
  ),
  'inferred-deadline': Object.freeze(
    /** @type {LifecycleAction[]} */ (['complete', 'reopen', 'snooze', 'dismiss', 'correct']),
  ),
  'inferred-reminder': Object.freeze(
    /** @type {LifecycleAction[]} */ (['complete', 'reopen', 'snooze', 'dismiss', 'correct']),
  ),
  'inferred-highlight': Object.freeze(/** @type {LifecycleAction[]} */ (['reopen', 'snooze', 'dismiss', 'correct'])),
  'inferred-resurface': Object.freeze(/** @type {LifecycleAction[]} */ (['reopen', 'snooze', 'dismiss', 'correct'])),
  connection: Object.freeze(/** @type {LifecycleAction[]} */ (['reopen', 'dismiss', 'correct'])),
});

/**
 * Whether `signal` is an objective task, whose completion is its block's `checked`
 * @param {IntelligenceSignal} signal
 */
export const isObjectiveTask = signal => signal.kind === 'task' && signal.provenance === 'objective';

/**
 * The status `signal` has now: an objective task's from its block's `checked`, then the
 * decision's, with a snooze that has ended read as active
 * @param {IntelligenceSignal} signal
 * @param {SignalDecision | null} decision
 * @param {number} now
 * @returns {DecisionStatus}
 */
export function effectiveStatus(signal, decision, now) {
  if (isObjectiveTask(signal) && signal.checked === true) return 'completed';
  if (!decision) return 'active';
  if (decision.status === 'snoozed' && /** @type {number} */ (decision.snoozedUntil) <= now) return 'active';
  return decision.status;
}

/**
 * What a lifecycle commit sets
 * @typedef {object} DecisionChange
 * @property {LifecycleAction | 'tombstone'} action
 * @property {DecisionStatus} status
 * @property {number | null} [snoozedUntil]
 * @property {DismissReason | null} [dismissReason]
 */

/**
 * The decision after `change`, one revision past `previous` (or the first, revision 1), with
 * the change at the end of its history and only the last HISTORY_MAX entries kept
 * @param {SignalDecision | null} previous
 * @param {DecisionChange} change
 * @param {{signalId: string, identity: Identity, now: number, commandId: string | null}} at
 * @returns {SignalDecision}
 */
export function nextDecision(previous, change, { signalId, identity, now, commandId }) {
  const decisionRevision = (previous?.decisionRevision ?? 0) + 1;
  const status = change.status;
  /** @type {HistoryEntry} */
  const entry = { decisionRevision, action: change.action, status, at: now, commandId };
  return {
    recordVersion: RECORD_VERSION,
    signalId,
    identity: { ...identity },
    status,
    snoozedUntil: status === 'snoozed' ? (change.snoozedUntil ?? null) : null,
    dismissReason: status === 'dismissed' ? (change.dismissReason ?? null) : null,
    completedAt: status === 'completed' ? (previous?.status === 'completed' ? previous.completedAt : now) : null,
    decisionRevision,
    updatedAt: now,
    history: [...(previous?.history ?? []), entry].slice(-HISTORY_MAX),
    tombstone: change.action === 'tombstone' ? { at: now, cause: 'anchor-deleted' } : (previous?.tombstone ?? null),
  };
}

/**
 * @param {SourceRef} source
 * @returns {string}
 */
export const sourceKey = source =>
  source.kind === 'block' ? `block ${source.noteId} ${source.blockId}` : `note ${source.noteId}`;

/**
 * The latest correction per field, in the order they were appended: the latest category, the
 * latest time basis, whether it's actionable, and each source's latest inclusion
 * @param {readonly SignalCorrection[]} corrections
 */
export function latestCorrections(corrections) {
  const ordered = [...corrections].sort((a, b) => a.at - b.at);
  /** @type {{category?: Category | null, time?: TimeBasis | null, actionable?: boolean, sources: Map<string, boolean>}} */
  const latest = { sources: new Map() };
  for (const { change } of ordered) {
    if (change.field === 'category') latest.category = change.after;
    else if (change.field === 'time') latest.time = change.after;
    else if (change.field === 'actionable') latest.actionable = change.after;
    else latest.sources.set(sourceKey(change.sourceRef), change.after);
  }
  return latest;
}

/**
 * What `signal` says once its corrections apply: the corrected category overrides the computed
 * one, the corrected time basis replaces its own, and a removed source drops out. A signal with
 * no correction is as stored.
 * @param {IntelligenceSignal} signal
 * @param {readonly SignalCorrection[]} corrections
 * @returns {{signal: IntelligenceSignal, categoryOverride: Category | null, corrected: boolean}}
 */
export function correctedSignal(signal, corrections) {
  const own = corrections.filter(correction => correction.signalId === signal.id);
  if (own.length === 0) return { signal, categoryOverride: null, corrected: false };
  const latest = latestCorrections(own);
  const sourceRefs = signal.sourceRefs.filter(source => latest.sources.get(sourceKey(source)) !== false);
  return {
    signal: {
      ...signal,
      time: latest.time !== undefined ? latest.time : signal.time,
      sourceRefs: sourceRefs.length > 0 ? sourceRefs : signal.sourceRefs,
    },
    categoryOverride: latest.category ?? null,
    corrected: true,
  };
}
