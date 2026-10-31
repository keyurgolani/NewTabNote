'use strict';

// AC6: startup never deletes the database or its records, keeps a version-8
// database with stores missing (one recovery copy, features off), and the
// integrity check is read-only.
// AC7: a database a newer build upgraded (since #17 PR 1b, one past version 9)
// stays byte-identical on every surface, with no chrome.storage.local writes but
// the worker's record of its migration run, and each surface shows the guard.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLegacyEnv, createLockManager, createDatabase, dumpDatabase, recordsOf, waitFor, plain, note, block, FakeDocument,
} = require('./helpers/legacy-env');
// The service worker is a module worker, and Popup and Side Panel load module entries; these
// run them the way Chrome does
const { startWorker } = require('./helpers/load-background');
const { loadPageModule } = require('./helpers/page-module');

const TEST_KEY = 'test-only-api-key';
const STORAGE_FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js'];
const APP_FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/core/dom-refs.js', 'js/core/logger.js',
  'js/ui/export-notice.js', 'js/storage.js', 'js/search.js', 'js/app.js',
];
const GUARD_TITLE = 'Your notes were upgraded by a newer NewTabNote version';
const GUARD_BODY = "This version can't open them safely, so it won't change anything. Update NewTabNote to keep working, or export a copy now.";

/** Rows for every v8 store, including orphans the old sweep deleted and a plaintext key in `settings`. */
function allRecords() {
  return {
    canvases: [
      note('n1', { name: 'Kept' }),
      note('expired', { name: 'Expired in trash', trashed: true, trashedAt: 1000 }),
    ],
    elements: [
      block('b1', 'n1', 0, 'hello'),
      block('b-expired', 'expired', 0, 'trashed body'),
      block('b-orphan', 'ghost', 0, 'orphan block'),
    ],
    settings: [{ key: 'llmApiKey', value: TEST_KEY }],
    media: [
      { id: 'm1', canvasId: 'n1', blob: new Blob(['png bytes'], { type: 'image/png' }), type: 'image/png', createdAt: 1 },
      { id: 'm-orphan', canvasId: 'ghost', blob: new Blob(['x'], { type: 'text/plain' }), type: 'text/plain', createdAt: 1 },
    ],
    search_index: [{ noteId: 'n1', name: 'Kept', content: 'hello', updatedAt: 1 }, { noteId: 'ghost', name: 'Gone', updatedAt: 1 }],
    folders: [{ id: 'f1', name: 'Folder', parentId: null, createdAt: 1, updatedAt: 1 }],
    links: [{ id: 'l1', fromNoteId: 'n1', toNoteId: 'ghost', createdAt: 1 }],
    themes: [{ id: 't1', name: 'My theme', updatedAt: 1 }],
    vectors: [{ id: 'n1', noteId: 'n1', vector: [0.1, 0.2] }, { id: 'ghost', noteId: 'ghost', vector: [0.3] }],
    snapshots: [{ id: 's1', noteId: 'ghost', timestamp: 1, blocks: [], title: 'Gone' }],
  };
}

/**
 * What `env` logged at `level` whose first argument is `first`, as each call's arguments
 * @returns {Array<Array<any>>}
 */
/**
 * chrome.storage.local writes but the worker's record of its migration run (#17 PR 1b), the
 * one key it writes on a profile it leaves as it is
 */
function writesButUpgradeRecord(env) {
  return env.chrome.writes().filter((w) => !(w.method === 'set' && w.keys.length === 1 && w.keys[0] === 'setting_storageUpgrade'));
}

function logged(env, level, first) {
  return env.logs.filter((entry) => entry.level === level && entry.args[0] === first).map((entry) => entry.args);
}

/** A database from raw indexedDB.open calls: version 8 with `omit` left out, or a later version with a meta store. */
async function fixture(factory, { version = 8, omit = [] } = {}) {
  const records = allRecords();
  for (const store of omit) delete records[store];
  const extraStores = {};
  if (version >= 9) {
    extraStores.meta = { keyPath: null, indexes: [] };
    records.meta = [{ key: 'schemaVersion', value: 9 }, { key: 'migratedAt', value: 1760000000000 }];
  }
  await createDatabase(factory, { version, omit, extraStores, records });
}

