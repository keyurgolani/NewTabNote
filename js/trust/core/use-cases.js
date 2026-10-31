/**
 * The Trust Center's use cases, in-process (#20, "Contracts"): what each catalog operation
 * does, over the records, the journal, and the health providers a registry root resolved.
 * Slice 2 registers handlers on #13's worker router and the Trust and Recovery pages that call
 * these. `recovery.run` has its catalog entry and payload schema here, and slice 3's pipeline
 * is its use case.
 *
 * Slice 4a adds what the views need: `recovery.dismiss` and `recovery.undismiss` (a dismissal
 * holds until the problem changes, incidents.js), `recovery.check` (the check after a repair:
 * the incident's provider's check, which alone resolves it), `recovery.copies` (Copies of your
 * notes, repair recovery points included), a time and a cause per group in trust.summary, and
 * each row's and card's next action from next-action.js in trust.report and recovery.incidents.
 *
 * Status is always aggregated from receipts, never from settings: a provider with no receipt
 * reads `unverified`, a receipt past its window or dated in the future reads `stale`, and the
 * worst core status counts `unverified` and `stale` as worse than `verified`, so no summary is
 * healthy until a real check passed (approved AC3).
 *
 * Checks run in the page that asks until #35 schedules them: opening Trust runs `local-cheap`
 * checks only, idle work adds `local-expensive` ones, and Verify now runs them all. Each
 * provider's check holds Web Lock `trust.check.<id>` when the host has locks, so two tabs
 * never run one provider at once.
 */

import * as v from '../../lib/valibot/index.mjs';
import {
  committed,
  conflict,
  failedFrom,
  ready,
  rejected,
  unavailable,
  unavailableFrom,
} from '../../kernel/core/contracts/outcomes.js';
import { effectiveStatus, runCheck } from './checks.js';
import { buildDiagnostics } from './diagnostics.js';
import { pointId } from './evidence.js';
import { incidentAction, nextActionOf, stillWorksOf, worstFirst } from './next-action.js';
import { payload as checkPayload } from './operations/recovery-check.js';
import { payload as dismissPayload } from './operations/recovery-dismiss.js';
import { payload as raisePayload } from './operations/recovery-raise.js';
import { payload as undismissPayload } from './operations/recovery-undismiss.js';
import { payload as verifyPayload } from './operations/trust-verify.js';
import { LEGACY_COPY_KEY } from './ports.js';
import { incidentKey } from './records.js';
import { HEALTH_GROUPS, SEVERITIES, STATUS_ORDER } from './vocabulary.js';

/** @typedef {import('./trust-records.js').TrustRecords} TrustRecords */
/** @typedef {import('./journal.js').DiagnosticJournal} DiagnosticJournal */
/** @typedef {import('./ports.js').Clock} Clock */
/** @typedef {import('./ports.js').Timers} Timers */
/** @typedef {import('./ports.js').Locks} Locks */
/** @typedef {import('./diagnostics.js').Versions} Versions */
/** @typedef {import('./diagnostics.js').MigrationReceipt} MigrationReceipt */
/** @typedef {import('./records.js').HealthReceipt} HealthReceipt */
/** @typedef {import('./records.js').Incident} Incident */
/** @typedef {import('./vocabulary.js').ProviderStatus} ProviderStatus */
/** @typedef {import('./vocabulary.js').CostClass} CostClass */
/** @typedef {import('./vocabulary.js').Trigger} Trigger */
/** @typedef {import('./vocabulary.js').HealthGroup} HealthGroup */
/** @typedef {import('../../kernel/registry/resolve.js').Resolution} Resolution */
/** @typedef {import('../../kernel/registry/resolve.js').Contribution} Contribution */
/** @typedef {import('../../kernel/registry/runtime.js').Runtime} Runtime */
/** @typedef {import('./operations/trust-summary.js').TrustSummary} TrustSummary */
/** @typedef {import('./operations/trust-summary.js').Cause} Cause */
/** @typedef {import('./operations/trust-report.js').TrustReport} TrustReport */
/** @typedef {import('./operations/recovery-check.js').Checked} Checked */
/** @typedef {import('./operations/recovery-copies.js').Copy} Copy */
/** @typedef {import('../../kernel/core/contracts/outcomes.js').Outcome} Outcome */

