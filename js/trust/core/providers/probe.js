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
 * Every capture-risk fault says whether reading still works (slice 4a, the one `preserved`
 * list): after a probe that didn't commit, one readonly read of the probe's key tries, and
 * `reading` goes in the fault's `preserved` when it answered, in its `affected` when it didn't,
 * and the receipt's `preserved` says the same. The read has its own deadline (READ_WITHIN_MS,
 * on the context's timers), so one that never answers counts as not reading, and the finding
 * still lands well inside the check's timeout.
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

/** The faults a migration below the latest version stands for, which storage's check looks at whenever it read the state */
const MIGRATION_FAULTS = Object.freeze(['migration-pending', 'migration-failed', 'migration-blocked']);

/** @returns {NonNullable<CheckResult['looked']>} */
const lookedMigration = () => MIGRATION_FAULTS.map(faultCode => ({ faultCode, subjectId: 'CanvasTabDB' }));

/**
 * The migration fault CanvasTabDB's state stands for, or null when it's at the latest version
 * (or there's none, which the probe reports). Throws on an answer it can't read, so storage
 * verifies nothing then.
 * @param {unknown} state
 * @returns {'migration-pending' | 'migration-failed' | 'migration-blocked' | null}
 */
function migrationFaultOf(state) {
  if (state === null || typeof state !== 'object') throw new TypeError('not a migration state');
  const { version, latest, status, blocked } = /** @type {Record<string, unknown>} */ (state);
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(latest) || (status !== null && typeof status !== 'string')) {
    throw new TypeError('not a migration state');
  }
  if (/** @type {number} */ (version) === 0 || /** @type {number} */ (version) >= /** @type {number} */ (latest)) return null;
  // The worker's marker: its run's upgrade waits on another connection now
  if (blocked === true || status === 'space-blocked') return 'migration-blocked';
  if (status === 'failed' || status === 'refused') return 'migration-failed';
  // No run recorded yet, one in progress or waiting on an open page, or a record from before
  // the database was replaced at an older version
  return 'migration-pending';
}

/**
 * Storage's answer while CanvasTabDB waits below the latest version: `degraded`, with the
 * migration fault, and capture safe only when the probe committed on capture's path
 * @param {'migration-pending' | 'migration-failed' | 'migration-blocked'} faultCode
 * @param {boolean} committed
 * @returns {CheckResult}
 */
function migrationResult(faultCode, committed) {
  /** @type {CheckResult} */
  const result = {
    status: 'degraded',
    evidence: { subjectId: 'CanvasTabDB' },
    consequenceKey: `storage.${faultCode}`,
    preserved: ['capture', 'editing', 'reading'],
    faults: [{ faultCode, subjectId: 'CanvasTabDB', severity: 'degraded', preserved: ['capture', 'editing', 'reading'] }],
    looked: committed ? [...lookedAll(['open-failed']), ...lookedMigration()] : lookedMigration(),
  };
  if (committed) result.capture = 'safe';
  return result;
}

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
    // A versioned open below 9 isn't the path capture uses there: it probed nothing, so it's
    // never a failed probe (the connection answers it unretryable once the open was refused)
    if (outcome.code === 'migration-required') return { kind: 'unverified', evidence, code: outcome.code };
    return { kind: outcome.retryable ? 'unverified' : 'failed', evidence, code: outcome.code };
  }
  // Rejected (a record under the probe's key), a conflict, or unknown: nothing was verified
  const code = 'code' in outcome ? outcome.code : null;
  return { kind: 'unverified', evidence: failureEvidence({ code }), code };
}

/** How long the read after a failed probe may take before it counts as not reading */
export const READ_WITHIN_MS = 1000;

/**
 * Whether reading still works after a probe that didn't commit: one readonly read of the
 * probe's key, which no record holds, answered within READ_WITHIN_MS when the context has
 * timers (checks.js passes them), or not
 * @param {KernelAdapter} adapter
 * @param {Readonly<Record<string, unknown>>} context
 */
