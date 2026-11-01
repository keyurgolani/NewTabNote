// The recovered note (#33, the stack's close-time PR; domain/recovered-note.js): 1.4.3's look,
// words and placement as the Design gate approved them, every string pinned, on the residue a
// draft leaves, with its dates en-US in the clock's zone (the lead's Q8), and the toast's words,
// V3's for a note in the Trash included.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { recoveredIdOf } from '../../js/kernel/core/domain/close-draft.js';
import { noteSaveMetadata } from '../../js/kernel/core/domain/note.js';
import { TEXT, recoveredNote } from '../../js/kernel/core/domain/recovered-note.js';
import { legacyEnv } from './storage-fixture.mjs';

/** @typedef {import('../../js/kernel/core/domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {import('../../js/kernel/core/domain/close-draft.js').Residue} Residue */
/** @typedef {any} Row */

const T0 = 1700000000000;
const NOW = T0 + 100;
/** When the closing tab closed: Oct 31, 2026, 9:41 PM UTC */
const AT = Date.UTC(2026, 9, 31, 21, 41);

/** @type {(id: string, fields?: Row) => Row} */
const note = (id, fields) => legacyEnv.note(id, fields);
/** @type {(id: string, canvasId: string, order: number, content?: string, fields?: Row) => Row} */
const block = (id, canvasId, order, content, fields) => legacyEnv.block(id, canvasId, order, content, fields);

const RECOVERED_A = 'Recovered: Alpha plan (Oct\u00a031,\u00a09:41\u00a0PM)';
const CLOSED_A = 'These changes to “Alpha plan” are from a tab that closed on Oct 31, 2026 at 9:41 PM, before they were saved.';
const SAVED_ELSEWHERE = 'That note was saved elsewhere too, so NewTabNote kept the changes here and left it as it is.';
const ONLY_CHANGED = 'Below are only the blocks that tab changed.';
const COPY = 'Copy what you need into that note, then delete this one.';
const RENAMED = 'A tab that closed on Oct 31, 2026 at 9:41 PM renamed “Alpha plan” to “Alpha plan, renamed” before the new name was saved.';

/** @type {CloseDraft} */
const DRAFT = /** @type {CloseDraft} */ ({
  v: 1,
  id: 'draft-1',
  noteId: 'A',
  at: AT,
  base: { revision: 0, updatedAt: T0, issued: [] },
  blocks: [],
  deletedBlockIds: [],
});

/**
 * The recovered note for a residue over note A, `a`'s fields on it
 * @param {{a?: Row, residue?: Partial<Residue>, zone?: string, trashDays?: number, inFolder?: boolean}} [spec]
 */
function recover({ a = {}, residue = {}, zone = 'UTC', trashDays = 30, inFolder = true } = {}) {
  const original = note('A', { name: 'Alpha plan', updatedAt: T0 + 5, ...a });
  /** @type {Residue} */
  const full = {
    blocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed', { updatedAt: T0 + 5 })],
    deletedBlockIds: [],
    name: undefined,
    ...residue,
  };
  return recoveredNote(/** @type {any} */ (original), full, DRAFT, { now: NOW, zone, trashDays, inFolder });
}

