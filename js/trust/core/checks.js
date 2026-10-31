/**
 * One provider's check, run into a receipt (#20, AC1 and "Where checks run"). A provider's
 * implementation answers `check(context)` with a CheckResult: a status a receipt can store,
 * allowlisted evidence, the faults it found, each of which becomes an incident, and `looked`:
 * the faults it really looked for, from reads that succeeded. The receipt it makes carries the
 * provider's declared verification operation, when it was verified, how long the check took,
 * and how long the receipt stays fresh.
 *
 * `looked` is what lets a check resolve: only the provider's open incidents that match an
 * entry, that the check no longer reports, and that had no new sighting while it ran (their
 * occurrences unchanged since just before it) resolve.
 * An entry names a fault from the provider's `observes`, and a subject when the check looked
 * at that subject only (no `subjectId` means every subject; `null` the incident without one).
 * A check that couldn't read leaves the fault out, and a missing or empty `looked` resolves
 * nothing, so an `unverified` answer after a failed read never reads as an all clear. The
 * records' own incidents (`open-failed` for NewTabNoteTrust, `write-failed`) never resolve
 * through a check, whatever `looked` says. A result
 * whose `faults` or `looked` names a fault outside `observes` is answered as outside the
 * schema.
 *
 * A check that takes longer than the provider's `timeoutMs` records `unverified`, never
 * `failed`, and so does one that throws or answers something this can't read: nothing was
 * verified, which isn't the same as a failure. Only a provider marked `core` may say whether
 * capture is safe. Scheduling (one check per provider under Web Lock `trust.check.<id>`,
 * cheap ones on open, expensive ones on Verify now or idle) is slice 2's, with the real
 * providers.
 */

import * as v from '../../lib/valibot/index.mjs';
import { EXCEPTION_NAMES } from './codes.js';
import { evidenceSchema, faultCode, remediationId, subjectId } from './evidence.js';
import { capabilities, consequenceKey } from './records.js';
import { CAPTURE_STATES, RECEIPT_STATUSES, SEVERITIES } from './vocabulary.js';

/** @typedef {import('./ports.js').Clock} Clock */
/** @typedef {import('./ports.js').Timers} Timers */
/** @typedef {import('./trust-records.js').ReceiptInput} ReceiptInput */
/** @typedef {import('./trust-records.js').RaiseInput} RaiseInput */
/** @typedef {import('./vocabulary.js').CostClass} CostClass */

/** A fault a check found: one incident, keyed by the provider, the fault, and its subject */
export const faultSchema = v.strictObject({
  faultCode,
  subjectId: v.optional(v.nullable(subjectId)),
  severity: v.picklist(SEVERITIES),
  affected: v.optional(capabilities),
  preserved: v.optional(capabilities),
});

/** A fault a check looked for: every subject, or the one it names */
export const lookedSchema = v.strictObject({
  faultCode,
  subjectId: v.optional(v.nullable(subjectId)),
});

/** What a check answers */
export const checkResultSchema = v.strictObject({
  status: v.picklist(RECEIPT_STATUSES),
  capture: v.optional(v.picklist(CAPTURE_STATES)),
  evidence: v.optional(evidenceSchema),
  consequenceKey: v.optional(v.nullable(consequenceKey)),
  preserved: v.optional(capabilities),
  nextAction: v.optional(v.nullable(remediationId)),
  faults: v.optional(v.pipe(v.array(faultSchema), v.maxLength(32))),
  looked: v.optional(v.pipe(v.array(lookedSchema), v.maxLength(64))),
});

/** @typedef {v.InferOutput<typeof lookedSchema>} Looked */

/** @typedef {v.InferOutput<typeof checkResultSchema>} CheckResult */

/**
 * A provider as a check runs it: its descriptor's fields and its implementation's check
 * @typedef {object} RunnableProvider
 * @property {string} id
 * @property {string} operation
 * @property {CostClass} costClass
 * @property {number} timeoutMs
 * @property {number} freshnessMs
 * @property {boolean} [core]
 * @property {readonly string[]} [observes] - the faults its check may report or look for
 * @property {(context: Readonly<Record<string, unknown>>) => unknown} check
 */

/**
 * What one check made: its receipt, the incidents it raises, and what it looked for
 * @typedef {{receipt: ReceiptInput, faults: RaiseInput[], looked: Looked[], outcome: 'answered' | 'timed-out' | 'threw' | 'invalid'}} CheckRun
 */

/**
 * Runs `provider`'s check once
 * @param {RunnableProvider} provider
 * @param {{context?: Readonly<Record<string, unknown>>, clock: Clock, timers: Timers}} options
 * @returns {Promise<CheckRun>}
 */
