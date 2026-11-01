// #13's schemas for what payloads and projections carry (contracts/fields.js, entities.js,
// settings.js, and outcome-schemas.js). A schema's type comes from the schema, and the
// `Equal` and `Same` checks below hold each one to the typedef #12 wrote by hand, and each
// query's result schema to the data the kernel answers it with: `npm run typecheck:kernel`
// fails when they drift apart.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import {
  FOLDER_OP_FIELDS,
  NOTE_OP_FIELDS,
  blockInput,
  blockRecord,
  changeRecord,
  folderRecord,
  noteRecord,
} from '../../js/kernel/core/contracts/entities.js';
import {
  ENTITY_TYPES,
  MAX_ID_LENGTH,
  code,
  commitSeq,
  content,
  count,
  entityId,
  id,
  revision,
  timestamp,
} from '../../js/kernel/core/contracts/fields.js';
import {
  bulkOutcomeSchema,
  bulkResultSchema,
  failedSchema,
  outcomeSchema,
  queryStateSchema,
} from '../../js/kernel/core/contracts/outcome-schemas.js';
import {
  bulk,
  committed,
  conflict,
  empty,
  failed,
  loading,
  ready,
  rejected,
  stale,
  unavailable,
  unknown,
} from '../../js/kernel/core/contracts/outcomes.js';
import { preferenceValues, workspaceSession } from '../../js/kernel/core/contracts/settings.js';
import { newFolderRecord } from '../../js/kernel/core/domain/folder.js';
import { newNoteRecord } from '../../js/kernel/core/domain/note.js';
import { DEFAULT_PREFERENCES, PREFERENCE_KEYS } from '../../js/kernel/core/domain/preferences.js';
import { WORKSPACE_SESSION_KEYS } from '../../js/kernel/core/domain/session.js';
import { NOW } from './support.mjs';

/**
 * true when A and B are the same type, false otherwise
 * @template A, B
 * @typedef {(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false} Equal
 */

/** @type {Equal<v.InferOutput<typeof outcomeSchema>, import('../../js/kernel/core/contracts/outcomes.js').Outcome>} */
const outcomeTypesMatch = true;
/** @type {Equal<v.InferOutput<typeof bulkOutcomeSchema>, import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome>} */
const bulkTypesMatch = true;
/** @type {Equal<v.InferOutput<typeof failedSchema>, import('../../js/kernel/core/contracts/outcomes.js').Failed>} */
const failedTypesMatch = true;
/**
 * @type {Equal<
 *   import('../../js/kernel/core/contracts/commands.js').CaptureToDailyNote['capture'],
 *   import('../../js/kernel/core/domain/note.js').Capture
 * >}
 */
const captureTypesMatch = true;
/**
 * @type {Equal<
 *   v.InferOutput<typeof workspaceSession>,
 *   Partial<import('../../js/kernel/core/domain/session.js').WorkspaceSession>
 * >}
 */
const sessionTypesMatch = true;
/** @type {Equal<keyof v.InferOutput<typeof workspaceSession>, (typeof WORKSPACE_SESSION_KEYS)[number]>} */
const sessionKeysMatch = true;

/**
 * true when A and B are each assignable to the other
 * @template A, B
 * @typedef {[A] extends [B] ? ([B] extends [A] ? true : false) : false} Same
 */

/**
 * The names of T's fields, without the index signature a record has for the fields a newer
 * build adds
 * @template T
 * @typedef {keyof {[K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]}} FieldNames
 */

/**
 * @template T, K
 * @typedef {K extends keyof T ? NonNullable<T[K]> : never} Field
 */

/**
 * true when A and B describe the same data: each is assignable to the other, they have the
 * same field names, and the same holds for their items and for each field that holds an
 * object. Equal can't hold a record to its typedef, since it tells an intersection, which a
 * record type with an index signature is, from the object type it amounts to.
 * @template A, B
 * @typedef {Same<A, B> extends true
 *   ? [A, B] extends [readonly (infer I)[], readonly (infer J)[]]
 *     ? Bound<I, J>
 *     : [A, B] extends [object, object]
 *       ? Equal<FieldNames<A>, FieldNames<B>> extends true
 *         ? false extends {[K in FieldNames<A>]-?: Bound<Field<A, K>, Field<B, K>>}[FieldNames<A>]
 *           ? false
 *           : true
 *         : false
 *       : true
 *   : false} Bound
 */

