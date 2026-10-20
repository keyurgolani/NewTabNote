// The baseline policy allows exactly what each surface could do before the kernel, and
// rejects everything else.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS } from './support.mjs';

/** @typedef {import('../../js/kernel/core/ports/policy.js').Surface} Surface */

// Written out by hand, so a change to BASELINE_CAPABILITIES has to change this too
/** @type {Record<Surface, {commands: string[] | 'all', queries: string[] | 'all'}>} */
const TODAY = {
  newtab: { commands: 'all', queries: 'all' },
  popup: { commands: ['createNote'], queries: 'all' },
  sidepanel: { commands: [], queries: 'all' },
  worker: { commands: ['captureToDailyNote', 'runStartupMaintenance'], queries: [] },
};

describe('the baseline policy', () => {
  const policy = createBaselinePolicy();

  it("allows each surface exactly today's commands and reads", () => {
    for (const [surface, allowed] of /** @type {Array<[Surface, (typeof TODAY)[Surface]]>} */ (Object.entries(TODAY))) {
      for (const type of COMMAND_TYPES) {
        const expected = allowed.commands === 'all' || allowed.commands.includes(type);
        assert.deepEqual(
          policy.authorize({ type }, CALLERS[surface]),
          expected ? { allowed: true } : { allowed: false, code: 'not-on-surface' },
          `${surface} ${type}`,
        );
      }
      for (const type of QUERY_TYPES) {
        const expected = allowed.queries === 'all' || allowed.queries.includes(type);
        assert.deepEqual(
          policy.authorizeQuery({ type }, CALLERS[surface]),
          expected ? { allowed: true } : { allowed: false, code: 'not-on-surface' },
          `${surface} ${type}`,
        );
      }
    }
  });

  it('rejects a command or query the catalog lacks, from every surface', () => {
    for (const caller of Object.values(CALLERS)) {
      assert.deepEqual(policy.authorize({ type: 'listNotes' }, caller), { allowed: false, code: 'unknown-command' });
      assert.deepEqual(policy.authorize({ type: 'toString' }, caller), { allowed: false, code: 'unknown-command' });
      assert.deepEqual(policy.authorize({}, caller), { allowed: false, code: 'unknown-command' });
      assert.deepEqual(policy.authorizeQuery({ type: 'createNote' }, caller), {
        allowed: false,
        code: 'unknown-query',
      });
    }
  });

  it('rejects a caller that is not one of the four surfaces', () => {
    for (const caller of [
      undefined,
      null,
      {},
      { surface: 'newtab' },
      { surface: 'newtab', contextId: '' },
      { surface: 'options', contextId: 'x' },
    ]) {
      assert.deepEqual(
        policy.authorize({ type: 'createNote' }, /** @type {any} */ (caller)),
        { allowed: false, code: 'unknown-caller' },
        JSON.stringify(caller),
      );
    }
  });
});
