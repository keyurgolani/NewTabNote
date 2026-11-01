#!/usr/bin/env node
// Writes test/fixtures/storage/expected/<fixture-id>.v11.json from each synthesized fixture, and
// each fixture #28 slice 3 recorded from a release (recorded/, record-release.mjs), by
// #17's rules as the plan states them, with code of its own: it imports nothing from
// js/kernel/, so test/kernel/storage-migrate.test.mjs compares the runner against an
// independent derivation, not against itself. Run by hand after synthesize-storage.mjs; the
// output is committed and reviewed:
//
//   node scripts/fixtures/derive-expected.mjs
//
// The rules (#17 plan section 3, the lead's answers of 2026-10-30, #17 PR 2a's step 10, and #17
// PR 3b's step 11):
// - No database, or an empty one: CanvasTabDB at 11 with every v11 store, `meta.schema` at
//   11/1, the change log's empty head in `meta`, and `structural-9`, `structural-10`, and
//   `structural-11` completion receipts with no recovery point (there's nothing to copy).
// - A legacy shape (any subset of the ten stores, with canvases and elements): one verified,
//   pinned `pre-migration` point of every store but `settings`, made before the upgrade, then
//   CanvasTabDB at 11 with the stores it lacked (empty, version-8 indexes), step 10's and step
//   11's empty stores, meta, and the three receipts naming the point. No record changes.
// - At 9 with its receipt: a pinned point before 11 (of every store but `settings`, `meta` and
//   `migrations` included), then step 10's and 11's empty stores, `meta.schema` at 11 with the
//   logical version it had, the change log's head, and `structural-10` and `structural-11`
//   receipts naming the point.
// - At 10 with its receipts: a pinned point before 11 (of every store but `settings`, step 10's
//   included), then the empty daily index, `meta.schema` at 11 with the logical version it had,
//   the change log's head as it was, and a `structural-11` receipt naming the point.
// - Already at 11 with its receipts: nothing changes, and no recovery database appears.
// - A point's manifest gives each store its count, ID-set hash (the sum of its keys' hashes
//   mod 2^256), content hash (the sum of SHA-256([store, key hash, value hash]) per record),
//   key path, and an empty purge list.
// - missing-core, an extra store, or a newer database: CanvasTabDB stays exactly as it was,
//   and a point is made with no target (Q13).
// - Any database but CanvasTabDB a release left (a recorded fixture can hold one) stays as it was.
// The run's clock is test/kernel/support.mjs's NOW, held still, so every time is NOW.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { compareKeys, fillCanaries } from '../../test/fixtures/storage/load-fixture.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
const DIR = path.join(ROOT, 'test', 'fixtures', 'storage');
const SHAPES = JSON.parse(fs.readFileSync(path.join(DIR, 'shapes.json'), 'utf8'));
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const POINT_ID = `pre-migration-${NOW}`;
const TAG = '$type';
const BINARY = new Set([
  'Blob', 'ArrayBuffer', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView',
]);

const sha256 = data => createHash('sha256').update(data).digest('hex');

/** A fixture-format value as the hash reads it: binary bytes as their SHA-256 and size */
function hashForm(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(hashForm);
  // A sparse array, or one with extra keys: its holes tagged, its extra keys beside it
  if (value[TAG] === 'Array') {
    const items = [];
    for (let i = 0; i < value.length; i++) {
      items.push(Object.hasOwn(value.items, String(i)) ? hashForm(value.items[String(i)]) : { [TAG]: 'hole' });
    }
    return { [TAG]: 'Array', items, props: hashForm(value.props || {}) };
  }
  if (BINARY.has(value[TAG]) && typeof value.base64 === 'string') {
    const bytes = Buffer.from(value.base64, 'base64');
    return value[TAG] === 'Blob'
      ? { [TAG]: 'Blob', sha256: sha256(bytes), type: value.mime, size: bytes.length }
      : { [TAG]: value[TAG], sha256: sha256(bytes), size: bytes.length };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hashForm(item)]));
}

