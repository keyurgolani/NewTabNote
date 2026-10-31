/**
 * Capture and Storage, the two core providers (#20, "Providers"), each verified by a real write
 * through the context's repository adapter: the same commit path, transaction rules, and
 * failure codes every command gets (#17's adapter or #12's legacy one, whichever the root
 * opened). A probe writes a `trust-probe` record, reads it back, and deletes it, all in one
 * readwrite transaction, so the database holds after it exactly what it held before, and no
 * other context ever sees the record. It passes only on commit.
 *
 * - Capture probes what a capture writes, the `notes` and `blocks` stores, after reading the
 *   Daily Note template setting the way captureToDailyNote does first. It says whether capture
 *   is safe: `at-risk` on any failure that isn't retryable, since with #17's capture journal
 *   not merged yet (#17 slice 2) nothing else keeps a capture. The journal backlog, the journal
 *   probe, and "degraded but safe when only CanvasTabDB fails" come with that journal.
 * - Storage probes the `notes` store. `action-required` on `quota` or `version-too-new`,
 *   `failed` on any other failure that isn't retryable, such as CanvasTabDB not opening. The
 *   integrity scan's findings and open conflicts that would make it `degraded` come with #17's
 *   later PRs, which add them.
 *
 * A retryable failure (a blocked upgrade, an open still pending, a transient abort) verified
 * nothing either way, so it's `unverified` with its code. A record already under the probe's
 * key is never touched: the probe stops, writes nothing, and reports `unverified`.
 */

import { committed, rejected, unavailableFrom } from '../../../kernel/core/contracts/outcomes.js';
import { failureEvidence, portOf } from './context.js';

/** @typedef {import('../../../kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../../kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../../kernel/core/ports/repository.js').Work} Work */
/** @typedef {import('../../../kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../checks.js').CheckResult} CheckResult */

/** The key a probe writes under, which no note, block, or folder id can be */
export const PROBE_KEY = 'trust-probe';

/** The commandId a probe's work carries: no adapter keeps one (idempotency: false), and a probe isn't a command */
const PROBE_COMMAND_ID = 'trust-probe';

/** The failures that need the user, not a retry: a full disk, or a newer build's database */
const ACTION_CODES = Object.freeze(['quota', 'version-too-new']);

/**
 * Writes, reads back, and deletes the probe record in each of `stores`, in one transaction
 * @param {KernelAdapter} adapter
 * @param {StoreName[]} stores
 * @returns {Promise<Outcome>}
 */
export async function probeCommit(adapter, stores) {
  /** @type {Work} */
  const work = {
    commandId: PROBE_COMMAND_ID,
    // A probe isn't a catalog command: nothing reads this beyond an adapter with idempotency,
    // and neither adapter has it
    command: /** @type {any} */ ({ type: 'trust.probe', commandId: PROBE_COMMAND_ID }),
    effect: {
      kind: 'units',
      units: [
        {
          stores,
          async run(tx) {
            for (const store of stores) {
              if ((await tx.get(store, PROBE_KEY)) !== undefined) return rejected('validation', 'probe-record-present');
            }
            for (const store of stores) tx.put(store, /** @type {any} */ ({ id: PROBE_KEY }));
            for (const store of stores) {
              const back = /** @type {{id?: unknown} | undefined} */ (await tx.get(store, PROBE_KEY));
              if (!back || back.id !== PROBE_KEY) return rejected('validation', 'probe-record-present');
            }
            for (const store of stores) tx.delete(store, PROBE_KEY);
            return undefined;
          },
        },
      ],
    },
    done: () => committed('trust-probe', [], { severity: 'info' }),
  };
  const { outcome } = await adapter.commit(work);
  return outcome;
}

/**
 * What a probe that didn't commit means: `null` when it committed
 * @param {Outcome} outcome
 * @returns {{kind: 'action' | 'failed' | 'unverified', evidence: {cause?: string, errorCode?: string}, code: string | null} | null}
 */
function failureOf(outcome) {
  if (outcome.kind === 'committed') return null;
  if (outcome.kind === 'unavailable') {
    const evidence = failureEvidence(outcome);
    if (ACTION_CODES.includes(outcome.code)) return { kind: 'action', evidence, code: outcome.code };
    return { kind: outcome.retryable ? 'unverified' : 'failed', evidence, code: outcome.code };
  }
  // Rejected (a record under the probe's key), a conflict, or unknown: nothing was verified
  const code = 'code' in outcome ? outcome.code : null;
  return { kind: 'unverified', evidence: failureEvidence({ code }), code };
}

/** Capture's check */
export const capture = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {Promise<CheckResult>}
   */
  async check(context) {
    const adapter = portOf(context, 'storage');
    // A capture reads the Daily Note template setting before its units run, so a settings
    // area that fails it fails the capture
    /** @type {Outcome} */
    let outcome;
    try {
      await adapter.readSettings('preferences', ['dailyNoteTemplate']);
      outcome = await probeCommit(adapter, ['notes', 'blocks']);
    } catch (error) {
      outcome = unavailableFrom(error);
    }
    const failure = failureOf(outcome);
    if (!failure) return { status: 'verified', capture: 'safe' };
    if (failure.kind === 'unverified') return { status: 'unverified', evidence: failure.evidence };
    const faultCode = failure.code === 'quota' || failure.code === 'version-too-new' ? failure.code : 'probe-failed';
    return {
      status: failure.kind === 'action' ? 'action-required' : 'failed',
      capture: 'at-risk',
      evidence: { ...failure.evidence, subjectId: 'CanvasTabDB' },
      consequenceKey: 'storage.capture-at-risk',
      faults: [{ faultCode, subjectId: 'CanvasTabDB', severity: 'capture-risk', affected: ['capture'] }],
    };
  },
});

/** Storage's check */
export const storage = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {Promise<CheckResult>}
   */
  async check(context) {
    const adapter = portOf(context, 'storage');
    /** @type {Outcome} */
    let outcome;
    try {
      outcome = await probeCommit(adapter, ['notes']);
    } catch (error) {
      outcome = unavailableFrom(error);
    }
    const failure = failureOf(outcome);
    if (!failure) return { status: 'verified', capture: 'safe' };
    if (failure.kind === 'unverified') return { status: 'unverified', evidence: failure.evidence };
    if (failure.kind === 'action') {
      const faultCode = /** @type {'quota' | 'version-too-new'} */ (failure.code);
      return {
        status: 'action-required',
        capture: 'at-risk',
        evidence: { ...failure.evidence, subjectId: 'CanvasTabDB' },
        consequenceKey: `storage.${faultCode}`,
        faults: [{ faultCode, subjectId: 'CanvasTabDB', severity: 'capture-risk', affected: ['capture', 'editing'] }],
      };
    }
    return {
      status: 'failed',
      capture: 'at-risk',
      evidence: { ...failure.evidence, subjectId: 'CanvasTabDB' },
      consequenceKey: 'storage.unavailable',
      faults: [
        {
          faultCode: failure.code === 'open-failed' ? 'open-failed' : 'probe-failed',
          subjectId: 'CanvasTabDB',
          severity: 'capture-risk',
          affected: ['capture', 'editing', 'reading'],
        },
      ],
    };
  },
});
