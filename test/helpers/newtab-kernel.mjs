// The in-page kernel the tests build (#35 slice 4d, Q10): the new tab's kernel as its root built it
// before its writes went to the worker. #17's adapter in the page, opened as the database is on
// disk, with startup maintenance, #33's missing-stores copy and the backup tasks, and every handler
// the catalog allows on the new tab, its writes' handlers among them. The tests of the editor and
// App run on it, so they test those and not the port: test/kernel/newtab-port.test.mjs holds the
// root's sends, and test/newtab-page.test.js the root against the real worker.

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { kernelClient } from '../../js/kernel/composition/host.js';
import { CONTEXT_HANDLERS } from '../../js/kernel/core/application/handlers-newtab.js';
import { WORKER_PAGE_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { forSurface, handlerTable } from '../../js/kernel/core/application/handlers.js';
import { maintenanceCommands } from '../../js/kernel/core/application/maintenance.js';

/** @typedef {import('../../js/kernel/adapters/indexeddb/adapter.js').IndexedDbAdapter} IndexedDbAdapter */
/** @typedef {import('../../js/kernel/adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../../js/kernel/composition/host.js').Client} Client */

/** Every handler the catalog allows on the new tab: the page's own, and what the worker runs for it */
export const IN_PAGE_HANDLERS = forSurface(
  handlerTable({
    commands: { ...WORKER_PAGE_HANDLERS.commands, ...CONTEXT_HANDLERS.commands, ...maintenanceCommands },
    queries: CONTEXT_HANDLERS.queries,
    refusals: WORKER_PAGE_HANDLERS.refusals,
  }),
  'newtab',
);

/**
 * #17's adapter in the page, as the new tab's root opened it before #35 slice 4d
 * @param {{indexedDB: IDBFactory, settings: SettingsStore & {remove?: (keys: string[]) => Promise<void>},
 *   awaitUpgrade?: () => Promise<unknown>, locks?: any}} host
 * @returns {IndexedDbAdapter}
 */
export function newTabTestAdapter(host) {
  return createIndexedDbAdapter({
    indexedDB: host.indexedDB,
    settings: /** @type {any} */ (host.settings),
    awaitUpgrade: host.awaitUpgrade,
    locks: host.locks ?? null,
    mode: 'existing',
    requireCore: true,
    maintains: true,
    copiesMissingStores: true,
    backups: true,
  });
}

/**
 * The in-page kernel's client on `adapter` (newTabTestAdapter), as `newtab`, which runs startup
 * maintenance before any command
 * @param {IndexedDbAdapter} adapter
 * @returns {Client}
 */
export function newTabTestClient(adapter) {
  return kernelClient({ adapter, surface: 'newtab', handlers: IN_PAGE_HANDLERS, maintainOnOpen: true, ready: adapter.open() });
}
