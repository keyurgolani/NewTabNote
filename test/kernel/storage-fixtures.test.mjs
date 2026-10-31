// The storage fixtures (#17 plan section 2, the format #28 slice 3 records into): every file
// parses under `ntn-storage-fixture/1`, stays under 256 KiB, and lists stores and records in
// key order; its CanvasTabDB matches shapes.json for its shape except what header.degraded
// lists; header.schema agrees with `meta`; a recorded fixture's fields are covered by the
// synthesized one of its shape; no string outside a canary looks like a secret; every
// synthesized fixture has an expected file; the loader and dumper round-trip each one; the
// registry's shapes are the catalog's; and the frozen release files are the tags' own.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { legacySchema, schemaAt } from '../../js/kernel/adapters/indexeddb/registry.js';
import { FORMAT, compareKeys, dumpFixture, fillCanaries, loadFixture } from '../fixtures/storage/load-fixture.mjs';
import { FIXTURES, newProfile } from './migration-support.mjs';

const SHAPES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'shapes.json'), 'utf8')).shapes;
const MAX_BYTES = 256 * 1024;

/**
 * Every fixture file under `kind`, as [relative path, parsed]
 * @param {string} kind
 * @returns {Array<[string, any]>}
 */
function filesOf(kind) {
  const dir = path.join(FIXTURES, kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => [`${kind}/${file}`, JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))]);
}

const ALL = [...filesOf('synthesized'), ...filesOf('recorded'), ...filesOf('expected')];

/**
 * What's wrong with a set of expected files: each must be `<fixture-id>.v<target>` for a
 * synthesized or recorded fixture, and every synthesized fixture needs its `.v9`
 * @param {string[]} expected
 * @param {string[]} synthesized
 * @param {string[]} recorded
 * @returns {string[]}
 */
function expectedProblems(expected, synthesized, recorded) {
  const fixtures = new Set([...synthesized, ...recorded]);
  const problems = [];
  for (const id of expected) {
    const match = /^(.+)\.v(\d+)$/.exec(id);
    if (!match) problems.push(`${id} isn't <fixture-id>.v<target>`);
    else if (!fixtures.has(match[1])) problems.push(`${id} names no fixture under synthesized/ or recorded/`);
  }
  for (const id of synthesized) if (!expected.includes(`${id}.v9`)) problems.push(`${id} has no expected file`);
  return problems;
}

/** Secret-looking strings; a canary placeholder is the only way a secret slot is written */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

/** Fields that hold a secret in some release; each must be empty or a canary in a fixture */
const SECRET_KEYS = new Set(['llmApiKey', 'setting_llmApiKey', 'password', 'apiKey', 'token']);

/**
 * Every [key, string] pair in a value, deep
 * @param {unknown} value
 * @param {string} [key]
 * @returns {Array<[string, string]>}
 */
function strings(value, key = '') {
  if (typeof value === 'string') return [[key, value]];
  if (Array.isArray(value)) return value.flatMap(item => strings(item, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, item]) => strings(item, k));
  return [];
}

/**
 * A store's shape without its line references
 * @param {any} store
 */
const shapeOf = store => ({
  keyPath: store.keyPath,
  autoIncrement: store.autoIncrement,
  indexes: store.indexes.map((/** @type {any} */ { name, keyPath, unique, multiEntry }) => ({
    name,
    keyPath,
    unique,
    multiEntry,
  })),
});

