'use strict';

// NTN-18 slice 0: the one-time notice to export before the storage upgrade.
// It shows for a profile whose notes hold something, outside #33's guard and a
// missing media or folders store. Export JSON leads to a check-the-file step
// whose Done records `exported`; Not now records `dismissed`; a profile with
// nothing to export records `not-needed`. The record is written once, under a
// lock, through the settings API, and nothing here changes a note.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createLockManager, createDatabase, dumpDatabase, settle, waitFor, plain, note, block, FakeDocument,
  startEditorClient, watchTransactions,
} = require('./helpers/legacy-env');
const { loadPageModule } = require('./helpers/page-module');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/ui/export-notice.js'];
const KEY = 'setting_preMigrationNotice';
const RECEIPT = 'setting_lastFullExportAt';
const TITLE = 'Save a copy before the next update';
const BODY = 'The next NewTabNote update changes how notes are stored on this device. Exporting now gives you a copy to keep.';
const CONFIRM = 'Check that the file saved, then choose Done.';
const CONTENTS = 'Export JSON includes active and archived notes, templates, folders, and media. '
  + 'Not included: trash, themes, version history, AI chat history, and settings. '
  + 'Backlinks rebuild when each note is next saved.';
const ANY_TIME = 'You can export any time from Settings > Data & Backup.';
const HINT = 'Export JSON and Create Backup include active and archived notes, templates, folders, and media. '
  + 'Not included: trash, themes, version history, AI chat history, and settings. '
  + 'The Markdown ZIP holds active notes only. Backlinks rebuild when each note is next saved.';

/** A note that holds something and an archived one, unless `canvases`/`elements` say otherwise. */
async function setup({ omit = [], canvases, elements, files = FILES, ...shared } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument(), ...shared });
  const records = {
    canvases: canvases || [note('A', { name: 'Groceries' }), note('AR', { name: 'Old trip', archived: true, archivedAt: 5 })],
    elements: elements || [block('a1', 'A', 0, 'eggs')],
  };
  if (!shared.indexedDB) await createDatabase(env.indexedDB, { omit, records });
  env.load(...files);
  const Storage = env.get('Storage');
  await Storage.init();
  // The page's settings port, which reads and records the outcome, and the database's state,
  // as App gives the notice
  await startEditorClient(env);
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
  const PageNotice = env.get('ExportNotice');
  const ExportNotice = class extends PageNotice {
    constructor(deps) {
      super({ settings: env.settingsClient, storageState: env.storageState, ...deps });
    }
  };
  return { env, Storage, toasts, ExportNotice };
}

/** #export-notice as newtab.html has it, between the note's title and its blocks. */
function noticeMarkup(env) {
  const { editor } = env.document.stub([{ id: 'editor' }]);
  const title = env.document.createElement('div');
  title.id = 'page-title';
  editor.appendChild(title);
  const card = env.document.createElement('section');
  card.id = 'export-notice';
  card.className = 'export-notice';
  const text = env.document.createElement('div');
  text.className = 'export-notice-text';
  text.setAttribute('aria-live', 'polite');
  card.appendChild(text);
  editor.appendChild(card);
  return card;
}

/**
 * Show a notice, on the page's settings port and database state unless given. onExport
 * resolves to each of `exports` in turn.
 */
function showNotice(env, { exports = [true], onClose = null, settings = env.settingsClient } = {}) {
  const calls = { exports: 0, closes: [] };
  const notice = new (env.get('ExportNotice'))({
    storageState: env.storageState,
    settings,
    onExport: async () => exports[calls.exports++],
    onClose: (returnFocus) => {
      calls.closes.push(returnFocus);
      if (onClose) onClose(returnFocus);
    },
  });
  const card = noticeMarkup(env);
  notice.show(card);
  return { notice, card, calls };
}

const buttons = (card) => card.querySelectorAll('.export-notice-btn').map((b) => [b.textContent, b.className.split(' ')[0]]);
const button = (card, label) => card.querySelectorAll('.export-notice-btn').find((b) => b.textContent === label);
const shown = (card) => card.classList.contains('is-shown');
const record = (env) => env.chrome.local[KEY];

