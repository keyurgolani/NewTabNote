/**
 * The one JSON codec every transport uses, the in-process one included (#13, "Topology"), so a
 * message means the same thing however it travels. It encodes only what JSON carries without
 * changing it: plain objects (from any realm), arrays without holes, strings, booleans, null,
 * and finite numbers. It refuses Dates, Maps, Sets, BigInts, functions, symbols, binary data
 * (ArrayBuffer, typed arrays, Blob), class instances, cycles, symbol keys, getters, hidden
 * properties, and nesting deeper than MAX_DEPTH. Timestamps are integers, which the schemas
 * check. -0 encodes as 0, as JSON has no negative zero.
 *
 * An object field whose value is `undefined` is left out, as JSON leaves it out, so it arrives
 * absent, which is what a schema's optional field takes it for. Stored records have such
 * fields: 1.4.x captures a page with no URL or title as a bookmark with `url` and `title`
 * undefined. `undefined` anywhere else is refused: JSON would send nothing for a whole
 * message, and null for an array item.
 */

import { MAX_DEPTH } from './limits.js';

/**
 * What the codec throws. A transport answers it as `invalid-payload`. `path` (a JSON Pointer
 * to the value it refused) is for tests and debugging: it never goes into an outcome or a log,
 * since a hostile message's keys could be anything.
 */
export class CodecError extends Error {
  /**
   * @param {string} problem
   * @param {string} path
   */
  constructor(problem, path) {
    super(`${problem} at ${path || '/'}`);
    this.name = 'CodecError';
    this.code = 'invalid-payload';
    this.problem = problem;
    this.path = path;
  }
}

/**
 * @param {string} path
 * @param {string | number} key
 * @returns {string}
 */
const child = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/**
 * Throws a CodecError for anything in `value` JSON can't carry as it is.
 * @param {unknown} value
 * @param {string} path
 * @param {number} depth
 * @param {Set<object>} open - the objects being walked, to refuse a cycle
 */
function check(value, path, depth, open) {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new CodecError("a number JSON can't hold", path);
      return;
    case 'object':
      break;
    default:
      throw new CodecError(`a value of type ${typeof value}`, path);
  }
  if (value === null) return;
  if (depth >= MAX_DEPTH) throw new CodecError('nesting too deep', path);
  if (open.has(value)) throw new CodecError('a cycle', path);
  open.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new CodecError('an array with a hole', child(path, index));
        check(value[index], child(path, index), depth + 1, open);
      }
      if (Object.keys(value).length !== value.length)
        throw new CodecError('an array with keys besides its items', path);
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) {
      throw new CodecError("an object that isn't plain", path);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw new CodecError('a symbol key', path);
      const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(value, key));
      if (!('value' in descriptor)) throw new CodecError('a getter or setter', child(path, key));
      if (!descriptor.enumerable) throw new CodecError('a hidden property', child(path, key));
      // Left out, as JSON leaves it out
      if (descriptor.value === undefined) continue;
      check(descriptor.value, child(path, key), depth + 1, open);
    }
  } finally {
    open.delete(value);
  }
}

/**
 * `value` as JSON text.
 * @param {unknown} value
 * @returns {string}
 * @throws {CodecError}
 */
export function encode(value) {
  check(value, '', 0, new Set());
  return JSON.stringify(value);
}

/**
 * Throws a CodecError when a parsed value nests deeper than MAX_DEPTH. It walks with its own
 * stack, so a deep message can't overflow the call stack.
 * @param {unknown} parsed
 */
function checkDepth(parsed) {
  /** @type {Array<[unknown, number]>} */
  const pending = [[parsed, 0]];
  while (pending.length > 0) {
    const [value, depth] = /** @type {[unknown, number]} */ (pending.pop());
    if (value === null || typeof value !== 'object') continue;
    if (depth >= MAX_DEPTH) throw new CodecError('nesting too deep', '');
    for (const item of Object.values(value)) pending.push([item, depth + 1]);
  }
}

/**
 * The value JSON text encodes.
 * @param {unknown} text
 * @returns {unknown}
 * @throws {CodecError}
 */
export function decode(text) {
  if (typeof text !== 'string') throw new CodecError("a message that isn't text", '');
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CodecError("text that isn't JSON", '');
  }
  checkDepth(value);
  return value;
}

/**
 * How many bytes `text` takes as UTF-8, which is what a message's size is measured in. A lone
 * surrogate counts as the three bytes of the replacement character it becomes.
 * @param {string} text
 * @returns {number}
 */
export function encodedBytes(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * `value` with every object's keys in sorted order
 * @param {unknown} value
 * @returns {unknown}
 */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map(key => [key, sorted(record[key])]),
  );
}

/**
 * `value` as canonical JSON: what encode() writes, undefined fields left out, with every
 * object's keys sorted, so two copies of one command read the same. #17 hashes it for a
 * command's payload hash.
 * @param {unknown} value
 * @returns {string}
 * @throws {CodecError}
 */
export function canonicalJson(value) {
  check(value, '', 0, new Set());
  return JSON.stringify(sorted(value));
}
