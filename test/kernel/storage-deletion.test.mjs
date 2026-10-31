// #17 PR 2b, "deletion must delete" (Q16): a note deleted for good, and a folder deleted, leave
// no trace anywhere a user's data is kept once the worker's purge has run. A version-8 profile
// holds canaries in a note's title, blocks, search entry, snapshot, links both ways, media,
// and vector, and in a folder's name. It's migrated, so its pinned recovery point holds them
// all, and a save that loses to a newer revision keeps one more in a conflict record. Then the
// note and the folder are deleted, through #17's adapter and, as the new tab deletes them,
// through the legacy adapter, and the purge runs: no store in CanvasTabDB or
// NewTabNoteRecovery, and no chrome.storage.local key, holds a canary; the point still
// verifies; its pre-update export lacks both; and every other note's rows are as they were.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { exportPoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import { purgeRecoveryPoints } from '../../js/kernel/adapters/indexeddb/purge.js';
import {
  listPoints,
  openRecovery,
  verifyPoint,
  DEFAULT_LIMITS,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { createLegacyAdapter } from '../../js/kernel/adapters/legacy/adapter.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import {
  DELETED_AT,
  KeyRange,
  dump,
  legacyEnv,
  profileWith,
  recordsIn,
  run,
  stringsIn,
  synthesized,
} from './migration-support.mjs';
import { CALLERS, NOW } from './support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */
/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */

const crypto = /** @type {any} */ (webcrypto);
const FIXTURES = synthesized();
const clock = { now: () => NOW };
/** A minute after the run's point: when the note and the folder are deleted, and the sweep runs */
const later = { now: () => DELETED_AT };

/** One canary per place a note or a folder leaves its text */
const CANARIES = Object.freeze({
  title: 'canary-deleted-title',
  block: 'canary-deleted-block',
  search: 'canary-deleted-search',
  snapshot: 'canary-deleted-snapshot',
  linkFrom: 'canary-deleted-link-from',
  linkTo: 'canary-deleted-link-to',
  media: 'canary-deleted-media',
  vector: 'canary-deleted-vector',
  conflict: 'canary-deleted-conflict',
  folder: 'canary-deleted-folder',
});

const DOOMED = 'doomed-note';
const DOOMED_FOLDER = 'doomed-folder';

/** @type {Array<{close(): void}>} */
const open = [];
afterEach(() => {
  for (const one of open.splice(0)) one.close();
});

/**
 * Resolves with a request's result
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
const done = request =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * Puts `records` into the profile's CanvasTabDB as it is, at version 8, as 1.4.1 wrote them
 * @param {Profile} of
 * @param {Record<string, Array<Record<string, unknown>>>} records
 */
async function putAsItIs(of, records) {
  const db = await done(of.real.open('CanvasTabDB'));
  const tx = db.transaction(Object.keys(records), 'readwrite');
  for (const [store, list] of Object.entries(records)) for (const record of list) tx.objectStore(store).put(record);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

/**
 * v8.basic with a doomed note and a doomed folder holding every canary, and a note that stays
 * linked to the doomed one both ways
 * @returns {Promise<{of: Profile, kept: string}>}
 */
async function doomedProfile() {
  const fixture = /** @type {any} */ (FIXTURES.get('v8.basic'));
  const of = await profileWith(fixture);
  const notes = recordsIn(fixture, 'CanvasTabDB', 'canvases').map(record => record.value);
  const kept = notes[0].id;
  await putAsItIs(of, {
    canvases: [{ ...notes[0], id: DOOMED, name: CANARIES.title, folderId: DOOMED_FOLDER }],
    elements: [
      { id: 'doomed-b1', canvasId: DOOMED, type: 'text', content: CANARIES.block, order: 0 },
      { id: 'doomed-b2', canvasId: DOOMED, type: 'text', content: `${CANARIES.block}-2`, order: 1 },
    ],
    search_index: [{ noteId: DOOMED, name: CANARIES.title, content: CANARIES.search, updatedAt: NOW }],
    snapshots: [{ id: 'doomed-s1', noteId: DOOMED, timestamp: NOW, blocks: [{ content: CANARIES.snapshot }] }],
    links: [
      { id: 'doomed-l1', fromNoteId: DOOMED, toNoteId: kept, createdAt: NOW, text: CANARIES.linkFrom },
      { id: 'doomed-l2', fromNoteId: kept, toNoteId: DOOMED, createdAt: NOW, text: CANARIES.linkTo },
    ],
    media: [{ id: 'doomed-m1', canvasId: DOOMED, name: CANARIES.media, type: 'text/plain', createdAt: NOW }],
    vectors: [{ id: DOOMED, noteId: DOOMED, vector: [0.5], text: CANARIES.vector, updatedAt: NOW }],
    folders: [
      {
        id: DOOMED_FOLDER,
        name: CANARIES.folder,
        parentId: null,
        createdAt: NOW,
        updatedAt: NOW,
        color: null,
        collapsed: false,
      },
    ],
  });
  assert.equal((await run(of)).status, 'migrated');
  return { of, kept };
}

/**
 * A new-tab kernel on #17's adapter over `of`, as PR 4's new tab will have it
 * @param {Profile} of
 */
async function onIndexedDb(of) {
  const adapter = createIndexedDbAdapter({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    keyRange: KeyRange,
    clock: later,
  });
  await adapter.open();
  open.push(adapter);
  return kernelFor(adapter);
}

/**
 * A new-tab kernel on the legacy adapter over `of`, as the new tab has it until PR 4
 * @param {Profile} of
 */
async function onLegacy(of) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome });
  env.load('js/utils.js', 'js/storage.js');
  const storage = env.get('Storage');
  const adapter = createLegacyAdapter({ storage, settings: of.chrome.api.storage.local, mode: 'versioned' });
  await adapter.open();
  open.push({ close: () => storage.db && storage.db.close() });
  return kernelFor(adapter);
}

