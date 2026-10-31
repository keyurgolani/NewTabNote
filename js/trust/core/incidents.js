/**
 * What happens to an incident (#20, "Contracts"; "Required states"): a sighting (raise), a
 * passing check (resolve), and a dismissal or undismissal, each an operation with a time, and
 * one pure reducer that applies an operation to the stored record.
 *
 * Every direct write runs its operation through the reducer inside the transaction that
 * writes it, so it's ordered by that transaction, not the wall clock: directAt() moves its
 * time to no earlier than what the record already holds (a resolution or a dismissal one
 * millisecond past the latest sighting, since it was decided after it), so a clock that steps
 * back, or two writes in one millisecond, can't put a later write behind an earlier one.
 *
 * Timestamps decide between a held storage sighting being replayed and what the record holds
 * (trust-records.js holds only those):
 * - A sighting adds its occurrences. One at or after `resolvedAt` reopens a resolved incident
 *   (a tie goes to the sighting); an older one leaves it resolved. One at or after the latest
 *   sighting brings its capabilities and evidence; an older one doesn't. While the incident is
 *   open its severity is the worse of the two, since a milder sighting doesn't make an open
 *   fault milder; a reopened one takes the sighting's. One at or after the last dismiss change
 *   clears a dismissal. A remediating incident stays remediating.
 * - A resolution applies only if it's later than every sighting.
 * - A dismissal or undismissal applies only if it's later than every sighting and than the
 *   last dismiss change (`dismissChangedAt`), so an older one replayed late changes nothing.
 * A replayed sighting records its id and count in the incident's `appliedOps`. One already
 * there adds nothing, and one that supersedes it (a later version of the same held sighting,
 * whose count includes it) adds only the difference.
 */

import * as v from '../../lib/valibot/index.mjs';
import { count, timestamp } from '../../kernel/core/contracts/fields.js';
import { evidenceSchema, faultCode, providerId, recordId, subjectId } from './evidence.js';
import { capabilities, incidentKey, incidentKeySchema, refOf, worseSeverity } from './records.js';
import { SEVERITIES } from './vocabulary.js';

/** @typedef {import('./records.js').Incident} Incident */

/**
 * How many replayed sightings an incident remembers. Only held storage sightings are
 * replayed: one per key in each context's memory and one in the settings copy, each
 * superseding at most SUPERSEDES before it, so this covers every one that can still arrive.
 */
export const APPLIED_OPS = 64;

/** How many earlier versions a held sighting names as superseded */
export const SUPERSEDES = 8;

/** What a sighting reports */
export const sightingSchema = v.strictObject({
  providerId,
  faultCode,
  subjectId: v.nullable(subjectId),
  severity: v.picklist(SEVERITIES),
  affected: capabilities,
  preserved: capabilities,
  evidence: evidenceSchema,
});

/** @typedef {v.InferOutput<typeof sightingSchema>} Sighting */

/**
 * A sighting as an operation: `count` occurrences, the latest at `at`. `incidentId` is the id
 * it gives an incident it creates, and `supersedes` names the held versions of it, newest
 * first, whose occurrences its count includes.
 */
export const raiseOpSchema = v.strictObject({
  opId: recordId,
  kind: v.literal('raise'),
  at: timestamp,
  key: incidentKeySchema,
  incidentId: recordId,
  sighting: sightingSchema,
  count: v.pipe(count, v.minValue(1)),
  supersedes: v.pipe(v.array(recordId), v.maxLength(SUPERSEDES)),
});

/** @typedef {v.InferOutput<typeof raiseOpSchema>} RaiseOp */
/** @typedef {{opId: string, kind: 'resolve', at: number, key: string}} ResolveOp */
/** @typedef {{opId: string, kind: 'dismiss', at: number, key: string, dismissed: boolean}} DismissOp */
/** @typedef {RaiseOp | ResolveOp | DismissOp} IncidentOp */

/**
 * One sighting as an operation, at `at`
 * @param {{next(): string}} ids
 * @param {Sighting} sighting
 * @param {number} at
 * @returns {RaiseOp}
 */
export function raiseOp(ids, sighting, at) {
  return {
    opId: ids.next(),
    kind: 'raise',
    at,
    key: incidentKey(sighting.providerId, sighting.faultCode, sighting.subjectId),
    incidentId: ids.next(),
    sighting,
    count: 1,
    supersedes: [],
  };
}

/**
 * The time a direct write of `kind` on `record` happens at: now, but never before what the
 * record holds, and for a resolution or a dismissal change, after its latest sighting and its
 * last dismiss change
 * @param {Incident | undefined} record
 * @param {IncidentOp['kind']} kind
 * @param {number} now
 */
