// #20 slice 3's salvage file and Save as file (remediation/salvage-file.js, saved-file.js,
// js/kernel/adapters/indexeddb/salvage-reader.js, js/kernel/adapters/files/save-picker.js):
// - "saved" is a file written through the picker, closed, read back, parsed, and counted, and
//   anything less answers not saved;
// - the salvage file holds every readable CanvasTabDB store but the secret-class `settings`,
//   the legacy copies, and the recovery points, in #17's legacy export shape with
//   `salvage: true`, and the frozen v1.4.1 import (test/fixtures/storage/releases/v1.4.1)
//   reads it with its images, folders, and archived and template flags intact;
// - no salvage or restore-point file holds a secret (canaries);
// - Save as file saves a legacy copy or a verified #17 point the same way.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

import { createSavePicker } from '../../js/kernel/adapters/files/save-picker.js';
import { LEGACY_STORE_NAMES } from '../../js/kernel/adapters/indexeddb/registry.js';
import { createSalvageReader } from '../../js/kernel/adapters/indexeddb/salvage-reader.js';
import { REMEDIATIONS } from '../../js/trust/core/remediation/catalog.js';
import { buildRestorePointFile, buildSalvage, countFile } from '../../js/trust/core/remediation/salvage-file.js';
import { readBack, saveVerified, serialize, writeFile } from '../../js/trust/core/remediation/saved-file.js';
import { KeyRange, legacyEnv, profileWith, run, synthesized } from './migration-support.mjs';
import { memoryFiles, remediationCenter, runOf } from './trust-remediation-support.mjs';
import { NOW } from './support.mjs';
import { flakyStore } from './trust-support.mjs';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

const crypto = /** @type {any} */ (webcrypto);
const SYNTHESIZED = synthesized();
const RELEASE = 'test/fixtures/storage/releases/v1.4.1/js';
const SECRETS = ['canary-llm-api-key', 'canary-webdav-password', 'canary-idb-llm-key', 'canary-copy-key'];

/**
 * A row in each store step 10 adds (#17 PR 2a), as the ledger, the change log, a save that
 * lost, and a deletion write them
 */
const STEP_10_ROWS = Object.freeze({
  operations: [{ opId: 'op-1', digest: 'digest-1', outcome: 'committed', at: NOW }],
  changes: [{ seq: 1, entityType: 'note', entityId: 'n1', revision: 2, opId: 'op-1', ops: [], position: 0 }],
  conflicts: [
    {
      id: 'command-lost',
      noteId: 'n1',
      scope: 'note',
      expected: 1,
      current: 2,
      at: NOW,
      command: { type: 'saveBlocks', blocks: [{ id: 'b1', content: 'The words that lost' }] },
    },
  ],
  tombstones: [{ entityType: 'note', id: 'n-gone', deletedAt: NOW, lastRevision: 3, seq: 1, reason: 'deleted' }],
});

/**
 * The v1.4.1 Storage on a fresh 1.4.1 profile, as a user who reinstalled 1.4.1 has it
 * @returns {Promise<{env: any, Storage: any}>}
 */
async function release141() {
  const env = legacyEnv.createLegacyEnv();
  await legacyEnv.createDatabase(env.indexedDB, {});
  env.load(`${RELEASE}/utils.js`, `${RELEASE}/storage.js`);
  const Storage = env.get('Storage');
  await Storage.init();
  return { env, Storage };
}

/**
 * Puts `rows` into `store` of CanvasTabDB as it is on disk
 * @param {IDBFactory} factory
 * @param {string} store
 * @param {unknown[]} rows
 */
