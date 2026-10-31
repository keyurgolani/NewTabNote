// The contract suite on the in-memory adapter, which has all three flags, plus what only
// the in-memory adapter does: running transactions one at a time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';
import { createMemoryLedger } from '../../js/kernel/core/memory/ledger.js';
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
      conflicts: async () => adapter.conflicts(),
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

  // A resent conflict replays: the contract suite's idempotency cases resend one
  it("doesn't keep an unavailable outcome, so a resend runs", async () => {
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

  it("serves only IDB_SETTINGS_KEYS from idbSettings, as the legacy adapter does from IndexedDB's settings store", async () => {
    const adapter = createMemoryAdapter();
    assert.deepEqual(await adapter.readSettings('idbSettings', ['insightsEnabled']), {});
    await assert.rejects(adapter.readSettings('idbSettings', ['llmApiKey']), { code: 'setting-not-served' });
  });

  it('refuses a write in a read-only unit and an unknown store', async () => {
    const adapter = createMemoryAdapter();
    const { outcome } = await adapter.commit({
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

  it('answers revision only after a get of the same key, as an adapter that keeps it in the record can', async () => {
    const adapter = createMemoryAdapter();
    await assert.rejects(
      adapter.read(['notes'], async tx => tx.revision('notes', 'n1')),
      /revision-before-get/,
    );
    await assert.rejects(
      adapter.read(['notes'], async tx => {
        await tx.get('notes', 'n2');
        return tx.revision('notes', 'n1');
      }),
      /revision-before-get/,
    );
    assert.equal(
      await adapter.read(['notes'], async tx => {
        await tx.get('notes', 'n1');
        return tx.revision('notes', 'n1');
      }),
      undefined,
    );
  });

  it("refuses a store outside the unit's or the read's stores, as IndexedDB does", async () => {
    const adapter = createMemoryAdapter();
    const { outcome } = await adapter.commit({
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

describe("the in-memory adapter, given #13's ledger and commit log", () => {
  /** A kernel over an adapter that writes its records and change entries to a ledger and log */
  const start = () => {
    const ledger = createMemoryLedger();
    const commitLog = createMemoryCommitLog();
    const adapter = createMemoryAdapter({ ledger, commitLog });
    const kernel = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds(),
      clock: testClock(),
    });
    /** @param {Record<string, unknown>} command */
    const execute = command => kernel.execute(/** @type {any} */ (command));
    return { ledger, commitLog, execute };
  };

  it('appends one change per entity a commit changed, with its revision, and puts that commitSeq on the outcome the ledger keeps', async () => {
    const { ledger, commitLog, execute } = start();
    const create = { type: 'createNote', commandId: 'c1', noteId: 'n1', blocks: [{ id: 'b1', content: 'a' }] };
    const folder = { type: 'createFolder', commandId: 'c2', folderId: 'f1', name: 'Work', parentId: null };
    const created = await execute(create);
    const filed = await execute(folder);
    assert.deepEqual(created.kind === 'committed' && [created.commitSeq, created.revision], [1, 1]);
    assert.deepEqual(filed.kind === 'committed' && filed.commitSeq, 2);
    assert.deepEqual(await commitLog.readChangesSince(0, 10), {
      kind: 'changes',
      entries: [
        { commitSeq: 1, entityType: 'note', entityId: 'n1', revision: 1 },
        { commitSeq: 2, entityType: 'folder', entityId: 'f1', revision: 1 },
      ],
      cursor: 2,
      more: false,
    });
    assert.deepEqual(await ledger.read(/** @type {any} */ (create)), { status: 'committed', outcome: created });
    assert.deepEqual(await ledger.read(/** @type {any} */ (folder)), { status: 'committed', outcome: filed });
  });

  it("types each change by the store it wrote, so deleteFolder's notes, filed at the root, go in as notes (#17 PR 2a)", async () => {
    const { commitLog, execute } = start();
    await execute({ type: 'createFolder', commandId: 'c1', folderId: 'f1', name: 'Work', parentId: null });
    await execute({ type: 'createNote', commandId: 'c2', noteId: 'n1', name: 'Filed', folderId: 'f1' });
    const removed = await execute({ type: 'deleteFolder', commandId: 'c3', folderId: 'f1' });
    assert.deepEqual(removed.kind === 'committed' && [removed.changedIds, removed.commitSeq], [['f1', 'n1'], 3]);
    assert.deepEqual(await commitLog.readChangesSince(2, 10), {
      kind: 'changes',
      entries: [
        { commitSeq: 3, entityType: 'folder', entityId: 'f1', revision: 1 },
        { commitSeq: 3, entityType: 'note', entityId: 'n1', revision: 1 },
      ],
      cursor: 3,
      more: false,
    });
  });

  it('appends nothing for a resend, which answers the original outcome, commitSeq included', async () => {
    const { commitLog, execute } = start();
    const pin = { type: 'setPinned', commandId: 'c2', noteId: 'n1', pinned: true };
    await execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
    const first = await execute(pin);
    assert.deepEqual(await execute(pin), first);
    assert.deepEqual(first.kind === 'committed' && first.commitSeq, 2);
    assert.equal(await commitLog.head(), 2);
  });

  it('keeps a conflict in the ledger and appends nothing for it, and keeps no record of a rejection', async () => {
    const { ledger, commitLog, execute } = start();
    await execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', blocks: [{ id: 'b1', content: 'a' }] });
    const stale = {
      type: 'saveNoteContent',
      commandId: 'c2',
      noteId: 'n1',
      blocks: [{ id: 'b1', content: 'b', order: 0 }],
      expectedRevision: 0,
    };
    const lost = await execute(stale);
    assert.equal(lost.kind, 'conflict');
    assert.deepEqual(await ledger.read(/** @type {any} */ (stale)), { status: 'conflict', outcome: lost });
    const missing = { type: 'setPinned', commandId: 'c3', noteId: 'gone', pinned: true };
    assert.equal((await execute(missing)).kind, 'rejected');
    assert.deepEqual(await ledger.read(/** @type {any} */ (missing)), { status: 'absent' });
    assert.equal(await commitLog.head(), 1);
  });

  it('appends nothing for a Daily Note ensureDailyNote finds, and moves no revision', async () => {
    const { commitLog, execute } = start();
    const made = await execute({ type: 'ensureDailyNote', commandId: 'c1', noteId: 'd1' });
    assert.deepEqual(made.kind === 'committed' && [made.code, made.commitSeq, made.revision], [
      'daily-note-created',
      1,
      1,
    ]);
    const found = await execute({ type: 'ensureDailyNote', commandId: 'c2', noteId: 'd2' });
    assert.deepEqual(found.kind === 'committed' && [found.code, found.changedIds, found.commitSeq, found.revision], [
      'daily-note-exists',
      [],
      undefined,
      1,
    ]);
    assert.equal(await commitLog.head(), 1);
    assert.deepEqual(await commitLog.readChangesSince(0, 10), {
      kind: 'changes',
      entries: [{ commitSeq: 1, entityType: 'note', entityId: 'd1', revision: 1 }],
      cursor: 1,
      more: false,
    });
  });

  it('gives a commit that changes no entity, such as a preference, a record but no commitSeq', async () => {
    const { ledger, commitLog, execute } = start();
    const prefer = { type: 'setPreferences', commandId: 'c1', values: { theme: 'dark' } };
    const outcome = await execute(prefer);
    assert.deepEqual(outcome.kind === 'committed' && outcome.commitSeq, undefined);
    assert.equal((await ledger.read(/** @type {any} */ (prefer))).status, 'committed');
    assert.equal(await commitLog.head(), 0);
  });

  it("records each item of a bulk command under its own key, and keeps the bulk key's reservation out of the ledger", async () => {
    const { ledger, commitLog, execute } = start();
    await execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
    await execute({ type: 'createNote', commandId: 'c2', noteId: 'n2' });
    const archive = { type: 'runBulkAction', commandId: 'b1', action: 'archive', noteIds: ['n1', 'n2'] };
    assert.equal((await execute(archive)).kind, 'bulk');
    assert.deepEqual(await ledger.read(/** @type {any} */ (archive)), { status: 'absent' });
    const item = await ledger.read({ type: 'archiveNote', commandId: 'b1:n2', noteId: 'n2' });
    assert.deepEqual(item.status === 'committed' && item.outcome.commitSeq, 4);
    assert.equal(await commitLog.head(), 4);
  });
});
