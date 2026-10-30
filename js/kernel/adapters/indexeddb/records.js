/**
 * What a recovery point (recovery-points.js) needs to know about a stored record without
 * keeping anything from it but a hash: its SHA-256, and about how many bytes it takes.
 *
 * A record's SHA-256 is taken over contracts/codec.js's canonicalJson of the record with every
 * value JSON can't hold written as a tagged object first, so two records hash alike only when
 * IndexedDB would hand back the same value for both:
 * - a Blob (a File too) as `{$type: 'Blob', sha256, type, size}` of its bytes (#17,
 *   "Recovery points"), and an ArrayBuffer, typed array or DataView as `{$type, sha256, size}`
 * - a Date as `{$type: 'Date', iso}`, `undefined` as `{$type: 'undefined'}`, a Map or Set as
 *   `{$type, entries}`, a RegExp, a BigInt, NaN, the infinities and -0 by their own tags
 * - an array with holes or extra keys, and a plain object with its own `$type` key, escaped so
 *   it can't read as one of the tags above
 * Keys hash the same way, so the ID set of a store is a set of these hashes.
 *
 * Nothing here logs or returns a record: a hash and a size are all that leave.
 */

import { canonicalJson, encodedBytes } from '../../core/contracts/codec.js';

/**
 * Web Crypto, or anything with its subtle.digest
 * @typedef {{subtle: {digest: (algorithm: string, data: BufferSource) => Promise<ArrayBuffer>}}} Digester
 */

/** The tag key, as test/fixtures/storage/'s format spells it */
const TAG = '$type';

/**
 * Lowercase hex of `buffer`
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function hex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The SHA-256 of `bytes`, as hex
 * @param {Digester} crypto
 * @param {BufferSource} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(crypto, bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * The SHA-256 of `text` as UTF-8, as hex
 * @param {Digester} crypto
 * @param {string} text
 * @returns {Promise<string>}
 */
export function sha256OfText(crypto, text) {
  return sha256Hex(crypto, new TextEncoder().encode(text));
}

/**
 * The name of a binary view's constructor, as structured clone keeps it
 * @param {ArrayBufferView} view
 * @returns {string}
 */
function viewName(view) {
  return Object.prototype.toString.call(view).slice(8, -1);
}

/**
 * `value` with everything JSON can't hold tagged, Blob and binary bytes as their SHA-256
 * @param {unknown} value
 * @param {Digester} crypto
 * @returns {Promise<unknown>}
 */
async function tagged(value, crypto) {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (Number.isNaN(value)) return { [TAG]: 'Number', value: 'NaN' };
      if (value === Infinity) return { [TAG]: 'Number', value: 'Infinity' };
      if (value === -Infinity) return { [TAG]: 'Number', value: '-Infinity' };
      if (Object.is(value, -0)) return { [TAG]: 'Number', value: '-0' };
      return value;
    case 'undefined':
      return { [TAG]: 'undefined' };
    case 'bigint':
      return { [TAG]: 'BigInt', value: value.toString() };
    case 'object':
      break;
    default:
      // A function or symbol, which IndexedDB never stores
      return { [TAG]: 'Unsupported', kind: typeof value };
  }
  if (value === null) return null;
  if (typeof Blob === 'function' && value instanceof Blob) {
    return {
      [TAG]: 'Blob',
      sha256: await sha256Hex(crypto, await value.arrayBuffer()),
      type: value.type,
      size: value.size,
    };
  }
  if (value instanceof ArrayBuffer) {
    return { [TAG]: 'ArrayBuffer', sha256: await sha256Hex(crypto, value), size: value.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { [TAG]: viewName(value), sha256: await sha256Hex(crypto, bytes.slice()), size: value.byteLength };
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return { [TAG]: 'Date', iso: Number.isNaN(time) ? null : value.toISOString() };
  }
  if (value instanceof RegExp) return { [TAG]: 'RegExp', source: value.source, flags: value.flags };
  if (value instanceof Map) {
    const entries = [];
    for (const [key, item] of value) entries.push([await tagged(key, crypto), await tagged(item, crypto)]);
    return { [TAG]: 'Map', entries };
  }
  if (value instanceof Set) {
    const entries = [];
    for (const item of value) entries.push(await tagged(item, crypto));
    return { [TAG]: 'Set', entries };
  }
  if (value instanceof Error) return { [TAG]: 'Error', name: value.name, message: value.message };
  if (Array.isArray(value)) {
    const items = [];
    let holes = false;
    for (let index = 0; index < value.length; index++) {
      if (Object.hasOwn(value, index)) items.push(await tagged(value[index], crypto));
      else {
        holes = true;
        items.push({ [TAG]: 'hole' });
      }
    }
    const extra = Object.keys(value).filter(key => !/^(0|[1-9]\d*)$/.test(key));
    if (!holes && extra.length === 0) return items;
    /** @type {Record<string, unknown>} */
    const props = {};
    for (const key of extra) props[key] = await tagged(/** @type {any} */ (value)[key], crypto);
    return { [TAG]: 'Array', items, props };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // A boxed primitive, or another built-in structured clone keeps
    return { [TAG]: 'Boxed', kind: Object.prototype.toString.call(value), value: String(value) };
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(record)) out[key] = await tagged(record[key], crypto);
  return Object.hasOwn(record, TAG) ? { [TAG]: 'Object', value: out } : out;
}

