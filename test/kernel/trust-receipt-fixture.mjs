// The `health` family's `truthful-receipt` conformance fixture (#20 slice 1, AC4), which every
// health provider declares: its id is registered, and its check, run against the context a
// root would inject, makes a receipt the schema takes, with its declared operation and
// freshness and allowlisted evidence. Slice 1's fixture providers and slice 2's real and
// interim ones both run it, through #15's conformance suite.

import assert from 'node:assert/strict';
import * as v from '../../js/lib/valibot/index.mjs';

import { runCheck } from '../../js/trust/core/checks.js';
import { PROVIDER_IDS } from '../../js/trust/core/codes.js';
import { checkEvidence } from '../../js/trust/core/evidence.js';
import { receiptSchema } from '../../js/trust/core/records.js';
import { manualClock, realTimers } from './trust-support.mjs';

/** @typedef {import('../../js/kernel/registry/resolve.js').Contribution} Contribution */
/** @typedef {import('../../js/trust/core/checks.js').CheckRun} CheckRun */

/**
 * The fixture's runner, checking each provider's receipt against `context`. `answers` makes it
 * also require the check to have answered (not timed out or thrown), and `then` sees each run.
 * @param {{context?: Readonly<Record<string, unknown>>, answers?: boolean, then?: (contribution: Contribution, run: CheckRun) => void}} [options]
 * @returns {(contribution: Contribution, implementation: unknown) => Promise<void>}
 */
export function truthfulReceipt({ context = {}, answers = false, then } = {}) {
  return async (contribution, implementation) => {
    const data = /** @type {Record<string, any>} */ (contribution.data);
    // A provider's id is registered with it, or none of its receipts could be written
    assert.ok(PROVIDER_IDS.includes(/** @type {string} */ (contribution.id)), `${contribution.ref} isn't in PROVIDER_IDS`);
    const clock = manualClock();
    const run = await runCheck(
      {
        id: /** @type {string} */ (contribution.id),
        operation: data.operation,
        costClass: data.costClass,
        timeoutMs: data.timeoutMs,
        freshnessMs: data.freshnessMs,
        core: data.core === true,
        check: given => /** @type {any} */ (implementation).check(given),
      },
      { context, clock, timers: realTimers },
    );
    const receipt = {
      ...run.receipt,
      id: '00000000-0000-4000-8000-000000000001',
      installId: '00000000-0000-4000-8000-000000000002',
      transition: true,
    };
    assert.ok(v.is(receiptSchema, receipt), `${contribution.ref} made a receipt outside the schema`);
    assert.equal(receipt.operation, data.operation, 'a receipt carries its declared operation');
    assert.equal(receipt.freshnessMs, data.freshnessMs, 'a receipt carries its declared freshness');
    assert.ok(checkEvidence(receipt.evidence).ok);
    assert.notEqual(run.outcome, 'invalid', `${contribution.ref} answered something a receipt can't hold`);
    if (answers) assert.equal(run.outcome, 'answered', `${contribution.ref}'s check ${run.outcome} against the context`);
    if (then) then(contribution, run);
  };
}