/** RFC 8785-style canonical JSON: keys sorted by UTF-16 code units */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const recordHash = value => sha256(canonical(hashForm(value)));
const addHash = (a, b) => ((BigInt(`0x${a}`) + BigInt(`0x${b}`)) % (1n << 256n)).toString(16).padStart(64, '0');
const ZERO = '0'.repeat(64);

const storeDef = (shape, name) => {
  const { keyPath, autoIncrement, indexes } = SHAPES.shapes[shape].stores.find(store => store.name === name);
  return { name, keyPath, autoIncrement, indexes: indexes.map(({ name: n, keyPath: k, unique, multiEntry }) => ({ name: n, keyPath: k, unique, multiEntry })), records: [] };
};

/** What happens to a fixture: `migrate` (from a legacy shape, from 9, or from none), `current`, or `refuse` */
function fate(fixture) {
  const { shape, degraded } = fixture.header;
  if (shape === 'none') return 'migrate-empty';
  if (shape === 'v11' && degraded.length === 0) return 'current';
  if (shape === 'v10' && degraded.length === 0) return 'migrate-from-10';
  if (shape === 'v9' && degraded.length === 0) return 'migrate-from-9';
  if (degraded.some(item => item.startsWith('extra-store:') || item.startsWith('idb-version:') || item === 'missing-store:canvases' || item === 'missing-store:elements')) {
    return 'refuse';
  }
  return 'migrate';
}

const SOURCE_SHAPE = fixture => {
  const { degraded } = fixture.header;
  if (degraded.some(item => item.startsWith('idb-version:') && Number(item.split(':')[1]) > 11)) return 'newer';
  if ((fixture.header.shape === 'v9' || fixture.header.shape === 'v10') && degraded.length === 0) return 'current';
  if (degraded.some(item => item.startsWith('extra-store:'))) return 'unknown';
  if (degraded.some(item => item === 'missing-store:canvases' || item === 'missing-store:elements')) return 'missing-core';
  return 'legacy';
};

/**
 * The recovery database holding the one point of `db` (the input database, encoded), made
 * before structural version `target` (null for none) from a database at `schema`'s versions
 */
function recoveryOf(fixture, db, target, schema = { structuralVersion: null, logicalVersion: null }) {
  const filled = fillCanaries(db);
  const stores = db.stores.map(store => store.name).filter(name => name !== 'settings').sort();
  const manifest = {};
  const rows = [];
  for (const name of stores) {
    const original = db.stores.find(store => store.name === name);
    const hashed = filled.stores.find(store => store.name === name);
    let idSetHash = ZERO;
    let contentHash = ZERO;
    original.records.forEach((record, i) => {
      const filledRecord = hashed.records[i];
      const keyHash = recordHash(filledRecord.key);
      const valueHash = recordHash(filledRecord.value);
      idSetHash = addHash(idSetHash, keyHash);
      // One entry per record over its store, key hash, and value hash (review R61)
      contentHash = addHash(contentHash, sha256(canonical([name, keyHash, valueHash])));
      rows.push({
        key: [POINT_ID, name, record.key],
        value: { pointId: POINT_ID, store: name, key: record.key, value: record.value, sha256: valueHash },
      });
    });
    manifest[name] = { count: original.records.length, idSetHash, contentHash, keyPath: original.keyPath, purged: [] };
  }
  rows.sort((a, b) => compareKeys(a.key, b.key));
  const point = {
    id: POINT_ID,
    kind: 'pre-migration',
    pinned: true,
    status: 'verified',
    sourceShape: SOURCE_SHAPE(fixture),
    sourceVersion: db.version,
    structuralVersion: schema.structuralVersion,
    logicalVersion: schema.logicalVersion,
    target,
    stores,
    createdAt: NOW,
    verifiedAt: NOW,
    manifest,
  };
  return {
    name: 'NewTabNoteRecovery',
    version: 1,
    stores: [
      { name: 'points', keyPath: 'id', autoIncrement: false, indexes: [], records: [{ key: POINT_ID, value: point }] },
      { name: 'progress', keyPath: 'pointId', autoIncrement: false, indexes: [], records: [] },
      { name: 'rows', keyPath: ['pointId', 'store', 'key'], autoIncrement: false, indexes: [], records: rows },
    ],
  };
}

