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
 *   fault milder; a reopened one takes the sighting's. A remediating incident stays
 *   remediating.
 * - A dismissal holds until the problem changes: a sighting at or after the last dismiss
 *   change clears it only when it's worse than the incident's severity, or names a cause
 *   (`evidence.errorCode`) other than the one it was dismissed with (`dismissedCause`). The
 *   same fault, subject, cause and severity sighted again keeps it, and so does a sighting
 *   that names no cause (a check's), so a check on every Trust Center open never undoes it. A
 *   resolution clears it, so a fault that's fixed and comes back is a problem to see again.
 *   Capture risk is the exception: any new sighting of a capture-risk incident from a failure
 *   event (a failed capture, a failed open) ends its dismissal, since each one may be a note
 *   that wasn't saved. Only a check's re-sighting of the same standing fault (`from: 'check'`)
 *   keeps it. A sighting held from several (trust-records.js) lists every cause it saw
 *   (`causes`), and any one other than the dismissed one counts as a change.
 * - A resolution applies only if it's later than every sighting.
 * - A dismissal or undismissal applies only if it's later than every sighting and than the
 *   last dismiss change (`dismissChangedAt`), so an older one replayed late changes nothing.
 * A sighting replayed from the settings copy names its lineage: the operation id of the first
 * version of its copy entry, which every later version keeps while it adds occurrences. The
 * incident's `appliedOps` keeps each lineage with the highest count applied, so a version
 * replayed again, or a later one, adds only what's new. Occurrences only one context's memory
 * holds aren't tracked: that context clears them right after the commit that replays them.
 */

import * as v from '../../lib/valibot/index.mjs';
import { count, timestamp } from '../../kernel/core/contracts/fields.js';
import { errorCode, evidenceSchema, faultCode, providerId, recordId, subjectId } from './evidence.js';
import { capabilities, incidentKey, incidentKeySchema, refOf, worseSeverity } from './records.js';
import { SEVERITIES } from './vocabulary.js';

/** @typedef {import('./records.js').Incident} Incident */

/**
 * How many copy lineages an incident remembers. The copy holds one entry, so one live lineage,
 * per key; a key gets a new lineage only after its entry was replayed and trimmed, so an
 * evicted lineage is one the copy no longer holds.
 */
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
  // A check's sighting, which never ends a capture-risk dismissal; absent for a failure event's
  from: v.optional(v.literal('check')),
  // Every cause the sightings held together named, when there was more than one
  causes: v.optional(v.pipe(v.array(errorCode), v.maxLength(8))),
});

/** @typedef {v.InferOutput<typeof sightingSchema>} Sighting */

/** How many causes a held sighting remembers */
export const MAX_CAUSES = 8;

/**
 * A sighting as an operation: `count` occurrences, the latest at `at`. `incidentId` is the id
 * it gives an incident it creates, and `lineage` the copy entry's first operation id, which
 * every later version of the entry keeps, its count including the earlier ones'.
 */
/** How many contexts an incident or a copy entry names as having sighted it */
export const CONTEXTS = 8;

/** The contexts (each records instance's random id) whose sightings an op or incident counts */
export const sightedBySchema = v.pipe(v.array(recordId), v.maxLength(CONTEXTS));

export const raiseOpSchema = v.strictObject({
  opId: recordId,
  kind: v.literal('raise'),
  at: timestamp,
  key: incidentKeySchema,
  incidentId: recordId,
  sighting: sightingSchema,
  count: v.pipe(count, v.minValue(1)),
  lineage: recordId,
  // The contexts whose sightings `count` holds; an entry without it (an older build's) reads as
  // another context's
  by: v.optional(sightedBySchema),
});

/**
 * `a` and `b` together, each once, at most CONTEXTS: past that, the list still names more than
 * one context, which is all a reader of it asks
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {string[]}
 */
export function sightedByUnion(a, b) {
  return [...new Set([...a, ...b])].slice(0, CONTEXTS);
}

/** @typedef {v.InferOutput<typeof raiseOpSchema>} RaiseOp */
/** @typedef {{opId: string, kind: 'resolve', at: number, key: string}} ResolveOp */
/** @typedef {{opId: string, kind: 'dismiss', at: number, key: string, dismissed: boolean}} DismissOp */
/** @typedef {RaiseOp | ResolveOp | DismissOp} IncidentOp */

/**
 * One sighting as an operation, at `at`
 * @param {{next(): string}} ids
 * @param {Sighting} sighting
 * @param {number} at
 * @param {readonly string[]} [by] - the context that sighted it
 * @returns {RaiseOp}
 */