/** @typedef {import('../../js/kernel/core/domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../../js/kernel/core/domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../../js/kernel/core/domain/note.js').BlockInput} BlockInput */
/** @typedef {import('../../js/kernel/core/domain/folder.js').FolderRecord} FolderRecord */

/** @type {Bound<v.InferOutput<typeof noteRecord>, NoteRecord>} */
const noteTypesMatch = true;
/** @type {Bound<v.InferOutput<typeof blockRecord>, BlockRecord>} */
const blockTypesMatch = true;
/** @type {Bound<v.InferOutput<typeof blockInput>, BlockInput>} */
const blockInputTypesMatch = true;
/** @type {Bound<v.InferOutput<typeof folderRecord>, FolderRecord>} */
const folderTypesMatch = true;

/** @typedef {import('../../js/kernel/core/contracts/queries.js').QueryType} QueryType */
/** @typedef {import('../../js/kernel/core/contracts/queries.js').QueryData} QueryData */

/**
 * Each query's result schema
 * @typedef {{
 *   listNotes: typeof import('../../js/kernel/core/contracts/operations/list-notes.js').result,
 *   getNote: typeof import('../../js/kernel/core/contracts/operations/get-note.js').result,
 *   getNoteBlocks: typeof import('../../js/kernel/core/contracts/operations/get-note-blocks.js').result,
 *   getBacklinks: typeof import('../../js/kernel/core/contracts/operations/get-backlinks.js').result,
 *   getNoteList: typeof import('../../js/kernel/core/contracts/operations/get-note-list.js').result,
 *   getNotesByIds: typeof import('../../js/kernel/core/contracts/operations/get-notes-by-ids.js').result,
 *   listSearchEntries: typeof import('../../js/kernel/core/contracts/operations/list-search-entries.js').result,
 *   listFolders: typeof import('../../js/kernel/core/contracts/operations/list-folders.js').result,
 *   getPreferences: typeof import('../../js/kernel/core/contracts/operations/get-preferences.js').result,
 *   getWorkspaceSession: typeof import('../../js/kernel/core/contracts/operations/get-workspace-session.js').result,
 *   getPopupInsightsEnabled: typeof import('../../js/kernel/core/contracts/operations/get-popup-insights-enabled.js').result,
 *   getInsightsPending: typeof import('../../js/kernel/core/contracts/operations/get-insights-pending.js').result,
 *   getJobRuns: typeof import('../../js/kernel/core/contracts/operations/get-job-runs.js').result,
 *   listSnapshots: typeof import('../../js/kernel/core/contracts/operations/list-snapshots.js').result,
 *   getSnapshot: typeof import('../../js/kernel/core/contracts/operations/get-snapshot.js').result,
 *   findDailyNote: typeof import('../../js/kernel/core/contracts/operations/find-daily-note.js').result,
 *   getWorkspaceData: typeof import('../../js/kernel/core/contracts/operations/get-workspace-data.js').result,
 *   listThemes: typeof import('../../js/kernel/core/contracts/operations/list-themes.js').result,
 *   exportBackup: typeof import('../../js/kernel/core/contracts/operations/export-backup.js').result,
 *   profileHoldsContent: typeof import('../../js/kernel/core/contracts/operations/profile-holds-content.js').result,
 *   listLinks: typeof import('../../js/kernel/core/contracts/operations/list-links.js').result,
 *   listVectors: typeof import('../../js/kernel/core/contracts/operations/list-vectors.js').result,
 *   getSyncData: typeof import('../../js/kernel/core/contracts/operations/get-sync-data.js').result,
 * }} ResultSchemas
 */

/**
 * What a query's result schema lets its `ready` state hold
 * @template {QueryType} T
 * @typedef {Extract<v.InferOutput<ResultSchemas[T]>, {kind: 'ready'}>['data']} ReadyData
 */