/**
 * Hold chrome.storage.local reads of `key` until a second one arrives, or for 50
 * event-loop turns, so two starts that overlap both read before either writes.
 */
function holdReads(chromeStub, key) {
  const local = chromeStub.api.storage.local;
  const realGet = local.get.bind(local);
  let held = [];
  const release = () => {
    const run = held;
    held = [];
    run.forEach((read) => read());
  };
  local.get = (keys, callback) => {
    if (keys !== key || !callback) return realGet(keys, callback);
    held.push(() => realGet(keys, callback));
    if (held.length === 2) {
      release();
    } else {
      let turns = 0;
      const wait = () => {
        if (held.length === 0) return;
        if (++turns >= 50) release();
        else setImmediate(wait);
      };
      setImmediate(wait);
    }
    return undefined;
  };
}

function recoveryCopies(env) {
  return Object.entries(env.chrome.local).filter(([key]) => key.startsWith('recovery_backup_'));
}

async function startStorage(env) {
  env.load(...STORAGE_FILES);
  const Storage = env.get('Storage');
  let error = null;
  try {
    await Storage.init();
  } catch (e) {
    error = e;
  }
  return { Storage, error };
}

describe('startup: complete version-8 database', () => {
  it('opens, writes no recovery copy, and the integrity check deletes nothing', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB);
    const before = await dumpDatabase(env.indexedDB);
    const { Storage, error } = await startStorage(env);

    assert.equal(error, null);
    assert.equal(Storage.openState, 'open');
    assert.deepEqual(plain(Storage.missingStores), []);
    assert.deepEqual(await dumpDatabase(env.indexedDB), before, 'orphans and expired trash still there');
    assert.equal(recoveryCopies(env).length, 0);
    assert.ok(env.logs.some((l) => l.level === 'info' && String(l.args[0]).includes('Integrity check')));
  });

  it('validateDatabase counts orphans in every auxiliary store, including snapshots and media', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB);
    const { Storage } = await startStorage(env);
    assert.deepEqual(plain(await Storage.validateDatabase()), {
      orphanedElements: 1,
      orphanedSearchIndex: 1,
      orphanedLinks: 1,
      orphanedVectors: 1,
      orphanedSnapshots: 1,
      orphanedMedia: 1,
      missingStores: [],
    });
  });

  it('no file under js/ calls indexedDB.deleteDatabase (AC6)', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.m?js$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('deleteDatabase')) offenders.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'js'));
    assert.deepEqual(offenders, []);
  });
});

