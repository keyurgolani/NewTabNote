/**
 * The search indexer in the packaged build (#27 slice 1, a declared 1.4.x fix). Until #27 the
 * build left js/workers/indexer.js out, so new Worker('js/workers/indexer.js') 404ed in every
 * package, and since #81 each packaged new tab journaled indexer.start-failed and raised its
 * incident. Unpacked source loads always ran it. Now the worker starts, writes each note's
 * text into its search entry, and the command palette finds a note by a word only in its
 * body, as it does from source. A note's preview holds its first line only, so the word is
 * on the second. Since #27 slice 2 the indexer is a module worker the bundler builds as a chunk
 * of its own, which build-info.json's chunks names.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, expectNoUncaught, launchExtension, resolveDist, chunkFile } = require('./harness');
const driver = require('./characterization/driver');

/** The indexer's chunk in the build under test, such as assets/indexer-<hash>.js */
const indexerChunk = () => chunkFile(resolveDist(), 'indexer');

const NOTES = [
  { name: 'Groceries', blocks: [{ type: 'text', content: 'Weekly shop' }, { type: 'text', content: 'Buy saffron and limes' }] },
  { name: 'Errands', blocks: [{ type: 'text', content: 'Return the library books' }] },
];

/**
 * The text the search index holds for the note named `name`, or null without an entry
 */
function indexedContent(page, name) {
  return page.evaluate(async noteName => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('CanvasTabDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const entries = await new Promise((resolve, reject) => {
        const request = db.transaction('search_index').objectStore('search_index').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const entry = entries.find(item => item.name === noteName);
      return entry ? entry.content : null;
    } finally {
      db.close();
    }
  }, name);
}

/**
 * Every diagnostic journal record and incident #20's trust database holds, as JSON, or none
 * when it was never made. It's only opened when it exists, so reading it never makes one.
 */
function trustRecords(page) {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some(db => db.name === 'NewTabNoteTrust')) return [];
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('NewTabNoteTrust');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = ['journal', 'incidents'].filter(name => db.objectStoreNames.contains(name));
      const all = await Promise.all(stores.map(name => new Promise((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })));
      return all.flat().map(record => JSON.stringify(record));
    } finally {
      db.close();
    }
  });
}

/**
 * The note titles the command palette lists for `query`, opening it if it's closed (its
 * shortcut toggles it)
 */
async function paletteNotes(page, query) {
  const input = page.locator('#command-palette-input');
  if (!(await input.isVisible())) await page.keyboard.press('ControlOrMeta+Shift+KeyA');
  await input.fill(query);
  const items = page.locator('#command-palette-results .command-palette-item').filter({ has: page.locator('.kind-note') });
  return items.locator('.command-palette-item-title').allTextContents();
}

test('the packaged build starts the search indexer, and a word only in a note\'s body finds the note', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NOTES);
  const page = await driver.openNewTab(extension);

  // Only the indexer writes a note's text into its search entry
  await expect.poll(() => indexedContent(page, 'Groceries'), { timeout: 15_000 }).toContain('saffron');
  expect(await indexedContent(page, 'Errands')).toContain('library');
  await expect.poll(() => paletteNotes(page, 'saffron')).toEqual(['Groceries']);
  expect((await trustRecords(page)).filter(record => /indexer[.-]start-failed/.test(record))).toEqual([]);
  expect(extension.log()).not.toContain(`request failed: GET chrome-extension://${extension.extensionId}/${indexerChunk()}`);
  expect(extension.log()).not.toMatch(/request failed: GET chrome-extension:\/\/[^ ]+\/(js\/workers|assets)\/indexer/);
  await expectNoUncaught(extension, page);
});

// The spec's own check: a package without the worker's file, as every one before #27, fails
// it, and journals indexer.start-failed on the new tab
test('self-test: without the indexer\'s chunk the body word isn\'t indexed, and the start failure is journaled', async ({ playwright, headless }, testInfo) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-no-indexer-'));
  let extension;
  try {
    fs.cpSync(resolveDist(), dist, { recursive: true });
    fs.rmSync(path.join(dist, indexerChunk()));
    extension = await launchExtension({ dist, chromium: playwright.chromium, headless });
    await extension.seedOnboarded();
    await driver.seedNotes(extension, NOTES);
    const page = await driver.openNewTab(extension);
    await expect.poll(() => trustRecords(page).then(records => records.filter(record => /indexer\.start-failed/.test(record)).length), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await indexedContent(page, 'Groceries')).toBe('');
    expect(await paletteNotes(page, 'saffron')).toEqual([]);
  } catch (error) {
    if (extension) await testInfo.attach('no-indexer-extension-log', { body: extension.log(), contentType: 'text/plain' }).catch(() => {});
    throw error;
  } finally {
    if (extension) await extension.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});