describe('every fixture file', () => {
  for (const [file, fixture] of ALL) {
    it(`${file}: the format, its size, and key order`, () => {
      assert.ok(fs.statSync(path.join(FIXTURES, file)).size < MAX_BYTES, 'over 256 KiB');
      assert.equal(fixture.format, FORMAT);
      const { header } = fixture;
      for (const field of [
        'id',
        'purpose',
        'shape',
        'releases',
        'provenance',
        'source',
        'schema',
        'degraded',
        'privacy',
      ]) {
        assert.ok(Object.hasOwn(header, field), `header.${field}`);
      }
      assert.ok(Object.hasOwn(SHAPES, header.shape), `unknown shape ${header.shape}`);
      assert.ok(['synthesized', 'recorded'].includes(header.provenance));
      assert.equal(path.basename(file, '.json'), header.id);
      assert.ok(Array.isArray(fixture.databases));
      const names = fixture.databases.map((/** @type {any} */ db) => db.name);
      assert.deepStrictEqual(names, [...names].sort());
      for (const db of fixture.databases) {
        const stores = db.stores.map((/** @type {any} */ s) => s.name);
        assert.deepStrictEqual(stores, [...stores].sort(), `${db.name}'s stores in order`);
        for (const store of db.stores) {
          const keys = store.records.map((/** @type {any} */ r) => r.key);
          for (let i = 1; i < keys.length; i++) {
            assert.ok(compareKeys(keys[i - 1], keys[i]) < 0, `${db.name}.${store.name} records in key order`);
          }
        }
      }
    });

    it(`${file}: CanvasTabDB is its shape, but for exactly what header.degraded lists`, () => {
      const { header } = fixture;
      const db = fixture.databases.find((/** @type {any} */ candidate) => candidate.name === 'CanvasTabDB');
      const expected = SHAPES[header.shape];
      const degraded = new Set(header.degraded);
      if (!db) {
        assert.equal(header.shape, 'none');
        assert.deepStrictEqual(header.degraded, []);
        return;
      }
      const idbVersion = [...degraded].find(item => item.startsWith('idb-version:'));
      assert.equal(db.version, idbVersion ? Number(idbVersion.split(':')[1]) : expected.idbVersion);
      const want = new Map(expected.stores.map((/** @type {any} */ s) => [s.name, shapeOf(s)]));
      for (const item of degraded) {
        if (item.startsWith('missing-store:')) {
          assert.ok(want.delete(item.slice('missing-store:'.length)), `${item} names no store of ${header.shape}`);
        }
      }
      const extras = [...degraded]
        .filter(item => item.startsWith('extra-store:'))
        .map(item => item.slice('extra-store:'.length));
      const have = db.stores.filter((/** @type {any} */ s) => !extras.includes(s.name));
      assert.deepStrictEqual(
        have.map((/** @type {any} */ s) => s.name),
        [...want.keys()].sort(),
      );
      for (const store of have) assert.deepStrictEqual(shapeOf(store), want.get(store.name), store.name);
      for (const item of degraded) {
        assert.match(item, /^(missing-store|extra-store|idb-version|meta-structural):/, `unknown degradation ${item}`);
      }
    });

    it(`${file}: header.schema agrees with meta`, () => {
      const { schema } = fixture.header;
      const db = fixture.databases.find((/** @type {any} */ candidate) => candidate.name === 'CanvasTabDB');
      const meta = db && db.stores.find((/** @type {any} */ s) => s.name === 'meta');
      const record = meta && meta.records.find((/** @type {any} */ r) => r.key === 'schema');
      assert.equal(schema.idbVersion, db ? db.version : null);
      assert.equal(schema.structuralVersion, record ? record.value.structuralVersion : null);
      assert.equal(schema.logicalVersion, record ? record.value.logicalVersion : null);
    });

    it(`${file}: no secret outside a canary`, () => {
      for (const [key, text] of strings(fixture)) {
        for (const pattern of SECRET_PATTERNS) assert.doesNotMatch(text, pattern, `${key} looks like a secret`);
        if (SECRET_KEYS.has(key))
          assert.match(text, /^(|\{\{CANARY:[a-z0-9-]+\}\})$/, `${key} holds a value, not a canary`);
      }
      // A settings row keyed llmApiKey holds its secret in `value`
      for (const db of fixture.databases) {
        for (const store of db.stores) {
          for (const record of store.records) {
            if (record.key === 'llmApiKey' && store.name === 'settings') {
              assert.match(
                String(record.value.value),
                /^(|\{\{CANARY:[a-z0-9-]+\}\})$/,
                'settings.llmApiKey holds a value',
              );
            }
          }
        }
      }
    });
  }

  it('every synthesized fixture has an expected file, and every expected file a fixture, synthesized or recorded', () => {
    const synthesized = filesOf('synthesized').map(([, f]) => f.header.id);
    const recorded = filesOf('recorded').map(([, f]) => f.header.id);
    const expected = filesOf('expected').map(([, f]) => f.header.id);
    assert.deepStrictEqual(expectedProblems(expected, synthesized, recorded), []);
    assert.ok(synthesized.length >= 15);
  });

  it("that check takes an expected file for a recorded fixture (#28 slice 3's), and refuses one for no fixture", () => {
    assert.deepStrictEqual(expectedProblems(['v8.basic.v9', 'v8.v1.4.0.v9'], ['v8.basic'], ['v8.v1.4.0']), []);
    assert.deepStrictEqual(expectedProblems(['v8.basic.v9', 'v8.gone.v9'], ['v8.basic'], []), [
      'v8.gone.v9 names no fixture under synthesized/ or recorded/',
    ]);
    assert.deepStrictEqual(expectedProblems([], ['v8.basic'], []), ['v8.basic has no expected file']);
  });

  it("a recorded fixture's fields are covered by the synthesized fixture of its shape (none recorded yet: #28 slice 3)", () => {
    /** @param {any} fixture */
    const fieldsOf = fixture => {
      /** @type {Map<string, Set<string>>} */
      const out = new Map();
      for (const db of fixture.databases) {
        for (const store of db.stores) {
          const fields = out.get(store.name) || new Set();
          for (const record of store.records) {
            if (record.value && typeof record.value === 'object')
              for (const field of Object.keys(record.value)) fields.add(field);
          }
          out.set(store.name, fields);
        }
      }
      return out;
    };
    for (const [file, recorded] of filesOf('recorded')) {
      const synthesized = filesOf('synthesized')
        .map(([, f]) => f)
        .filter(f => f.header.shape === recorded.header.shape);
      assert.ok(synthesized.length > 0, `${file}: no synthesized fixture of its shape`);
      assert.deepStrictEqual(recorded.header.schema, synthesized[0].header.schema);
      const covered = new Map();
      for (const f of synthesized) {
        for (const [store, fields] of fieldsOf(f))
          covered.set(store, new Set([...(covered.get(store) || []), ...fields]));
      }
      for (const [store, fields] of fieldsOf(recorded)) {
        for (const field of fields)
          assert.ok(covered.get(store)?.has(field), `${file}: ${store}.${field} has no synthesized cover`);
      }
    }
  });
});

