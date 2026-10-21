/**
 * Side Panel's composition root (#12, docs/adr/0001-kernel-stack.md). js/sidepanel.js reads
 * the notes it summarizes through this client.
 */

import { createLegacyAdapter } from '../adapters/legacy/adapter.js';
import { kernelClient, legacyHost } from './host.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyHost} LegacyHost */

/**
 * Side Panel's kernel and its client. It opens the database as it is, with no repair,
 * upgrade, or maintenance, and makes none on a profile without one. A database a newer build
 * upgraded is refused as `newer-schema`.
 * @param {LegacyHost} [host]
 * @returns {Client}
 */
export function createSidePanelClient(host = legacyHost()) {
  const adapter = createLegacyAdapter({ ...host, mode: 'existing' });
  return kernelClient({ adapter, surface: 'sidepanel' });
}
