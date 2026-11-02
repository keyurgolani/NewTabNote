/**
 * The browser host for the profile store (test/fixtures/storage/profile-store.mjs, #17 PR 4a,
 * Q8): its calls, run in an extension page or the service worker on that target's own
 * indexedDB, as fixture-host.js runs the fixture loader. The characterization driver seeds
 * through it, and a spec writes and reads the records 1.4.x's Storage wrote through it, with no
 * app code: since #17 PR 4a the worker has no Storage global, and 4b takes the new tab's.
 *
 *   const store = profileStore(extension.worker);   // or a Page the harness opened
 *   const note = await store.createNote('Beta');
 *   await store.saveElement({ id: generateId(), canvasId: note.id, type: 'text', content: 'beta body', order: 0 });
 *   const notes = await store.getAllNotes(true);
 *
 * Each of DatabaseManager's calls the specs make is here by its name, with its arguments, and
 * answers what 1.4.x's answered, once its transaction has committed: createNote, saveElement,
 * updateNote, archiveNote, unarchiveNote, trashNote, createFolder, deleteFolder, getAllNotes,
 * getNote, getElementsByNote, getAllFolders, getTrashedNotes, getTemplates and
 * getCustomThemes, and seedNotes for the driver. Arguments and answers cross as JSON, which
 * 1.4.x's note, block, folder and theme records are. generateId makes an id as Utils.generateId
 * did, here, without a call into the target. The store's source is evaluated in the target
 * through Playwright, which an extension page's CSP doesn't apply to, so nothing is added to
 * the extension under test.
 */

const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'storage', 'profile-store.mjs');

/** The store's calls, as test/kernel/profile-store.test.mjs holds them to the store's own */
const PROFILE_STORE_METHODS = Object.freeze([
  'createNote',
  'saveElement',
  'updateNote',
  'archiveNote',
  'unarchiveNote',
  'trashNote',
  'createFolder',
  'deleteFolder',
  'getAllNotes',
  'getNote',
  'getElementsByNote',
  'getAllFolders',
  'getTrashedNotes',
  'getTemplates',
  'getCustomThemes',
  'seedNotes',
]);

let body = null;

/**
 * The store's source as a script body: its `export` keywords dropped, so its functions are in
 * scope. It imports nothing at the top level, which this checks.
 */
function storeBody() {
  if (body !== null) return body;
  const source = fs.readFileSync(STORE, 'utf8');
  if (/^import\s/m.test(source)) throw new Error(`${STORE} has a static import, which the browser host can't run`);
  body = source.replace(/^export (?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, '');
  if (/^export\s/m.test(body)) throw new Error(`${STORE} has an export the browser host doesn't know how to drop`);
  return body;
}

/** An id as 1.4.x's Utils.generateId made one: the time, a dash, and up to nine base-36 characters */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * @param {{evaluate: Function}} target a Playwright Page or Worker of the extension
 */
function profileStore(target) {
  const call = (method, args) =>
    target.evaluate(
      `(async () => {\n${storeBody()}\nconst args = ${JSON.stringify(args)};\nreturn await createProfileStore(indexedDB).${method}(...args);\n})()`,
    );
  return Object.freeze(Object.fromEntries(PROFILE_STORE_METHODS.map(method => [method, (...args) => call(method, args)])));
}

module.exports = { profileStore, generateId, PROFILE_STORE_METHODS };
