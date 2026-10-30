/**
 * One provider's check, run into a receipt (#20, AC1 and "Where checks run"). A provider's
 * implementation answers `check(context)` with a CheckResult: a status a receipt can store,
 * allowlisted evidence, and the faults it found, each of which becomes an incident. The
 * receipt it makes carries the provider's declared verification operation, when it was
 * verified, how long the check took, and how long the receipt stays fresh.
 *
 * A check that takes longer than the provider's `timeoutMs` records `unverified`, never
 * `failed`, and so does one that throws or answers something this can't read: nothing was
 * verified, which isn't the same as a failure. Only a provider marked `core` may say whether
 * capture is safe. Scheduling (one check per provider under Web Lock `trust.check.<id>`,
 * cheap ones on open, expensive ones on Verify now or idle) is slice 2's, with the real
 * providers.
 */

import * as v from '../../lib/valibot/index.mjs';
import { code } from '../../kernel/core/contracts/fields.js';
import { evidenceSchema, opaqueId } from './evidence.js';
import { capabilities, consequenceKey } from './records.js';
import { CAPTURE_STATES, RECEIPT_STATUSES, SEVERITIES } from './vocabulary.js';

/** @typedef {import('./ports.js').Clock} Clock */
/** @typedef {import('./ports.js').Timers} Timers */
/** @typedef {import('./trust-records.js').ReceiptInput} ReceiptInput */
/** @typedef {import('./trust-records.js').RaiseInput} RaiseInput */
/** @typedef {import('./vocabulary.js').CostClass} CostClass */

/** A fault a check found: one incident, keyed by the provider, the fault, and its subject */
export const faultSchema = v.strictObject({
  faultCode: code,
  subjectId: v.optional(v.nullable(opaqueId)),
  severity: v.picklist(SEVERITIES),
  affected: v.optional(capabilities),
  preserved: v.optional(capabilities),
});

/** What a check answers */
export const checkResultSchema = v.strictObject({
  status: v.picklist(RECEIPT_STATUSES),
  capture: v.optional(v.picklist(CAPTURE_STATES)),
  evidence: v.optional(evidenceSchema),
  consequenceKey: v.optional(v.nullable(consequenceKey)),
  preserved: v.optional(capabilities),
  nextAction: v.optional(v.nullable(opaqueId)),
  faults: v.optional(v.pipe(v.array(faultSchema), v.maxLength(32))),
});

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
 * @property {(context: Readonly<Record<string, unknown>>) => unknown} check
 */

/**
 * What one check made: its receipt, and the incidents it raises
 * @typedef {{receipt: ReceiptInput, faults: RaiseInput[], outcome: 'answered' | 'timed-out' | 'threw' | 'invalid'}} CheckRun
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
        .then(() => provider.check(context))
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
      outcome: 'timed-out',
    };
  }
  if (answer.kind === 'threw') {
    const evidence = answer.exception ? { errorCode: 'check-threw', exception: answer.exception } : { errorCode: 'check-threw' };
    return { receipt: { ...base, status: 'unverified', evidence }, faults: [], outcome: 'threw' };
  }
  const parsed = v.safeParse(checkResultSchema, answer.value);
  if (!parsed.success || (parsed.output.capture !== undefined && provider.core !== true)) {
    return { receipt: { ...base, status: 'unverified', evidence: { errorCode: 'invalid-check-result' } }, faults: [], outcome: 'invalid' };
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
  return { receipt, faults, outcome: 'answered' };
}

/**
 * An error's name when it's an Error or DOMException name, never its message
 * @param {unknown} error
 * @returns {string | null}
 */
export function exceptionOf(error) {
  if (error === null || typeof error !== 'object') return null;
  const name = /** @type {{name?: unknown}} */ (error).name;
  return typeof name === 'string' && /^[A-Z][A-Za-z0-9]{0,63}$/.test(name) ? name : null;
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
