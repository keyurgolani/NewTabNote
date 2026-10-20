/**
 * Copies of what crosses the kernel's edge: commands and queries coming in, outcomes, query
 * data, and the records the in-memory adapter stores. A caller that changes an object after
 * handing it over can't change what the kernel stores.
 *
 * It copies what #13's JSON codec carries: plain objects (from any realm), arrays, strings,
 * booleans, null, and finite numbers. Dates, BigInts, NaN and the infinities, functions,
 * symbols, cycles, and instances of any other class are refused with NotCloneableError, so a
 * command the kernel takes in-process is one #35 can send over a port without a caller
 * changing. A key is copied as data, so an own `__proto__` key that JSON.parse made stays a key
 * and never re-parents the copy. A field whose value is `undefined` is copied as it is, since
 * stored records have them (a page with no title captures as a bookmark with
 * `title: undefined`). #13's codec (contracts/codec.js) leaves such a field out, as JSON does,
 * so a message sent through the router arrives without it.
 */

export class NotCloneableError extends Error {
  /** @param {string} what */
  constructor(what) {
    super(`Can't clone ${what}`);
    this.name = 'NotCloneableError';
  }
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function clone(value) {
  return /** @type {T} */ (copy(value, new Set()));
}

/**
 * @param {unknown} value
 * @param {Set<object>} path - the objects being copied, to refuse a cycle
 * @returns {unknown}
 */
function copy(value, path) {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new NotCloneableError(`a ${typeof value}`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new NotCloneableError(String(value));
  if (value === null || typeof value !== 'object') return value;
  if (path.has(value)) throw new NotCloneableError('a cycle');
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => copy(item, path));
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) {
      const tag = Object.prototype.toString.call(value);
      const name = typeof proto.constructor === 'function' && proto.constructor.name ? proto.constructor.name : tag;
      throw new NotCloneableError(`an instance of ${name}`);
    }
    /** @type {Record<string, unknown>} */
    const result = {};
    const source = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(source)) {
      Object.defineProperty(result, key, {
        value: copy(source[key], path),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    path.delete(value);
  }
}