/** @type {{[T in QueryType]: Bound<ReadyData<T>, QueryData[T]>}} */
const queryDataMatches = {
  listNotes: true,
  getNote: true,
  getNoteBlocks: true,
  getBacklinks: true,
  getNoteList: true,
  getNotesByIds: true,
  listSearchEntries: true,
  listFolders: true,
  getPreferences: true,
  getWorkspaceSession: true,
  getPopupInsightsEnabled: true,
  getInsightsPending: true,
  getJobRuns: true,
  listSnapshots: true,
  getSnapshot: true,
  findDailyNote: true,
  getWorkspaceData: true,
  listThemes: true,
  exportBackup: true,
  profileHoldsContent: true,
  listLinks: true,
  listVectors: true,
  getSyncData: true,
};

/**
 * @param {v.GenericSchema} schema
 * @param {unknown} value
 */
const accepts = (schema, value) => v.safeParse(schema, value).success;

describe('fields', () => {
  it('ids are non-empty strings up to MAX_ID_LENGTH, and an entity id says what it names', () => {
    assert.equal(accepts(id, 'n1'), true);
    assert.equal(accepts(id, 'x'.repeat(MAX_ID_LENGTH)), true);
    for (const bad of ['', 'x'.repeat(MAX_ID_LENGTH + 1), 5, null]) assert.equal(accepts(id, bad), false, String(bad));
    assert.deepEqual(ENTITY_TYPES, ['note', 'block', 'folder', 'snapshot', 'intelligence']);
    assert.deepEqual(v.getMetadata(entityId('folder')), { entity: 'folder' });
    assert.equal(accepts(entityId('note'), ''), false);
    assert.deepEqual(v.getMetadata(content(v.string())), { content: true });
  });

  it('times, revisions, positions, and counts are integers, and codes are kebab-case words', () => {
    for (const [schema, good, bad] of /** @type {const} */ ([
      [timestamp, [0, NOW], [-1, 1.5, NaN, '5']],
      [revision, [0, 7], [-1, 0.5]],
      [commitSeq, [1, 2 ** 40], [0, -3, 1.25]],
      [count, [0, 3], [-1, 2.5]],
      [code, ['note-not-found', 'committed2'], ['Note', 'a--b', '-a', 'a b', 'x'.repeat(65)]],
    ])) {
      for (const value of good) assert.equal(accepts(schema, value), true, String(value));
      for (const value of bad) assert.equal(accepts(schema, value), false, String(value));
    }
  });
});

