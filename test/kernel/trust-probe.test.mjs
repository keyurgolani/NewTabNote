// #20 slice 2's core providers, Capture and Storage (AC4): verified by a write that commits
// through the context's repository adapter, #17's and #12's legacy one both, never by a
// setting existing; the probe leaves CanvasTabDB exactly as it found it and never touches a
// record under its key; and each failure the adapter answers maps to its status, capture
// state, and incident.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError, unavailable } from '../../js/kernel/core/contracts/outcomes.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { PROBE_KEY, capture, probeCommit, storage } from '../../js/trust/core/providers/probe.js';
import { dump, legacyEnv, run as migrate } from './migration-support.mjs';
import { adapterOn } from './storage-fixture.mjs';
import { freshProfile } from './trust-provider-support.mjs';
import { manualClock, realTimers } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/checks.js').CheckRun} CheckRun */

/** A migration reader at the latest version, for the probes these tests drive (#20 slice 4 prerequisites, part 2) */
const AT_LATEST = Object.freeze({ current: async () => ({ version: 9, latest: 9, status: 'migrated', code: null }) });

/**
 * A core provider's check, run into a receipt
 * @param {'capture' | 'storage'} id
 * @param {Readonly<Record<string, unknown>>} context
 * @returns {Promise<CheckRun>}
 */
function run(id, context) {
  const check = id === 'capture' ? capture : storage;
  return runCheck(
    {
      id,
      operation: `${id}.probe`,
      observes:
        id === 'storage'
          ? ['quota', 'version-too-new', 'probe-failed', 'open-failed', 'migration-pending', 'migration-failed', 'migration-blocked']
          : ['quota', 'version-too-new', 'probe-failed'],
      costClass: 'local-cheap',
      timeoutMs: 5000,
      freshnessMs: 60_000,
      core: true,
      check: given => check.check(given),
    },
    { context: { migration: AT_LATEST, ...context }, clock: manualClock(), timers: realTimers },
  );
}

/** A note and a block, as 1.4.x stores them */
const NOTE = { id: '1730000000000-abc', name: 'Groceries', blocks: [], createdAt: 1, updatedAt: 1 };
const BLOCK = { id: '1730000000001-def', canvasId: NOTE.id, type: 'text', content: 'Milk' };

