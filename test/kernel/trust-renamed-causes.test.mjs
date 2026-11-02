// #17 PR 4a moves the new tab onto #17's adapter, whose failure codes (adapters/indexeddb/
// failures.js) replace the legacy adapter's for every command the tab sends. A chrome.storage.local
// write the automatic backup couldn't make answered `transaction-failed` there, and answers
// `settings-write-failed` here; `quota` is the same on both. A dismissal holds until the problem
// changes, and a sighting that names another cause is a change (incidents.js, changesProblem),
// so a dismissed incident can show once more after the update, on its next failure. The lead's
// call (#20's owner): declare it, and pin it here.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { openRecords, trustProfile } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

/**
 * What the automatic backup's failure event raises (event-codes.js, `backup.auto-failed`), with
 * the evidence a failed chrome.storage.local write gives it
 * @param {string} errorCode
 */
const autoBackupFailed = errorCode => ({
  providerId: 'backup',
  faultCode: 'auto-backup-failed',
  severity: /** @type {const} */ ('data-risk'),
  evidence: { cause: 'storage', errorCode, retryable: errorCode !== 'quota' },
});

describe("a dismissed incident across #17 PR 4a's renamed failure codes", () => {
  it('comes back once when its cause code was renamed, then stays dismissed while that code repeats', async () => {
    const store = createMemoryTrustStore();
    opened.push(store);
    const { records, clock } = await openRecords(store, trustProfile());
    /** @param {string} errorCode */
    const sighted = async errorCode => {
      clock.advance(1000);
      const { incident } = await records.raise(autoBackupFailed(errorCode));
      return incident;
    };
    const dismiss = async (/** @type {string} */ id) => {
      clock.advance(1000);
      assert.ok(await records.dismiss(id, true));
    };

    // Before the update: the legacy adapter's code, dismissed, and the same code again keeps it
    const first = await sighted('transaction-failed');
    assert.ok(first);
    await dismiss(first.id);
    assert.equal((await sighted('transaction-failed'))?.dismissed, true);

    // After it: #17's adapter's code for the same failure is another cause, so it shows once more
    assert.equal((await sighted('settings-write-failed'))?.dismissed, false);
    assert.equal((await sighted('settings-write-failed'))?.dismissed, false);
    await dismiss(first.id);
    for (let i = 0; i < 3; i++) assert.equal((await sighted('settings-write-failed'))?.dismissed, true);
    const [incident] = await records.incidents();
    assert.deepEqual([incident.id, incident.dismissedCause], [first.id, 'settings-write-failed']);
  });

  it('a dismissed quota incident stays dismissed, since quota is the same code on both adapters', async () => {
    const store = createMemoryTrustStore();
    opened.push(store);
    const { records, clock } = await openRecords(store, trustProfile());
    clock.advance(1000);
    const { incident } = await records.raise(autoBackupFailed('quota'));
    assert.ok(incident);
    clock.advance(1000);
    assert.ok(await records.dismiss(incident.id, true));
    for (let i = 0; i < 3; i++) {
      clock.advance(1000);
      assert.equal((await records.raise(autoBackupFailed('quota'))).incident?.dismissed, true);
    }
  });
});
