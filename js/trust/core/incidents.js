/**
 * What happens to an incident (#20, "Contracts"; "Required states"): a sighting (raise), a
 * passing check (resolve), and a dismissal, each an operation with the time it happened, and
 * one pure reducer that applies an operation to the stored record. Every write runs its
 * operation through the reducer in one transaction. In fallback the records hold the
 * operations that couldn't be written, and both reads and reconciliation run them through
 * this same reducer, so a held operation means exactly what it would have meant written.
 *
 * Timestamps decide, whatever order operations arrive in:
 * - A sighting always adds one occurrence. One newer than `resolvedAt` reopens a resolved
 *   incident; an older one leaves it resolved. One at or after the latest sighting brings its
 *   severity, capabilities, and evidence; an older one doesn't. One newer than a dismissal
 *   clears it. A remediating incident stays remediating.
 * - A resolution applies only if no sighting is newer than it.
 * - A dismissal applies only if no sighting is newer than it.
 * A held sighting that's replayed records its operation id in the incident's `appliedOps`, so
 * a replay of the same one, from this context's memory or from the settings copy, adds
 * nothing.
 */

import * as v from '../../lib/valibot/index.mjs';
import { timestamp } from '../../kernel/core/contracts/fields.js';
import { evidenceSchema, faultCode, providerId, recordId, subjectId } from './evidence.js';
import { capabilities, incidentKey, incidentKeySchema, refOf, worseSeverity } from './records.js';
import { SEVERITIES } from './vocabulary.js';

/** @typedef {import('./records.js').Incident} Incident */

/** How many held operation ids an incident remembers */
export const APPLIED_OPS = 64;

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

/** A sighting as an operation. `incidentId` is the id it gives an incident it creates. */
export const raiseOpSchema = v.strictObject({
  opId: recordId,
  kind: v.literal('raise'),
  at: timestamp,
  key: incidentKeySchema,
  incidentId: recordId,
  sighting: sightingSchema,
});

/** @typedef {v.InferOutput<typeof raiseOpSchema>} RaiseOp */
/** @typedef {{opId: string, kind: 'resolve', at: number, key: string}} ResolveOp */
/** @typedef {{opId: string, kind: 'dismiss', at: number, key: string, dismissed: boolean}} DismissOp */
/** @typedef {RaiseOp | ResolveOp | DismissOp} IncidentOp */

/**
 * A sighting as an operation, at `at`
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
  };
}

/**
 * The incident `op` makes of `record`. With `track`, a held operation's id is remembered, and
 * one already applied changes nothing.
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
  const applied = track ? [op.opId] : [];
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
      dismissedAt: null,
      firstSeenAt: at,
      lastSeenAt: at,
      resolvedAt: null,
      occurrences: 1,
      affected: [...sighting.affected],
      preserved: [...sighting.preserved],
      evidence: sighting.evidence,
      appliedOps: applied,
    };
  }
  if (track && record.appliedOps.includes(op.opId)) return record;
  const newest = at >= record.lastSeenAt;
  const reopens = record.state === 'resolved' && at > (record.resolvedAt ?? 0);
  const staysResolved = record.state === 'resolved' && !reopens;
  const undismisses = record.dismissed && at > (record.dismissedAt ?? 0);
  return {
    ...record,
    severity: reopens ? sighting.severity : staysResolved ? record.severity : worseSeverity(record.severity, sighting.severity),
    state: reopens ? 'open' : record.state,
    resolvedAt: reopens ? null : record.resolvedAt,
    dismissed: undismisses ? false : record.dismissed,
    dismissedAt: undismisses ? null : record.dismissedAt,
    firstSeenAt: Math.min(record.firstSeenAt, at),
    lastSeenAt: Math.max(record.lastSeenAt, at),
    occurrences: record.occurrences + 1,
    affected: newest ? [...sighting.affected] : record.affected,
    preserved: newest ? [...sighting.preserved] : record.preserved,
    evidence: newest ? sighting.evidence : record.evidence,
    appliedOps: track ? [...record.appliedOps, op.opId].slice(-APPLIED_OPS) : record.appliedOps,
  };
}

/**
 * @param {Incident | undefined} record
 * @param {ResolveOp} op
 * @returns {Incident | undefined}
 */
export function applyResolve(record, op) {
  if (!record || record.state === 'resolved' || record.lastSeenAt > op.at) return record;
  return { ...record, state: 'resolved', resolvedAt: op.at, dismissed: false, dismissedAt: null };
}

/**
 * @param {Incident | undefined} record
 * @param {DismissOp} op
 * @returns {Incident | undefined}
 */
export function applyDismiss(record, op) {
  if (!record || record.state === 'resolved' || record.lastSeenAt > op.at) return record;
  return { ...record, dismissed: op.dismissed, dismissedAt: op.dismissed ? op.at : null };
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
