// recovery.html's views (#20 slice 4b): js/trust/ui/view.js drawn in legacy-env's FakeDocument
// on the page's real root (js/kernel/composition/recovery.js), over production js/storage.js
// and fake-indexeddb, as the page runs them. The page opens on its notes database: it draws
// its error state, and runs no row, when that database can't open. Once it opens, it draws the
// stored receipts, runs the open check, and draws again. One problem's repair runs inline,
// end to end, against a lagging search index this test seeds: #22 registers no pipeline yet,
// so the test passes the root one whose checkpoint follows the index.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

import { createLegacyAdapter } from '../../js/kernel/adapters/legacy/adapter.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { createNewTabClient } from '../../js/kernel/composition/newtab.js';
import { createRecoveryRoot } from '../../js/kernel/composition/recovery.js';
import { INCIDENT, PAGE, REBUILD, RESOLVED } from '../../js/trust/ui/copy.js';
import { mountRecoveryPage } from '../../js/trust/ui/view.js';
import { closeAll, legacyContext, legacyEnv } from './legacy-fixture.mjs';
import { KeyRange } from './migration-support.mjs';
import { MANIFEST, grantedAsDeclared } from './trust-provider-support.mjs';
import { realTimers, webLocks } from './trust-support.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('../../js/kernel/composition/recovery.js').RecoveryHost} RecoveryHost */
/** @typedef {import('../../js/kernel/composition/recovery.js').RecoveryRoot} RecoveryRoot */

const ROOT = path.join(import.meta.dirname, '..', '..');

/** The commit feed's head the seeded pipeline reads, and how far behind it may fall */
const HEAD = 12;

/**
 * What the page's root reads from its globals, over `context`: its Storage and chrome.*
 * @param {LegacyContext} context
 * @param {Partial<RecoveryHost>} [extra]
 * @returns {RecoveryHost}
 */
function hostOf(context, extra = {}) {
  const local = context.env.chrome.api.storage.local;
  return {
    legacy: { storage: context.storage, settings: local },
    indexedDB: context.env.indexedDB,
    keyRange: /** @type {any} */ (KeyRange),
    settings: {
      /** @param {string[]} keys */
      get: keys => local.get(keys),
      /** @param {Record<string, unknown>} items */
      set: items => local.set(items),
      getKeys: async () => Object.keys(context.env.chrome.local),
    },
    secretSettings: local,
    locks: webLocks(),
    crypto: /** @type {any} */ (webcrypto),
    permissions: grantedAsDeclared(),
    manifest: MANIFEST,
    timers: realTimers,
    ...extra,
  };
}

/**
 * recovery.html's body as the page ships it, which the views draw into: the header's two
 * links home, its views' nav, the main landmark, and the live region
 */
function pageDocument() {
  const doc = new legacyEnv.FakeDocument();
  /** @param {string} tag @param {Record<string, string>} attributes @param {any} parent */
  const add = (tag, attributes, parent = doc.body) => {
    const element = doc.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'class') element.className = value;
      else element.setAttribute(name, value);
    }
    parent.appendChild(element);
    return element;
  };
  const header = add('header', { class: 'trust-header' });
  add('a', { class: 'trust-brand trust-home', href: 'newtab.html' }, header);
  add('nav', { id: 'trust-views', class: 'trust-views' }, header);
  add('a', { class: 'trust-linkbtn trust-home', href: 'newtab.html' }, header);
  add('main', { id: 'trust-main', class: 'trust-main' });
  add('div', { id: 'trust-live', class: 'sr-only' });
  return doc;
}

/**
 * The page on `root`, whose trust calls are recorded by type, in order
 * @param {RecoveryRoot} root
 * @param {{hash?: string}} [options]
 */
function openPage(root, { hash = '' } = {}) {
  /** @type {string[]} */
  const calls = [];
  const trust = {
    /** @param {any} query */
    query: query => {
      calls.push(query.type);
      return root.trust.query(query);
    },
    /** @param {any} command */
    execute: command => {
      calls.push(command.type);
      return root.trust.execute(command);
    },
  };
  const doc = pageDocument();
  let reloads = 0;
  const location = { hash };
  const { ready } = mountRecoveryPage({
    document: /** @type {any} */ (doc),
    root: { ...root, trust },
    location,
    newTabUrl: 'chrome-extension://test/newtab.html',
    reload: () => {
      reloads += 1;
    },
  });
  return { doc, calls, ready, location, reloads: () => reloads };
}

/** @param {any} element */
const text = element => (element ? String(element.textContent).replace(/\s+/g, ' ').trim() : '');

/** @param {any} doc */
const headline = doc => text(doc.getElementById('trust-h1'));

