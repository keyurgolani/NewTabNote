'use strict';

// The new tab's toasts for what the closing tabs' drafts came to (#33, the stack's close-time
// PR): the recovered-note toast and the Trash one (V3), each in its final words, shown by App
// once its start's apply is done, through Utils.showToast into newtab.html's live region, which
// is on the page from the start (V2). The region sits 92 px up and 24 px in, clear of the AI
// chat's button and its input row, in every state (V4). The reads behind the words, and the
// lists taken under the drafts' lock, are in test/kernel/close-drafts-roots.test.mjs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, createDatabase, note, block } = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
const UNTOLD = 'ntn-recovered-untold';
const SAVED_UNTOLD = 'ntn-saved-untold';

/**
 * A new tab's page on a profile with A, its recovered note R, and C in the Trash, the untold
 * lists as `lists` gives them, App loaded, and the root's client over it, as newtab.js builds it
 * @param {{recovered?: Array<{id: string, of: string}>, savedInTrash?: Array<{id: string}>}} [lists]
 */
async function pageWith({ recovered = [], savedInTrash = [] } = {}) {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [
        note('A', { name: 'Alpha plan' }),
        note('R', { name: 'Recovered: Alpha plan' }),
        note('C', { name: 'Charlie', trashed: true, trashedAt: 1700000000500 }),
      ],
      elements: [block('a1', 'A', 0, 'alpha'), block('r1', 'R', 0, 'kept'), block('c1', 'C', 0, 'charlie')],
    },
  });
  const storage = env.global.localStorage;
  if (recovered.length > 0) storage.setItem(UNTOLD, JSON.stringify(recovered));
  if (savedInTrash.length > 0) storage.setItem(SAVED_UNTOLD, JSON.stringify(savedInTrash));
  env.load('js/utils.js', 'js/app.js');
  const newTab = await import('../js/kernel/composition/newtab.js');
  const kernel = newTab.createNewTabPageClient(
    newTab.createNewTabAdapter({
      indexedDB: env.indexedDB,
      settings: env.chrome.api.storage.local,
      awaitUpgrade: async () => {},
      locks: env.global.navigator.locks,
    }),
    { drafts: { storage, locks: env.global.navigator.locks }, wake: () => {} },
  );
  assert.equal(await kernel.whenReady(), null);
  const toasts = [];
  env.get('Utils').showToast = (message, type, duration) => toasts.push([message, type, duration]);
  const App = env.get('App');
  const errors = [];
  const app = Object.assign(Object.create(App.prototype), {
    kernel,
    logger: { error: (...args) => errors.push(args) },
  });
  return { env, app, toasts, errors, storage };
}

describe("the new tab's toasts for the closing tabs' drafts (V3)", () => {
  it('tells a recovered note in its exact words, as info for 6 s, and clears the list', async () => {
    const { app, toasts, storage } = await pageWith({ recovered: [{ id: 'R', of: 'A' }] });
    await app.tellCloseDrafts();
    assert.deepEqual(toasts, [['Kept your changes to “Alpha plan” from a closed tab in a recovered note.', 'info', 6000]]);
    assert.equal(storage.getItem(UNTOLD), null);
  });

  it('tells a note in the Trash a draft was saved into, in its exact words, and clears the list', async () => {
    const one = await pageWith({ savedInTrash: [{ id: 'C' }] });
    await one.app.tellCloseDrafts();
    assert.deepEqual(one.toasts, [["Saved your changes to “Charlie” from a closed tab. It's in the Trash.", 'info', 6000]]);
    assert.equal(one.storage.getItem(SAVED_UNTOLD), null);
  });

  it('tells both kinds at one start, the recovered note first', async () => {
    const { app, toasts } = await pageWith({ recovered: [{ id: 'R', of: 'A' }], savedInTrash: [{ id: 'C' }] });
    await app.tellCloseDrafts();
    assert.deepEqual(toasts.map(([message]) => message), [
      'Kept your changes to “Alpha plan” from a closed tab in a recovered note.',
      "Saved your changes to “Charlie” from a closed tab. It's in the Trash.",
    ]);
  });

  it('tells nothing at a start with nothing to tell, and nothing of an entry whose note went or left the Trash', async () => {
    const quiet = await pageWith();
    await quiet.app.tellCloseDrafts();
    assert.deepEqual(quiet.toasts, []);
    const gone = await pageWith({ recovered: [{ id: 'gone', of: 'A' }], savedInTrash: [{ id: 'A' }, { id: 'gone' }] });
    await gone.app.tellCloseDrafts();
    assert.deepEqual(gone.toasts, [], 'A is in Notes, and nothing is under the other ids');
    assert.deepEqual(gone.errors, []);
  });
});

describe("the toasts' live region and place (V2, V4)", () => {
  it('is on the new tab from the start, empty, polite and a status', () => {
    const html = fs.readFileSync(path.join(ROOT, 'newtab.html'), 'utf8');
    const regions = html.match(/<div class="toast-container"[^>]*>[^<]*<\/div>/g) || [];
    assert.deepEqual(regions, ['<div class="toast-container" aria-live="polite" role="status"></div>']);
  });

  it('a toast goes into that region, and makes none of its own', async () => {
    const env = createLegacyEnv();
    env.load('js/utils.js');
    const [region] = Object.values(env.document.stub([{ id: 'toasts' }]));
    region.className = 'toast-container';
    env.get('Utils').showToast('Kept', 'info', 6000);
    assert.equal(env.document.querySelectorAll('.toast-container').length, 1);
    assert.equal(region.children.length, 1);
    assert.equal(region.children[0].textContent, 'Kept');
  });

  it('sits 92 px up and 24 px in, and no other rule moves it', () => {
    const cssDir = path.join(ROOT, 'css');
    /** Every declaration block whose selector names .toast-container, across css/ */
    const rules = [];
    for (const file of fs.readdirSync(cssDir).filter((name) => name.endsWith('.css'))) {
      const text = fs.readFileSync(path.join(cssDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (match[1].includes('.toast-container')) rules.push({ file, selector: match[1].trim(), body: match[2] });
      }
    }
    assert.deepEqual(rules.map((rule) => [rule.file, rule.selector]), [['editor.css', '.toast-container']]);
    const declared = Object.fromEntries(rules[0].body.split(';').map((part) => part.split(':').map((side) => side.trim())).filter(([name]) => name));
    assert.equal(declared.bottom, '92px');
    assert.equal(declared.right, '24px');
  });
});
