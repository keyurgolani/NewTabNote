'use strict';

// NTN-18 slice 0: the one-time notice to export before the storage upgrade.
// It shows for a profile that had notes, outside onboarding and #33's guard and
// degraded states, records the first choice once through the settings API, and
// never changes a note.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLegacyEnv, createDatabase, dumpDatabase, settle, plain, note, block, FakeDocument,
} = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/ui/export-notice.js'];
const APP_FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/core/event-bus.js', 'js/core/dom-refs.js', 'js/core/logger.js',
  'js/storage.js', 'js/search.js', 'js/ui/export-notice.js', 'js/app.js',
];
const KEY = 'setting_preMigrationNotice';
const TITLE = 'Save a copy before the next update';
const BODY = 'The next NewTabNote update changes how notes are stored on this device. Exporting now gives you a copy to keep.';
const LEFT_OUT = 'Not included: trash, themes, version history, AI chat history, and settings.';
const STARTED_WITH_NOTES = { hadNotes: true, ranOnboarding: false };

/** A profile with an active and an archived note, at version 8 without `omit`, or at version 9. */
async function setup({ omit = [], version = 8, files = FILES } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  const records = {
    canvases: [note('A', { name: 'Groceries' }), note('AR', { name: 'Old trip', archived: true, archivedAt: 5 })],
    elements: [block('a1', 'A', 0, 'eggs')],
  };
  for (const store of omit) delete records[store];
  await createDatabase(env.indexedDB, {
    version,
    omit,
    extraStores: version >= 9 ? { meta: { keyPath: null, indexes: [] } } : {},
    records,
  });
  env.load(...files);
  const Storage = env.get('Storage');
  let initError = null;
  try {
    await Storage.init();
  } catch (error) {
    initError = error;
  }
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
  return { env, Storage, toasts, initError };
}

/** The writing column (#editor) with a title in it, as newtab.html has it. */
function writingColumn(env) {
  const { editor } = env.document.stub([{ id: 'editor' }]);
  const title = env.document.createElement('div');
  title.id = 'page-title';
  editor.appendChild(title);
  return editor;
}

/** Show a notice and let it fill. onExport resolves to each of `results` in turn. */
function showNotice(env, Storage, { results = [true], onClose = null } = {}) {
  const ExportNotice = env.get('ExportNotice');
  const calls = { exports: 0, closes: 0 };
  const notice = new ExportNotice({
    storage: Storage,
    onExport: async () => results[calls.exports++],
    onClose: () => { calls.closes += 1; if (onClose) onClose(); },
  });
  const column = writingColumn(env);
  notice.show(column);
  env.clock.tick(0);
  return { notice, column, calls };
}

const button = (column, label) => column.querySelectorAll('.export-notice-btn').find((b) => b.textContent === label);
const region = (column) => column.querySelector('.export-notice');

describe('ExportNotice.isDue', () => {
  it('is due for a profile that had notes, in a tab that ran no onboarding, with nothing recorded', async () => {
    const { env, Storage } = await setup();
    assert.equal(await env.get('ExportNotice').isDue(Storage, STARTED_WITH_NOTES), true);
  });

  it('is not due on a profile that had no notes, or in a tab that ran onboarding', async () => {
    const { env, Storage } = await setup();
    const ExportNotice = env.get('ExportNotice');
    assert.equal(await ExportNotice.isDue(Storage, { hadNotes: false, ranOnboarding: false }), false);
    assert.equal(await ExportNotice.isDue(Storage, { hadNotes: true, ranOnboarding: true }), false);
  });

  it('is not due once this notice or a later one has a recorded outcome', async () => {
    const { env, Storage } = await setup();
    const ExportNotice = env.get('ExportNotice');
    for (const record of [{ version: 1, outcome: 'dismissed', at: 1 }, { version: 2, outcome: 'exported', at: 2 }]) {
      env.chrome.local[KEY] = record;
      assert.equal(await ExportNotice.isDue(Storage, STARTED_WITH_NOTES), false);
    }
  });

  it('is due when the stored value is not a record of this notice', async () => {
    const { env, Storage } = await setup();
    const ExportNotice = env.get('ExportNotice');
    for (const value of ['dismissed', true, { outcome: 'dismissed' }]) {
      env.chrome.local[KEY] = value;
      assert.equal(await ExportNotice.isDue(Storage, STARTED_WITH_NOTES), true, JSON.stringify(value));
    }
  });

  it('is not due while a store is missing (#33 degraded state)', async () => {
    const { env, Storage } = await setup({ omit: ['themes'] });
    assert.deepEqual(plain(Storage.missingStores), ['themes']);
    assert.equal(await env.get('ExportNotice').isDue(Storage, STARTED_WITH_NOTES), false);
  });

  it("is not due in #33's guard states", async () => {
    for (const spec of [{ version: 9 }, { omit: ['elements'] }]) {
      const { env, Storage, initError } = await setup(spec);
      assert.ok(initError, 'Storage.init refused');
      assert.equal(await env.get('ExportNotice').isDue(Storage, STARTED_WITH_NOTES), false);
    }
  });
});