export function raiseOp(ids, sighting, at, by) {
  const opId = ids.next();
  return {
    opId,
    kind: 'raise',
    at,
    key: incidentKey(sighting.providerId, sighting.faultCode, sighting.subjectId),
    incidentId: ids.next(),
    sighting,
    count: 1,
    lineage: opId,
    ...(by ? { by: [...by] } : {}),
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
 * The incident `op` makes of `record`. With `track`, a sighting replayed from the copy is
 * remembered by its lineage in `appliedOps`, and adds only what that lineage hasn't yet.
 * @param {Incident | undefined} record
 * @param {IncidentOp} op
 * @param {{track?: boolean, unseen?: boolean}} [options]
 * @returns {Incident | undefined}
 */
export function applyOp(record, op, { track = false, unseen = false } = {}) {
  if (op.kind === 'resolve') return applyResolve(record, op);
  if (op.kind === 'dismiss') return applyDismiss(record, op);
  return applyRaise(record, op, { track, unseen });
}

/**
 * @param {Incident | undefined} record
 * @param {RaiseOp} op
 * @param {{track?: boolean, unseen?: boolean}} [options] - `unseen`: a held sighting, which
 *   no write has counted yet (a copy entry's new count, or what one context's memory holds)
 * @returns {Incident}
 */
export function applyRaise(record, op, { track = false, unseen = false } = {}) {
  const { sighting, at } = op;
  const remembered = { lineage: op.lineage, count: op.count };
  // An op that doesn't say whose sightings it holds reads as another context's
  const by = op.by || [op.lineage];
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
      sightedBy: sightedByUnion([], by),
    };
  }
  let added = op.count;
  if (track) {
    const applied = record.appliedOps.find(item => item.lineage === op.lineage);
    if (applied) added = Math.max(0, op.count - applied.count);
    if (added === 0) return record;
  }
  const newest = at >= record.lastSeenAt;
  // A held sighting's new count reopens, and undismisses a problem that changed, whatever the
  // clocks say: a resolve or a dismiss replays what's held first, under the copy's lock, so
  // what it hadn't counted came after it. Memory clears what it replayed once the write commits.
  const late = track || unseen;
  const reopens = record.state === 'resolved' && added > 0 && (late || at >= (record.resolvedAt ?? 0));
  const staysResolved = record.state === 'resolved' && !reopens;
  const undismisses =
    record.dismissed &&
    added > 0 &&
    (late || at >= (record.dismissChangedAt ?? 0)) &&
    (changesProblem(record, sighting) || newCaptureRisk(record, sighting));
  return {
    ...(undismisses ? withoutCause(record) : record),
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
    appliedOps: track
      ? [...record.appliedOps.filter(item => item.lineage !== op.lineage), remembered].slice(-APPLIED_OPS)
      : record.appliedOps,
    // Who sighted it since it was last resolved; a record from before this field reads as
    // sighted by contexts unknown
    sightedBy:
      added === 0
        ? record.sightedBy
        : reopens
          ? sightedByUnion([], by)
          : sightedByUnion(record.sightedBy || [record.id], by),
  };
}

/**
 * The cause an incident's evidence names: its error code, or null
 * @param {{evidence: Record<string, unknown>}} held
 * @returns {string | null}
 */
const causeOf = held => (typeof held.evidence.errorCode === 'string' ? held.evidence.errorCode : null);

/**
 * Whether `sighting` is a changed problem for a dismissed `record`: a worse severity, or a
 * cause other than the one it was dismissed with. A sighting that names no cause says nothing
 * about it. A record an older build dismissed has no `dismissedCause`; its evidence stands in.
 * @param {Incident} record
 * @param {Sighting} sighting
 */
export function changesProblem(record, sighting) {
  if (SEVERITIES.indexOf(sighting.severity) < SEVERITIES.indexOf(record.severity)) return true;
  const causes = causesOf(sighting);
  if (causes.length === 0) return false;
  const dismissedWith = record.dismissedCause !== undefined ? record.dismissedCause : causeOf(record);
  return causes.some(cause => cause !== dismissedWith);
}

/**
 * Every cause a sighting names: those a held one gathered, or its evidence's
 * @param {Sighting} sighting
 * @returns {string[]}
 */
export function causesOf(sighting) {
  if (sighting.causes && sighting.causes.length > 0) return [...sighting.causes];
  const cause = causeOf(sighting);
  return cause === null ? [] : [cause];
}

/**
 * Whether `sighting` is a failure event's new sighting of a capture-risk incident, which ends
 * its dismissal whatever its cause
 * @param {Incident} record
 * @param {Sighting} sighting
 */
const newCaptureRisk = (record, sighting) =>
  sighting.from !== 'check' && (record.severity === 'capture-risk' || sighting.severity === 'capture-risk');

/**
 * `record` without `dismissedCause`, which only a dismissed incident holds
 * @param {Incident} record
 * @returns {Incident}
 */
function withoutCause(record) {
  const rest = { ...record };
  delete rest.dismissedCause;
  return rest;
}

/**
 * @param {Incident | undefined} record
 * @param {ResolveOp} op
 * @returns {Incident | undefined}
 */
export function applyResolve(record, op) {
  if (!record || record.state === 'resolved' || op.at <= record.lastSeenAt) return record;
  return { ...withoutCause(record), state: 'resolved', resolvedAt: op.at, dismissed: false, sightedBy: [] };
}

/**
 * @param {Incident | undefined} record
 * @param {DismissOp} op
 * @returns {Incident | undefined}
 */
export function applyDismiss(record, op) {
  if (!record || record.state === 'resolved' || op.at <= record.lastSeenAt) return record;
  if (record.dismissChangedAt !== null && op.at <= record.dismissChangedAt) return record;
  if (!op.dismissed) return { ...withoutCause(record), dismissed: false, dismissChangedAt: op.at };
  return { ...record, dismissed: true, dismissChangedAt: op.at, dismissedCause: causeOf(record) };
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