describe('startup: version 8 without themes (AC6)', () => {
  it('keeps every record and writes exactly one recovery copy of every readable store except settings', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['themes'] });
    const before = await dumpDatabase(env.indexedDB);
    const { Storage, error } = await startStorage(env);

    assert.equal(error, null);
    assert.equal(Storage.openState, 'open');
    assert.deepEqual(plain(Storage.missingStores), ['themes']);
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);

    const copies = recoveryCopies(env);
    assert.equal(copies.length, 1);
    const [key, copy] = copies[0];
    assert.match(key, /^recovery_backup_\d+$/);
    assert.equal(copy.recoveryBackup, true);
    assert.equal(copy.reason, 'missing-stores');
    assert.deepEqual(copy.missingStores, ['themes']);
    assert.equal(typeof copy.timestamp, 'number');
    for (const store of ['canvases', 'elements', 'media', 'search_index', 'folders', 'links', 'vectors', 'snapshots']) {
      assert.deepEqual(copy[store].map((r) => r.id || r.noteId).sort(),
        recordsOf(before, store) && Object.keys(recordsOf(before, store)).sort(), `${store} copied`);
    }
    assert.equal(copy.settings, undefined, 'settings left out');
    assert.ok(!JSON.stringify(copy).includes(TEST_KEY), 'no plaintext key in the copy');
    const media = copy.media.find((m) => m.id === 'm1');
    assert.equal(media.blob, `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`, 'Blob as data URL');
  });

  it('a second start does not write a second copy for the same missing stores', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['themes'] });
    await startStorage(env);
    const again = createLegacyEnv({ indexedDB: env.indexedDB });
    Object.assign(again.chrome.local, JSON.parse(JSON.stringify(env.chrome.local)));
    await startStorage(again);
    assert.equal(recoveryCopies(again).length, 1);
  });

  it('two tabs starting at once write one copy between them', async () => {
    const locks = createLockManager();
    const first = createLegacyEnv({ locks });
    await fixture(first.indexedDB, { omit: ['themes'] });
    // A second new tab of the same profile: same database, chrome.storage.local, and locks.
    const second = createLegacyEnv({ indexedDB: first.indexedDB, chrome: first.chrome, locks });
    // Reading every store takes a while on a real profile, so the second tab looks for the
    // copy while the first is still reading. Hold each look briefly so both can overlap.
    holdReads(first.chrome, 'recovery_copy_missing_stores');

    await Promise.all([startStorage(first), startStorage(second)]);

    // Count writes, not keys: two starts in the same millisecond pick the same key.
    const copyWrites = first.chrome.calls.filter((c) => c.method === 'set'
      && c.keys.some((key) => key.startsWith('recovery_backup_')));
    assert.equal(copyWrites.length, 1, 'one tab writes the copy, the other finds it');
    const copies = recoveryCopies(first).filter(([, copy]) => copy.reason === 'missing-stores');
    assert.equal(copies.length, 1);
  });

  it('without navigator.locks a start still writes the copy', async () => {
    const env = createLegacyEnv({ locks: null });
    await fixture(env.indexedDB, { omit: ['themes'] });
    await startStorage(env);
    assert.equal(recoveryCopies(env).length, 1);
  });

  it('no start reads all of chrome.storage.local to look for the copy', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['themes'] });
    // Backups already stored, which a full read would load into memory before render.
    env.chrome.local.auto_backup_1 = { version: 1, canvases: [], elements: [] };
    env.chrome.local.recovery_backup_1 = { recoveryBackup: true, reason: 'pre-import-replace', canvases: [] };
    await startStorage(env);
    const again = createLegacyEnv({ indexedDB: env.indexedDB });
    Object.assign(again.chrome.local, JSON.parse(JSON.stringify(env.chrome.local)));
    await startStorage(again);

    const fullReads = (calls) => calls.filter((c) => c.method === 'get' && (c.keys === null || c.keys === undefined));
    assert.deepEqual(fullReads(env.chrome.calls), [], 'the start that writes the copy');
    assert.deepEqual(fullReads(again.chrome.calls), [], 'a later start');
    const missingStoreCopies = recoveryCopies(again).filter(([, copy]) => copy.reason === 'missing-stores');
    assert.equal(missingStoreCopies.length, 1);
  });

  it('the service worker never writes the copy', async () => {
    const env = createLegacyEnv({ context: 'worker' });
    await fixture(env.indexedDB, { omit: ['themes'] });
    env.load(...STORAGE_FILES);
    await env.get('Storage').init();
    assert.equal(recoveryCopies(env).length, 0);
  });

  it('runs without custom themes: reads are empty, a write reaches its error', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['themes'] });
    const { Storage } = await startStorage(env);
    assert.deepEqual(plain(await Storage.getCustomThemes()), []);
    await assert.rejects(Storage.saveCustomTheme({ name: 'New' }), { code: 'STORE_UNAVAILABLE' });
    const created = await Storage.createNote('Still works');
    assert.ok(await Storage.getNote(created.id));
  });

  it('the new tab names the features that are off and points to Export', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['themes', 'settings'] });
    env.load(...APP_FILES);
    await env.get('Storage').init();
    const toasts = [];
    env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
    env.get('App').prototype.reportMissingStores.call({ storageState: await storageStateOf(env) });
    assert.deepEqual(toasts, [{
      message: 'Your notes database is incomplete, so these are off: custom themes. Export a copy from Settings > Data & Backup.',
      kind: 'error',
    }]);
  });

  it('a missing settings store alone shows no toast', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['settings'] });
    env.load(...APP_FILES);
    await env.get('Storage').init();
    const toasts = [];
    env.get('Utils').showToast = (message) => toasts.push(message);
    env.get('App').prototype.reportMissingStores.call({ storageState: await storageStateOf(env) });
    assert.deepEqual(toasts, []);
  });
});

