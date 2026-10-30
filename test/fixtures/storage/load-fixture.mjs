// The storage fixture format, `ntn-storage-fixture/1` (#17 plan section 2, shared with #28
// slice 3), and its loader and dumper. A fixture is one JSON object:
//
//   { format, header: {id, purpose, shape, releases, provenance, source, schema, degraded, privacy},
//     databases: [{name, version, stores: [{name, keyPath, autoIncrement, indexes, records}]}],
//     chromeStorageLocal: {...} }
//
// Records are {key, value} pairs, so out-of-line and compound keys work, and stores and
// records are sorted by key. Values JSON can't hold are tagged objects: Blob {$type, mime,
// base64}, ArrayBuffer and typed arrays {$type, base64}, Date {$type, iso}, undefined
// {$type}, Map and Set {$type, entries}, NaN, the infinities and -0 {$type: 'Number', value}.
// A plain object whose own key is `$type` is escaped as {$type: 'Object', value}. Keys use the
// same tags. Strings may hold {{CANARY:<slot>}}, filled from `canaries` (default
// `canary-<slot>`), so no real secret is ever committed.
//
// loadFixture opens each database at exactly its version, makes the declared stores and
// indexes in onupgradeneeded only, writes records in transactions of at most 100, writes
// chromeStorageLocal with storage.set, and runs no app code. dumpFixture reads every database
// a factory has, and chrome.storage.local when given, back into the same format, canonical, for
// deepStrictEqual against expected/. Both run on Node; #28 adds a browser host behind the same
// signatures.

export const FORMAT = 'ntn-storage-fixture/1';

/** Writes per transaction while loading */
const BATCH = 100;

const TAG = '$type';

/** @typedef {{name: string, keyPath: string | string[], unique: boolean, multiEntry: boolean}} FixtureIndex */
/** @typedef {{key: unknown, value: unknown}} FixtureRecord */
/** @typedef {{name: string, keyPath: string | string[] | null, autoIncrement: boolean, indexes: FixtureIndex[], records: FixtureRecord[]}} FixtureStore */
/** @typedef {{name: string, version: number, stores: FixtureStore[]}} FixtureDatabase */
/**
 * @typedef {object} Fixture
 * @property {string} format
 * @property {Record<string, any>} header
 * @property {FixtureDatabase[]} databases
 * @property {Record<string, unknown>} [chromeStorageLocal]
 */
/**
 * chrome.storage.local, or anything with its promise-returning get and set
 * @typedef {{get: (keys: string[] | null) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void>}} FixtureStorage
 */

/** The typed arrays structured clone keeps, by name */
const VIEWS = /** @type {Record<string, any>} */ ({
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
});

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const base64Of = bytes => Buffer.from(bytes).toString('base64');

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
const bytesOf = text => new Uint8Array(Buffer.from(text, 'base64'));

/**
 * `value` in the fixture format
 * @param {unknown} value
 * @returns {Promise<unknown>}
 */
