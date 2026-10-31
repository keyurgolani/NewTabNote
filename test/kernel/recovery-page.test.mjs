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
import { CONSEQUENCE, INCIDENT, PAGE, REASON, REBUILD, RESOLVED } from '../../js/trust/ui/copy.js';
import { attentionText, durationText, fill, fixedLine, problemsOf, runResult } from '../../js/trust/ui/model.js';
import { mountRecoveryPage } from '../../js/trust/ui/view.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { REMEDIATIONS, searchEntryOf } from '../../js/trust/core/remediation/catalog.js';
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
 * The page on `root`, whose trust calls are recorded by type, in order. `answers` gives a
 * type's calls, in order, an answer in place of the root's, where the page can't be made to
 * meet one for real: a run that failed, or a check that couldn't run. An undefined entry is
 * the root's own answer, and a function is called with the root's call and answers what it
 * returns, as a client that stops waiting while the call goes on. The page waits 10 ms where it
 * would wait to read a run again.
 * @param {RecoveryRoot} root
 * @param {{hash?: string, answers?: Record<string, unknown[]>}} [options]
 */
function openPage(root, { hash = '', answers = {} } = {}) {
  /** @type {string[]} */
  const calls = [];
  /**
   * @param {string} type
   * @param {() => Promise<any>} call
   */
  const answer = (type, call) => {
    const index = calls.filter(made => made === type).length;
    calls.push(type);
    const given = answers[type] ? answers[type][index] : undefined;
    if (typeof given === 'function') return Promise.resolve(given(call));
    return given === undefined ? call() : Promise.resolve(given);
  };
  const trust = {
    /** @param {any} query */
    query: query => answer(query.type, () => root.trust.query(query)),
    /** @param {any} command */
    execute: command => answer(command.type, () => root.trust.execute(command)),
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
    wait: () => new Promise(resolve => setTimeout(resolve, 10)),
  });
  return { doc, calls, ready, location, reloads: () => reloads };
}

/** @param {any} element */
const text = element => (element ? String(element.textContent).replace(/\s+/g, ' ').trim() : '');

/** @param {any} doc */
const headline = doc => text(doc.getElementById('trust-h1'));