describe('startup: version 8 without media, with an expired trashed note', () => {
  async function start() {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['media'] });
    env.load(...APP_FILES, 'js/controllers/sidebar-controller.js');
    const Storage = env.get('Storage');
    await Storage.init();
    return { env, Storage };
  }

  it('skips trash cleanup in SidebarController, so the expired note keeps its blocks', async () => {
    const { env } = await start();
    const before = await dumpDatabase(env.indexedDB);
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const removed = [];
    // App.init runs the sidebar's; App's own copy had no caller, and slice 5 deleted it
    assert.equal(env.get('App').prototype.runTrashCleanup, undefined);
    const SidebarController = env.get('SidebarController');
    const removal = { removeNotes: async (removal) => { removed.push(removal); return { kind: 'committed', changedIds: [] }; } };
    await SidebarController.prototype.runTrashCleanup.call({ storageState: await storageStateOf(env), logger, removal });
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    assert.deepEqual(removed, []);
  });

  it('runs: export works without media, and media imports are refused before any change', async () => {
    const { env, Storage } = await start();
    const exported = plain(await Storage.exportAll());
    assert.deepEqual(exported.media, []);
    assert.deepEqual(exported.canvases.map((n) => n.id), ['n1']);

    const before = await dumpDatabase(env.indexedDB);
    const withMedia = {
      version: 1,
      canvases: [note('p1')],
      elements: [],
      media: [{ id: 'pm', canvasId: 'p1', blob: 'data:text/plain;base64,', type: 'text/plain' }],
    };
    await assert.rejects(Storage.importData(withMedia, 'merge'), { code: 'IMPORT_INVALID', message: "this profile's media store is missing" });
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    const result = plain(await Storage.importData({ version: 1, canvases: [note('p2')], elements: [] }, 'merge'));
    assert.equal(result.notes, 1);
  });

  it('a missing auxiliary store does not stop note and block writes', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['search_index', 'links', 'snapshots'] });
    const { Storage } = await startStorage(env);
    const created = await Storage.createNote('Indexed later');
    await Storage.saveNoteWithBlocks(created, [block('nb', created.id, 0, 'body')]);
    await Storage.updateNoteNameInSearchIndex(created.id, 'Renamed');
    await Storage.updateNoteLinks(created.id, ['Kept']);
    assert.deepEqual(plain(await Storage.getSearchIndex()), []);
    assert.deepEqual(plain(await Storage.getBacklinks('n1')), []);
    assert.deepEqual(plain(await Storage.getSnapshots('n1')), []);
    assert.equal((await Storage.getElementsByNote(created.id)).length, 1);
  });
});

describe('startup: version 8 without elements', () => {
  it('refuses with MISSING_CORE_STORES, changes nothing, and saves a recovery copy', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { omit: ['elements'] });
    const before = await dumpDatabase(env.indexedDB);
    const { Storage, error } = await startStorage(env);

    assert.equal(error.code, 'MISSING_CORE_STORES');
    assert.equal(Storage.openState, 'missing-core-stores');
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    const copies = recoveryCopies(env);
    assert.equal(copies.length, 1);
    assert.deepEqual(copies[0][1].missingStores, ['elements']);
    assert.ok(copies[0][1].canvases.length === 2);
    assert.deepEqual(env.chrome.writes().map((w) => w.method), ['set'], 'only the recovery copy; no default settings');
  });

  it('the new tab shows "Your notes database is incomplete" with Export and Reload', async () => {
    const { env, app, appErrors } = await startApp({ omit: ['elements'] });
    const guard = env.document.querySelector('.storage-guard');
    assert.equal(guard.querySelector('h1').textContent, 'Your notes database is incomplete');
    assert.deepEqual(guard.querySelectorAll('button').map((b) => b.textContent), ['Export', 'Reload']);
    assert.ok(app);
    // The app owns the page from here (#27 slice 3)
    assert.deepEqual(appErrors, ['storage-guard']);
  });

  it("the new tab's root puts no App on the page, which the boundary rules can't see in js/kernel/ (#12 slice 7c)", async () => {
    const { env, app } = await startApp({ omit: ['elements'] });
    assert.ok(app, 'it made one, and ran its init');
    assert.equal(Object.hasOwn(env.global, 'app'), false);
    assert.equal(env.global.app, undefined);
  });
});

