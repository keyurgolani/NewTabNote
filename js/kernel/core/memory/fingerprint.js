/**
 * What tells one command from another under the same commandId, for the in-memory adapter and
 * ledger: the command's canonical JSON, every object's keys sorted, so two copies of one
 * command compare alike. #17 hashes the same canonical JSON with SHA-256 instead (#13,
 * "Idempotency and catch-up").
 */

/**
 * @param {string} a
 * @param {string} b
 */
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `value` with every object's keys in sorted order
 * @param {unknown} value
 * @returns {unknown}
 */
const sortedKeys = value => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(
    Object.keys(record)
      .sort(byKey)
      .map(key => [key, sortedKeys(record[key])]),
  );
};

/**
 * @param {unknown} command
 * @returns {string}
 */
export const fingerprintOf = command => JSON.stringify(sortedKeys(command));
