/**
 * The Trust Center's use cases, in-process (#20, "Contracts"): what each catalog operation
 * does, over the records, the journal, and the health providers a registry root resolved.
 * Slice 2 registers handlers on #13's worker router and the Trust and Recovery pages that call
 * these. `recovery.run` has its catalog entry and payload schema here, and slice 3's pipeline
 * is its use case.
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
  failedFrom,
  ready,
  rejected,
  unavailable,
  unavailableFrom,
} from '../../kernel/core/contracts/outcomes.js';
import { effectiveStatus, runCheck } from './checks.js';
import { buildDiagnostics } from './diagnostics.js';
import { payload as raisePayload } from './operations/recovery-raise.js';
import { payload as verifyPayload } from './operations/trust-verify.js';
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
/** @typedef {import('./operations/trust-report.js').TrustReport} TrustReport */

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
 * @property {readonly string[]} observes - the faults its check can observe
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
   * open incidents for the faults it observes and no longer reports; one that timed out,
   * threw, or answered outside the schema resolves nothing. What didn't land is counted in the
   * storage incident.
   * @param {ProviderInfo} provider
   * @returns {Promise<{receipt: HealthReceipt | null, complete: boolean}>}
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
      // Held isn't stored: the check answers not recorded until a write stores it
      const raised = await records.raise(fault);
      if (!raised.recorded) complete = false;
    }
    if (!recorded.recorded) return { receipt: null, complete: false };
    const { receipt } = recorded;
    if (run.outcome === 'answered' && provider.observes.length > 0) {
      const still = run.faults.map(fault => incidentKey(fault.providerId, fault.faultCode, fault.subjectId));
      const resolved = await records.resolve(provider.id, still, { faults: provider.observes });
      if (!resolved.recorded) return { receipt, complete: false };
      for (const incident of resolved.resolved) {
        note('incident.resolved', {
          incidentId: incident.id,
          providerId: incident.providerId,
          faultCode: incident.faultCode,
        });
      }
    }
    return { receipt, complete };
  };

  return Object.freeze({
    /** trust.summary */
    async summary() {
      const now = clock.now();
      try {
        const all = await statuses(now);
        const { incidents: listed, read } = await records.incidentsRead();
        const open = listed.filter(incident => incident.state !== 'resolved');
        // Writes failing, or a settings copy this summary couldn't read: another context may
        // hold something, so nothing is called safe and something needs action
        const blind = records.state() === 'fallback' || !read;
        const needsAction = open.filter(incident => !incident.dismissed);
        const core = all.filter(({ provider }) => provider.core);
        const fresh = core.filter(({ status }) => status !== 'stale');
        const atRisk =
          fresh.some(({ receipt }) => receipt && receipt.capture === 'at-risk') ||
          open.some(incident => incident.severity === 'capture-risk');
        const safe = fresh.some(({ receipt }) => receipt && receipt.capture === 'safe');
        const storageDown =
          blind ||
          all.some(({ provider, status }) => provider.id === 'storage' && status === 'failed') ||
          open.some(incident => incident.providerId === 'storage' && incident.faultCode === 'open-failed');
        const groups = HEALTH_GROUPS.map(group => {
          const members = all.filter(({ provider }) => provider.group === group);
          const ids = members.map(({ provider }) => provider.id);
          return {
            group,
            providers: members.length,
            needsAction: needsAction.filter(incident => ids.includes(incident.providerId)).length,
            worst: worstStatus(members.map(({ status }) => status)),
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
        /** @type {TrustReport} */
        const report = {
          records: records.state(),
          providers: (await statuses(now)).map(({ provider, receipt, status }) => ({
            providerId: provider.id,
            group: provider.group,
            core: provider.core,
            operation: provider.operation,
            costClass: provider.costClass,
            freshnessMs: provider.freshnessMs,
            status,
            receipt,
          })),
          incidents: [],
          copyRead: true,
          runs: await records.runs(),
        };
        const { incidents: listed, read } = await records.incidentsRead();
        report.incidents = listed;
        report.copyRead = read;
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
        const { incidents: all, read } = await records.incidentsRead();
        /** @param {Incident} incident */
        const rank = incident => (incident.state === 'resolved' ? SEVERITIES.length : SEVERITIES.indexOf(incident.severity));
        const listed = all
          .filter(incident => includeResolved || incident.state !== 'resolved')
          .sort((a, b) => rank(a) - rank(b) || b.lastSeenAt - a.lastSeenAt);
        return ready(now, { incidents: listed, copyRead: read });
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
          const one = () => verifyOne(provider);
          const { receipt, complete } = locks ? await locks.request(`trust.check.${provider.id}`, one) : await one();
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