describe('a database a newer build upgraded, past version 9 (AC7)', () => {
  it('Storage.init refuses with NEWER_SCHEMA and changes nothing', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { version: 10 });
    const before = await dumpDatabase(env.indexedDB);
    const { Storage, error } = await startStorage(env);

    assert.equal(error.code, 'NEWER_SCHEMA');
    assert.equal(error.constructor.name, 'Error', 'a plain Error the service worker can build');
    assert.equal(Storage.openState, 'newer-version');
    assert.equal(Storage.onDiskVersion, 10);
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    assert.deepEqual(env.chrome.writes(), []);
  });

  it('a database a newer build upgrades right after the check is refused the same way', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { version: 10 });
    env.load(...STORAGE_FILES);
    const Storage = env.get('Storage');
    Storage.checkAndRepairDatabase = async () => {}; // as if a newer build upgraded right after the check
    await assert.rejects(Storage.init(), { code: 'NEWER_SCHEMA' });
    assert.equal(Storage.openState, 'newer-version');
    assert.equal(Storage.onDiskVersion, 10);
  });

  it('the new tab shows the guard, and Export downloads every store except settings', async () => {
    const { env, before, downloads, appErrors } = await startApp({ version: 10 });
    assert.deepEqual(appErrors, ['storage-guard']);
    const guard = env.document.querySelector('.storage-guard');
    assert.equal(guard.querySelector('h1').textContent, GUARD_TITLE);
    assert.equal(guard.querySelector('p').textContent, GUARD_BODY);
    const buttons = guard.querySelectorAll('button');
    assert.deepEqual(buttons.map((b) => [b.textContent, b.type]), [['Export', 'button'], ['Reload', 'button']]);
    assert.equal(env.document.activeElement, buttons[0]);

    buttons[0].click();
    await waitFor(() => downloads.length > 0, { message: 'raw export download' });
    const [{ data, filename }] = downloads;
    assert.match(filename, /^newtabnote-raw-v10-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
    const raw = JSON.parse(data);
    assert.equal(raw.rawExport, true);
    assert.equal(raw.onDiskVersion, 10);
    assert.equal(typeof raw.exportedAt, 'number');
    assert.deepEqual(Object.keys(raw.stores).sort(),
      ['canvases', 'elements', 'folders', 'links', 'media', 'meta', 'search_index', 'snapshots', 'themes', 'vectors']);
    assert.deepEqual(raw.stores.meta, [{ key: 'migratedAt', value: 1760000000000 }, { key: 'schemaVersion', value: 9 }],
      'a store without a key path keeps its keys');
    assert.ok(raw.stores.media.find((m) => m.id === 'm1').blob.startsWith('data:image/png;base64,'));
    assert.ok(!data.includes(TEST_KEY));

    buttons[1].click();
    assert.equal(env.global.__reloads, 1);
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    assert.deepEqual(env.chrome.writes(), []);

    // The console names what the guard shows, with the outcome's cause and code, and the kernel
    // logged what Storage threw
    const [[, error]] = logged(env, 'error', 'Failed to initialize app:');
    assert.equal(error.message, GUARD_TITLE);
    assert.deepEqual([error.cause.cause, error.cause.code], ['newer-schema', 'version-too-new']);
    const [[, opened]] = logged(env, 'warn', 'NewTabNote kernel: storage-unavailable');
    assert.deepEqual([opened.cause, opened.code, opened.error.cause.code], ['newer-schema', 'version-too-new', 'NEWER_SCHEMA']);
  });

  it('the popup shows the guard with one Open new tab button and disables quick note', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { version: 10 });
    const before = await dumpDatabase(env.indexedDB);
    const els = env.document.stub([
      { id: 'open-tab', tag: 'button' }, { id: 'quick-note-input', tag: 'input' },
      'main-content', 'daily-summary', 'summary-content', 'page-list',
    ]);
    await loadPageModule(env, 'js/popup.js');
    await Promise.all(env.document.fire('DOMContentLoaded'));

    const guard = els['main-content'].querySelector('.storage-guard');
    assert.equal(guard.querySelector('h2').textContent, GUARD_TITLE);
    assert.equal(guard.querySelector('p').textContent, GUARD_BODY);
    const buttons = guard.querySelectorAll('button');
    assert.deepEqual(buttons.map((b) => b.textContent), ['Open new tab']);
    buttons[0].click();
    assert.deepEqual(env.chrome.tabsCreated, [{ url: 'newtab.html' }]);

    assert.equal(els['quick-note-input'].disabled, true);
    els['quick-note-input'].value = 'a quick note';
    els['quick-note-input'].dispatchEvent({ type: 'keydown', key: 'Enter' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    assert.deepEqual(env.chrome.writes(), []);
  });

  it('the side panel shows the guard with one Open new tab button', async () => {
    const env = createLegacyEnv();
    await fixture(env.indexedDB, { version: 10 });
    const before = await dumpDatabase(env.indexedDB);
    const els = env.document.stub(['open-notes', 'status', 'status-count', 'sections', 'empty-state']);
    const openButton = env.document.createElement('button');
    openButton.setAttribute('data-open-notes', '');
    env.document.body.appendChild(openButton);
    env.load('js/insights-summary.js');
    await loadPageModule(env, 'js/sidepanel.js');
    await Promise.all(env.document.fire('DOMContentLoaded'));

    const guard = els.sections.querySelector('.storage-guard');
    assert.equal(guard.querySelector('h2').textContent, GUARD_TITLE);
    assert.equal(guard.querySelector('p').textContent, GUARD_BODY);
    const buttons = guard.querySelectorAll('button');
    assert.deepEqual(buttons.map((b) => b.textContent), ['Open new tab']);
    buttons[0].click();
    assert.deepEqual(env.chrome.tabsCreated, [{ url: 'chrome-extension://test-extension/newtab.html' }]);
    assert.ok(els['empty-state'].classList.contains('hidden'));
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    assert.deepEqual(env.chrome.writes(), []);
  });

  it('the context menu and keyboard command refuse with a "Not captured" notification', async () => {
    const env = createLegacyEnv({ context: 'worker' });
    await fixture(env.indexedDB, { version: 10 });
    const before = await dumpDatabase(env.indexedDB);
    await startWorker(env);
    const tab = { id: 7, windowId: 1, url: 'https://example.test/page', title: 'Example page' };

    env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, tab);
    env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-selection', selectionText: 'quote' }, tab);
    await env.chrome.api.commands.onCommand.listeners[0]('capture-page');
    await waitFor(() => env.chrome.notifications.length === 3, { message: 'three notifications' });

    for (const notification of env.chrome.notifications) {
      assert.equal(notification.title, 'Not captured');
      assert.match(notification.message, /^Your notes were upgraded by a newer NewTabNote version\./);
    }
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    // The worker's run left it as it was, and recorded that, and wrote nothing else
    assert.deepEqual(writesButUpgradeRecord(env), []);
    assert.equal(env.chrome.local.setting_storageUpgrade.status, 'refused');

    // Each refusal is in the console with its cause and code, and so is the open's
    const refusals = logged(env, 'warn', 'Storage not opened in background:');
    assert.deepEqual(refusals.map(([, outcome]) => [outcome.cause, outcome.code]), [
      ['newer-schema', 'version-too-new'],
      ['newer-schema', 'version-too-new'],
      ['newer-schema', 'version-too-new'],
    ]);
    const [[, opened]] = logged(env, 'warn', 'NewTabNote kernel: storage-unavailable');
    assert.deepEqual([opened.cause, opened.code], ['newer-schema', 'version-too-new']);
  });
});

