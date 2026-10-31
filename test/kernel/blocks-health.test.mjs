// #14 slice 1 ("Diagnostics"): the block-health query joins #20's `block-types` provider. A root
// that passes its block registry as `blocks` gets the types the block contract disables
// counted too, beside the ones the kit didn't resolve; the counts are all the receipt holds; and
// an answer that isn't counts verifies nothing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBlockRegistry } from '../../js/kernel/composition/blocks.js';
import { BUILT_IN_BLOCKS } from '../../js/kernel/core/blocks/builtins.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { manualClock, realTimers } from './trust-support.mjs';

/** @typedef {import('../../js/kernel/core/blocks/builtins.js').BlockDescriptor} BlockDescriptor */
/** @typedef {import('../../js/trust/core/checks.js').CheckRun} CheckRun */

const text = /** @type {BlockDescriptor} */ (BUILT_IN_BLOCKS.find(descriptor => descriptor.id === 'text'));

/**
 * The block-types provider's check, run into a receipt against `context`
 * @param {Readonly<Record<string, unknown>>} context
 * @returns {Promise<CheckRun>}
 */
async function blockTypesCheck(context) {
  const descriptor = /** @type {any} */ (PROVIDERS.find(candidate => candidate.id === 'block-types'));
  const implementation = /** @type {any} */ (await descriptor.load());
  return runCheck(
    { ...descriptor, check: (/** @type {Readonly<Record<string, unknown>>} */ given) => implementation.check(given) },
    { context, clock: manualClock(), timers: realTimers },
  );
}

/**
 * A root's context with its block registry: the kit's resolution, and the health query
 * @param {readonly unknown[]} descriptors
 * @param {{joined?: boolean}} [options]
 */
function contextOf(descriptors, { joined = true } = {}) {
  const registry = createBlockRegistry({ host: 'workspace', descriptors });
  return joined
    ? { resolutions: () => [registry.resolution], blocks: registry }
    : { resolutions: () => [registry.resolution] };
}

/** A definition the kit resolves and the block contract refuses: text's, with no defaults */
const lacking = (() => {
  const model = /** @type {Record<string, unknown>} */ ({ ...text.implementation });
  delete model.defaults;
  return { ...text, id: 'lacking', rank: 1007, implementation: model };
})();

describe("the block-health query in #20's block-types provider (#14 slice 1)", () => {
  it('verifies the 18 built-ins, all enabled', async () => {
    const { receipt, faults } = await blockTypesCheck(contextOf(BUILT_IN_BLOCKS));
    assert.deepEqual([receipt.status, receipt.evidence], ['verified', { records: 18, count: 0 }]);
    assert.deepEqual(faults, []);
  });

  it('counts a type the kit resolved but the block contract disabled, which the kit alone would miss', async () => {
    const descriptors = [...BUILT_IN_BLOCKS, lacking];
    const joined = await blockTypesCheck(contextOf(descriptors));
    assert.deepEqual([joined.receipt.status, joined.receipt.evidence], ['degraded', { records: 19, count: 1 }]);
    assert.deepEqual(joined.faults.map(fault => [fault.faultCode, fault.severity]), [['contribution-unavailable', 'degraded']]);
    const kitOnly = await blockTypesCheck(contextOf(descriptors, { joined: false }));
    assert.equal(kitOnly.receipt.status, 'verified');
  });

  it("keeps the kit's count when it's the higher one: a duplicate is two rows the kit refused", async () => {
    const { receipt } = await blockTypesCheck(contextOf([...BUILT_IN_BLOCKS, text]));
    assert.deepEqual([receipt.status, receipt.evidence], ['degraded', { records: 19, count: 2 }]);
  });

  it("records unverified for an answer that isn't the query's counts", async () => {
    const { resolutions } = contextOf(BUILT_IN_BLOCKS);
    for (const answer of [{ types: 1, disabled: 2 }, { types: -1, disabled: 0 }, { types: 1.5, disabled: 0 }, { types: '18', disabled: 0 }, null, 'ok']) {
      const { receipt, outcome } = await blockTypesCheck({ resolutions, blocks: { health: () => answer } });
      assert.deepEqual([outcome, receipt.status], ['threw', 'unverified'], JSON.stringify(answer));
    }
  });

  it('is not-configured while no root registers the block family, health query or not', async () => {
    const blocks = createBlockRegistry({ host: 'workspace' });
    const { receipt } = await blockTypesCheck({ resolutions: () => [], blocks });
    assert.equal(receipt.status, 'not-configured');
  });

  it('puts only counts in the receipt, never a type id or a definition', async () => {
    const { receipt } = await blockTypesCheck(contextOf([...BUILT_IN_BLOCKS, lacking]));
    assert.deepEqual(Object.keys(receipt.evidence ?? {}).sort(), ['count', 'records']);
    assert.equal(JSON.stringify(receipt).includes('lacking'), false);
  });
});
