// The contract suite on the in-memory adapter, which has all three flags, plus what only
// the in-memory adapter does: running transactions one at a time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { runContractSuite } from './contract.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../js/kernel/core/ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../../js/kernel/core/ports/repository.js').Work} Work */

/** @type {import('./support.mjs').ContractFixture} */
const memoryFixture = {
  name: 'memory',
  flags: Object.freeze({ atomicMultiStore: true, revisions: true, idempotency: true }),
  async start() {
    /** @type {Array<StoreName | SettingsArea>} */
    const failing = [];
    const adapter = createMemoryAdapter({
      beforeWrite(target) {
        const index = failing.indexOf(target);
        if (index === -1) return;
        failing.splice(index, 1);
        throw new UnavailableError('storage', 'write-failed', true);
      },
    });
    const clock = testClock();
    const ids = testIds();
    /** @param {import('./support.mjs').Caller} caller */
    const kernel = caller => createKernel({ adapter, policy: createBaselinePolicy(), caller, ids, clock });
    return {
      adapter,
      clock,
      ids,
      kernel: (caller = CALLERS.newtab) => kernel(caller),
      // The in-memory adapter is one store, so a second context shares it
      secondContext: async () => ({
        kernel: (caller = CALLERS.newtab) => kernel({ ...caller, contextId: `${caller.contextId}-second` }),
      }),
      failNextWrite: target => {
        failing.push(target);
      },
      close: async () => {},
    };
  },
};

runContractSuite(memoryFixture);

describe('the in-memory adapter', () => {
  /**
   * @param {string} commandId
   * @param {(log: string[]) => Promise<void>} body
   * @returns {Work}
   */
  const work = (commandId, body) => ({
    commandId,
    command: { type: 'runStartupMaintenance', commandId },
    effect: { kind: 'units', units: [{ stores: ['notes'], run: async () => body(log) }] },
    done: () => ({
      kind: 'committed',
      code: 'test',
      changedIds: [],
      messageKey: 'committed.test',
      severity: 'success',
    }),
  });
  /** @type {string[]} */
  const log = [];

  it('runs transactions one at a time, in the order they open', async () => {
    const adapter = createMemoryAdapter();
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const first = adapter.commit(
      work('w1', async entries => {
        entries.push('first started');
        await gate;
        entries.push('first finished');
      }),
    );
    const read = adapter.read(['notes'], async () => {
      log.push('read');
    });
    const second = adapter.commit(
      work('w2', async entries => {
        entries.push('second');
      }),
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(log, ['first started']);
    release();
    await Promise.all([first, read, second]);
    assert.deepEqual(log, ['first started', 'first finished', 'read', 'second']);
  });

  it("keeps a conflicted command and doesn't keep an unavailable outcome, so a resend runs", async () => {
    let fail = true;
    const adapter = createMemoryAdapter({
      beforeWrite() {
        if (fail) throw new UnavailableError('quota', 'quota-exceeded', false);
      },
    });
    const kernel = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds(),
      clock: testClock(),
    });
    const create = { type: 'createNote', commandId: 'c1', noteId: 'n1' };
    const failed = await kernel.execute(/** @type {any} */ (create));
    assert.deepEqual(failed.kind === 'unavailable' && [failed.cause, failed.code, failed.retryable], [
      'quota',
      'quota-exceeded',
      false,
    ]);
    fail = false;
    assert.equal((await kernel.execute(/** @type {any} */ (create))).kind, 'committed');
  });

  it('refuses a write in a read-only unit and an unknown store', async () => {
    const adapter = createMemoryAdapter();
    const outcome = await adapter.commit({
      commandId: 'w1',
      command: { type: 'runStartupMaintenance', commandId: 'w1' },
      effect: {
        kind: 'units',
        units: [
          {
            stores: ['notes'],
            mode: 'readonly',
            async run(tx) {
              tx.put('notes', { id: 'n1' });
            },
          },
        ],
      },
      done: () => ({
        kind: 'committed',
        code: 'test',
        changedIds: [],
        messageKey: 'committed.test',
        severity: 'success',
      }),
    });
    assert.deepEqual(outcome.kind === 'unavailable' && outcome.code, 'write-in-readonly-transaction');
    await assert.rejects(
      adapter.read(/** @type {any} */ (['nowhere']), async () => undefined),
      /unknown-store/,
    );
  });

  it("refuses a store outside the unit's or the read's stores, as IndexedDB does", async () => {
    const adapter = createMemoryAdapter();
    const outcome = await adapter.commit({
      commandId: 'w1',
      command: { type: 'runStartupMaintenance', commandId: 'w1' },
      effect: {
        kind: 'units',
        units: [
          {
            stores: ['notes'],
            async run(tx) {
              await tx.get('blocks', 'b1');
            },
          },
        ],
      },
      done: () => ({
        kind: 'committed',
        code: 'test',
        changedIds: [],
        messageKey: 'committed.test',
        severity: 'success',
      }),
    });
    assert.deepEqual(outcome.kind === 'unavailable' && outcome.code, 'store-outside-transaction');
    await assert.rejects(
      adapter.read(['notes'], tx => tx.getAll('folders')),
      /store-outside-transaction/,
    );
  });
});