describe("the new tab when its kernel can't open storage for another reason", () => {
  it('shows the error state saying why in words, with Reload, and writes nothing', async () => {
    for (const [failure, words] of [
      // As when Chrome can't open the database's backing store
      [new DOMException('Internal error opening backing store for indexedDB.open.', 'UnknownError'), "NewTabNote couldn't open your notes."],
      [new DOMException('The quota has been exceeded.', 'QuotaExceededError'), "There's no room left to store your notes."],
    ]) {
      const { env, before, appErrors } = await startApp({}, (page) => {
        page.get('Storage').open = async () => { throw failure; };
      });
      const appEl = env.document.getElementById('app');
      assert.equal(appEl.querySelector('h2').textContent, 'Failed to initialize');
      assert.deepEqual(appErrors, ['error-state']);
      // An outcome carries no error message, so the words are the new tab's own
      assert.equal(appEl.querySelector('p').textContent, words);
      assert.deepEqual(appEl.querySelectorAll('button').map((b) => b.textContent), ['Reload']);
      assert.deepEqual(await dumpDatabase(env.indexedDB), before);
      assert.deepEqual(env.chrome.writes(), []);
      // The console has the words, the outcome's cause and code, and what opening threw
      const [[, error]] = logged(env, 'error', 'Failed to initialize app:');
      assert.equal(error.message, words);
      assert.equal(error.cause.kind, 'unavailable');
      const [[, opened]] = logged(env, 'warn', 'NewTabNote kernel: storage-unavailable');
      assert.deepEqual([opened.cause, opened.code], [error.cause.cause, error.cause.code]);
      assert.equal(opened.error.cause, failure);
    }
  });
});