/** @param {KernelAdapter} adapter */
function kernelFor(adapter) {
  let count = 0;
  const ids = { next: () => `deletion-${(count += 1)}` };
  return createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock: later });
}

/**
 * A save of the doomed note from a revision it no longer has, which keeps its text in a
 * conflict record (#17's adapter, PR 2a)
 * @param {Profile} of
 */
async function loseASave(of) {
  const kernel = await onIndexedDb(of);
  await kernel.execute(
    /** @type {any} */ ({ type: 'renameNote', commandId: 'rename', noteId: DOOMED, name: 'Renamed' }),
  );
  const lost = await kernel.execute(
    /** @type {any} */ ({
      type: 'saveNoteContent',
      commandId: 'lost-save',
      noteId: DOOMED,
      blocks: [{ id: 'doomed-b1', canvasId: DOOMED, type: 'text', content: CANARIES.conflict, order: 0 }],
      expectedRevision: 0,
    }),
  );
  assert.equal(lost.kind, 'conflict', JSON.stringify(lost));
}

/**
 * Trashes the doomed note and deletes it for good, and deletes the doomed folder, on `kernel`
 * @param {import('../../js/kernel/core/application/kernel.js').Kernel} kernel
 */
async function deleteBoth(kernel) {
  const trashed = await kernel.execute(/** @type {any} */ ({ type: 'trashNote', commandId: 'trash', noteId: DOOMED }));
  assert.equal(trashed.kind, 'committed', JSON.stringify(trashed));
  const deleted = await kernel.execute(
    /** @type {any} */ ({ type: 'deleteNotePermanently', commandId: 'delete', noteId: DOOMED }),
  );
  assert.deepEqual(deleted.kind === 'committed' && deleted.code, 'note-deleted');
  const folder = await kernel.execute(
    /** @type {any} */ ({ type: 'deleteFolder', commandId: 'folder', folderId: DOOMED_FOLDER }),
  );
  assert.deepEqual(folder.kind === 'committed' && folder.code, 'folder-deleted');
}

/**
 * @param {Profile} of
 */
const purge = of =>
  purgeRecoveryPoints({
    indexedDB: of.faults.factory,
    keyRange: KeyRange,
    locks: legacyEnv.createLockManager(),
    crypto,
    clock: later,
    logger: { warn: (event, detail) => of.logs.push({ event, detail }) },
  });

/**
 * The canaries in `value`, wherever they are
 * @param {unknown} value
 * @returns {string[]}
 */
const canariesIn = value => {
  const strings = stringsIn(value);
  return Object.values(CANARIES).filter(canary => strings.some(text => text.includes(canary)));
};

/**
 * Every row a profile's points hold but the doomed entities', by point, store, and key
 * @param {import('../fixtures/storage/load-fixture.mjs').Fixture} dumped
 */
const otherRows = dumped =>
  recordsIn(dumped, 'NewTabNoteRecovery', 'rows')
    .map(record => record.value)
    .filter(row => canariesIn(row).length === 0)
    .map(row => JSON.stringify([row.pointId, row.store, row.key, row.sha256]))
    .sort();

/**
 * The pinned point, read back verified, and its pre-update export
 * @param {Profile} of
 */
async function pinnedAndExport(of) {
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
  try {
    const [point] = (await listPoints(recovery)).filter(candidate => candidate.pinned);
    const io = { keyRange: KeyRange, crypto, limits: DEFAULT_LIMITS };
    const verdict = await verifyPoint({ recovery, point, io });
    const file = await exportPoint({
      indexedDB: of.real,
      keyRange: KeyRange,
      crypto,
      clock,
      pointId: point.id,
      locks: legacyEnv.createLockManager(),
    });
    return { point, verdict, file: JSON.parse(JSON.stringify(file)) };
  } finally {
    recovery.close();
  }
}

