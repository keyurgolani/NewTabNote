/**
 * What Popup's and Side Panel's roots share (#35 slices 4b-2 and 4c), whose reads stay in the
 * page on #17's read-only reader while their writes go to the worker: a kernel for the page's
 * queries alone on that reader, the page's own timers, and a wait those timers bound.
 */

import { UnavailableError, unavailable } from '../core/contracts/outcomes.js';
import { kernelClient } from './host.js';

/** @typedef {import('../adapters/indexeddb/reader.js').IndexedDbReader} IndexedDbReader */
/** @typedef {import('../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../core/ports/runtime.js').Timers} Timers */
/** @typedef {import('../core/application/handlers.js').HandlerTable} HandlerTable */
/** @typedef {import('../core/contracts/surfaces.js').Surface} Surface */

/** @type {Timers} the page's own */
export const PAGE_TIMERS = Object.freeze({
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
});

/**
 * #17's reader as the kernel's adapter, for a page's table of queries alone. Nothing that writes is
 * there: the kernel refuses a command its table doesn't hold before it recalls or commits anything
 * (kernel.js), so nothing reaches the stand-ins, and each answers as an adapter without it does.
 * It isn't exported, so nothing takes it for a whole adapter: every exported one runs the
 * kernel-adapter suite (test/kernel/conformance-inventory.mjs), which a queries-only one can't.
 * @param {IndexedDbReader} reader
 * @returns {KernelAdapter & {open(): Promise<void>}}
 */
function readsOnly(reader) {
  const noExport = () => Promise.reject(new UnavailableError('adapter', 'backups-need-legacy-storage', false));
  return Object.freeze({
    name: reader.name,
    flags: reader.flags,
    open: reader.open,
    read: reader.read,
    readSettings: reader.readSettings,
    ledger: reader.ledger,
    recall: () => undefined,
    commit: () => Promise.resolve({ outcome: unavailable('adapter', 'adapter-failed', false), replayed: false }),
    exportBackup: noExport,
    exportData: noExport,
  });
}

/**
 * A page's kernel for its queries alone, as `surface`, on #17's reader (readsOnly), and its
 * client. Popup's and Side Panel's roots read through it, and their writes go to the worker.
 * @param {IndexedDbReader} reader
 * @param {Surface} surface
 * @param {HandlerTable} handlers - the page's table, of queries alone
 */
export const readsKernel = (reader, surface, handlers) =>
  kernelClient({ adapter: readsOnly(reader), surface, handlers });

/**
 * Resolves once `done` does, which never rejects, or `ms` from now on `timers`, whichever is first
 * @param {Promise<unknown>} done
 * @param {Timers} timers
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const within = (done, timers, ms) =>
  new Promise(resolve => {
    const handle = timers.set(resolve, ms);
    done.then(() => {
      timers.clear(handle);
      resolve();
    });
  });
