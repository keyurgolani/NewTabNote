// #7 slice 1, categories and time on an injected clock and IANA time zone: every category and
// its boundaries, the undated rule on the latest block edit, a task due beyond Soon staying
// inactive until its window opens, local midnight, a DST change, and zones other than the
// machine's. Then ranking, a pure comparator.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_WINDOWS, placeSignal } from '../../js/kernel/core/intelligence/categories.js';
import { compareRankKeys, rankKeyOf } from '../../js/kernel/core/intelligence/ranking.js';
import {
  addLocalDays,
  addLocalDaysToInstant,
  instantAt,
  isLocalDate,
  isTimeZone,
  localDateOf,
  startOfLocalDay,
} from '../../js/kernel/core/intelligence/time.js';
import {
  ZONE,
  asSignal,
  connectionDraft,
  idOf,
  inferredDraft,
  intelligenceWorld,
  pinDraft,
  taskDraft,
  todo,
} from './intelligence-fixtures.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/kernel/core/intelligence/records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').SignalDecision} SignalDecision */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').SignalCorrection} SignalCorrection */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').TimeBasis} TimeBasis */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Where a task with `time` goes at `now`
 * @param {TimeBasis | null} time
 * @param {number} now
 * @param {{timeZone?: string, decision?: SignalDecision | null, corrections?: SignalCorrection[], context?: object}} [options]
 */
const placeTask = (time, now, { timeZone = ZONE, decision = null, corrections = [], context } = {}) =>
  placeSignal(asSignal(taskDraft({ time, context })), decision, corrections, { now, timeZone });

/**
 * A UTC instant
 * @param {string} iso
 */
const at = iso => Date.parse(iso);

describe('local time (intelligence/time.js)', () => {
  it('reads local dates in the zone it is given, never the machine’s', () => {
    // 2026-10-20 23:30 in New York is already the 21st in UTC and in Kolkata
    const instant = at('2026-10-21T03:30:00Z');
    assert.equal(localDateOf(instant, 'America/New_York'), '2026-10-20');
    assert.equal(localDateOf(instant, 'UTC'), '2026-10-21');
    assert.equal(localDateOf(instant, 'Asia/Kolkata'), '2026-10-21');
    assert.equal(localDateOf(at('2026-10-20T10:00:00Z'), 'Pacific/Kiritimati'), '2026-10-21');
    assert.ok(isTimeZone('Asia/Kolkata'));
    assert.ok(!isTimeZone('Mars/Olympus'));
    assert.ok(!isTimeZone(''));
    assert.ok(isLocalDate('2028-02-29'));
    assert.ok(!isLocalDate('2026-02-29'));
  });

  it('finds local midnight across a DST change, including a skipped midnight', () => {
    assert.equal(startOfLocalDay('2026-03-08', 'America/New_York'), at('2026-03-08T05:00:00Z'));
    assert.equal(startOfLocalDay('2026-03-09', 'America/New_York'), at('2026-03-09T04:00:00Z'));
    assert.equal(startOfLocalDay('2026-11-02', 'America/New_York'), at('2026-11-02T05:00:00Z'));
    // Chile springs forward at midnight, so the day starts at 01:00
    assert.equal(startOfLocalDay('2026-09-06', 'America/Santiago'), at('2026-09-06T04:00:00Z'));
    // 02:30 doesn't happen on New York's spring-forward day, and 01:30 happens twice in the fall
    assert.equal(instantAt('2026-03-08', 'America/New_York', 2, 30), at('2026-03-08T07:30:00Z'));
    assert.equal(instantAt('2026-11-01', 'America/New_York', 1, 30), at('2026-11-01T05:30:00Z'));
    assert.equal(addLocalDays('2026-12-28', 7), '2027-01-04');
  });

  it('adds local days at the same wall-clock time across a DST change', () => {
    const before = at('2026-10-25T13:00:00Z'); // 09:00 EDT
    const after = addLocalDaysToInstant(before, 14, 'America/New_York');
    assert.equal(after, at('2026-11-08T14:00:00Z')); // 09:00 EST, 14 days and an hour later
    assert.equal(after - before, 14 * DAY + HOUR);
  });
});