/** A completion receipt, as migrate.js writes one per step */
const receipt = (id, from, to, recoveryPointId) => ({
  key: [id, 'completed'],
  value: { id, from, to, status: 'completed', startedAt: NOW, completedAt: NOW, recoveryPointId, failure: null },
});

/**
 * CanvasTabDB after the steps a database needs to reach 11: the stores it had, the ones it
 * lacked, the later steps' empty stores, meta at 11 with the change log's head (step 10 makes it
 * empty, and step 11 leaves it as it was), and a receipt per step it ran, each naming the point
 * made before them. A database at 9 or 10 keeps its own earlier receipts.
 */
function upgraded(db, recoveryPointId, { from = 8, logicalVersion = 1 } = {}) {
  const had = new Map((db ? db.stores : []).map(store => [store.name, structuredClone(store)]));
  const stores = SHAPES.shapes.v11.stores.map(store => had.get(store.name) || storeDef('v11', store.name));
  const meta = stores.find(store => store.name === 'meta');
  const head = from === 10 ? meta.records.find(record => record.key === 'changes') : null;
  meta.records = [
    head || { key: 'changes', value: { key: 'changes', head: 0, floor: 0 } },
    { key: 'schema', value: { key: 'schema', structuralVersion: 11, logicalVersion } },
  ];
  const migrations = stores.find(store => store.name === 'migrations');
  const steps = [
    receipt('structural-9', 8, 9, recoveryPointId),
    receipt('structural-10', 9, 10, recoveryPointId),
    receipt('structural-11', 10, 11, recoveryPointId),
  ];
  const ran = steps.filter(step => step.value.from >= from);
  migrations.records = [...migrations.records, ...ran].sort((a, b) => compareKeys(a.key, b.key));
  return { name: 'CanvasTabDB', version: 11, stores };
}

const files = ['synthesized', 'recorded'].flatMap(kind =>
  fs.existsSync(path.join(DIR, kind))
    ? fs.readdirSync(path.join(DIR, kind)).filter(file => file.endsWith('.json')).sort().map(file => path.join(kind, file))
    : [],
);
fs.mkdirSync(path.join(DIR, 'expected'), { recursive: true });
for (const file of files) {
  const fixture = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const db = fixture.databases.find(database => database.name === 'CanvasTabDB');
  const others = fixture.databases.filter(database => database.name !== 'CanvasTabDB');
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const header = { ...fixture.header, id: `${fixture.header.id}.v11`, purpose: `After the registry runs to 11 on ${fixture.header.id}.` };
  const at11 = logicalVersion => ({ shape: 'v11', degraded: [], schema: { idbVersion: 11, structuralVersion: 11, logicalVersion } });
  let databases;
  switch (fate(fixture)) {
    case 'current':
      databases = fixture.databases;
      break;
    case 'migrate-empty':
      databases = [...others, upgraded(null, null)].sort(byName);
      Object.assign(header, at11(1));
      break;
    case 'migrate':
      databases = [...others, upgraded(db, POINT_ID), recoveryOf(fixture, db, 11)].sort(byName);
      Object.assign(header, at11(1));
      break;
    case 'migrate-from-9':
    case 'migrate-from-10': {
      const from = fate(fixture) === 'migrate-from-9' ? 9 : 10;
      const schema = { structuralVersion: from, logicalVersion: fixture.header.schema.logicalVersion };
      databases = [
        ...others,
        upgraded(db, POINT_ID, { from, logicalVersion: schema.logicalVersion }),
        recoveryOf(fixture, db, 11, schema),
      ].sort(byName);
      Object.assign(header, at11(schema.logicalVersion));
      break;
    }
    case 'refuse':
      databases = [...others, db, recoveryOf(fixture, db, null)].sort(byName);
      break;
  }
  const expected = { format: fixture.format, header, databases, chromeStorageLocal: fixture.chromeStorageLocal || {} };
  fs.writeFileSync(path.join(DIR, 'expected', `${fixture.header.id}.v11.json`), `${JSON.stringify(expected, null, 2)}\n`);
}
console.log(`wrote ${files.length} expected files`);