async function putRaw(factory, store, rows) {
  const db = /** @type {IDBDatabase} */ (
    await new Promise((resolve, reject) => {
      const request = factory.open('CanvasTabDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })
  );
  const tx = db.transaction(store, 'readwrite');
  for (const row of rows) tx.objectStore(store).put(row);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

/**
 * The v8.orphans profile after #17's migration (so it has a verified pre-migration point and
 * `meta` and `migrations`), with a secret in the legacy IndexedDB settings and in
 * chrome.storage.local, and two legacy copies, one of them holding a `settings` store and a
 * credential field
 */
async function postMigrationProfile() {
  const of = await profileWith(/** @type {any} */ (SYNTHESIZED.get('v8.orphans')));
  await putRaw(of.real, 'settings', [{ key: 'llmApiKey', value: 'canary-idb-llm-key' }]);
  assert.equal((await run(of)).status, 'migrated');
  await of.chrome.api.storage.local.set({
    setting_llmApiKey: 'canary-llm-api-key',
    setting_syncWebdavConfig: { password: 'canary-webdav-password', username: 'u' },
    auto_backup_1793413294673: {
      version: 1,
      exportedAt: 1793413294673,
      autoBackup: true,
      canvases: [{ id: 'copy-note', name: 'From a copy' }],
      elements: [{ id: 'copy-block', canvasId: 'copy-note', content: 'copied text' }],
      media: [],
      folders: [],
    },
    recovery_backup_1793413294676: {
      recoveryBackup: true,
      timestamp: 1793413294676,
      canvases: [],
      elements: [],
      settings: [{ key: 'llmApiKey', value: 'canary-copy-key' }],
      syncWebdavConfig: { password: 'canary-webdav-password' },
    },
  });
  return of;
}

/** @param {Profile} of */
const readerOn = of =>
  createSalvageReader({ indexedDB: of.real, keyRange: KeyRange, crypto, settings: of.chrome.api.storage.local });

/**
 * A Trust Center whose salvage and Save as file run on `of`, saving into `files`
 * @param {Profile} of
 * @param {ReturnType<typeof memoryFiles>} files
 */
const centerOn = (of, files) =>
  remediationCenter({ contributions: /** @type {any} */ (REMEDIATIONS), ports: { salvage: readerOn(of), files } });

/** @param {unknown} answer @returns {any} */
const asRun = answer => {
  assert.equal(/** @type {any} */ (answer).kind, 'remediation', JSON.stringify(answer));
  return answer;
};

describe('the salvage file (#20 slice 3)', () => {
  it('saves every readable store but settings, the legacy copies, and the recovery points, read back and counted', async () => {
    const of = await postMigrationProfile();
    const files = memoryFiles();
    const { pipeline, records } = await centerOn(of, files);
    const done = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    assert.equal(done.outcome, 'verified');
    assert.deepEqual(done.needs, []);
    assert.deepEqual(done.impact.changes, [{ target: 'file', creates: 1, updates: 0, deletes: 0 }]);
    assert.match(String(files.lastName), /^newtabnote-salvage-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.json$/);
    const file = files.last();

    assert.equal(file.version, 1);
    assert.equal(file.salvage, true);
    // #17's legacy shape, as its pre-migration export splits it
    assert.deepEqual(file.canvases.map((/** @type {any} */ n) => n.name).sort(), [
      'Groceries',
      'Meeting template',
      'Old plans',
      'Reading list',
    ]);
    assert.deepEqual(
      file.trashedCanvases.map((/** @type {any} */ n) => n.name),
      ['Thrown away'],
    );
    assert.equal(file.elements.length, 4);
    // The trashed note's block, and the one whose note is gone
    assert.equal(file.orphanElements.length, 2);
    assert.ok(file.orphanElements.some((/** @type {any} */ b) => b.content === 'Left behind'));
    assert.equal(file.media.length, 2);
    assert.match(file.media[0].blob, /^data:image\/png;base64,/);
    assert.equal(file.folders.length, 1);
    // Every other store under its own name, step 10's four (#17 PR 2a) and step 11's daily index
    // (#17 PR 3b) included, settings never
    assert.deepEqual(Object.keys(file.stores).sort(), [
      'changes',
      'conflicts',
      'daily_index',
      'links',
      'meta',
      'migrations',
      'operations',
      'search_index',
      'snapshots',
      'themes',
      'tombstones',
      'vectors',
    ]);
    assert.equal('settings' in file.stores, false);
    // The legacy copies by key, and the pre-migration point with its rows
    assert.deepEqual(Object.keys(file.legacyCopies).sort(), [
      'auto_backup_1793413294673',
      'recovery_backup_1793413294676',
    ]);
    assert.equal(file.legacyCopies.recovery_backup_1793413294676.settings, undefined);
    assert.equal(file.recoveryPoints.length, 1);
    const [point] = file.recoveryPoints;
    assert.equal(point.kind, 'pre-migration');
    assert.equal(point.verified, true);
    assert.equal(typeof point.verifiedAt, 'number');
    assert.equal(point.stores.canvases.length, 5);
    assert.equal('settings' in point.stores, false);
    // The counts, which the read-back matched
    assert.deepEqual(file.counts, countFile(file));
    assert.equal(file.counts.canvases, 5);
    assert.equal(file.counts.elements, 6);
    assert.equal(file.counts.legacyCopies, 2);
    assert.deepEqual(file.unreadable, []);
    // What was left out, by where it was
    assert.deepEqual(
      file.omissions.map((/** @type {any} */ o) => o.at),
      [
        'CanvasTabDB.settings',
        'legacyCopies.recovery_backup_1793413294676.settings',
        'legacyCopies.recovery_backup_1793413294676.syncWebdavConfig',
      ],
    );
    // The run says it read back verified
    const stored = (await records.runs()).find(item => item.id === done.runId);
    assert.equal(stored?.state, 'succeeded');
  });

  it("holds each of step 10's stores (#17 PR 2a), and names one that won't read, in the file, the run, and its record", async () => {
    const of = await postMigrationProfile();
    const rows = STEP_10_ROWS;
    for (const [store, list] of Object.entries(rows)) await putRaw(of.real, store, list);
    const files = memoryFiles();
    const { pipeline } = await centerOn(of, files);
    const done = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    const file = files.last();
    for (const [store, list] of Object.entries(rows)) {
      assert.deepEqual(file.stores[store], list, store);
      assert.equal(file.counts[`stores.${store}`], list.length, store);
    }
    assert.ok(JSON.stringify(file.stores.conflicts).includes('The words that lost'));
    assert.deepEqual(
      file.omissions.filter((/** @type {any} */ o) =>
        /^CanvasTabDB\.(?:operations|changes|conflicts|tombstones)$/.test(o.at),
      ),
      [],
    );

    // The conflict records won't read: the file holds them as [], and says so where they were
    const reader = readerOn(of);
    const failing = {
      ...reader,
      async collect() {
        const read = await reader.collect();
        const stores = read.database.stores.map(store =>
          store.store === 'conflicts' ? { store: 'conflicts', values: [], errorCode: 'unreadable' } : store,
        );
        return { ...read, database: { ...read.database, stores } };
      },
    };
    const saved = memoryFiles();
    const center = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { salvage: /** @type {any} */ (failing), files: saved },
    });
    const partial = asRun(await center.pipeline.run(runOf('save-salvage-file')));
    assert.equal(partial.state, 'succeeded', JSON.stringify(partial));
    assert.equal(partial.outcome, 'saved-partial');
    const named = [{ origin: 'CanvasTabDB', part: 'conflicts', pointId: null, code: 'unreadable' }];
    assert.deepEqual(partial.unreadable, named);
    assert.deepEqual(saved.last().unreadable, named);
    assert.deepEqual(saved.last().stores.conflicts, []);
    const stored = (await center.records.runs()).find(item => item.id === partial.runId);
    assert.deepEqual(stored?.unreadable, named);
  });

  it("imports into the frozen v1.4.1 with step 10's four stores in it, which 1.4.1 doesn't read", async () => {
    const of = await postMigrationProfile();
    for (const [store, list] of Object.entries(STEP_10_ROWS)) await putRaw(of.real, store, list);
    const files = memoryFiles();
    const { pipeline } = await centerOn(of, files);
    asRun(await pipeline.run(runOf('save-salvage-file')));
    const file = files.last();
    for (const [store, list] of Object.entries(STEP_10_ROWS)) assert.deepEqual(file.stores[store], list, store);

    const { env, Storage } = await release141();
    const check = Storage.validateImport(file);
    assert.equal(check.ok, true, check.reason);
    const result = await Storage.importData(file, 'merge');
    assert.equal(result.notes, file.canvases.length);
    assert.equal(result.blocks, file.elements.length);
    // Its own ten stores, and nothing of the four in them
    const dumped = await legacyEnv.dumpDatabase(env.indexedDB);
    assert.deepEqual(Object.keys(dumped.stores).sort(), [...LEGACY_STORE_NAMES]);
    assert.equal(JSON.stringify(dumped).includes('The words that lost'), false);
  });

  it('holds no secret: not the IndexedDB settings, not chrome.storage.local, not one inside a legacy copy (AC14 canary)', async () => {
    const of = await postMigrationProfile();
    const files = memoryFiles();
    const { pipeline, records, journal } = await centerOn(of, files);
    asRun(await pipeline.run(runOf('save-salvage-file')));
    const text = [...files.files.values()].join('');
    await journal.flush();
    const trust = JSON.stringify({ runs: await records.runs(), events: await records.events() });
    for (const secret of SECRETS) {
      assert.equal(text.includes(secret), false, `${secret} is in the salvage file`);
      assert.equal(trust.includes(secret), false, `${secret} is in a trust record`);
    }
    // while the notes' own words are there, so the file isn't simply empty
    assert.ok(text.includes('Left behind'));
  });

  it('imports into the frozen v1.4.1 with its images, folders, and archived and template flags intact', async () => {
    const of = await postMigrationProfile();
    const files = memoryFiles();
    const { pipeline } = await centerOn(of, files);
    asRun(await pipeline.run(runOf('save-salvage-file')));
    const file = files.last();

    const { env, Storage } = await release141();
    const check = Storage.validateImport(file);
    assert.equal(check.ok, true, check.reason);
    const result = await Storage.importData(file, 'merge');
    assert.equal(result.notes, file.canvases.length);
    assert.equal(result.blocks, file.elements.length);

    const dumped = await legacyEnv.dumpDatabase(env.indexedDB);
    const notes = Object.values(legacyEnv.recordsOf(dumped, 'canvases'));
    const byName = (/** @type {string} */ name) =>
      /** @type {any} */ (notes.find((/** @type {any} */ n) => n.name === name));
    assert.equal(byName('Old plans').archived, true);
    assert.equal(byName('Meeting template').isTemplate, true);
    const folders = Object.values(legacyEnv.recordsOf(dumped, 'folders'));
    assert.deepEqual(
      folders.map((/** @type {any} */ f) => f.name),
      ['Home'],
    );
    assert.equal(byName('Groceries').folderId, /** @type {any} */ (folders[0]).id);
    const media = Object.values(legacyEnv.recordsOf(dumped, 'media'));
    assert.equal(media.length, 1);
    assert.equal(/** @type {any} */ (media[0]).canvasId, byName('Groceries').id);
    assert.equal(/** @type {any} */ (media[0]).blob.type, 'image/png');
    // The trashed note and the orphan stay out of 1.4.1 and in the file
    assert.equal(byName('Thrown away'), undefined);
    assert.equal(result.skippedMedia, 1);
  });

  it("still saves while NewTabNoteTrust won't take a write, and says its run wasn't recorded", async () => {
    const of = await postMigrationProfile();
    const files = memoryFiles();
    const broken = flakyStore(createMemoryTrustStore());
    broken.failNext(1000, 'quota', { writesOnly: true });
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { salvage: readerOn(of), files },
      store: /** @type {any} */ (broken.store),
    });
    const done = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(done.state, 'succeeded');
    assert.equal(done.recorded, false);
    assert.equal(files.last().salvage, true);
    // A run that changes stored records still stops before it changes anything
    const refused = await pipeline.run(runOf('safe-disable'));
    assert.equal(/** @type {any} */ (refused).code, 'not-recorded');
  });

  it('the reader never reads the secret-class settings store, here or inside a point, and reads nothing it changes', async () => {
    const of = await postMigrationProfile();
    const before = await legacyEnv.dumpDatabase(of.real);
    const read = await readerOn(of).collect();
    assert.equal(read.database.status, 'open');
    assert.equal(
      read.database.stores.some(store => store.store === 'settings'),
      false,
    );
    for (const point of read.recoveryPoints.points) {
      assert.equal(
        point.stores.some(store => store.store === 'settings'),
        false,
      );
    }
    assert.equal(JSON.stringify(read).includes('canary-idb-llm-key'), false);
    // Only the legacy copies' keys come back from chrome.storage.local
    assert.deepEqual(
      read.legacyCopies.copies.map(copy => copy.key),
      ['auto_backup_1793413294673', 'recovery_backup_1793413294676'],
    );
    assert.equal(JSON.stringify(read).includes('canary-llm-api-key'), false);
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });

  it('with no CanvasTabDB at all, still saves the legacy copies, and says the database is missing', async () => {
    const of = await profileWith(/** @type {any} */ (SYNTHESIZED.get('none.basic')));
    await of.chrome.api.storage.local.set({
      auto_backup_1793413294673: {
        version: 1,
        canvases: [{ id: 'n', name: 'Kept' }],
        elements: [],
        media: [],
        folders: [],
      },
    });
    const files = memoryFiles();
    const { pipeline } = await centerOn(of, files);
    const done = asRun(await pipeline.run(runOf('save-salvage-file')));
    // Saved, but short of a database: a warning that says what it couldn't read
    assert.equal(done.state, 'succeeded');
    assert.equal(done.outcome, 'saved-partial');
    assert.equal(done.severity, 'warning');
    assert.deepEqual(done.unreadable, [{ origin: 'CanvasTabDB', part: null, pointId: null, code: 'no-database' }]);
    const file = files.last();
    assert.deepEqual(file.unreadable, done.unreadable);
    assert.deepEqual(file.canvases, []);
    assert.equal(file.legacyCopies.auto_backup_1793413294673.canvases[0].name, 'Kept');
    // No database was made by reading
    const names = await of.real.databases();
    assert.equal(
      names.some(db => db.name === 'CanvasTabDB'),
      false,
    );
  });

  it('writes a store that would not read as [] with its error code, and keeps what 1.4.1 would refuse beside the import', () => {
    const file = buildSalvage(
      {
        database: {
          status: 'open',
          stores: [
            { store: 'canvases', values: [{ id: 'a', name: 'A' }, { id: 'a', name: 'twin' }, { name: 'no id' }] },
            { store: 'elements', values: [{ id: 'b', canvasId: 'a' }] },
            { store: 'vectors', values: [], errorCode: 'unreadable' },
            { store: 'settings', values: [{ key: 'llmApiKey', value: 'canary-idb-llm-key' }] },
          ],
        },
        legacyCopies: { status: 'failed', errorCode: 'settings-read-failed', copies: [] },
        recoveryPoints: { status: 'missing', points: [] },
      },
      { now: NOW },
    );
    assert.deepEqual(file.stores.vectors, []);
    assert.deepEqual(file.unreadable, [
      { origin: 'CanvasTabDB', part: 'vectors', pointId: null, code: 'unreadable' },
      { origin: 'legacyCopies', part: null, pointId: null, code: 'settings-read-failed' },
    ]);
    assert.deepEqual(
      file.canvases.map((/** @type {any} */ n) => n.name),
      ['A'],
    );
    assert.equal(file.unimportable.canvases.length, 2);
    assert.equal(file.counts.canvases, 3);
    assert.equal(JSON.stringify(file).includes('canary-idb-llm-key'), false);
    assert.deepEqual(file.omissions[0], { what: 'store', at: 'CanvasTabDB.settings', reason: 'secret' });
  });
});