describe('the loader and the dumper', () => {
  for (const [file, fixture] of filesOf('synthesized')) {
    it(`${file} loads and dumps back as itself`, async () => {
      const of = newProfile();
      const { databases } = await loadFixture(fixture, { factory: of.real, storage: of.chrome.api.storage.local });
      assert.deepStrictEqual(
        databases,
        fixture.databases.map((/** @type {any} */ db) => db.name),
      );
      const dumped = await dumpFixture({
        factory: of.real,
        storage: of.chrome.api.storage.local,
        header: fixture.header,
      });
      // An empty database at version 1 reads back as one, as IndexedDB keeps it
      assert.deepStrictEqual(
        dumped,
        fillCanaries({ ...fixture, chromeStorageLocal: fixture.chromeStorageLocal || {} }),
      );
    });
  }

  it('renames databases through `names`, and fills canaries from `canaries`', async () => {
    const [, fixture] = /** @type {[string, any]} */ (
      filesOf('synthesized').find(([file]) => file.includes('local-settings'))
    );
    const of = newProfile();
    await loadFixture(fixture, {
      factory: of.real,
      storage: of.chrome.api.storage.local,
      names: { CanvasTabDB: 'CanvasTabDB-test' },
      canaries: { 'llm-api-key': 'placed-here' },
    });
    assert.deepStrictEqual(
      (await of.real.databases()).map(db => db.name),
      ['CanvasTabDB-test'],
    );
    assert.equal(of.chrome.local.setting_llmApiKey, 'placed-here');
    const dumped = await dumpFixture({ factory: of.real, names: { CanvasTabDB: 'CanvasTabDB-test' } });
    assert.deepStrictEqual(
      dumped.databases.map(db => db.name),
      ['CanvasTabDB'],
    );
  });

  it('round-trips every tagged value', async () => {
    const { decodeValue, encodeValue } = await import('../fixtures/storage/load-fixture.mjs');
    const value = {
      blob: new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
      buffer: new Uint8Array([3]).buffer,
      floats: new Float32Array([0.5]),
      date: new Date(0),
      missing: undefined,
      map: new Map([['a', 1]]),
      set: new Set([2]),
      odd: { $type: 'not a tag' },
      nan: NaN,
      negative: -0,
      // eslint-disable-next-line no-sparse-arrays
      sparse: [1, , 3],
      labelled: Object.assign([4, 5], { label: 'kept' }),
    };
    const encoded = JSON.parse(JSON.stringify(await encodeValue(value)));
    assert.deepStrictEqual(await encodeValue(decodeValue(encoded)), encoded);
    assert.deepStrictEqual(encoded.odd, { $type: 'Object', value: { $type: 'not a tag' } });
    assert.deepStrictEqual(encoded.sparse, { $type: 'Array', length: 3, items: { 0: 1, 2: 3 }, props: {} });
    assert.deepStrictEqual(encoded.labelled, {
      $type: 'Array',
      length: 2,
      items: { 0: 4, 1: 5 },
      props: { label: 'kept' },
    });
    const decoded = decodeValue(encoded);
    assert.equal(decoded.sparse.length, 3);
    assert.equal(1 in decoded.sparse, false, 'the hole is a hole, not undefined');
    assert.equal(decoded.labelled.label, 'kept');
    // And the record hash, which tells a hole from undefined, reads the decoded value as the original
    const crypto = /** @type {any} */ ((await import('node:crypto')).webcrypto);
    const { recordSha256 } = await import('../../js/kernel/adapters/indexeddb/records.js');
    assert.equal(await recordSha256(decoded, crypto), await recordSha256(value, crypto));
  });
});