describe('a note and a folder deleted for good leave nothing behind once the purge has run (#17 PR 2b)', () => {
  for (const [label, kernelOn] of /** @type {const} */ ([
    ["#17's adapter", onIndexedDb],
    ['the legacy adapter, as the new tab deletes', onLegacy],
  ])) {
    it(`through ${label}: no canary in either database or chrome.storage.local, and the point still verifies`, async () => {
      const { of, kept } = await doomedProfile();
      await loseASave(of);
      const migrated = await dump(of);
      // Every canary is somewhere before: the live notes, the point, and the conflict record
      assert.deepEqual(canariesIn(migrated).sort(), Object.values(CANARIES).sort());

      await deleteBoth(await kernelOn(of));
      const deleted = await dump(of);
      // The delete took every row of the note's from CanvasTabDB, its conflict record and the
      // links to it from a note that stays included
      assert.deepEqual(canariesIn(deleted.databases.filter(db => db.name === 'CanvasTabDB')), []);
      assert.deepEqual(
        recordsIn(deleted, 'CanvasTabDB', 'links').map(record => record.value.id),
        recordsIn(migrated, 'CanvasTabDB', 'links')
          .map(record => record.value.id)
          .filter(id => !id.startsWith('doomed-')),
      );
      // The point still holds them, until the purge
      assert.ok(canariesIn(deleted.databases.filter(db => db.name === 'NewTabNoteRecovery')).length > 0);
      const tombstones = recordsIn(deleted, 'CanvasTabDB', 'tombstones').map(record => record.value);
      assert.deepEqual(
        tombstones.map(({ entityType, id, reason, purge: pending }) => [entityType, id, reason, pending]).sort(),
        [
          ['folder', DOOMED_FOLDER, 'deleted', 'pending'],
          ['note', DOOMED, 'deleted', 'pending'],
        ],
      );

      const purged = await purge(of);
      assert.deepEqual([purged.status, purged.tombstones, purged.failure], ['purged', 2, null]);
      // The note's row, its two blocks, its search entry, snapshot, two links, media, and
      // vector, and the folder's row
      assert.equal(purged.rows, 10);
      const after = await dump(of);
      assert.deepEqual(canariesIn(after), []);
      assert.deepEqual(otherRows(after), otherRows(deleted));
      for (const tombstone of recordsIn(after, 'CanvasTabDB', 'tombstones').map(record => record.value)) {
        assert.equal('purge' in tombstone, false, JSON.stringify(tombstone));
        assert.equal(tombstone.purgedAt, DELETED_AT);
      }

      const { point, verdict, file } = await pinnedAndExport(of);
      assert.deepEqual(verdict, { ok: true });
      // The purged rows' keys, ids only, in their stores' lists
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(point.manifest)
            .filter(([, store]) => store.purged.length > 0)
            .map(([store, { purged: keys }]) => [store, [...keys].sort()]),
        ),
        {
          canvases: [DOOMED],
          elements: ['doomed-b1', 'doomed-b2'],
          folders: [DOOMED_FOLDER],
          links: ['doomed-l1', 'doomed-l2'],
          media: ['doomed-m1'],
          search_index: [DOOMED],
          snapshots: ['doomed-s1'],
          vectors: [DOOMED],
        },
      );
      const exportedIds = [...file.canvases, ...file.trashedCanvases].map((/** @type {any} */ note) => note.id);
      assert.ok(exportedIds.includes(kept));
      assert.equal(exportedIds.includes(DOOMED), false);
      assert.equal(
        file.folders.some((/** @type {any} */ folder) => folder.id === DOOMED_FOLDER),
        false,
      );
      assert.deepEqual(canariesIn(file), []);
      // A second sweep has nothing left to do
      assert.equal((await purge(of)).status, 'nothing');
    });
  }

  it('a note deleted below version 10 has no tombstone, so it stays in its point: the declared gap', async () => {
    // A shape no release made gets a point and no step, so it stays at 8 with a point, and the
    // new tab still runs on it
    const fixture = /** @type {any} */ (FIXTURES.get('v8.extra-store'));
    const of = await profileWith(fixture);
    const refused = await run(of);
    assert.deepEqual([refused.status, typeof refused.recoveryPointId], ['refused', 'string']);
    const noteId = recordsIn(fixture, 'CanvasTabDB', 'canvases')[0].value.id;
    const kernel = await onLegacy(of);
    await kernel.execute(/** @type {any} */ ({ type: 'trashNote', commandId: 'trash', noteId }));
    const deleted = await kernel.execute(
      /** @type {any} */ ({ type: 'deleteNotePermanently', commandId: 'delete', noteId }),
    );
    assert.equal(deleted.kind, 'committed', JSON.stringify(deleted));
    assert.equal((await purge(of)).status, 'nothing');
    const after = await dump(of);
    assert.equal(after.databases.find(db => db.name === 'CanvasTabDB')?.version, 8);
    assert.deepEqual(
      recordsIn(after, 'CanvasTabDB', 'canvases').filter(record => record.key === noteId),
      [],
    );
    const kept = recordsIn(after, 'NewTabNoteRecovery', 'rows').filter(
      record => record.value.store === 'canvases' && record.value.key === noteId,
    );
    assert.equal(kept.length, 1);
  });
});