describe('ExportNotice.isDue', () => {
  it('is due for a profile with a note that holds something, with nothing recorded', async () => {
    const { Storage, ExportNotice } = await setup();
    assert.equal(await new ExportNotice().isDue(), true);
  });

  for (const [label, canvases, elements] of [
    ['no notes', [], []],
    ['only an untitled empty note, as a first start creates', [note('U', { name: 'Untitled' })], []],
    ['only untitled notes with empty blocks, and a note in trash', [note('U', { name: 'Untitled 2' }), note('T', { name: 'Kept', trashed: true, trashedAt: 1 })],
      [block('u1', 'U', 0, '<br>'), block('u2', 'U', 1, ' &nbsp; <br/> '), block('u3', 'U', 2, ''), block('t1', 'T', 0, 'trashed text')]],
  ]) {
    it(`with ${label}, records "not-needed" and is never due again`, async () => {
      const { env, Storage, ExportNotice } = await setup({ canvases, elements });
      assert.equal(await new ExportNotice().isDue(), false);
      assert.deepEqual(plain(record(env)), { version: 1, outcome: 'not-needed', at: record(env).at });
      assert.equal(typeof record(env).at, 'number');

      // The profile's own first note, typed into later, doesn't bring it
      await Storage.saveElement(block('later', canvases[0] ? canvases[0].id : (await Storage.createNote('Untitled')).id, 1, 'typed later'));
      assert.equal(await new ExportNotice().isDue(), false);
    });
  }

  for (const [label, canvases, elements] of [
    ['an untitled note with text', [note('U', { name: 'Untitled' })], [block('u1', 'U', 0, 'a line')]],
    ['an untitled note whose only block is a pasted image', [note('U', { name: 'Untitled' })],
      [block('u1', 'U', 0, '<img src="data:image/png;base64,iVBORw0KGgo=">')]],
    ['an untitled note with only a new table, its cells still "Header 1"', [note('U', { name: 'Untitled' })],
      [block('u1', 'U', 0, '', { type: 'table', tableData: [['Header 1', 'Header 2'], ['', '']] })]],
    ['an untitled note with only a divider', [note('U', { name: 'Untitled' })], [block('u1', 'U', 0, '', { type: 'divider' })]],
    ['a titled note with no blocks', [note('N', { name: 'Ideas' })], []],
    ['only a template', [note('T', { name: 'Weekly review', isTemplate: true })], []],
    ['only an archived note', [note('AR', { name: 'Untitled', archived: true, archivedAt: 1 })], [block('ar1', 'AR', 0, 'old')]],
  ]) {
    it(`is due with ${label}`, async () => {
      const { env, Storage, ExportNotice } = await setup({ canvases, elements });
      assert.equal(await new ExportNotice().isDue(), true);
      assert.equal(record(env), undefined);
    });
  }

  it('is not due once this notice or a later one has a recorded outcome', async () => {
    const { env, Storage, ExportNotice } = await setup();
    for (const value of [{ version: 1, outcome: 'dismissed', at: 1 }, { version: 2, outcome: 'exported', at: 2 }]) {
      env.chrome.local[KEY] = value;
      assert.equal(await new ExportNotice().isDue(), false);
    }
  });

  it('is due when the stored value is not a record of this notice', async () => {
    const { env, Storage, ExportNotice } = await setup();
    for (const value of ['dismissed', true, { outcome: 'dismissed' }]) {
      env.chrome.local[KEY] = value;
      assert.equal(await new ExportNotice().isDue(), true, JSON.stringify(value));
    }
  });

  for (const store of ['media', 'folders']) {
    it(`is not due while the ${store} store, which Export JSON reads, is missing`, async () => {
      const { Storage, ExportNotice } = await setup({ omit: [store] });
      assert.deepEqual(plain(Storage.missingStores), [store]);
      assert.equal(await new ExportNotice().isDue(), false);
    });
  }

  for (const store of ['themes', 'settings', 'vectors']) {
    it(`is still due while the ${store} store, which Export JSON doesn't read, is missing`, async () => {
      const { Storage, ExportNotice } = await setup({ omit: [store] });
      assert.equal(await new ExportNotice().isDue(), true);
    });
  }

  it('a failed read decides nothing and records nothing', async () => {
    const { env, Storage, ExportNotice } = await setup({ canvases: [], elements: [] });
    failNextRead(env, KEY);
    await assert.rejects(new ExportNotice().isDue());
    assert.equal(record(env), undefined);
  });

  it('after a full export, a tab that shows it starts at the check-the-file step', async () => {
    const { env, Storage, ExportNotice } = await setup();
    env.chrome.local[RECEIPT] = 1700000000000;
    const notice = new ExportNotice({ onExport: async () => true });
    assert.equal(await notice.isDue(), true);
    const card = noticeMarkup(env);
    notice.show(card);
    assert.equal(card.querySelector('.export-notice-body').textContent, CONFIRM);
    assert.deepEqual(buttons(card), [['Done', 'primary-btn'], ['Export again', 'secondary-btn'], ['Not now', 'secondary-btn']]);
    assert.equal(record(env), undefined);
  });

  it('a failed read of that receipt starts it at the first step', async () => {
    const { env, Storage, ExportNotice } = await setup();
    env.chrome.local[RECEIPT] = 1700000000000;
    failNextRead(env, RECEIPT);
    const notice = new ExportNotice({ onExport: async () => true });
    assert.equal(await notice.isDue(), true);
    const card = noticeMarkup(env);
    notice.show(card);
    assert.deepEqual(buttons(card).map(([text]) => text), ['Export JSON', 'Not now']);
  });
});