describe('the registry and the catalog', () => {
  it("step 9's stores are shapes.json's v9, and the legacy stores its v8", () => {
    /** @param {string} shape */
    const catalog = shape =>
      Object.fromEntries(SHAPES[shape].stores.map((/** @type {any} */ s) => [s.name, shapeOf(s)]));
    assert.deepStrictEqual(legacySchema(), catalog('v8'));
    assert.deepStrictEqual(schemaAt(9), catalog('v9'));
    assert.deepStrictEqual(schemaAt(8), catalog('v8'));
  });

  it('every release tag is in exactly one shape, from v1.0.0 to v1.4.1', () => {
    const releases = Object.values(SHAPES).flatMap((/** @type {any} */ s) => s.releases);
    assert.deepStrictEqual(releases, [
      'v1.0.0',
      'v1.1.0',
      'v1.1.1',
      'v1.1.2',
      'v1.1.3',
      'v1.1.4',
      'v1.1.5',
      'v1.2.0',
      'v1.3.0',
      'v1.4.0',
      'v1.4.1',
    ]);
  });
});

describe('the frozen release files (Q11)', () => {
  for (const tag of ['v1.4.0', 'v1.4.1']) {
    it(`${tag}: each file is the tag's own, by git blob and SHA-256`, () => {
      const dir = path.join(FIXTURES, 'releases', tag);
      const source = JSON.parse(fs.readFileSync(path.join(dir, 'SOURCE.json'), 'utf8'));
      assert.equal(source.tag, tag);
      assert.deepStrictEqual(
        source.files.map((/** @type {any} */ f) => f.path),
        ['js/storage.js', 'js/utils.js'],
      );
      for (const file of source.files) {
        const bytes = fs.readFileSync(path.join(dir, file.path));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        assert.equal(blob, file.gitBlob, file.path);
      }
    });
  }
});
