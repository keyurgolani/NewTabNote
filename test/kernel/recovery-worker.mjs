// A stand-in for the service worker recovery.html sends its repairs' writes to (#35 slice 8), for
// the kernel tests that build recovery.html's root on a profile. It is the worker's own port router,
// installed as js/background.js installs it (composition/background.js, installWorkerRouter), with
// the handlers js/background.js gives it for what pages send (composition/coordinator.js,
// pageCommandHandlers), on the Chrome fake's runtime (chrome-fake.mjs). The coordinator's queue is
// what it stands in for: each command runs at once, if its request is still waited on, on the
// worker's kernel for the caller's surface, recovery.html's on its own table as the worker builds
// it, over the profile's CanvasTabDB through #17's adapter, which opens with the first command. It
// keeps each command it was handed, by type and surface, so a case can see what went over the port.

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { installWorkerRouter } from '../../js/kernel/composition/background.js';
import { pageCommandHandlers } from '../../js/kernel/composition/coordinator.js';
import { kernelClient } from '../../js/kernel/composition/host.js';
import { WORKER_PAGE_HANDLERS, WORKER_RECOVERY_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { createChromeFake } from './chrome-fake.mjs';

/** @typedef {import('../../js/kernel/adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../../js/kernel/composition/host.js').Client} Client */
/** @typedef {import('../../js/kernel/core/contracts/surfaces.js').Surface} Surface */

/**
 * The stand-in on `indexedDB`, and recovery.html's runtime to it
 * @param {{indexedDB: IDBFactory, settings: SettingsStore}} profile
 */
export function recoveryWorker({ indexedDB, settings }) {
  const fake = createChromeFake();
  /** @type {Array<[unknown, unknown]>} each command the queue was handed: its type, and the caller's surface */
  const handed = [];
  /** @type {ReturnType<typeof createIndexedDbAdapter> | null} */
  let adapter = null;
  /** @type {Map<Surface, Client>} */
  const kernels = new Map();
  /** @param {Surface} surface */
  const kernelOf = surface => {
    let kernel = kernels.get(surface);
    if (!kernel) {
      adapter ||= createIndexedDbAdapter({ indexedDB, settings, mode: 'existing', backups: true });
      const handlers = surface === 'recovery' ? WORKER_RECOVERY_HANDLERS : WORKER_PAGE_HANDLERS;
      kernel = kernelClient({ adapter, surface, handlers });
      kernels.set(surface, kernel);
    }
    return kernel;
  };
  const queue = /** @type {import('../../js/kernel/composition/coordinator.js').Coordinator} */ (
    /** @type {unknown} */ ({
      /** @param {any} command @param {{begin: () => boolean, surface: Surface}} dispatch */
      enqueue: async (command, { begin, surface }) => {
        handed.push([command.type, surface]);
        // As the coordinator's turn does, it runs nothing once the router stopped waiting for it
        if (!begin()) return rejected('validation', 'cancelled');
        return kernelOf(surface).execute(command);
      },
    })
  );
  fake.worker.install(chrome => {
    installWorkerRouter({ runtime: chrome.runtime, coordinatorId: 'coordinator-stand-in', handlers: pageCommandHandlers(() => queue) });
  });
  const page = fake.page('recovery');
  return {
    /** recovery.html's chrome.runtime, which its root's host hands its client */
    runtime: page.chrome.runtime,
    handed,
    /** Closes the page's ports and the worker, and the stand-in's database connection */
    close() {
      page.close();
      fake.worker.stop();
      if (adapter) adapter.close();
    },
  };
}