/** `words` as a pattern that matches them as they are */
const escape = (/** @type {string} */ words) => words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  it('ships the body the views draw into, its tokens and stylesheet, the network guard first, and one module script', () => {
    const html = fs.readFileSync(path.join(ROOT, 'recovery.html'), 'utf8');
    for (const id of ['trust-views', 'trust-main', 'trust-live']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.equal((html.match(/class="[^"]*\btrust-home\b/g) || []).length, 2);
    // The system's scheme until the page reads the theme, so a dark profile never opens white
    assert.match(html, /<html lang="en" data-scheme="system">/);
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]);
    assert.deepEqual(sheets, ['css/design-tokens.css', 'css/recovery.css']);
    const scripts = [...html.matchAll(/<script([^>]*)><\/script>/g)].map(match => match[1].trim());
    assert.deepEqual(scripts, ['vite-ignore src="js/network-guard.js"', 'type="module" src="js/recovery.js"']);
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
      // Nothing new can be saved, so it takes the ring with a cross (change 14)
      assert.equal(page.doc.querySelector('section.trust-headline').getAttribute('data-tone'), 'failed');
      assert.match(text(page.doc.getElementById('trust-main')), new RegExp(escape(PAGE.noDatabaseBody)));
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

  it('says the device is out of space, in the Recovery Center\'s words, when that stopped the open, and runs no row', async () => {
    const context = legacyContext();
    const legacy = createLegacyAdapter({ storage: context.storage, settings: context.env.chrome.api.storage.local, mode: 'existing' });
    const adapter = Object.freeze({
      ...legacy,
      open: async () => {
        throw new UnavailableError('quota', 'quota', false);
      },
    });
    const root = createRecoveryRoot({ host: hostOf(context, { adapter: /** @type {any} */ (adapter) }) });
    const page = openPage(root);
    try {
      await page.ready;
      assert.equal(headline(page.doc), PAGE.outOfSpace);
      assert.equal(text(page.doc.getElementById('trust-main')), `${PAGE.outOfSpace}${PAGE.outOfSpaceBody}${PAGE.reloadKeeps}${PAGE.reload}`);
      assert.equal(page.doc.activeElement, page.doc.getElementById('trust-reload'));
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
      assert.equal(page.doc.querySelector('section.trust-headline').getAttribute('data-tone'), 'failed');
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
      // s5's line under the resolved title, and with nothing left open, nothing needs recovering
      assert.match(text(fixed()), /Fixed at \d{1,2}:\d{2} [AP]M, when a check passed after the rebuild\./);
      assert.equal(headline(page.doc), `${PAGE.recovery}: ${PAGE.nothingToRecover}`);
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
      assert.match(text(panel()), new RegExp(escape(REBUILD.stillThere)));
      assert.equal(page.doc.querySelectorAll('li.trust-incident').filter((/** @type {any} */ li) => li.getAttribute('data-state') === 'resolved').length, 0);
      // The rebuild itself wrote every entry: it's the pipeline that never caught up
      assert.deepEqual(await counts(tab.env.indexedDB), { notes: 2, entries: 2 });
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  it("says so when the check after the rebuild couldn't run, and Check again runs it", async () => {
    const tab = await profileWithStaleIndex(2);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context, searchPipeline(tab.env.indexedDB)) });
    // The first check after the rebuild couldn't decide, as a check that timed out answers
    const page = openPage(root, { hash: '#recovery', answers: { 'recovery.check': [{ kind: 'checked', result: 'not-checked', retryable: true }] } });
    try {
      await page.ready;
      const card = () => page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => li.getAttribute('data-state') === 'open');
      await until(card, 'the lagging problem');
      control(page.doc, REBUILD.action, card()).click();
      const panel = () => page.doc.querySelector('section.trust-flow');
      await until(() => panel() && panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(page.doc, REBUILD.confirm, panel()).click();
      await until(() => panel() && panel().getAttribute('data-state') === 'not-checked', 'the check that couldn\'t run');
      assert.match(text(panel()), new RegExp(escape(REBUILD.notChecked)));
      control(page.doc, REBUILD.checkAgain, panel()).click();
      await until(() => page.doc.getElementById('h-fixed'), 'Fixed just now');
      assert.equal(page.calls.filter(type => type === 'recovery.check').length, 2);
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  it('says what stopped a failed rebuild and that the notes are unchanged, and Try again starts over at the preview', async () => {
    const tab = await profileWithStaleIndex(2);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context, searchPipeline(tab.env.indexedDB)) });
    const failed = {
      kind: 'remediation', runId: '00000000-0000-4000-8000-0000000000f1', remediationId: 'rebuild-index', class: 'regenerable',
      state: 'failed', step: 'apply', outcome: 'apply-failed', needs: [], impact: null, previewDigest: null,
      unreadable: [], unreadableCount: 0, fileMayBeEmpty: false,
    };
    // The preview is the root's, and the confirmed run's answer the failure
    const page = openPage(root, { hash: '#recovery', answers: { 'recovery.run': [undefined, failed] } });
    try {
      await page.ready;
      const card = () => page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => li.getAttribute('data-state') === 'open');
      await until(card, 'the lagging problem');
      control(page.doc, REBUILD.action, card()).click();
      const panel = () => page.doc.querySelector('section.trust-flow');
      await until(() => panel() && panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(page.doc, REBUILD.confirm, panel()).click();
      await until(() => panel() && panel().getAttribute('data-state') === 'failed', 'the failure');
      assert.match(text(panel()), /^Rebuild the search index\s*Failed to rebuild the search index: it stopped before it finished\. Tried at /);
      assert.match(text(panel()), new RegExp(escape(REBUILD.unchanged)));
      // The run the failure stood in for still waits for its confirmation, so it isn't listed
      assert.equal(page.doc.querySelector('table.trust-runs'), null);
      // The steps say where it stopped, in words as well as shapes
      assert.deepEqual(panel().querySelector('ol.trust-steps').querySelectorAll('li').map((/** @type {any} */ li) => li.getAttribute('data-step')), ['done', 'failed', 'todo']);
      control(page.doc, REBUILD.tryAgain, panel()).click();
      await until(() => panel() && panel().getAttribute('data-state') === 'awaiting', 'the preview again');
      assert.deepEqual(page.calls.filter(type => type === 'recovery.run').length, 3);
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  it('shows new numbers, and says why, when the notes changed between the preview and the rebuild', async () => {
    const tab = await profileWithStaleIndex(2);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context, searchPipeline(tab.env.indexedDB)) });
    const page = openPage(root, { hash: '#recovery' });
    try {
      await page.ready;
      const card = () => page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => li.getAttribute('data-state') === 'open');
      await until(card, 'the lagging problem');
      control(page.doc, REBUILD.action, card()).click();
      const panel = () => page.doc.querySelector('section.trust-flow');
      await until(() => panel() && panel().getAttribute('data-state') === 'awaiting', 'the preview');
      assert.match(text(panel()), /writes 2 new search entries/);
      // A note made on the new tab after the preview, its entry lost with the others
      const newtab = createNewTabClient({ storage: tab.storage, settings: tab.env.chrome.api.storage.local });
      assert.equal(await newtab.whenReady(), null);
      assert.equal((await newtab.execute({ type: 'createNote', commandId: newtab.ids.next(), noteId: newtab.ids.next(), name: 'Later' })).kind, 'committed');
      await withDatabase(tab.env.indexedDB, async db => {
        const tx = db.transaction('search_index', 'readwrite');
        tx.objectStore('search_index').clear();
        await new Promise(resolve => {
          tx.oncomplete = resolve;
        });
      });
      control(page.doc, REBUILD.confirm, panel()).click();
      await until(() => panel() && panel().querySelector('.trust-warning'), 'the changed preview');
      assert.equal(panel().getAttribute('data-state'), 'awaiting');
      assert.match(text(panel()), new RegExp(escape(REBUILD.previewChanged)));
      assert.match(text(panel()), /writes 3 new search entries/);
      assert.deepEqual(await counts(tab.env.indexedDB), { notes: 3, entries: 0 });
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  it("says it can't confirm the notes are saving when its health records can't be read, with Reload", async () => {
    const tab = legacyContext();
    assert.equal(await createNewTabClient({ storage: tab.storage, settings: tab.env.chrome.api.storage.local }).whenReady(), null);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context) });
    const page = openPage(root, { answers: { 'trust.summary': [{ kind: 'failed', cause: 'storage', code: 'transaction-failed' }] } });
    try {
      await page.ready;
      assert.equal(headline(page.doc), PAGE.cantConfirm);
      assert.match(text(page.doc.getElementById('trust-main')), new RegExp(escape(PAGE.readFailed)));
      // Reload takes focus, as in the other error states
      assert.equal(page.doc.activeElement, page.doc.getElementById('trust-reload'));
      // It stopped at the failed read: no check ran
      assert.equal(page.calls.includes('trust.verify'), false);
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

describe("the views' words (#20 slice 4b)", () => {
  it('names the one or two rows that need attention, and past two the first and how many more (answer 7)', () => {
    const rows = ['Saved keys', 'Permissions', 'Search'].map((label, n) => ({ id: `row-${n}`, label }));
    assert.equal(attentionText(rows.slice(0, 1)), '1 thing needs your attention: Saved keys.');
    assert.equal(attentionText(rows.slice(0, 2)), '2 things need your attention: Saved keys and Permissions.');
    assert.equal(attentionText(rows), 'Saved keys and 2 more need your attention.');
  });

  it('reads a duration of a second or more in seconds (change 14), and fills only the values it has', () => {
    assert.equal(durationText(120), '120 ms');
    assert.equal(durationText(1000), '1 second');
    assert.equal(durationText(1840), '1.8 seconds');
    assert.equal(fill('{a}, {b}, {c}', { a: '', b: 0, c: null }), ', 0, {c}');
  });
});

describe("recovery.html after #115's design review", () => {
  /**
   * The repair panel's steps: each one's state, shape, and words
   * @param {any} panel
   */
  const stepsOf = panel =>
    panel
      .querySelector('ol.trust-steps')
      .querySelectorAll('li')
      .map((/** @type {any} */ li) => [li.getAttribute('data-step'), String(li.querySelector('.trust-glyph').className).replace('trust-glyph ', ''), text(li)]);

  /**
   * The page at the Recovery Center on a profile with `count` notes whose index lost its entries,
   * and a search pipeline as `pipeline` gives it
   * @param {{count?: number, stuck?: boolean, whole?: boolean, behindOnce?: boolean, answers?: Record<string, unknown[]>}} [options]
   */
  async function recoveryOn({ count = 2, stuck = false, whole = false, behindOnce = false, answers = {} } = {}) {
    const tab = await profileWithStaleIndex(count);
    if (whole) {
      // Every entry as the new tab's indexer writes it
      await withDatabase(tab.env.indexedDB, async db => {
        const tx = db.transaction(['canvases', 'elements', 'search_index'], 'readwrite');
        for (const note of await result(tx.objectStore('canvases').getAll())) {
          const blocks = await result(tx.objectStore('elements').index('canvasId').getAll(note.id));
          tx.objectStore('search_index').put(searchEntryOf(note, blocks));
        }
        await new Promise(resolve => {
          tx.oncomplete = resolve;
        });
      });
    }
    const context = legacyContext(tab.env);
    let reads = 0;
    // Behind for the open check's read only, then caught up: the check after a repair passes
    const once = {
      pipelines: [{ id: 'search', windowSeq: 0, checkpoint: async () => (reads++ === 0 ? 0 : HEAD) }],
      commitLog: /** @type {any} */ ({ head: async () => HEAD }),
    };
    const root = createRecoveryRoot({ host: hostOf(context, behindOnce ? once : searchPipeline(tab.env.indexedDB, { stuck })) });
    const page = openPage(root, { hash: '#recovery', answers });
    await page.ready;
    const card = () => page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => li.getAttribute('data-state') === 'open');
    await until(card, 'the lagging problem');
    const panel = () => page.doc.querySelector('section.trust-flow');
    return { tab, context, root, page, card, panel, close: () => (root.close(), closeAll([tab, context])) };
  }

  it("marks the check after the rebuild by what it found: in progress while it runs, not passed when the problem is still there, and not run when it couldn't run", async () => {
    // While it runs
    const checking = await recoveryOn({ answers: { 'recovery.check': [new Promise(() => {})] } });
    try {
      control(checking.page.doc, REBUILD.action, checking.card()).click();
      await until(() => checking.panel() && checking.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(checking.page.doc, REBUILD.confirm, checking.panel()).click();
      await until(() => checking.panel() && checking.panel().getAttribute('data-state') === 'checking', 'the check');
      assert.deepEqual(stepsOf(checking.panel()), [
        ['done', 'trust-tone-ok', `${REBUILD.steps.preview}: ${PAGE.stepDone}`],
        ['done', 'trust-tone-ok', `${REBUILD.steps.apply}: ${PAGE.stepDone}`],
        ['current', 'trust-tone-checking', `${REBUILD.steps.verify}: ${PAGE.stepCurrent}`],
      ]);
    } finally {
      checking.close();
    }
    // Still there
    const still = await recoveryOn({ stuck: true });
    try {
      control(still.page.doc, REBUILD.action, still.card()).click();
      await until(() => still.panel() && still.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(still.page.doc, REBUILD.confirm, still.panel()).click();
      await until(() => still.panel() && still.panel().getAttribute('data-state') === 'still-there', 'the check');
      assert.deepEqual(stepsOf(still.panel())[2], ['not-passed', 'trust-tone-failed', `${REBUILD.steps.verify}: ${PAGE.stepNotPassed}`]);
    } finally {
      still.close();
    }
    // Couldn't run
    const unchecked = await recoveryOn({ answers: { 'recovery.check': [{ kind: 'checked', result: 'not-checked', retryable: true }] } });
    try {
      control(unchecked.page.doc, REBUILD.action, unchecked.card()).click();
      await until(() => unchecked.panel() && unchecked.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(unchecked.page.doc, REBUILD.confirm, unchecked.panel()).click();
      await until(() => unchecked.panel() && unchecked.panel().getAttribute('data-state') === 'not-checked', 'the check');
      assert.deepEqual(stepsOf(unchecked.panel())[2], ['not-run', 'trust-tone-todo', `${REBUILD.steps.verify}: ${PAGE.stepNotRun}`]);
    } finally {
      unchecked.close();
    }
  });

  it("gives Still there a way forward: the notes didn't change, Try again, and Dismiss", async () => {
    const still = await recoveryOn({ stuck: true });
    try {
      control(still.page.doc, REBUILD.action, still.card()).click();
      await until(() => still.panel() && still.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(still.page.doc, REBUILD.confirm, still.panel()).click();
      await until(() => still.panel() && still.panel().getAttribute('data-state') === 'still-there', 'the check');
      assert.match(text(still.panel()), new RegExp(escape(REBUILD.unchanged)));
      const again = control(still.page.doc, REBUILD.tryAgain, still.panel());
      assert.match(again.className, /\bprimary-btn\b/);
      assert.ok(control(still.page.doc, PAGE.dismiss, still.card()));
      // Try again runs the repair again: with every entry written, it has nothing to write,
      // and the check after it decides, still finding the problem
      again.click();
      await until(() => still.page.calls.filter(type => type === 'recovery.check').length === 2 && still.panel() && still.panel().getAttribute('data-state') === 'still-there', 'the check after Try again');
      assert.equal(still.page.calls.filter(type => type === 'recovery.run').length, 3);
    } finally {
      still.close();
    }
  });

  it('lets the check after a rebuild with nothing to write decide: a pass is Fixed just now, logged as Nothing to do', async () => {
    const run = await recoveryOn({ whole: true, behindOnce: true });
    try {
      control(run.page.doc, REBUILD.action, run.card()).click();
      const fixed = () => run.page.doc.querySelectorAll('li.trust-incident').find((/** @type {any} */ li) => li.getAttribute('data-state') === 'resolved');
      await until(fixed, 'Fixed just now');
      assert.equal(run.panel(), null);
      const runs = run.page.doc.querySelector('table.trust-runs');
      assert.deepEqual(runs.querySelectorAll('td').slice(0, 2).map(text), [REBUILD.action, PAGE.nothingToDoRun]);
    } finally {
      run.close();
    }
  });

  it("...and a fail takes Still there's way forward, never logged as Cancelled", async () => {
    const run = await recoveryOn({ whole: true, stuck: true });
    try {
      control(run.page.doc, REBUILD.action, run.card()).click();
      await until(() => run.panel() && run.panel().getAttribute('data-state') === 'still-there', 'the check');
      assert.ok(control(run.page.doc, REBUILD.tryAgain, run.panel()));
      assert.match(text(run.panel()), new RegExp(escape(REBUILD.unchanged)));
      // The panel draws as the check answers, and the run's log with the read after it
      await until(() => run.page.doc.querySelector('table.trust-runs'), 'the run logged');
      const runs = run.page.doc.querySelector('table.trust-runs');
      assert.deepEqual(runs.querySelectorAll('td').slice(0, 2).map(text), [REBUILD.action, PAGE.nothingToDoRun]);
      assert.doesNotMatch(text(runs), new RegExp(PAGE.cancelled));
    } finally {
      run.close();
    }
  });

  it("says why Recovery points and Local model aren't verified when neither has a receipt: this device never checked them", async () => {
    const tab = legacyContext();
    assert.equal(await createNewTabClient({ storage: tab.storage, settings: tab.env.chrome.api.storage.local }).whenReady(), null);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context) });
    const page = openPage(root);
    try {
      await page.ready;
      for (const id of ['recovery-readiness', 'local-inference']) {
        const row = page.doc.getElementById(`row-${id}`);
        assert.equal(text(row.querySelector('.trust-row-text')), PAGE.neverChecked, id);
        assert.match(text(row), /Not verified yet/, id);
      }
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  it('reads Nothing needs your attention when every open problem is dismissed, with when the last checks ran', async () => {
    const still = await recoveryOn({ stuck: true });
    try {
      control(still.page.doc, PAGE.dismiss, still.card()).click();
      await until(() => /Nothing needs/.test(headline(still.page.doc)), 'the headline');
      assert.equal(headline(still.page.doc), `${PAGE.recovery}: ${PAGE.nothingNeedsYou}`);
      assert.match(text(still.page.doc.querySelector('section.trust-headline').querySelector('.trust-proof')), /^NewTabNote's last checks ran at \d{1,2}:\d{2} [AP]M\.$/);
    } finally {
      still.close();
    }
  });

  it('says how to reach site access in Chrome under the button that opens its extensions page', async () => {
    const tab = legacyContext();
    assert.equal(await createNewTabClient({ storage: tab.storage, settings: tab.env.chrome.api.storage.local }).whenReady(), null);
    const context = legacyContext(tab.env);
    // Chrome granted the APIs and none of the AI providers' sites
    const limited = { getAll: async () => ({ permissions: [...MANIFEST.permissions, 'newTabPageOverride'], origins: [] }) };
    const root = createRecoveryRoot({ host: hostOf(context, { permissions: limited }) });
    const page = openPage(root);
    try {
      await page.ready;
      const row = page.doc.getElementById('row-permissions');
      assert.ok(control(page.doc, 'Review site access in Chrome', row));
      assert.match(text(row), new RegExp(escape(PAGE.siteAccessHow)));
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });

  // ───────── #115's high review and the design delta ─────────

  /** The Recent repairs rows' results, newest first */
  const runResults = (/** @type {any} */ doc) => {
    const runs = doc.querySelector('table.trust-runs');
    return runs ? runs.querySelector('tbody').querySelectorAll('tr').map((/** @type {any} */ row) => text(row.querySelectorAll('td')[1])) : [];
  };

  it("logs a run as Done and checked only once the check after it passed: still there, or not checked yet, otherwise", async () => {
    const still = await recoveryOn({ stuck: true });
    try {
      control(still.page.doc, REBUILD.action, still.card()).click();
      await until(() => still.panel() && still.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(still.page.doc, REBUILD.confirm, still.panel()).click();
      await until(() => still.panel() && still.panel().getAttribute('data-state') === 'still-there', 'still there');
      await until(() => runResults(still.page.doc).length > 0, 'the run logged');
      assert.deepEqual(runResults(still.page.doc), [PAGE.doneStillThere]);
      const glyph = still.page.doc.querySelector('table.trust-runs').querySelector('.trust-glyph');
      assert.ok(glyph.classList.contains('trust-tone-partial'));
    } finally {
      still.close();
    }
    // The check after it couldn't run, so nothing says whether it's fixed
    const unchecked = await recoveryOn({ stuck: true, answers: { 'recovery.check': [{ kind: 'checked', result: 'not-checked', retryable: true }] } });
    try {
      control(unchecked.page.doc, REBUILD.action, unchecked.card()).click();
      await until(() => unchecked.panel() && unchecked.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(unchecked.page.doc, REBUILD.confirm, unchecked.panel()).click();
      await until(() => unchecked.panel() && unchecked.panel().getAttribute('data-state') === 'not-checked', 'not checked');
      await until(() => runResults(unchecked.page.doc).length > 0, 'the run logged');
      assert.deepEqual(runResults(unchecked.page.doc), [PAGE.doneNotChecked]);
      assert.ok(unchecked.page.doc.querySelector('table.trust-runs').querySelector('.trust-glyph').classList.contains('trust-tone-todo'));
    } finally {
      unchecked.close();
    }
  });

  it('says an expired preview expired, offers it again, and never logs it as Cancelled', async () => {
    const run = { kind: 'remediation', state: 'cancelled', outcome: 'run-expired', runId: '00000000-0000-4000-8000-0000000000e1' };
    const page = await recoveryOn({ answers: { 'recovery.run': [undefined, run] } });
    try {
      control(page.page.doc, REBUILD.action, page.card()).click();
      await until(() => page.panel() && page.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(page.page.doc, REBUILD.confirm, page.panel()).click();
      await until(() => page.panel() && page.panel().getAttribute('data-state') === 'expired', 'the expired preview');
      assert.match(text(page.panel()), new RegExp(escape(REBUILD.previewExpired)));
      control(page.page.doc, REBUILD.previewAgain, page.panel()).click();
      await until(() => page.panel() && page.panel().getAttribute('data-state') === 'awaiting', 'the preview again');
      assert.equal(page.page.calls.filter(call => call === 'recovery.run').length, 3);
    } finally {
      page.close();
    }
    assert.deepEqual(runResult(/** @type {any} */ ({ state: 'cancelled', outcome: 'run-expired', incidentId: null, updatedAt: 1 })), { tone: 'absent', text: PAGE.previewExpiredRun });
  });

  it('says a repair it stopped waiting for is still running, reads its run until it ends, then checks it', async () => {
    const page = await recoveryOn({
      behindOnce: true,
      // The client gives up on the confirmation while the run goes on under its lock
      answers: { 'recovery.run': [undefined, (/** @type {() => Promise<any>} */ call) => (call(), { kind: 'unknown', code: 'deadline-exceeded', commandId: 'x' })] },
    });
    try {
      control(page.page.doc, REBUILD.action, page.card()).click();
      await until(() => page.panel() && page.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(page.page.doc, REBUILD.confirm, page.panel()).click();
      await until(() => page.panel() && page.panel().getAttribute('data-state') === 'still-running', 'still running');
      assert.match(text(page.panel()), new RegExp(escape(REBUILD.stillRunning)));
      // Then the run's record ends, and the check after it passes
      await until(() => /Fixed just now/.test(text(page.page.doc.getElementById('trust-main'))), 'fixed');
      assert.ok(page.page.calls.includes('recovery.check'));
    } finally {
      page.close();
    }
  });

  it("knows its own run when Try again meets it running, and never says another tab is running it", async () => {
    // The confirmation's answer stands in as a failure, so its run stays as the preview left it
    const failed = { kind: 'remediation', state: 'failed', outcome: 'apply-failed', runId: null };
    const running = { kind: 'unavailable', cause: 'coordinator', code: 'remediation-running', retryable: true };
    const page = await recoveryOn({ answers: { 'recovery.run': [undefined, failed, running] } });
    try {
      control(page.page.doc, REBUILD.action, page.card()).click();
      await until(() => page.panel() && page.panel().getAttribute('data-state') === 'awaiting', 'the preview');
      control(page.page.doc, REBUILD.confirm, page.panel()).click();
      await until(() => page.panel() && page.panel().getAttribute('data-state') === 'failed', 'the stand-in failure');
      control(page.page.doc, REBUILD.tryAgain, page.panel()).click();
      // Its own run, which waits for a confirmation it never got: the page takes the preview again
      await until(() => page.panel() && page.panel().getAttribute('data-state') === 'awaiting', 'the preview again');
      assert.doesNotMatch(text(page.page.doc.getElementById('trust-main')), new RegExp(escape(REASON['remediation-running'])));
      assert.equal(page.page.calls.filter(call => call === 'recovery.run').length, 4);
    } finally {
      page.close();
    }
  });

  it('keeps Dismiss busy while its own call is on its way, so a second press sends nothing', async () => {
    /** @type {(answer: unknown) => void} */
    let answerDismiss = () => {};
    const held = new Promise(resolve => {
      answerDismiss = resolve;
    });
    const page = await recoveryOn({ answers: { 'recovery.dismiss': [(/** @type {() => Promise<any>} */ call) => held.then(() => call())] } });
    try {
      control(page.page.doc, PAGE.dismiss, page.card()).click();
      await until(() => control(page.page.doc, PAGE.dismiss, page.card()).getAttribute('aria-disabled') === 'true', 'Dismiss busy');
      control(page.page.doc, PAGE.dismiss, page.card()).click();
      answerDismiss(null);
      await until(() => /Nothing needs/.test(headline(page.page.doc)), 'dismissed');
      assert.equal(page.page.calls.filter(call => call === 'recovery.dismiss').length, 1);
      assert.doesNotMatch(text(page.page.doc.getElementById('trust-main')), new RegExp(escape(PAGE.changedSinceShown)));
    } finally {
      page.close();
    }
  });
});

describe("the Recovery Center's words for what it knows (#115's high review)", () => {
  /** An incident as the records hold one, open unless `fields` say otherwise */
  const incident = (/** @type {Record<string, unknown>} */ fields) =>
    /** @type {any} */ ({
      id: '00000000-0000-4000-8000-0000000000c1',
      ref: '000000',
      key: 'index/lagging',
      providerId: 'index',
      faultCode: 'lagging',
      subjectId: null,
      severity: 'degraded',
      state: 'open',
      dismissed: false,
      dismissChangedAt: null,
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      resolvedAt: null,
      occurrences: 1,
      affected: ['search'],
      preserved: [],
      evidence: {},
      appliedOps: [],
      ...fields,
    });

  it('gives every problem title one for when it is fixed, and keys the open-failed pair by the database it names', () => {
    for (const key of Object.keys(INCIDENT)) assert.ok(RESOLVED[/** @type {keyof typeof RESOLVED} */ (key)], key);
    const records = problemsOf([
      incident({ key: 'storage/open-failed/NewTabNoteTrust', providerId: 'storage', faultCode: 'open-failed', subjectId: 'NewTabNoteTrust', state: 'resolved', resolvedAt: 2000 }),
    ]);
    assert.equal(records[0].resolvedTitle, RESOLVED['storage/open-failed/NewTabNoteTrust']);
    assert.notEqual(records[0].resolvedTitle, RESOLVED['storage/open-failed/CanvasTabDB']);
  });

  it('says a check passed only for a problem a check resolved, and when it was resolved for one an event or the records resolved', () => {
    const at = new Date(2026, 9, 31, 14, 5).getTime();
    const checked = problemsOf([incident({ state: 'resolved', resolvedAt: at })])[0];
    assert.equal(fixedLine(checked, [], at), fill(PAGE.fixedAfterCheck, { time: '2:05 PM' }));
    for (const fields of [
      { key: 'index/indexer-start-failed', faultCode: 'indexer-start-failed' },
      { key: 'storage/write-failed', providerId: 'storage', faultCode: 'write-failed' },
      { key: 'storage/open-failed/NewTabNoteTrust', providerId: 'storage', faultCode: 'open-failed', subjectId: 'NewTabNoteTrust' },
    ]) {
      const problem = problemsOf([incident({ ...fields, state: 'resolved', resolvedAt: at })])[0];
      assert.equal(fixedLine(problem, [], at), fill(PAGE.resolvedAt, { time: '2:05 PM' }), fields.key);
    }
  });

  it("logs a finished run as Done and checked only once its problem resolved after it", () => {
    const run = /** @type {any} */ ({ id: 'r', commandId: 'rebuild-index', incidentId: '00000000-0000-4000-8000-0000000000c1', state: 'succeeded', outcome: 'verified', startedAt: 1500, updatedAt: 2000 });
    assert.deepEqual(runResult(run, [incident({ state: 'resolved', resolvedAt: 2500 })]), { tone: 'ok', text: PAGE.doneAndChecked });
    assert.deepEqual(runResult(run, [incident({ lastSeenAt: 2600 })]), { tone: 'partial', text: PAGE.doneStillThere });
    assert.deepEqual(runResult(run, [incident({ lastSeenAt: 1000 })]), { tone: 'todo', text: PAGE.doneNotChecked });
    assert.deepEqual(runResult(run, []), { tone: 'todo', text: PAGE.doneNotChecked });
    // Resolved before the run ended: something else fixed it, not this run's check
    assert.deepEqual(runResult(run, [incident({ state: 'resolved', resolvedAt: 1800 })]), { tone: 'todo', text: PAGE.doneNotChecked });
  });
});

describe("recovery.html's root and #14's block family (#14 slice 1)", () => {
  it("reads Block types as verified on the 18 built-ins, from the block family its root registers, and counts them there only", async () => {
    const tab = legacyContext();
    assert.equal(await createNewTabClient({ storage: tab.storage, settings: tab.env.chrome.api.storage.local }).whenReady(), null);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context) });
    const page = openPage(root);
    try {
      await page.ready;
      const report = /** @type {any} */ (await root.trust.query({ type: 'trust.report' }));
      const blockTypes = report.data.providers.find((/** @type {any} */ provider) => provider.providerId === 'block-types');
      assert.equal(blockTypes.status, 'verified', JSON.stringify(blockTypes));
      assert.deepEqual(blockTypes.receipt.evidence, { records: 18, count: 0 });
      // The Trust Center's row for NewTabNote's own parts, with Block types among its checks
      const row = page.doc.getElementById('row-platform');
      assert.match(text(row), /^NewTabNote's own parts\s*Verified/);
      const sub = row.querySelectorAll('.trust-sub').find((/** @type {any} */ element) => text(element.querySelector('h4')).startsWith('Block types:'));
      assert.ok(sub, text(row));
      assert.equal(text(sub.querySelector('h4')), 'Block types: Verified');
      assert.match(text(sub), /Block types\s*18(?!\d)/);
      assert.match(text(sub), /Types that didn't load\s*0(?!\d)/);
      // Built-in features counts the providers and remediations, so no block type counts twice
      const parts = row.querySelectorAll('.trust-sub').find((/** @type {any} */ element) => text(element.querySelector('h4')).startsWith('Built-in features:'));
      assert.match(text(parts), new RegExp(`Built-in parts\\s*${PROVIDERS.length + REMEDIATIONS.length}(?!\\d)`));
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });
});

describe("recovery.html while its health records can't be saved (#115's review)", () => {
  /**
   * `factory` with NewTabNoteTrust's open failing, as a profile whose records store won't open
   * @param {IDBFactory} factory
   */
  const trustStoreDown = factory =>
    /** @type {IDBFactory} */ (
      new Proxy(factory, {
        get(target, property) {
          if (property === 'open') {
            return (/** @type {string} */ name, /** @type {number} */ version) => {
              if (name !== 'NewTabNoteTrust') return target.open(name, version);
              /** @type {any} */
              const request = { result: undefined, error: new DOMException('closed for this test', 'UnknownError'), transaction: null };
              setTimeout(() => request.onerror && request.onerror({ target: request }), 0);
              return request;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
    );

  it("shows what this visit's checks found, the storage row in its provider's words, and no promise over the cards", async () => {
    const tab = legacyContext();
    assert.equal(await createNewTabClient({ storage: tab.storage, settings: tab.env.chrome.api.storage.local }).whenReady(), null);
    const context = legacyContext(tab.env);
    const root = createRecoveryRoot({ host: hostOf(context, { indexedDB: trustStoreDown(context.env.indexedDB) }) });
    const page = openPage(root);
    try {
      await page.ready;
      // It opens on the Recovery Center, which promises nothing about cards that may not say
      // what still works (N3)
      assert.match(headline(page.doc), /^Recovery Center: \d problems? to look at$/);
      assert.equal(text(page.doc.querySelector('section.trust-headline').querySelector('.trust-proof')), PAGE.cantConfirmProof);
      control(page.doc, PAGE.trust).click();
      await until(() => headline(page.doc) === `${PAGE.trust}: ${PAGE.cantConfirm}`, 'the Trust Center');
      // The open check ran, so its rows say what it found, not that nothing ever checked them
      const storage = page.doc.getElementById('row-storage');
      assert.equal(text(storage.querySelector('.trust-row-text')), CONSEQUENCE['storage.trust-records-unavailable']);
      assert.match(text(page.doc.getElementById('row-capture')), /Verified/);
      for (const id of ['capture', 'storage', 'permissions']) assert.doesNotMatch(text(page.doc.getElementById(`row-${id}`)), new RegExp(escape(PAGE.neverChecked)), id);
    } finally {
      root.close();
      closeAll([tab, context]);
    }
  });
});
