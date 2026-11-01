// #17 PR 3a's placement, kind, and lifecycle (js/kernel/core/domain/placement.js): the group
// #17's transform derives from a 1.4.x note's flags, held to #1's placementOf
// (js/product/placement.js) for every combination of flags, and the rules the kernel's commands
// keep it in step by.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLACEMENT_FIELDS,
  hasPlacementGroup,
  isDateKey,
  isPlacement,
  kindOf,
  lifecycleOf,
  placementFindingsOf,
  placementGroupOf,
  withNewPlacement,
  withPlacementGroup,
  withoutPlacement,
} from '../../js/kernel/core/domain/placement.js';
import { isDateKey as productIsDateKey, placementOf } from '../../js/product/placement.js';
import { NOW } from './support.mjs';

const LIVE = new Set(['f-live']);

/**
 * Every combination of the flags placement reads, each value a 1.4.x record can hold for it,
 * absent included
 * @returns {Array<Record<string, unknown>>}
 */
function everyNote() {
  /** @type {Record<string, unknown[]>} */
  const values = {
    folderId: [undefined, null, '', 'f-live', 'f-gone', 7],
    isDaily: [undefined, false, true, 'yes'],
    dateStr: [undefined, null, '2026-10-20', '2026-02-30', '20-10-2026', 42],
    name: [undefined, '', '  ', 'Untitled', 'untitled 3', 'Untitled draft', 'Plan', 42],
    isTemplate: [undefined, false, true],
    archived: [undefined, false, true],
    trashed: [undefined, false, true],
  };
  /** @type {Array<Record<string, unknown>>} */
  let notes = [{ id: 'n', createdAt: NOW }];
  for (const [field, options] of Object.entries(values)) {
    notes = notes.flatMap(note =>
      options.map(value => {
        const next = { ...note };
        if (value !== undefined) next[field] = value;
        return next;
      }),
    );
  }
  return notes;
}

describe("the group the transform derives, held to #1's placementOf", () => {
  it('placementGroupOf gives the placement placementOf gives, and kind and lifecycle from its states, for every combination of flags', () => {
    const notes = everyNote();
    assert.ok(notes.length > 10000, `${notes.length} combinations`);
    for (const note of notes) {
      const product = placementOf(/** @type {any} */ (note), LIVE);
      const group = placementGroupOf(note, LIVE);
      const label = JSON.stringify(note);
      assert.deepEqual(group.placement, product.placement, label);
      assert.equal(group.kind, product.states.template ? 'template' : 'note', label);
      assert.equal(
        group.lifecycle,
        product.states.trashed ? 'trashed' : product.states.archived ? 'archived' : 'active',
        label,
      );
      // #1's findings but the UTC key, which is #17 PR 3b's, in its order
      assert.deepEqual(
        placementFindingsOf(note, LIVE),
        product.findings.map(finding => finding.code).filter(code => code !== 'daily-utc-key'),
        label,
      );
      assert.equal(isPlacement(group.placement), true, label);
    }
  });

  it("isDateKey is #1's: a YYYY-MM-DD key naming a real calendar date", () => {
    const values = [
      '2026-10-20',
      '2024-02-29',
      '2023-02-29',
      '1900-02-29',
      '2000-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-4-01',
      ' 2026-10-20',
      '',
      null,
      undefined,
      20261020,
      new Date(NOW),
    ];
    for (const value of values) assert.equal(isDateKey(value), productIsDateKey(value), String(value));
  });

  it('a note is in the trash before the archive, and a template is a template wherever it is', () => {
    assert.equal(lifecycleOf({ trashed: true, archived: true }), 'trashed');
    assert.equal(lifecycleOf({ archived: 1 }), 'archived');
    assert.equal(lifecycleOf({}), 'active');
    assert.equal(kindOf(/** @type {Record<string, unknown>} */ ({ isTemplate: true, isDaily: true })), 'template');
    assert.equal(kindOf({ isTemplate: 0 }), 'note');
  });

  it('isPlacement takes the three kinds as #1 has them, and nothing else', () => {
    for (const value of [
      { kind: 'inbox' },
      { kind: 'collection', folderId: null },
      { kind: 'collection', folderId: 'f1' },
      { kind: 'daily', dateKey: '2026-10-20' },
    ]) {
      assert.equal(isPlacement(value), true, JSON.stringify(value));
      assert.equal(hasPlacementGroup({ placement: value }), true, JSON.stringify(value));
    }
    for (const value of [
      undefined,
      null,
      'inbox',
      {},
      { kind: 'collection' },
      { kind: 'collection', folderId: 7 },
      { kind: 'daily' },
      { kind: 'daily', dateKey: '2026-02-30' },
      { kind: 'moment' },
    ]) {
      assert.equal(isPlacement(value), false, JSON.stringify(value));
      assert.equal(hasPlacementGroup({ placement: value }), false, JSON.stringify(value));
    }
  });
});

