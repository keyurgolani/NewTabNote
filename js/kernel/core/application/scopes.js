/**
 * Write scopes (#17, "Versions"; ports/repository.js, WriteScope). A derived command, such as
 * insights a job extracted, may change only the derived fields (domain/note.js,
 * DERIVED_FIELDS) of notes it read in its own transaction, and the records #22's indexer
 * derives from a note (DERIVED_RECORDS) of a note it read and found there. Its units run over
 * a transaction that refuses anything else, so on every adapter a derived write can't change a
 * note's name, placement, or lifecycle, can't touch its blocks, can't delete it, and can't
 * leave a search entry or an embedding behind for a note that's gone.
 */

import { UnavailableError } from '../contracts/outcomes.js';
import { DERIVED_FIELDS } from '../domain/note.js';

/** @typedef {import('../ports/repository.js').Tx} Tx */
/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../ports/repository.js').StoreName} StoreName */

/**
 * The stores of records derived from one note, each with the field its note's id is in: a
 * note's search entry and its embedding (#17 PR 4b). A derived unit may put one only for a
 * note it read and found, and may delete one, since dropping either loses nothing the user wrote.
 * @type {Readonly<Partial<Record<StoreName, string>>>}
 */
export const DERIVED_RECORDS = Object.freeze({ searchIndex: 'noteId', vectors: 'id' });

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
 * A transaction over `tx` that takes only writes of derived fields to notes it read, and of
 * derived records (DERIVED_RECORDS) of notes it read and found
 * @param {Tx} tx
 * @returns {Tx}
 */
function derivedTx(tx) {
  /** @type {Map<string, Map<string, FieldForm> | undefined>} */
  const read = new Map();
  /**
   * The notes this transaction read and found, by id, from a get or a list of them
   * @type {Set<string>}
   */
  const found = new Set();
  /**
   * @template {Record<string, unknown> | undefined} R
   * @param {StoreName} store
   * @param {R[]} records
   * @returns {R[]}
   */
  const sawAll = (store, records) => {
    if (store === 'notes') for (const record of records) if (record) found.add(/** @type {string} */ (record.id));
    return records;
  };
  return {
    get: (store, key) =>
      tx.get(store, key).then(record => {
        // What this transaction read, before the unit can change it
        if (store === 'notes') {
          read.set(key, record && new Map(Object.entries(record).map(([field, value]) => [field, formOf(value)])));
          if (record) found.add(key);
        }
        return record;
      }),
    getAll: store => tx.getAll(store).then(records => sawAll(store, records)),
    getAllByIndex: (store, index, value) =>
      tx.getAllByIndex(store, index, value).then(records => sawAll(store, records)),
    getKeysByIndex: (store, index, value) => tx.getKeysByIndex(store, index, value),
    revision: (store, key) => tx.revision(store, key),
    versions: (store, key) => tx.versions(store, key),
    has: store => tx.has(store),
    dailyAnswer: () => tx.dailyAnswer(),
    put: (store, record) => {
      const keyField = DERIVED_RECORDS[store];
      if (keyField !== undefined) {
        const noteId = /** @type {Record<string, unknown>} */ (record)[keyField];
        if (typeof noteId !== 'string' || !found.has(noteId)) throw outsideScope();
        tx.put(store, record);
        return;
      }
      const before = store === 'notes' ? read.get(/** @type {string} */ (record.id)) : undefined;
      if (!before) throw outsideScope();
      const after = /** @type {Record<string, unknown>} */ (record);
      for (const field of new Set([...before.keys(), ...Object.keys(after)])) {
        if (!DERIVED_FIELDS.includes(field) && !same(before.get(field), after[field])) throw outsideScope();
      }
      tx.put(store, record);
    },
    delete: (store, key) => {
      if (DERIVED_RECORDS[store] === undefined) throw outsideScope();
      tx.delete(store, key);
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
