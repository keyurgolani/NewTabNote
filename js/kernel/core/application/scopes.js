/**
 * Write scopes (#17, "Versions"; ports/repository.js, WriteScope). A derived command, such as
 * insights a job extracted, may change only the derived fields (domain/note.js,
 * DERIVED_FIELDS) of notes it read in its own transaction. Its units run over a transaction
 * that refuses anything else, so on every adapter a derived write can't change a note's name,
 * placement, or lifecycle, can't touch its blocks, and can't delete it.
 */

import { UnavailableError } from '../contracts/outcomes.js';
import { DERIVED_FIELDS } from '../domain/note.js';

/** @typedef {import('../ports/repository.js').Tx} Tx */
/** @typedef {import('../ports/repository.js').Unit} Unit */

const outsideScope = () => new UnavailableError('adapter', 'write-outside-scope', false);

/**
 * `value` as canonical JSON, keys sorted, or null when it has no JSON form
 * @param {unknown} value
 * @returns {string | null}
 */
function canonical(value) {
  /**
   * @param {string} _
   * @param {unknown} item
   */
  const sorted = (_, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = /** @type {Record<string, unknown>} */ (item);
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, record[key]]),
    );
  };
  try {
    return JSON.stringify(value, sorted);
  } catch {
    return null;
  }
}

/**
 * Whether a field holds the same value after a write as before it. A unit spreads the record
 * it read, so a field it left alone is the same value, and one it copied compares by content.
 * @param {unknown} before
 * @param {unknown} after
 */
function same(before, after) {
  if (Object.is(before, after)) return true;
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') return false;
  const text = canonical(before);
  return text !== null && text === canonical(after);
}

/**
 * A transaction over `tx` that takes only writes of derived fields to notes it read
 * @param {Tx} tx
 * @returns {Tx}
 */
function derivedTx(tx) {
  /** @type {Map<string, Record<string, unknown> | undefined>} */
  const read = new Map();
  return {
    get: (store, key) =>
      tx.get(store, key).then(record => {
        // What this transaction read, before the unit can change it
        if (store === 'notes') read.set(key, record && { ...record });
        return record;
      }),
    getAll: store => tx.getAll(store),
    getAllByIndex: (store, index, value) => tx.getAllByIndex(store, index, value),
    getKeysByIndex: (store, index, value) => tx.getKeysByIndex(store, index, value),
    revision: (store, key) => tx.revision(store, key),
    put: (store, record) => {
      const before = store === 'notes' ? read.get(/** @type {string} */ (record.id)) : undefined;
      if (!before) throw outsideScope();
      const after = /** @type {Record<string, unknown>} */ (record);
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!DERIVED_FIELDS.includes(key) && !same(before[key], after[key])) throw outsideScope();
      }
      tx.put(store, record);
    },
    delete: () => {
      throw outsideScope();
    },
  };
}

/**
 * `unit`, held to the derived scope
 * @param {Unit} unit
 * @returns {Unit}
 */
export function derivedOnly(unit) {
  return { ...unit, run: tx => unit.run(derivedTx(tx)) };
}
