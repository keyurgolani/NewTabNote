/**
 * Checks shared by js/product/topology.js and js/product/placement.js. Pure, with
 * no I/O and no browser globals, like both modules.
 */

/**
 * A check's result: the checked value, copied, or why it was rejected. Test
 * `result.ok === false` rather than `!result.ok`, which doesn't narrow under the
 * legacy jsconfig.json (no strictNullChecks).
 * @template T
 * @typedef {{ok: true, value: T} | {ok: false, reason: string}} Validation
 */

/**
 * @param {string} reason
 * @returns {{ok: false, reason: string}}
 */
export function invalid(reason) {
  return { ok: false, reason };
}

/**
 * Whether a value is a non-array object
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why a record's own keys aren't exactly `fields`, or null when they are
 * @param {Record<string, unknown>} record
 * @param {ReadonlyArray<string>} fields
 * @returns {string | null}
 */
export function fieldsIssue(record, fields) {
  const extra = Object.keys(record).find(key => !fields.includes(key));
  if (extra !== undefined) return `unexpected field ${JSON.stringify(extra)}`;
  const missing = fields.find(field => !Object.prototype.hasOwnProperty.call(record, field));
  if (missing !== undefined) return `missing field ${JSON.stringify(missing)}`;
  return null;
}

/**
 * Whether a value is one of a list of strings
 * @template {string} T
 * @param {ReadonlyArray<T>} list
 * @param {unknown} value
 * @returns {value is T}
 */
export function isOneOf(list, value) {
  return typeof value === 'string' && /** @type {ReadonlyArray<string>} */ (list).includes(value);
}

/**
 * isOneOf, or null. The null is in the guard because `value !== null` doesn't
 * narrow `unknown` without strictNullChecks.
 * @template {string} T
 * @param {ReadonlyArray<T>} list
 * @param {unknown} value
 * @returns {value is T | null}
 */
export function isOneOfOrNull(list, value) {
  return value === null || isOneOf(list, value);
}

/**
 * A note, folder, or block ID: a non-empty string that encodeURIComponent
 * accepts, so a note ID can always go in a URL
 * @param {unknown} value
 * @returns {value is string}
 */
export function isEntityId(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * isEntityId, or null
 * @param {unknown} value
 * @returns {value is string | null}
 */
export function isEntityIdOrNull(value) {
  return value === null || isEntityId(value);
}
