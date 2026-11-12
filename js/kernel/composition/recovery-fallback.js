/**
 * recovery.html's fallback (#35 slice 8): rebuild-index's batch committed in the page, on #17's
 * write adapter, only while the coordinator can't run it (./recovery.js says when). It takes Web
 * Lock storage.restore before it builds the adapter, and lets it go once the batch is in and the
 * adapter closed. The worker's coordinator checks that lock before each turn and pauses while
 * another context holds it (#35 slice 7), so nothing the worker commits runs beside the batch, and
 * a coordinator that comes up meanwhile opens only once the lock is free. Without Web Locks it
 * runs nothing.
 *
 * recovery.html's root loads it with import() at its first use, so the page's start holds the
 * reader alone and no writer (docs/architecture/committers.json, `inContext`).
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { rebuildCommands } from '../core/application/search-rebuild.js';
import { unavailable, unavailableFrom } from '../core/contracts/outcomes.js';
import { RESTORE_LOCK } from '../core/messaging/restore-messages.js';

/** @typedef {import('../adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/operations/rebuild-search-index.js').RebuildSearchIndex} RebuildSearchIndex */

/**
 * @typedef {object} RecoveryFallback
 * @property {(command: RebuildSearchIndex) => Promise<Outcome>} execute
 *   The batch's outcome: what its commit answered, or `unavailable` when it couldn't run
 */

/**
 * The fallback on recovery.html's host
 * @param {{
 *   indexedDB: IDBFactory,
 *   keyRange: typeof IDBKeyRange,
 *   settings: SettingsStore,
 *   locks: {request: (name: string, callback: (lock: unknown) => Promise<Outcome>) => Promise<Outcome>} | null,
 * }} host
 * @returns {RecoveryFallback}
 */
export function createRecoveryFallback({ indexedDB, keyRange, settings, locks }) {
  return Object.freeze({
    async execute(command) {
      // Nothing keeps the worker's coordinator from committing beside it
      if (!locks) return unavailable('adapter', 'locks-unavailable', false);
      const work = rebuildCommands.rebuildSearchIndex(command);
      if ('kind' in work) return work;
      return locks.request(RESTORE_LOCK, async () => {
        const adapter = createIndexedDbAdapter({ indexedDB, settings, keyRange, mode: 'existing' });
        try {
          await adapter.open();
          return (await adapter.commit(work)).outcome;
        } catch (error) {
          return unavailableFrom(error);
        } finally {
          adapter.close();
        }
      });
    },
  });
}