describe('Save as file for a restore point (#20, "Data and migration")', () => {
  it('saves a legacy copy by its key, without a secret inside it, as a file 1.4.1 imports', async () => {
    const of = await postMigrationProfile();
    const files = memoryFiles();
    const { pipeline } = await centerOn(of, files);
    const done = asRun(await pipeline.run(runOf('save-recovery-file', { subjectId: 'recovery_backup_1793413294676' })));
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    const text = [...files.files.values()].join('');
    for (const secret of SECRETS) assert.equal(text.includes(secret), false, secret);
    const file = files.last();
    assert.equal(file.restorePoint.kind, 'legacy-copy');
    assert.equal(file.restorePoint.key, 'recovery_backup_1793413294676');
    assert.deepEqual(
      file.omissions.map((/** @type {any} */ o) => o.at),
      ['recovery_backup_1793413294676.settings', 'recovery_backup_1793413294676.syncWebdavConfig'],
    );

    const auto = asRun(await pipeline.run(runOf('save-recovery-file', { subjectId: 'auto_backup_1793413294673' })));
    assert.equal(auto.state, 'succeeded');
    const copy = files.last();
    assert.match(String(files.lastName), /^newtabnote-restore-point-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.json$/);
    const { Storage } = await release141();
    assert.equal(Storage.validateImport(copy).ok, true);
    assert.equal((await Storage.importData(copy, 'merge')).notes, 1);
  });

  it("saves a verified #17 point by its id, and refuses one that doesn't verify or isn't there", async () => {
    const of = await postMigrationProfile();
    const files = memoryFiles();
    const { pipeline } = await centerOn(of, files);
    const pointId = `pre-migration-${NOW}`;
    const done = asRun(await pipeline.run(runOf('save-recovery-file', { subjectId: pointId })));
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    const file = files.last();
    assert.equal(file.restorePoint.id, pointId);
    assert.equal(file.restorePoint.pointKind, 'pre-migration');
    const { Storage } = await release141();
    assert.equal(Storage.validateImport(file).ok, true);
    await Storage.importData(file, 'merge');

    const missing = asRun(await pipeline.run(runOf('save-recovery-file', { subjectId: 'auto_backup_1000000000000' })));
    assert.equal(missing.state, 'failed');
    assert.equal(missing.outcome, 'no-recovery-point');
    const none = asRun(await pipeline.run(runOf('save-recovery-file')));
    assert.equal(none.outcome, 'not-applicable');
  });

  it('a cancelled picker cancels the run, and a page without the picker never says saved', async () => {
    const of = await postMigrationProfile();
    const files = memoryFiles();
    const { pipeline } = await centerOn(of, files);
    files.cancel = true;
    const cancelled = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.outcome, 'cancelled-by-user');
    files.unavailable = true;
    const unavailable = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(unavailable.state, 'failed');
    assert.equal(unavailable.outcome, 'picker-unavailable');
    assert.equal(files.files.size, 0);
  });
});