describe('the export notice in the guard states (NTN-18 slice 0)', () => {
  for (const [label, spec, openState] of [
    ['a database past version 9', { version: 10 }, 'newer-version'],
    ['a version-8 database without elements', { omit: ['elements'] }, 'missing-core-stores'],
  ]) {
    it(`${label}: the new tab shows the guard without deciding on the notice, which isn't due there`, async () => {
      const decided = [];
      const { env, app } = await startApp(spec, (page) => {
        const { prototype } = page.get('ExportNotice');
        const isDue = prototype.isDue;
        prototype.isDue = function recordedIsDue(...args) {
          decided.push(this);
          return isDue.apply(this, args);
        };
      });
      assert.ok(env.document.querySelector('.storage-guard'));
      assert.deepEqual(decided, [], "App.init stops when the tab's kernel can't open storage, before the decision");

      const Storage = env.get('Storage');
      assert.equal(Storage.openState, openState);
      const writes = env.chrome.writes().length;
      // On the ports App has
      const notice = new (env.get('ExportNotice'))({
        storageState: app.storageState,
        settings: app.settings,
        onExport: async () => true,
      });
      assert.equal(await notice.isDue(), false);
      assert.equal(env.chrome.writes().length, writes, 'and records nothing');
      assert.equal(env.chrome.local.setting_preMigrationNotice, undefined);
    });
  }
});