describe('Storage settings reads', () => {
  it('getSetting is readSetting with a default for a missing key or a failed read', async () => {
    const { env, Storage } = await setup();
    env.chrome.local.setting_theme = 'dark';
    assert.equal(await Storage.getSetting('theme', 'system'), 'dark');
    assert.equal(await Storage.readSetting('theme'), 'dark');
    assert.equal(await Storage.getSetting('nothingHere', 'fallback'), 'fallback');
    assert.equal(await Storage.readSetting('nothingHere'), undefined);
    failNextRead(env, 'setting_theme');
    assert.equal(await Storage.getSetting('theme', 'system'), 'system');
    failNextRead(env, 'setting_theme');
    await assert.rejects(Storage.readSetting('theme'), /IO error/);
  });
});

/**
 * Make the next chrome.storage.local read of `key` fail, as Chrome reports it: through
 * runtime.lastError to a callback, and as a rejection to a promise read, the settings port's.
 */
function failNextRead(env, key) {
  const local = env.chrome.api.storage.local;
  const realGet = local.get;
  local.get = (keys, callback) => {
    if (![].concat(keys).includes(key)) return realGet.call(local, keys, callback);
    local.get = realGet;
    if (!callback) return Promise.reject(new Error('IO error'));
    setImmediate(() => {
      env.chrome.api.runtime.lastError = { message: 'IO error' };
      try { callback(undefined); } finally { env.chrome.api.runtime.lastError = undefined; }
    });
    return undefined;
  };
}

describe('ExportNotice.record', () => {
  it('writes one versioned record through the settings API, and a recorded outcome stands', async () => {
    const { env, Storage, ExportNotice } = await setup();
    const notice = new ExportNotice();
    await notice.record('dismissed');
    const first = plain(record(env));
    assert.deepEqual(Object.keys(first).sort(), ['at', 'outcome', 'version']);
    assert.equal(first.version, 1);
    assert.equal(first.outcome, 'dismissed');

    await notice.record('not-needed');
    assert.deepEqual(plain(record(env)), first);
  });

  it('"exported" replaces "dismissed", so an export that finishes after another tab\'s Not now counts', async () => {
    const { env, Storage, ExportNotice } = await setup();
    const notice = new ExportNotice();
    await notice.record('dismissed');
    await notice.record('exported');
    assert.equal(record(env).outcome, 'exported');
    await notice.record('dismissed');
    assert.equal(record(env).outcome, 'exported', 'and nothing replaces "exported"');
  });

  it('two tabs take turns: both read before either writes only without the lock', async () => {
    const locks = createLockManager();
    const first = await setup({ locks });
    const second = await setup({ locks, indexedDB: first.env.indexedDB, chrome: first.env.chrome });
    const seen = [];
    // Each tab's settings port, whose reads of the record are seen
    const watched = (settings) => ({
      ...settings,
      workspaceData: async (keys) => {
        const values = await settings.workspaceData(keys);
        const value = values.preMigrationNotice;
        seen.push(value === undefined ? 'none' : value.outcome);
        await settle(5); // the other tab gets its chance here
        return values;
      },
    });
    await Promise.all([
      new first.ExportNotice({ settings: watched(first.env.settingsClient) }).record('exported'),
      new second.ExportNotice({ settings: watched(second.env.settingsClient) }).record('dismissed'),
    ]);
    assert.deepEqual(seen, ['none', 'exported'], 'the second tab read what the first wrote');
    assert.equal(record(first.env).outcome, 'exported');
  });

  it('a failed read writes nothing over what is there', async () => {
    const { env, Storage, ExportNotice } = await setup();
    env.chrome.local[KEY] = { version: 1, outcome: 'exported', at: 1 };
    failNextRead(env, KEY);
    await assert.rejects(new ExportNotice().record('dismissed'));
    assert.deepEqual(plain(record(env)), { version: 1, outcome: 'exported', at: 1 });
  });
});

