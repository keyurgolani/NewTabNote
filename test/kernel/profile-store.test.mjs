// #17 PR 4a, Q8: the profile store the e2e specs and the characterization driver write and read a
// profile through (test/fixtures/storage/profile-store.mjs) makes the records 1.4.x's Storage
// made, and reads them as it read them. Each record it writes has the fields the recorded v1.4.0
// fixture holds for the same write. On one profile its writes are the frozen v1.4.1 Storage's,
// ids and times aside, and on a profile 1.4.1 wrote, and on the recorded fixture, it reads what
// 1.4.1 reads. e2e/harness/profile-store.js offers every call it has.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { loadFixture } from '../fixtures/storage/load-fixture.mjs';
import { createProfileStore, generateId } from '../fixtures/storage/profile-store.mjs';
import { closeAll, releaseContext } from './legacy-fixture.mjs';
import { FIXTURES, legacyEnv, newProfile } from './migration-support.mjs';

/** @typedef {import('./legacy-fixture.mjs').PageContext} PageContext */

const requireCommonJs = createRequire(import.meta.url);
/** @type {{profileStore: Function, generateId: () => string, PROFILE_STORE_METHODS: readonly string[]}} */
const host = requireCommonJs('../../e2e/harness/profile-store.js');

/** @type {import('../fixtures/storage/load-fixture.mjs').Fixture} */
const RECORDED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'recorded', 'v8.v1.4.0.json'), 'utf8'));

/**
 * The recorded fixture's records in CanvasTabDB's store `name`
 * @param {string} name
 * @returns {any[]}
 */
const recordedIn = name => {
  const db = RECORDED.databases.find(found => found.name === 'CanvasTabDB');
  const store = db && db.stores.find(found => found.name === name);
  return store ? store.records.map(record => record.value) : [];
};

/** @param {object} record */
const fieldsOf = record => Object.keys(record).sort();

/**
 * The one set of fields every record in `records` that `which` picks has
 * @param {any[]} records
 * @param {(record: any) => boolean} which
 * @returns {string[]}
 */
function recordedFields(records, which) {
  const sets = [...new Set(records.filter(which).map(record => fieldsOf(record).join(',')))];
  assert.equal(sets.length, 1, `the recorded fixture writes one shape: ${sets.join(' | ')}`);
  return sets[0].split(',');
}

/** A 1.4.x profile at 8 with its ten stores and nothing in them */
async function emptyProfile() {
  const env = legacyEnv.createLegacyEnv({ worker: false });
  await legacyEnv.createDatabase(env.indexedDB, {});
  return env;
}

/** The frozen v1.4.1 Storage on an empty 1.4.x profile */
async function release141() {
  const context = releaseContext();
  await legacyEnv.createDatabase(context.env.indexedDB, {});
  await context.storage.open();
  return context;
}

const TIME_FIELDS = new Set(['createdAt', 'updatedAt', 'archivedAt', 'trashedAt']);
const ID_FIELDS = new Set(['id', 'noteId', 'canvasId', 'folderId', 'parentId']);

/**
 * `value` with each id `labels` names as its label, and each time a write stamped as 'written'
 * @param {unknown} value
 * @param {Map<string, string>} labels
 * @returns {any}
 */
function settled(value, labels) {
  if (Array.isArray(value)) return value.map(item => settled(item, labels));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => {
      if (TIME_FIELDS.has(field) && typeof item === 'number') return [field, 'written'];
      if (ID_FIELDS.has(field) && typeof item === 'string') return [field, labels.get(item) ?? item];
      return [field, settled(item, labels)];
    }),
  );
}

/**
 * The note, block, folder and search entry records on `factory`'s profile, settled
 * @param {IDBFactory} factory
 * @param {Map<string, string>} labels
 */