describe('background capture on a version-8 database', () => {
  it('saves to the daily note and notifies', async () => {
    const env = createLegacyEnv({ context: 'worker' });
    await fixture(env.indexedDB);
    await startWorker(env);
    const tab = { id: 7, windowId: 1, url: 'https://example.test/page', title: 'Example page' };
    env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, tab);
    await waitFor(() => env.chrome.notifications.length === 1, { message: 'capture notification' });
    assert.equal(env.chrome.notifications[0].title, 'Captured to New Tab Note');
    const elements = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements'));
    assert.ok(elements.some((e) => e.type === 'bookmark' && e.url === 'https://example.test/page'));
  });

  it('a failed save notifies instead of failing silently', async () => {
    // The worker's kernel is on #17's adapter (#17 PR 1b), over a factory that can fail its writes
    const real = new (require('fake-indexeddb').IDBFactory)();
    const { faultyFactory } = await import('./kernel/storage-faults.mjs');
    const faults = faultyFactory(real);
    const env = createLegacyEnv({ context: 'worker', indexedDB: faults.factory });
    await fixture(real);
    await startWorker(env);
    // The worker opens its database on the first event that needs it (#35), here a browser
    // start, once its run has brought it to 9
    env.chrome.api.runtime.onStartup.listeners[0]();
    assert.equal((await env.global.storageUpgrade).status, 'migrated');
    // The capture's commit fails: first for a full disk, then twice for something else, so its
    // one run again fails too
    faults.abortAfterNextWrite('elements', 'QuotaExceededError');
    for (const count of [1, 2]) {
      if (count === 2) {
        faults.abortAfterNextWrite('elements', 'UnknownError');
        faults.abortAfterNextWrite('elements', 'UnknownError');
      }
      env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-selection', selectionText: 'quote' },
        { url: 'https://example.test/', title: 'x' });
      await waitFor(() => env.chrome.notifications.length === count, { message: `failure notification ${count}` });
    }
    // An outcome carries no error message, so each says why in words of its own
    assert.deepEqual(env.chrome.notifications, [
      { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Not captured', message: "Saving to today's note failed: there is no room left to store it" },
      { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Not captured', message: "Saving to today's note failed: the notes database couldn't store it" },
    ]);
    // and the console has each outcome's cause and code, and none of what was captured
    const failed = logged(env, 'error', 'Failed to capture to daily note:');
    assert.deepEqual(failed.map(([, outcome]) => [outcome.kind, outcome.cause, outcome.code]), [
      ['unavailable', 'quota', 'quota'],
      ['unavailable', 'storage', 'retries-exhausted'],
    ]);
    assert.ok(!JSON.stringify(failed).includes('quote'));
  });

  it('refuses on a database without its blocks store and changes nothing', async () => {
    const env = createLegacyEnv({ context: 'worker' });
    await fixture(env.indexedDB, { omit: ['elements'] });
    const before = await dumpDatabase(env.indexedDB);
    await startWorker(env);
    env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, { url: 'https://example.test/', title: 'x' });
    await waitFor(() => env.chrome.notifications.length === 1, { message: 'refusal notification' });
    assert.deepEqual(env.chrome.notifications[0], {
      type: 'basic', iconUrl: 'icons/icon48.png', title: 'Not captured',
      message: "Your notes database is incomplete, so this version won't change anything. Open a new tab to export a copy.",
    });
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
    // The run gave it a recovery point and no step (Q13), and recorded that
    assert.deepEqual(writesButUpgradeRecord(env), []);
    assert.equal(env.chrome.local.setting_storageUpgrade.status, 'refused');
  });

  it("lets a newer build upgrade the database, and refuses the next capture as it would have at start", async () => {
    const env = createLegacyEnv({ context: 'worker' });
    await fixture(env.indexedDB);
    await startWorker(env);
    const tab = { id: 7, windowId: 1, url: 'https://example.test/page', title: 'Example page' };
    env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, tab);
    await waitFor(() => env.chrome.notifications.length === 1, { message: 'capture notification' });
    // The worker's run brought it to 9. A newer build opens it at 10, which an open connection
    // would block
    const upgraded = await new Promise((resolve, reject) => {
      const request = env.indexedDB.open('CanvasTabDB', 10);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("the worker's connection blocked the upgrade"));
    });
    upgraded.close();
    env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, tab);
    await waitFor(() => env.chrome.notifications.length === 2, { message: 'refusal notification' });
    assert.equal(env.chrome.notifications[1].title, 'Not captured');
    assert.match(env.chrome.notifications[1].message, /^Your notes were upgraded by a newer NewTabNote version\./);
  });
});

/**
 * The database's state App reads, as the new tab's root makes it from the page's Storage
 * @returns {Promise<{openState: string, missingStores: readonly string[]}>}
 */
async function storageStateOf(env) {
  const { createNewTabStorageState } = await loadPageModule(env, 'js/kernel/composition/newtab.js');
  return createNewTabStorageState({ storage: env.get('Storage') });
}

/**
 * Start the new tab against a fixture with a stub #app element, after `beforeInit(env)`, as
 * js/main.js's boot() starts it: its composition root constructs App with the tab's kernel at
 * once, since the stub document isn't loading, and runs App.init, whose promise it answers.
 * `app` is the App it made, caught as init runs, since the root puts none on the page.
 */
async function startApp(spec, beforeInit = () => {}) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await fixture(env.indexedDB, spec);
  const before = await dumpDatabase(env.indexedDB);
  env.document.stub(['app']);
  env.load(...APP_FILES);
  const downloads = [];
  env.get('Utils').downloadFile = (data, filename) => downloads.push({ data, filename });
  env.get('Utils').showToast = () => {};
  let app = null;
  const { prototype } = env.get('App');
  const init = prototype.init;
  prototype.init = function caughtInit(...args) {
    app = this;
    return init.apply(this, args);
  };
  beforeInit(env);
  // Each error state App says it ended in, ntn:app-error's
  const appErrors = [];
  env.window.addEventListener('ntn:app-error', (event) => appErrors.push(event.detail.state));
  const { startNewTab } = await loadPageModule(env, 'js/kernel/composition/newtab.js');
  await startNewTab();
  return { env, app, before, downloads, appErrors };
}
