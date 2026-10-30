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
import { committed, failedFrom, ready, rejected, unavailableFrom } from '../../kernel/core/contracts/outcomes.js';
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
 */

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
   * Runs one provider's check and stores what it found
   * @param {ProviderInfo} provider
   * @returns {Promise<HealthReceipt>}
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
      journal.event('trust.check-timed-out', {
        providerId: provider.id,
        durationMs: run.receipt.durationMs,
        timeoutMs: provider.timeoutMs,
      });
    } else if (run.outcome !== 'answered') {
      const exception = run.receipt.evidence.exception;
      journal.event('trust.check-failed', {
        providerId: provider.id,
        durationMs: run.receipt.durationMs,
        errorCode: run.outcome === 'invalid' ? 'invalid-check-result' : 'check-threw',
        ...(typeof exception === 'string' ? { exception } : {}),
      });
    }
    const receipt = await records.record(run.receipt);
    for (const fault of run.faults) await records.raise(fault);
    if (receipt.status === 'verified') {
      const still = run.faults.map(fault => incidentKey(fault.providerId, fault.faultCode, fault.subjectId));
      for (const incident of await records.resolve(provider.id, still)) {
        journal.event('incident.resolved', {
          incidentId: incident.id,
          providerId: incident.providerId,
          faultCode: incident.faultCode,
        });
      }
    }
    return receipt;
  };

  return Object.freeze({
    /** trust.summary */
    async summary() {
      const now = clock.now();
      try {
        const all = await statuses(now);
        const open = (await records.incidents()).filter(incident => incident.state !== 'resolved');
        const needsAction = open.filter(incident => !incident.dismissed);
        const core = all.filter(({ provider }) => provider.core);
        const fresh = core.filter(({ status }) => status !== 'stale');
        const atRisk =
          fresh.some(({ receipt }) => receipt && receipt.capture === 'at-risk') ||
          open.some(incident => incident.severity === 'capture-risk');
        const safe = fresh.some(({ receipt }) => receipt && receipt.capture === 'safe');
        const storageDown =
          records.state() === 'fallback' ||
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
          capture: atRisk ? 'at-risk' : safe ? 'safe' : 'unknown',
          actionRequired: needsAction.length,
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
          incidents: await records.incidents(),
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
        const all = await records.incidents();
        /** @param {Incident} incident */
        const rank = incident => (incident.state === 'resolved' ? SEVERITIES.length : SEVERITIES.indexOf(incident.severity));
        const listed = all
          .filter(incident => includeResolved || incident.state !== 'resolved')
          .sort((a, b) => rank(a) - rank(b) || b.lastSeenAt - a.lastSeenAt);
        return ready(now, { incidents: listed });
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
        for (const provider of chosen) {
          const one = () => verifyOne(provider);
          const receipt = locks ? await locks.request(`trust.check.${provider.id}`, one) : await one();
          changed.push(receipt.id);
        }
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
        const { incident } = await records.raise(input);
        journal.event('incident.raised', {
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
        journal.event('diagnostics.exported', { records: exported.preview.length, bytes: exported.bytes });
        return exported;
      } catch (error) {
        return unavailableFrom(error);
      }
    },
  });
}

/** @typedef {ReturnType<typeof createTrustUseCases>} TrustUseCases */
