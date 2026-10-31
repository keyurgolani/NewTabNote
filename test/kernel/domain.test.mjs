// The domain rules the use cases apply, case by case, as storage.js and background.js have
// applied them since 1.4.0.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createsCycle } from '../../js/kernel/core/domain/folder.js';
import {
  blocksFromTemplate,
  captureBlock,
  dailyDateStr,
  dailyNoteName,
  findDailyNote,
  inBlockOrder,
  isEmpty,
  isUntitled,
  notesInView,
} from '../../js/kernel/core/domain/note.js';
import { sessionIssue } from '../../js/kernel/core/domain/session.js';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/kernel/core/domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../../js/kernel/core/domain/note.js').BlockRecord} BlockRecord */

/**
 * @param {string} id
 * @param {Partial<NoteRecord>} [fields]
 * @returns {NoteRecord}
 */
const note = (id, fields = {}) => ({ id, name: id, updatedAt: NOW, ...fields });

/**
 * @param {Record<string, unknown>} fields
 * @returns {BlockRecord}
 */
const block = fields => ({ id: 'b', canvasId: 'n', type: 'text', ...fields });

describe('notes', () => {
  it('isUntitled: no name, blank, or "Untitled" with an optional number', () => {
    for (const name of [undefined, '', '  ', 'Untitled', ' untitled ', 'Untitled 3', 'untitled12']) {
      assert.equal(isUntitled(note('n', { name })), true, JSON.stringify(name));
    }
    for (const name of ['Plan', 'Untitled draft', 'Untitled-2'])
      assert.equal(isUntitled(note('n', { name })), false, name);
    // A name it can't read counts as a title, so trashing can't delete the note
    assert.equal(isUntitled(note('n', { name: /** @type {any} */ (42) })), false);
  });

  it('isEmpty: every block a text block of spaces, line breaks, and non-breaking spaces', () => {
    assert.equal(isEmpty([]), true);
    assert.equal(
      isEmpty([block({ content: '' }), block({ content: ' <br>&nbsp;<BR/>\n&NBSP;<br />' }), block({ content: null })]),
      true,
    );
    // A block with no type is a text block, and only its content counts
    assert.equal(isEmpty([block({ type: undefined, content: ' ', imageUrl: 'data:,', checked: true })]), true);
    for (const filled of [
      { content: 'x' },
      { content: '<p> </p>' },
      { content: '<b></b>' },
      { content: '<img src="data:,">' },
      { content: { ops: [] } },
      { content: 5 },
      { type: 'image', content: '' },
      { type: 'table', content: '' },
      { type: 'divider' },
      { type: 'bookmark', content: '' },
    ]) {
      assert.equal(isEmpty([block({ content: '', ...filled })]), false, JSON.stringify(filled));
    }
  });

  it('notesInView lists each view in the order Storage reads it, without notes lacking updatedAt', () => {
    const notes = [
      note('b', { updatedAt: NOW }),
      note('a', { updatedAt: NOW }),
      note('newest', { updatedAt: NOW + 2 }),
      note('archived', { updatedAt: NOW + 1, archived: true, archivedAt: NOW + 5 }),
      note('archivedEarlier', { updatedAt: NOW + 3, archived: true, archivedAt: NOW + 4 }),
      note('trashed', { updatedAt: NOW, trashed: true, trashedAt: NOW + 1 }),
      note('template', { updatedAt: NOW + 9, isTemplate: true }),
      note('noTime', { updatedAt: undefined }),
    ];
    const ids = /** @param {NoteRecord[]} list */ list => list.map(n => n.id);
    assert.deepEqual(ids(notesInView(notes, 'active')), ['newest', 'b', 'a']);
    assert.deepEqual(ids(notesInView(notes, 'withArchived')), ['archivedEarlier', 'newest', 'archived', 'b', 'a']);
    assert.deepEqual(ids(notesInView(notes, 'archived')), ['archived', 'archivedEarlier']);
    assert.deepEqual(ids(notesInView(notes, 'trashed')), ['trashed']);
    assert.deepEqual(ids(notesInView(notes, 'templates')), ['template']);
  });

  it('notesInView lists what Popup and Side Panel have always read: no archivedAt or trashedAt, and every indexed note', () => {
    const notes = [
      note('flags', { updatedAt: NOW + 4, archived: true, trashed: true }),
      note('archived', { updatedAt: NOW + 3, archived: true, archivedAt: NOW + 3 }),
      note('template', { updatedAt: NOW + 2, isTemplate: true }),
      note('trashed', { updatedAt: NOW + 1, trashed: true, trashedAt: NOW + 1 }),
      note('b', { updatedAt: NOW }),
      note('a', { updatedAt: NOW }),
      note('noTime', { updatedAt: undefined }),
    ];
    const ids = /** @param {NoteRecord[]} list */ list => list.map(n => n.id);
    assert.deepEqual(ids(notesInView(notes, 'popup')), ['flags', 'template', 'b', 'a']);
    assert.deepEqual(ids(notesInView(notes, 'sidePanel')), ['flags', 'archived', 'template', 'trashed', 'b', 'a']);
  });

  it('inBlockOrder sorts by order, then id', () => {
    const blocks = [block({ id: 'c', order: 1 }), block({ id: 'b', order: 0 }), block({ id: 'a', order: 1 })];
    assert.deepEqual(
      inBlockOrder(blocks).map(b => b.id),
      ['b', 'a', 'c'],
    );
  });
});

