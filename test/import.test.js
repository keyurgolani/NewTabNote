'use strict';

// AC2, AC3, AC4: import validates before writing, Merge never touches local
// records, Replace all trashes in one transaction after a recovery copy, and
// no open editor can save a trashed note back to active afterwards.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, settle, waitFor, plain, note, block, FakeDocument,
  makeEditor, runUntil, shownTabs, startEditorClient,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/ui/confirm-dialog.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
  'js/controllers/tab-controller.js',
  'js/controllers/settings-controller.js',
];

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A profile with folders, active, empty, daily, archived, template, and trashed notes, and media. */
async function createProfile(factory) {
  await createDatabase(factory, {
    records: {
      folders: [
        { id: 'F1', name: 'Work', parentId: null, createdAt: 1, updatedAt: 1, color: null, collapsed: false },
        { id: 'F2', name: 'Plans', parentId: 'F1', createdAt: 1, updatedAt: 1, color: null, collapsed: false },
      ],
      canvases: [
        note('A', { name: 'Alpha', folderId: 'F2' }),
        note('E', { name: 'Untitled' }), // empty and untitled: trashNote would hard-delete it
        note('D', { name: 'Daily Note - Oct 1, 2026', isDaily: true, dateStr: '2026-10-01' }),
        note('AR', { name: 'Old daily', isDaily: true, dateStr: '2026-09-30', archived: true, archivedAt: 5 }),
        note('T', { name: 'Meeting template', isTemplate: true }),
        note('TR', { name: 'Thrown away', trashed: true, trashedAt: 6 }),
      ],
      elements: [
        block('a1', 'A', 0, 'alpha one'),
        block('a2', 'A', 1, 'alpha two'),
        block('d1', 'D', 0, 'daily'),
        block('ar1', 'AR', 0, 'archived daily'),
        block('t1', 'T', 0, 'template body'),
        block('tr1', 'TR', 0, 'trashed body'),
      ],
      media: [{ id: 'm1', canvasId: 'A', blob: new Blob([PNG_BYTES], { type: 'image/png' }), type: 'image/png', createdAt: 1 }],
    },
  });
}

/** A backup of the profile it will be merged into, shaped like an export with folders. */
function sameProfileBackup() {
  const dataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
  return {
    version: 1,
    exportedAt: 1760000000000,
    canvases: [
      note('A', { name: 'Alpha', folderId: 'F2' }),
      note('E', { name: 'Untitled' }),
      note('D', { name: 'Daily Note - Oct 1, 2026', isDaily: true, dateStr: '2026-10-01' }),
      note('AR', { name: 'Old daily', isDaily: true, dateStr: '2026-09-30', archived: true, archivedAt: 5 }),
      note('T', { name: 'Meeting template', isTemplate: true }),
    ],
    elements: [
      block('a1', 'A', 0, 'alpha one'),
      block('a2', 'A', 1, 'alpha two'),
      block('d1', 'D', 0, 'daily'),
      block('ar1', 'AR', 0, 'archived daily'),
      block('t1', 'T', 0, 'template body'),
    ],
    media: [{ id: 'm1', canvasId: 'A', blob: dataUrl, type: 'image/png', createdAt: 1 }],
    folders: [
      { id: 'F1', name: 'Work', parentId: null, createdAt: 1, updatedAt: 1, color: null, collapsed: false },
      { id: 'F2', name: 'Plans', parentId: 'F1', createdAt: 1, updatedAt: 1, color: null, collapsed: false },
    ],
  };
}