describe('categories (#7, "Categories and time")', () => {
  // NOW is 2026-10-20 12:00 UTC, 08:00 in New York
  it('puts an overdue signal, and one due within the Now window, in Now', () => {
    const overdue = placeTask({ dueAt: NOW - 1 }, NOW);
    assert.equal(overdue.category, 'now');
    assert.deepEqual(overdue.rule, { code: 'overdue', date: '2026-10-20' });
    const yesterday = placeTask({ dueDate: '2026-10-19' }, NOW);
    assert.equal(yesterday.category, 'now');
    assert.deepEqual(yesterday.rule, { code: 'overdue', date: '2026-10-19' });
    const edge = placeTask({ dueAt: NOW + DEFAULT_WINDOWS.nowMs }, NOW);
    assert.equal(edge.category, 'now');
    assert.deepEqual(edge.rule, { code: 'due-within', at: NOW + DEFAULT_WINDOWS.nowMs });
    assert.equal(placeTask({ dueAt: NOW + DEFAULT_WINDOWS.nowMs + 1 }, NOW).category, 'today');
  });

  it('puts what is due on the current local date in Today, up to local midnight', () => {
    const evening = placeTask({ dueAt: at('2026-10-21T03:59:59Z') }, NOW); // 23:59:59 EDT
    assert.equal(evening.category, 'today');
    assert.deepEqual(evening.rule, { code: 'due-today', at: at('2026-10-21T03:59:59Z') });
    const midnight = placeTask({ dueAt: at('2026-10-21T04:00:00Z') }, NOW);
    assert.equal(midnight.category, 'soon');
    assert.deepEqual(placeTask({ dueDate: '2026-10-20' }, NOW).rule, { code: 'due-today', at: null });
  });

  it('puts what is due within the Soon window in Soon, and keeps a later one inactive until its window opens', () => {
    const inSeven = placeTask({ dueDate: '2026-10-27' }, NOW);
    assert.equal(inSeven.category, 'soon');
    assert.ok(inSeven.active);
    assert.deepEqual(inSeven.rule, { code: 'due-on', date: '2026-10-27' });
    const inEight = placeTask({ dueDate: '2026-10-28' }, NOW);
    assert.equal(inEight.category, 'soon');
    assert.equal(inEight.active, false);
    assert.equal(inEight.activeFrom, startOfLocalDay('2026-10-21', ZONE));
    assert.equal(inEight.validUntil, inEight.activeFrom);
  });

  it('keeps a task due in 30 days out of the active list until 7 local days before, across the DST change', () => {
    const time = { dueDate: '2026-11-19' };
    const opens = startOfLocalDay('2026-11-12', ZONE);
    assert.equal(opens, at('2026-11-12T05:00:00Z')); // EST, after New York's fall-back
    const now = placeTask(time, NOW);
    assert.equal(now.active, false);
    assert.equal(now.activeFrom, opens);
    assert.equal(placeTask(time, opens - 1).active, false);
    const open = placeTask(time, opens);
    assert.equal(open.active, true);
    assert.equal(open.category, 'soon');
    assert.equal(open.activeFrom, null);
  });

  it('works the date out at local midnight in the user’s zone, not in UTC', () => {
    const lateEvening = at('2026-10-21T03:30:00Z'); // 23:30 EDT on the 20th, the 21st in UTC
    const time = { dueDate: '2026-10-21' };
    assert.equal(placeTask(time, lateEvening).category, 'soon');
    assert.equal(placeTask(time, lateEvening, { timeZone: 'UTC' }).category, 'today');
    assert.equal(placeTask(time, lateEvening).validUntil, at('2026-10-21T04:00:00Z'));
    assert.equal(placeTask(time, at('2026-10-21T04:00:00Z')).category, 'today');
  });

  it('gives a zone other than the machine’s its own answer for the same instant', () => {
    const instant = at('2026-10-20T20:00:00Z'); // 01:30 on the 21st in Kolkata, 16:00 on the 20th in New York
    const time = { dueDate: '2026-10-21' };
    assert.equal(placeTask(time, instant, { timeZone: 'Asia/Kolkata' }).category, 'today');
    assert.equal(placeTask(time, instant, { timeZone: 'America/New_York' }).category, 'soon');
    assert.equal(placeTask(time, instant, { timeZone: 'Pacific/Auckland' }).category, 'today');
  });

  it('counts Soon days by local date across a DST change', () => {
    const saturday = at('2026-10-31T16:00:00Z'); // 12:00 EDT, the day before fall-back
    assert.equal(placeTask({ dueDate: '2026-11-07' }, saturday).category, 'soon');
    assert.ok(placeTask({ dueDate: '2026-11-07' }, saturday).active);
    assert.equal(placeTask({ dueDate: '2026-11-08' }, saturday).active, false);
    assert.equal(placeTask({ dueDate: '2026-11-08' }, saturday).activeFrom, at('2026-11-01T04:00:00Z'));
  });

  it('puts an undated signal in Today for today’s Daily Note, Resurface after 14 days unedited, and Soon otherwise', () => {
    const daily = placeTask(null, NOW, { context: { dailyNoteDate: '2026-10-20' } });
    assert.equal(daily.category, 'today');
    assert.deepEqual(daily.rule, { code: 'daily-note' });
    assert.equal(daily.validUntil, startOfLocalDay('2026-10-21', ZONE));
    assert.equal(placeTask(null, NOW, { context: { dailyNoteDate: '2026-10-19' } }).category, 'soon');
    const stale = placeTask(null, NOW, { context: { lastEditAt: NOW - 15 * DAY } });
    assert.equal(stale.category, 'resurface');
    assert.deepEqual(stale.rule, { code: 'not-edited', date: '2026-10-05' });
    const recent = placeTask(null, NOW, { context: { lastEditAt: NOW - 13 * DAY } });
    assert.equal(recent.category, 'soon');
    assert.deepEqual(recent.rule, { code: 'stored' });
    assert.equal(recent.validUntil, NOW + DAY);
    const pin = placeSignal(asSignal(pinDraft({ context: { lastEditAt: NOW - 20 * DAY } })), null, [], {
      now: NOW,
      timeZone: ZONE,
    });
    assert.equal(pin.category, 'resurface');
  });

  it('resurfaces 14 local days after the last block edit, across the DST change', () => {
    const lastEditAt = at('2026-10-25T13:00:00Z'); // 09:00 EDT
    const resurfaceAt = at('2026-11-08T14:00:00Z'); // 09:00 EST
    assert.equal(placeTask(null, resurfaceAt - 1, { context: { lastEditAt } }).category, 'soon');
    assert.equal(placeTask(null, resurfaceAt, { context: { lastEditAt } }).category, 'resurface');
    assert.equal(placeTask(null, resurfaceAt - 1, { context: { lastEditAt } }).validUntil, resurfaceAt);
  });

  it('reads the latest block edit, never the note’s updatedAt', async () => {
    const world = await intelligenceWorld();
    const old = NOW - 20 * DAY;
    await world.addNote('n1', [{ ...todo('b1', 'Renew passport'), updatedAt: old }]);
    // Renaming moves the note's updatedAt to now, and leaves every block as it was
    const renamed = await world.kernel.execute({
      type: 'renameNote',
      commandId: 'rename',
      noteId: 'n1',
      name: 'Errands',
    });
    assert.equal(renamed.kind, 'committed');
    const draft = await world.tasks.derive?.({
      producerId: 'tasks',
      noteId: 'n1',
      anchorBlockId: 'b1',
      subjectKey: 'task',
    });
    assert.ok(draft);
    await world.intelligence.upsertSignals('tasks', [draft]);
    const read = await world.intelligence.readSignal(idOf(draft));
    assert.equal(read.kind, 'ready');
    if (read.kind === 'ready') {
      assert.equal(read.signal.context.lastEditAt, old);
      assert.equal(placeSignal(read.signal, null, [], { now: NOW, timeZone: ZONE }).category, 'resurface');
    }
  });

  it('keeps a stored category, and Connection for a connection', () => {
    const stored = placeSignal(
      asSignal(inferredDraft({ kind: 'inferred-resurface', category: 'resurface' })),
      null,
      [],
      {
        now: NOW,
        timeZone: ZONE,
      },
    );
    assert.equal(stored.category, 'resurface');
    assert.equal(
      placeSignal(asSignal(connectionDraft()), null, [], { now: NOW, timeZone: ZONE }).category,
      'connection',
    );
  });

  it('applies the latest corrected category and time basis', () => {
    const signal = asSignal(inferredDraft({ time: { dueDate: '2026-10-25' } }));
    /** @param {number} offset @param {import('../../js/kernel/core/intelligence/records.js').CorrectionChange} change @returns {SignalCorrection} */
    const correction = (offset, change) => ({
      recordVersion: 1,
      entryId: `e${offset}`,
      signalId: signal.id,
      identity: signal.identity,
      change,
      note: null,
      at: NOW + offset,
      commandId: `c${offset}`,
    });
    const corrections = [
      correction(1, { field: 'category', before: null, after: 'resurface' }),
      correction(2, { field: 'category', before: 'resurface', after: 'today' }),
      correction(3, { field: 'time', before: { dueDate: '2026-10-25' }, after: { dueDate: '2026-10-19' } }),
    ];
    const placed = placeSignal(signal, null, corrections, { now: NOW, timeZone: ZONE });
    assert.equal(placed.category, 'today');
    assert.ok(placed.corrected);
    assert.deepEqual(placed.rule, { code: 'overdue', date: '2026-10-19' });
    const timeOnly = placeSignal(signal, null, [corrections[2]], { now: NOW, timeZone: ZONE });
    assert.equal(timeOnly.category, 'now');
  });

  it('takes a snooze, a completion, a dismissal, and suspension or invalidation out of the active list', () => {
    const signal = asSignal(inferredDraft({ time: { dueDate: '2026-10-22' } }));
    /** @param {Partial<SignalDecision>} fields @returns {SignalDecision} */
    const decision = fields => ({
      recordVersion: 1,
      signalId: signal.id,
      identity: signal.identity,
      status: 'active',
      snoozedUntil: null,
      dismissReason: null,
      completedAt: null,
      decisionRevision: 1,
      updatedAt: NOW,
      history: [],
      tombstone: null,
      ...fields,
    });
    const until = NOW + 3 * HOUR;
    const snoozed = placeSignal(signal, decision({ status: 'snoozed', snoozedUntil: until }), [], {
      now: NOW,
      timeZone: ZONE,
    });
    assert.equal(snoozed.status, 'snoozed');
    assert.equal(snoozed.active, false);
    assert.equal(snoozed.activeFrom, until);
    assert.equal(snoozed.validUntil, until);
    const woke = placeSignal(signal, decision({ status: 'snoozed', snoozedUntil: until }), [], {
      now: until,
      timeZone: ZONE,
    });
    assert.equal(woke.status, 'active');
    assert.ok(woke.active);
    for (const fields of [
      { status: /** @type {const} */ ('completed'), completedAt: NOW },
      { status: /** @type {const} */ ('dismissed') },
    ]) {
      const placed = placeSignal(signal, decision(fields), [], { now: NOW, timeZone: ZONE });
      assert.equal(placed.active, false);
      assert.equal(placed.activeFrom, null);
    }
    for (const freshness of [
      {
        state: /** @type {const} */ ('suspended'),
        cause: /** @type {const} */ ('note-trashed'),
        since: NOW,
        invalidatedAt: null,
        resumeTo: { state: /** @type {const} */ ('current'), cause: null, invalidatedAt: null },
      },
      {
        state: /** @type {const} */ ('invalidated'),
        cause: /** @type {const} */ ('anchor-deleted'),
        since: NOW,
        invalidatedAt: NOW,
        resumeTo: null,
      },
    ]) {
      assert.equal(placeSignal({ ...signal, freshness }, null, [], { now: NOW, timeZone: ZONE }).active, false);
    }
    // A stale inference is still shown, with its cause
    const stale = {
      ...signal,
      freshness: {
        state: /** @type {const} */ ('stale'),
        cause: /** @type {const} */ ('source-edited'),
        since: NOW,
        invalidatedAt: null,
        resumeTo: null,
      },
    };
    assert.ok(placeSignal(stale, null, [], { now: NOW, timeZone: ZONE }).active);
  });

  it('says when the placement changes by time alone', () => {
    const dueAt = NOW + 5 * HOUR; // 13:00 EDT
    assert.equal(placeTask({ dueAt }, NOW).validUntil, dueAt - DEFAULT_WINDOWS.nowMs);
    assert.equal(placeTask({ dueAt }, dueAt - DEFAULT_WINDOWS.nowMs).validUntil, dueAt + 1);
    assert.equal(placeTask({ dueAt: NOW - HOUR }, NOW).validUntil, null);
  });
});

