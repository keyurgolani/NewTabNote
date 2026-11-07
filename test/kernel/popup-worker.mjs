// A stand-in for the service worker that Popup's root sends its writes to (#35 slice 4b-2), for
// the kernel tests that build Popup's root on a legacy-env profile. It is the worker's own port
// router, installed as js/background.js installs it (composition/background.js,
// installWorkerRouter), on the Chrome fake's runtime (chrome-fake.mjs), with handlers for
// Popup's two commands, createNote and applyCloseDraft. Each runs on a kernel of the caller's
// surface, on the shared catalog, over the profile's CanvasTabDB through #17's adapter. The
// coordinator's queue is all it leaves out, so it's a stand-in: the worker's own path, its queue
// and its kernel per surface, is held by test/kernel/worker-root.test.mjs,
// test/kernel/worker-router.test.mjs and test/background-coordinator.test.js, and by
// test/popup-sidepanel.test.js's quick note, which runs js/popup.js against js/background.js
// itself. It keeps each frame its ports heard, by its kind and operation, and what its router
// handed each command's handler, by the caller's surface and session, so a case can see what
// went over the port.

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { installWorkerRouter } from '../../js/kernel/composition/background.js';
import { kernelClient } from '../../js/kernel/composition/host.js';
import { closeDraftCommands } from '../../js/kernel/core/application/close-drafts.js';
import { handlerTable } from '../../js/kernel/core/application/handlers.js';
import { noteCommands } from '../../js/kernel/core/application/notes.js';
import { rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { createChromeFake } from './chrome-fake.mjs';

/** @typedef {import('../../js/kernel/adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../../js/kernel/composition/host.js').Client} Client */
/** @typedef {import('../../js/kernel/core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../../js/kernel/core/messaging/router.js').CoordinatorStatus} CoordinatorStatus */
/** @typedef {import('../../js/kernel/core/messaging/router.js').Dispatch} Dispatch */

/** Popup's two commands, as the worker serves them a page, on the shared catalog */
const PAGE_COMMANDS = handlerTable({
  commands: { createNote: noteCommands.createNote, applyCloseDraft: closeDraftCommands.applyCloseDraft },
});

/**
 * One command a handler was handed: who sent it, by the router's verified caller, and its type
 * and id
 * @typedef {{surface: Surface, sessionId: string, type: unknown, commandId: unknown}} Handed
 */

/**
 * The stand-in, and Popup's runtime to it: a popup.html page on the same fake, whose first send
 * starts the worker
 * @param {{
 *   indexedDB: IDBFactory,
 *   settings: SettingsStore,
 *   status?: () => CoordinatorStatus,
 *   before?: (handed: Handed) => unknown,
 * }} profile - `status`: what each welcome says, ready unless a case says otherwise. `before`:
 *   what a handler awaits once it's handed a command, before it begins it
 */
export function popupWorker({ indexedDB, settings, status, before }) {
  const fake = createChromeFake();
  /** @type {Array<{frame: unknown, operation: unknown}>} */
  const frames = [];
  /** @type {Handed[]} */
  const handed = [];
  const adapter = createIndexedDbAdapter({ indexedDB, settings, mode: 'existing' });
  /** @type {Map<Surface, Client>} each caller surface's kernel, on the one adapter */
  const kernels = new Map();
  /** @param {Surface} surface */
  const kernelOf = surface => {
    let kernel = kernels.get(surface);
    if (!kernel) {
      kernel = kernelClient({ adapter, surface, handlers: PAGE_COMMANDS });
      kernels.set(surface, kernel);
    }
    return kernel;
  };
  /**
   * A handler for either command, as the router calls it
   * @param {unknown} payload
   * @param {Dispatch} context
   */
  const serve = async (payload, context) => {
    const { surface, contextId } = context.caller;
    const { type, commandId } = /** @type {{type?: unknown, commandId?: unknown}} */ (payload);
    const one = { surface, sessionId: contextId, type, commandId };
    handed.push(one);
    if (before) await before(one);
    // As the coordinator's turn does, it runs nothing once the router stopped waiting for it
    if (!context.begin()) return rejected('validation', 'cancelled');
    return kernelOf(surface).execute(/** @type {any} */ (payload));
  };
  fake.worker.install(chrome => {
    // Each frame a page's port brings, heard beside the router, which reads it too
    chrome.runtime.onConnect.addListener((/** @type {any} */ port) => {
      port.onMessage.addListener((/** @type {unknown} */ text) => {
        const frame = typeof text === 'string' ? JSON.parse(text) : {};
        frames.push({ frame: frame.frame, operation: frame.operation });
      });
    });
    installWorkerRouter({
      runtime: chrome.runtime,
      coordinatorId: 'coordinator-stand-in',
      ...(status ? { status } : {}),
      handlers: Object.freeze({ createNote: serve, applyCloseDraft: serve }),
    });
  });
  const page = fake.page('popup');
  return {
    /** Popup's chrome.runtime, which its root's host hands its send chunk */
    runtime: page.chrome.runtime,
    /** The version the fake's manifest says, which the router's welcome says too */
    extensionVersion: /** @type {string} */ (page.chrome.runtime.getManifest().version),
    frames,
    handed,
    /** Closes the page's ports and the worker, and the stand-in's database connection */
    close() {
      page.close();
      fake.worker.stop();
      adapter.close();
    },
  };
}