/** What 1.4.0's exportAll wrote: active notes only, the whole media store, no folders. */
function backup140() {
  return {
    version: 1,
    exportedAt: 1750000000000,
    canvases: [note('X1', { name: 'From 1.4.0' }), note('X2', { name: 'Second' })],
    elements: [block('x1', 'X1', 0, 'one'), block('x2', 'X2', 0, 'two')],
    media: [
      { id: 'mx', canvasId: 'X1', blob: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}`, type: 'text/plain' },
      { id: 'mo', canvasId: 'GONE', blob: 'data:text/plain;base64,', type: 'text/plain' }, // orphan media row
    ],
  };
}

async function setup() {
  const env = createLegacyEnv();
  await createProfile(env.indexedDB);
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => { toasts.push({ message, kind }); };
  return { env, Storage, toasts };
}

/** Snapshot of IndexedDB and chrome.storage.local. */
async function snapshot(env) {
  return { db: await dumpDatabase(env.indexedDB), local: JSON.parse(JSON.stringify(env.chrome.local)) };
}

function makeController(env, Storage) {
  const SettingsController = env.get('SettingsController');
  return new SettingsController({ storage: Storage, eventBus: null, domRefs: null, logger: null });
}

const fileOf = (data) => new Blob([typeof data === 'string' ? data : JSON.stringify(data)], { type: 'application/json' });
const overlay = (env, title) => env.document.querySelectorAll('.confirm-dialog-overlay')
  .find((o) => !title || o.getAttribute('aria-label') === title) || null;
const waitForDialog = (env, title) => waitFor(() => overlay(env, title), { message: `dialog ${title}` });
const press = (el, key) => el.dispatchEvent({ type: 'keydown', key });
const choose = (dialog, id) => dialog.querySelector(`[data-choice="${id}"]`).click();
const confirmButton = (dialog) => dialog.querySelector('.confirm-dialog-confirm');
const cancelButton = (dialog) => dialog.querySelector('.confirm-dialog-cancel');

describe('Storage.validateImport', () => {
  let Storage;

  beforeEach(async () => {
    ({ Storage } = await setup());
  });

  it('accepts a 1.4.0 export and counts the orphan media row as skipped', () => {
    assert.deepEqual(plain(Storage.validateImport(backup140())), {
      ok: true,
      counts: { notes: 2, blocks: 2, folders: 0, media: 1, skippedMedia: 1 },
    });
  });

  const refusals = [
    ['not an object', [], "the file isn't a NewTabNote backup"],
    ['no canvases', { version: 1 }, "the file isn't a NewTabNote backup"],
    ['an unknown version', { version: 2, canvases: [], elements: [] }, "backup version 2 isn't supported"],
    ['no elements', { version: 1, canvases: [note('N')] }, 'it has no list of blocks'],
    ['media that is not a list', { version: 1, canvases: [], elements: [], media: {} }, "its media isn't a list"],
    ['a numeric ID', { version: 1, canvases: [{ ...note('N'), id: 42 }], elements: [] }, 'note 1 has no text ID'],
    ['a record that is not an object', { version: 1, canvases: [note('N')], elements: ['x'] }, "block 1 isn't a record"],
    ['duplicate note IDs', { version: 1, canvases: [note('N'), note('N')], elements: [] }, 'two notes share the ID "N"'],
    ['an orphan element', { version: 1, canvases: [note('N')], elements: [block('b', 'MISSING', 0)] },
      'block "b" belongs to a note that isn\'t in the file'],
  ];
  for (const [label, data, reason] of refusals) {
    it(`refuses ${label}`, () => {
      assert.deepEqual(plain(Storage.validateImport(data)), { ok: false, reason });
    });
  }
});

describe('Import dialogs and refused packages (AC2)', () => {
  let env;
  let Storage;
  let toasts;
  let controller;

  beforeEach(async () => {
    ({ env, Storage, toasts } = await setup());
    controller = makeController(env, Storage);
  });

  for (const [how, dismiss] of [
    ['Escape', (dialog) => press(dialog, 'Escape')],
    ['a backdrop click', (dialog) => dialog.dispatchEvent({ type: 'mousedown', target: dialog })],
    ['Cancel', (dialog) => choose(dialog, 'cancel')],
  ]) {
    it(`dismissing "Import backup" with ${how} changes nothing`, async () => {
      const before = await snapshot(env);
      const data = sameProfileBackup();
      const done = controller.importFromFile(fileOf(data));
      const dialog = await waitForDialog(env, 'Import backup');
      assert.match(dialog.textContent, /5 notes, 5 blocks, and 2 folders/);
      assert.equal(env.document.activeElement.textContent, 'Merge', 'focus starts on Merge');
      dismiss(dialog);
      await done;
      assert.deepEqual(await snapshot(env), before);
      assert.equal(toasts.length, 0);
    });

    it(`dismissing the Replace all confirmation with ${how} changes nothing`, async () => {
      const before = await snapshot(env);
      const done = controller.importFromFile(fileOf(sameProfileBackup()));
      choose(await waitForDialog(env, 'Import backup'), 'replace');
      const confirm = await waitForDialog(env, 'Replace all notes?');
      assert.equal(env.document.activeElement.textContent, 'Cancel', 'focus starts on Cancel');
      if (how === 'Cancel') cancelButton(confirm).click(); else dismiss(confirm);
      await done;
      assert.deepEqual(await snapshot(env), before);
    });
  }

  it('the Replace all confirmation states what moves to trash and for how long', async () => {
    await Storage.setSetting('trashRetention', 14);
    const done = controller.importFromFile(fileOf(sameProfileBackup()));
    choose(await waitForDialog(env, 'Import backup'), 'replace');
    const confirm = await waitForDialog(env, 'Replace all notes?');
    assert.equal(confirm.querySelector('.confirm-dialog-message').textContent,
      '3 active notes move to trash, where they stay for 14 days. Archived notes, templates, and folders stay. '
      + 'A recovery copy is saved first.');
    assert.ok(confirmButton(confirm).classList.contains('confirm-dialog-danger'));
    press(confirm, 'Escape');
    await done;
  });

  it('a retention of 0 reads "until you empty trash"', async () => {
    await Storage.setSetting('trashRetention', 0);
    const done = controller.importFromFile(fileOf(sameProfileBackup()));
    choose(await waitForDialog(env, 'Import backup'), 'replace');
    const confirm = await waitForDialog(env, 'Replace all notes?');
    assert.match(confirm.textContent, /where they stay until you empty trash\./);
    press(confirm, 'Escape');
    await done;
  });

  const refused = [
    ['invalid JSON', '{"version": 1, "canv', "the file isn't valid JSON"],
    ['a package without elements', { version: 1, canvases: [note('N')] }, 'it has no list of blocks'],
    ['a numeric ID', { version: 1, canvases: [{ ...note('N'), id: 7 }], elements: [] }, 'note 1 has no text ID'],
    ['an orphan element', { version: 1, canvases: [note('N')], elements: [block('b', 'nope', 0)] },
      'block "b" belongs to a note that isn\'t in the file'],
  ];
  for (const [label, data, reason] of refused) {
    it(`refuses ${label} before any dialog and changes nothing`, async () => {
      const before = await snapshot(env);
      await controller.importFromFile(fileOf(data));
      assert.equal(overlay(env), null, 'no dialog opened');
      assert.deepEqual(toasts, [{ message: `Import failed before any change: ${reason}`, kind: 'error' }]);
      assert.deepEqual(await snapshot(env), before);
    });
  }

  it('never mutates the parsed input', async () => {
    const data = sameProfileBackup();
    const copy = structuredClone(data);
    await Storage.importData(data, 'merge');
    await Storage.importData(data, 'replace');
    assert.deepEqual(data, copy);
  });
});

describe('Merge (AC3)', () => {
  let env;
  let Storage;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
  });

  it('merging a backup into its own profile leaves every local record identical and adds copies', async () => {
    const before = await dumpDatabase(env.indexedDB);
    const result = await Storage.importData(sameProfileBackup(), 'merge');
    const after = await dumpDatabase(env.indexedDB);

    for (const store of ['canvases', 'elements', 'media', 'folders']) {
      const old = recordsOf(before, store);
      const now = recordsOf(after, store);
      for (const [id, value] of Object.entries(old)) {
        assert.deepEqual(now[id], value, `${store} ${id} unchanged`);
      }
    }
    assert.deepEqual(recordsOf(after, 'folders'), recordsOf(before, 'folders'), 'existing folders reused, none added');
    assert.equal(result.reusedFolders, 2);
    assert.equal(result.folders, 0);

    const oldNotes = recordsOf(before, 'canvases');
    const added = Object.values(recordsOf(after, 'canvases')).filter((n) => !oldNotes[n.id]);
    assert.equal(added.length, 5);
    assert.ok(added.every((n) => !['A', 'E', 'D', 'AR', 'T'].includes(n.id)), 'new note IDs');
    const alphaCopy = added.find((n) => n.name === 'Alpha');
    assert.equal(alphaCopy.folderId, 'F2', 'filed into the existing folder');

    const oldElements = recordsOf(before, 'elements');
    const newElements = Object.values(recordsOf(after, 'elements')).filter((e) => !oldElements[e.id]);
    assert.equal(newElements.length, 5);
    assert.deepEqual(newElements.filter((e) => e.canvasId === alphaCopy.id).map((e) => e.content).sort(),
      ['alpha one', 'alpha two']);

    const newMedia = Object.values(recordsOf(after, 'media')).filter((m) => m.id !== 'm1');
    assert.equal(newMedia.length, 1);
    assert.equal(newMedia[0].canvasId, alphaCopy.id);
    assert.deepEqual(newMedia[0].blob, { __blob: PNG_BYTES.toString('base64'), type: 'image/png' }, 'data URL stored as a Blob');
  });

  it('archived and template flags carry over, and a daily note for a kept date becomes "(imported)"', async () => {
    await Storage.importData(sameProfileBackup(), 'merge');
    const notes = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases'));
    const copies = notes.filter((n) => !['A', 'E', 'D', 'AR', 'T', 'TR'].includes(n.id));
    const byName = Object.fromEntries(copies.map((n) => [n.name, n]));
    assert.equal(byName['Old daily (imported)'].archived, true);
    assert.equal(byName['Old daily (imported)'].isDaily, false);
    assert.equal(byName['Daily Note - Oct 1, 2026 (imported)'].dateStr, null);
    assert.equal(byName['Meeting template'].isTemplate, true);
    const dailyFor = (date) => notes.filter((n) => n.isDaily && n.dateStr === date).map((n) => n.id);
    assert.deepEqual(dailyFor('2026-10-01'), ['D'], 'one daily note per date');
  });

  it('a package folder that collides reuses the local one; dangling folder and parent IDs become null', async () => {
    const data = {
      version: 1,
      canvases: [note('P1', { folderId: 'F1' }), note('P2', { folderId: 'NOWHERE' }), note('P3', { folderId: 'NEW' })],
      elements: [],
      folders: [
        { id: 'F1', name: 'Renamed in the backup', parentId: null },
        { id: 'NEW', name: 'New folder', parentId: 'ALSO-NOWHERE' },
      ],
    };
    await Storage.importData(data, 'merge');
    const dump = await dumpDatabase(env.indexedDB);
    const folders = recordsOf(dump, 'folders');
    assert.equal(folders.F1.name, 'Work', 'local folder untouched');
    assert.equal(folders.NEW.name, 'New folder', 'non-colliding folder keeps its ID');
    assert.equal(folders.NEW.parentId, null);
    const byName = Object.fromEntries(Object.values(recordsOf(dump, 'canvases')).map((n) => [n.name, n]));
    assert.equal(byName['Note P1'].folderId, 'F1');
    assert.equal(byName['Note P2'].folderId, null);
    assert.equal(byName['Note P3'].folderId, 'NEW');
  });

  it('imports a 1.4.0 export and skips its orphan media row', async () => {
    const result = await Storage.importData(backup140(), 'merge');
    assert.equal(result.notes, 2);
    assert.equal(result.media, 1);
    assert.equal(result.skippedMedia, 1);
  });

  it('the success toast counts what was imported and the orphan media skipped', async () => {
    const { env: e, Storage: s, toasts } = await setup();
    const controller = makeController(e, s);
    const done = controller.importFromFile(fileOf(backup140()));
    choose(await waitForDialog(e, 'Import backup'), 'merge');
    await done;
    assert.deepEqual(toasts, [{
      message: 'Imported 2 notes, 2 blocks, and 1 media file. Skipped 1 media file that belonged to no note in the backup.',
      kind: 'success',
    }]);
  });
});

describe('Replace all (AC4)', () => {
  let env;
  let Storage;
  let toasts;

  beforeEach(async () => {
    ({ env, Storage, toasts } = await setup());
  });

  it('writes a recovery copy first, then trashes active notes in the same transaction as the import', async () => {
    const opened = [];
    const db = Storage.db;
    const original = db.transaction.bind(db);
    db.transaction = (stores, mode) => {
      if (mode === 'readwrite') opened.push([].concat(stores).sort().join(','));
      return original(stores, mode);
    };
    const keysBefore = Object.keys(env.chrome.local);

    const result = await Storage.importData(sameProfileBackup(), 'replace');

    const recoveryKeys = Object.keys(env.chrome.local).filter((k) => !keysBefore.includes(k));
    assert.equal(recoveryKeys.length, 1);
    assert.match(recoveryKeys[0], /^recovery_backup_\d+$/);
    const copy = env.chrome.local[recoveryKeys[0]];
    assert.equal(copy.recoveryBackup, true);
    assert.equal(copy.reason, 'pre-import-replace');
    assert.equal(typeof copy.timestamp, 'number');
    assert.equal(copy.version, 1);
    assert.ok(copy.canvases.some((n) => n.id === 'A'), 'the copy holds the notes being replaced');

    assert.deepEqual(opened, ['canvases,elements,folders,media'], 'one readwrite transaction');
    assert.deepEqual(plain(result.trashedIds).sort(), ['A', 'D', 'E']);

    const notes = recordsOf(await dumpDatabase(env.indexedDB), 'canvases');
    for (const id of ['A', 'D', 'E']) {
      assert.equal(notes[id].trashed, true, `${id} trashed`);
      assert.equal(notes[id].archived, false);
      assert.equal(notes[id].archivedAt, null);
      assert.equal(notes[id].trashedAt, result.trashedAt);
    }
    assert.ok(notes.E, 'the empty untitled note moved to trash instead of being deleted');
    assert.equal(notes.AR.trashed, undefined, 'archived notes stay');
    assert.equal(notes.T.trashed, undefined, 'templates stay');
    assert.equal(notes.TR.trashedAt, 6, 'already-trashed notes untouched');
    const names = Object.values(notes).filter((n) => !n.trashed).map((n) => n.name).sort();
    assert.ok(names.includes('Daily Note - Oct 1, 2026'), 'the daily note date is free again after the replace');
    assert.ok(names.includes('Old daily (imported)'), 'the archived daily note keeps its date');
  });

  it('a failed recovery write stops the import with IndexedDB unchanged', async () => {
    const controller = makeController(env, Storage);
    const before = await dumpDatabase(env.indexedDB);
    env.chrome.failNextSet(new Error('QUOTA_BYTES quota exceeded'));
    const done = controller.importFromFile(fileOf(sameProfileBackup()));
    choose(await waitForDialog(env, 'Import backup'), 'replace');
    confirmButton(await waitForDialog(env, 'Replace all notes?')).click();
    await done;

    assert.deepEqual(toasts, [{ message: "Import failed before any change: couldn't save a recovery copy", kind: 'error' }]);
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
  });

  it('an aborted commit leaves IndexedDB unchanged', async () => {
    const before = await dumpDatabase(env.indexedDB);
    const Utils = env.get('Utils');
    const realId = Utils.generateId;
    let calls = 0;
    // The sixth new ID collides with an existing block, so an add() fails inside the commit.
    Utils.generateId = () => (++calls === 6 ? 'a1' : realId());
    await assert.rejects(Storage.importData(sameProfileBackup(), 'replace'), { name: 'ConstraintError' });
    Utils.generateId = realId;
    assert.deepEqual(await dumpDatabase(env.indexedDB), before);
  });

  it('after Replace all no pane stays on a trashed note, and none can save one back to active', async () => {
    const { tabs, editors, pip } = await openEditors(env, Storage);
    const controller = wireImport(makeController(env, Storage), tabs);

    typeInto(editors.primary, 'typed before import');
    await replaceAll(env, controller, sameProfileBackup());

    assert.equal(pip.closed, true, 'PiP on a trashed note closed');
    const shown = await Storage.getNote(editors.primary.noteId);
    assert.ok(shown && !shown.trashed, 'the left pane moved to an active note');
    assert.deepEqual(plain(tabs.openTabs.map((tab) => tab.noteId)), [shown.id], 'in a tab');
    assert.equal(editors.secondary.noteId, null, 'the hidden right pane lets go of its trashed note');

    typeInto(editors.primary, 'typed after import');
    env.clock.tick(500);
    await runUntil(env, Promise.all([editors.primary.flushSave(), editors.secondary.flushSave()]));

    const db = await dumpDatabase(env.indexedDB);
    const notes = recordsOf(db, 'canvases');
    for (const id of ['A', 'D', 'E']) assert.equal(notes[id].trashed, true, `${id} stays in trash`);
    const elements = Object.values(recordsOf(db, 'elements'));
    assert.ok(elements.some((el) => el.id === 'a1' && el.content === 'typed before import'), 'the edit from before the import stayed with A');
    assert.ok(elements.some((el) => el.canvasId === shown.id && el.content === 'typed after import'), 'later typing went to the note on screen');
  });

  it('with the right pane active, both panes leave the trashed notes, never for the same note', async () => {
    const { tabs, editors } = await openEditors(env, Storage);
    tabs._setSplitView(true);
    tabs.setActiveEditorSide('right');
    tabs.openTabs.push({ noteId: 'D', name: 'Daily' });
    const controller = wireImport(makeController(env, Storage), tabs);

    await replaceAll(env, controller, sameProfileBackup());

    for (const editor of [editors.primary, editors.secondary]) {
      const shown = await Storage.getNote(editor.noteId);
      assert.ok(shown && !shown.trashed, `${shown ? shown.name : 'nothing'} is active`);
    }
    assert.notEqual(editors.primary.noteId, editors.secondary.noteId);
    assert.equal(tabs.openTabs[tabs.activeTabIndex].noteId, tabs.getEditor().noteId, "the active tab is the active pane's note");
  });

  it('with the active pane on a note it keeps, Replace all leaves that pane alone and gives it the active tab', async () => {
    const { tabs, editors } = await openEditors(env, Storage);
    await runUntil(env, editors.primary.loadNote('AR')); // archived: Replace all keeps it
    tabs._setSplitView(true);
    tabs.openTabs.push({ noteId: 'D', name: 'Daily' }); // the right pane's note, which Replace all trashes
    const controller = wireImport(makeController(env, Storage), tabs);

    await replaceAll(env, controller, sameProfileBackup());

    assert.equal(editors.primary.noteId, 'AR', 'the left pane keeps its note');
    const right = await Storage.getNote(editors.secondary.noteId);
    assert.ok(right && !right.trashed && !right.archived, 'the right pane moved to an active note');
    assert.notEqual(editors.secondary.noteId, editors.primary.noteId);
    assert.equal(tabs.openTabs[tabs.activeTabIndex].noteId, 'AR', "the active tab is the left pane's note");
  });

  for (const [label, backup] of [
    ['no notes', { version: 1, exportedAt: 1, canvases: [], elements: [] }],
    ['only archived notes', {
      version: 1,
      exportedAt: 1,
      canvases: [note('X', { name: 'Kept in the archive', archived: true, archivedAt: 1 })],
      elements: [block('x1', 'X', 0, 'archived body')],
    }],
  ]) {
    it(`Replace all with a backup of ${label} opens a new note and closes split view`, async () => {
      const { tabs, editors } = await openEditors(env, Storage);
      tabs._setSplitView(true);
      tabs.openTabs.push({ noteId: 'A', name: 'Alpha' });
      const controller = wireImport(makeController(env, Storage), tabs);

      await replaceAll(env, controller, backup);

      const active = plain(await Storage.getAllNotes());
      assert.deepEqual(active.map((n) => n.name), ['Untitled'], 'the one active note is a new one');
      assert.equal(editors.primary.noteId, active[0].id);
      assert.deepEqual(plain(tabs.openTabs.map((tab) => tab.noteId)), [active[0].id]);
      assert.equal(tabs.splitViewEnabled, false, 'no right pane without a second note');
      assert.equal(env.chrome.local.setting_splitViewEnabled, false);
    });
  }

  it("drops the notes it trashed from the tabs, keeps the archived note's tab, and moves the active pane to an active note", async () => {
    const { tabs, editors } = await openEditors(env, Storage);
    tabs._setSplitView(true);
    tabs.openTabs.push({ noteId: 'A', name: 'Alpha' }, { noteId: 'AR', name: 'Old daily' }, { noteId: 'E', name: 'Untitled' });
    tabs.activeTabIndex = 2;
    await tabs.saveTabs();
    tabs.cacheLastOpenedNoteId('E');
    const controller = makeController(env, Storage);
    controller.onFlushEditors = () => tabs.flushEditorsForImport();
    controller.onReloadEditors = (ids, at) => tabs.reloadEditorsAfterImport(ids, at);

    await replaceAll(env, controller, sameProfileBackup());

    // Not the archived note's tab next to it: a pane moves only onto a note in use
    const left = await Storage.getNote(editors.primary.noteId);
    assert.ok(left && !left.trashed && !left.archived, 'the active pane went to an active note');
    const kept = [{ noteId: 'AR', name: 'Old daily' }, { noteId: left.id, name: left.name }];
    assert.deepEqual(plain(tabs.openTabs), kept, 'the archived note keeps its tab');
    assert.equal(tabs.activeTabIndex, 1);
    assert.deepEqual(shownTabs(env), ['Old daily', left.name]);
    const right = await Storage.getNote(editors.secondary.noteId);
    assert.ok(right && !right.trashed && !right.archived && right.id !== left.id, 'the right pane went to another active note');

    const local = env.chrome.local;
    assert.deepEqual(local.setting_openTabs, kept);
    assert.equal(local.setting_activeTabIndex, 1);
    assert.equal(local.setting_secondaryNoteId, right.id);
    assert.equal(local.lastOpenedNoteId, left.id);
  });

  it('opens the first note in a tab, and a reload opens no note in trash', async () => {
    const { tabs, editors } = await openEditors(env, Storage);
    tabs._setSplitView(true);
    tabs.openTabs.push({ noteId: 'A', name: 'Alpha' }, { noteId: 'E', name: 'Untitled' });
    await tabs.saveTabs();
    tabs.cacheLastOpenedNoteId('A');
    const controller = wireImport(makeController(env, Storage), tabs);

    await replaceAll(env, controller, sameProfileBackup());

    const [first] = plain(await Storage.getAllNotes());
    assert.deepEqual(plain(tabs.openTabs.map((tab) => tab.noteId)), [first.id], 'the first note after the import has the only tab');
    assert.equal(editors.primary.noteId, first.id);
    assert.equal(env.chrome.local.lastOpenedNoteId, first.id);
    const right = await Storage.getNote(env.chrome.local.setting_secondaryNoteId);
    assert.ok(right && !right.trashed && right.id !== first.id, 'the saved split note is another active note');

    // Reload: a new page on the same profile restores the saved workspace
    const page = createLegacyEnv({ indexedDB: env.indexedDB, chrome: env.chrome });
    page.load(...FILES);
    const reloaded = page.get('Storage');
    await reloaded.init();
    await startEditorClient(page);
    page.document.stub(['note-tabs', 'workspace-container', 'editor-container', 'secondary-editor-container', 'split-view-toggle']);
    const restored = new (page.get('TabController'))({ storage: reloaded, eventBus: null, domRefs: null, logger: null });
    restored.editor = makeEditor(page, page.document);
    restored.secondaryEditor = makeEditor(page, page.document);
    const activeNotes = await reloaded.getAllNotes();
    restored.onGetNotes = () => activeNotes;
    await restored.loadSavedTabs();

    assert.equal(restored.editor.noteId, first.id);
    assert.equal(restored.splitViewEnabled, true);
    for (const editor of [restored.editor, restored.secondaryEditor]) {
      assert.ok(editor.noteData, 'each pane has a note');
      assert.notEqual(editor.noteData.trashed, true, `${editor.noteData.name} is not in trash`);
    }
  });

  it('a page-hide write queued behind the commit cannot move a trashed note back to active', async () => {
    const { tabs, editors } = await openEditors(env, Storage);
    const controller = makeController(env, Storage);
    controller.onFlushEditors = () => tabs.flushEditorsForImport();
    controller.onReloadEditors = (ids, at) => tabs.reloadEditorsAfterImport(ids, at);

    // Right after the commit's transaction opens, the user types and the tab is hidden.
    const realTransaction = Storage.transaction.bind(Storage);
    let hidden = false;
    Storage.transaction = (stores, mode) => {
      const tx = realTransaction(stores, mode);
      if (!hidden && mode === 'readwrite' && [].concat(stores).includes('folders')) {
        hidden = true;
        typeInto(editors.primary, 'typed while the import commits');
        env.clock.tick(500); // comes due while saves are held
        env.document.visibilityState = 'hidden';
        env.document.fire('visibilitychange');
      }
      return tx;
    };
    await replaceAll(env, controller, sameProfileBackup());
    Storage.transaction = realTransaction;
    assert.equal(hidden, true, 'the page hid during the commit');

    const db = await dumpDatabase(env.indexedDB);
    const notes = recordsOf(db, 'canvases');
    assert.equal(notes.A.trashed, true, 'A stays in trash');
    assert.equal(notes.A.archived, false);
    assert.equal(recordsOf(db, 'elements').a1.content, 'typed while the import commits', 'the edit is kept');
    assert.notEqual(editors.primary.noteId, 'A', 'the pane moved off A');
  });

  it('a chrome.storage write that fails after the commit still reports the import, opens the note, and refreshes', async () => {
    const { tabs, editors } = await openEditors(env, Storage);
    const controller = wireImport(makeController(env, Storage), tabs);
    let refreshes = 0;
    controller.onRefreshNotesList = async () => { refreshes += 1; };
    // The commit lands, then the next chrome.storage.local write (the open tabs) fails
    const realImport = Storage.importData.bind(Storage);
    Storage.importData = async (...args) => {
      const result = await realImport(...args);
      env.chrome.failNextSet(new Error('QUOTA_BYTES quota exceeded'));
      return result;
    };

    await replaceAll(env, controller, sameProfileBackup());

    assert.ok(toasts.some((t) => t.kind === 'success' && t.message.startsWith('Imported 5 notes')), 'the import is reported');
    assert.deepEqual(toasts.filter((t) => t.kind === 'error'), [
      { message: "Your notes were imported, but this page didn't finish updating. Reload it to see them.", kind: 'error' },
    ]);
    const shown = await Storage.getNote(editors.primary.noteId);
    assert.ok(shown && !shown.trashed, 'a note from the import is open');
    assert.equal(tabs.openTabs[tabs.activeTabIndex].noteId, shown.id);
    assert.equal(refreshes, 1, 'the notes list refreshed');
  });

  it('a failed post-commit step in this page still tells the other new tabs', async () => {
    const { tabs } = await openEditors(env, Storage);
    const channel = { sent: [], postMessage(data) { this.sent.push(plain(data)); } };
    tabs.channel = channel;
    const controller = wireImport(makeController(env, Storage), tabs);
    const realImport = Storage.importData.bind(Storage);
    Storage.importData = async (...args) => {
      const result = await realImport(...args);
      env.chrome.failNextSet(new Error('QUOTA_BYTES quota exceeded'));
      return result;
    };

    await replaceAll(env, controller, sameProfileBackup());

    assert.equal(channel.sent.length, 1);
    assert.deepEqual(channel.sent[0].left.slice().sort(), ['A', 'D', 'E']);
  });
});

describe('Merge and the tab bar', () => {
  it('Merge opens the first note in a tab, so the tab bar and the editor agree', async () => {
    const { env, Storage } = await setup();
    const { tabs, editors } = await openEditors(env, Storage);
    tabs.openTabs.push({ noteId: 'A', name: 'Alpha' });
    const controller = wireImport(makeController(env, Storage), tabs);
    const newer = {
      version: 1,
      exportedAt: 1,
      canvases: [note('N', { name: 'Newer note', updatedAt: 4102444800000 })],
      elements: [block('n1', 'N', 0, 'newer body')],
    };

    const done = controller.importFromFile(fileOf(newer));
    choose(await waitForDialog(env, 'Import backup'), 'merge');
    await runUntil(env, done);

    const [first] = plain(await Storage.getAllNotes());
    assert.equal(first.name, 'Newer note');
    assert.equal(editors.primary.noteId, first.id);
    assert.equal(tabs.openTabs[tabs.activeTabIndex].noteId, first.id, 'the active tab is the note on screen');
    assert.deepEqual(shownTabs(env), ['Alpha', 'Newer note']);
  });

  it("Merge with split view opens the first note it imported, not the newest note, which the other pane shows", async () => {
    const { env, Storage } = await setup();
    const { tabs, editors } = await openEditors(env, Storage);
    tabs._setSplitView(true);
    tabs.openTabs.push({ noteId: 'A', name: 'Alpha' });
    // The right pane's note is the newest one, saved after the PiP's; Merge keeps the backup's older dates
    await runUntil(env, tabs.pipEditor.flushSave());
    // updatedAt is the wall clock's millisecond, and two saves can share one: the right pane saves in a later one
    const pipSavedAt = (await Storage.getNote('E')).updatedAt;
    while (Date.now() <= pipSavedAt) await new Promise((resolve) => setTimeout(resolve, 1));
    typeInto(editors.secondary, 'daily, edited just now');
    env.clock.tick(500);
    await runUntil(env, editors.secondary.flushSave());
    assert.equal(plain(await Storage.getAllNotes())[0].id, 'D');
    const controller = wireImport(makeController(env, Storage), tabs);

    const done = controller.importFromFile(fileOf(backup140()));
    choose(await waitForDialog(env, 'Import backup'), 'merge');
    await runUntil(env, done);

    assert.notEqual(editors.primary.noteId, editors.secondary.noteId, 'never one note in both panes');
    const shown = await Storage.getNote(editors.primary.noteId);
    assert.equal(shown.name, 'From 1.4.0', 'the first note in the backup');
    assert.equal(editors.secondary.noteId, 'D', 'the right pane keeps its note');
    assert.equal(tabs.openTabs[tabs.activeTabIndex].noteId, shown.id);
  });

  it("Merge doesn't load a note over a pane's unsaved text from a deleted note", async () => {
    const { env, Storage } = await setup();
    const { tabs, editors } = await openEditors(env, Storage);
    tabs.openTabs.push({ noteId: 'A', name: 'Alpha' });
    typeInto(editors.primary, 'typed into Alpha');
    await Storage.permanentlyDeleteNote('A'); // another tab
    await runUntil(env, editors.primary.flushSave());
    assert.equal(editors.primary.noteGone, true);
    const controller = wireImport(makeController(env, Storage), tabs);

    const done = controller.importFromFile(fileOf(backup140()));
    choose(await waitForDialog(env, 'Import backup'), 'merge');
    await runUntil(env, done);

    assert.equal(editors.primary.noteId, 'A');
    assert.equal(editors.primary.blocks[0].content, 'typed into Alpha');
    assert.ok(editors.primary.root.querySelector('.note-gone-notice'));
  });
});

describe('The import file input', () => {
  it('clears after an import, and after one that throws, so the same file can be picked again', async () => {
    const { env, Storage } = await setup();
    const controller = makeController(env, Storage);
    env.document.stub(['settings-modal', 'settings-btn', 'import-btn', { id: 'import-input', tag: 'input' }]);
    controller.setupSettings();
    const input = env.document.getElementById('import-input');
    const [onChange] = input.listeners.change;
    const pick = (file) => {
      input.files = [file];
      input.value = 'C:\\fakepath\\backup.json';
      return onChange.call(input, { type: 'change', target: input });
    };

    const merged = pick(fileOf(backup140()));
    choose(await waitForDialog(env, 'Import backup'), 'merge');
    await merged;
    assert.equal(input.value, '');

    controller.importFromFile = async () => { throw new Error('the profile went away'); };
    await assert.rejects(pick(fileOf(backup140())), /the profile went away/);
    assert.equal(input.value, '');
  });
});

// ─── Editors for the AC4 test ───

function typeInto(editor, text) {
  editor.blocks[0].content = text;
  editor.scheduleSave();
}

/** Wire an import the way App does: hold and flush the editors, then move panes and open what Merge added. */
function wireImport(controller, tabs) {
  controller.getEditor = () => tabs.getEditor();
  controller.onFlushEditors = () => tabs.flushEditorsForImport();
  controller.onReloadEditors = (ids, at) => tabs.reloadEditorsAfterImport(ids, at);
  controller.onOpenImportedNote = (noteId) => tabs.openImportedNote(noteId);
  return controller;
}

/** Import `data` with Replace all, through both dialogs. */
async function replaceAll(env, controller, data) {
  const done = controller.importFromFile(fileOf(data));
  choose(await waitForDialog(env, 'Import backup'), 'replace');
  confirmButton(await waitForDialog(env, 'Replace all notes?')).click();
  await runUntil(env, done);
}

async function openEditors(env, Storage) {
  if (!env.documentClient) await startEditorClient(env);
  const panes = env.document.stub(['note-tabs', 'workspace-container', 'editor-container', 'secondary-editor-container', 'split-view-toggle']);
  panes['editor-container'].className = 'editor-pane active';
  panes['secondary-editor-container'].className = 'editor-pane secondary hidden';
  const TabController = env.get('TabController');
  const tabs = new TabController({ storage: Storage, eventBus: null, domRefs: null, logger: null });
  tabs.onCreateNote = () => Storage.createNote('Untitled');
  const primary = makeEditor(env, env.document, { root: panes['editor-container'] });
  const secondary = makeEditor(env, env.document, { root: panes['secondary-editor-container'] });
  const pipDoc = new FakeDocument();
  const pipTarget = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    // The PiP window's frames run whenever the new tab's do in these tests (runUntil).
    requestAnimationFrame: (fn) => env.global.requestAnimationFrame(fn),
  };
  pipDoc.defaultView = pipTarget;
  const pipEditor = makeEditor(env, pipDoc);
  const pip = { closed: false };
  tabs.editor = primary;
  tabs.secondaryEditor = secondary;
  tabs.pipEditor = pipEditor;
  tabs.pipWindow = {
    close() {
      pip.closed = true;
      (pipTarget.listeners.pagehide || []).forEach((fn) => fn({ type: 'pagehide' }));
      tabs.pipWindow = null;
      tabs.pipEditor = null;
    },
  };
  await primary.loadNote('A');
  await secondary.loadNote('D');
  await pipEditor.loadNote('E');
  // Give the empty note a block so the PiP editor has something to save.
  pipEditor.blocks.push(pipEditor.createBlock('text', 'pip text'));
  pipEditor.scheduleSave();
  return { tabs, editors: { primary, secondary }, pip };
}
