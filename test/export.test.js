'use strict';

// AC5: an export from a profile with archived notes, templates, and folders,
// imported with Replace all into an empty profile, reproduces all of them with
// folder placement intact. The Data & Backup hint lists what's excluded. Each export and import
// runs as the page runs it since #17 PR 4a, on #17's adapter (backups.js) through the page's
// settings port.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, plain, note, block, startNewTabKernel,
} = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js'];
const IMAGE = Buffer.from('fake image bytes');

async function sourceProfile() {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      folders: [
        { id: 'F1', name: 'Projects', parentId: null, createdAt: 1, updatedAt: 1, color: '#aabbcc', collapsed: false },
        { id: 'F2', name: 'Launch', parentId: 'F1', createdAt: 1, updatedAt: 1, color: null, collapsed: true },
      ],
      canvases: [
        note('active', { name: 'Active note', folderId: 'F2', pinned: true }),
        note('archived', { name: 'Archived note', folderId: 'F1', archived: true, archivedAt: 1700000000500 }),
        note('template', { name: 'Weekly template', isTemplate: true }),
        note('trashed', { name: 'In trash', trashed: true, trashedAt: 1700000000600 }),
      ],
      elements: [
        block('e1', 'active', 0, 'first'),
        block('e2', 'active', 1, 'second', { type: 'todo', checked: true }),
        block('e3', 'archived', 0, 'kept in archive'),
        block('e4', 'template', 0, '{{date}} agenda'),
        block('e5', 'trashed', 0, 'not exported'),
      ],
      media: [
        { id: 'm-active', canvasId: 'active', blob: new Blob([IMAGE], { type: 'image/png' }), type: 'image/png', createdAt: 1 },
        { id: 'm-trashed', canvasId: 'trashed', blob: new Blob(['x'], { type: 'text/plain' }), type: 'text/plain', createdAt: 1 },
      ],
    },
  });
  env.load(...FILES);
  // As the new tab's root starts the page, with the Storage global's shell connected to its kernel
  await startNewTabKernel(env);
  return env;
}

/** A profile with nothing in it yet, the page's kernel started on it */
async function emptyProfile() {
  const env = createLegacyEnv();
  env.load(...FILES);
  // As the new tab's root starts the page, with the Storage global's shell connected to its kernel
  await startNewTabKernel(env);
  return env;
}

/** Export JSON's file, or with `backup` Create Backup's, as the page makes it */
const exportFile = (env, backup = false) => env.settingsClient.exportBackup({ backup });

/** The export the automatic backup and Replace all's recovery copy hold: the automatic backup's */
async function exportObject(env) {
  const keys = () => Object.keys(env.chrome.local).filter((key) => key.startsWith('auto_backup_'));
  const before = keys();
  await env.settingsClient.createAutoBackup();
  const { autoBackup, backupCreatedAt, ...object } = env.chrome.local[keys().find((key) => !before.includes(key))];
  assert.deepEqual([autoBackup, typeof backupCreatedAt], [true, 'number']);
  return object;
}

/** Import `data` as the page does: the backup check, then the importBackup command */
async function importBackup(env, data, mode) {
  const checked = env.validateBackup(data);
  if (!checked.ok) throw new Error(checked.reason);
  return plain(await env.settingsClient.importBackup(data, mode, checked.counts));
}