async function readsStill(adapter, context) {
  const key = /** @type {string} */ (/** @type {unknown} */ ([...PROBE_KEY]));
  const read = adapter.read(['notes'], tx => tx.get('notes', key)).then(
    () => true,
    () => false,
  );
  const timers = /** @type {import('../ports.js').Timers | undefined} */ (context.timers);
  if (!timers || typeof timers.set !== 'function') return read;
  /** @type {unknown} */
  let handle;
  const late = new Promise(resolve => {
    handle = timers.set(() => resolve(false), READ_WITHIN_MS);
  });
  try {
    return /** @type {boolean} */ (await Promise.race([read, late]));
  } finally {
    timers.clear(handle);
  }
}

/**
 * A capture-risk fault's capabilities: `broken`, and reading in whichever list the read put it
 * @param {readonly ('capture' | 'editing')[]} broken
 * @param {boolean} reads
 * @returns {{affected: ('capture' | 'editing' | 'reading')[], preserved: 'reading'[]}}
 */
const riskTo = (broken, reads) => ({
  affected: reads ? [...broken] : [...broken, 'reading'],
  preserved: reads ? ['reading'] : [],
});

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
    const risk = riskTo(['capture'], await readsStill(adapter, context));
    return {
      status: failure.kind === 'action' ? 'action-required' : 'failed',
      capture: 'at-risk',
      evidence: { ...failure.evidence, subjectId: 'CanvasTabDB' },
      consequenceKey: 'storage.capture-at-risk',
      preserved: risk.preserved,
      faults: [{ faultCode, subjectId: 'CanvasTabDB', severity: 'capture-risk', ...risk }],
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
    const reader = portOf(context, 'migration');
    // Below the latest version capture works on the database as it is, so a migration that
    // hasn't happened is storage's own state, never a failed probe. A state it can't read is
    // unknown: it probes anyway, so a database that won't open still fails, and it looks at
    // no migration fault
    /** @type {ReturnType<typeof migrationFaultOf>} */
    let migration = null;
    let known = true;
    try {
      migration = migrationFaultOf(await reader.current());
    } catch {
      known = false;
    }
    const lookedKnown = () => (known ? lookedMigration() : []);
    /** @type {Outcome} */
    let outcome;
    try {
      outcome = await probeCommit(adapter, ['notes']);
    } catch (error) {
      outcome = unavailableFrom(error);
    }
    // A versioned open below 9: the adapter isn't capture's path, so it probed nothing capture uses
    if (outcome.kind === 'unavailable' && outcome.code === 'migration-required') {
      return migrationResult(migration || 'migration-pending', false);
    }
    const failure = failureOf(outcome);
    if (!failure && migration) return migrationResult(migration, true);
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
          looked: [...lookedAll(['open-failed']), ...lookedKnown()],
        };
      }
      // At the latest version: a migration that stood before is done, so its fault is looked at and gone
      return { status: 'verified', capture: 'safe', looked: [...lookedAll(['open-failed']), ...lookedKnown()] };
    }
    if (failure.kind === 'unverified') return { status: 'unverified', evidence: failure.evidence };
    const risk = riskTo(['capture', 'editing'], await readsStill(adapter, context));
    if (failure.kind === 'action') {
      const faultCode = /** @type {'quota' | 'version-too-new'} */ (failure.code);
      return {
        status: 'action-required',
        capture: 'at-risk',
        evidence: { ...failure.evidence, subjectId: 'CanvasTabDB' },
        consequenceKey: `storage.${faultCode}`,
        preserved: risk.preserved,
        faults: [{ faultCode, subjectId: 'CanvasTabDB', severity: 'capture-risk', ...risk }],
      };
    }
    return {
      status: 'failed',
      capture: 'at-risk',
      evidence: { ...failure.evidence, subjectId: 'CanvasTabDB' },
      consequenceKey: 'storage.unavailable',
      preserved: risk.preserved,
      faults: [
        {
          // A database that won't open is the incident slice 1b's worker raises, keyed alike
          faultCode: failure.code !== null && OPEN_CODES.includes(failure.code) ? 'open-failed' : 'probe-failed',
          subjectId: 'CanvasTabDB',
          severity: 'capture-risk',
          ...risk,
        },
      ],
    };
  },
});
