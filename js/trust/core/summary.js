/**
 * trust.summary from what the records read (#20 slice 4c): each provider's status from its latest
 * receipt, the incidents, and what they add up to. It takes each provider as its static row
 * (providers/rows.js), so a page that only shows status computes the summary beside the records.
 * This module reaches no registry, checks module, Valibot or payload schema, but a page that
 * reads the records loads Valibot with them (trust-records.js). The use cases' trust.summary is
 * this, over the providers their registry root resolved.
 *
 * Status is always aggregated from receipts, never from settings: a provider with no receipt
 * reads `unverified`, a receipt past its window or dated in the future reads `stale`, and the
 * worst core status counts `unverified` and `stale` as worse than `verified`, so no summary is
 * healthy until a real check passed (approved AC3). While an update waits, storage's receipt
 * reads `degraded`, so `worstCore` does too, though the wait needs no action: whether anything
 * needs the user is `actionRequired`'s to say, not `worstCore`'s.
 *
 * Dismissed incidents stay listed but leave Needs action, and so does an update that's waiting
 * (updates.js, the design review's change 9), which needs no one: the Trust Center reads it by the
 * same rule. That rule decides which problems count, not how many: this counts incidents, and the
 * Recovery Center counts problems, merging incidents that share a title. Capture risk stays
 * strict: capture reads `safe` only on a fresh core receipt verified after the latest sighting of
 * every open capture-risk incident, dismissed ones included (the records time a capture-risk
 * sighting after the newest core receipt, whatever the clock), so a dismissed one reads `unknown`
 * until a later probe passes, never `safe`, and a new failure ends its dismissal (incidents.js).
 *
 * A cause carries only a registered error code, and never names a problem whose fault or
 * severity isn't registered: records a newer build wrote can hold what this build has no words
 * for, and trust.summary's schema takes none of it.
 */

import { ERROR_CODES, FAULT_CODES } from './codes.js';
import { updateKeyOf, waits, whyOf } from './updates.js';
import { HEALTH_GROUPS, SEVERITIES, STATUS_ORDER } from './vocabulary.js';

/** @typedef {import('./records.js').HealthReceipt} HealthReceipt */
/** @typedef {import('./records.js').Incident} Incident */
/** @typedef {import('./vocabulary.js').ProviderStatus} ProviderStatus */
/** @typedef {import('./operations/trust-summary.js').TrustSummary} TrustSummary */
/** @typedef {import('./operations/trust-summary.js').Cause} Cause */

/**
 * A provider as the summary reads it: its row's id, group and core flag (providers/rows.js), or
 * the same fields of the contribution a registry root resolved
 * @typedef {{id: string, group: string, core: boolean}} SummaryProvider
 */

/**
 * What the summary is read from: the providers that run here, in the order the registry browses
 * them (rows.js keeps it), each provider's latest receipt, every incident the records list, and
 * whether the read reached the store and the settings copy
 * @typedef {object} SummaryInput
 * @property {readonly SummaryProvider[]} providers - a host's own, rowsOn(host) for a page that
 *   reads the rows, as a root's registry resolves them on its host
 * @property {readonly HealthReceipt[]} receipts - the latest per provider (records.latestReceipts)
 * @property {readonly Incident[]} incidents - resolved ones included (records.incidentsRead)
 * @property {boolean} copyRead
 * @property {boolean} recordsRead
 * @property {'closed' | 'open' | 'fallback'} recordsState - the records' state()
 * @property {number} now
 */

/** The statuses that are a fault, which a group with no open problem names as its cause */
const FAULT_STATUSES = Object.freeze(['failed', 'action-required', 'degraded']);

/**
 * A receipt's status as it reads at `now`: `stale` once it's past its window or dated in the
 * future, otherwise what it stored
 * @param {{status: string, verifiedAt: number, freshnessMs: number}} receipt
 * @param {number} now
 * @returns {ProviderStatus}
 */
export function effectiveStatus(receipt, now) {
  if (receipt.verifiedAt > now || now - receipt.verifiedAt > receipt.freshnessMs) return 'stale';
  return /** @type {ProviderStatus} */ (receipt.status);
}

/**
 * The worst of `statuses`, or `unverified` when there are none
 * @param {readonly ProviderStatus[]} statuses
 * @returns {ProviderStatus}
 */
export function worstStatus(statuses) {
  if (statuses.length === 0) return 'unverified';
  return /** @type {ProviderStatus} */ (
    STATUS_ORDER[Math.min(...statuses.map(status => STATUS_ORDER.indexOf(/** @type {any} */ (status))))]
  );
}

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
 * The registered error code `evidence` names, or null
 * @param {Readonly<Record<string, unknown>> | null | undefined} evidence
 * @returns {Cause['errorCode']}
 */
const errorCodeOf = evidence => {
  const code = evidence ? evidence.errorCode : undefined;
  return typeof code === 'string' && ERROR_CODES.includes(code) ? /** @type {Cause['errorCode']} */ (code) : null;
};

/**
 * What every status page reads: each provider's status, the open incidents, and what they add up
 * to. `shown` is every open incident the user hasn't dismissed; `needsAction` is those but an
 * update that's waiting.
 * @template {SummaryProvider} P
 * @param {Omit<SummaryInput, 'providers'> & {providers: readonly P[]}} input - the providers as
 *   the caller has them, which each status keeps
 */