describe('ranking (#7, "Ranking")', () => {
  /**
   * @param {IntelligenceSignal} signal
   * @param {number} [now]
   */
  const keyOf = (signal, now = NOW) => rankKeyOf(placeSignal(signal, null, [], { now, timeZone: ZONE }), ZONE);

  it('orders by category, then objective before inferred, time basis, pinned tasks, latest edit, and id', () => {
    const ranked = {
      nowTask: asSignal(taskDraft({ blockId: 'a', time: { dueAt: NOW - HOUR } })),
      nowInferred: asSignal(inferredDraft({ blockId: 'b', time: { dueAt: NOW - 2 * HOUR } })),
      todayEarly: asSignal(taskDraft({ blockId: 'c', time: { dueAt: NOW + 3 * HOUR } })),
      todayLate: asSignal(taskDraft({ blockId: 'd', time: { dueAt: NOW + 6 * HOUR } })),
      soonDated: asSignal(taskDraft({ blockId: 'e', time: { dueDate: '2026-10-23' } })),
      soonPinned: asSignal(taskDraft({ blockId: 'f', context: { notePinned: true, lastEditAt: NOW - DAY } })),
      soonRecent: asSignal(taskDraft({ blockId: 'g', context: { lastEditAt: NOW - HOUR } })),
      soonOlder: asSignal(taskDraft({ blockId: 'h', context: { lastEditAt: NOW - 2 * DAY } })),
      soonInferred: asSignal(inferredDraft({ blockId: 'i', time: { dueDate: '2026-10-21' } })),
      resurface: asSignal(pinDraft({ context: { lastEditAt: NOW - 30 * DAY } })),
      connection: asSignal(connectionDraft()),
    };
    const expected = Object.keys(ranked);
    const shuffled = [...expected].reverse().sort((a, b) => (a.length % 3) - (b.length % 3));
    const sorted = shuffled
      .map(name => ({ name, key: keyOf(ranked[/** @type {keyof typeof ranked} */ (name)]) }))
      .sort((a, b) => compareRankKeys(a.key, b.key))
      .map(({ name }) => name);
    assert.deepEqual(sorted, expected);
  });

  it('is total and antisymmetric, ending on id', () => {
    const a = asSignal(taskDraft({ blockId: 'x' }));
    const b = asSignal(taskDraft({ blockId: 'y' }));
    const [first, second] = [keyOf(a), keyOf(b)].sort(compareRankKeys);
    assert.ok(first.id < second.id);
    assert.equal(compareRankKeys(keyOf(a), keyOf(a)), 0);
    assert.equal(Math.sign(compareRankKeys(keyOf(a), keyOf(b))), -Math.sign(compareRankKeys(keyOf(b), keyOf(a))));
  });
});