async function storedOn(factory, labels) {
  const dump = await legacyEnv.dumpDatabase(factory);
  /** @type {Record<string, unknown>} */
  const stores = {};
  for (const name of ['canvases', 'elements', 'folders', 'search_index']) {
    const records = legacyEnv.recordsOf(dump, name);
    stores[name] = Object.fromEntries(
      Object.entries(records)
        .map(([key, record]) => [labels.get(key) ?? key, settled(legacyEnv.plain(record), labels)])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }
  return stores;
}

/**
 * The writes the e2e specs and the driver make, through `api`: 1.4.1's Storage, or the store.
 * Answers each id it made, in order.
 * @param {any} api
 * @returns {Promise<string[]>}
 */
async function writes(api) {
  const alpha = await api.createNote('Alpha');
  const beta = await api.createNote('Beta');
  const template = await api.createNote('Template');
  await api.saveElement({
    id: 'block-1',
    canvasId: alpha.id,
    type: 'text',
    content: 'alpha body',
    order: 0,
    checked: false,
    indentLevel: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  await api.updateNote({ ...(await api.getNote(beta.id)), name: 'Beta renamed' });
  await api.archiveNote(alpha.id);
  await api.unarchiveNote(alpha.id);
  await api.archiveNote(beta.id);
  const work = await api.createFolder('Work');
  const inner = await api.createFolder('Inner', work.id);
  await api.updateNote({ ...(await api.getNote(alpha.id)), folderId: inner.id });
  await api.updateNote({ ...(await api.getNote(beta.id)), folderId: work.id });
  await api.deleteFolder(work.id);
  await api.updateNote({ ...(await api.getNote(template.id)), isTemplate: true });
  await api.trashNote(beta.id);
  return [alpha.id, beta.id, template.id, work.id, inner.id];
}

/**
 * Each read the e2e specs make, through `api`, for the notes `ids` names
 * @param {any} api
 * @param {string[]} ids
 */
async function reads(api, ids) {
  return legacyEnv.plain({
    active: await api.getAllNotes(),
    withArchived: await api.getAllNotes(true),
    notes: await Promise.all(ids.map(id => api.getNote(id))),
    blocks: await Promise.all(ids.map(id => api.getElementsByNote(id))),
    folders: await api.getAllFolders(),
    trashed: await api.getTrashedNotes(),
    templates: await api.getTemplates(),
    themes: await api.getCustomThemes(),
  });
}

describe('the profile store the e2e specs and the driver write and read through (#17 PR 4a, Q8)', () => {
  it('writes each record with the fields the recorded v1.4.0 fixture holds for the same write', async () => {
    const env = await emptyProfile();
    const store = createProfileStore(env.indexedDB);
    const alpha = await store.createNote('Alpha');
    const [beta] = await store.seedNotes([{ name: 'Beta', blocks: [{ content: 'beta body' }] }]);
    const folder = await store.createFolder('Work');
    await store.archiveNote(beta.id);
    const trashed = await store.trashNote(alpha.id);
    const dump = await legacyEnv.dumpDatabase(env.indexedDB);
    const notes = legacyEnv.recordsOf(dump, 'canvases');
    const notesRecorded = recordedIn('canvases');
    // createNote's note, archived or not, and a trashed one
    assert.deepEqual(
      fieldsOf(notes[beta.id]),
      recordedFields(notesRecorded, note => 'viewport' in note && !note.trashed),
    );
    assert.deepEqual(
      fieldsOf(notes[alpha.id]),
      recordedFields(notesRecorded, note => note.trashed),
    );
    assert.deepEqual([notes[beta.id].archived, typeof notes[beta.id].archivedAt], [true, 'number']);
    assert.equal(trashed && trashed.trashed, true);
    // createNote's search entry, a text block as the editor saved one, and a folder
    assert.deepEqual(
      fieldsOf(legacyEnv.recordsOf(dump, 'search_index')[beta.id]),
      recordedFields(recordedIn('search_index'), () => true),
    );
    const [block] = Object.values(legacyEnv.recordsOf(dump, 'elements'));
    assert.deepEqual(
      fieldsOf(block),
      recordedFields(recordedIn('elements'), element => element.type === 'text' && !('imageUrl' in element)),
    );
    assert.deepEqual([block.content, block.canvasId, block.order], ['beta body', beta.id, 0]);
    assert.deepEqual(
      fieldsOf(legacyEnv.recordsOf(dump, 'folders')[folder.id]),
      recordedFields(recordedIn('folders'), () => true),
    );
  });

  it('writes on one profile what the frozen v1.4.1 Storage writes on another, ids and times aside', async () => {
    const env = await emptyProfile();
    const mine = await writes(createProfileStore(env.indexedDB));
    const context = await release141();
    const theirs = await writes(context.storage);
    closeAll([context]);
    const names = ['alpha', 'beta', 'template', 'work', 'inner'];
    const stored = await storedOn(env.indexedDB, new Map(mine.map((id, index) => [id, names[index]])));
    const expected = await storedOn(context.env.indexedDB, new Map(theirs.map((id, index) => [id, names[index]])));
    assert.deepStrictEqual(stored, expected);
  });

  it('reads what the frozen v1.4.1 Storage reads, on a profile 1.4.1 wrote and on the recorded fixture', async () => {
    const context = await release141();
    const ids = await writes(context.storage);
    assert.deepStrictEqual(
      await reads(createProfileStore(context.env.indexedDB), ids),
      await reads(context.storage, ids),
    );
    closeAll([context]);

    const of = newProfile();
    await loadFixture(RECORDED, { factory: of.real, storage: of.chrome.api.storage.local });
    const recorded = releaseContext({ indexedDB: of.real, chrome: of.chrome });
    await recorded.storage.open();
    const noteIds = recordedIn('canvases').map(note => note.id);
    const store = createProfileStore(of.real);
    assert.deepStrictEqual(await reads(store, noteIds), await reads(recorded.storage, noteIds));
    assert.equal((await store.getCustomThemes()).length, 1);
    closeAll([recorded]);
  });

  it('refuses to trash an untitled note with nothing in it, which 1.4.x deleted for good, and writes nothing', async () => {
    const env = await emptyProfile();
    const store = createProfileStore(env.indexedDB);
    const note = await store.createNote();
    await store.saveElement({ id: 'empty', canvasId: note.id, type: 'text', content: '<br>&nbsp;', order: 0 });
    const before = await legacyEnv.dumpDatabase(env.indexedDB);
    await assert.rejects(store.trashNote(note.id), /deletes the untitled empty note/);
    assert.deepStrictEqual(await legacyEnv.dumpDatabase(env.indexedDB), before);
  });

  it('opens a profile as it is, makes none where there is none, and holds no connection after a call', async () => {
    const of = newProfile();
    await assert.rejects(createProfileStore(of.real).getAllNotes(), /the profile has no CanvasTabDB/);
    assert.deepEqual(await of.real.databases(), []);
    const env = await emptyProfile();
    await createProfileStore(env.indexedDB).createNote('Alpha');
    // An upgrade finds no connection of the store's to wait on
    const upgraded = await legacyEnv.requestToPromise(env.indexedDB.open('CanvasTabDB', 9));
    assert.equal(upgraded.version, 9);
    upgraded.close();
  });

  it("offers each of the store's calls through the browser host, with ids in the form Utils.generateId gives", async () => {
    const env = await emptyProfile();
    assert.deepEqual([...host.PROFILE_STORE_METHODS].sort(), Object.keys(createProfileStore(env.indexedDB)).sort());
    for (const id of [generateId(), host.generateId()]) assert.match(id, /^\d{13}-[0-9a-z]{1,9}$/);
  });
});
