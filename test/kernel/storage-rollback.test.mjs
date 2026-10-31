// #17 PR 1a, rolling back after step 9 (plan risk 1, review R61's probe F): a profile migrated
// to 9, then opened by the frozen v1.4.0 and v1.4.1 Storage (test/fixtures/storage/releases/,
// the tags' own files), keeps CanvasTabDB and NewTabNoteRecovery byte for byte, and loses no
// chrome.storage.local key. v1.4.0 fails with VersionError, since all ten legacy stores are
// there for its missing-store check to find, and v1.4.1's #33 guard refuses the newer
// database. Neither deletes anything. #17 PR 1b's test/storage-rollback.test.js repeats this
// once version 9 ships.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dump, legacyEnv, profileWith, run, synthesized } from './migration-support.mjs';

const FIXTURES = synthesized();
const CASES = ['v8.basic', 'v8.missing-themes', 'v7.basic', 'v2-idb-settings.basic'];

/**
 * Runs `tag`'s own Storage.init() on `of`'s profile, sharing its IndexedDB and
 * chrome.storage.local. Resolves what init threw, or null.
 * @param {import('./migration-support.mjs').Profile} of
 * @param {string} tag
 * @returns {Promise<{error: any, Storage: any}>}
 */
async function rollBack(of, tag) {
  const env = legacyEnv.createLegacyEnv({ indexedDB: of.real, chrome: of.chrome });
  const dir = `test/fixtures/storage/releases/${tag}/js`;
  env.load(`${dir}/utils.js`, `${dir}/storage.js`);
  const Storage = env.get('Storage');
  // Settled into a value at once, so the refusal is never an unhandled rejection meanwhile
  const ended = Storage.init().then(
    () => null,
    (/** @type {unknown} */ error) => error,
  );
  return { error: await legacyEnv.runUntil(env, ended), Storage };
}

describe('a profile migrated to 9, opened by a 1.4.x build', () => {
  for (const id of CASES) {
    for (const tag of ['v1.4.0', 'v1.4.1']) {
      it(`${id}, then ${tag}: refused, and nothing changed or deleted`, async () => {
        const of = await profileWith(/** @type {any} */ (FIXTURES.get(id)));
        assert.equal((await run(of)).status, 'migrated');
        const before = await dump(of);
        const { error, Storage } = await rollBack(of, tag);
        if (tag === 'v1.4.0') {
          assert.equal(error && error.name, 'VersionError', String(error));
        } else {
          assert.ok(error, 'v1.4.1 opened a newer database');
          assert.match(String(error.message), /newer than this build supports/);
          assert.equal(Storage.openState, 'newer-version');
        }
        const after = await dump(of);
        assert.deepStrictEqual(after.databases, before.databases);
        // No key lost or changed, auto_backup_* and recovery_backup_* included
        for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (before.chromeStorageLocal))) {
          assert.deepStrictEqual(/** @type {any} */ (after.chromeStorageLocal)[key], value, key);
        }
      });
    }
  }
});