describe('"saved" means written, closed, read back, parsed, and counted', () => {
  const file = buildSalvage(
    {
      database: { status: 'open', stores: [{ store: 'canvases', values: [{ id: 'a' }] }] },
      legacyCopies: { status: 'read', copies: [] },
      recoveryPoints: { status: 'missing', points: [] },
    },
    { now: NOW },
  );
  const build = async () => file;

  it('writes the file in parts that join to its JSON exactly', () => {
    assert.equal([...serialize(file)].join(''), JSON.stringify(file));
    assert.ok([...serialize(file)].length > 5);
  });

  it('answers saved only once the read-back parsed and every count matched', async () => {
    const files = memoryFiles();
    assert.deepEqual(await saveVerified({ files, suggestedName: 'x.json', build }), {
      status: 'saved',
      counts: file.counts,
      characters: JSON.stringify(file).length,
      // No subject named is never held (#20 slice 4a)
      read: { unreadable: [], held: 1, holdsSubject: false, readCanvas: true },
    });
  });

  it('answers not saved for each way short of that', async () => {
    const files = memoryFiles();
    files.unavailable = true;
    assert.deepEqual(await saveVerified({ files, suggestedName: 'x.json', build }), {
      status: 'failed',
      code: 'picker-unavailable',
    });
    assert.deepEqual(await saveVerified({ files: undefined, suggestedName: 'x.json', build }), {
      status: 'failed',
      code: 'picker-unavailable',
    });
    files.unavailable = false;
    files.cancel = true;
    assert.deepEqual(await saveVerified({ files, suggestedName: 'x.json', build }), { status: 'cancelled' });
    files.failWrite = true;
    assert.deepEqual(await saveVerified({ files, suggestedName: 'x.json', build }), {
      status: 'failed',
      code: 'file-not-saved',
      picked: true,
    });
    files.alter = text => text.slice(0, -1);
    assert.deepEqual(await saveVerified({ files, suggestedName: 'x.json', build }), {
      status: 'failed',
      code: 'file-unreadable',
    });
    files.alter = text => text.replace('"canvases":[{"id":"a"}]', '"canvases":[]');
    assert.deepEqual(await saveVerified({ files, suggestedName: 'x.json', build }), {
      status: 'failed',
      code: 'file-mismatch',
    });
    // Its stated counts changed though its records didn't
    files.alter = text => text.replace('"canvases":1', '"canvases":2');
    assert.deepEqual(await saveVerified({ files, suggestedName: 'x.json', build }), {
      status: 'failed',
      code: 'file-mismatch',
    });
    // A file the picker hands back empty
    // A file that can't be built once picked
    assert.deepEqual(
      await saveVerified({
        files,
        suggestedName: 'x.json',
        build: async () => {
          throw new Error('read failed');
        },
      }),
      { status: 'failed', code: 'build-failed', picked: true },
    );
    const written = await writeFile({ files, suggestedName: 'x.json', build });
    assert.equal(written.status, 'written');
    files.alter = () => '';
    assert.deepEqual(await readBack({ files, written: /** @type {any} */ (written) }), {
      status: 'failed',
      code: 'file-unreadable',
    });
  });
});