export async function encodeValue(value) {
  if (value === undefined) return { [TAG]: 'undefined' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { [TAG]: 'Number', value: 'NaN' };
    if (value === Infinity) return { [TAG]: 'Number', value: 'Infinity' };
    if (value === -Infinity) return { [TAG]: 'Number', value: '-Infinity' };
    if (Object.is(value, -0)) return { [TAG]: 'Number', value: '-0' };
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Blob) {
    return { [TAG]: 'Blob', mime: value.type, base64: base64Of(new Uint8Array(await value.arrayBuffer())) };
  }
  if (value instanceof ArrayBuffer) return { [TAG]: 'ArrayBuffer', base64: base64Of(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const name = Object.prototype.toString.call(value).slice(8, -1);
    return { [TAG]: name, base64: base64Of(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (value instanceof Date) return { [TAG]: 'Date', iso: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  if (value instanceof Map) {
    const entries = [];
    for (const [key, item] of value) entries.push([await encodeValue(key), await encodeValue(item)]);
    return { [TAG]: 'Map', entries };
  }
  if (value instanceof Set) {
    const entries = [];
    for (const item of value) entries.push(await encodeValue(item));
    return { [TAG]: 'Set', entries };
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) items.push(await encodeValue(item));
    return items;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(record)) out[key] = await encodeValue(record[key]);
  return Object.hasOwn(record, TAG) ? { [TAG]: 'Object', value: out } : out;
}

/**
 * A value in the fixture format, as IndexedDB would hold it
 * @param {unknown} value
 * @returns {any}
 */
export function decodeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const record = /** @type {Record<string, any>} */ (value);
  if (Object.hasOwn(record, TAG)) {
    const tag = record[TAG];
    switch (tag) {
      case 'undefined':
        return undefined;
      case 'Number':
        return { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 }[/** @type {'NaN'} */ (record.value)];
      case 'Blob':
        return new Blob([bytesOf(record.base64)], { type: record.mime });
      case 'ArrayBuffer':
        return bytesOf(record.base64).slice().buffer;
      case 'Date':
        return new Date(record.iso === null ? NaN : record.iso);
      case 'Map':
        return new Map(record.entries.map((/** @type {[unknown, unknown]} */ [key, item]) => [decodeValue(key), decodeValue(item)]));
      case 'Set':
        return new Set(record.entries.map(decodeValue));
      case 'Object': {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [key, item] of Object.entries(record.value)) out[key] = decodeValue(item);
        return out;
      }
      default:
        if (Object.hasOwn(VIEWS, tag)) {
          const bytes = bytesOf(record.base64);
          const View = VIEWS[tag];
          const per = View.BYTES_PER_ELEMENT || 1;
          return new View(bytes.slice().buffer, 0, tag === 'DataView' ? bytes.length : bytes.length / per);
        }
        throw new Error(`unknown fixture tag ${String(tag)}`);
    }
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(record)) out[key] = decodeValue(item);
  return out;
}

/**
 * IndexedDB's key order for two keys in the fixture format: numbers, then dates, then strings
 * by UTF-16 code units, then binary keys by their bytes, then arrays item by item
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function compareKeys(a, b) {
  /** @param {any} key @returns {[number, any]} */
  const rank = key => {
    if (typeof key === 'number') return [0, key];
    if (typeof key === 'string') return [2, key];
    if (Array.isArray(key)) return [4, key];
    if (key && key[TAG] === 'Number') return [0, decodeValue(key)];
    if (key && key[TAG] === 'Date') return [1, Date.parse(key.iso)];
    if (key && typeof key.base64 === 'string') return [3, Buffer.from(key.base64, 'base64')];
    throw new Error('not a key');
  };
  const [ta, va] = rank(a);
  const [tb, vb] = rank(b);
  if (ta !== tb) return ta - tb;
  if (ta === 3) return Buffer.compare(va, vb);
  if (ta === 4) {
    for (let i = 0; i < Math.min(va.length, vb.length); i++) {
      const order = compareKeys(va[i], vb[i]);
      if (order !== 0) return order;
    }
    return va.length - vb.length;
  }
  return va < vb ? -1 : va > vb ? 1 : 0;
}

const CANARY = /\{\{CANARY:([a-z0-9-]+)\}\}/g;

/**
 * `value` (in the fixture format) with every canary filled in
 * @template T
 * @param {T} value
 * @param {Record<string, string>} [canaries]
 * @returns {T}
 */
export function fillCanaries(value, canaries = {}) {
  /** @param {unknown} item @returns {unknown} */
  const fill = item => {
    if (typeof item === 'string') return item.replace(CANARY, (_, slot) => canaries[slot] ?? `canary-${slot}`);
    if (Array.isArray(item)) return item.map(fill);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, fill(entry)]));
    }
    return item;
  };
  return /** @type {T} */ (fill(value));
}

/**
 * Every canary slot a fixture names
 * @param {unknown} value
 * @returns {string[]}
 */
export function canarySlots(value) {
  const slots = new Set();
  for (const match of JSON.stringify(value).matchAll(CANARY)) slots.add(match[1]);
  return [...slots].sort();
}

/**
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
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
const committed = tx =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });

/**
 * Loads `fixture` into `factory` (and `storage`), running no app code
 * @param {Fixture} fixture
 * @param {{factory: IDBFactory, names?: Record<string, string>, storage?: FixtureStorage, canaries?: Record<string, string>}} options
 * @returns {Promise<{databases: string[]}>}
 */