describe('Daily Notes', () => {
  it('names the note after the local date and keys it by the UTC date, as background.js always has', () => {
    assert.equal(dailyDateStr(NOW), '2026-10-20');
    assert.equal(dailyNoteName(NOW), 'Daily Note - Oct 20, 2026');
  });

  it("finds today's Daily Note among archived notes too, but not in the trash or among templates", () => {
    const today = { isDaily: true, dateStr: '2026-10-20' };
    assert.equal(
      findDailyNote([note('t', { ...today, trashed: true }), note('x', { isDaily: true, dateStr: '2026-10-19' })], NOW),
      undefined,
    );
    assert.equal(findDailyNote([note('a', { ...today, archived: true })], NOW)?.id, 'a');
    assert.equal(findDailyNote([note('tpl', { ...today, isTemplate: true })], NOW), undefined);
  });

  it('copies template blocks with new ids and the variables filled in, tables included', () => {
    let next = 0;
    const [copy] = blocksFromTemplate(
      [
        block({
          id: 't1',
          canvasId: 'tpl',
          content: '{{title}} at {{time}} on {{date}} ({{datetime}})',
          tableData: [['{{title}}', 3]],
        }),
      ],
      { noteId: 'd1', title: 'Daily', now: NOW, nextId: () => `new-${++next}` },
    );
    const date = new Date(NOW);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    assert.deepEqual(copy, {
      id: 'new-1',
      canvasId: 'd1',
      type: 'text',
      content: `Daily at ${time} on ${date.toLocaleDateString()} (${date.toLocaleString()})`,
      tableData: [['Daily', 3]],
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('builds the captured block background.js builds, with its capture time as createdAt and updatedAt (#17 PR 2a)', () => {
    assert.deepEqual(
      captureBlock({ id: 'c1', noteId: 'd1', now: NOW, capture: { type: 'bookmark', url: 'u', title: 't' } }),
      {
        id: 'c1',
        type: 'bookmark',
        content: '',
        url: 'u',
        title: 't',
        canvasId: 'd1',
        order: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    );
    assert.deepEqual(captureBlock({ id: 'c2', noteId: 'd1', now: NOW, capture: { type: 'text', content: 'Quote' } }), {
      id: 'c2',
      type: 'text',
      content: 'Quote',
      canvasId: 'd1',
      order: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
});

describe('folders and the session', () => {
  it('createsCycle: the folder itself, a descendant, or a parent chain that already loops', () => {
    const folders = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
      { id: 'z', parentId: null },
    ];
    for (const parentId of ['a', 'b', 'c']) assert.equal(createsCycle(folders, 'a', parentId), true, parentId);
    assert.equal(createsCycle(folders, 'z', 'x'), true);
    for (const parentId of [null, 'z', 'missing'])
      assert.equal(createsCycle(folders, 'a', parentId), false, String(parentId));
    assert.equal(createsCycle(folders, 'c', 'a'), false);
  });

  it('sessionIssue names the first key the session lacks or has the wrong type for', () => {
    assert.equal(
      sessionIssue({ openTabs: [{ noteId: 'n1' }], activeTabIndex: 0, splitViewEnabled: false, secondaryNoteId: null }),
      null,
    );
    assert.equal(sessionIssue({ openTabs: [{ name: 'x' }] }), 'openTabs');
    assert.equal(sessionIssue({ activeTabIndex: 1.5 }), 'activeTabIndex');
    assert.equal(sessionIssue({ lastOpenedNoteId: '' }), 'lastOpenedNoteId');
    assert.equal(sessionIssue({ theme: 'dark' }), 'theme');
  });
});