describe('the notice', () => {
  it('fills the static markup: heading and text in the live region, buttons outside it, named by its heading', async () => {
    const { env, Storage } = await setup();
    const focused = env.document.activeElement;
    const { card } = showNotice(env);

    const live = card.querySelector('.export-notice-text');
    assert.equal(live.getAttribute('aria-live'), 'polite');
    assert.equal(live.querySelector('h2').id, 'export-notice-title');
    assert.equal(live.querySelector('h2').textContent, TITLE);
    assert.deepEqual(live.querySelectorAll('p').map((p) => p.textContent), [BODY, CONTENTS, ANY_TIME]);
    assert.equal(live.querySelectorAll('button').length, 0, 'no buttons in the live region');
    assert.equal(card.getAttribute('aria-labelledby'), 'export-notice-title');
    assert.ok(shown(card));
    assert.deepEqual(buttons(card), [['Export JSON', 'primary-btn'], ['Not now', 'secondary-btn']]);
    assert.deepEqual(card.querySelectorAll('.export-notice-btn').map((b) => [b.tagName, b.type]), [['BUTTON', 'button'], ['BUTTON', 'button']]);
    assert.equal(env.document.activeElement, focused, 'focus stays where it was');
  });

  it('says what Export JSON holds in the same words as the Data & Backup hint, which App fills from it', async () => {
    const { ExportNotice } = await setup();
    assert.equal(ExportNotice.TEXT.contents, CONTENTS);
    assert.equal(ExportNotice.TEXT.hint, HINT);
  });

  it('Export JSON records nothing: it asks to check the file, with Done, Export again, and Not now', async () => {
    const { env, Storage } = await setup();
    const before = await dumpDatabase(env.indexedDB);
    const { card, calls } = showNotice(env, { exports: [true, true] });
    const exportButton = button(card, 'Export JSON');
    exportButton.focus();

    exportButton.click();
    await settle();
    assert.equal(calls.exports, 1);
    assert.equal(record(env), undefined, 'the file may not have saved');
    assert.equal(card.querySelector('.export-notice-body').textContent, CONFIRM);
    assert.deepEqual(buttons(card), [['Done', 'primary-btn'], ['Export again', 'secondary-btn'], ['Not now', 'secondary-btn']]);
    assert.equal(env.document.activeElement, exportButton, 'focus stays on the button, now Export again');

    button(card, 'Export again').click();
    await settle();
    assert.equal(calls.exports, 2);
    assert.equal(record(env), undefined);

    button(card, 'Done').click();
    await settle();
    assert.equal(record(env).outcome, 'exported');
    assert.equal(shown(card), false);
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
  });

  it('a failed export keeps the notice as it was; its own toast says why', async () => {
    const { env, Storage } = await setup();
    const { card, calls } = showNotice(env, { exports: [false] });
    button(card, 'Export JSON').click();
    await settle();
    assert.equal(calls.exports, 1);
    assert.deepEqual(buttons(card), [['Export JSON', 'primary-btn'], ['Not now', 'secondary-btn']]);
    assert.equal(card.getAttribute('aria-busy'), null);
    assert.equal(record(env), undefined);
  });

  it('Not now records "dismissed", from either step, and changes no note', async () => {
    for (const exportFirst of [false, true]) {
      const { env, Storage } = await setup();
      const before = await dumpDatabase(env.indexedDB);
      const { card } = showNotice(env);
      if (exportFirst) {
        button(card, 'Export JSON').click();
        await settle();
      }
      button(card, 'Not now').click();
      await settle();
      assert.equal(record(env).outcome, 'dismissed');
      assert.equal(shown(card), false);
      assert.equal(card.querySelector('.export-notice-text').textContent, '');
      assert.equal(card.getAttribute('aria-labelledby'), null);
      assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    }
  });

  it('ignores clicks while a choice runs, marked by aria-busy', async () => {
    const { env, Storage } = await setup();
    let finish;
    let exports = 0;
    const notice = new (env.get('ExportNotice'))({
      storageState: env.storageState,
      settings: env.settingsClient,
      onExport: () => { exports += 1; return new Promise((resolve) => { finish = resolve; }); },
    });
    const card = noticeMarkup(env);
    notice.show(card);

    button(card, 'Export JSON').click();
    button(card, 'Export JSON').click();
    button(card, 'Not now').click();
    await settle();
    assert.equal(exports, 1);
    assert.equal(card.getAttribute('aria-busy'), 'true');
    assert.equal(record(env), undefined);

    finish(true);
    await settle();
    assert.equal(card.getAttribute('aria-busy'), null);
    assert.ok(button(card, 'Done'));
  });

  it('a choice that fails to save keeps the notice and says so', async () => {
    const { env, Storage, toasts } = await setup();
    const { card } = showNotice(env);
    env.chrome.failNextSet(new Error('Resource::kQuotaBytes quota exceeded'));
    button(card, 'Not now').click();
    await settle();

    assert.equal(record(env), undefined);
    assert.ok(shown(card));
    assert.deepEqual(toasts, [{ message: "Couldn't save your choice. Try again.", kind: 'error' }]);
  });

  it('goes away when another tab records a choice, and stops listening', async () => {
    const { env, Storage } = await setup();
    const listeners = env.chrome.api.storage.onChanged.listeners;
    const before = listeners.length;
    const { card } = showNotice(env);
    assert.equal(listeners.length, before + 1);

    // Another tab writes the choice, and this tab hears which setting changed
    const recorded = { version: 1, outcome: 'dismissed', at: 1 };
    await new Promise((resolve) => env.chrome.api.storage.local.set({ [KEY]: recorded }, resolve));
    listeners.slice().forEach((listener) => listener({ [KEY]: { newValue: recorded } }, 'local'));
    await waitFor(() => !shown(card));
    assert.equal(shown(card), false);
    assert.equal(listeners.length, before, 'the settings listener is gone');
  });

  it('closes in the file:// preview too, whose chrome.storage stand-in has no real events', async () => {
    const env = createLegacyEnv({ document: new FakeDocument() });
    delete env.global.chrome;
    env.load(...FILES);
    assert.equal(typeof env.get('chrome.storage.onChanged.addListener'), 'function', 'storage.js put its stand-in in place');
    // The settings port hears of changes through chrome.storage.onChanged, the stand-in's here,
    // as the new tab's root builds it
    const { createNewTabSettingsClient, newTabHost } = await loadPageModule(env, 'js/kernel/composition/newtab.js');
    const settings = createNewTabSettingsClient(null, newTabHost());
    const { notice, card } = showNotice(env, { settings });
    notice.close();
    assert.equal(shown(card), false);
  });

  it('an export from Settings, in any tab, moves it to the check-the-file step', async () => {
    const { env, Storage } = await setup();
    const { card } = showNotice(env);
    env.chrome.api.storage.onChanged.listeners.slice().forEach((listener) => listener({ [RECEIPT]: { newValue: 1 } }, 'local'));
    assert.equal(card.querySelector('.export-notice-body').textContent, CONFIRM);
    assert.deepEqual(buttons(card).map(([label]) => label), ['Done', 'Export again', 'Not now']);
  });

  it('when it closes holding focus, onClose gets where focus was before it moved into the notice', async () => {
    const { env, Storage } = await setup();
    const kept = showNotice(env);
    button(kept.card, 'Not now').click();
    await settle();
    assert.deepEqual(kept.calls.closes, [], 'focus was elsewhere, so it stays there');

    const other = await setup();
    const held = showNotice(other.env);
    const block = other.env.document.createElement('div');
    other.env.document.body.appendChild(block);
    const notNow = button(held.card, 'Not now');
    notNow.focus();
    notNow.dispatchEvent({ type: 'focusin', relatedTarget: block });
    notNow.dispatchEvent({ type: 'focusin', relatedTarget: button(held.card, 'Export JSON') }); // moving within the notice
    notNow.click();
    await settle();
    assert.equal(held.calls.closes.length, 1);
    assert.equal(held.calls.closes[0].element, block);
  });
});