describe('the recovered note, as the Design gate approved it', () => {
  it("its title is the original's and the edit's time, whose date wraps as one unit, in the clock's zone", () => {
    assert.equal(recover().note.name, RECOVERED_A);
    const untitled = recover({ a: { name: '' } });
    assert.equal(untitled.note.name, 'Recovered: Untitled (Oct\u00a031,\u00a09:41\u00a0PM)', 'named as the list names it');
    assert.equal(
      String(untitled.blocks[0].content).split('. ')[0],
      'These changes to “Untitled” are from a tab that closed on Oct 31, 2026 at 9:41 PM, before they were saved',
    );
    const pacific = recover({ zone: 'America/Los_Angeles' });
    assert.equal(pacific.note.name, 'Recovered: Alpha plan (Oct\u00a031,\u00a02:41\u00a0PM)');
    assert.match(String(pacific.blocks[0].content), /^These changes to “Alpha plan” are from a tab that closed on Oct 31, 2026 at 2:41 PM,/);
  });

  it('is its id, its title set by hand, and an ordinary note: never a Daily Note or a template', () => {
    const { note: made } = recover({ a: { isDaily: true, dateStr: '2026-10-31', isTemplate: false } });
    assert.deepEqual(
      [made.id, made.titleManuallySet, made.isDaily, made.dateStr, made.isTemplate],
      [recoveredIdOf(DRAFT), true, false, null, false],
    );
  });

  it("sits in the original's folder while that folder exists, and in none once it's gone", () => {
    assert.equal(recover({ a: { folderId: 'F' } }).note.folderId, 'F');
    assert.equal(recover({ a: { folderId: 'F' }, inFolder: false }).note.folderId, null);
  });

  it("has the original's pin, except a template's or a trashed note's", () => {
    assert.equal(recover({ a: { pinned: true } }).note.pinned, true);
    assert.equal(recover({ a: { pinned: true, isTemplate: true } }).note.pinned, false);
    assert.equal(recover({ a: { pinned: true, trashed: true, trashedAt: T0 + 3 } }).note.pinned, false);
  });

  it("sorts right under the original: its times 1 ms before the original's, and archived with an archived original 1 ms before it", () => {
    const { note: made } = recover({ a: { createdAt: T0 - 50, archived: true, archivedAt: T0 + 3 } });
    assert.deepEqual(
      [made.createdAt, made.updatedAt, made.archived, made.archivedAt, made.trashed],
      [T0 - 51, T0 + 4, true, T0 + 2, undefined],
    );
    assert.deepEqual([made.lifecycle, made.kind], ['archived', 'note']);
  });

  it('goes in the Trash with a trashed original, from this start, and out of Archive', () => {
    const { note: made } = recover({ a: { trashed: true, trashedAt: T0 + 3, archived: true, archivedAt: T0 + 2 } });
    assert.deepEqual([made.trashed, made.trashedAt, made.archived, made.archivedAt, made.lifecycle], [true, NOW, false, null, 'trashed']);
  });

  it('a Daily Note\'s or a template\'s changes become a regular note, whose first block says which it was', () => {
    const daily = recover({ a: { isDaily: true, dateStr: '2026-10-31' } });
    assert.equal(
      daily.blocks[0].content,
      `${CLOSED_A} That Daily Note was saved elsewhere too, so NewTabNote kept the changes here as a regular note`
        + ` and left it as it is. ${ONLY_CHANGED} Copy what you need into that Daily Note, then delete this one.`,
    );
    const template = recover({ a: { isTemplate: true } });
    assert.equal(
      template.blocks[0].content,
      `${CLOSED_A} That template was saved elsewhere too, so NewTabNote kept the changes here as a regular note`
        + ` and left it as it is. ${ONLY_CHANGED} Copy what you need into that template, then delete this one.`,
    );
  });

  it("keeps the original's viewport and grid, and makes its copies at this start, in their order, under its id", () => {
    const viewport = { scale: 1.5, offsetX: 10, offsetY: -20 };
    const settings = { gridType: 'lines', backgroundColor: '#101010' };
    const { note: made, blocks } = recover({
      a: { viewport, settings },
      residue: { blocks: [block('a2', 'A', 3, 'second'), block('a1', 'A', 1, 'first')] },
    });
    assert.deepEqual([made.viewport, made.settings], [viewport, settings]);
    const id = recoveredIdOf(DRAFT);
    assert.deepEqual(
      blocks.map(row => [row.id, row.canvasId, row.order, row.type, row.createdAt, row.updatedAt]),
      [
        [`${id}-0`, id, 0, 'callout', NOW, NOW],
        [`${id}-1`, id, 1, 'text', NOW, NOW],
        [`${id}-2`, id, 2, 'text', NOW, NOW],
      ],
    );
    assert.deepEqual(blocks.slice(1).map(row => row.content), ['first', 'second']);
    assert.equal(blocks[0].calloutIcon, 'ℹ️');
  });

  it('names the original once, and says what else that tab did: its deletes still there, and a new title', () => {
    const { blocks } = recover({ residue: { deletedBlockIds: ['a2', 'a3'], name: 'Alpha plan, renamed' } });
    assert.equal(
      blocks[0].content,
      `${CLOSED_A} ${SAVED_ELSEWHERE} ${ONLY_CHANGED} That tab also deleted 2 blocks, which are still in that note.`
        + ` That tab also renamed it “Alpha plan, renamed”. ${COPY}`,
    );
    const one = recover({ residue: { deletedBlockIds: ['a2'] } });
    assert.equal(one.blocks[0].content, `${CLOSED_A} ${SAVED_ELSEWHERE} ${ONLY_CHANGED} That tab also deleted a block, which is still in that note. ${COPY}`);
    const cleared = recover({ residue: { name: '' } });
    assert.equal(cleared.blocks[0].content, `${CLOSED_A} ${SAVED_ELSEWHERE} ${ONLY_CHANGED} ${COPY}`, 'a cleared title is no new title');
  });

  it("escapes the first block's text, quotes too, and the list shows it as a save would", () => {
    const { note: made, blocks } = recover({
      a: { name: 'Q&A <b>"plan"</b>' },
      residue: { blocks: [block('t1', 'A', 4, 'Book the room', { type: 'todo', checked: true }), block('t2', 'A', 5, 'Send the notes', { type: 'todo' })] },
    });
    assert.equal(
      String(blocks[0].content).split('. ')[0],
      'These changes to “Q&amp;A &lt;b&gt;&quot;plan&quot;&lt;/b&gt;” are from a tab that closed on Oct 31, 2026 at 9:41 PM, before they were saved',
    );
    const meta = noteSaveMetadata(/** @type {any} */ (blocks));
    assert.deepEqual([made.preview, made.todoProgress], [meta.preview, meta.todoProgress]);
    assert.deepEqual(made.todoProgress, { completed: 1, total: 2 });
    assert.ok(String(made.preview).endsWith('…'), 'cut as a save cuts it');
  });

  it("a residue that's only a name keeps the typed name in a recovered note, under the original's title, in words of its own (V6)", () => {
    const renamedOnly = { blocks: [], name: 'Alpha plan, renamed' };
    const withDeletes = recover({ residue: { ...renamedOnly, deletedBlockIds: ['a2'] } });
    assert.equal(withDeletes.note.name, RECOVERED_A);
    assert.deepEqual(withDeletes.blocks.map(row => row.type), ['callout']);
    assert.equal(
      withDeletes.blocks[0].content,
      `${RENAMED} That note was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.`
        + ' That tab also deleted a block, which is still in that note. To use the new name, rename that note, then delete this one.',
    );
    const alone = recover({ residue: renamedOnly });
    assert.equal(
      alone.blocks[0].content,
      `${RENAMED} That note was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.`
        + ' To use the new name, rename that note, then delete this one.',
    );
    const template = recover({ residue: renamedOnly, a: { isTemplate: true } });
    assert.equal(
      template.blocks[0].content,
      `${RENAMED} That template was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.`
        + ' To use the new name, rename that template, then delete this one.',
    );
    const trashed = recover({ residue: renamedOnly, a: { trashed: true, trashedAt: T0 + 3 }, trashDays: 7 });
    assert.equal(
      trashed.blocks[0].content,
      `${RENAMED} That note is in the Trash, so NewTabNote kept the new name here and put this note in the Trash too.`
        + ' Restore this note to keep the new name. Otherwise the Trash deletes it in 7 days.',
    );
    const kept = recover({ residue: renamedOnly, a: { trashed: true, trashedAt: T0 + 3 }, trashDays: 0 });
    assert.equal(
      kept.blocks[0].content,
      `${RENAMED} That note is in the Trash, so NewTabNote kept the new name here and put this note in the Trash too.`
        + ' Restore this note to keep the new name.',
      'with the Trash keeping notes until emptied',
    );
  });

  it('in the Trash, says how long it keeps the note, a day as "1 day", and nothing when it keeps notes until emptied', () => {
    const trashed = { trashed: true, trashedAt: T0 + 3 };
    const IN_TRASH = 'That note is in the Trash, so NewTabNote kept the changes here and put this note in the Trash too.';
    assert.equal(
      recover({ a: trashed }).blocks[0].content,
      `${CLOSED_A} ${IN_TRASH} ${ONLY_CHANGED} Restore this note to keep them. Otherwise the Trash deletes it in 30 days.`,
    );
    assert.match(String(recover({ a: trashed, trashDays: 1 }).blocks[0].content), / Restore this note to keep them\. Otherwise the Trash deletes it in 1 day\.$/);
    assert.match(String(recover({ a: trashed, trashDays: 0 }).blocks[0].content), / Restore this note to keep them\.$/);
  });
});

