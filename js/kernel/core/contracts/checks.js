/**
 * The few shape checks a use case needs before it can run. Slice 3 has no schema library:
 * #13 adds validators to the catalog, with Valibot. Until then a command that fails one of
 * these, or an invariant, is `rejected` with reason `validation`.
 */

/**
 * An id the kernel can store and look up: a non-empty string.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isId(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * @param {unknown} value
 * @returns {value is string | null}
 */
export function isIdOrNull(value) {
  return value === null || isId(value);
}

/**
 * A plain object, not an array.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
export function isIdList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isId);
}

/**
 * The keys of `values` that `allowed` doesn't list.
 * @param {Record<string, unknown>} values
 * @param {readonly string[]} allowed
 * @returns {string[]}
 */
export function unknownKeys(values, allowed) {
  return Object.keys(values).filter(key => !allowed.includes(key));
}

/**
 * `values` without the keys whose value is undefined. #13's codec leaves such a key out of a
 * message, so a command that sets values by key does the same in-process, and both paths
 * agree on what it sets.
 * @param {Record<string, unknown>} values
 * @returns {Record<string, unknown>}
 */
export function definedValues(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
