// A Daily Note's key (#17 PR 3b, js/kernel/core/domain/daily.js): its local date in a zone, held
// to #1's localDateKey and its `daily-utc-key` finding; who holds a date by #17's rules, in two
// phases whatever order the notes come in, the earliest made where two claim one; and the fields
// logical 3 gives a note, which never touch its name.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignDailyKeys,
  canHoldKey,
  dailyHolder,
  holdsKey,
  localKeyIn,
  madeBefore,
  underAnswer,
  utcKeyedLocalKey,
  withAssignedKey,
} from '../../js/kernel/core/domain/daily.js';
import { DAILY_FIELDS, NEW_NOTE_FIELDS, PLACEMENT_FIELDS } from '../../js/kernel/core/domain/placement.js';
import { localDateKey, placementOf } from '../../js/product/placement.js';

const LA = 'America/Los_Angeles';
/** The host's zone, which #1's localDateKey reads in */
const HOST = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const HOUR = 60 * 60 * 1000;

/**
 * A Daily Note as 1.4.x stored one
 * @param {string} id
 * @param {string} day - the date its name gives, `Mon D`
 * @param {string} dateStr
 * @param {number} createdAt
 * @param {Record<string, unknown>} [fields]
 */
const daily = (id, day, dateStr, createdAt, fields = {}) => ({
  id,
  name: `Daily Note - ${day}, 2025`,
  isDaily: true,
  dateStr,
  createdAt,
  updatedAt: createdAt,
  ...fields,
});

/**
 * Each note's key, holder, and move, by id, sorted
 * @param {Map<string, import('../../js/kernel/core/domain/daily.js').DailyAssignment>} assigned
 */
const table = assigned =>
  Object.fromEntries([...assigned].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, one]) => [id, one]));