describe("the toast's words, after a start applied closing tabs' edits", () => {
  it('says where both notes are for a recovered note, with the title cut at 40', () => {
    /** @param {string} title @param {{archived?: boolean, trashed?: boolean}} [where] */
    const told = (title, where = {}) => ({ title, archived: false, trashed: false, ...where });
    const one = 'Kept your changes to “Alpha plan” from a closed tab in a recovered note.';
    assert.equal(TEXT.recovered([told('Alpha plan')]), one);
    assert.equal(TEXT.recovered([told('Alpha plan', { archived: true })]), `${one} Both are in Archive.`);
    assert.equal(TEXT.recovered([told('Alpha plan', { trashed: true })]), `${one} Both are in the Trash.`);
    assert.equal(TEXT.recovered([told('Alpha plan'), told('Bravo', { archived: true })]), 'Kept your changes from closed tabs in 2 recovered notes.');
    assert.equal(
      TEXT.recovered([told('Notes from the long planning meeting about the beta launch')]),
      'Kept your changes to “Notes from the long planning meeting ab…” from a closed tab in a recovered note.',
    );
  });

  it('says it saved the edit into a note in the Trash (V3), with the title cut at 40', () => {
    assert.equal(TEXT.savedInTrash(['Alpha plan']), 'Saved your changes to “Alpha plan” from a closed tab. It\'s in the Trash.');
    assert.equal(TEXT.savedInTrash(['Alpha plan', 'Bravo']), 'Saved your changes from closed tabs to 2 notes in the Trash.');
    assert.equal(
      TEXT.savedInTrash(['Notes from the long planning meeting about the beta launch']),
      'Saved your changes to “Notes from the long planning meeting ab…” from a closed tab. It\'s in the Trash.',
    );
  });
});