describe('Export JSON (exportAll)', () => {
  it('includes active and archived notes, templates, folders, and their media; not trash', async () => {
    const env = await sourceProfile();
    const exported = JSON.parse(await (await exportFile(env)).text());

    assert.equal(exported.version, 1);
    assert.equal(typeof exported.exportedAt, 'number');
    assert.deepEqual(exported.canvases.map((n) => n.id).sort(), ['active', 'archived', 'template']);
    assert.deepEqual(exported.elements.map((e) => e.id).sort(), ['e1', 'e2', 'e3', 'e4']);
    assert.deepEqual(exported.folders.map((f) => f.id).sort(), ['F1', 'F2']);
    assert.deepEqual(exported.media.map((m) => m.id), ['m-active'], 'media of trashed notes left out');
    assert.equal(exported.media[0].blob, `data:image/png;base64,${IMAGE.toString('base64')}`);
  });

  it('round-trips through Replace all into an empty profile with folder placement intact (AC5)', async () => {
    const source = await sourceProfile();
    const file = await (await exportFile(source)).text();

    const target = await emptyProfile();
    const result = await importBackup(target, JSON.parse(file), 'replace');
    assert.deepEqual(result.trashedIds, [], 'nothing to trash in an empty profile');

    const dump = await dumpDatabase(target.indexedDB);
    const folders = recordsOf(dump, 'folders');
    assert.deepEqual(Object.keys(folders).sort(), ['F1', 'F2']);
    assert.equal(folders.F2.parentId, 'F1');
    assert.equal(folders.F1.color, '#aabbcc');
    assert.equal(folders.F2.collapsed, true);

    const notes = Object.values(recordsOf(dump, 'canvases'));
    const byName = Object.fromEntries(notes.map((n) => [n.name, n]));
    assert.deepEqual(Object.keys(byName).sort(), ['Active note', 'Archived note', 'Weekly template']);
    assert.equal(byName['Active note'].folderId, 'F2');
    assert.equal(byName['Active note'].pinned, true);
    assert.equal(byName['Archived note'].folderId, 'F1');
    assert.equal(byName['Archived note'].archived, true);
    assert.equal(byName['Archived note'].archivedAt, 1700000000500);
    assert.equal(byName['Weekly template'].isTemplate, true);

    const elements = Object.values(recordsOf(dump, 'elements'));
    const contentsOf = (name) => elements
      .filter((e) => e.canvasId === byName[name].id)
      .sort((a, b) => a.order - b.order)
      .map((e) => [e.type, e.content, e.checked]);
    assert.deepEqual(contentsOf('Active note'), [['text', 'first', false], ['todo', 'second', true]]);
    assert.deepEqual(contentsOf('Archived note'), [['text', 'kept in archive', false]]);
    assert.deepEqual(contentsOf('Weekly template'), [['text', '{{date}} agenda', false]]);

    const media = Object.values(recordsOf(dump, 'media'));
    assert.equal(media.length, 1);
    assert.equal(media[0].canvasId, byName['Active note'].id);
    assert.deepEqual(media[0].blob, { __blob: IMAGE.toString('base64'), type: 'image/png' });

    // Archived notes and templates show up where the app lists them: the page's note list
    await target.noteList.settled();
    assert.deepEqual(plain(target.noteList.view('archived')).map((n) => n.name), ['Archived note']);
    assert.deepEqual(plain(target.noteList.view('templates')).map((n) => n.name), ['Weekly template']);
  });
});

describe('Merging a profile\'s own export (AC3)', () => {
  it('leaves every existing record identical and files the copies into the existing folders', async () => {
    const env = await sourceProfile();
    const before = await dumpDatabase(env.indexedDB);
    await importBackup(env, JSON.parse(await (await exportFile(env)).text()), 'merge');
    const after = await dumpDatabase(env.indexedDB);

    for (const store of ['canvases', 'elements', 'media', 'folders']) {
      const now = recordsOf(after, store);
      for (const [id, value] of Object.entries(recordsOf(before, store))) {
        assert.deepEqual(now[id], value, `${store} ${id} unchanged`);
      }
    }
    assert.deepEqual(recordsOf(after, 'folders'), recordsOf(before, 'folders'));
    const copies = Object.values(recordsOf(after, 'canvases')).filter((n) => !recordsOf(before, 'canvases')[n.id]);
    assert.deepEqual(copies.map((n) => [n.name, n.folderId]).sort(),
      [['Active note', 'F2'], ['Archived note', 'F1'], ['Weekly template', null]]);
    assert.equal(Object.keys(recordsOf(after, 'media')).length, 3, 'one media copy added');
  });
});

