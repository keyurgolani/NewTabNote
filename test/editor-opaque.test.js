'use strict';

// #14 slice 3, the opaque rule in load and save, and schemaVersion on the next save. The legacy
// editor keeps what decode found: a block this build doesn't fully read (from a newer version,
// of a type it doesn't have, or with stored data it can't read) is written back as it was
// loaded, and a known block keeps every field its type doesn't own, through saves, undo and
// redo, a delete and its undo, Export JSON and Import, version history and Save as a new note.
// Every known block a save writes says its version, and a load writes nothing. A save writes
// only the blocks its pane changed (#17, the per-pane save), so a block it leaves alone stays as
// stored, with no version if it had none. Elements are compared by small fields, never whole.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, plain, note, block, startEditorClient, makeEditor, runUntil,
  bootNewTab,
} = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js'];
const T = 1700000000000;
const OPTIONS = { timeout: 30_000 };

/** A note's blocks as a newer build, or a file from one, could leave them, beside 1.4.x's own */
const OPAQUE = Object.freeze([
  block('o1', 'N', 0, 'Before'),
  // A type this build doesn't have
  { id: 'o2', type: 'kanban', columns: [{ name: 'To do', cards: ['a'] }], content: '<b>board</b>', canvasId: 'N', order: 1, createdAt: T, updatedAt: T },
  // A newer version of a type it has
  { ...block('o3', 'N', 2, 'Newer'), schemaVersion: 2, newerField: { shape: 'kept' } },
  // A version that isn't one
  { ...block('o4', 'N', 3, 'Odd version'), schemaVersion: 'x' },
  // A field its type doesn't own
  { ...block('o5', 'N', 4, 'Extra'), futureField: { kept: [1, 2] } },
  // A table whose grid isn't rows
  { ...block('o6', 'N', 5, ''), type: 'table', rows: 1, cols: 2, tableData: 'Name,Age', hasHeaderRow: true },
  block('o7', 'N', 6, 'After'),
]);

/** Which of OPAQUE decode reads as a known block, which a save writes at version 1 */
const KNOWN = new Set(['o1', 'o5', 'o7']);

/** A record as a save that writes it should store it: the same, and version 1 on a known block */
const savedAs = record => (KNOWN.has(record.id) ? { ...record, schemaVersion: 1 } : record);

/** An editor on note N, holding `records` */
async function openNote(records, { name = 'Plan' } = {}) {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, { records: { canvases: [note('N', { name })], elements: records } });
  env.load(...FILES);
  await startEditorClient(env);
  const editor = makeEditor(env);
  await runUntil(env, editor.loadNote('N'));
  return { env, editor };
}

const stored = async env => recordsOf(await dumpDatabase(env.indexedDB), 'elements');

/** A block without the fields an import gives anew: its id, note and times */
const withoutNewFields = ({ id, canvasId, createdAt, updatedAt, ...rest }) => rest;

/** A block without the fields Save as a new note gives anew: its id and note */
const withoutIds = ({ id, canvasId, ...rest }) => rest;

/**
 * A block as a snapshot holds it: a known one as it serializes, without the note and the place
 * a save gives it, and every other one as it was loaded
 */
const inSnapshotAs = record => {
  if (!KNOWN.has(record.id)) return record;
  const { canvasId, order, ...rest } = savedAs(record);
  return rest;
};

/** Each stored block of `noteId`, in note order, without the fields an import gives anew */
async function storedOf(env, noteId) {
  const blocks = Object.values(await stored(env)).filter(record => record.canvasId === noteId);
  return plain(blocks.sort((a, b) => a.order - b.order).map(withoutNewFields));
}

/**
 * OPAQUE as loaded, without the fields an import gives anew: what a save that changed nothing
 * leaves stored, since it writes only the blocks its pane changed (#17, the per-pane save)
 */
const LOADED = plain(OPAQUE.map(withoutNewFields));

