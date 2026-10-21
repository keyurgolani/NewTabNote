'use strict';

/**
 * Starts the legacy service worker, js/background.js, for the characterization suite's node
 * tier (test/characterization-background.test.js). Tests reach the worker only through
 * this file, and read records only through readTodaysDailyNote, so the PR that makes
 * background.js a module (#12 slice 1), and #35's coordinator rerouting captures, change
 * this file, its fakes, and its read, not the assertions.
 *
 * background.js runs as Chrome runs it, a module service worker (#12 slice 1): startWorker
 * evaluates it and the modules it imports, the real js/utils.js, js/storage.js, and its
 * kernel composition root, as ES modules in test/helpers/legacy-env.js's worker context,
 * on fake-indexeddb, with chrome.* fakes that record listeners. That takes
 * vm.SourceTextModule, so node runs with --experimental-vm-modules (npm test passes it).
 * This file adds fakes for what the tests look at: the context menus created, the active
 * tab, and chrome.scripting.executeScript returning a selection from that tab, as #5's
 * extractSelection reads it (1.4.0 never calls it).
 */

const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createLegacyEnv, dumpDatabase, recordsOf, plain } = require('./legacy-env');

const ROOT = path.join(__dirname, '..', '..');
const WORKER_SCRIPT = 'js/background.js';
// What importScripts() throws in a module service worker
const MODULE_IMPORT_SCRIPTS = "Failed to execute 'importScripts' on 'WorkerGlobalScope': Module scripts don't support importScripts().";
// #27 adds it; then every row has to take its release-build value here
const DEFINE_ALLOWLIST = path.join(ROOT, 'build', 'define-allowlist.json');
// Rounds of queued work a capture may take before the worker counts as stuck
const DRAIN_LIMIT = 10_000;

// The tab chrome.tabs.query reports as active, and the selection chrome.scripting reads from it
const TAB = Object.freeze({ id: 7, windowId: 1, url: 'https://example.test/page', title: 'Example page' });
const SELECTION = Object.freeze({ text: 'Words selected on the page', title: TAB.title, url: TAB.url });

/**
 * The event fakes under `api` (anything with addListener and a listeners array), by name,
 * such as 'contextMenus.onClicked'
 */
function eventFakes(api, prefix = '') {
  const events = new Map();
  for (const [key, value] of Object.entries(api)) {
    if (!value || typeof value !== 'object') continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value.addListener === 'function' && Array.isArray(value.listeners)) {
      events.set(name, value);
    } else {
      for (const [inner, event] of eventFakes(value, name)) events.set(inner, event);
    }
  }
  return events;
}

/**
 * Let the worker finish everything it has queued. fake-indexeddb and the chrome.* fakes
 * run their callbacks through setImmediate, and the worker's timers are legacy-env's fake
 * clock, so once no setImmediate callback is pending nothing else will run. Unlike a fixed
 * number of settle() rounds, this also waits out a capture that takes longer, or a second
 * one a listener started.
 */
async function drain() {
  if (typeof process.getActiveResourcesInfo !== 'function') {
    throw new Error('process.getActiveResourcesInfo() is missing; load-background.js needs it to know when the worker is idle');
  }
  for (let round = 0; round < DRAIN_LIMIT; round++) {
    await new Promise(resolve => setImmediate(resolve));
    if (!process.getActiveResourcesInfo().includes('Immediate')) return;
  }
  throw new Error(`The worker still had work queued after ${DRAIN_LIMIT} rounds`);
}

/**
 * Evaluate js/background.js in `env`, a legacy-env worker context, the way Chrome starts a
 * module service worker: each module read from disk unmodified, linked by its relative
 * specifiers, and evaluated once, imports first. importScripts() throws, as it does in a
 * module worker. Resolves once the graph has evaluated, so its listeners are registered;
 * rejects with what a module threw while it evaluated, which would stop the real worker.
 * @param {ReturnType<typeof createLegacyEnv>} env
 * @returns {Promise<void>}
 */