describe('the save picker (js/kernel/adapters/files/save-picker.js)', () => {
  /** A fake showSaveFilePicker whose files hold what was written once closed */
  function fakePicker() {
    /** @type {string[]} */
    const disk = [];
    const calls = { opened: 0, closed: 0, aborted: 0, options: /** @type {any} */ (null) };
    let cancel = false;
    let failAt = -1;
    /** @param {any} options */
    const showSaveFilePicker = async options => {
      calls.options = options;
      if (cancel) throw new DOMException('The user aborted a request.', 'AbortError');
      const slot = disk.length;
      disk.push('');
      return {
        async createWritable() {
          calls.opened++;
          /** @type {string[]} */
          const buffer = [];
          return {
            async write(/** @type {string} */ part) {
              if (buffer.length === failAt) throw new DOMException('disk full', 'QuotaExceededError');
              buffer.push(part);
            },
            async close() {
              calls.closed++;
              disk[slot] = buffer.join('');
            },
            async abort() {
              calls.aborted++;
            },
          };
        },
        async getFile() {
          return { text: async () => disk[slot] };
        },
      };
    };
    return {
      disk,
      calls,
      showSaveFilePicker,
      cancelNext: () => {
        cancel = true;
      },
      /** @param {number} at */
      failWriteAt: at => {
        failAt = at;
      },
    };
  }

  it('is unavailable on a page without the picker, and never falls back to a download', async () => {
    const picker = createSavePicker({});
    assert.equal(picker.available(), false);
    await assert.rejects(picker.pick({ suggestedName: 'x.json' }), { name: 'NotSupportedError' });
  });

  it('writes, closes, and reads the same file back; a cancel is null, and a failed write aborts', async () => {
    const fake = fakePicker();
    const picker = createSavePicker({ showSaveFilePicker: /** @type {any} */ (fake.showSaveFilePicker) });
    assert.equal(picker.available(), true);
    const handle = /** @type {any} */ (await picker.pick({ suggestedName: 'newtabnote-salvage.json' }));
    assert.equal(fake.calls.options.suggestedName, 'newtabnote-salvage.json');
    assert.deepEqual(fake.calls.options.types, [
      { description: 'NewTabNote file', accept: { 'application/json': ['.json'] } },
    ]);
    await picker.write(handle, ['{"a":', '1}']);
    assert.equal(fake.calls.closed, 1);
    assert.equal(await picker.read(handle), '{"a":1}');

    fake.cancelNext();
    assert.equal(await picker.pick({ suggestedName: 'x.json' }), null);

    const other = createSavePicker({ showSaveFilePicker: /** @type {any} */ (fakePicker().showSaveFilePicker) });
    const failing = fakePicker();
    failing.failWriteAt(1);
    const broken = createSavePicker({ showSaveFilePicker: /** @type {any} */ (failing.showSaveFilePicker) });
    const target = /** @type {any} */ (await broken.pick({ suggestedName: 'x.json' }));
    await assert.rejects(broken.write(target, ['a', 'b']), { name: 'QuotaExceededError' });
    assert.equal(failing.calls.aborted, 1);
    assert.equal(failing.calls.closed, 0);
    void other;
  });

  it('is what the pipeline saves through, end to end', async () => {
    const fake = fakePicker();
    const of = await profileWith(/** @type {any} */ (SYNTHESIZED.get('v8.basic')));
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: {
        salvage: readerOn(of),
        files: createSavePicker({ showSaveFilePicker: /** @type {any} */ (fake.showSaveFilePicker) }),
      },
    });
    const done = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(done.state, 'succeeded');
    assert.equal(JSON.parse(fake.disk[0]).salvage, true);
  });
});