describe('entity schemas (#13, AC1)', () => {
  it("are the records #12's kernel reads and writes, field for field", () => {
    assert.ok(noteTypesMatch && blockTypesMatch && blockInputTypesMatch && folderTypesMatch);
    assert.ok(Object.values(queryDataMatches).every(Boolean));
  });

  it('accept the records 1.4.x writes, and Popup notes with four fields', () => {
    assert.equal(accepts(noteRecord, newNoteRecord({ id: 'n1', name: 'Plan', now: NOW })), true);
    assert.equal(accepts(noteRecord, { id: 'n2', name: 'Quick', createdAt: NOW, updatedAt: NOW }), true);
    assert.equal(
      accepts(noteRecord, {
        ...newNoteRecord({ id: 'n3', name: '', now: NOW }),
        todoProgress: { completed: 1, total: 2 },
      }),
      true,
    );
    assert.equal(accepts(noteRecord, { id: 'd1', isDaily: true, dateStr: '2026-10-20' }), true);
    assert.equal(accepts(folderRecord, newFolderRecord({ id: 'f1', name: 'Work', parentId: null, now: NOW })), true);
    const block = { id: 'b1', canvasId: 'n1', type: 'text', content: '<p>Line</p>', order: 0 };
    assert.equal(accepts(blockRecord, block), true);
    assert.equal(accepts(blockInput, { id: 'b1', content: 'x' }), true);
    assert.equal(accepts(blockRecord, { id: 'b1', content: 'x' }), false, 'a stored block names its note');
  });

  it('keep the fields this build does not know, so a newer record reads back whole', () => {
    const note = { id: 'n1', name: 'Plan', placementVersion: 3, kind: 'note' };
    assert.deepEqual(v.parse(noteRecord, note), note);
  });

  it('refuse a record whose known fields have the wrong type', () => {
    for (const note of [
      { name: 'no id' },
      { id: 'n1', name: 5 },
      { id: 'n1', updatedAt: '2026-10-20' },
      { id: 'n1', archived: 'yes' },
      { id: 'n1', dateStr: '20/10/2026' },
      { id: 'n1', folderId: '' },
      { id: 'n1', todoProgress: { completed: '1', total: 2 } },
    ]) {
      assert.equal(accepts(noteRecord, note), false, JSON.stringify(note));
    }
    assert.equal(accepts(folderRecord, { id: 'f1', parentId: 7 }), false);
  });

  it("describe #17's change records, which #13's CommitFeed reads", () => {
    const change = {
      seq: 1,
      entityType: 'note',
      entityId: 'n1',
      revision: 2,
      opId: 'c1',
      ops: [
        { op: 'updateNote', fields: ['name', 'pinned'] },
        { op: 'insertBlock', blockId: 'b1' },
      ],
    };
    assert.equal(accepts(changeRecord, change), true);
    assert.equal(accepts(changeRecord, { ...change, ops: [] }), true);
    assert.equal(accepts(changeRecord, { ...change, seq: 0 }), false);
    assert.equal(accepts(changeRecord, { ...change, entityType: 'tab' }), false);
    // #17's adapter keeps each row's place in its commit, and a field the schema doesn't name,
    // a value of the note's included, doesn't fit (R131)
    assert.equal(accepts(changeRecord, { ...change, position: 0 }), true);
    assert.equal(accepts(changeRecord, { ...change, name: 'Plan' }), false);
  });

  it("pin the change log's ops to their names, a block's id, and the record's own field names, so no value fits in one (#17 PR 4c)", () => {
    const op = (/** @type {unknown} */ value) =>
      accepts(changeRecord, { seq: 1, entityType: 'note', entityId: 'n1', revision: 1, opId: 'c1', ops: [value] });
    for (const value of [
      { op: 'createNote' },
      { op: 'deleteNote' },
      { op: 'moveBlock', blockId: 'b1' },
      { op: 'deleteBlock', blockId: 'b1' },
      { op: 'createFolder' },
      { op: 'updateFolder', fields: ['collapsed'] },
      { op: 'deleteFolder' },
    ]) {
      assert.equal(op(value), true, JSON.stringify(value));
    }
    for (const value of [
      // A value, a field the schema doesn't name, an op it doesn't know, or an empty list
      { op: 'updateNote', fields: ['name'], name: 'Plan' },
      { op: 'updateBlock', blockId: 'b1', content: 'text' },
      { op: 'updateNote', fields: ['Plans for Tuesday'] },
      { op: 'updateNote', fields: ['revision'] },
      { op: 'updateNote', fields: ['updatedAt'] },
      { op: 'updateNote', fields: [] },
      { op: 'updateFolder', fields: ['name', 'pinned'] },
      { op: 'insertBlock', blockId: '' },
      { op: 'insertBlock', blockId: 'b'.repeat(MAX_ID_LENGTH + 1) },
      { op: 'renameNote' },
      { op: 'createNote', note: { id: 'n1' } },
    ]) {
      assert.equal(op(value), false, JSON.stringify(value));
    }
    // Nothing in a change record is content
    assert.deepEqual(v.getMetadata(changeRecord.entries.ops), {});
    assert.ok(
      NOTE_OP_FIELDS.includes('name') && !NOTE_OP_FIELDS.includes('id') && !NOTE_OP_FIELDS.includes('updatedAt'),
    );
    assert.deepEqual([...FOLDER_OP_FIELDS], ['collapsed', 'color', 'createdAt', 'name', 'parentId']);
  });
});

