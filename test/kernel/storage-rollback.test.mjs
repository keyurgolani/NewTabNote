// #17 PR 1a, rolling back after step 9 (plan risk 1, review R61's probe F), and after step 10 since
// #17 PR 2a, with the ledger, change log, conflict, and tombstone rows it keeps, and since PR 2b
// with notes deleted for good and the point purged of them: a profile migrated
// to 10, then opened by the frozen v1.4.0 and v1.4.1 Storage (test/fixtures/storage/releases/,
// the tags' own files), keeps CanvasTabDB and NewTabNoteRecovery byte for byte, and loses no
// chrome.storage.local key. v1.4.0 fails with VersionError, since all ten legacy stores are
// there for its missing-store check to find, and v1.4.1's #33 guard refuses the newer
// database. Neither deletes anything. #17 PR 1b's test/storage-rollback.test.js repeats this
// once version 9 ships. #28 slice 3 adds the profiles that hold auto_backup_* and
// recovery_backup_* keys, recorded from v1.3.0 and v1.4.0 and generated (maximal), so that
// check reads real keys, and a database a later build left at 12, which 1.4.x refuses too.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import { maximalFixture } from '../fixtures/storage/generate.mjs';
import { productionInputs } from './generated-inputs.mjs';
import {
  FIXTURES as DIR,
  deleteAndPurge,
  dump,
  legacyEnv,
  profileWith,
  recordsIn,
  run,
  synthesized,
  writeHistory,
} from './migration-support.mjs';

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

describe('a profile migrated to 10, opened by a 1.4.x build', () => {
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

/** The recorded fixtures that hold backups: v1.3.0's and v1.4.0's */
const WITH_BACKUPS = ['v8.v1.3.0', 'v8.v1.4.0']
  .map(id => path.join(DIR, 'recorded', `${id}.json`))
  .filter(file => fs.existsSync(file))
  .map(file => JSON.parse(fs.readFileSync(file, 'utf8')));

/**
 * 1.4.x's refusal of a newer database, and nothing changed or deleted
 * @param {import('./migration-support.mjs').Profile} of
 * @param {string} tag
 */
async function refusedUnchanged(of, tag) {
  const before = await dump(of);
  const keys = Object.keys(/** @type {object} */ (before.chromeStorageLocal));
  const { error, Storage } = await rollBack(of, tag);
  if (tag === 'v1.4.0') {
    assert.equal(error && error.name, 'VersionError', String(error));
  } else {
    assert.match(String(error && error.message), /newer than this build supports/);
    assert.equal(Storage.openState, 'newer-version');
  }
  const after = await dump(of);
  assert.deepStrictEqual(after.databases, before.databases);
  for (const key of keys) {
    assert.deepStrictEqual(/** @type {any} */ (after.chromeStorageLocal)[key], /** @type {any} */ (before.chromeStorageLocal)[key], key);
  }
  return keys;
}

describe('a profile with backups, migrated to 10, opened by a 1.4.x build', async () => {
  const maximal = maximalFixture(await productionInputs()).fixture;
  const cases = [...WITH_BACKUPS, maximal];
  it('has a fixture recorded from v1.3.0 and one from v1.4.0', () => {
    assert.deepStrictEqual(
      WITH_BACKUPS.map(fixture => fixture.header.id),
      ['v8.v1.3.0', 'v8.v1.4.0'],
    );
  });
  for (const fixture of cases) {
    for (const tag of ['v1.4.0', 'v1.4.1']) {
      it(`${fixture.header.id}, then ${tag}: refused, and every auto_backup_* and recovery_backup_* key kept`, async () => {
        const of = await profileWith(fixture);
        assert.equal((await run(of)).status, 'migrated');
        const keys = await refusedUnchanged(of, tag);
        assert.ok(keys.some(key => key.startsWith('auto_backup_')), 'no auto_backup_* key to keep');
        assert.ok(keys.some(key => key.startsWith('recovery_backup_')), 'no recovery_backup_* key to keep');
      });
    }
  }
});

describe('a profile at 10 holding a ledger, a change log, a conflict, and a tombstone, opened by a 1.4.x build (#17 PR 2a)', () => {
  /** @type {Record<string, () => Promise<import('./migration-support.mjs').Profile>>} */
  const profiles = {
    'v10.basic': () => profileWith(/** @type {any} */ (FIXTURES.get('v10.basic'))),
    "v8.basic, migrated, then written through #17's adapter": async () => {
      const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
      assert.equal((await run(of)).status, 'migrated');
      assert.deepEqual(await writeHistory(of), [
        'committed',
        'committed',
        'conflict',
        'committed',
        'committed',
        'committed',
        'committed',
      ]);
      return of;
    },
  };
  for (const [name, make] of Object.entries(profiles)) {
    for (const tag of ['v1.4.0', 'v1.4.1']) {
      it(`${name}, then ${tag}: refused, and nothing changed or deleted`, async () => {
        const of = await make();
        const before = await dump(of);
        const stores = before.databases.find(db => db.name === 'CanvasTabDB')?.stores ?? [];
        for (const store of ['operations', 'changes', 'conflicts', 'tombstones']) {
          assert.ok(
            (stores.find(found => found.name === store)?.records.length ?? 0) > 0,
            `${name} holds ${store} rows`,
          );
        }
        await refusedUnchanged(of, tag);
      });
    }
  }
});

describe('a profile at 10 with a note and a folder deleted for good and its point purged, opened by a 1.4.x build (#17 PR 2b)', () => {
  for (const tag of ['v1.4.0', 'v1.4.1']) {
    it(`v8.basic, migrated, deleted, and purged, then ${tag}: refused, and nothing changed or deleted`, async () => {
      const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
      assert.equal((await run(of)).status, 'migrated');
      const { noteId, folderId, purged } = await deleteAndPurge(of);
      assert.deepEqual([purged.status, purged.tombstones], ['purged', 2]);
      assert.ok(purged.rows > 1);
      const before = await dump(of);
      const tombstones = recordsIn(before, 'CanvasTabDB', 'tombstones').map(record => record.value.id);
      assert.deepEqual(tombstones.sort(), [folderId, noteId].sort());
      await refusedUnchanged(of, tag);
    });
  }
});

describe('a database a later build left at version 12, opened by a 1.4.x build', () => {
  for (const tag of ['v1.4.0', 'v1.4.1']) {
    it(`v9.newer, then ${tag}: refused, and nothing changed or deleted`, async () => {
      const of = await profileWith(/** @type {any} */ (FIXTURES.get('v9.newer')));
      await refusedUnchanged(of, tag);
    });
  }
});
