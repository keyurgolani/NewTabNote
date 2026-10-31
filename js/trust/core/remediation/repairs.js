/**
 * The repairs the Trust and Recovery views offer (#20 slice 4a): for each problem, by its
 * provider and fault, the remediation its card offers. A view offers a repair only from here,
 * and only for a fault its provider observes, so the check after the repair (recovery.check)
 * can see that it's gone; test/kernel/trust-s4a-contracts.test.mjs pins that for every row,
 * and that the remediation applies to the provider and the provider names it.
 *
 * `kind`: a `repair` fixes the fault, so the view checks after it and says "fixed" or "still
 * there"; a `mitigation` turns off what the fault breaks (safe-disable), and the fault stays
 * until its own fix, so the view says what it turned off rather than "fixed".
 *
 * Not here, on purpose:
 * - `recover-orphans`: its fault, `storage/scan-findings`, isn't observed until #17's integrity
 *   scan brings the observation with it; until then nothing raises it.
 * - `capture/capture-failed` and `index/indexer-start-failed`, a failure event's incidents that
 *   no check sees: a later success at the same site resolves them, and Dismiss is their action.
 * - `index/stalled` has its row, though nothing raises it before #22.
 * - The salvage file, Save as file, and the diagnostic report are tools, not repairs: they
 *   resolve nothing.
 */

/** @typedef {{providerId: string, faultCode: string, remediationId: string, kind: 'repair' | 'mitigation'}} Repair */

/** @type {readonly Readonly<Repair>[]} */
export const REPAIRS = Object.freeze(
  /** @type {Repair[]} */ ([
    { providerId: 'index', faultCode: 'lagging', remediationId: 'rebuild-index', kind: 'repair' },
    { providerId: 'index', faultCode: 'stalled', remediationId: 'rebuild-index', kind: 'repair' },
    { providerId: 'storage', faultCode: 'open-failed', remediationId: 'retry-open', kind: 'repair' },
    { providerId: 'storage', faultCode: 'probe-failed', remediationId: 'retry-open', kind: 'repair' },
    { providerId: 'capture', faultCode: 'probe-failed', remediationId: 'retry-open', kind: 'repair' },
    // Out of space: "Free up some space on this device, then choose Try again"
    { providerId: 'storage', faultCode: 'quota', remediationId: 'retry-open', kind: 'repair' },
    { providerId: 'capture', faultCode: 'quota', remediationId: 'retry-open', kind: 'repair' },
    { providerId: 'credentials', faultCode: 'legacy-secret', remediationId: 'remove-saved-key', kind: 'repair' },
    { providerId: 'local-inference', faultCode: 'load-failed', remediationId: 'safe-disable', kind: 'mitigation' },
  ]).map(repair => Object.freeze(repair)),
);

/**
 * The repair a view offers for `incident`, or null
 * @param {{providerId: string, faultCode: string}} incident
 * @returns {Readonly<Repair> | null}
 */
export function repairOf(incident) {
  return REPAIRS.find(repair => repair.providerId === incident.providerId && repair.faultCode === incident.faultCode) || null;
}
