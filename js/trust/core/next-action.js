/**
 * The one place that picks what a view offers next (#20 slice 4a), so no view picks its own:
 * each provider row's next action in the Trust Center, each problem card's in the Recovery
 * Center, and the one list of what still works beside a problem. trust.report and
 * recovery.incidents carry what these answer.
 *
 * A provider row's next action, first match wins:
 * 1. A core provider while capture is at risk: the Recovery Center, at its worst problem.
 * 2. An open problem (not dismissed) with a repair (remediation/repairs.js): that repair, for
 *    that incident. Limited site access: Chrome's site access for the extension. Any other
 *    problem: the Recovery Center, at it.
 * 3. The receipt's own `nextAction`, while it's fresh (Credentials' Remove saved keys).
 * 4. Stale, or unverified with no receipt or a check that couldn't run: Check now.
 * 5. Backup not set up: its settings.
 * 6. Nothing.
 * A problem card's is step 2's, or nothing (Dismiss is always there).
 */

import * as v from '../../lib/valibot/index.mjs';
import { providerId, recordId, remediationId } from './evidence.js';
import { repairOf } from './remediation/repairs.js';
import { SEVERITIES } from './vocabulary.js';

/** @typedef {import('./records.js').Incident} Incident */
/** @typedef {import('./records.js').HealthReceipt} HealthReceipt */
/** @typedef {import('./vocabulary.js').ProviderStatus} ProviderStatus */

export const nextActionSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('remediation'), remediationId, incidentId: v.nullable(recordId) }),
  v.strictObject({ kind: v.literal('check'), providerId }),
  v.strictObject({ kind: v.literal('recovery-center'), incidentId: v.nullable(recordId) }),
  v.strictObject({ kind: v.literal('site-access') }),
  v.strictObject({ kind: v.literal('settings'), area: v.picklist(['backup']) }),
]);

/** @typedef {v.InferOutput<typeof nextActionSchema>} NextAction */

/** A receipt's error codes that say its check couldn't run, so Check now is the way on */
const COULD_NOT_CHECK = Object.freeze(['check-timed-out', 'check-threw', 'invalid-check-result']);

/**
 * `incidents` worst first: severity, then most recently seen
 * @template {{severity: string, lastSeenAt: number}} T
 * @param {readonly T[]} incidents
 * @returns {T[]}
 */
export const worstFirst = incidents =>
  [...incidents].sort(
    (a, b) =>
      SEVERITIES.indexOf(/** @type {any} */ (a.severity)) - SEVERITIES.indexOf(/** @type {any} */ (b.severity)) ||
      b.lastSeenAt - a.lastSeenAt,
  );

/**
 * The remediation a view offers for a problem, or null
 * @param {{providerId: string, faultCode: string}} incident
 * @returns {string | null}
 */
export function repairFor(incident) {
  const repair = repairOf(incident);
  return repair ? repair.remediationId : null;
}

/**
 * A problem card's next action, or null when Dismiss is all it has
 * @param {Pick<Incident, 'id' | 'providerId' | 'faultCode'>} incident
 * @returns {NextAction | null}
 */
export function incidentAction(incident) {
  const remediation = repairFor(incident);
  if (remediation) {
    return { kind: 'remediation', remediationId: /** @type {any} */ (remediation), incidentId: incident.id };
  }
  if (incident.providerId === 'permissions') return { kind: 'site-access' };
  return null;
}

/**
 * A provider row's next action (see the top of this file)
 * @param {{
 *   providerId: string,
 *   core: boolean,
 *   status: ProviderStatus,
 *   receipt: Pick<HealthReceipt, 'nextAction' | 'evidence'> | null,
 *   incidents: readonly Pick<Incident, 'id' | 'providerId' | 'faultCode' | 'severity' | 'lastSeenAt'>[],
 *   captureAtRisk: boolean,
 * }} row - `incidents`: the provider's open ones that aren't dismissed
 * @returns {NextAction | null}
 */
export function nextActionOf({ providerId: id, core, status, receipt, incidents, captureAtRisk }) {
  const [worst] = worstFirst(incidents);
  if (core && captureAtRisk) return { kind: 'recovery-center', incidentId: worst ? worst.id : null };
  if (worst) return incidentAction(worst) || { kind: 'recovery-center', incidentId: worst.id };
  if (status !== 'stale' && receipt && receipt.nextAction) {
    return { kind: 'remediation', remediationId: receipt.nextAction, incidentId: null };
  }
  const errorCode = receipt && receipt.evidence ? receipt.evidence.errorCode : undefined;
  const couldNotCheck = !receipt || COULD_NOT_CHECK.includes(/** @type {string} */ (errorCode));
  if (status === 'stale' || (status === 'unverified' && couldNotCheck)) {
    return { kind: 'check', providerId: /** @type {any} */ (id) };
  }
  if (status === 'not-configured' && id === 'backup') return { kind: 'settings', area: 'backup' };
  return null;
}

/**
 * What still works beside a provider's problems, computed once for every view: what its
 * receipt or any of its open problems says it preserves, less anything any of them says it
 * affects
 * @param {Pick<HealthReceipt, 'preserved'> | null} receipt
 * @param {readonly Pick<Incident, 'affected' | 'preserved'>[]} incidents
 * @returns {string[]}
 */
export function stillWorksOf(receipt, incidents) {
  const affected = new Set(incidents.flatMap(incident => incident.affected));
  const preserved = [...(receipt ? receipt.preserved : []), ...incidents.flatMap(incident => incident.preserved)];
  return [...new Set(preserved)].filter(capability => !affected.has(capability));
}