describe('the group the kernel writes and keeps in step', () => {
  it("withNewPlacement files a new note in its folder's collection, a Daily Note under its date, and any other in Unfiled, never in Inbox (Q3)", () => {
    assert.deepEqual(withNewPlacement({ id: 'n', folderId: 'f1' }), {
      id: 'n',
      folderId: 'f1',
      placement: { kind: 'collection', folderId: 'f1' },
      kind: 'note',
      lifecycle: 'active',
    });
    assert.deepEqual(withNewPlacement({ id: 'd', folderId: null, isDaily: true, dateStr: '2026-10-20' }).placement, {
      kind: 'daily',
      dateKey: '2026-10-20',
    });
    for (const fields of [{ folderId: null, name: 'Untitled' }, { folderId: null, name: 'Plan' }, {}]) {
      assert.deepEqual(withNewPlacement({ id: 'n', ...fields }).placement, { kind: 'collection', folderId: null });
    }
  });

  it('withPlacementGroup leaves a note without its group as it is, for the transform to fill from the flags then', () => {
    const after = { id: 'n', folderId: 'f1', archived: true };
    assert.equal(withPlacementGroup({ id: 'n', folderId: null }, after), after);
  });

  it('withPlacementGroup follows the flags: kind and lifecycle always, and the placement only when the folder or the daily state moved', () => {
    const inbox = {
      id: 'n',
      name: 'Untitled',
      folderId: null,
      placement: { kind: 'inbox' },
      kind: 'note',
      lifecycle: 'active',
    };
    // A pin, an archive, or a trash keeps the transform's Inbox
    assert.deepEqual(withPlacementGroup(inbox, { ...inbox, archived: true }), {
      ...inbox,
      archived: true,
      lifecycle: 'archived',
    });
    assert.deepEqual(withPlacementGroup(inbox, { ...inbox, trashed: true, archived: true }).lifecycle, 'trashed');
    assert.deepEqual(withPlacementGroup(inbox, { ...inbox, isTemplate: true }).kind, 'template');
    // A 1.4.x record without folderId, moved to the root, hasn't moved
    const legacy = { id: 'n', name: 'Plan', placement: { kind: 'inbox' }, kind: 'note', lifecycle: 'active' };
    assert.deepEqual(withPlacementGroup(legacy, { ...legacy, folderId: null }).placement, { kind: 'inbox' });
    // A move to a folder, and out of it, which goes to Unfiled, not back to Inbox
    const filed = withPlacementGroup(inbox, { ...inbox, folderId: 'f1' });
    assert.deepEqual(filed.placement, { kind: 'collection', folderId: 'f1' });
    assert.deepEqual(withPlacementGroup(filed, { ...filed, folderId: null }).placement, {
      kind: 'collection',
      folderId: null,
    });
    // A Daily Note out of its folder goes back under its date
    const daily = { ...filed, isDaily: true, dateStr: '2026-10-20' };
    assert.deepEqual(withPlacementGroup(daily, { ...daily, folderId: null }).placement, {
      kind: 'daily',
      dateKey: '2026-10-20',
    });
  });

  it('withoutPlacement takes exactly the fields PLACEMENT_FIELDS names, and leaves every flag', () => {
    const note = withNewPlacement({ id: 'n', name: 'Plan', folderId: 'f1', archived: true, isTemplate: false });
    for (const field of PLACEMENT_FIELDS) assert.ok(field in note, field);
    assert.deepEqual(withoutPlacement(note), {
      id: 'n',
      name: 'Plan',
      folderId: 'f1',
      archived: true,
      isTemplate: false,
    });
    assert.deepEqual(PLACEMENT_FIELDS, ['placement', 'kind', 'lifecycle']);
  });
});
