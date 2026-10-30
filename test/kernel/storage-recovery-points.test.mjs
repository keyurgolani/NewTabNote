// #17 PR 1a, verified recovery points (recovery-points.js, records.js): a record's hash sees
// every value IndexedDB keeps; verification catches a changed record, a missing id, an extra
// row, a key swapped for another, and a count off by one; a copy cut off mid-way resumes; only
// a failed verification discards a point, and only that one; the pinned pre-migration point
// survives later ones; purged ids (#17 PR 2, Q16) are accounted for; and every copy batch stays
// within 100 records or 2 MB.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  DEFAULT_LIMITS,
  ROWS_STORE,
  POINTS_STORE,
  committed,
  copyPoint,
  discardPoint,
  keepVerified,
  listPoints,
  openRecovery,
  startPoint,
  storesToCopy,
  verifyPoint,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import {
  approximateBytes,
  contentEntry,
  recordSha256,
  subtractHashes,
  taggedJson,
} from '../../js/kernel/adapters/indexeddb/records.js';
import { openWithoutUpgrade } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { KeyRange, Killed, legacyEnv, newProfile, profileWith, run, synthesized } from './migration-support.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */
/** @typedef {import('../../js/kernel/adapters/indexeddb/recovery-points.js').Point} Point */

const crypto = /** @type {any} */ (webcrypto);
const FIXTURES = synthesized();
const io = { keyRange: KeyRange, crypto, limits: DEFAULT_LIMITS };
const clock = { now: () => NOW };

/**
 * Makes a point of the profile's CanvasTabDB, copied in full but not yet verified
 * @param {Profile} of
 * @param {{id?: string, target?: number | null, limits?: typeof DEFAULT_LIMITS, hooks?: any}} [options]
 */
async function copied(of, { id = 'p1', target = 9, limits = DEFAULT_LIMITS, hooks } = {}) {
  const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(of.faults.factory, 'CanvasTabDB'));
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.faults.factory, { create: true }));
  const { point, progress } = await startPoint(recovery, {
    id,
    kind: 'pre-migration',
    sourceShape: 'legacy',
    sourceVersion: source.version,
    structuralVersion: null,
    logicalVersion: null,
    target,
    stores: storesToCopy(source),
    createdAt: NOW,
  });
  try {
    await copyPoint({ source, recovery, point, progress, io: { ...io, limits }, hooks });
  } finally {
    source.close();
  }
  return { recovery, point };
}

/**
 * Changes one row of a point in place, through its own connection
 * @param {Profile} of
 * @param {(store: IDBObjectStore) => void} change
 */
async function tamper(of, change) {
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
  const tx = recovery.transaction([ROWS_STORE, POINTS_STORE], 'readwrite');
  const done = committed(tx);
  change(tx.objectStore(ROWS_STORE));
  await done;
  recovery.close();
}

/**
 * One row's key and value, read raw
 * @param {Profile} of
 * @param {string} pointId
 * @param {string} store
 * @returns {Promise<any>}
 */
async function firstRow(of, pointId, store) {
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
  const tx = recovery.transaction(ROWS_STORE, 'readonly');
  const request = tx
    .objectStore(ROWS_STORE)
    .getAll(KeyRange.bound([pointId, store], [pointId, `${store}\u0000`], false, true), 1);
  const row = await new Promise(resolve => {
    request.onsuccess = () => resolve(request.result[0]);
  });
  recovery.close();
  return row;
}

/**
 * Every row of a point for `store`, read raw
 * @param {Profile} of
 * @param {string} pointId
 * @param {string} store
 * @returns {Promise<any[]>}
 */
async function rowsOf(of, pointId, store) {
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
  const tx = recovery.transaction(ROWS_STORE, 'readonly');
  const request = tx.objectStore(ROWS_STORE).getAll(KeyRange.bound([pointId, store], [pointId, `${store}\u0000`], false, true));
  const rows = await new Promise(resolve => {
    request.onsuccess = () => resolve(request.result);
  });
  recovery.close();
  return /** @type {any[]} */ (rows);
}