describe('what ships (R1: no visible change)', () => {
  it('only the trust core reaches the pipeline, and no shipped page loads it, the save picker, the salvage reader, or the repair points', () => {
    const root = path.join(import.meta.dirname, '..', '..');
    const targets = new Set([
      ...fs.readdirSync(path.join(root, 'js/trust/core/remediation')).map(name => `js/trust/core/remediation/${name}`),
      'js/kernel/adapters/files/save-picker.js',
      'js/kernel/adapters/indexeddb/salvage-reader.js',
      'js/kernel/adapters/indexeddb/repair-points.js',
    ]);
    /** @type {Set<string>} */
    const importers = new Set();
    /** @param {string} dir */
    const walk = dir => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const file = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (file !== 'js/lib') walk(file);
          continue;
        }
        if (!/\.m?js$/.test(entry.name) || targets.has(file)) continue;
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        for (const [, specifier] of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
          if (specifier.startsWith('.') && targets.has(path.posix.join(path.posix.dirname(file), specifier))) {
            importers.add(file);
          }
        }
      }
    };
    walk('js');
    // recovery.run's schema reads the preview's, and the one next-action picker the repair
    // table (data only); nothing else outside them reaches any of them
    assert.deepEqual([...importers].sort(), [
      'js/trust/core/next-action.js',
      'js/trust/core/operations/recovery-run.js',
    ]);
    for (const page of ['newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html', 'manifest.json']) {
      const text = fs.readFileSync(path.join(root, page), 'utf8');
      assert.equal(/remediation|save-picker|salvage-reader|repair-points/.test(text), false, page);
    }
  });
});
