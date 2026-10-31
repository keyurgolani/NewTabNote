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
 *   `failed` on any other failure that isn't retryable, such as CanvasTabDB not opening, and
 *   `degraded` (capture still safe) when the probe commits while NewTabNoteTrust takes no
 *   writes. The integrity scan's findings and open conflicts that would also make it
 *   `degraded` come with #17's later PRs, which add them.
 *
 * Each observes the faults it reports (`quota`, `version-too-new`, `probe-failed`), so a later
 * answer that no longer reports one resolves it. Storage also observes `open-failed`: a probe
 * that opened CanvasTabDB resolves slice 1b's `storage/open-failed/CanvasTabDB`, and one that
 * found it won't open reports that incident. The records' own `open-failed` for
 * NewTabNoteTrust is never a check's to resolve.
 *
 * A retryable failure (a blocked upgrade, an open still pending, a transient abort) verified
 * nothing either way, so it's `unverified` with its code. A record already under the probe's
 * key is never touched: the probe stops, writes nothing, and reports `unverified`, and so does a
 * read-back that differs (`probe-readback-mismatch`).
 */

import { committed, rejected, unavailableFrom, unknown } from '../../../kernel/core/contracts/outcomes.js';
import { failureEvidence, portOf } from './context.js';

/** @typedef {import('../../../kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../../kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../../kernel/core/ports/repository.js').Work} Work */
/** @typedef {import('../../../kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../checks.js').CheckResult} CheckResult */

/**
 * The key a probe writes under: an array, which no note, block, or folder key can be, since
 * every release and the kernel (isId) key them by strings, so an imported record can't take it
 */
export const PROBE_KEY = Object.freeze(['ntn-trust-probe']);

/** The commandId a probe's work carries: neither adapter keeps one (idempotency: false), and a probe isn't a command */
const PROBE_COMMAND_ID = 'trust-probe';

/**
 * What a probe that committed looked at: every fault it observes, on CanvasTabDB, which it
 * opened, so Storage's includes slice 1b's `storage/open-failed/CanvasTabDB`. One that failed
 * looked at nothing beyond the fault it reports, and one that verified nothing, at nothing, so
 * neither resolves anything.
 * @param {readonly string[]} [also]
 * @returns {NonNullable<CheckResult['looked']>}
 */
const lookedAll = (also = []) =>
  ['quota', 'version-too-new', 'probe-failed', ...also].map(faultCode => ({ faultCode, subjectId: 'CanvasTabDB' }));

/** Open failures, which Storage reports as slice 1b's worker does: `open-failed` on CanvasTabDB */
const OPEN_CODES = Object.freeze(['open-failed', 'missing-core-stores', 'no-database']);

/** The failures that need the user, not a retry: a full disk, or a newer build's database */
const ACTION_CODES = Object.freeze(['quota', 'version-too-new']);

/** Whether `record` is the probe's own */
const isProbe = (/** @type {unknown} */ record) =>
  record !== null &&
  typeof record === 'object' &&
  JSON.stringify(/** @type {{id?: unknown}} */ (record).id) === JSON.stringify(PROBE_KEY);

/**
 * Writes, reads back, and deletes the probe record in each of `stores`, in one transaction. It
 * changes no entity (`changedIds` is empty), so a commit log that appends one entry per changed
 * entity, as #17's PR 2 will, gets none. A commit that answers without running the unit, or
 * replays an earlier answer, didn't verify anything, and answers `unknown`.
 * @param {KernelAdapter} adapter
 * @param {StoreName[]} stores
 * @returns {Promise<Outcome>}
 */
export async function probeCommit(adapter, stores) {
  const key = /** @type {string} */ (/** @type {unknown} */ ([...PROBE_KEY]));
  let ran = false;
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
            ran = false;
            for (const store of stores) {
              if ((await tx.get(store, key)) !== undefined) return rejected('validation', 'probe-record-present');
            }
            for (const store of stores) tx.put(store, /** @type {any} */ ({ id: [...PROBE_KEY] }));
            for (const store of stores) {
              if (!isProbe(await tx.get(store, key))) return rejected('validation', 'probe-readback-mismatch');
            }
            for (const store of stores) tx.delete(store, key);
            ran = true;
            return undefined;
          },
        },
      ],
    },
    done: () => committed('trust-probe', [], { severity: 'info' }),
  };
  const { outcome, replayed } = await adapter.commit(work);
  if (outcome.kind === 'committed' && (replayed || !ran)) return unknown('probe-not-run', PROBE_COMMAND_ID);
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
    if (!failure) return { status: 'verified', capture: 'safe', looked: lookedAll() };
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
    if (!failure) {
      // NewTabNoteTrust is storage too: while it won't take writes, the records layer holds
      // its `storage/open-failed/NewTabNoteTrust` incident, and this check says so rather than
      // verify. A verified receipt resolves that incident only once NewTabNoteTrust took it.
      const trust = /** @type {{state?: unknown} | undefined} */ (context.trust);
      if (trust && typeof trust.state === 'function' && trust.state() === 'fallback') {
        return {
          status: 'degraded',
          capture: 'safe',
          evidence: { subjectId: 'NewTabNoteTrust' },
          consequenceKey: 'storage.trust-records-unavailable',
          preserved: ['capture', 'editing', 'reading'],
          looked: lookedAll(['open-failed']),
        };
      }
      return { status: 'verified', capture: 'safe', looked: lookedAll(['open-failed']) };
    }
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
          // A database that won't open is the incident slice 1b's worker raises, keyed alike
          faultCode: failure.code !== null && OPEN_CODES.includes(failure.code) ? 'open-failed' : 'probe-failed',
          subjectId: 'CanvasTabDB',
          severity: 'capture-risk',
          affected: ['capture', 'editing', 'reading'],
        },
      ],
    };
  },
});