describe('a record hash', () => {
  it('sees what IndexedDB keeps: Blob bytes and type, binary data, Dates, undefined, Maps, Sets, -0, and an escaped $type', async () => {
    const hash = (/** @type {unknown} */ value) => recordSha256(value, crypto);
    const png = new Uint8Array([1, 2, 3]);
    assert.equal(
      await hash(new Blob([png], { type: 'image/png' })),
      await hash(new Blob([png], { type: 'image/png' })),
    );
    assert.notEqual(
      await hash(new Blob([png], { type: 'image/png' })),
      await hash(new Blob([png], { type: 'image/gif' })),
    );
    assert.notEqual(await hash(new Blob([png])), await hash(new Blob([new Uint8Array([1, 2, 4])])));
    assert.notEqual(await hash({ a: undefined }), await hash({}));
    assert.notEqual(await hash(new Date(0)), await hash(0));
    assert.notEqual(await hash(new Float32Array([1])), await hash(new Uint8Array([0, 0, 128, 63])));
    assert.notEqual(await hash(-0), await hash(0));
    assert.notEqual(await hash(new Map([['a', 1]])), await hash({ a: 1 }));
    assert.notEqual(await hash(new Set([1])), await hash([1]));
    assert.notEqual(await hash({ $type: 'Date', iso: '1970-01-01T00:00:00.000Z' }), await hash(new Date(0)));
    // eslint-disable-next-line no-sparse-arrays
    assert.notEqual(await hash([1, , 3]), await hash([1, undefined, 3]));
    assert.equal(await hash({ b: 1, a: 2 }), await hash({ a: 2, b: 1 }));
    assert.match(
      await taggedJson({ blob: new Blob([png], { type: 'image/png' }) }, crypto),
      /^\{"blob":\{"\$type":"Blob","sha256":"[0-9a-f]{64}","size":3,"type":"image\/png"\}\}$/,
    );
  });

  it('counts a Blob by its size, not its bytes as text, for the batch bound', () => {
    assert.ok(approximateBytes({ blob: new Blob([new Uint8Array(1000)]) }) >= 1000);
    assert.ok(approximateBytes({ text: 'x'.repeat(1000) }) >= 1000);
  });
});