describe("capture and storage probe through #17's adapter (#20 slice 2)", () => {
  it('verify on a write that commits, and leave CanvasTabDB holding exactly what it held', async () => {
    const of = freshProfile();
    await legacyEnv.createDatabase(of.real, { records: { canvases: [NOTE], elements: [BLOCK] } });
    of.chrome.local.setting_dailyNoteTemplate = null;
    // #17 PR 1b: only the migration runner upgrades a database, after its point, so it's at this
    // build's version before #17's adapter opens it versioned
    assert.equal((await migrate(of)).status, 'migrated');
    const adapter = adapterOn(of);
    await adapter.open();
    const before = JSON.stringify(await dump(of));
    for (const id of /** @type {const} */ (['capture', 'storage'])) {
      const { receipt, faults } = await run(id, { storage: adapter });
      assert.deepEqual([receipt.status, receipt.capture, faults], ['verified', 'safe', []], id);
    }
    assert.equal(JSON.stringify(await dump(of)), before, 'the probe left something behind');
    adapter.close();
  });

  it('never touches a record already under its key: it stops, writes nothing, and verifies nothing', async () => {
    const of = freshProfile();
    const squatter = { id: PROBE_KEY, name: 'Mine' };
    await legacyEnv.createDatabase(of.real, { records: { canvases: [squatter] } });
    // #17 PR 1b: only the migration runner upgrades a database, after its point, so it's at this
    // build's version before #17's adapter opens it versioned
    assert.equal((await migrate(of)).status, 'migrated');
    const adapter = adapterOn(of);
    await adapter.open();
    const before = JSON.stringify(await dump(of));
    const outcome = await probeCommit(adapter, ['notes']);
    assert.deepEqual([outcome.kind, 'code' in outcome && outcome.code], ['rejected', 'probe-record-present']);
    const { receipt } = await run('storage', { storage: adapter });
    assert.deepEqual([receipt.status, receipt.evidence], ['unverified', { errorCode: 'probe-record-present' }]);
    assert.equal(JSON.stringify(await dump(of)), before);
    adapter.close();
  });

  it('a full disk is action-required with capture at risk, and raises the quota incident', async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    for (const id of /** @type {const} */ (['capture', 'storage'])) {
      of.faults.abortAfterNextWrite('canvases', 'QuotaExceededError');
      const { receipt, faults } = await run(id, { storage: adapter });
      assert.deepEqual([receipt.status, receipt.capture], ['action-required', 'at-risk'], id);
      assert.deepEqual(receipt.evidence, { cause: 'quota', errorCode: 'quota', subjectId: 'CanvasTabDB' });
      assert.deepEqual(
        faults.map(fault => [fault.faultCode, fault.subjectId, fault.severity]),
        [['quota', 'CanvasTabDB', 'capture-risk']],
      );
    }
    adapter.close();
  });

  it("a newer build's database is action-required, version-too-new", async () => {
    const of = freshProfile();
    await legacyEnv.createDatabase(of.real, { version: 99 });
    const adapter = adapterOn(of);
    await adapter.open().catch(() => {});
    const { receipt, faults } = await run('storage', { storage: adapter });
    assert.deepEqual([receipt.status, receipt.capture, receipt.evidence.errorCode], ['action-required', 'at-risk', 'version-too-new']);
    assert.deepEqual(faults.map(fault => fault.faultCode), ['version-too-new']);
    const captured = await run('capture', { storage: adapter });
    assert.deepEqual([captured.receipt.status, captured.faults[0].faultCode], ['action-required', 'version-too-new']);
    adapter.close();
  });

  it('a database that won\'t open is failed, with capture at risk', async () => {
    const of = freshProfile();
    // Popup's open makes no database, so a profile without one can't be probed
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open().catch(() => {});
    for (const id of /** @type {const} */ (['capture', 'storage'])) {
      const { receipt, faults } = await run(id, { storage: adapter });
      assert.deepEqual([receipt.status, receipt.capture], ['failed', 'at-risk'], id);
      assert.equal(receipt.evidence.subjectId, 'CanvasTabDB');
      assert.equal(faults.length, 1);
      assert.equal(faults[0].severity, 'capture-risk');
    }
  });

  it('a template read that throws, as a capture would hit it first, verifies nothing, and its message stays out', async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    const failing = {
      ...adapter,
      readSettings: async () => {
        throw new Error('chrome.storage failed reading a canary-title');
      },
    };
    const { receipt } = await run('capture', { storage: failing });
    assert.deepEqual([receipt.status, receipt.capture], ['unverified', undefined]);
    assert.ok(!JSON.stringify(receipt).includes('canary'));
    adapter.close();
  });

  it('a retryable failure verifies nothing either way: unverified, no incident', async () => {
    const answers = { storage: { commit: async () => ({ outcome: { kind: 'unavailable', cause: 'storage', code: 'blocked-upgrade', retryable: true } }) } };
    const { receipt, faults } = await run('storage', answers);
    assert.deepEqual([receipt.status, receipt.capture, faults], ['unverified', undefined, []]);
    assert.deepEqual(receipt.evidence, { cause: 'storage', errorCode: 'blocked-upgrade' });
  });

  it('storage says degraded, not verified, while NewTabNoteTrust takes no writes', async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    const fallback = { storage: adapter, trust: { incidents: async () => [], state: () => 'fallback' } };
    const { receipt } = await run('storage', fallback);
    assert.deepEqual([receipt.status, receipt.capture, receipt.evidence], ['degraded', 'safe', { subjectId: 'NewTabNoteTrust' }]);
    const open = { storage: adapter, trust: { incidents: async () => [], state: () => 'open' } };
    assert.equal((await run('storage', open)).receipt.status, 'verified');
    adapter.close();
  });
});

describe('storage says why an update waits or failed (#20 slice 4b, the director\'s change 9)', () => {
  it('carries a run short of space as space-short, an upgrade waiting on another connection as blocked-upgrade, and a failed run\'s own code, and a plain wait as none', async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    /** @param {Record<string, unknown>} state */
    const reader = state => ({ current: async () => ({ version: 8, latest: 11, status: null, code: null, blocked: false, ...state }) });
    for (const [state, faultCode, errorCode] of /** @type {const} */ ([
      [{ status: 'space-blocked', code: 'space-short' }, 'migration-blocked', 'space-short'],
      [{ blocked: true }, 'migration-blocked', 'blocked-upgrade'],
      [{ status: 'failed', code: 'schema-mismatch' }, 'migration-failed', 'schema-mismatch'],
      [{}, 'migration-pending', undefined],
    ])) {
      const { receipt, faults } = await run('storage', { storage: adapter, migration: reader(state) });
      assert.deepEqual(
        [receipt.status, receipt.capture, receipt.consequenceKey, receipt.evidence.errorCode, faults.map(fault => fault.faultCode)],
        ['degraded', 'safe', `storage.${faultCode}`, errorCode, [faultCode]],
        JSON.stringify(state),
      );
    }
    // A code no list registers isn't carried
    const { receipt } = await run('storage', { storage: adapter, migration: reader({ status: 'failed', code: 'not-a-code' }) });
    assert.equal(receipt.evidence.errorCode, undefined);
    adapter.close();
  });
});