describe("a Daily Note's local date", () => {
  it('localKeyIn gives the date in the zone, across UTC midnight and on either side of it', () => {
    // 01:30 UTC on Oct 21: still Oct 20 in Los Angeles, Oct 21 in Kolkata and Tokyo
    const at = Date.UTC(2026, 9, 21, 1, 30);
    for (const [zone, key] of [
      [LA, '2026-10-20'],
      ['UTC', '2026-10-21'],
      ['Asia/Kolkata', '2026-10-21'],
      ['Asia/Tokyo', '2026-10-21'],
      ['Pacific/Honolulu', '2026-10-20'],
    ]) {
      assert.equal(localKeyIn(at, zone), key, zone);
    }
    // 23:30 UTC on Dec 31: New Year's Day in Tokyo, a year earlier still in Los Angeles
    const late = Date.UTC(2026, 11, 31, 23, 30);
    assert.deepEqual([localKeyIn(late, LA), localKeyIn(late, 'Asia/Tokyo')], ['2026-12-31', '2027-01-01']);
  });

  it("localKeyIn in the host's zone is #1's localDateKey, through two years and both DST changes", () => {
    const start = Date.UTC(2025, 0, 1);
    // An odd step, so the times fall at every hour and minute of the day in turn
    for (let at = start; at < start + 730 * 24 * HOUR; at += 7 * HOUR + 17 * 60 * 1000) {
      assert.equal(localKeyIn(at, HOST), localDateKey(at), new Date(at).toISOString());
    }
  });

  it("utcKeyedLocalKey is #1's daily-utc-key finding, for notes made at every hour, named or renamed", () => {
    const start = Date.UTC(2025, 9, 1);
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    let checked = 0;
    for (let at = start; at < start + 72 * HOUR; at += 53 * 60 * 1000) {
      const utc = new Date(at).toISOString().slice(0, 10);
      const local = localDateKey(at);
      const date = new Date(at);
      const name = `Daily Note - ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      for (const dateStr of [utc, local, `2025-10-${pad(date.getUTCDate() + 1)}`]) {
        for (const named of [name, 'Groceries']) {
          const note = { id: 'n', name: named, isDaily: true, dateStr, createdAt: at };
          const finding = placementOf(note, new Set()).findings.find(found => found.code === 'daily-utc-key');
          assert.equal(
            utcKeyedLocalKey(note, HOST),
            finding && finding.code === 'daily-utc-key' ? finding.localKey : null,
            `${new Date(at).toISOString()} ${dateStr} ${named}`,
          );
          checked += 1;
        }
      }
    }
    assert.ok(checked > 400, `${checked} notes`);
  });

  it("utcKeyedLocalKey takes the date the untouched name gives, else createdAt's in the zone, and is null for any other note", () => {
    // Made at 19:00 on Oct 7 in Los Angeles, keyed by Oct 8, 1.4.x's UTC date
    const evening = daily('e', 'Oct 7', '2025-10-08', Date.UTC(2025, 9, 8, 2));
    assert.equal(utcKeyedLocalKey(evening, LA), '2025-10-07');
    assert.equal(utcKeyedLocalKey(evening, 'Asia/Tokyo'), '2025-10-07', 'the name wins over the zone');
    assert.equal(utcKeyedLocalKey({ ...evening, name: 'Plans' }, LA), '2025-10-07');
    assert.equal(utcKeyedLocalKey({ ...evening, name: 'Plans' }, 'UTC'), null, "createdAt's UTC date is its key");
    // Keyed by its own date, made by the calendar ahead of its day, not daily, or without a usable time
    assert.equal(utcKeyedLocalKey(daily('m', 'Oct 8', '2025-10-08', Date.UTC(2025, 9, 8, 17)), LA), null);
    assert.equal(utcKeyedLocalKey(daily('c', 'Oct 12', '2025-10-12', Date.UTC(2025, 9, 5, 19)), LA), null);
    assert.equal(utcKeyedLocalKey({ ...evening, isDaily: false }, LA), null);
    for (const createdAt of [undefined, NaN, Infinity, 9e15, '2025-10-08']) {
      assert.equal(utcKeyedLocalKey({ ...evening, createdAt }, LA), null, String(createdAt));
    }
    assert.equal(utcKeyedLocalKey({ ...evening, dateStr: '2025-13-08' }, LA), null);
  });
});

describe('who holds a date (assignDailyKeys, #17 Q1 and Q7)', () => {
  it('moves each evening-made note to the date its name gives, earliest made first, when no other holds it', () => {
    const notes = [
      daily('oct-7-evening', 'Oct 7', '2025-10-08', Date.UTC(2025, 9, 8, 2)),
      daily('oct-8-evening', 'Oct 8', '2025-10-09', Date.UTC(2025, 9, 9, 3)),
    ];
    assert.deepEqual(table(assignDailyKeys(notes, LA)), {
      'oct-7-evening': { dailyKey: '2025-10-07', rekeyed: true, duplicateOf: null },
      'oct-8-evening': { dailyKey: '2025-10-08', rekeyed: true, duplicateOf: null },
    });
  });

  it('keeps a note where 1.4.x showed it when another holds its local date, and every note of a date a race made twice names the earliest', () => {
    const notes = [
      daily('oct-10-a', 'Oct 10', '2025-10-10', Date.UTC(2025, 9, 10, 17)),
      daily('oct-10-b', 'Oct 10', '2025-10-10', Date.UTC(2025, 9, 10, 17, 0, 1)),
      daily('oct-10-evening', 'Oct 10', '2025-10-11', Date.UTC(2025, 9, 11, 3)),
      // Made at the same moment as oct-10-a, so the lower id holds
      daily('oct-10-0', 'Oct 10', '2025-10-10', Date.UTC(2025, 9, 10, 17)),
    ];
    assert.deepEqual(table(assignDailyKeys(notes, LA)), {
      'oct-10-0': { dailyKey: '2025-10-10', rekeyed: false, duplicateOf: null },
      'oct-10-a': { dailyKey: '2025-10-10', rekeyed: false, duplicateOf: 'oct-10-0' },
      'oct-10-b': { dailyKey: '2025-10-10', rekeyed: false, duplicateOf: 'oct-10-0' },
      'oct-10-evening': { dailyKey: '2025-10-11', rekeyed: false, duplicateOf: null },
    });
  });

  it('an evening note that stays where 1.4.x showed it takes no date from the note made for that date', () => {
    // Oct 19's own note holds Oct 19, so the one made that evening stays on Oct 20, which the
    // note the calendar made for Oct 20 holds: it's that one's duplicate there
    const notes = [
      daily('oct-19', 'Oct 19', '2025-10-19', Date.UTC(2025, 9, 19, 16)),
      daily('oct-19-evening', 'Oct 19', '2025-10-20', Date.UTC(2025, 9, 20, 4)),
      daily('oct-20', 'Oct 20', '2025-10-20', Date.UTC(2025, 9, 20, 16)),
    ];
    assert.deepEqual(table(assignDailyKeys(notes, LA)), {
      'oct-19': { dailyKey: '2025-10-19', rekeyed: false, duplicateOf: null },
      'oct-19-evening': { dailyKey: '2025-10-20', rekeyed: false, duplicateOf: 'oct-20' },
      'oct-20': { dailyKey: '2025-10-20', rekeyed: false, duplicateOf: null },
    });
  });

  it('every move comes before any note stays, so one that stays never keeps a later evening note off its own date', () => {
    // Daily opened every morning and evening in 1.4.x: Oct 27's morning note, then each
    // evening's, which 1.4.x keyed by the next day and the next morning opened again
    const notes = [
      daily('oct-27', 'Oct 27', '2025-10-27', Date.UTC(2025, 9, 27, 16)),
      daily('oct-27-evening', 'Oct 27', '2025-10-28', Date.UTC(2025, 9, 28, 3)),
      daily('oct-28-evening', 'Oct 28', '2025-10-29', Date.UTC(2025, 9, 29, 2)),
      daily('oct-29-evening', 'Oct 29', '2025-10-30', Date.UTC(2025, 9, 30, 2)),
    ];
    assert.deepEqual(table(assignDailyKeys(notes, LA)), {
      'oct-27': { dailyKey: '2025-10-27', rekeyed: false, duplicateOf: null },
      // Its own date is held, and Oct 28's note moved to where 1.4.x showed it
      'oct-27-evening': { dailyKey: '2025-10-28', rekeyed: false, duplicateOf: 'oct-28-evening' },
      'oct-28-evening': { dailyKey: '2025-10-28', rekeyed: true, duplicateOf: null },
      'oct-29-evening': { dailyKey: '2025-10-29', rekeyed: true, duplicateOf: null },
    });
    // So Oct 30, the day after, has no note yet: today's opens fresh
    assert.equal(dailyHolder(notes, '2025-10-30', LA), undefined);
  });

  it('a note in the trash or a template gets its key and holds none, and one with a key claims it as the kernel made it', () => {
    const notes = [
      daily('trashed-first', 'Oct 15', '2025-10-15', Date.UTC(2025, 9, 15, 16), { trashed: true }),
      daily('template', 'Oct 15', '2025-10-15', Date.UTC(2025, 9, 15, 15), { isTemplate: true }),
      daily('kept', 'Oct 15', '2025-10-15', Date.UTC(2025, 9, 15, 18)),
      // In the trash and made in the evening: like any note, it moves only to a date no note
      // holds, so this one stays where 1.4.x showed it, since Oct 15 is held
      daily('trashed-evening', 'Oct 15', '2025-10-16', Date.UTC(2025, 9, 16, 3), { trashed: true }),
      // And this one moves to Oct 13, which it holds no more than a trashed note holds any date,
      // so the note made that evening after it moves there too, and holds it
      daily('trashed-evening-13', 'Oct 13', '2025-10-14', Date.UTC(2025, 9, 14, 3), { trashed: true }),
      daily('oct-13-evening', 'Oct 13', '2025-10-14', Date.UTC(2025, 9, 14, 4)),
      // The kernel's, keyed by its local date in its zone, which a later legacy note can't take
      { ...daily('kernel', 'Oct 17', '2025-10-17', Date.UTC(2025, 9, 18, 2)), dailyKey: '2025-10-17' },
      daily('legacy-17', 'Oct 17', '2025-10-17', Date.UTC(2025, 9, 18, 3)),
      // No usable date: no key at all
      daily('undated', 'Oct 18', '', Date.UTC(2025, 9, 18, 16)),
      { id: 'not-daily', name: 'Plans', isDaily: false, dateStr: '2025-10-15', createdAt: 1 },
    ];
    assert.deepEqual(table(assignDailyKeys(notes, LA)), {
      kernel: { dailyKey: '2025-10-17', rekeyed: false, duplicateOf: null },
      kept: { dailyKey: '2025-10-15', rekeyed: false, duplicateOf: null },
      'legacy-17': { dailyKey: '2025-10-17', rekeyed: false, duplicateOf: 'kernel' },
      'oct-13-evening': { dailyKey: '2025-10-13', rekeyed: true, duplicateOf: null },
      template: { dailyKey: '2025-10-15', rekeyed: false, duplicateOf: 'kept' },
      'trashed-evening': { dailyKey: '2025-10-16', rekeyed: false, duplicateOf: null },
      'trashed-evening-13': { dailyKey: '2025-10-13', rekeyed: true, duplicateOf: 'oct-13-evening' },
      'trashed-first': { dailyKey: '2025-10-15', rekeyed: false, duplicateOf: 'kept' },
    });
    // A trashed note holds no date, even one only it has
    assert.equal(dailyHolder(notes, '2025-10-16', LA), undefined);
  });

  it('gives the same answer whatever order the notes come in', () => {
    const notes = [
      daily('oct-7-evening', 'Oct 7', '2025-10-08', Date.UTC(2025, 9, 8, 2)),
      daily('oct-8-evening', 'Oct 8', '2025-10-09', Date.UTC(2025, 9, 9, 3)),
      daily('oct-8', 'Oct 8', '2025-10-08', Date.UTC(2025, 9, 8, 16)),
      daily('oct-10-a', 'Oct 10', '2025-10-10', Date.UTC(2025, 9, 10, 17)),
      daily('oct-10-b', 'Oct 10', '2025-10-10', Date.UTC(2025, 9, 10, 17, 0, 1)),
      daily('oct-10-evening', 'Oct 10', '2025-10-11', Date.UTC(2025, 9, 11, 3)),
      daily('oct-11-evening', 'Oct 11', '2025-10-12', Date.UTC(2025, 9, 12, 3), { name: 'Renamed' }),
      daily('oct-12-planned', 'Oct 12', '2025-10-12', Date.UTC(2025, 9, 5, 19)),
    ];
    const expected = table(assignDailyKeys(notes, LA));
    // Every rotation, and every rotation reversed
    for (let shift = 0; shift < notes.length; shift++) {
      const turned = [...notes.slice(shift), ...notes.slice(0, shift)];
      assert.deepEqual(table(assignDailyKeys(turned, LA)), expected, `rotated ${shift}`);
      assert.deepEqual(table(assignDailyKeys([...turned].reverse(), LA)), expected, `reversed ${shift}`);
    }
    // Oct 8's own note holds Oct 8, so that evening's stays on Oct 9
    assert.deepEqual(expected['oct-8-evening'], { dailyKey: '2025-10-09', rekeyed: false, duplicateOf: null });
    // Renamed, so its local date is createdAt's, Oct 11, where it moves; Oct 10's evening note,
    // whose own date is held, stays there as its duplicate
    assert.deepEqual(expected['oct-11-evening'], { dailyKey: '2025-10-11', rekeyed: true, duplicateOf: null });
    assert.deepEqual(expected['oct-10-evening'], {
      dailyKey: '2025-10-11',
      rekeyed: false,
      duplicateOf: 'oct-11-evening',
    });
  });

  it('dailyHolder finds the note that holds a date, never one in the trash, and nothing for a date no note holds', () => {
    const notes = [
      daily('oct-7-evening', 'Oct 7', '2025-10-08', Date.UTC(2025, 9, 8, 2)),
      daily('oct-9', 'Oct 9', '2025-10-09', Date.UTC(2025, 9, 9, 16), { trashed: true }),
    ];
    assert.equal(dailyHolder(notes, '2025-10-07', LA)?.note.id, 'oct-7-evening');
    assert.equal(dailyHolder(notes, '2025-10-08', LA), undefined, 'the note moved off it');
    assert.equal(dailyHolder(notes, '2025-10-09', LA), undefined, 'a trashed note holds nothing');
  });
});

describe('a duplicate logical 3 marked, in a later lookup', () => {
  /**
   * `notes` as logical 3 leaves them, every one keyed by its answer, or only those `keyed` names
   * @param {Array<Record<string, unknown> & {id: string}>} notes
   * @param {string[]} [keyed]
   */
  const keyedBy = (notes, keyed = notes.map(note => note.id)) => {
    const answer = assignDailyKeys(notes, LA);
    return notes.map(note => {
      const one = answer.get(note.id);
      return one && keyed.includes(note.id) ? withAssignedKey(note, one) : note;
    });
  };
  // Daily opened every morning and evening in 1.4.x
  const chain = [
    daily('oct-27', 'Oct 27', '2025-10-27', Date.UTC(2025, 9, 27, 16)),
    daily('oct-27-evening', 'Oct 27', '2025-10-28', Date.UTC(2025, 9, 28, 3)),
    daily('oct-28-evening', 'Oct 28', '2025-10-29', Date.UTC(2025, 9, 29, 2)),
    daily('oct-29-evening', 'Oct 29', '2025-10-30', Date.UTC(2025, 9, 30, 2)),
  ];

  it('never counts as a claim: once the run is done, a date opens the note that moved there, not the duplicate made before it', () => {
    const after = keyedBy(chain);
    assert.equal(after[1].dailyDuplicateOf, 'oct-28-evening');
    assert.deepEqual(
      ['2025-10-27', '2025-10-28', '2025-10-29', '2025-10-30'].map(key => dailyHolder(after, key, LA)?.note.id),
      ['oct-27', 'oct-28-evening', 'oct-29-evening', undefined],
    );
    // So a lookup's repair writes nothing new on the note that holds it
    const found = /** @type {NonNullable<ReturnType<typeof dailyHolder>>} */ (dailyHolder(after, '2025-10-28', LA));
    assert.equal(withAssignedKey(found.note, found.assignment), found.note);
  });

  it('never counts as a claim before the note it names is keyed, so that note still moves and today stays free', () => {
    // Oct 27's morning; Oct 28's morning and evening; Oct 29's evening; upgraded Oct 30. The run
    // has keyed Oct 28's evening note, a duplicate under Oct 29, and not yet Oct 29's evening note
    const notes = [
      daily('oct-27', 'Oct 27', '2025-10-27', Date.UTC(2025, 9, 27, 15)),
      daily('oct-28', 'Oct 28', '2025-10-28', Date.UTC(2025, 9, 28, 15)),
      daily('oct-28-evening', 'Oct 28', '2025-10-29', Date.UTC(2025, 9, 29, 2)),
      daily('oct-29-evening', 'Oct 29', '2025-10-30', Date.UTC(2025, 9, 30, 2)),
    ];
    const during = keyedBy(notes, ['oct-27', 'oct-28', 'oct-28-evening']);
    assert.deepEqual([during[2].dailyKey, during[2].dailyDuplicateOf], ['2025-10-29', 'oct-29-evening']);
    assert.equal(dailyHolder(during, '2025-10-29', LA)?.note.id, 'oct-29-evening');
    assert.equal(dailyHolder(during, '2025-10-30', LA), undefined, "today's opens a new note");
  });

  it('holds its date once no other note does, so a date never loses its note to the trash', () => {
    const after = keyedBy(chain).map(note => (note.id === 'oct-28-evening' ? { ...note, trashed: true } : note));
    assert.equal(dailyHolder(after, '2025-10-28', LA)?.note.id, 'oct-27-evening');
    // Two duplicates of one note that's gone: the earlier made holds
    const race = [
      { ...daily('a', 'Oct 10', '2025-10-10', 3), dailyKey: '2025-10-10', dailyDuplicateOf: 'gone' },
      { ...daily('b', 'Oct 10', '2025-10-10', 1), dailyKey: '2025-10-10', dailyDuplicateOf: 'gone' },
    ];
    assert.equal(dailyHolder(race, '2025-10-10', LA)?.note.id, 'b');
    // And two that name each other: the earlier made holds, so the date still has its note
    const crossed = [
      { ...race[0], dailyDuplicateOf: 'b' },
      { ...race[1], dailyDuplicateOf: 'a' },
    ];
    assert.equal(dailyHolder(crossed, '2025-10-10', LA)?.note.id, 'b');
  });

  it("a marked duplicate isn't the date's note, even where the index names it", () => {
    const after = keyedBy(chain);
    assert.equal(holdsKey(after[1], '2025-10-28'), false);
    assert.equal(holdsKey(after[2], '2025-10-28'), true);
  });
});

describe('what logical 3 writes on a note (withAssignedKey)', () => {
  it('its key, a zone of null for a 1.4.x note, and its holder, and for a note that moves, its dateStr and daily placement, never its name', () => {
    const evening = {
      ...daily('e', 'Oct 7', '2025-10-08', Date.UTC(2025, 9, 8, 2)),
      placement: { kind: 'daily', dateKey: '2025-10-08' },
      kind: 'note',
      lifecycle: 'active',
    };
    const moved = withAssignedKey(evening, { dailyKey: '2025-10-07', rekeyed: true, duplicateOf: null });
    assert.deepEqual(moved, {
      ...evening,
      dateStr: '2025-10-07',
      placement: { kind: 'daily', dateKey: '2025-10-07' },
      dailyKey: '2025-10-07',
      dailyTimeZone: null,
      dailyDuplicateOf: null,
    });
    assert.equal(moved.name, evening.name);
    // Once it has them, the same note comes back
    assert.equal(withAssignedKey(moved, { dailyKey: '2025-10-07', rekeyed: true, duplicateOf: null }), moved);
    // A note in a folder keeps that placement; a duplicate names its holder; a kernel note its zone
    const filed = { ...evening, placement: { kind: 'collection', folderId: 'f1' } };
    assert.deepEqual(
      withAssignedKey(filed, { dailyKey: '2025-10-07', rekeyed: true, duplicateOf: 'h' }).placement,
      filed.placement,
    );
    const kernel = { ...daily('k', 'Oct 9', '2025-10-09', 1), dailyKey: '2025-10-09', dailyTimeZone: LA };
    assert.deepEqual(withAssignedKey(kernel, { dailyKey: '2025-10-09', rekeyed: false, duplicateOf: 'h' }), {
      ...kernel,
      dailyDuplicateOf: 'h',
    });
  });

  it('holdsKey, canHoldKey, and madeBefore', () => {
    const note = { ...daily('a', 'Oct 9', '2025-10-09', 5), dailyKey: '2025-10-09' };
    assert.equal(holdsKey(note, '2025-10-09'), true);
    for (const other of [
      { ...note, trashed: true },
      { ...note, isTemplate: true },
      { ...note, isDaily: false },
      { ...note, dailyKey: undefined },
    ]) {
      assert.equal(holdsKey(other, '2025-10-09'), false, JSON.stringify(other));
    }
    assert.equal(holdsKey(note, '2025-10-10'), false);
    assert.equal(holdsKey(undefined, '2025-10-09'), false);
    assert.deepEqual([canHoldKey({ archived: true }), canHoldKey({ trashed: true })], [true, false]);
    assert.equal(madeBefore({ id: 'b', createdAt: 1 }, { id: 'a', createdAt: 2 }), true);
    assert.equal(madeBefore({ id: 'a', createdAt: 2 }, { id: 'b', createdAt: 2 }), true, 'then the lower id');
    assert.equal(madeBefore({ id: 'a' }, { id: 'b', createdAt: 9 }), false, 'no time comes after every time');
    assert.equal(madeBefore({ id: 'a' }, { id: 'b' }), true);
  });

  it('the fields every legacy path strips are the group and the key (placement.js)', () => {
    assert.deepEqual(DAILY_FIELDS, ['dailyKey', 'dailyTimeZone', 'dailyDuplicateOf']);
    assert.deepEqual(NEW_NOTE_FIELDS, [...PLACEMENT_FIELDS, ...DAILY_FIELDS]);
  });
});

describe("a lookup while logical 3's batches run (underAnswer, #17 PR 4a, F10)", () => {
  // Oct 28's evening note, which 1.4.x keyed by Oct 29's UTC date, renamed to Oct 25 since the
  // run read it; Oct 27's morning note; and a note a page made since, for Oct 30
  const evening = daily('evening', 'Oct 25', '2025-10-29', Date.UTC(2025, 9, 29, 2));
  const morning = daily('morning', 'Oct 27', '2025-10-27', Date.UTC(2025, 9, 27, 16));
  const made = {
    ...daily('made', 'Oct 30', '2025-10-30', Date.UTC(2025, 9, 30, 17)),
    dailyKey: '2025-10-30',
    dailyTimeZone: LA,
    dailyDuplicateOf: null,
  };
  const answer = new Map([
    ['evening', { dailyKey: '2025-10-28', rekeyed: true, duplicateOf: null }],
    ['morning', { dailyKey: '2025-10-27', rekeyed: false, duplicateOf: null }],
  ]);

  it('gives each note the run read the fields its batch writes, and leaves the rest as they are', () => {
    /** @type {Array<Record<string, unknown>>} */
    const notes = underAnswer([evening, morning, made], answer);
    const [keyed, read, page] = notes;
    /** @type {Record<string, unknown>} */
    const written = withAssignedKey(evening, /** @type {any} */ (answer.get('evening')));
    assert.deepEqual(keyed, written);
    assert.deepEqual(
      [keyed.dailyKey, keyed.dateStr, keyed.name],
      ['2025-10-28', '2025-10-28', 'Daily Note - Oct 25, 2025'],
    );
    assert.equal(read.dailyKey, '2025-10-27');
    assert.equal(page, made);
    // With no run going, every note is as it is
    assert.deepEqual(underAnswer([evening, morning], null), [evening, morning]);
  });

  it("finds the note a date's lookup will find once the run is done, not the one the notes' fields give now", () => {
    // By its name now, the renamed note would take Oct 25, where the run gives it Oct 28
    assert.equal(dailyHolder([evening, morning], '2025-10-25', LA)?.note.id, 'evening');
    const notes = underAnswer([evening, morning, made], answer);
    assert.equal(dailyHolder(notes, '2025-10-25', LA), undefined);
    assert.equal(dailyHolder(notes, '2025-10-28', LA)?.note.id, 'evening');
    assert.equal(dailyHolder(notes, '2025-10-30', LA)?.note.id, 'made');
  });

  it('leaves a note a command keyed to another day since the run read it, as its batch does', () => {
    const otherwise = { ...evening, dailyKey: '2025-10-25', dailyTimeZone: LA, dailyDuplicateOf: null };
    const [kept] = underAnswer([otherwise], answer);
    assert.equal(kept, otherwise);
  });
});