describe('verification', () => {
  it('passes a point read back as it was copied', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.data-urls')));
    const { recovery, point } = await copied(of);
    assert.deepStrictEqual(await verifyPoint({ recovery, point, io }), { ok: true });
    recovery.close();
  });

  /** @type {Array<[string, (row: any, store: IDBObjectStore, rows: Record<string, any[]>) => void | Promise<void>, string]>} */
  const DAMAGE = [
    [
      'a changed record',
      (row, store) => store.put({ ...row, value: { ...row.value, name: 'changed' } }),
      'record-mismatch',
    ],
    [
      'a changed Blob',
      (row, store) => store.put({ ...row, value: { ...row.value, blob: new Blob(['other'], { type: 'image/png' }) } }),
      'record-mismatch',
    ],
    ['a missing id', (row, store) => store.delete([row.pointId, row.store, row.key]), 'count-mismatch'],
    [
      'an extra row (the count off by one)',
      async (row, store, rows) => {
        rows.pending.push({ ...row, key: `${row.key}-extra`, value: { ...row.value, id: `${row.key}-extra` } });
      },
      'count-mismatch',
    ],
    [
      'a key swapped for another, the count kept',
      async (row, store, rows) => {
        rows.removed.push([row.pointId, row.store, row.key]);
        rows.pending.push({ ...row, key: `${row.key}-other`, value: { ...row.value, id: `${row.key}-other` } });
      },
      'id-set-mismatch',
    ],
    [
      "a value whose key field no longer names its row's key, its row hash recomputed",
      async (row, store, rows) => {
        rows.pending.push({ ...row, value: { ...row.value, id: 'someone-else' } });
      },
      'key-mismatch',
    ],
    [
      'a row under a store the point never copied',
      (row, store) => store.put({ ...row, store: 'zz-not-copied' }),
      'count-mismatch',
    ],
    // Review R61's probes: each row agreeing with itself isn't enough
    [
      "a notes row holding a block's value and hash (probe A)",
      (row, store, rows) => store.put({ ...row, value: rows.elements[0].value, sha256: rows.elements[0].sha256 }),
      'key-mismatch',
    ],
    [
      'two notes rows with their values and hashes swapped (probe B)',
      (row, store, rows) => {
        const [a, b] = rows.canvases;
        store.put({ ...a, value: b.value, sha256: b.sha256 });
        store.put({ ...b, value: a.value, sha256: a.sha256 });
      },
      'key-mismatch',
    ],
    [
      'a changed record with its row hash recomputed (probe C)',
      async (row, store, rows) => {
        rows.pending.push({ ...row, value: { ...row.value, name: 'changed' } });
      },
      'content-mismatch',
    ],
    [
      'two notes rows swapped with their ids fixed and their hashes recomputed',
      async (row, store, rows) => {
        const [a, b] = rows.canvases;
        rows.pending.push({ ...a, value: { ...b.value, id: a.key } }, { ...b, value: { ...a.value, id: b.key } });
      },
      'content-mismatch',
    ],
    [
      "a block's value moved under a notes key, with its id and hash made to fit",
      async (row, store, rows) => {
        rows.pending.push({ ...row, value: { ...rows.elements[0].value, id: row.key } });
      },
      'content-mismatch',
    ],
  ];
  for (const [what, damage, code] of DAMAGE) {
    it(`catches ${what}`, async () => {
      const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
      const { recovery, point } = await copied(of);
      recovery.close();
      const store = what.includes('Blob') ? 'media' : 'canvases';
      const row = await firstRow(of, point.id, store);
      /** @type {Record<string, any[]>} */
      const rows = {
        canvases: await rowsOf(of, point.id, 'canvases'),
        elements: await rowsOf(of, point.id, 'elements'),
        pending: [],
        removed: [],
      };
      // Rows a case rewrites with a fresh hash, worked out before the transaction opens
      const rewrites = damage.constructor.name === 'AsyncFunction';
      if (rewrites) await damage(row, /** @type {any} */ (null), rows);
      /** @type {any[]} */
      const rehashed = [];
      for (const changed of rows.pending) rehashed.push({ ...changed, sha256: await recordSha256(changed.value, crypto) });
      await tamper(of, target => {
        if (rewrites) {
          for (const key of rows.removed) target.delete(key);
          for (const changed of rehashed) target.put(changed);
        }
        else damage(row, target, rows);
      });
      const reopened = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
      assert.deepStrictEqual(await verifyPoint({ recovery: reopened, point, io }), { ok: false, code });
      reopened.close();
    });
  }

  it('catches a manifest whose count is off by one', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const { recovery, point } = await copied(of);
    const off = {
      ...point,
      manifest: {
        ...point.manifest,
        canvases: { ...point.manifest.canvases, count: point.manifest.canvases.count + 1 },
      },
    };
    assert.deepStrictEqual(await verifyPoint({ recovery, point: off, io }), { ok: false, code: 'count-mismatch' });
    recovery.close();
  });
});

describe('purged ids (#17 PR 2, Q16)', () => {
  it('a row purged with its key in the manifest still verifies; one left behind, or purged without its key, does not', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const { recovery, point } = await copied(of);
    recovery.close();
    const row = await firstRow(of, point.id, 'canvases');
    // As PR 2's purge will: the key on the purge list, and the row's entry out of the content hash
    const entry = await contentEntry('canvases', await recordSha256(row.key, crypto), row.sha256, crypto);
    const canvases = point.manifest.canvases;
    /** @type {Point} */
    const purged = {
      ...point,
      manifest: {
        ...point.manifest,
        canvases: { ...canvases, purged: [row.key], contentHash: subtractHashes(canvases.contentHash, entry) },
      },
    };
    /** @type {Point} */
    const listedOnly = { ...point, manifest: { ...point.manifest, canvases: { ...canvases, purged: [row.key] } } };
    const check = async (/** @type {Point} */ which) => {
      const db = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
      const verdict = await verifyPoint({ recovery: db, point: which, io });
      db.close();
      return verdict;
    };
    assert.deepStrictEqual(await check(purged), { ok: false, code: 'purged-row-present' });
    await tamper(of, rows => rows.delete([row.pointId, row.store, row.key]));
    assert.deepStrictEqual(await check(purged), { ok: true });
    assert.deepStrictEqual(await check(point), { ok: false, code: 'count-mismatch' });
    // A purge that left the content hash as it was doesn't verify either
    assert.deepStrictEqual(await check(listedOnly), { ok: false, code: 'content-mismatch' });
  });
});

