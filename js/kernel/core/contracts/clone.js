/**
 * Copies of what crosses the kernel's edge: commands and queries coming in, outcomes, query
 * data, and the records the in-memory adapter stores. A caller that changes an object after
 * handing it over can't change what the kernel stores. And since anything this copies,
 * structuredClone copies too, #35 can move the kernel behind a message channel without
 * changing a caller.
 *
 * It copies plain objects (from any realm), arrays, Dates, and primitives. Functions,
 * symbols, cycles, and instances of any other class are refused with NotCloneableError.
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
  if (typeof value === 'function' || typeof value === 'symbol') throw new NotCloneableError(`a ${typeof value}`);
  if (value === null || typeof value !== 'object') return value;
  if (path.has(value)) throw new NotCloneableError('a cycle');
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Date]') return new Date(/** @type {Date} */ (value).getTime());
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => copy(item, path));
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) {
      const name = typeof proto.constructor === 'function' && proto.constructor.name ? proto.constructor.name : tag;
      throw new NotCloneableError(`an instance of ${name}`);
    }
    /** @type {Record<string, unknown>} */
    const result = {};
    const source = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(source)) result[key] = copy(source[key], path);
    return result;
  } finally {
    path.delete(value);
  }
}