/**
 * The SHA-256 of a stored record (or key), as hex, over its tagged canonical JSON
 * @param {unknown} value
 * @param {Digester} crypto
 * @returns {Promise<string>}
 */
export async function recordSha256(value, crypto) {
  return sha256OfText(crypto, canonicalJson(await tagged(value, crypto)));
}

/** Arithmetic on the 256-bit set hashes below */
const MODULUS = 1n << 256n;

/**
 * `a + b` modulo 2^256, for hex set hashes: the ID set of a store is the sum of its keys'
 * hashes, so it's the same in whatever order the keys come, and a purged key's hash can be
 * added back to check a set it was taken from (recovery-points.js, Q16)
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function addHashes(a, b) {
  return ((BigInt(`0x${a}`) + BigInt(`0x${b}`)) % MODULUS).toString(16).padStart(64, '0');
}

/**
 * `a - b` modulo 2^256: takes an entry's hash back out of a set hash, as permanent deletion's
 * purge (#17 PR 2) takes a purged row out of its store's content hash
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function subtractHashes(a, b) {
  return ((BigInt(`0x${a}`) - BigInt(`0x${b}`) + MODULUS) % MODULUS).toString(16).padStart(64, '0');
}

/** The hash of the empty set */
export const EMPTY_SET_HASH = '0'.repeat(64);

/**
 * One record's entry in its store's content hash: the SHA-256 of its store, its key's hash,
 * and its value's hash together, so the sum over a store binds each value to its key and its
 * store, and a value moved to another key or store changes it (review R61)
 * @param {string} store
 * @param {string} keyHash - recordSha256 of the key
 * @param {string} valueHash - recordSha256 of the value
 * @param {Digester} crypto
 * @returns {Promise<string>}
 */
export function contentEntry(store, keyHash, valueHash, crypto) {
  return sha256OfText(crypto, canonicalJson([store, keyHash, valueHash]));
}

/**
 * The key a value holds at `keyPath`, as IndexedDB reads it for an inline key, or undefined
 * when it holds none there
 * @param {unknown} value
 * @param {string | string[]} keyPath
 * @returns {unknown}
 */
export function keyAt(value, keyPath) {
  if (Array.isArray(keyPath)) {
    const parts = keyPath.map(path => keyAt(value, path));
    return parts.some(part => part === undefined) ? undefined : parts;
  }
  if (keyPath === '') return value;
  /** @type {unknown} */
  let at = value;
  for (const name of keyPath.split('.')) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, name)) return undefined;
    at = /** @type {Record<string, unknown>} */ (at)[name];
  }
  return at;
}

/**
 * About how many bytes `value` takes stored: its strings as UTF-8, numbers as 8, Blobs and
 * binary data by their size. For the 2 MB batch bound and the space check, never exact.
 * @param {unknown} value
 * @returns {number}
 */
export function approximateBytes(value) {
  /** @type {unknown[]} */
  const pending = [value];
  let bytes = 0;
  // Each value once, so a shared reference isn't counted twice and a cycle can't loop
  const seen = new Set();
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string') bytes += encodedBytes(item) + 2;
    else if (typeof item === 'number' || typeof item === 'bigint') bytes += 8;
    else if (typeof item === 'boolean' || item === null || item === undefined) bytes += 4;
    else if (typeof item === 'object') {
      if (seen.has(item)) continue;
      seen.add(item);
      if (typeof Blob === 'function' && item instanceof Blob) bytes += item.size;
      else if (item instanceof ArrayBuffer) bytes += item.byteLength;
      else if (ArrayBuffer.isView(item)) bytes += item.byteLength;
      else if (item instanceof Date) bytes += 8;
      else if (item instanceof Map) {
        for (const [key, entry] of item) pending.push(key, entry);
      } else if (item instanceof Set) {
        for (const entry of item) pending.push(entry);
      } else {
        for (const [key, entry] of Object.entries(item)) {
          bytes += encodedBytes(key) + 2;
          pending.push(entry);
        }
      }
    }
  }
  return bytes;
}

/**
 * The tagged JSON of `value`, for tests that check the tags (never logged)
 * @param {unknown} value
 * @param {Digester} crypto
 * @returns {Promise<string>}
 */
export async function taggedJson(value, crypto) {
  return canonicalJson(await tagged(value, crypto));
}