export function directAt(record, kind, now) {
  if (!record) return now;
  const changed = record.dismissChangedAt ?? 0;
  if (kind === 'raise') return Math.max(now, record.lastSeenAt, record.resolvedAt ?? 0, changed);
  return Math.max(now, record.lastSeenAt + 1, kind === 'dismiss' ? changed + 1 : 0);
}

/**
 * The incident `op` makes of `record`. With `track`, a replayed sighting is remembered in
 * `appliedOps`, and one already applied changes nothing.
 * @param {Incident | undefined} record
 * @param {IncidentOp} op
 * @param {{track?: boolean}} [options]
 * @returns {Incident | undefined}
 */
export function applyOp(record, op, { track = false } = {}) {
  if (op.kind === 'resolve') return applyResolve(record, op);
  if (op.kind === 'dismiss') return applyDismiss(record, op);
  return applyRaise(record, op, { track });
}

/**
 * @param {Incident | undefined} record
 * @param {RaiseOp} op
 * @param {{track?: boolean}} [options]
 * @returns {Incident}
 */
export function applyRaise(record, op, { track = false } = {}) {
  const { sighting, at } = op;
  const remembered = { opId: op.opId, count: op.count };
  if (!record) {
    return {
      id: op.incidentId,
      ref: refOf(op.incidentId),
      key: op.key,
      providerId: sighting.providerId,
      faultCode: sighting.faultCode,
      subjectId: sighting.subjectId,
      severity: sighting.severity,
      state: 'open',
      dismissed: false,
      dismissChangedAt: null,
      firstSeenAt: at,
      lastSeenAt: at,
      resolvedAt: null,
      occurrences: op.count,
      affected: [...sighting.affected],
      preserved: [...sighting.preserved],
      evidence: sighting.evidence,
      appliedOps: track ? [remembered] : [],
    };
  }
  let added = op.count;
  if (track) {
    if (record.appliedOps.some(item => item.opId === op.opId)) return record;
    // The newest earlier version already applied is part of this count
    for (const earlier of op.supersedes) {
      const applied = record.appliedOps.find(item => item.opId === earlier);
      if (applied) {
        added = Math.max(0, op.count - applied.count);
        break;
      }
    }
  }
  const newest = at >= record.lastSeenAt;
  const reopens = record.state === 'resolved' && added > 0 && at >= (record.resolvedAt ?? 0);
  const staysResolved = record.state === 'resolved' && !reopens;
  const undismisses = record.dismissed && added > 0 && at >= (record.dismissChangedAt ?? 0);
  return {
    ...record,
    severity: reopens ? sighting.severity : staysResolved ? record.severity : worseSeverity(record.severity, sighting.severity),
    state: reopens ? 'open' : record.state,
    resolvedAt: reopens ? null : record.resolvedAt,
    dismissed: undismisses ? false : record.dismissed,
    dismissChangedAt: undismisses ? at : record.dismissChangedAt,
    firstSeenAt: Math.min(record.firstSeenAt, at),
    lastSeenAt: added > 0 ? Math.max(record.lastSeenAt, at) : record.lastSeenAt,
    occurrences: record.occurrences + added,
    affected: newest && added > 0 ? [...sighting.affected] : record.affected,
    preserved: newest && added > 0 ? [...sighting.preserved] : record.preserved,
    evidence: newest && added > 0 ? sighting.evidence : record.evidence,
    appliedOps: track ? [...record.appliedOps, remembered].slice(-APPLIED_OPS) : record.appliedOps,
  };
}

/**
 * @param {Incident | undefined} record
 * @param {ResolveOp} op
 * @returns {Incident | undefined}
 */
export function applyResolve(record, op) {
  if (!record || record.state === 'resolved' || op.at <= record.lastSeenAt) return record;
  return { ...record, state: 'resolved', resolvedAt: op.at, dismissed: false };
}

/**
 * @param {Incident | undefined} record
 * @param {DismissOp} op
 * @returns {Incident | undefined}
 */
export function applyDismiss(record, op) {
  if (!record || record.state === 'resolved' || op.at <= record.lastSeenAt) return record;
  if (record.dismissChangedAt !== null && op.at <= record.dismissChangedAt) return record;
  return { ...record, dismissed: op.dismissed, dismissChangedAt: op.at };
}

/**
 * Operations in the order they happened, each once by its id
 * @param {readonly IncidentOp[]} ops
 * @returns {IncidentOp[]}
 */
export function inOrder(ops) {
  /** @type {Map<string, IncidentOp>} */
  const byId = new Map();
  for (const op of ops) if (!byId.has(op.opId)) byId.set(op.opId, op);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}