/** The statuses that are a fault, which a group with no open problem names as its cause */
const FAULT_STATUSES = Object.freeze(['failed', 'action-required', 'degraded']);

/** The most copies recovery.copies lists */
const MAX_COPIES = 500;

/**
 * The cause an incident's or a receipt's evidence names: its error code, or null
 * @param {{evidence: Record<string, unknown>}} held
 * @returns {any}
 */
const errorCodeOf = held => (typeof held.evidence.errorCode === 'string' ? held.evidence.errorCode : null);

/**
 * Whether a check's `looked` covers `incident`: its fault, for every subject or its own
 * @param {readonly {faultCode: string, subjectId?: string | null}[]} looked
 * @param {Incident} incident
 */
const lookedAt = (looked, incident) =>
  looked.some(
    item =>
      item.faultCode === incident.faultCode && (item.subjectId === undefined || item.subjectId === incident.subjectId),
  );

/**
 * A provider as the use cases read it from its contribution
 * @typedef {object} ProviderInfo
 * @property {string} ref
 * @property {string} id
 * @property {HealthGroup} group
 * @property {boolean} core
 * @property {string} operation
 * @property {CostClass} costClass
 * @property {number} timeoutMs
 * @property {number} freshnessMs
 * @property {readonly string[]} observes - the faults its check may report or look for
 */

/**
 * recovery.raise's answer for an incident memory and the settings copy hold
 * @param {string} incidentId
 * @returns {import('./operations/recovery-raise.js').Held}
 */
export function heldOutcome(incidentId) {
  return { kind: 'held', code: 'incident-held', incidentId, messageKey: 'held.incident-held', severity: 'warning' };
}

/**
 * Whether a check of `costClass` runs for `trigger`
 * @param {CostClass} costClass
 * @param {Trigger} trigger
 */