describe('Data & Backup hint (AC5)', () => {
  it('lists what exports include and leave out, from the text the export notice uses', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'newtab.html'), 'utf8');
    // The element with that id, whatever its tag and the order of its attributes
    const hint = html.match(/<([a-z][a-z0-9]*)\b[^>]*\bid="export-contents-hint"[^>]*>([\s\S]*?)<\/\1>/);
    assert.ok(hint, 'newtab.html has #export-contents-hint');
    assert.equal(hint[2], '', 'App.init fills it');
    assert.ok(html.indexOf('<h3>Export &amp; Import</h3>') < hint.index && hint.index < html.indexOf('<h3>Auto Backup</h3>'),
      'in Data & Backup, under Export & Import');
    const env = createLegacyEnv();
    env.load('js/ui/export-notice.js');
    assert.equal(env.get('ExportNotice').TEXT.hint, 'Export JSON and Create Backup include '
      + 'active and archived notes, templates, folders, and media. Not included: trash, themes, version history, '
      + 'AI chat history, and settings. The Markdown ZIP holds active notes only. Backlinks rebuild when each note is '
      + 'next saved.');
  });
});

describe('Export JSON as a file (exportAllAsBlob, exportFile on #17\'s adapter)', () => {
  // Images and files live in their blocks as data URLs (the upload buttons
  // write them uncompressed); only import writes the media store.
  const UPLOADS = 16;
  const UPLOAD_BYTES = 96 * 1024;
  const dataUrl = (type, fill) => `data:${type};base64,${Buffer.alloc(UPLOAD_BYTES, fill).toString('base64')}`;
  const imageUrl = (i) => dataUrl('image/png', i);
  const fileData = (i) => dataUrl('application/pdf', 100 + i);
  const MEDIA_ROWS = 3;
  const mediaBytes = (i) => Buffer.alloc(8 * 1024, 200 + i);
  /** The longest string one record needs: a block with its upload, and its other fields */
  const RECORD_CAP = imageUrl(0).length + 1024;

  /** One note with UPLOADS images and UPLOADS files in its blocks, plus media rows, an archived note, a template, and a folder */
  async function uploadsProfile() {
    const env = createLegacyEnv();
    const elements = [block('p0', 'photos', 0, 'first')];
    for (let i = 0; i < UPLOADS; i++) {
      elements.push(block(`img${i}`, 'photos', 1 + 2 * i, '', { type: 'image', imageUrl: imageUrl(i) }));
      elements.push(block(`file${i}`, 'photos', 2 + 2 * i, '', {
        type: 'file', fileName: `scan-${i}.pdf`, fileSize: UPLOAD_BYTES, fileData: fileData(i),
      }));
    }
    elements.push(block('k1', 'kept', 0, 'kept'));
    const media = [];
    for (let i = 0; i < MEDIA_ROWS; i++) {
      media.push({ id: `m${i}`, canvasId: 'photos', blob: new Blob([mediaBytes(i)], { type: 'image/png' }), type: 'image/png', createdAt: i });
    }
    await createDatabase(env.indexedDB, {
      records: {
        folders: [{ id: 'F1', name: 'Trips', parentId: null, createdAt: 1, updatedAt: 1, color: null, collapsed: false }],
        canvases: [
          note('photos', { name: 'Photos', folderId: 'F1' }),
          note('kept', { name: 'Kept', archived: true, archivedAt: 1 }),
          note('template', { name: 'Template', isTemplate: true }),
        ],
        elements,
        media,
      },
    });
    env.load(...FILES);
    await startNewTabKernel(env);
    return env;
  }

  /** Record the size in bytes of each part of each Blob the page's code builds; `instanceof Blob` still holds for every Blob */
  function watchBlobs(env) {
    const built = [];
    env.global.Blob = new Proxy(Blob, {
      construct(target, args) {
        built.push(Array.from(args[0] || [], (part) => (typeof part === 'string' ? Buffer.byteLength(part) : part.size)));
        return Reflect.construct(target, args);
      },
    });
    return built;
  }

  /**
   * Count how many media rows are being encoded at once, until `seen.restore()`: #17's adapter
   * reads each row's Blob for its data URL (data-urls.js)
   */
  function watchEncoding() {
    const read = Blob.prototype.arrayBuffer;
    const seen = { now: 0, most: 0, total: 0, restore: () => { Blob.prototype.arrayBuffer = read; } };
    Blob.prototype.arrayBuffer = async function counted() {
      seen.now += 1;
      seen.total += 1;
      seen.most = Math.max(seen.most, seen.now);
      try {
        return await read.call(this);
      } finally {
        seen.now -= 1;
      }
    };
    return seen;
  }

  it('holds the same JSON as exportAll, without indentation, with extra fields last', async () => {
    const env = await uploadsProfile();
    // Create Backup's file, with the fields 1.4.x's createBackup gave it
    const file = await exportFile(env, true);
    assert.equal(file.type, 'application/json');
    const text = await file.text();
    assert.ok(!text.includes('\n'), 'no indentation');
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), [
      'version', 'exportedAt', 'canvases', 'elements', 'media', 'folders', 'backupType', 'backupCreatedAt', 'backupVersion',
    ]);
    const { exportedAt, backupType, backupCreatedAt, backupVersion, ...rest } = parsed;
    assert.equal(typeof exportedAt, 'number');
    assert.deepEqual([backupType, typeof backupCreatedAt, backupVersion], ['full-backup', 'string', 1]);
    const { exportedAt: objectTime, ...object } = await exportObject(env);
    assert.equal(typeof objectTime, 'number');
    assert.deepEqual(rest, object);
    assert.equal(rest.elements.length, 2 + 2 * UPLOADS);
    assert.equal(rest.media.length, MEDIA_ROWS);
  });

  it('writes each record on its own, so no string holds more than one block\'s upload', async () => {
    const env = await uploadsProfile();
    const built = watchBlobs(env);
    const seen = watchEncoding();
    let file;
    try {
      file = await exportFile(env);
    } finally {
      seen.restore();
    }

    assert.equal(built.length, 1);
    const [parts] = built;
    assert.equal(parts.reduce((sum, length) => sum + length, 0), file.size);
    assert.ok(file.size > 20 * RECORD_CAP, 'the file is many records long');
    assert.ok(Math.max(...parts) <= RECORD_CAP, `the longest part was ${Math.max(...parts)} bytes, over ${RECORD_CAP}`);
    assert.deepEqual([seen.total, seen.most], [MEDIA_ROWS, 1], 'media rows are encoded one at a time');
  });

  it('exportAll, which auto backup and the Replace all copy use, still encodes media rows all at once', async () => {
    const env = await uploadsProfile();
    const seen = watchEncoding();
    try {
      await exportObject(env);
    } finally {
      seen.restore();
    }
    assert.deepEqual([seen.total, seen.most], [MEDIA_ROWS, MEDIA_ROWS]);
  });

  it('imports with Replace all into an empty profile with every image and file intact', async () => {
    const source = await uploadsProfile();
    const text = await (await exportFile(source)).text();

    const target = await emptyProfile();
    await importBackup(target, JSON.parse(text), 'replace');
    const dump = await dumpDatabase(target.indexedDB);
    const notes = Object.values(recordsOf(dump, 'canvases'));
    assert.deepEqual(notes.map((n) => n.name).sort(), ['Kept', 'Photos', 'Template']);
    const photos = notes.find((n) => n.name === 'Photos');
    assert.equal(photos.folderId, 'F1');

    const blocks = Object.values(recordsOf(dump, 'elements')).filter((e) => e.canvasId === photos.id).sort((a, b) => a.order - b.order);
    assert.equal(blocks.length, 1 + 2 * UPLOADS);
    for (let i = 0; i < UPLOADS; i++) {
      assert.equal(blocks[1 + 2 * i].imageUrl, imageUrl(i), `image ${i}`);
      assert.equal(blocks[2 + 2 * i].fileData, fileData(i), `file ${i}`);
    }
    const media = Object.values(recordsOf(dump, 'media')).sort((a, b) => a.createdAt - b.createdAt);
    assert.equal(media.length, MEDIA_ROWS);
    media.forEach((row, i) => {
      assert.equal(row.canvasId, photos.id);
      assert.deepEqual(row.blob, { __blob: mediaBytes(i).toString('base64'), type: 'image/png' }, `media row ${i}`);
    });
  });
});