describe('a copy cut off', () => {
  it('resumes from its progress record and verifies, with each row once', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    let written = 0;
    const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(of.faults.factory, 'CanvasTabDB'));
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.faults.factory, { create: true }));
    const { point, progress } = await startPoint(recovery, {
      id: 'p1',
      kind: 'pre-migration',
      sourceShape: 'legacy',
      sourceVersion: 8,
      structuralVersion: null,
      logicalVersion: null,
      target: 9,
      stores: storesToCopy(source),
      createdAt: NOW,
    });
    const limits = { records: 1, bytes: DEFAULT_LIMITS.bytes };
    await assert.rejects(
      copyPoint({
        source,
        recovery,
        point,
        progress,
        io: { ...io, limits },
        hooks: {
          between: label => {
            if (label === 'copy-written' && ++written === 7) throw new Killed();
          },
        },
      }),
      Killed,
    );
    source.close();
    recovery.close();
    // A new worker reads the point and its progress from disk
    const resumed = await run(of, { limits });
    assert.equal(resumed.status, 'migrated');
    assert.equal(resumed.recoveryPointId, 'p1');
    const db = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    const [stored] = await listPoints(db);
    assert.equal(stored.status, 'verified');
    const fixture = /** @type {any} */ (FIXTURES.get('v8.basic'));
    for (const store of fixture.databases[0].stores) {
      if (store.name === 'settings') continue;
      assert.equal(stored.manifest[store.name].count, store.records.length, store.name);
    }
    db.close();
  });
});