export async function runCheck(provider, { context = {}, clock, timers }) {
  const started = clock.now();
  /** @type {unknown} */
  let handle;
  /** @type {Promise<{kind: 'timed-out'}>} */
  const timeout = new Promise(resolve => {
    handle = timers.set(() => resolve({ kind: 'timed-out' }), provider.timeoutMs);
  });
  /** @type {{kind: 'answered', value: unknown} | {kind: 'threw', exception: string | null} | {kind: 'timed-out'}} */
  let answer;
  try {
    answer = await Promise.race([
      Promise.resolve()
        // The check's timers, so a step inside it can bound itself; a root's own wins
        .then(() => provider.check(context.timers ? context : { ...context, timers }))
        .then(
          value => /** @type {const} */ ({ kind: 'answered', value }),
          error => ({ kind: /** @type {const} */ ('threw'), exception: exceptionOf(error) }),
        ),
      timeout,
    ]);
  } finally {
    timers.clear(handle);
  }
  const durationMs = Math.max(0, clock.now() - started);
  /** @type {Omit<ReceiptInput, 'status' | 'evidence'>} */
  const base = {
    providerId: provider.id,
    verifiedAt: started,
    durationMs,
    freshnessMs: provider.freshnessMs,
    operation: provider.operation,
    consequenceKey: null,
    preserved: [],
    nextAction: null,
    executionClass: provider.costClass,
  };
  if (answer.kind === 'timed-out') {
    return {
      receipt: { ...base, status: 'unverified', evidence: { errorCode: 'check-timed-out', timeoutMs: provider.timeoutMs } },
      faults: [],
      looked: [],
      outcome: 'timed-out',
    };
  }
  if (answer.kind === 'threw') {
    const evidence = answer.exception ? { errorCode: 'check-threw', exception: answer.exception } : { errorCode: 'check-threw' };
    return { receipt: { ...base, status: 'unverified', evidence }, faults: [], looked: [], outcome: 'threw' };
  }
  const parsed = v.safeParse(checkResultSchema, answer.value);
  const observes = provider.observes || [];
  if (
    !parsed.success ||
    (parsed.output.capture !== undefined && provider.core !== true) ||
    !(parsed.output.faults || []).every(fault => observes.includes(fault.faultCode)) ||
    !(parsed.output.looked || []).every(item => observes.includes(item.faultCode)) ||
    !distinct((parsed.output.looked || []).map(item => `${item.faultCode}/${item.subjectId === undefined ? '*' : item.subjectId}`))
  ) {
    return {
      receipt: { ...base, status: 'unverified', evidence: { errorCode: 'invalid-check-result' } },
      faults: [],
      looked: [],
      outcome: 'invalid',
    };
  }
  const result = parsed.output;
  /** @type {ReceiptInput} */
  const receipt = {
    ...base,
    status: result.status,
    evidence: result.evidence || {},
    consequenceKey: result.consequenceKey ?? null,
    preserved: result.preserved || [],
    nextAction: result.nextAction ?? null,
  };
  if (result.capture !== undefined) receipt.capture = result.capture;
  const faults = (result.faults || []).map(fault => ({
    providerId: provider.id,
    faultCode: fault.faultCode,
    subjectId: fault.subjectId ?? null,
    severity: fault.severity,
    affected: fault.affected || [],
    preserved: fault.preserved || [],
    evidence: {},
  }));
  const looked = (result.looked || []).map(item =>
    item.subjectId === undefined ? { faultCode: item.faultCode } : { faultCode: item.faultCode, subjectId: item.subjectId },
  );
  return { receipt, faults, looked, outcome: 'answered' };
}

/**
 * Whether every item is there once
 * @param {string[]} items
 */
const distinct = items => new Set(items).size === items.length;

/**
 * An error's name when it's one of the known Error and DOMException names (codes.js), never
 * its message, and never a name an error was given that isn't one of them
 * @param {unknown} error
 * @returns {string | null}
 */
export function exceptionOf(error) {
  if (error === null || typeof error !== 'object') return null;
  const name = /** @type {{name?: unknown}} */ (error).name;
  return typeof name === 'string' && EXCEPTION_NAMES.includes(name) ? name : null;
}

/**
 * A receipt's status as it reads at `now`: `stale` once it's past its window or dated in the
 * future, otherwise what it stored
 * @param {{status: string, verifiedAt: number, freshnessMs: number}} receipt
 * @param {number} now
 * @returns {import('./vocabulary.js').ProviderStatus}
 */
export function effectiveStatus(receipt, now) {
  if (receipt.verifiedAt > now || now - receipt.verifiedAt > receipt.freshnessMs) return 'stale';
  return /** @type {import('./vocabulary.js').ProviderStatus} */ (receipt.status);
}