// #17's adapter never opens again once its connection is gone: after another context's upgrade
// or Chrome's close, every call answers reload-required, which no resend fixes (connection.js).
// The page that holds it reloads to open the database again, so a probe there verified nothing.
describe("a probe on a connection that needs a reload (#20 slice 4b, the lead's call of 2026-10-31 11:55)", () => {
  it("verifies nothing after another context's upgrade closed the connection: unverified with reload-required, never failed, for capture and storage", async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    // A newer build's upgrade, which closes this connection on versionchange
    await new Promise((resolve, reject) => {
      const request = of.real.open('CanvasTabDB', 99);
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
      request.onerror = () => reject(request.error);
    });
    for (const id of /** @type {const} */ (['capture', 'storage'])) {
      const { receipt, faults } = await run(id, { storage: adapter });
      assert.deepEqual([receipt.status, receipt.capture, faults], ['unverified', undefined, []], id);
      assert.deepEqual(receipt.evidence, { cause: 'storage', errorCode: 'reload-required' }, id);
    }
    adapter.close();
  });

  it('verifies nothing on a connection already closed, as one Chrome closed reads', async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    adapter.close();
    for (const id of /** @type {const} */ (['capture', 'storage'])) {
      const { receipt, faults } = await run(id, { storage: adapter });
      assert.deepEqual([receipt.status, faults, receipt.evidence.errorCode], ['unverified', [], 'reload-required'], id);
    }
  });
});

// The legacy adapter's two cases went with it (#17 PR 4a): every root opens #17's adapter, whose
// verify on a committed write is the first case above, and whose transient failure is this one
describe("a probe write #17's adapter can't commit, as a transient UnknownError there and on its one more run (#20 slice 2, #17 PR 4a)", () => {
  it("verifies nothing: unverified, with the code #17's adapter gives a commit whose one more run failed too", async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    // #17's adapter runs a transaction an UnknownError aborted once more, and answers
    // retries-exhausted when that fails too, where the legacy adapter answered transaction-failed
    of.faults.throwOnNextWrite('canvases', 'UnknownError');
    of.faults.throwOnNextWrite('canvases', 'UnknownError');
    const { receipt } = await run('storage', { storage: adapter });
    assert.deepEqual([receipt.status, receipt.evidence], ['unverified', { cause: 'storage', errorCode: 'retries-exhausted' }]);
    adapter.close();
  });
});