describe('the opaque rule in load and save (#14 slice 3)', () => {
  it('a save stores the block it changed at schemaVersion 1, and leaves every other block as it was loaded, the cards among them', OPTIONS, async () => {
    const { env, editor } = await openNote(OPAQUE);
    editor.getBlockById('o1').content = 'Before, edited';
    await runUntil(env, editor.save());
    const after = await stored(env);
    assert.deepEqual(plain(after.o1), plain({ ...savedAs(OPAQUE[0]), content: 'Before, edited' }), 'o1, the block it changed');
    for (const record of OPAQUE.slice(1)) assert.deepEqual(plain(after[record.id]), plain(record), `${record.id}, not rewritten`);
  });

  it('a note opened and left alone writes nothing: upcasting runs in memory', OPTIONS, async () => {
    const { env } = await openNote(OPAQUE);
    const after = await stored(env);
    for (const record of OPAQUE) assert.deepEqual(plain(after[record.id]), plain(record), record.id);
  });

  it('undo and redo of an edit keep the fields a block carries, one named __proto__ included', OPTIONS, async () => {
    const carried = { ...block('u1', 'N', 0, 'One'), futureField: 'kept', ...JSON.parse('{"__proto__": {"shape": "kept"}}') };
    const { env, editor } = await openNote([carried, block('u2', 'N', 1, 'Two')]);
    const target = editor.getBlockById('u1');
    const before = editor.snapshotBlock(target);
    target.content = 'Edited';
    editor.pushUndo({ type: 'content', blockId: 'u1', before, after: editor.snapshotBlock(target) });

    editor.undo();
    await runUntil(env, editor.save());
    // Read through the kernel, whose reads keep a field named __proto__, where the test's dump doesn't
    const undone = plain((await env.documentClient.openNote('N')).blocks.find(b => b.id === 'u1'));
    assert.equal(undone.content, 'One');
    assert.equal(undone.futureField, 'kept');
    assert.deepEqual(Object.getOwnPropertyDescriptor(undone, '__proto__')?.value, { shape: 'kept' });
    assert.equal(typeof editor.getBlockById('u1').serialize, 'function', 'still a block');

    editor.redo();
    await runUntil(env, editor.save());
    const redone = plain((await stored(env)).u1);
    assert.equal(redone.content, 'Edited');
    assert.equal(redone.futureField, 'kept');
  });

  it('a deleted block comes back with every field it held when the delete is undone', OPTIONS, async () => {
    const { env, editor } = await openNote([block('d1', 'N', 0, 'Keep'), { ...block('d2', 'N', 1, 'Gone'), futureField: 'kept' }]);
    editor.selectedBlockIds = new Set(['d2']);
    Object.assign(editor, { focusBlock() {} });
    await editor.deleteSelectedBlocks();
    await runUntil(env, editor.save());
    assert.equal((await stored(env)).d2, undefined, 'deleted');

    editor.undo();
    await runUntil(env, editor.save());
    const back = plain((await stored(env)).d2);
    assert.equal(back.content, 'Gone');
    assert.equal(back.futureField, 'kept');
  });

  it("deleting a note's last block puts a new empty text block in its place, and the one it deleted is gone", OPTIONS, async () => {
    const table = { ...block('t1', 'N', 0, ''), type: 'table', rows: 1, cols: 2, tableData: [['a', 'b']], hasHeaderRow: true };
    const { env, editor } = await openNote([table]);
    Object.assign(editor, { focusBlock() {} });
    editor.deleteBlock('t1');
    assert.equal(editor.blocks.length, 1);
    assert.notEqual(editor.blocks[0].id, 't1', 'a new block, not the table retyped');
    assert.equal(editor.blocks[0].type, 'text');
    await runUntil(env, editor.save());
    const after = await stored(env);
    assert.equal(after.t1, undefined, 'the table is deleted, not stored as text');
    assert.equal(after[editor.blocks[0].id].type, 'text');
  });

  it('a block the editor holds goes through the note\'s Export JSON and Import as it was loaded', OPTIONS, async () => {
    const env = createLegacyEnv();
    await createDatabase(env.indexedDB, { records: { canvases: [note('N', { name: 'Plan' })], elements: OPAQUE } });
    const { tabs, wire } = await bootNewTab(env);
    await runUntil(env, tabs.openNoteInNewTab('N'));
    await runUntil(env, tabs.getEditor().save());
    assert.deepEqual(await storedOf(env, 'N'), LOADED, 'the save before the export rewrites nothing');

    // The note's own Export JSON reads its blocks as stored (SettingsController.exportCurrentNote)
    const exported = plain(await env.documentClient.blocksAsStored('N'));
    const notes = wire(new (env.get('NotesManager'))({ storage: null, domRefs: null, logger: null, llm: null }));
    env.get('Utils').readFileAsText = async file => file.text;
    env.get('Utils').showToast = () => {};
    const file = { name: 'plan.json', text: JSON.stringify({ exportType: 'single-note', note: { name: 'Plan copy' }, blocks: exported }) };
    await runUntil(env, notes.importNote(file));

    const copy = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases')).find(n => n.name === 'Plan copy');
    assert.ok(copy, 'imported');
    // Opened, and saved by the editor again
    await runUntil(env, tabs.openNoteInNewTab(copy.id));
    await runUntil(env, tabs.getEditor().save());
    assert.deepEqual(await storedOf(env, copy.id), LOADED);
  });

  it('a block the editor holds goes through Export JSON and Import (merge) as it was loaded', OPTIONS, async () => {
    const { env, editor } = await openNote(OPAQUE);
    await runUntil(env, editor.save());

    const exported = await env.kernel.query({ type: 'exportBackup', backup: false });
    assert.equal(exported.kind, 'ready');
    const backup = JSON.parse(await exported.data.text());
    const imported = await env.kernel.execute({ type: 'importBackup', commandId: 'c-import', mode: 'merge', backup });
    assert.equal(imported.kind, 'committed', JSON.stringify(imported));
    const [copyId] = imported.changedIds;

    await runUntil(env, editor.loadNote(copyId));
    await runUntil(env, editor.save());
    assert.deepEqual(await storedOf(env, copyId), LOADED);
  });

  it('a snapshot holds every block as a save stores it, and a revert to it after they were deleted brings each back so', OPTIONS, async () => {
    const { env, editor } = await openNote(OPAQUE);
    Object.assign(editor, { focusBlock() {} });
    editor._snapshotDirty = true;
    await runUntil(env, editor._autoSnapshot());
    const [summary] = await env.documentClient.snapshots('N');
    const snap = await editor._readSnapshot(summary.id);
    const inSnap = Object.fromEntries(snap.blocks.map(record => [record.id, record]));
    for (const record of OPAQUE) assert.deepEqual(plain(inSnap[record.id]), plain(inSnapshotAs(record)), `${record.id} in the snapshot`);

    // Every block but the first and the last goes, with a yes to the question, and the revert's
    env.global.confirmDialog = async () => true;
    editor.selectedBlockIds = new Set(OPAQUE.slice(1, -1).map(record => record.id));
    await editor.deleteSelectedBlocks();
    await runUntil(env, editor.save());
    assert.deepEqual(Object.keys(await stored(env)).sort(), ['o1', 'o7'], 'deleted');

    await runUntil(env, editor._runRevert(summary));
    await runUntil(env, editor.save());
    const after = await stored(env);
    for (const record of OPAQUE) assert.deepEqual(plain(after[record.id]), plain(savedAs(record)), `${record.id} after the revert`);
  });

  it('Save as a new note stores every block as a save stores it, each under a new id in the new note', OPTIONS, async () => {
    const { env, editor } = await openNote(OPAQUE);
    Object.assign(editor, { focusBlock() {} });
    await runUntil(env, editor._saveAsNewNote());
    assert.notEqual(editor.noteId, 'N');
    const copy = Object.values(await stored(env)).filter(record => record.canvasId === editor.noteId).sort((a, b) => a.order - b.order);
    assert.equal(copy.length, OPAQUE.length);
    OPAQUE.forEach((record, i) => {
      assert.ok(!OPAQUE.some(original => original.id === copy[i].id), `${record.id} under a new id`);
      assert.deepEqual(plain(withoutIds(copy[i])), plain(withoutIds(savedAs(record))), record.id);
    });
  });
});

