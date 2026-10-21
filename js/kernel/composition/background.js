/**
 * The service worker's composition root (#12, docs/adr/0001-kernel-stack.md).
 *
 * js/background.js imports this module statically, so it evaluates before the worker
 * registers any listener. A throw while it loads, or a top-level await anywhere in what it
 * imports, leaves the extension without its context menus and commands, so loading it
 * touches no browser API. js/background.js builds the worker's kernel with
 * createWorkerClient() once its own imports, utils.js and storage.js, have put Utils and
 * Storage on self.
 */

import { createLegacyAdapter } from '../adapters/legacy/adapter.js';
import { kernelClient, legacyHost } from './host.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyHost} LegacyHost */

/**
 * The worker's kernel and its client. It opens the database versioned, as Storage.init did,
 * and runs startup maintenance before any command. Its caller, `worker-internal`, may capture
 * and maintain, and nothing else. Its connection closes when another context upgrades or
 * deletes the database, so it never blocks one, and the next capture opens it again: a
 * newer build's database is refused as `newer-schema`.
 * @param {LegacyHost} [host]
 * @returns {Client}
 */
export function createWorkerClient(host = legacyHost()) {
  const adapter = createLegacyAdapter({ ...host, mode: 'versioned', reopen: true });
  return kernelClient({ adapter, surface: 'worker-internal', maintainOnOpen: true });
}