// Every code #17's adapter (failures.js), its connection (connection.js) and the memory adapter
// answer a commit with, as each answers it, reads as ruled for both core providers: a full disk
// or a newer build's database needs the user; a failure no resend fixes is failed, with capture
// at risk, but reload-required, which a reload fixes (the lead, 2026-10-31 11:55), and
// migration-required, which isn't capture's path; and one a resend may fix verified nothing.
// The memory adapter refuses the probe's array key itself (invalid-key), so its codes are
// answered here as it answers them, not by it.
describe('every code the adapters answer reads as ruled, for capture and storage (#20 slice 4c)', () => {
  // What a probe reads on `code`: its status, capture state, faults, and the code its receipt carries
  /** @typedef {(code: string) => unknown[]} Reads */
  /** @type {Reads} */
  const ACTION = code => ['action-required', 'at-risk', [code], code];
  /** @type {Reads} */
  const FAILED = code => ['failed', 'at-risk', ['probe-failed'], code];
  /** @type {Reads} */
  const UNVERIFIED = code => ['unverified', undefined, [], code];
  /**
   * A database that won't open, keyed as slice 1b's worker raises it
   * @type {Reads}
   */
  const OPEN_FAILED = code => ['failed', 'at-risk', ['open-failed'], code];
  /**
   * Storage's update waiting: its evidence says why the update waits, and nothing does here
   * @type {Reads}
   */
  const PENDING = () => ['degraded', undefined, ['migration-pending'], undefined];
  /**
   * Each code as an adapter answers it, and what capture and storage read on it
   * @type {Array<[code: string, cause: string, retryable: boolean, capture: Reads, storage: Reads]>}
   */
  const CODES = [
    ['quota', 'quota', false, ACTION, ACTION],
    ['version-too-new', 'newer-schema', false, ACTION, ACTION],
    ['transaction-inactive', 'adapter', false, FAILED, FAILED],
    ['write-in-readonly-transaction', 'adapter', false, FAILED, FAILED],
    ['not-cloneable', 'adapter', false, FAILED, FAILED],
    ['invalid-key', 'adapter', false, FAILED, FAILED],
    ['store-unavailable', 'storage', false, FAILED, FAILED],
    ['constraint', 'storage', false, FAILED, FAILED],
    ['unreadable', 'storage', false, FAILED, FAILED],
    ['transaction-ended-early', 'adapter', false, FAILED, FAILED],
    ['timed-out', 'storage', true, UNVERIFIED, UNVERIFIED],
    ['transaction-failed', 'storage', true, UNVERIFIED, UNVERIFIED],
    ['retries-exhausted', 'storage', true, UNVERIFIED, UNVERIFIED],
    ['adapter-failed', 'adapter', true, UNVERIFIED, UNVERIFIED],
    ['reload-required', 'storage', false, UNVERIFIED, UNVERIFIED],
    ['migration-required', 'storage', true, UNVERIFIED, PENDING],
    ['no-database', 'storage', true, UNVERIFIED, UNVERIFIED],
    ['missing-core-stores', 'storage', false, FAILED, OPEN_FAILED],
    ['open-failed', 'storage', true, UNVERIFIED, UNVERIFIED],
    ['open-pending', 'storage', true, UNVERIFIED, UNVERIFIED],
    ['blocked-upgrade', 'storage', true, UNVERIFIED, UNVERIFIED],
    ['not-open', 'adapter', false, FAILED, FAILED],
    ['unknown-store', 'adapter', false, FAILED, FAILED],
    ['store-outside-transaction', 'adapter', false, FAILED, FAILED],
    ['revision-before-get', 'adapter', false, FAILED, FAILED],
    ['setting-not-served', 'adapter', false, FAILED, FAILED],
  ];

  it('maps each to its status, capture state and fault, and carries the code', async () => {
    for (const [code, cause, retryable, captureReads, storageReads] of CODES) {
      // An adapter whose commit answers the code, and whose reads still answer
      const answering = {
        readSettings: async () => ({}),
        read: async () => undefined,
        commit: async () => ({ outcome: unavailable(/** @type {any} */ (cause), code, retryable), replayed: false }),
      };
      for (const [id, reads] of /** @type {const} */ ([
        ['capture', captureReads],
        ['storage', storageReads],
      ])) {
        const { receipt, faults } = await run(id, { storage: answering });
        assert.deepEqual(
          [receipt.status, receipt.capture, faults.map(fault => fault.faultCode), receipt.evidence.errorCode],
          reads(code),
          `${code}, ${id}`,
        );
      }
    }
  });

  it('reads a template read the adapter answers settings-read-failed for as capture unverified, with its code, and commits nothing', async () => {
    const failing = {
      readSettings: async () => {
        throw new UnavailableError('storage', 'settings-read-failed', true);
      },
      read: async () => undefined,
      commit: async () => {
        throw new Error('the probe committed after its template read failed');
      },
    };
    const { receipt, faults } = await run('capture', { storage: failing });
    assert.deepEqual(
      [receipt.status, receipt.capture, faults, receipt.evidence],
      ['unverified', undefined, [], { cause: 'storage', errorCode: 'settings-read-failed' }],
    );
  });

  it("reads a TransactionInactiveError #17's adapter hits on the probe's write as failed, capture at risk, with reading still working", async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    for (const id of /** @type {const} */ (['capture', 'storage'])) {
      of.faults.throwOnNextWrite('canvases', 'TransactionInactiveError');
      const { receipt, faults } = await run(id, { storage: adapter });
      assert.deepEqual(
        [
          receipt.status,
          receipt.capture,
          receipt.evidence,
          faults.map(fault => [fault.faultCode, fault.severity, fault.preserved]),
        ],
        [
          'failed',
          'at-risk',
          { cause: 'adapter', errorCode: 'transaction-inactive', subjectId: 'CanvasTabDB' },
          [['probe-failed', 'capture-risk', ['reading']]],
        ],
        id,
      );
    }
    adapter.close();
  });
});