export function assess({ providers, receipts, incidents, copyRead, recordsRead, recordsState, now }) {
  const latest = new Map(receipts.map(receipt => [receipt.providerId, receipt]));
  const all = providers.map(provider => {
    const receipt = latest.get(provider.id) || null;
    /** @type {ProviderStatus} */
    const status = receipt ? effectiveStatus(receipt, now) : 'unverified';
    return { provider, receipt, status };
  });
  const open = incidents.filter(incident => incident.state !== 'resolved');
  // Writes failing, or a store or settings copy this read couldn't reach: what's held or
  // stored is unknown, so nothing is called safe and something needs action
  const blind = recordsState === 'fallback' || !copyRead || !recordsRead;
  const shown = open.filter(incident => !incident.dismissed);
  // An update that's waiting needs no one: it's shown, and needs no action (change 9)
  const storageReceipt = latest.get('storage') || null;
  const needsAction = shown.filter(incident => !waits(incident, storageReceipt));
  const core = all.filter(({ provider }) => provider.core);
  const fresh = core.filter(({ status }) => status !== 'stale');
  const atRisk =
    fresh.some(({ receipt }) => receipt && receipt.capture === 'at-risk') ||
    shown.some(incident => incident.severity === 'capture-risk');
  // The latest sighting of any open capture-risk incident, dismissed or not
  const riskSeenAt = Math.max(
    -1,
    ...open.filter(incident => incident.severity === 'capture-risk').map(incident => incident.lastSeenAt),
  );
  const safe = fresh.some(({ receipt }) => receipt && receipt.capture === 'safe' && receipt.verifiedAt > riskSeenAt);
  return { all, latest, open, blind, shown, needsAction, core, atRisk, safe };
}

/**
 * Whether this build registers `incident`'s fault and severity. One a newer build wrote with
 * either unregistered still needs action, but is never a cause: trust.summary's schema takes
 * neither, and an unknown severity has no place in the worst-first order.
 * @param {Incident} incident
 */
const registered = incident => FAULT_CODES.includes(incident.faultCode) && SEVERITIES.includes(incident.severity);

/**
 * A group's cause: its worst registered problem that needs action, or, with none, its worst
 * member at fault by its receipt, of the members with no open problem (one whose problems were
 * all dismissed, or whose update waits, says no more); null when nothing in it is at fault. A
 * problem says why by its own evidence, as the Trust Center reads it, and storage's update, whose
 * check's incident carries none, by storage's latest receipt when that receipt reports the
 * update (updates.js whyOf).
 * @param {ReturnType<typeof assess>['all']} members
 * @param {readonly Incident[]} needs - the group's incidents that need action
 * @param {readonly Incident[]} open - every open incident, dismissed ones included
 * @param {ReadonlyMap<string, HealthReceipt>} latest - each provider's latest receipt
 * @returns {Cause | null}
 */
function causeOf(members, needs, open, latest) {
  const [worst] = worstFirst(needs.filter(registered));
  if (worst) {
    const update = worst.providerId === 'storage' && updateKeyOf(worst.faultCode, null) !== null;
    return {
      from: 'incident',
      providerId: worst.providerId,
      faultCode: worst.faultCode,
      errorCode: errorCodeOf(update ? whyOf(latest.get('storage') || null, worst.evidence || {}) : worst.evidence),
      severity: worst.severity,
      consequenceKey: null,
      incidentId: worst.id,
      at: worst.lastSeenAt,
    };
  }
  const rank = (/** @type {ProviderStatus} */ status) => STATUS_ORDER.indexOf(/** @type {any} */ (status));
  const [faulty] = members
    .filter(
      ({ provider, receipt, status }) =>
        receipt && FAULT_STATUSES.includes(status) && !open.some(incident => incident.providerId === provider.id),
    )
    .sort((a, b) => rank(a.status) - rank(b.status));
  if (!faulty || !faulty.receipt) return null;
  return {
    from: 'receipt',
    providerId: faulty.receipt.providerId,
    faultCode: null,
    errorCode: errorCodeOf(faulty.receipt.evidence),
    severity: null,
    consequenceKey: faulty.receipt.consequenceKey,
    incidentId: null,
    at: faulty.receipt.verifiedAt,
  };
}

/**
 * trust.summary's answer
 * @param {SummaryInput} input
 * @returns {TrustSummary}
 */
export function summarize(input) {
  const { all, latest, open, blind, shown, needsAction, core, atRisk, safe } = assess(input);
  const storageDown =
    blind ||
    all.some(({ provider, status }) => provider.id === 'storage' && status === 'failed') ||
    shown.some(incident => incident.providerId === 'storage' && incident.faultCode === 'open-failed');
  const groups = HEALTH_GROUPS.map(group => {
    const members = all.filter(({ provider }) => provider.group === group);
    const ids = members.map(({ provider }) => provider.id);
    const needs = needsAction.filter(incident => ids.includes(incident.providerId));
    const times = members.flatMap(({ receipt }) => (receipt ? [receipt.verifiedAt] : []));
    return {
      group,
      providers: members.length,
      needsAction: needs.length,
      worst: worstStatus(members.map(({ status }) => status)),
      // When it was last checked: its newest receipt's time, null before any check
      checkedAt: times.length > 0 ? Math.max(...times) : null,
      cause: causeOf(members, needs, open, latest),
    };
  }).filter(group => group.providers > 0);
  return {
    worstCore: worstStatus(core.map(({ status }) => status)),
    // While writes fail, nothing proves capture safe
    capture: atRisk ? 'at-risk' : safe && !blind ? 'safe' : 'unknown',
    // While writes fail, or the copy can't be read, something always needs action
    actionRequired: Math.max(needsAction.length, blind ? 1 : 0),
    route: atRisk || storageDown ? 'recovery' : 'trust',
    records: input.recordsState,
    groups,
  };
}
