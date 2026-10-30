/**
 * Static descriptor data. Descriptors are code-owned data plus their loader and probe, so
 * every other value a descriptor holds is plain data: strings, numbers, booleans, null, and
 * arrays and plain objects of them. Projections hand out frozen copies, so nothing that reads
 * a resolution can change a descriptor or another reader's view.
 */

const MAX_DEPTH = 8;

/**
 * Whether `value` is plain data, as above, no deeper than MAX_DEPTH
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {boolean}
 */
export function isPlainData(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every(item => isPlainData(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every(item => isPlainData(item, depth + 1));
}

/**
 * A deep frozen copy of plain data
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function frozenCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return /** @type {T} */ (Object.freeze(value.map(frozenCopy)));
  return /** @type {T} */ (
    Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenCopy(item)])))
  );
}
