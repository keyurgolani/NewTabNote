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
 * `value` as canonical JSON, keys sorted, or null when JSON can't write it out whole: a Map,
 * a Blob, or any object but a plain one or an array
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
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('no canonical form');
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
 * A field's value as it was read: a primitive as itself, and an object as its canonical text,
 * taken before the unit runs on, so a change the unit makes in place to the object still shows.
 * An object with no canonical form gets a token nothing equals, so a write that keeps it is
 * refused, since it can't be checked.
 * @typedef {{value: unknown} | {text: string} | {unchecked: true}} FieldForm
 */

/**
 * @param {unknown} value
 * @returns {FieldForm}
 */
function formOf(value) {
  if (value === null || typeof value !== 'object') return { value };
  const text = canonical(value);
  return text === null ? { unchecked: true } : { text };
}

/**
 * Whether a field holds the same value after a write as when it was read
 * @param {FieldForm | undefined} before - undefined for a field the record didn't have
 * @param {unknown} after
 */
function same(before, after) {
  if (!before) return after === undefined;
  const now = formOf(after);
  if ('value' in before) return 'value' in now && Object.is(before.value, now.value);
  if ('text' in before) return 'text' in now && before.text === now.text;
  return false;
}

/**
 * A transaction over `tx` that takes only writes of derived fields to notes it read
 * @param {Tx} tx
 * @returns {Tx}
 */
function derivedTx(tx) {
  /** @type {Map<string, Map<string, FieldForm> | undefined>} */
  const read = new Map();
  return {
    get: (store, key) =>
      tx.get(store, key).then(record => {
        // What this transaction read, before the unit can change it
        if (store === 'notes') {
          read.set(key, record && new Map(Object.entries(record).map(([field, value]) => [field, formOf(value)])));
        }
        return record;
      }),
    getAll: store => tx.getAll(store),
    getAllByIndex: (store, index, value) => tx.getAllByIndex(store, index, value),
    getKeysByIndex: (store, index, value) => tx.getKeysByIndex(store, index, value),
    revision: (store, key) => tx.revision(store, key),
    versions: (store, key) => tx.versions(store, key),
    has: store => tx.has(store),
    dailyAnswer: () => tx.dailyAnswer(),
    put: (store, record) => {
      const before = store === 'notes' ? read.get(/** @type {string} */ (record.id)) : undefined;
      if (!before) throw outsideScope();
      const after = /** @type {Record<string, unknown>} */ (record);
      for (const field of new Set([...before.keys(), ...Object.keys(after)])) {
        if (!DERIVED_FIELDS.includes(field) && !same(before.get(field), after[field])) throw outsideScope();
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
