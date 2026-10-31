// The service worker's composition root since #17 PR 1b (js/kernel/composition/background.js):
// it runs #17's migration run at worker start and records its outcome; a run short of space
// leaves the database as it was, captures keep working on it, and the next worker start within
// RETRY_AFTER_MS doesn't try again; a blocked upgrade answers blocked-upgrade at once instead
// of leaving a capture waiting, and once the blocker goes the run finishes and captures commit.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import { RETRY_AFTER_MS, UPGRADE_RECORD_KEY, createWorkerClient } from '../../js/kernel/composition/background.js';
import { detectShape, inspect } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { legacyEnv, profileWith, synthesized } from './migration-support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

/** @type {{IDBKeyRange: typeof globalThis.IDBKeyRange}} */
const { IDBKeyRange: KeyRange } = createRequire(import.meta.url)('fake-indexeddb');
const FIXTURES = synthesized();

/** A disk with 1 MB free */
const CRAMPED = async () => ({ quota: 100 * 1024 ** 2, usage: 99 * 1024 ** 2 });

/**
 * The worker's host over `of`
 * @param {Profile} of
 * @param {{estimate?: any}} [options]
 */
const hostOf = (of, { estimate = null } = {}) => ({
  indexedDB: of.real,
  keyRange: KeyRange,
  settings: of.chrome.api.storage.local,
  locks: legacyEnv.createLockManager(),
  estimate,
  crypto: /** @type {any} */ (webcrypto),
});

/** @param {any} worker @param {string} id */
const capture = (worker, id) =>
  worker.execute({
    type: 'captureToDailyNote',
    commandId: `c-${id}`,
    noteId: `d-${id}`,
    blockId: `b-${id}`,
    capture: { type: 'text', content: id },
  });

/** @param {Profile} of */
const recoveryExists = async of =>
  (await of.real.databases()).some((/** @type {IDBDatabaseInfo} */ db) => db.name === 'NewTabNoteRecovery');

describe("the worker's composition root", () => {
  it('short of space: records it, opens the database as it is, and captures still commit on 8', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const worker = createWorkerClient(hostOf(of, { estimate: CRAMPED }));
    assert.equal(await worker.whenReady(), null);
    const outcome = await worker.migration.done;
    assert.deepStrictEqual([outcome.status, outcome.failure], ['space-blocked', { code: 'space-short' }]);
    const record = /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]);
    assert.deepStrictEqual([record.status, record.code, typeof record.at], ['space-blocked', 'space-short', 'number']);
    assert.equal(detectShape(await inspect(of.real)).kind, 'legacy');
    assert.equal(await recoveryExists(of), false, 'no point, no recovery database');
    assert.equal((await capture(worker, 'on-8')).kind, 'committed');
    assert.equal((await inspect(of.real)).version, 8);
  });

  it('a worker start within RETRY_AFTER_MS of a run short of space tries nothing, and one after it tries again', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    await createWorkerClient(hostOf(of, { estimate: CRAMPED })).migration.done;
    const recorded = /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]);
    // Room now, but the last try stands: nothing is measured or copied, and the record keeps its time
    const soon = createWorkerClient(hostOf(of, { estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }) }));
    assert.equal((await soon.migration.done).status, 'space-blocked');
    assert.equal(await soon.whenReady(), null);
    assert.equal((await capture(soon, 'still-8')).kind, 'committed');
    assert.deepStrictEqual(of.chrome.local[UPGRADE_RECORD_KEY], recorded);
    assert.equal((await inspect(of.real)).version, 8);
    // Once it's older than RETRY_AFTER_MS the next start runs, and migrates
    of.chrome.local[UPGRADE_RECORD_KEY] = { ...recorded, at: recorded.at - RETRY_AFTER_MS - 1 };
    const later = createWorkerClient(hostOf(of));
    assert.equal((await later.migration.done).status, 'migrated');
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).status, 'migrated');
    assert.equal((await inspect(of.real)).version, 9);
    assert.equal((await capture(later, 'on-9')).kind, 'committed');
  });

  it('a blocked upgrade answers blocked-upgrade at once, and once the blocker closes the run finishes and captures commit', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    // An older build's page that never closes on versionchange, as 1.4.1's new tab holds its own
    const blocker = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(of.real.open('CanvasTabDB')));
    const worker = createWorkerClient(hostOf(of));
    try {
      const refused = await legacyEnv.waitFor(async () => {
        const answer = await worker.whenReady();
        return answer && answer.code === 'blocked-upgrade' ? answer : null;
      });
      assert.deepStrictEqual([refused.cause, refused.code, refused.retryable], ['storage', 'blocked-upgrade', true]);
      assert.equal(worker.migration.blocked(), true);
      const held = await capture(worker, 'while-blocked');
      assert.deepStrictEqual(held.kind === 'unavailable' && [held.cause, held.code], ['storage', 'blocked-upgrade']);
    } finally {
      blocker.close();
    }
    assert.equal((await worker.migration.done).status, 'migrated');
    assert.equal(await worker.whenReady(), null);
    assert.equal((await capture(worker, 'after')).kind, 'committed');
  });

  it('a profile with a newer database is refused, recorded, and captures answer newer-schema', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v9.newer')));
    const worker = createWorkerClient(hostOf(of));
    const failure = await worker.whenReady();
    assert.deepStrictEqual(failure && [failure.cause, failure.code], ['newer-schema', 'version-too-new']);
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).status, 'refused');
  });
});