describe('ExportNotice.record', () => {
  it('writes one versioned record through the settings API, and the first choice stands', async () => {
    const { env, Storage } = await setup();
    const ExportNotice = env.get('ExportNotice');
    assert.equal(await ExportNotice.record(Storage, 'exported'), true);
    const record = env.chrome.local[KEY];
    assert.deepEqual(Object.keys(record).sort(), ['at', 'outcome', 'version']);
    assert.equal(record.version, 1);
    assert.equal(record.outcome, 'exported');
    assert.equal(typeof record.at, 'number');

    assert.equal(await ExportNotice.record(Storage, 'dismissed'), false);
    assert.deepEqual(env.chrome.local[KEY], record);
  });
});

describe('the notice', () => {
  it('goes in empty at the top of the writing column, fills a moment later, and takes no focus', async () => {
    const { env, Storage } = await setup();
    const ExportNotice = env.get('ExportNotice');
    const notice = new ExportNotice({ storage: Storage, onExport: async () => true });
    const column = writingColumn(env);
    const focused = env.document.activeElement;
    notice.show(column);

    const shown = region(column);
    assert.equal(column.children[0], shown, 'above the note title');
    assert.equal(shown.tagName, 'SECTION');
    assert.equal(shown.getAttribute('aria-live'), 'polite');
    assert.equal(shown.getAttribute('aria-labelledby'), 'export-notice-title');
    assert.equal(shown.textContent, '', 'empty until it fills, so it is announced');

    env.clock.tick(0);
    assert.equal(env.document.getElementById('export-notice-title').textContent, TITLE);
    assert.equal(shown.querySelector('.export-notice-body').textContent, BODY);
    assert.ok(shown.querySelector('.export-notice-contents').textContent.endsWith(LEFT_OUT));
    const buttons = shown.querySelectorAll('.export-notice-btn');
    assert.deepEqual(buttons.map((b) => [b.tagName, b.type, b.textContent]), [
      ['BUTTON', 'button', 'Export JSON'],
      ['BUTTON', 'button', 'Not now'],
    ]);
    assert.equal(env.document.activeElement, focused, 'focus stays where it was');
  });

  it("lists what the export leaves out in the Data & Backup hint's words", () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'newtab.html'), 'utf8');
    const hint = /<p class="setting-hint" id="export-contents-hint">([^<]*)<\/p>/.exec(html);
    assert.ok(hint, 'newtab.html has the Data & Backup hint');
    assert.ok(hint[1].includes(LEFT_OUT));
  });

  it('Not now records "dismissed", takes the notice away, and changes no note', async () => {
    const { env, Storage } = await setup();
    const before = await dumpDatabase(env.indexedDB);
    const { column, calls } = showNotice(env, Storage);
    button(column, 'Not now').click();
    await settle();

    assert.equal(env.chrome.local[KEY].outcome, 'dismissed');
    assert.equal(env.chrome.local[KEY].version, 1);
    assert.equal(region(column), null);
    assert.equal(calls.exports, 0);
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
  });

  it('Export JSON records "exported" only once the export succeeds, and changes no note', async () => {
    const { env, Storage } = await setup();
    const before = await dumpDatabase(env.indexedDB);
    const { column, calls } = showNotice(env, Storage, { results: [false, true] });

    button(column, 'Export JSON').click();
    await settle();
    assert.equal(calls.exports, 1);
    assert.equal(env.chrome.local[KEY], undefined, 'a failed export records nothing');
    assert.ok(region(column), 'and the notice stays');
    assert.equal(button(column, 'Export JSON').getAttribute('aria-disabled'), null);

    button(column, 'Export JSON').click();
    await settle();
    assert.equal(calls.exports, 2);
    assert.equal(env.chrome.local[KEY].outcome, 'exported');
    assert.equal(region(column), null);
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
  });

  it('ignores clicks while the export runs', async () => {
    const { env, Storage } = await setup();
    const ExportNotice = env.get('ExportNotice');
    let finish;
    let exports = 0;
    const notice = new ExportNotice({
      storage: Storage,
      onExport: () => { exports += 1; return new Promise((resolve) => { finish = resolve; }); },
    });
    const column = writingColumn(env);
    notice.show(column);
    env.clock.tick(0);

    button(column, 'Export JSON').click();
    button(column, 'Export JSON').click();
    button(column, 'Not now').click();
    await settle();
    assert.equal(exports, 1);
    assert.equal(button(column, 'Not now').getAttribute('aria-disabled'), 'true');
    assert.equal(env.chrome.local[KEY], undefined);

    finish(true);
    await settle();
    assert.equal(env.chrome.local[KEY].outcome, 'exported');
    assert.equal(region(column), null);
  });

  it('a choice that fails to save keeps the notice and says so', async () => {
    const { env, Storage, toasts } = await setup();
    const { column } = showNotice(env, Storage);
    env.chrome.failNextSet(new Error('QUOTA_BYTES quota exceeded'));
    button(column, 'Not now').click();
    await settle();

    assert.equal(env.chrome.local[KEY], undefined);
    assert.ok(region(column));
    assert.deepEqual(toasts, [{ message: "Couldn't save your choice. Try again.", kind: 'error' }]);
  });

  it('goes away when another tab records a choice', async () => {
    const { env, Storage } = await setup();
    const { column } = showNotice(env, Storage);
    const record = { version: 1, outcome: 'dismissed', at: 1 };
    env.chrome.api.storage.onChanged.listeners.forEach((listener) => listener({ [KEY]: { newValue: record } }, 'local'));
    assert.equal(region(column), null);
  });

  it('puts focus back in the note when it closes while holding focus', async () => {
    const { env, Storage } = await setup();
    const kept = showNotice(env, Storage);
    button(kept.column, 'Not now').click();
    await settle();
    assert.equal(kept.calls.closes, 0, 'focus was elsewhere, so it stays there');

    const other = await setup();
    const held = showNotice(other.env, other.Storage);
    button(held.column, 'Not now').focus();
    button(held.column, 'Not now').click();
    await settle();
    assert.equal(held.calls.closes, 1);
  });
});

