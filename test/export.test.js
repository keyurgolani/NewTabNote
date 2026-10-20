'use strict';

// AC5: an export from a profile with archived notes, templates, and folders,
// imported with Replace all into an empty profile, reproduces all of them with
// folder placement intact. The Data & Backup hint lists what's excluded.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, createDatabase, dumpDatabase, recordsOf, plain, note, block } = require('./helpers/legacy-env');

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
  await env.get('Storage').init();
  return env;
}

describe('exportAll', () => {
  it('includes active and archived notes, templates, folders, and their media; not trash', async () => {
    const env = await sourceProfile();
    const exported = plain(await env.get('Storage').exportAll());

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
    const file = JSON.stringify(await source.get('Storage').exportAll());

    const target = createLegacyEnv();
    target.load(...FILES);
    const Storage = target.get('Storage');
    await Storage.init();
    const result = plain(await Storage.importData(JSON.parse(file), 'replace'));
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

    // Archived notes and templates show up where the app lists them.
    assert.deepEqual(plain(await Storage.getArchivedNotes()).map((n) => n.name), ['Archived note']);
    assert.deepEqual(plain(await Storage.getTemplates()).map((n) => n.name), ['Weekly template']);
  });
});

describe('Merging a profile\'s own export (AC3)', () => {
  it('leaves every existing record identical and files the copies into the existing folders', async () => {
    const env = await sourceProfile();
    const Storage = env.get('Storage');
    const before = await dumpDatabase(env.indexedDB);
    await Storage.importData(JSON.parse(JSON.stringify(await Storage.exportAll())), 'merge');
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
  it('lists what exports include and leave out', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'newtab.html'), 'utf8');
    const section = html.slice(html.indexOf('<h3>Export &amp; Import</h3>'), html.indexOf('<h3>Auto Backup</h3>'));
    assert.ok(section.includes('<p class="setting-hint" id="export-contents-hint">Export JSON and Create Backup include '
      + 'active and archived notes, templates, folders, and media. Not included: trash, themes, version history, '
      + 'AI chat history, and settings. The Markdown ZIP holds active notes only. Backlinks rebuild when each note is '
      + 'next saved.</p>'));
  });
});