export async function loadFixture(fixture, { factory, names = {}, storage, canaries }) {
  if (fixture.format !== FORMAT) throw new Error(`not an ${FORMAT} fixture`);
  const filled = fillCanaries(fixture, canaries);
  const opened = [];
  for (const database of filled.databases) {
    const name = names[database.name] ?? database.name;
    const request = factory.open(name, database.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of database.stores) {
        /** @type {IDBObjectStoreParameters} */
        const options = { autoIncrement: store.autoIncrement };
        if (store.keyPath !== null) options.keyPath = store.keyPath;
        const created = db.createObjectStore(store.name, options);
        for (const index of store.indexes) {
          created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      }
    };
    const db = await done(request);
    try {
      for (const store of database.stores) {
        for (let start = 0; start < store.records.length; start += BATCH) {
          const tx = db.transaction(store.name, 'readwrite');
          const ended = committed(tx);
          const target = tx.objectStore(store.name);
          for (const record of store.records.slice(start, start + BATCH)) {
            const value = decodeValue(record.value);
            if (target.keyPath === null) target.put(value, decodeValue(record.key));
            else target.put(value);
          }
          await ended;
        }
      }
    } finally {
      db.close();
    }
    opened.push(name);
  }
  if (storage && filled.chromeStorageLocal) {
    /** @type {Record<string, unknown>} */
    const items = {};
    for (const [key, value] of Object.entries(filled.chromeStorageLocal)) items[key] = decodeValue(value);
    if (Object.keys(items).length > 0) await storage.set(items);
  }
  return { databases: opened };
}

/**
 * Reads one database back in the fixture format
 * @param {IDBFactory} factory
 * @param {string} name - its name in `factory`
 * @param {string} as - its name in the fixture
 * @returns {Promise<FixtureDatabase>}
 */
async function dumpDatabase(factory, name, as) {
  const request = factory.open(name);
  request.onupgradeneeded = () => {
    if (request.transaction) request.transaction.abort();
  };
  const db = await done(request);
  try {
    /** @type {FixtureStore[]} */
    const stores = [];
    for (const storeName of Array.from(db.objectStoreNames).sort()) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const indexes = Array.from(store.indexNames)
        .sort()
        .map(indexName => {
          const index = store.index(indexName);
          return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        });
      /** @type {Array<{key: IDBValidKey, value: unknown}>} */
      const raw = [];
      await new Promise((resolve, reject) => {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          raw.push({ key: cursor.primaryKey, value: cursor.value });
          cursor.continue();
        };
        tx.oncomplete = () => resolve(undefined);
        tx.onabort = () => reject(tx.error);
      });
      const records = [];
      for (const { key, value } of raw) records.push({ key: await encodeValue(key), value: await encodeValue(value) });
      stores.push({ name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, records });
    }
    return { name: as, version: db.version, stores };
  } finally {
    db.close();
  }
}

/**
 * Everything in `factory` (and `storage`) in the fixture format
 * @param {{factory: IDBFactory, names?: Record<string, string>, storage?: FixtureStorage, header?: Record<string, any>}} options
 * @returns {Promise<Fixture>}
 */
export async function dumpFixture({ factory, names = {}, storage, header = {} }) {
  const back = new Map(Object.entries(names).map(([fixtureName, actual]) => [actual, fixtureName]));
  const listed = await factory.databases();
  const databases = [];
  for (const { name } of listed.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (name === undefined) continue;
    databases.push(await dumpDatabase(factory, name, back.get(name) ?? name));
  }
  databases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  /** @type {Fixture} */
  const fixture = { format: FORMAT, header, databases };
  if (storage) {
    const local = await storage.get(null);
    /** @type {Record<string, unknown>} */
    const encoded = {};
    for (const key of Object.keys(local).sort()) encoded[key] = await encodeValue(local[key]);
    fixture.chromeStorageLocal = encoded;
  }
  return fixture;
}

/**
 * Reads a fixture file
 * @param {string | URL} file
 * @returns {Promise<Fixture>}
 */
export async function readFixture(file) {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(file, 'utf8'));
}
