// #13's schemas for what payloads and projections carry (contracts/fields.js, entities.js,
// settings.js, and outcome-schemas.js). A schema's type comes from the schema, and the
// `Equal` checks below hold each one to the typedef #12 wrote by hand: `npm run
// typecheck:kernel` fails when they drift apart.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import {
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
 * @param {v.GenericSchema} schema
 * @param {unknown} value
 */
const accepts = (schema, value) => v.safeParse(schema, value).success;

describe('fields', () => {
  it('ids are non-empty strings up to MAX_ID_LENGTH, and an entity id says what it names', () => {
    assert.equal(accepts(id, 'n1'), true);
    assert.equal(accepts(id, 'x'.repeat(MAX_ID_LENGTH)), true);
    for (const bad of ['', 'x'.repeat(MAX_ID_LENGTH + 1), 5, null]) assert.equal(accepts(id, bad), false, String(bad));
    assert.deepEqual(ENTITY_TYPES, ['note', 'block', 'folder']);
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
    const change = { seq: 1, entityType: 'note', entityId: 'n1', revision: 2, opId: 'c1', ops: [{ op: 'put' }] };
    assert.equal(accepts(changeRecord, change), true);
    assert.equal(accepts(changeRecord, { ...change, seq: 0 }), false);
    assert.equal(accepts(changeRecord, { ...change, entityType: 'tab' }), false);
    assert.deepEqual(v.getMetadata(changeRecord.entries.ops), { content: true });
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
