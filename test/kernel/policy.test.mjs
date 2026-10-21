// The baseline policy allows exactly what each surface could do before the kernel, reading
// each catalog entry's surfaces, and rejects everything else.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { QUERIES, QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { SYSTEM_QUERIES } from '../../js/kernel/core/contracts/system.js';
import { SURFACES, createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS } from './support.mjs';

/** @typedef {import('../../js/kernel/core/ports/policy.js').Surface} Surface */

// Written out by hand, so a change to a catalog entry's surfaces has to change this too
/** @type {Record<Surface, {commands: string[] | 'all', queries: string[] | 'all'}>} */
const TODAY = {
  newtab: { commands: 'all', queries: 'all' },
  popup: { commands: ['createNote'], queries: 'all' },
  sidepanel: { commands: [], queries: 'all' },
  offscreen: { commands: [], queries: [] },
  'worker-internal': { commands: ['captureToDailyNote', 'runStartupMaintenance'], queries: [] },
  recovery: { commands: [], queries: [] },
};

describe('the baseline policy', () => {
  const policy = createBaselinePolicy();

  it("allows each surface exactly today's commands and reads", () => {
    assert.deepEqual([...SURFACES].sort(), Object.keys(TODAY).sort());
    for (const [surface, allowed] of /** @type {Array<[Surface, (typeof TODAY)[Surface]]>} */ (Object.entries(TODAY))) {
      for (const [types, list] of /** @type {const} */ ([
        [COMMAND_TYPES, allowed.commands],
        [QUERY_TYPES, allowed.queries],
      ])) {
        for (const type of types) {
          const expected = list === 'all' || list.includes(type);
          assert.deepEqual(
            policy.authorize({ type }, CALLERS[surface]),
            expected ? { allowed: true } : { allowed: false, code: 'not-on-surface' },
            `${surface} ${type}`,
          );
        }
      }
    }
  });

  it("reads the surfaces from each catalog entry, so the entry is the only place they're listed", () => {
    for (const [type, entry] of [...Object.entries(COMMANDS), ...Object.entries(QUERIES)]) {
      for (const surface of SURFACES) {
        assert.equal(
          policy.authorize({ type }, CALLERS[surface]).allowed,
          entry.surfaces.includes(surface),
          `${surface} ${type}`,
        );
      }
    }
    const shared = COMMAND_TYPES.filter(type => /** @type {readonly string[]} */ (QUERY_TYPES).includes(type));
    assert.deepEqual(shared, [], 'a command and a query share a name, so the policy could read the wrong entry');
  });

  it("reads the coordinator's own queries from their entries too, and lets the pages ask for messaging health", () => {
    for (const [type, entry] of Object.entries(SYSTEM_QUERIES)) {
      for (const surface of SURFACES) {
        assert.equal(
          policy.authorize({ type }, CALLERS[surface]).allowed,
          entry.surfaces.includes(surface),
          `${surface} ${type}`,
        );
      }
    }
    const asking = SURFACES.filter(
      surface => policy.authorize({ type: 'system.messagingHealth' }, CALLERS[surface]).allowed,
    );
    assert.deepEqual(asking, ['newtab', 'popup', 'sidepanel', 'recovery']);
  });

  it('rejects a request the catalog lacks, from every surface', () => {
    for (const caller of Object.values(CALLERS)) {
      for (const request of [{ type: 'dropDatabase' }, { type: 'toString' }, { type: '__proto__' }, {}, { type: 7 }]) {
        assert.deepEqual(
          policy.authorize(request, caller),
          { allowed: false, code: 'unknown-operation' },
          JSON.stringify(request),
        );
      }
      assert.deepEqual(policy.authorize(/** @type {any} */ (null), caller), {
        allowed: false,
        code: 'unknown-operation',
      });
    }
  });

  it('rejects a caller that is not one of the surfaces', () => {
    for (const caller of [
      undefined,
      null,
      {},
      { surface: 'newtab' },
      { surface: 'newtab', contextId: '' },
      { surface: 'worker', contextId: 'x' },
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