describe('App.showExportNoticeIfDue', () => {
  it('puts the notice in the writing column for a profile that had notes', async () => {
    const { env } = await setup({ files: APP_FILES });
    const column = writingColumn(env);
    const app = { settingsController: { exportAll: async () => true } };
    await env.get('App').prototype.showExportNoticeIfDue.call(app, STARTED_WITH_NOTES);
    env.clock.tick(0);
    assert.equal(column.children[0].className, 'export-notice');
    assert.equal(env.document.getElementById('export-notice-title').textContent, TITLE);
  });

  it('shows nothing in a tab that ran onboarding, and never fails the start', async () => {
    const { env, Storage } = await setup({ files: APP_FILES });
    const column = writingColumn(env);
    const show = env.get('App').prototype.showExportNoticeIfDue;
    await show.call({}, { hadNotes: true, ranOnboarding: true });
    Storage.getSetting = async () => { throw new Error('storage gone'); };
    await show.call({}, STARTED_WITH_NOTES);
    assert.equal(region(column), null);
  });

  it("the #33 guard shows no notice and records nothing on a profile with notes", async () => {
    const env = createLegacyEnv({ document: new FakeDocument() });
    await createDatabase(env.indexedDB, {
      version: 9,
      extraStores: { meta: { keyPath: null, indexes: [] } },
      records: { canvases: [note('A', { name: 'Groceries' })], elements: [block('a1', 'A', 0, 'eggs')] },
    });
    env.document.stub(['app']);
    env.load(...APP_FILES);
    env.get('Utils').showToast = () => {};
    const app = new (env.get('App'))();
    await app.init();

    assert.equal(env.document.getElementById('storage-guard-title').textContent,
      'Your notes were upgraded by a newer NewTabNote version');
    assert.equal(env.document.querySelector('.export-notice'), null);
    assert.equal(env.chrome.local[KEY], undefined);
  });
});