describe('settings schemas', () => {
  it('take every preference the kernel owns, with the defaults first run writes, and no other key', () => {
    assert.deepEqual(Object.keys(preferenceValues.entries), [...PREFERENCE_KEYS]);
    assert.equal(accepts(preferenceValues, DEFAULT_PREFERENCES), true);
    assert.equal(accepts(preferenceValues, { dailyNoteTemplate: '' }), true);
    assert.equal(accepts(preferenceValues, { dailyNoteTemplate: 'n1' }), true);
    for (const values of [{ llmApiKey: 'x' }, { theme: 5 }, { trashRetention: -1 }, { theme: 'x'.repeat(257) }]) {
      assert.equal(accepts(preferenceValues, values), false, JSON.stringify(values));
    }
  });

  it('take the workspace session TabController saves', () => {
    assert.deepEqual(Object.keys(workspaceSession.entries), [...WORKSPACE_SESSION_KEYS]);
    const session = {
      openTabs: [{ noteId: 'n1', title: 'Plan' }],
      activeTabIndex: 0,
      splitViewEnabled: false,
      secondaryNoteId: null,
      lastOpenedNoteId: 'n1',
    };
    assert.equal(accepts(workspaceSession, session), true);
    assert.equal(accepts(workspaceSession, { openTabs: null }), true);
    assert.equal(accepts(workspaceSession, { activeTabIndex: 'first' }), false);
    assert.equal(accepts(workspaceSession, { openTabs: [{ title: 'no note' }] }), false);
    assert.equal(accepts(workspaceSession, { theme: 'dark' }), false);
  });
});

describe('outcome schemas (#13, "Outcomes and authorization")', () => {
  it("accept every outcome #12's helpers make, a bulk outcome, and every query state", () => {
    assert.ok(outcomeTypesMatch && bulkTypesMatch && failedTypesMatch && captureTypesMatch);
    assert.ok(sessionTypesMatch && sessionKeysMatch);
    const outcomes = [
      committed('note-created', ['n1'], { revision: 1, commitSeq: 4 }),
      committed('title-kept', [], { severity: 'info' }),
      rejected('validation', 'invalid-payload'),
      rejected('policy', 'forbidden-for-surface'),
      rejected('not-found', 'note-not-found'),
      conflict('revision-conflict', 3),
      unavailable('coordinator', 'deadline-exceeded', true),
      unknown('outcome-unknown', 'c1'),
    ];
    for (const outcome of outcomes) {
      assert.equal(accepts(outcomeSchema, outcome), true, outcome.code);
      assert.equal(accepts(bulkResultSchema, outcome), true, outcome.code);
    }
    const items = bulk('trash', [
      { id: 'a', outcome: committed('note-trashed', ['a']) },
      { id: 'b', outcome: rejected('not-found', 'note-not-found') },
    ]);
    assert.equal(accepts(bulkOutcomeSchema, items), true);
    assert.equal(accepts(bulkResultSchema, items), true);
    assert.equal(accepts(outcomeSchema, items), false, 'a plain command never answers with a bulk outcome');
    const states = queryStateSchema(v.array(noteRecord));
    for (const state of [
      loading(),
      ready(NOW, [{ id: 'n1' }]),
      empty(NOW),
      stale(NOW, []),
      failed('coordinator', 'unavailable'),
    ]) {
      assert.equal(accepts(states, state), true, state.kind);
    }
    assert.equal(accepts(states, ready(NOW, [{ name: 'no id' }])), false);
  });

  it('leave no room for content: an extra field, a messageKey that is not kind.code, or an unknown cause fails', () => {
    const note = committed('note-created', ['n1']);
    assert.equal(accepts(outcomeSchema, { ...note, title: 'Plan' }), false);
    assert.equal(accepts(outcomeSchema, { ...note, messageKey: 'Your note "Plan" was saved' }), false);
    assert.equal(accepts(outcomeSchema, { ...unavailable('storage', 'blocked', true), cause: 'disk' }), false);
    assert.equal(accepts(outcomeSchema, { ...rejected('policy', 'not-on-surface'), reason: 'other' }), false);
    assert.equal(accepts(outcomeSchema, { ...note, code: 'Saved Plan' }), false);
    assert.equal(accepts(failedSchema, { ...failed('storage', 'x'), detail: 'stack' }), false);
  });
});