describe('which points stay', () => {
  it('a failed verification discards only that point, and the pinned one survives it', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    // A pinned point from before, of a database this run won't match
    const { recovery, point } = await copied(of, { id: 'pinned', target: null });
    const pinned = await keepVerified({ recovery, point, clock, io });
    assert.equal(pinned.pinned, true);
    recovery.close();
    const outcome = await run(of, {
      hooks: {
        between: async label => {
          if (label !== 'copied') return;
          // The copy is damaged before verification reads it
          const row = await firstRow(of, `pre-migration-${NOW}`, 'elements');
          await tamper(of, rows => rows.put({ ...row, value: { ...row.value, content: 'damaged' } }));
        },
      },
    });
    assert.deepStrictEqual([outcome.status, outcome.failure], ['failed', { code: 'recovery-point-unverified' }]);
    const db = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    assert.deepStrictEqual(
      (await listPoints(db)).map(p => [p.id, p.status, p.pinned]),
      [['pinned', 'verified', true]],
    );
    assert.deepStrictEqual(await verifyPoint({ recovery: db, point: pinned, io }), { ok: true });
    const tx = db.transaction(ROWS_STORE, 'readonly');
    const leftover = await new Promise(resolve => {
      const request = tx
        .objectStore(ROWS_STORE)
        .count(KeyRange.bound([`pre-migration-${NOW}`], [`pre-migration-${NOW}\u0000`], false, true));
      request.onsuccess = () => resolve(request.result);
    });
    assert.equal(leftover, 0);
    db.close();
    // Nothing structural ran
    assert.equal(
      of.logs.some(line => line.event === 'storage-recovery-point-unverified'),
      true,
    );
  });

  it('the first verified pre-migration point is pinned; later ones keep only the newest beside it', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    // Before steps 9, 10, and 11, as #17's later PRs will make them
    for (const [id, target] of /** @type {const} */ ([['first', 9], ['second', 10], ['third', 11]])) {
      const { recovery, point } = await copied(of, { id, target });
      const ticking = { now: () => NOW + ['first', 'second', 'third'].indexOf(id) };
      await keepVerified({ recovery, point: { ...point, createdAt: ticking.now() }, clock: ticking, io });
      recovery.close();
    }
    const db = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    const points = await listPoints(db);
    assert.deepStrictEqual(
      points.map(p => [p.id, p.pinned]),
      [
        ['first', true],
        ['third', false],
      ],
    );
    for (const point of points) assert.deepStrictEqual(await verifyPoint({ recovery: db, point, io }), { ok: true });
    db.close();
  });

  it('a point remade before the same target replaces the older one, and takes its pin', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    for (const id of ['old', 'remade']) {
      const { recovery, point } = await copied(of, { id, target: 9 });
      const ticking = { now: () => NOW + ['old', 'remade'].indexOf(id) };
      await keepVerified({ recovery, point: { ...point, createdAt: ticking.now() }, clock: ticking, io });
      recovery.close();
    }
    const db = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    assert.deepStrictEqual(
      (await listPoints(db)).map(p => [p.id, p.target, p.pinned]),
      [['remade', 9, true]],
    );
    db.close();
  });

  it('discarding a point deletes its rows in bounded batches and nothing of another point', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const a = await copied(of, { id: 'a' });
    a.recovery.close();
    const b = await copied(of, { id: 'b' });
    const before = of.faults.transactions.length;
    await discardPoint(b.recovery, 'a', { keyRange: KeyRange, limits: { records: 3, bytes: DEFAULT_LIMITS.bytes } });
    const deletes = of.faults.transactions
      .slice(before)
      .filter(tx => tx.names.includes(ROWS_STORE) && tx.mode === 'readwrite');
    assert.ok(deletes.length > 3, `${deletes.length} delete batches`);
    assert.deepStrictEqual(
      (await listPoints(b.recovery)).map(p => p.id),
      ['b'],
    );
    assert.deepStrictEqual(await verifyPoint({ recovery: b.recovery, point: b.point, io }), { ok: true });
    b.recovery.close();
  });
});

describe('batch bounds (#17, "Accessibility and performance")', () => {
  /**
   * The rows each copy batch wrote, in order
   * @param {Record<string, any[]>} records
   * @returns {Promise<number[]>}
   */
  async function batches(records) {
    const of = newProfile();
    await legacyEnv.createDatabase(of.real, { records });
    /** @type {number[]} */
    const sizes = [];
    let last = 0;
    const hooks = {
      between: async (/** @type {string} */ label) => {
        if (label !== 'copy-written') return;
        const db = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
        const tx = db.transaction(ROWS_STORE, 'readonly');
        const count = await new Promise(resolve => {
          const request = tx.objectStore(ROWS_STORE).count();
          request.onsuccess = () => resolve(request.result);
        });
        db.close();
        sizes.push(/** @type {number} */ (count) - last);
        last = /** @type {number} */ (count);
      },
    };
    const { recovery } = await copied(of, { hooks });
    recovery.close();
    return sizes.filter(size => size > 0);
  }

  it('stops at 100 records', async () => {
    const notes = Array.from({ length: 250 }, (_, i) => legacyEnv.note(`n${String(i).padStart(3, '0')}`));
    assert.deepStrictEqual(await batches({ canvases: notes }), [100, 100, 50]);
  });

  it('stops at 2 MB, and copies a bigger record alone', async () => {
    const big = (/** @type {string} */ id, /** @type {number} */ size) =>
      legacyEnv.block(id, 'n1', 0, 'x'.repeat(size));
    const elements = [big('b1', 900_000), big('b2', 900_000), big('b3', 900_000), big('b4', 3_000_000), big('b5', 10)];
    assert.deepStrictEqual(await batches({ canvases: [legacyEnv.note('n1')], elements }), [1, 2, 1, 1, 1]);
  });
});