export function runsOn(costClass, trigger) {
  if (trigger === 'open') return costClass === 'local-cheap';
  if (trigger === 'idle') return costClass !== 'network';
  return true;
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
 * @param {{
 *   records: TrustRecords,
 *   journal: DiagnosticJournal,
 *   clock: Clock,
 *   timers: Timers,
 *   locks?: Locks | null,
 *   registry: {resolution: Resolution, runtime: Runtime, context?: Readonly<Record<string, unknown>>},
 *   versions: Versions,
 *   migrations?: () => Promise<readonly MigrationReceipt[]>,
 * }} options
 */
export function createTrustUseCases({ records, journal, clock, timers, locks = null, registry, versions, migrations }) {
  /**
   * Journals what a use case did. While NewTabNoteTrust won't take writes these would fail
   * too, so they're skipped: one failed operation counts one failed write, not one per event.
   * @param {string} code
   * @param {Record<string, unknown>} fields
   */
  const note = (code, fields) => {
    if (records.state() !== 'fallback') journal.event(code, fields);
  };

  /** @returns {ProviderInfo[]} the resolved health providers that can run here, in browse order */
  const providers = () =>
    registry.resolution
      .list('health')
      .filter(contribution => contribution.ref !== null && contribution.state === 'enabled')
      .map(contribution => {
        const data = /** @type {Record<string, any>} */ (contribution.data);
        return {
          ref: /** @type {string} */ (contribution.ref),
          id: /** @type {string} */ (contribution.id),
          group: /** @type {HealthGroup} */ (contribution.group),
          core: data.core === true,
          operation: data.operation,
          costClass: data.costClass,
          timeoutMs: data.timeoutMs,
          freshnessMs: data.freshnessMs,
          observes: /** @type {string[]} */ ([...(data.observes || [])]),
        };
      });

  /**
   * Every provider with its latest receipt and the status that reads as now
   * @param {number} now
   */
  const statuses = async now => {
    const latest = new Map((await records.latestReceipts()).map(receipt => [receipt.providerId, receipt]));
    return providers().map(provider => {
      const receipt = latest.get(provider.id) || null;
      /** @type {ProviderStatus} */
      const status = receipt ? effectiveStatus(receipt, now) : 'unverified';
      return { provider, receipt, status };
    });
  };

  /**
   * Runs one provider's check and stores what it found. Answers its receipt, and whether all
   * of it landed: the receipt, each fault's incident (a held one isn't stored, so it hasn't),
   * and the resolution. A check that answered, whatever its status, resolves the provider's
   * open incidents it looked at (`looked`), no longer reports, and saw no new sighting of
   * while it ran (their occurrences, read before it, unchanged);
   * one that timed out, threw, or answered outside the schema resolves nothing. What didn't
   * land is counted in the storage incident.
   * @param {ProviderInfo} provider
   * @returns {Promise<{
   *   receipt: HealthReceipt | null,
   *   complete: boolean,
   *   outcome: string,
   *   looked: readonly {faultCode: string, subjectId?: string | null}[],
   *   still: string[],
   *   resolveRan: boolean,
   * }>} - also how the check ended, what it looked at, the keys it still reports, and whether
   *   its resolve ran (it doesn't when the count read before the check failed)
   */
  const verifyOne = async provider => {
    const loaded = await registry.runtime.load(provider.ref);
    const check =
      loaded.ok && loaded.implementation && typeof (/** @type {any} */ (loaded.implementation).check) === 'function'
        ? /** @type {(context: Readonly<Record<string, unknown>>) => unknown} */ (
            context => /** @type {any} */ (loaded.implementation).check(context)
          )
        : () => {
            throw new TypeError('provider has no check');
          };
    // What the provider's open incidents count before the check, so only one with no sighting
    // while it ran can resolve; a read that fails resolves nothing
    const seen = await records.occurrencesOf(provider.id);
    const run = await runCheck({ ...provider, check }, { context: registry.context || {}, clock, timers });
    if (run.outcome === 'timed-out') {
      note('trust.check-timed-out', {
        providerId: provider.id,
        durationMs: run.receipt.durationMs,
        timeoutMs: provider.timeoutMs,
      });
    } else if (run.outcome !== 'answered') {
      const exception = run.receipt.evidence.exception;
      note('trust.check-failed', {
        providerId: provider.id,
        durationMs: run.receipt.durationMs,
        errorCode: run.outcome === 'invalid' ? 'invalid-check-result' : 'check-threw',
        ...(typeof exception === 'string' ? { exception } : {}),
      });
    }
    const recorded = await records.record(run.receipt);
    let complete = recorded.recorded;
    for (const fault of run.faults) {
      // Held isn't stored: the check answers not recorded until a write stores it. A check's
      // sighting never ends a capture-risk dismissal by itself (incidents.js).
      const raised = await records.raise({ ...fault, from: 'check' });
      if (!raised.recorded) complete = false;
    }
    const still = run.faults.map(fault => incidentKey(fault.providerId, fault.faultCode, fault.subjectId));
    const ran = { outcome: run.outcome, looked: run.looked, still, resolveRan: false };
    if (!recorded.recorded) return { receipt: null, complete: false, ...ran };
    const { receipt } = recorded;
    if (run.outcome === 'answered' && run.looked.length > 0 && seen.ok) {
      const resolved = await records.resolve(provider.id, still, {
        looked: run.looked,
        seen: /** @type {{counts: Record<string, number>}} */ (seen).counts,
      });
      if (!resolved.recorded) return { receipt, complete: false, ...ran };
      ran.resolveRan = true;
      for (const incident of resolved.resolved) {
        note('incident.resolved', {
          incidentId: incident.id,
          providerId: incident.providerId,
          faultCode: incident.faultCode,
        });
      }
    }
    return { receipt, complete, ...ran };
  };

  /**
   * One provider's check, under its Web Lock when the host has them
   * @param {ProviderInfo} provider
   */
  const verifyLocked = provider => {
    const one = () => verifyOne(provider);
    return locks ? locks.request(`trust.check.${provider.id}`, one) : one();
  };

  /**
   * What every status page reads: each provider's status, the incidents, and what they add up
   * to. Dismissed incidents stay listed but leave Needs action and the cards. Capture risk
   * stays strict: capture reads `safe` only on a fresh core receipt verified after the latest
   * sighting of every open capture-risk incident, dismissed ones included (the records time a
   * capture-risk sighting after the newest core receipt, whatever the clock), so a dismissed one
   * reads `unknown` until a later probe passes, never `safe`, and a new failure ends its
   * dismissal (incidents.js).
   * @param {number} now
   */
  const assess = async now => {
    const all = await statuses(now);
    const { incidents: listed, copyRead, recordsRead } = await records.incidentsRead();
    const open = listed.filter(incident => incident.state !== 'resolved');
    // Writes failing, or a store or settings copy this read couldn't reach: what's held or
    // stored is unknown, so nothing is called safe and something needs action
    const blind = records.state() === 'fallback' || !copyRead || !recordsRead;
    const needsAction = open.filter(incident => !incident.dismissed);
    const core = all.filter(({ provider }) => provider.core);
    const fresh = core.filter(({ status }) => status !== 'stale');
    const atRisk =
      fresh.some(({ receipt }) => receipt && receipt.capture === 'at-risk') ||
      needsAction.some(incident => incident.severity === 'capture-risk');
    // The latest sighting of any open capture-risk incident, dismissed or not
    const riskSeenAt = Math.max(
      -1,
      ...open.filter(incident => incident.severity === 'capture-risk').map(incident => incident.lastSeenAt),
    );
    const safe = fresh.some(({ receipt }) => receipt && receipt.capture === 'safe' && receipt.verifiedAt > riskSeenAt);
    return { all, listed, copyRead, recordsRead, open, blind, needsAction, core, atRisk, safe };
  };

  /**
   * A group's cause: its worst problem that needs action, or, with none, its worst member at
   * fault by its receipt, of the members with no open problem (one whose problems were all
   * dismissed says no more); null when nothing in it is at fault
   * @param {{provider: ProviderInfo, receipt: HealthReceipt | null, status: ProviderStatus}[]} members
   * @param {readonly Incident[]} needs - the group's incidents that need action
   * @param {readonly Incident[]} open - every open incident, dismissed ones included
   * @returns {Cause | null}
   */
  const causeOf = (members, needs, open) => {
    const [worst] = worstFirst(needs);
    if (worst) {
      return {
        from: 'incident',
        providerId: worst.providerId,
        faultCode: worst.faultCode,
        errorCode: errorCodeOf(worst),
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
      errorCode: errorCodeOf(faulty.receipt),
      severity: null,
      consequenceKey: faulty.receipt.consequenceKey,
      incidentId: null,
      at: faulty.receipt.verifiedAt,
    };
  };

  /**
   * Sets or clears an incident's dismissal: recovery.dismiss and recovery.undismiss
   * @param {v.GenericSchema} schema
   * @param {boolean} dismissed
   * @returns {(payload: unknown) => Promise<Outcome>}
   */
  const dismissal = (schema, dismissed) => async payload => {
    const checked = v.safeParse(schema, payload);
    if (!checked.success) return rejected('validation', 'invalid-payload');
    const { incidentId, occurrences } = /** @type {{incidentId: string, occurrences?: number}} */ (checked.output);
    try {
      const read = await records.incidentsRead();
      const found = read.incidents.find(incident => incident.id === incidentId);
      // Not found by a read that didn't answer isn't "not there"
      if (!found && !(read.recordsRead && read.copyRead)) return unavailable('storage', 'unreadable', true);
      if (!found || found.state === 'resolved') return rejected('not-found', 'incident-not-found');
      const done = await records.dismissSeen(incidentId, dismissed, occurrences);
      if (done.status === 'done') return committed(dismissed ? 'incident-dismissed' : 'incident-shown', [incidentId]);
      // Sighted since the user saw it: they see it again rather than dismiss what they didn't see
      if (done.status === 'changed') return conflict('incident-changed', done.incident.occurrences);
      if (done.status === 'failed' || records.state() === 'fallback') {
        return unavailable('storage', 'not-recorded', true);
      }
      // Resolved or gone since it was read
      return rejected('not-found', 'incident-not-found');
    } catch (error) {
      return unavailableFrom(error);
    }
  };

  return Object.freeze({
    /** trust.summary */
    async summary() {
      const now = clock.now();
      try {
        const { all, open, blind, needsAction, core, atRisk, safe } = await assess(now);
        const storageDown =
          blind ||
          all.some(({ provider, status }) => provider.id === 'storage' && status === 'failed') ||
          needsAction.some(incident => incident.providerId === 'storage' && incident.faultCode === 'open-failed');
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
            cause: causeOf(members, needs, open),
          };
        }).filter(group => group.providers > 0);
        /** @type {TrustSummary} */
        const summary = {
          worstCore: worstStatus(core.map(({ status }) => status)),
          // While writes fail, nothing proves capture safe
          capture: atRisk ? 'at-risk' : safe && !blind ? 'safe' : 'unknown',
          // While writes fail, or the copy can't be read, something always needs action
          actionRequired: Math.max(needsAction.length, blind ? 1 : 0),
          route: atRisk || storageDown ? 'recovery' : 'trust',
          records: records.state(),
          groups,
        };
        return ready(now, summary);
      } catch (error) {
        return failedFrom(error);
      }
    },

    /** trust.report */
    async report() {
      const now = clock.now();
      try {
        const { all, listed, copyRead, recordsRead, needsAction, atRisk } = await assess(now);
        /** @type {TrustReport} */
        const report = {
          records: records.state(),
          providers: all.map(({ provider, receipt, status }) => {
            const own = needsAction.filter(incident => incident.providerId === provider.id);
            return {
              providerId: provider.id,
              group: provider.group,
              core: provider.core,
              operation: provider.operation,
              costClass: provider.costClass,
              freshnessMs: provider.freshnessMs,
              status,
              receipt,
              // The row's one next action, and what still works beside its problems
              next: nextActionOf({
                providerId: provider.id,
                core: provider.core,
                status,
                receipt,
                incidents: own,
                captureAtRisk: atRisk,
              }),
              stillWorks: /** @type {any} */ (stillWorksOf(receipt, own)),
            };
          }),
          incidents: listed,
          copyRead,
          recordsRead,
          runs: await records.runs(),
        };
        return ready(now, report);
      } catch (error) {
        return failedFrom(error);
      }
    },

    /**
     * recovery.incidents
     * @param {{includeResolved?: boolean}} [payload]
     */
    async incidents({ includeResolved = false } = {}) {
      const now = clock.now();
      try {
        const { incidents: all, copyRead, recordsRead } = await records.incidentsRead();
        /** @param {Incident} incident */
        const rank = incident => (incident.state === 'resolved' ? SEVERITIES.length : SEVERITIES.indexOf(incident.severity));
        const listed = all
          .filter(incident => includeResolved || incident.state !== 'resolved')
          .sort((a, b) => rank(a) - rank(b) || b.lastSeenAt - a.lastSeenAt);
        // Each open problem's card action, from the one picker
        const next = listed
          .filter(incident => incident.state !== 'resolved')
          .map(incident => ({ incidentId: incident.id, next: incidentAction(incident) }));
        return ready(now, { incidents: listed, copyRead, recordsRead, next });
      } catch (error) {
        return failedFrom(error);
      }
    },

    /** recovery.dismiss */
    dismiss: dismissal(dismissPayload, true),

    /** recovery.undismiss */
    undismiss: dismissal(undismissPayload, false),

    /**
     * recovery.check: the incident's provider's check, after a repair. Only a pass resolves it.
     * @param {unknown} payload
     * @returns {Promise<Checked | Outcome>}
     */
    async check(payload) {
      const checked = v.safeParse(checkPayload, payload);
      if (!checked.success) return rejected('validation', 'invalid-payload');
      const { incidentId } = checked.output;
      try {
        const read = await records.incidentsRead();
        const found = read.incidents.find(incident => incident.id === incidentId);
        if (!found && !(read.recordsRead && read.copyRead)) return unavailable('storage', 'unreadable', true);
        if (!found) return rejected('not-found', 'incident-not-found');
        /**
         * @param {Checked['result']} result
         * @param {HealthReceipt | null} receipt
         * @param {boolean} [retryable]
         * @returns {Checked}
         */
        const answer = (result, receipt, retryable = false) => ({
          kind: 'checked',
          incidentId,
          providerId: /** @type {any} */ (found.providerId),
          result,
          retryable,
          receiptId: receipt ? receipt.id : null,
        });
        if (found.state === 'resolved') return answer('fixed', null);
        const provider = providers().find(item => item.id === found.providerId);
        // A check that can't see the fault can never say it's gone
        if (!provider || !provider.observes.includes(found.faultCode)) return answer('not-checked', null);
        const ran = await verifyLocked(provider);
        if (!ran.complete) return unavailable('storage', 'not-recorded', true);
        if (ran.outcome !== 'answered') return answer('not-checked', ran.receipt, true);
        const after = await records.incidentsRead();
        // An incident only the settings copy holds is missing from a read that couldn't reach it
        if (!after.recordsRead || !after.copyRead) return unavailable('storage', 'unreadable', true);
        const current = after.incidents.find(incident => incident.id === incidentId);
        // Open incidents are always kept, so one that's gone was resolved and pruned
        if (!current || current.state === 'resolved') return answer('fixed', ran.receipt);
        // Still there only when the check still reports it, or it was sighted while the check ran
        if (ran.still.includes(found.key) || current.occurrences !== found.occurrences) {
          return answer('still-there', ran.receipt);
        }
        // Nothing decided. A check that looked at it but whose resolve couldn't run (the count
        // read before it failed) may decide next time; one that didn't look at it, or looked at
        // one no check resolves (the records' own), won't.
        return answer('not-checked', ran.receipt, lookedAt(ran.looked, found) && !ran.resolveRan);
      } catch (error) {
        return unavailableFrom(error);
      }
    },

    /** recovery.copies */
    async copies() {
      const now = clock.now();
      try {
        const context = /** @type {Record<string, any>} */ (registry.context || {});
        /** @type {Copy[]} */
        const copies = [];
        let pointsRead = false;
        let copiesRead = false;
        const recovery = context.recovery;
        if (recovery && typeof recovery.points === 'function') {
          /** @type {unknown} */
          let listed = null;
          try {
            listed = await recovery.points();
          } catch {
            listed = null;
          }
          if (Array.isArray(listed)) {
            pointsRead = true;
            // Which run made each pre-repair point; a run list that won't read names none
            const runs = await records.runs().catch(() => []);
            for (const point of listed) {
              if (!point || typeof point !== 'object' || !v.is(pointId, point.id)) continue;
              const pointKind = point.id.startsWith('pre-repair-') ? 'pre-repair' : 'pre-migration';
              const run = pointKind === 'pre-repair' ? runs.find(item => item.recoveryPointId === point.id) : undefined;
              const verified = point.status === 'verified';
              copies.push({
                id: point.id,
                kind: 'recovery-point',
                pointKind,
                at: Number.isSafeInteger(point.createdAt) && point.createdAt >= 0 ? point.createdAt : null,
                verified,
                madeBy: run ? { runId: run.id, remediationId: run.commandId } : null,
                actions: verified ? ['save-recovery-file'] : [],
              });
            }
          }
        }
        const settings = context.settings;
        if (settings && typeof settings.getKeys === 'function') {
          /** @type {unknown} */
          let keys = null;
          try {
            keys = await settings.getKeys();
          } catch {
            keys = null;
          }
          if (Array.isArray(keys)) {
            copiesRead = true;
            for (const key of keys) {
              if (typeof key !== 'string' || !LEGACY_COPY_KEY.test(key)) continue;
              const at = Number(key.slice(key.lastIndexOf('_') + 1));
              copies.push({
                id: /** @type {any} */ (key),
                kind: 'legacy-copy',
                pointKind: null,
                at: Number.isSafeInteger(at) ? at : null,
                // 1.4.x never verified a copy
                verified: false,
                madeBy: null,
                actions: ['save-recovery-file'],
              });
            }
          }
        }
        copies.sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
        return ready(now, { copies: copies.slice(0, MAX_COPIES), pointsRead, copiesRead });
      } catch (error) {
        return failedFrom(error);
      }
    },

    /**
     * trust.verify
     * @param {unknown} payload
     */
    async verify(payload) {
      const checked = v.safeParse(verifyPayload, payload);
      if (!checked.success) return rejected('validation', 'invalid-payload');
      const { providerIds, trigger } = checked.output;
      const chosen = providers().filter(
        provider => (!providerIds || providerIds.includes(provider.id)) && runsOn(provider.costClass, trigger),
      );
      try {
        /** @type {string[]} */
        const changed = [];
        let unrecorded = 0;
        for (const provider of chosen) {
          const { receipt, complete } = await verifyLocked(provider);
          if (receipt) changed.push(receipt.id);
          if (!complete) unrecorded++;
        }
        // A check any part of which the store wouldn't take is never reported as recorded
        if (unrecorded > 0) return unavailable('storage', 'not-recorded', true);
        return committed('trust-verified', changed, changed.length === 0 ? { severity: 'info' } : {});
      } catch (error) {
        return unavailableFrom(error);
      }
    },

    /**
     * recovery.raise
     * @param {unknown} payload
     */
    async raise(payload) {
      const checked = v.safeParse(raisePayload, payload);
      if (!checked.success) return rejected('validation', 'invalid-payload');
      const { type, commandId, ...input } = checked.output;
      try {
        const { incident, held, recorded } = await records.raise(input);
        // Held in memory and the settings copy until NewTabNoteTrust takes writes again: its own
        // kind, so no caller reads it as a committed write
        if (!recorded && held && incident) return heldOutcome(incident.id);
        // Not recorded and not held: the write-failed incident counts it
        if (!recorded || !incident) return unavailable('storage', 'not-recorded', true);
        note('incident.raised', {
          incidentId: incident.id,
          providerId: incident.providerId,
          faultCode: incident.faultCode,
          severity: incident.severity,
          count: incident.occurrences,
        });
        return committed('incident-raised', [incident.id]);
      } catch (error) {
        return unavailableFrom(error);
      }
    },

    /** diagnostics.export */
    async exportDiagnostics() {
      try {
        const exported = await buildDiagnostics({ records, journal, clock, versions, migrations });
        note('diagnostics.exported', { records: exported.fields.length, bytes: exported.bytes });
        return exported;
      } catch (error) {
        return unavailableFrom(error);
      }
    },
  });
}

/** @typedef {ReturnType<typeof createTrustUseCases>} TrustUseCases */