describe('schemaVersion, written the next time a block is saved (#14 slice 3)', () => {
  it('a save writes schemaVersion 1 on each known block it writes, and leaves a block it doesn\'t write as stored', OPTIONS, async () => {
    const untouched = block('v3', 'N', 2, 'Three');
    const { env, editor } = await openNote([block('v1', 'N', 0, 'One'), { ...block('v2', 'N', 1, 'Two'), type: 'todo', checked: true }, untouched]);
    editor.getBlockById('v1').content = 'One, edited';
    editor.getBlockById('v2').content = 'Two, edited';
    await runUntil(env, editor.save());
    const after = await stored(env);
    assert.deepEqual([after.v1.schemaVersion, after.v2.schemaVersion], [1, 1]);
    assert.deepEqual(plain(after.v3), plain(untouched), 'v3, left alone, is not rewritten, so it gains no version');
  });

  it('a version 0 record and the version 1 record a save writes read as the same block', OPTIONS, async () => {
    const v0 = block('s1', 'N', 0, 'Same <b>block</b>');
    const { env, editor } = await openNote([v0]);
    await runUntil(env, editor.save());
    assert.deepEqual(plain((await stored(env)).s1), plain(v0), 'left alone, s1 is not rewritten, so it stays at version 0');
    // The record a save writes of s1 once it writes it: the block as it serializes, in its note and place
    const v1 = { ...plain(editor.getBlockById('s1').serialize()), canvasId: 'N', order: 0 };
    assert.equal(v1.schemaVersion, 1);
    const read = record => {
      const decoded = env.global.BlockProjections.decodeBlock(plain(record));
      return plain({ state: decoded.state, type: decoded.type, version: decoded.version, fields: decoded.fields, extra: decoded.extra });
    };
    assert.deepEqual(read(v1), { ...read(v0), state: 'current' });
    assert.equal(read(v0).state, 'upcast');
  });

  it('a block from a newer version is never written below its version', OPTIONS, async () => {
    const newer = { ...block('n1', 'N', 0, 'Newer'), schemaVersion: 9 };
    const { env, editor } = await openNote([newer, block('n2', 'N', 1, 'Mine')]);
    const mine = editor.getBlockById('n2');
    mine.content = 'Mine, edited';
    await runUntil(env, editor.save());
    const after = await stored(env);
    assert.equal(after.n1.schemaVersion, 9);
    assert.equal(after.n2.content, 'Mine, edited');
  });
});
