'use strict';

/**
 * Starts the legacy service worker, js/background.js, for the characterization suite's node
 * tier (test/characterization-background.test.js). Tests reach the worker only through
 * this file, and read records only through readTodaysDailyNote, so the PR that makes
 * background.js a module (#12 slice 1), and #35's coordinator rerouting captures, change
 * this file, its fakes, and its read, not the assertions.
 *
 * background.js runs as the worker loads it: test/helpers/legacy-env.js's worker context
 * importScripts the real js/utils.js and js/storage.js on fake-indexeddb, with chrome.*
 * fakes that record listeners. This file adds fakes for what the tests look at: the
 * context menus created, the active tab, and chrome.scripting.executeScript returning a
 * selection from that tab, as #5's extractSelection reads it (1.4.0 never calls it).
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, dumpDatabase, recordsOf, plain } = require('./legacy-env');

const ROOT = path.join(__dirname, '..', '..');
// #27 adds it; then every row has to take its release-build value here
const DEFINE_ALLOWLIST = path.join(ROOT, 'build', 'define-allowlist.json');

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
 * Start js/background.js on an empty profile and wait for its startup Storage.init().
 * @returns {Promise<{
 *   tab: {id: number, windowId: number, url: string, title: string},
 *   selection: {text: string, title: string, url: string},
 *   listenerCounts: () => Object<string, number>,
 *   contextMenus: () => Array<Object>,
 *   dispatch: (event: string, ...args: any[]) => Promise<void>,
 *   indexedDB: any,
 * }>}
 */
async function loadBackground() {
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

  env.load('js/background.js');
  // background.js keeps its startup Storage.init() as storageReady; captures await it too
  await env.get('storageReady');

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
     * they return. A listener that starts a capture without awaiting it returns first.
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
 * Today's Daily Note in IndexedDB, as { note, blocks } with its blocks in order, or null
 * while there is none. Today is the UTC date, as Storage.ensureDailyNote() keys it.
 */
async function readTodaysDailyNote(worker) {
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

module.exports = { loadBackground, readTodaysDailyNote };
