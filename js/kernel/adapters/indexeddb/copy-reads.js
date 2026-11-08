/**
 * A store's values read for a copy on #17's adapter, which writes nothing (#35 slice 4d's P-a,
 * NTN-255). It moved out of recovery-copies.js, which writes #33's copy, so the storage guard's
 * raw export (raw-export.js) reaches no writer through it. #33's copy reads each store with it
 * as before.
 */

import { withDataUrls } from './data-urls.js';
import { endOf } from './requests.js';

/**
 * Every value of store `name`, each Blob in it as a data URL, read in a transaction of its own.
 * A store without a key path, which version 8 has none of, comes as `{key, value}` pairs. #33's
 * copy (recovery-copies.js) and the storage guard's raw export (raw-export.js) read each store
 * with it.
 * @param {IDBDatabase} db
 * @param {string} name
 * @returns {Promise<unknown[]>}
 */
export function readStoreForCopy(db, name) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly');
    const store = tx.objectStore(name);
    const values = store.getAll();
    const keys = store.keyPath === null ? store.getAllKeys() : null;
    endOf(tx).then(end =>
      end.committed ? resolve({ values: values.result || [], keys: keys ? keys.result : null }) : reject(end.error),
    );
  }).then(async read => {
    const { values, keys } = /** @type {{values: unknown[], keys: IDBValidKey[] | null}} */ (read);
    const converted = [];
    for (const value of values) converted.push(await withDataUrls(value));
    return keys ? converted.map((value, i) => ({ key: keys[i], value })) : converted;
  });
}