describe('the receipt Settings writes after a full export', () => {
  const SETTINGS_FILES = [...FILES, 'js/controllers/tab-controller.js', 'js/controllers/settings-controller.js'];

  async function settingsSetup() {
    const context = await setup({ files: SETTINGS_FILES });
    const downloads = [];
    context.env.get('Utils').downloadFile = (data, filename) => downloads.push({ data, filename });
    const settings = new (context.env.get('SettingsController'))({
      settings: context.env.settingsClient,
      documentClient: context.env.documentClient,
      validateBackup: context.env.validateBackup,
      domRefs: null,
      logger: null,
    });
    return { ...context, settings, downloads };
  }

  it('Export JSON and Create Backup write it, and move a showing notice to the check-the-file step', async () => {
    for (const [run, countsAsBackup] of [['exportAll', true], ['createBackup', false]]) {
      const { env, Storage, settings, downloads } = await settingsSetup();
      const { card } = showNotice(env);
      assert.equal(await settings[run](), true);
      assert.equal(downloads.length, 1);
      assert.equal(typeof env.chrome.local[RECEIPT], 'number');
      assert.equal(typeof env.chrome.local.setting_lastBackupAt, countsAsBackup ? 'number' : 'undefined', 'as 1.4.0 kept it');
      await waitFor(() => card.querySelector('[data-action="done"]'), { message: 'the check-the-file step' });
      assert.equal(card.querySelector('.export-notice-body').textContent, CONFIRM);
      assert.equal(record(env), undefined);
    }
  });

  it('Export JSON and Create Backup first save what every open editor has pending, so the file has the last edit', async () => {
    for (const run of ['exportAll', 'createBackup']) {
      const { env, Storage, settings, downloads } = await settingsSetup();
      // The primary and split editors and Picture-in-Picture, each with an edit inside its debounce
      const pending = (id, noteId, content) => ({
        flushSave: async () => {
          await settle(2);
          await Storage.saveElement(block(id, noteId, 9, content));
        },
      });
      const tabs = Object.create(env.get('TabController').prototype);
      Object.assign(tabs, {
        editor: pending('a1', 'A', 'eggs and milk'),
        secondaryEditor: pending('ar1', 'AR', 'typed in the right pane'),
        pipEditor: pending('pip1', 'A', 'typed in Picture-in-Picture'),
      });
      settings.onSaveOpenEditors = () => tabs.saveOpenEditors();

      assert.equal(await settings[run](), true);
      const file = JSON.parse(await downloads[0].data.text());
      const contents = Object.fromEntries(file.elements.map((element) => [element.id, element.content]));
      assert.deepEqual([contents.a1, contents.ar1, contents.pip1],
        ['eggs and milk', 'typed in the right pane', 'typed in Picture-in-Picture'], run);
    }
  });

  it('the file handed over still counts when the writes after it fail', async () => {
    const { env, settings, toasts, downloads } = await settingsSetup();
    env.chrome.failNextSet(new Error('Resource::kQuotaBytes quota exceeded'));
    assert.equal(await settings.exportAll(), true);
    assert.equal(downloads.length, 1);
    assert.deepEqual(toasts, [{ message: 'All notes exported as JSON', kind: 'success' }]);
  });

  it('a failed export says so and hands nothing over', async () => {
    const { settings, toasts, downloads } = await settingsSetup();
    // The read fails: the readonly transaction over the notes and blocks that #17's adapter
    // reads the export in since #17 PR 4a
    let failed = false;
    const unwatch = watchTransactions(({ stores, mode, name, open }) => {
      if (!failed && name === 'CanvasTabDB' && mode === 'readonly' && stores.includes('canvases') && stores.includes('elements')) {
        failed = true;
        throw new DOMException('read failed', 'UnknownError');
      }
      return open();
    });
    try {
      assert.equal(await settings.exportAll(), false);
    } finally {
      unwatch();
    }
    assert.equal(failed, true, 'the read failed');
    assert.equal(downloads.length, 0);
    assert.deepEqual(toasts, [{ message: 'Export failed', kind: 'error' }]);
  });
});

