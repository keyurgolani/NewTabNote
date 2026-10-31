// #20 slice 2's recovery readiness (AC4): verified by reading the newest verified #17 recovery
// point of each kind back and matching it (#17's verifyPoint), `degraded` when one no longer
// matches, `unverified` with none, whatever legacy copies the profile keeps, and the reader
// writing nothing and making no recovery database.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createRecoveryReader } from '../../js/kernel/adapters/indexeddb/health.js';
import { ROWS_STORE, committed, openRecovery } from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { countLegacyCopies, newestVerified, recoveryReadiness } from '../../js/trust/core/providers/recovery-readiness.js';
import { KeyRange, dump, legacyEnv, run } from './migration-support.mjs';
import { freshProfile, settingsOf } from './trust-provider-support.mjs';
import { manualClock, realTimers } from './trust-support.mjs';

/** @typedef {import('./trust-provider-support.mjs').Profile} Profile */

/**
 * @param {Profile} of
 */
const readerOn = of => createRecoveryReader({ indexedDB: of.faults.factory, keyRange: KeyRange, crypto: /** @type {any} */ (webcrypto) });

/**
 * Recovery readiness's check on `of`
 * @param {Profile} of
 */
const checkOn = of =>
  runCheck(
    {
      id: 'recovery-readiness',
      operation: 'recovery.verify-newest-points',
      observes: ['point-unverified'],
      costClass: 'local-expensive',
      timeoutMs: 60_000,
      freshnessMs: 60_000,
      check: context => recoveryReadiness.check(context),
    },
    { context: { recovery: readerOn(of), settings: settingsOf(of) }, clock: manualClock(), timers: realTimers },
  );

/** A 1.4.x profile with a note, which #17's run copies into a verified pre-migration point */
async function migratedProfile() {
  const of = freshProfile();
  await legacyEnv.createDatabase(of.real, {
    records: {
      canvases: [{ id: '1730000000000-abc', name: 'Groceries', createdAt: 1, updatedAt: 1 }],
      elements: [{ id: '1730000000001-def', canvasId: '1730000000000-abc', type: 'text', content: 'Milk' }],
    },
  });
  const outcome = await run(/** @type {any} */ (of));
  assert.equal(outcome.status, 'migrated');
  return of;
}

describe('recovery readiness (#20 slice 2)', () => {
  it('is unverified with no verified point, counting legacy copies without reading their values, and makes no database', async () => {
    const of = freshProfile();
    of.chrome.local.auto_backup_1730000000000 = { notes: ['canary-note'] };
    of.chrome.local.recovery_backup_1730000000001 = { notes: [] };
    of.chrome.local.setting_theme = 'dark';
    const { receipt } = await checkOn(of);
    assert.deepEqual([receipt.status, receipt.evidence], ['unverified', { count: 0, records: 2 }]);
    assert.deepEqual((await of.real.databases()).map(database => database.name), []);
    // Without chrome.storage.local.getKeys the count is left out, never read off the values
    assert.equal(await countLegacyCopies({ get: async () => ({}) }), null);
  });

  it("verifies once #17's run made a verified point, and reads it back writing nothing", async () => {
    const of = await migratedProfile();
    const before = JSON.stringify(await dump(/** @type {any} */ (of)));
    const { receipt, faults } = await checkOn(of);
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.evidence.count, 1);
    assert.equal(typeof receipt.evidence.verifiedAt, 'number');
    assert.deepEqual(faults, []);
    assert.equal(JSON.stringify(await dump(/** @type {any} */ (of))), before);
  });

  it('is degraded, with a point-unverified incident, once the point no longer matches, and keeps the point', async () => {
    const of = await migratedProfile();
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    const tx = recovery.transaction(ROWS_STORE, 'readwrite');
    const done = committed(tx);
    const store = tx.objectStore(ROWS_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) cursor.update({ ...cursor.value, value: { ...cursor.value.value, name: 'Changed' } });
    };
    await done;
    recovery.close();
    const { receipt, faults } = await checkOn(of);
    assert.equal(receipt.status, 'degraded');
    assert.deepEqual([receipt.evidence.count, receipt.evidence.attempts, receipt.evidence.errorCode], [0, 1, 'record-mismatch']);
    assert.deepEqual(faults.map(fault => [fault.faultCode, fault.subjectId, fault.severity]), [
      ['point-unverified', 'NewTabNoteRecovery', 'data-risk'],
    ]);
    assert.equal((await readerOn(of).points()).length, 1, 'the check discarded a point');
  });

  it('takes the newest verified point of each kind, never one still copying or failed', () => {
    const points = [
      { id: 'a', kind: 'pre-migration', status: 'verified', createdAt: 1, verifiedAt: 2 },
      { id: 'b', kind: 'pre-migration', status: 'verified', createdAt: 3, verifiedAt: 4 },
      { id: 'c', kind: 'pre-migration', status: 'copying', createdAt: 5, verifiedAt: null },
      { id: 'd', kind: 'pre-restore', status: 'failed', createdAt: 6, verifiedAt: null },
    ];
    assert.deepEqual(newestVerified(points).map(point => point.id), ['b']);
  });
});
