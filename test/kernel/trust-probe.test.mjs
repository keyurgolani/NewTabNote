// #20 slice 2's core providers, Capture and Storage (AC4): verified by a write that commits
// through the context's repository adapter, #17's and #12's legacy one both, never by a
// setting existing; the probe leaves CanvasTabDB exactly as it found it and never touches a
// record under its key; and each failure the adapter answers maps to its status, capture
// state, and incident.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