async function startWorker(env) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('test/helpers/load-background.js runs the module service worker with vm.SourceTextModule, '
      + 'which needs node --experimental-vm-modules (npm test passes it)');
  }
  if (env.kind !== 'worker') throw new Error("startWorker needs createLegacyEnv({ context: 'worker' })");
  env.global.importScripts = () => { throw new TypeError(MODULE_IMPORT_SCRIPTS); };
  // What Chrome gives the worker that #13's router reads as it installs: the manifest, for
  // the extension's version, and crypto.randomUUID(), for the coordinator's id
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  env.chrome.api.runtime.getManifest = () => structuredClone(manifest);
  env.global.crypto = webcrypto;

  const modules = new Map();
  const moduleFor = file => {
    if (!modules.has(file)) {
      modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), {
        context: env.context,
        identifier: pathToFileURL(file).href,
      }));
    }
    return modules.get(file);
  };
  const worker = moduleFor(path.join(ROOT, WORKER_SCRIPT));
  await worker.link((specifier, referencing) => {
    if (!/^\.{1,2}\//.test(specifier)) {
      throw new Error(`${fileURLToPath(referencing.identifier)} imports ${JSON.stringify(specifier)}; the worker resolves only relative specifiers`);
    }
    return moduleFor(fileURLToPath(new URL(specifier, referencing.identifier)));
  });
  await worker.evaluate();
}

/**
 * Start js/background.js on an empty profile and wait until it has opened the database.
 * `mutate`, for the self-tests that check these assertions catch a broken worker, gets the
 * worker's global once it has started, to break something in it.
 * @param {{mutate?: (worker: any) => void}} [options]
 * @returns {Promise<{
 *   tab: {id: number, windowId: number, url: string, title: string},
 *   selection: {text: string, title: string, url: string},
 *   listenerCounts: () => Object<string, number>,
 *   contextMenus: () => Array<Object>,
 *   dispatch: (event: string, ...args: any[]) => Promise<void>,
 *   indexedDB: any,
 * }>}
 */
async function loadBackground({ mutate } = {}) {
  if (fs.existsSync(DEFINE_ALLOWLIST)) {
    throw new Error(`${path.relative(ROOT, DEFINE_ALLOWLIST)} exists: set each of its rows to its release-build value in test/helpers/load-background.js before loading the worker`);
  }

  const env = createLegacyEnv({ context: 'worker' });
  const menus = [];
  env.chrome.api.contextMenus.create = (properties, callback) => {
    menus.push(plain(properties));
    if (typeof callback === 'function') callback();
  };
  env.chrome.api.tabs.query = async () => [{ ...TAB }];
  env.chrome.api.scripting = {
    executeScript: async () => [{ frameId: 0, result: { ...SELECTION } }],
  };

  await startWorker(env);
  // background.js's kernel opens the database and runs startup maintenance as the worker
  // starts, and captures wait for it. A module's top-level bindings aren't globals, so wait
  // until the worker is idle, when that has settled, and check it opened the database.
  await drain();
  const { openState } = env.global.Storage;
  if (openState !== 'open') {
    throw new Error(`The worker's startup left Storage.openState at '${openState}' on an empty profile`);
  }
  if (mutate) mutate(env.global);

  const events = eventFakes(env.chrome.api);
  return {
    tab: TAB,
    selection: SELECTION,
    /** Listeners per chrome.* event, for each event that has any */
    listenerCounts: () => Object.fromEntries([...events]
      .filter(([, event]) => event.listeners.length > 0)
      .map(([name, event]) => [name, event.listeners.length])),
    /** The properties of each chrome.contextMenus.create call, in order */
    contextMenus: () => menus.map(menu => ({ ...menu })),
    /**
     * Fire a chrome.* event at the worker's listeners, as Chrome would, and wait for what
     * they return. A listener that starts a capture without awaiting it returns first;
     * readTodaysDailyNote waits for the capture.
     */
    async dispatch(name, ...args) {
      const event = events.get(name);
      if (!event) throw new Error(`No chrome.* event fake named ${name}`);
      for (const listener of [...event.listeners]) await listener(...args);
    },
    indexedDB: env.indexedDB,
  };
}

/**
 * Today's Daily Note in IndexedDB once the worker is idle, as { note, blocks } with its
 * blocks in order, or null when there is none. Today is the UTC date, as
 * Storage.ensureDailyNote() keys it.
 */
async function readTodaysDailyNote(worker) {
  await drain();
  const dump = await dumpDatabase(worker.indexedDB);
  const today = new Date().toISOString().slice(0, 10);
  const notes = Object.values(recordsOf(dump, 'canvases')).filter(note => note.isDaily && note.dateStr === today && !note.trashed);
  if (notes.length === 0) return null;
  if (notes.length > 1) throw new Error(`${notes.length} Daily Notes for ${today}`);
  const [note] = notes;
  const blocks = Object.values(recordsOf(dump, 'elements'))
    .filter(element => element.canvasId === note.id)
    .sort((a, b) => a.order - b.order);
  return { note, blocks };
}

module.exports = { loadBackground, readTodaysDailyNote, startWorker };