describe('focus after the notice closes holding it (App.focusAfterExportNotice)', () => {
  const APP_FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/core/dom-refs.js',
    'js/core/logger.js', 'js/storage.js', 'js/search.js', 'js/app.js'];

  /**
   * The active pane's editor, as App.getEditor returns it: a title and blocks,
   * each [id, whether it has text content].
   */
  function activePane(env, { noteId = 'N', blocks = [['image', false], ['t1', true], ['t2', true]] } = {}) {
    const doc = env.document;
    const root = doc.createElement('div');
    root.className = 'editor-pane active';
    doc.body.appendChild(root);
    const titleEl = doc.createElement('div');
    titleEl.id = 'page-title';
    root.appendChild(titleEl);
    const elements = {};
    for (const [id, hasText] of blocks) {
      const element = doc.createElement('div');
      element.className = 'block';
      if (hasText) {
        const content = doc.createElement('div');
        content.className = 'block-content';
        element.appendChild(content);
      }
      root.appendChild(element);
      elements[id] = element;
    }
    const focusedBlocks = [];
    const editor = {
      noteId,
      root,
      titleEl,
      blocks: blocks.map(([id]) => ({ id })),
      getBlockElement: (id) => elements[id] || null,
      focusBlock: (id, atEnd) => {
        focusedBlocks.push([id, atEnd]);
        elements[id].querySelector('.block-content').focus();
      },
    };
    return { editor, root, titleEl, elements, focusedBlocks };
  }

  function appSetup() {
    const env = createLegacyEnv({ document: new FakeDocument() });
    env.load(...APP_FILES);
    const App = env.get('App');
    const focusAfter = (editor, returnFocus) => App.prototype.focusAfterExportNotice.call({ getEditor: () => editor }, returnFocus);
    return { env, focusAfter };
  }

  it('goes back where it was in the pane, caret included', () => {
    const { env, focusAfter } = appSetup();
    const { editor, elements, focusedBlocks } = activePane(env);
    const ranges = [];
    env.document.getSelection = () => ({ removeAllRanges: () => ranges.push('cleared'), addRange: (range) => ranges.push(range) });
    const caret = { collapsed: true, startOffset: 2 };
    const content = elements.t2.querySelector('.block-content');

    focusAfter(editor, { element: content, range: caret });
    assert.equal(env.document.activeElement, content);
    assert.deepEqual(ranges, ['cleared', caret]);
    assert.deepEqual(focusedBlocks, []);
  });

  it('else to the end of the first text block, when focus came from outside the panes or from something gone', () => {
    const { env, focusAfter } = appSetup();
    const headerButton = env.document.createElement('button');
    env.document.body.appendChild(headerButton);
    // A block of a pane no longer on the page
    const removed = activePane(env);
    removed.root.remove();
    const gone = removed.elements.t2.querySelector('.block-content');
    for (const returnFocus of [null, { element: null, range: null }, { element: headerButton, range: null }, { element: gone, range: null }]) {
      const { editor, elements, focusedBlocks } = activePane(env);
      focusAfter(editor, returnFocus);
      assert.deepEqual(focusedBlocks, [['t1', true]], 'the image block before it has no text');
      assert.equal(env.document.activeElement, elements.t1.querySelector('.block-content'));
    }
  });

  it('else the title, for a note with no text blocks', () => {
    const { env, focusAfter } = appSetup();
    const { editor, titleEl, focusedBlocks } = activePane(env, { blocks: [['image', false], ['divider', false]] });
    focusAfter(editor, null);
    assert.equal(env.document.activeElement, titleEl);
    assert.deepEqual(focusedBlocks, []);
  });

  it('else the pane itself when no note is loaded, never the page body, and only until focus moves on', () => {
    const { env, focusAfter } = appSetup();
    const { editor, root } = activePane(env, { noteId: null, blocks: [] });
    focusAfter(editor, null);
    assert.equal(env.document.activeElement, root);
    assert.equal(root.getAttribute('tabindex'), '-1');
    assert.notEqual(env.document.activeElement, env.document.body);

    root.dispatchEvent({ type: 'blur' });
    assert.equal(root.hasAttribute('tabindex'), false, 'the pane is focusable again only as the markup has it');
  });
});