/**
 * The button or link labelled `label`
 * @param {any} doc
 * @param {string} label
 * @param {any} [within]
 */
function control(doc, label, within = doc) {
  const found = [...within.querySelectorAll('button'), ...within.querySelectorAll('a')].filter(element => text(element) === label);
  assert.ok(found.length > 0, `no control labelled "${label}" in: ${text(within.documentElement || within)}`);
  return found[0];
}

/**
 * Wait until `ready()` holds, as the page draws its answers
 * @param {() => unknown} ready
 * @param {string} what
 */
async function until(ready, what) {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * Open CanvasTabDB as it is, run `work` on it, and close it
 * @template T
 * @param {IDBFactory} indexedDB
 * @param {(db: IDBDatabase) => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withDatabase(indexedDB, work) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('CanvasTabDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await work(/** @type {IDBDatabase} */ (db));
  } finally {
    /** @type {IDBDatabase} */ (db).close();
  }
}

/**
 * `request`'s result, once it succeeds
 * @param {IDBRequest} request
 * @returns {Promise<any>}
 */
const result = request =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * A profile whose new tab made its notes database and `count` notes, and whose search index
 * then lost every entry
 * @param {number} count
 */
async function profileWithStaleIndex(count) {
  const tab = legacyContext();
  const newtab = createNewTabClient({ storage: tab.storage, settings: tab.env.chrome.api.storage.local });
  assert.equal(await newtab.whenReady(), null);
  for (let n = 0; n < count; n++) {
    const outcome = await newtab.execute({ type: 'createNote', commandId: newtab.ids.next(), noteId: newtab.ids.next(), name: `Note ${n + 1}` });
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  }
  await withDatabase(tab.env.indexedDB, async db => {
    const tx = db.transaction('search_index', 'readwrite');
    tx.objectStore('search_index').clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  });
  return tab;
}

/**
 * How many notes and search entries CanvasTabDB holds
 * @param {IDBFactory} indexedDB
 */
const counts = indexedDB =>
  withDatabase(indexedDB, async db => {
    const tx = db.transaction(['canvases', 'search_index'], 'readonly');
    const [notes, entries] = await Promise.all([result(tx.objectStore('canvases').count()), result(tx.objectStore('search_index').count())]);
    return { notes, entries };
  });

/**
 * A pipeline over the commit feed that has applied everything once every note has its search
 * entry, and nothing before, as #22's search projection will report it; `stuck` never catches up
 * @param {IDBFactory} indexedDB
 * @param {{stuck?: boolean}} [options]
 */
function searchPipeline(indexedDB, { stuck = false } = {}) {
  return {
    pipelines: [
      {
        id: 'search',
        windowSeq: 0,
        checkpoint: async () => {
          if (stuck) return 0;
          const { notes, entries } = await counts(indexedDB);
          return entries >= notes ? HEAD : 0;
        },
      },
    ],
    commitLog: /** @type {any} */ ({ head: async () => HEAD }),
  };
}

/** Whether NewTabNoteTrust exists on `context`'s profile */
const trustDatabaseMade = async (/** @type {LegacyContext} */ context) =>
  (await context.env.indexedDB.databases()).some((/** @type {{name: string}} */ db) => db.name === 'NewTabNoteTrust');

describe('recovery.html', () => {
  it('ships the body the views draw into, its tokens and stylesheet, and one module script', () => {
    const html = fs.readFileSync(path.join(ROOT, 'recovery.html'), 'utf8');
    for (const id of ['trust-views', 'trust-main', 'trust-live']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.equal((html.match(/class="[^"]*\btrust-home\b/g) || []).length, 2);
    // The system's scheme until the page reads the theme, so a dark profile never opens white
    assert.match(html, /<html lang="en" data-scheme="system">/);
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]);
    assert.deepEqual(sheets, ['css/design-tokens.css', 'css/recovery.css']);
    const scripts = [...html.matchAll(/<script([^>]*)><\/script>/g)].map(match => match[1].trim());
    assert.deepEqual(scripts, ['type="module" src="js/recovery.js"']);
  });

  it("is what Settings' Trust Center section opens, a link that says nothing about a state it can't read", () => {
    const html = fs.readFileSync(path.join(ROOT, 'newtab.html'), 'utf8');
    const start = html.indexOf('<div class="settings-section" data-setting-label="trust center"');
    assert.ok(start > 0);
    const section = html.slice(start, html.indexOf('<div class="settings-section" data-setting-label="export import"'));
    assert.match(section, /<h3>Trust Center<\/h3>/);
    assert.match(section, /<a class="secondary-btn setting-link" href="recovery.html#trust">Open Trust Center<\/a>/);
    const words = section.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.equal(words, 'Trust Center See where your notes live, what protects them, and what can leave this device. Open Trust Center');
  });
});

describe("recovery.html's views on its root (#20 slice 4b)", () => {
  it('opens on its notes database, draws the stored receipts, runs the open check, and draws again', async () => {
    const tab = legacyContext();
    assert.equal(await createNewTabClient({ storage: tab.storage, settings: tab.env.chrome.api.storage.local }).whenReady(), null);
    await tab.env.chrome.api.storage.local.set({ setting_theme: 'dark' });
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context) });
    const page = openPage(root);
    try {
      assert.equal(headline(page.doc), PAGE.opening);
      await page.ready;
      assert.deepEqual(page.calls, [
        'trust.summary',
        'trust.report',
        'recovery.incidents',
        'trust.verify',
        'trust.summary',
        'trust.report',
        'recovery.incidents',
      ]);
      assert.equal(headline(page.doc), `${PAGE.trust}: ${PAGE.saving}`);
      // The theme, read through the settings port
      assert.equal(page.doc.documentElement.dataset.scheme, 'dark');
      const groups = page.doc.querySelectorAll('h2').map(text);
      assert.deepEqual(groups, PAGE.sections.map(section => section.title));
      // The two views, the Trust Center current, and the way back to the new tab
      const views = page.doc.getElementById('trust-views').querySelectorAll('a');
      assert.deepEqual(views.map(text), [PAGE.trust, PAGE.recovery]);
      assert.equal(views[0].getAttribute('aria-current'), 'page');
      for (const home of page.doc.querySelectorAll('.trust-home')) assert.equal(home.getAttribute('href'), 'chrome-extension://test/newtab.html');
      assert.equal(page.doc.title, `${PAGE.trust} - ${PAGE.brand}`);
      // The open check ran only on the page's own router
      assert.ok(await trustDatabaseMade(context));
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  it("draws its error state when its notes database doesn't exist, runs no row, and makes no database", async () => {
    const context = legacyContext();
    await context.env.chrome.api.storage.local.set({ setting_theme: 'dark' });
    const root = createRecoveryRoot({ host: hostOf(context) });
    const page = openPage(root);
    try {
      await page.ready;
      assert.equal(headline(page.doc), PAGE.noDatabase);
      assert.match(text(page.doc.getElementById('trust-main')), new RegExp(PAGE.noDatabaseBody.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual(page.calls, []);
      assert.deepEqual(await context.env.indexedDB.databases(), []);
      // No views to switch between, and the theme falls back to the system's
      assert.equal(page.doc.getElementById('trust-views').children.length, 0);
      assert.equal(page.doc.documentElement.dataset.scheme, 'system');
    } finally {
      root.close();
      closeAll([context]);
    }
  });

  it("draws its error state when its notes database can't open, with Reload first, and runs no row", async () => {
    const context = legacyContext();
    const legacy = createLegacyAdapter({ storage: context.storage, settings: context.env.chrome.api.storage.local, mode: 'existing' });
    // The database is there, and opening it fails, as a corrupt or locked profile's does
    const adapter = Object.freeze({
      ...legacy,
      open: async () => {
        throw new UnavailableError('storage', 'open-failed', true);
      },
    });
    const root = createRecoveryRoot({ host: hostOf(context, { adapter: /** @type {any} */ (adapter) }) });
    const page = openPage(root);
    try {
      await page.ready;
      assert.equal(headline(page.doc), PAGE.openFailed);
      // No raw error text: the words are the page's own
      assert.doesNotMatch(text(page.doc.getElementById('trust-main')), /open-failed|UnavailableError|storage/);
      const reload = page.doc.getElementById('trust-reload');
      assert.equal(page.doc.activeElement, reload);
      reload.click();
      assert.equal(page.reloads(), 1);
      assert.deepEqual(page.calls, []);
      assert.equal(await trustDatabaseMade(context), false);
    } finally {
      root.close();
      closeAll([context]);
    }
  });

  it('draws the newer-schema state for a database a newer NewTabNote upgraded, and runs no row', async () => {
    const context = legacyContext();
    // A version past this build's, as a newer build leaves it
    await new Promise((resolve, reject) => {
      const request = context.env.indexedDB.open('CanvasTabDB', 99);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('canvases', { keyPath: 'id' });
        request.result.createObjectStore('elements', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
      request.onerror = () => reject(request.error);
    });
    const root = createRecoveryRoot({ host: hostOf(context) });
    const page = openPage(root);
    try {
      await page.ready;
      assert.equal(headline(page.doc), PAGE.newerSchema);
      assert.deepEqual(page.calls, []);
      assert.equal(await trustDatabaseMade(context), false);
    } finally {
      root.close();
      closeAll([context]);
    }
  });

  it('repairs a seeded lagging search index end to end: its preview, the confirmed rebuild, the check after it, and Fixed just now', async () => {
    const tab = await profileWithStaleIndex(3);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context, searchPipeline(tab.env.indexedDB)) });
    const page = openPage(root, { hash: '#recovery' });
    try {
      await page.ready;
      // The open check found search behind, and the Recovery Center lists it with its repair
      const card = () => page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => text(li.querySelector('h3')) === INCIDENT['index/lagging']);
      await until(card, 'the lagging problem');
      assert.equal(card().getAttribute('data-state'), 'open');
      assert.match(text(card()), /Search is \d+ changes behind/);
      const views = page.doc.getElementById('trust-views').querySelectorAll('a');
      assert.equal(views[1].getAttribute('aria-current'), 'page');
      assert.match(text(views[1]), /\d+, \d+ problems?$/);

      control(page.doc, REBUILD.action, card()).click();
      const panel = () => page.doc.querySelector('section.trust-flow');
      await until(() => panel() && panel().getAttribute('data-state') === 'awaiting', 'the preview');
      assert.match(text(panel()), /Rebuilding writes 3 new search entries and updates 0\./);
      const impact = panel().querySelector('table.trust-impact');
      assert.deepEqual(impact.querySelectorAll('td').map(text), ['3', '0', '0']);
      // The panel's heading takes focus as it opens
      assert.equal(page.doc.activeElement, panel().querySelector('h4'));

      control(page.doc, REBUILD.confirm, panel()).click();
      const fixed = () => page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => li.getAttribute('data-state') === 'resolved');
      await until(fixed, 'Fixed just now');
      assert.equal(text(fixed().querySelector('h3')), `${RESOLVED['index/lagging']}${PAGE.fixed}`);
      assert.equal(text(page.doc.getElementById('h-fixed')), PAGE.fixedJustNow);
      assert.equal(panel(), null);
      assert.deepEqual(await counts(tab.env.indexedDB), { notes: 3, entries: 3 });
      // The repair is listed, done and checked
      const runs = page.doc.querySelector('table.trust-runs');
      assert.deepEqual(runs.querySelectorAll('td').slice(0, 2).map(text), [REBUILD.action, PAGE.doneAndChecked]);
      assert.deepEqual(
        page.calls.filter(type => type === 'recovery.run' || type === 'recovery.check'),
        ['recovery.run', 'recovery.run', 'recovery.check'],
      );
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  it('says so when the rebuild finished and the check still finds the problem, which stays open', async () => {
    const tab = await profileWithStaleIndex(2);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context, searchPipeline(tab.env.indexedDB, { stuck: true })) });
    const page = openPage(root, { hash: '#recovery' });
    try {
      await page.ready;
      const card = () => page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => li.getAttribute('data-state') === 'open' && text(li).includes(REBUILD.action));
      await until(card, 'the lagging problem');
      control(page.doc, REBUILD.action, card()).click();
      const panel = () => page.doc.querySelector('section.trust-flow');
      await until(() => panel() && panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(page.doc, REBUILD.confirm, panel()).click();
      await until(() => panel() && panel().getAttribute('data-state') === 'still-there', 'the check after it');
      assert.match(text(panel()), new RegExp(REBUILD.stillThere.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(page.doc.querySelectorAll('li.trust-incident').filter((/** @type {any} */ li) => li.getAttribute('data-state') === 'resolved').length, 0);
      // The rebuild itself wrote every entry: it's the pipeline that never caught up
      assert.deepEqual(await counts(tab.env.indexedDB), { notes: 2, entries: 2 });
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  it('takes a dismissed problem out of the count, and Undo puts it back', async () => {
    const tab = await profileWithStaleIndex(1);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context, searchPipeline(tab.env.indexedDB, { stuck: true })) });
    const page = openPage(root, { hash: '#recovery' });
    try {
      await page.ready;
      const card = () => page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => text(li).includes(REBUILD.action) || text(li).includes(PAGE.undo));
      await until(card, 'the lagging problem');
      const badge = () => text(page.doc.getElementById('trust-views').querySelectorAll('a')[1]);
      const before = badge();
      control(page.doc, PAGE.dismiss, card()).click();
      await until(() => text(card()).includes(PAGE.dismissed), 'the dismissal');
      assert.notEqual(badge(), before);
      control(page.doc, PAGE.undo, card()).click();
      await until(() => !text(card()).includes(PAGE.dismissed) && badge() === before, 'Undo');
      assert.ok(page.calls.includes('recovery.dismiss') && page.calls.includes('recovery.undismiss'));
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });
});
