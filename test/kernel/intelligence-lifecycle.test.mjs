// #7 slice 1, lifecycle commands (approved AC3 and the refined body's "One completion
// authority"): every transition, the first commit for a revision winning and the loser getting
// SignalDecisionConflict with the current state, idempotent retries, corrections with the
// latest per field winning, objective tasks completing through the note-command port with the
// signal following the committed `checked`, and no other write ever touching a note.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { hintSchema } from '../../js/kernel/core/contracts/hint-channel.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { eventSchema, hintOf } from '../../js/kernel/core/intelligence/events.js';
import { result as resultSchema } from '../../js/kernel/core/intelligence/operations.js';
import { HISTORY_MAX } from '../../js/kernel/core/intelligence/records.js';
import { createIntelligence } from '../../js/kernel/core/intelligence/service.js';
import { createMemoryIntelligenceRepository } from '../../js/kernel/core/memory/intelligence.js';
import {
  LINKS,
  PINS,
  RECIPE,
  TASKS,
  ZONE,
  connectionDraft,
  idOf,
  inferredDraft,
  intelligenceWorld,
  pinDraft,
  taskDraft,
  todo,
} from './intelligence-fixtures.mjs';
import { NOW, testClock } from './support.mjs';

/** @typedef {import('../../js/kernel/core/intelligence/operations.js').IntelligenceOutcome} IntelligenceOutcome */

const HOUR = 3_600_000;

/**
 * A world with one inferred deadline, one pin, and one connection, and a command maker
 */
async function world() {
  const w = await intelligenceWorld();
  const deadline = inferredDraft({ time: { dueDate: '2026-10-25' } });
  await w.intelligence.upsertSignals(RECIPE, [deadline]);
  await w.intelligence.upsertSignals(PINS, [pinDraft()]);
  await w.intelligence.upsertSignals(LINKS, [connectionDraft()]);
  let count = 0;
  /**
   * @param {string} type
   * @param {string} signalId
   * @param {number} expectedDecisionRevision
   * @param {Record<string, unknown>} [fields]
   */
  const command = (type, signalId, expectedDecisionRevision, fields = {}) => ({
    type: `intelligence.${type}`,
    commandId: `life-${++count}`,
    signalId,
    expectedDecisionRevision,
    ...fields,
  });
  return {
    ...w,
    command,
    deadlineId: idOf(deadline),
    pinId: idOf(pinDraft()),
    connectionId: idOf(connectionDraft()),
  };
}

/**
 * @param {IntelligenceOutcome} outcome
 * @param {string} kind
 * @param {string} [code]
 */
function assertOutcome(outcome, kind, code) {
  assert.ok(v.is(resultSchema, outcome), JSON.stringify(outcome));
  assert.equal(outcome.kind, kind, JSON.stringify(outcome));
  if (code) assert.equal(outcome.code, code);
}

describe('lifecycle commands (#7, "Contracts")', () => {
  it('moves an inferred signal through mark done, reopen, snooze, dismiss, and correct, one revision each', async () => {
    const w = await world();
    const steps = /** @type {Array<[string, Record<string, unknown>, string, string]>} */ ([
      ['complete', {}, 'signal-completed', 'completed'],
      ['reopen', {}, 'signal-reopened', 'active'],
      ['snooze', { until: NOW + 3 * HOUR }, 'signal-snoozed', 'snoozed'],
      ['reopen', {}, 'signal-reopened', 'active'],
      ['dismiss', { reason: 'not-actionable' }, 'signal-dismissed', 'dismissed'],
      ['reopen', {}, 'signal-reopened', 'active'],
      ['correct', { entryId: 'e1', change: { field: 'category', after: 'today' } }, 'signal-corrected', 'active'],
    ]);
    let revision = 0;
    for (const [type, fields, code, status] of steps) {
      const outcome = await w.intelligence.execute(w.command(type, w.deadlineId, revision, fields));
      assertOutcome(outcome, 'committed', code);
      revision += 1;
      if (outcome.kind === 'committed') {
        assert.equal(outcome.revision, revision);
        assert.ok(typeof outcome.commitSeq === 'number');
        assert.deepEqual(outcome.changedIds, [w.deadlineId]);
      }
      const read = await w.intelligence.readSignal(w.deadlineId);
      assert.equal(read.kind, 'ready');
      if (read.kind === 'ready') {
        assert.equal(read.state.status, status, type);
        assert.equal(read.state.decisionRevision, revision);
        assert.equal(read.decision?.history.length, revision);
        assert.equal(read.decision?.history.at(-1)?.action, type);
      }
    }
    const read = await w.intelligence.readSignal(w.deadlineId);
    if (read.kind === 'ready') {
      assert.equal(read.corrections.length, 1);
      assert.deepEqual(read.corrections[0].change, { field: 'category', before: null, after: 'today' });
    }
  });

  it('emits typed events in #13’s hint shape with entityType intelligence', async () => {
    const w = await world();
    w.events.length = 0;
    const outcome = await w.intelligence.execute(w.command('dismiss', w.deadlineId, 0));
    assert.equal(outcome.kind, 'committed');
    assert.deepEqual(
      w.events.map(event => event.type),
      ['intelligence.decisionChanged'],
    );
    for (const event of w.events) {
      assert.ok(v.is(eventSchema, event));
      assert.equal(event.entityType, 'intelligence');
      assert.equal(event.entityId, w.deadlineId);
      assert.equal(event.commitSeq, outcome.kind === 'committed' ? outcome.commitSeq : -1);
      assert.ok(v.is(hintSchema, { frame: 'hint', ...hintOf(event) }));
    }
    // #17's change log names the signal as the entity the commit changed
    const changes = await w.commitLog.readChangesSince(0, 1000);
    assert.equal(changes.kind, 'changes');
    if (changes.kind === 'changes') {
      assert.deepEqual(changes.entries.at(-1), {
        commitSeq: w.events[0].commitSeq,
        entityType: 'intelligence',
        entityId: w.deadlineId,
        revision: w.events[0].revision,
      });
    }
  });

  it('lets the first commit for a revision win and gives the loser SignalDecisionConflict with the current state', async () => {
    const w = await world();
    const [first, second] = await Promise.all([
      w.intelligence.execute(w.command('dismiss', w.deadlineId, 0, { reason: 'not-actionable' })),
      w.intelligence.execute(w.command('snooze', w.deadlineId, 0, { until: NOW + HOUR })),
    ]);
    assertOutcome(first, 'committed', 'signal-dismissed');
    assertOutcome(second, 'conflict', 'signal-decision-conflict');
    if (second.kind === 'conflict' && 'current' in second) {
      assert.deepEqual(second.current, {
        signalId: w.deadlineId,
        status: 'dismissed',
        snoozedUntil: null,
        dismissReason: 'not-actionable',
        decisionRevision: 1,
        checked: null,
      });
      assert.equal(second.currentRevision, 1);
    }
    const read = await w.intelligence.readSignal(w.deadlineId);
    if (read.kind === 'ready') {
      assert.equal(read.state.status, 'dismissed');
      assert.equal(read.decision?.history.length, 1);
    }
    assertOutcome(
      await w.intelligence.execute(w.command('reopen', w.deadlineId, 7)),
      'conflict',
      'signal-decision-conflict',
    );
  });

  it('answers a retry of a commandId with the outcome it got, and runs nothing again', async () => {
    const w = await world();
    const dismiss = w.command('dismiss', w.deadlineId, 0);
    const first = await w.intelligence.execute(dismiss);
    w.events.length = 0;
    const again = await w.intelligence.execute({ ...dismiss });
    assert.deepEqual(again, first);
    assert.deepEqual(w.events, []);
    const read = await w.intelligence.readSignal(w.deadlineId);
    if (read.kind === 'ready') assert.equal(read.state.decisionRevision, 1);
    // A lost command that conflicted gets its conflict again
    const late = w.command('snooze', w.deadlineId, 0, { until: NOW + HOUR });
    const conflict = await w.intelligence.execute(late);
    assert.equal(conflict.kind, 'conflict');
    assert.deepEqual(await w.intelligence.execute(late), conflict);
    // The same key for another command fails closed
    assertOutcome(
      await w.intelligence.execute({ ...dismiss, reason: 'confirmed' }),
      'rejected',
      'idempotency-key-reuse',
    );
  });

  it('refuses what a kind does not take, a bad payload, a missing signal, and a suspended one', async () => {
    const w = await world();
    await w.addNote('n5', [todo('t1', 'Call vendor')]);
    const taskId = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
    for (const [type, signalId, fields] of /** @type {Array<[string, string, Record<string, unknown>]>} */ ([
      ['correct', taskId, { entryId: 'e1', change: { field: 'category', after: 'today' } }],
      ['complete', w.pinId, {}],
      ['correct', w.pinId, { entryId: 'e2', change: { field: 'category', after: 'today' } }],
      ['snooze', w.connectionId, { until: NOW + HOUR }],
      ['complete', w.connectionId, {}],
    ])) {
      assertOutcome(
        await w.intelligence.execute(w.command(type, signalId, 0, fields)),
        'rejected',
        'action-not-available',
      );
    }
    for (const bad of [
      { ...w.command('dismiss', w.deadlineId, 0), prompt: 'canary' },
      w.command('dismiss', 'not-a-signal-id', 0),
      w.command('dismiss', w.deadlineId, -1),
      w.command('snooze', w.deadlineId, 0),
      w.command('archive', w.deadlineId, 0),
      w.command('correct', w.deadlineId, 0, { entryId: 'e3', change: { field: 'title', after: 'x' } }),
      w.command('correct', w.deadlineId, 0, {
        entryId: 'e4',
        change: { field: 'category', after: 'today' },
        note: 'see https://x.example',
      }),
    ]) {
      assertOutcome(await w.intelligence.execute(bad), 'rejected', 'invalid-command');
    }
    assertOutcome(
      await w.intelligence.execute(w.command('dismiss', idOf(pinDraft({ noteId: 'nope' })), 0)),
      'rejected',
      'signal-not-found',
    );
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: true,
      archived: false,
      isTemplate: false,
    });
    assertOutcome(
      await w.intelligence.execute(w.command('dismiss', w.deadlineId, 0)),
      'rejected',
      'signal-not-actionable',
    );
  });

  it('refuses a snooze that ends now or earlier, and warns when the signal is due before the snooze ends', async () => {
    const w = await world();
    assertOutcome(
      await w.intelligence.execute(w.command('snooze', w.deadlineId, 0, { until: NOW })),
      'rejected',
      'snooze-not-future',
    );
    const late = await w.intelligence.execute(w.command('snooze', w.deadlineId, 0, { until: NOW + 10 * 24 * HOUR }));
    assertOutcome(late, 'committed', 'signal-snoozed-past-due');
    assert.equal(late.severity, 'warning');
  });

  it('dismisses a connection as not related by default', async () => {
    const w = await world();
    assertOutcome(await w.intelligence.execute(w.command('dismiss', w.connectionId, 0)), 'committed');
    const read = await w.intelligence.readSignal(w.connectionId);
    if (read.kind === 'ready') assert.equal(read.state.dismissReason, 'not-related');
  });

  it('keeps only the last 50 history entries', async () => {
    const w = await world();
    for (let revision = 0; revision < HISTORY_MAX + 10; revision += 1) {
      const type = revision % 2 === 0 ? 'dismiss' : 'reopen';
      assertOutcome(await w.intelligence.execute(w.command(type, w.deadlineId, revision)), 'committed');
    }
    const read = await w.intelligence.readSignal(w.deadlineId);
    if (read.kind === 'ready') {
      assert.equal(read.decision?.history.length, HISTORY_MAX);
      assert.equal(read.decision?.history[0].decisionRevision, 11);
      assert.equal(read.state.decisionRevision, HISTORY_MAX + 10);
    }
  });

  it('writes nothing when the repository fails the commit, and the same command then succeeds', async () => {
    let fail = true;
    const repository = createMemoryIntelligenceRepository({
      beforeCommit() {
        if (fail) throw new UnavailableError('storage', 'write-failed', true);
      },
    });
    const intelligence = createIntelligence({
      repository,
      noteCommands: { setTodoChecked: async () => assert.fail('no note command') },
      timeZone: ZONE,
      clock: testClock(),
    });
    fail = false;
    await intelligence.upsertSignals(RECIPE, [inferredDraft()]);
    fail = true;
    const id = idOf(inferredDraft());
    const dismiss = { type: 'intelligence.dismiss', commandId: 'c1', signalId: id, expectedDecisionRevision: 0 };
    const failed = await intelligence.execute(dismiss);
    assertOutcome(failed, 'unavailable', 'write-failed');
    const read = await intelligence.readSignal(id);
    if (read.kind === 'ready') assert.equal(read.decision, null);
    fail = false;
    assertOutcome(await intelligence.execute(dismiss), 'committed', 'signal-dismissed');
  });
});

describe('corrections (#7, "Records and identity")', () => {
  it('appends each correction with what it replaced, and the latest per field wins', async () => {
    const w = await world();
    const steps = /** @type {Array<Record<string, unknown>>} */ ([
      { field: 'category', after: 'resurface' },
      { field: 'time', after: { dueDate: '2026-10-21' } },
      { field: 'category', after: 'today' },
    ]);
    for (const [index, change] of steps.entries()) {
      const outcome = await w.intelligence.execute(
        w.command('correct', w.deadlineId, index, {
          entryId: `e${index}`,
          change,
          note: index === 0 ? 'Not urgent' : undefined,
        }),
      );
      assertOutcome(outcome, 'committed', 'signal-corrected');
      w.clock.advance(1000);
    }
    const read = await w.intelligence.readSignal(w.deadlineId);
    assert.equal(read.kind, 'ready');
    if (read.kind === 'ready') {
      assert.deepEqual(
        read.corrections.map(correction => correction.change),
        [
          { field: 'category', before: null, after: 'resurface' },
          { field: 'time', before: { dueDate: '2026-10-25' }, after: { dueDate: '2026-10-21' } },
          { field: 'category', before: 'resurface', after: 'today' },
        ],
      );
      assert.equal(read.corrections[0].note, 'Not urgent');
      assert.equal(read.corrections[1].note, null);
      // The signal itself is never rewritten by a correction
      assert.deepEqual(read.signal.time, { dueDate: '2026-10-25' });
      assert.equal(read.signal.category, null);
    }
  });

  it('dismisses as not actionable, and a correction back makes it active again', async () => {
    const w = await world();
    await w.intelligence.execute(
      w.command('correct', w.deadlineId, 0, { entryId: 'e1', change: { field: 'actionable', after: false } }),
    );
    let read = await w.intelligence.readSignal(w.deadlineId);
    if (read.kind === 'ready') {
      assert.equal(read.state.status, 'dismissed');
      assert.equal(read.state.dismissReason, 'not-actionable');
    }
    await w.intelligence.execute(
      w.command('correct', w.deadlineId, 1, { entryId: 'e2', change: { field: 'actionable', after: true } }),
    );
    read = await w.intelligence.readSignal(w.deadlineId);
    if (read.kind === 'ready') assert.equal(read.state.status, 'active');
  });

  it('removes a connection’s sources one at a time, and leaving one dismisses it as not related', async () => {
    const w = await world();
    /** @param {string} noteId */
    const source = noteId => ({ kind: 'note', noteId, revision: 0 });
    /**
     * @param {number} revision
     * @param {string} noteId
     * @param {boolean} after
     */
    const remove = (revision, noteId, after = false) =>
      w.intelligence.execute(
        w.command('correct', w.connectionId, revision, {
          entryId: `src-${revision}`,
          change: { field: 'source', sourceRef: source(noteId), after },
        }),
      );
    assertOutcome(await remove(0, 'n2'), 'committed');
    let read = await w.intelligence.readSignal(w.connectionId);
    if (read.kind === 'ready') assert.equal(read.state.status, 'active');
    assertOutcome(await remove(1, 'n3'), 'committed');
    read = await w.intelligence.readSignal(w.connectionId);
    if (read.kind === 'ready') {
      assert.equal(read.state.status, 'dismissed');
      assert.equal(read.state.dismissReason, 'not-related');
    }
    assertOutcome(await remove(2, 'n3', true), 'committed');
    read = await w.intelligence.readSignal(w.connectionId);
    if (read.kind === 'ready') assert.equal(read.state.status, 'active');
    assertOutcome(await remove(3, 'n9'), 'rejected', 'source-not-cited');
    assertOutcome(
      await w.intelligence.execute(
        w.command('correct', w.deadlineId, 0, {
          entryId: 'x',
          change: { field: 'source', sourceRef: source('n1'), after: false },
        }),
      ),
      'rejected',
      'action-not-available',
    );
  });
});

describe('one completion authority (#7, "One completion authority")', () => {
  it('completes an objective task through the note command, and the signal follows the committed checked', async () => {
    const w = await world();
    await w.addNote('n5', [todo('t1', 'Call vendor')]);
    const id = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
    const before = await w.readNote('n5');
    const complete = w.command('complete', id, 0);
    const outcome = await w.intelligence.execute(complete);
    assertOutcome(outcome, 'committed', 'signal-completed');
    assert.deepEqual(w.noteCalls, [
      {
        commandId: complete.commandId,
        noteId: 'n5',
        blockId: 't1',
        checked: true,
        expectedRevision: before?.revision ?? null,
      },
    ]);
    const note = await w.readNote('n5');
    assert.equal(note?.blocks.find(block => block.id === 't1')?.checked, true);
    let read = await w.intelligence.readSignal(id);
    assert.equal(read.kind, 'ready');
    if (read.kind === 'ready') {
      assert.equal(read.signal.checked, true);
      assert.equal(read.signal.sourceRefs[0].revision, note?.revision);
      assert.equal(read.state.status, 'completed');
      // The decision never says completed for an objective task: the block's checked does
      assert.equal(read.decision?.status, 'active');
      assert.equal(read.decision?.decisionRevision, 1);
    }
    // A retry is answered from the outcome it got, with no second note command
    assert.deepEqual(await w.intelligence.execute({ ...complete }), outcome);
    assert.equal(w.noteCalls.length, 1);

    const reopen = await w.intelligence.execute(w.command('reopen', id, 1));
    assertOutcome(reopen, 'committed', 'signal-reopened');
    assert.equal(w.noteCalls.at(-1)?.checked, false);
    assert.equal((await w.readNote('n5'))?.blocks.find(block => block.id === 't1')?.checked, false);
    read = await w.intelligence.readSignal(id);
    if (read.kind === 'ready') {
      assert.equal(read.signal.checked, false);
      assert.equal(read.state.status, 'active');
    }
  });

  it('reopens a dismissed or snoozed task through the decision alone, since its block is not checked', async () => {
    const w = await world();
    await w.addNote('n5', [todo('t1', 'Call vendor')]);
    const id = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
    assertOutcome(await w.intelligence.execute(w.command('dismiss', id, 0)), 'committed');
    assertOutcome(await w.intelligence.execute(w.command('reopen', id, 1)), 'committed', 'signal-reopened');
    assert.equal(w.noteCalls.length, 0);
  });

  it('leaves the signal as it was with a typed outcome when the note changed since the signal read it', async () => {
    const w = await world();
    await w.addNote('n5', [todo('t1', 'Call vendor'), todo('t2', 'Pay invoice')]);
    const id = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
    // Another block's edit moves the note's revision past the one the signal read
    await w.editBlock('n5', todo('t2', 'Pay the invoice'));
    const outcome = await w.intelligence.execute(w.command('complete', id, 0));
    assertOutcome(outcome, 'conflict', 'note-revision-conflict');
    if (outcome.kind === 'conflict' && 'current' in outcome) {
      assert.equal(outcome.current.status, 'active');
      assert.equal(outcome.current.checked, false);
    }
    assert.equal((await w.readNote('n5'))?.blocks.find(block => block.id === 't1')?.checked, false);
    const read = await w.intelligence.readSignal(id);
    if (read.kind === 'ready') {
      assert.equal(read.signal.checked, false);
      assert.equal(read.decision, null);
      assert.equal(read.state.status, 'active');
    }
  });

  it('answers unavailable when the note command throws, and writes nothing', async () => {
    const repository = createMemoryIntelligenceRepository();
    const intelligence = createIntelligence({
      repository,
      noteCommands: {
        setTodoChecked: async () => {
          throw new UnavailableError('storage', 'note-write-failed', true);
        },
      },
      timeZone: ZONE,
      clock: testClock(),
    });
    await intelligence.upsertSignals(TASKS, [taskDraft()]);
    const id = idOf(taskDraft());
    const outcome = await intelligence.execute({
      type: 'intelligence.complete',
      commandId: 'c1',
      signalId: id,
      expectedDecisionRevision: 0,
    });
    assertOutcome(outcome, 'unavailable', 'note-write-failed');
    const read = await intelligence.readSignal(id);
    if (read.kind === 'ready') {
      assert.equal(read.signal.checked, false);
      assert.equal(read.decision, null);
    }
  });

  it('writes no note record, note revision, or updatedAt for any other lifecycle command or producer write', async () => {
    const w = await world();
    await w.addNote('n5', [todo('t1', 'Call vendor')]);
    const taskId = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
    const before = await w.noteSnapshot(['n5']);
    let revision = 0;
    for (const [type, fields] of /** @type {Array<[string, Record<string, unknown>]>} */ ([
      ['complete', {}],
      ['reopen', {}],
      ['snooze', { until: NOW + HOUR }],
      ['dismiss', {}],
      ['correct', { entryId: 'e1', change: { field: 'time', after: { dueDate: '2026-10-21' } } }],
    ])) {
      assertOutcome(await w.intelligence.execute(w.command(type, w.deadlineId, revision++, fields)), 'committed');
    }
    assertOutcome(await w.intelligence.execute(w.command('snooze', taskId, 0, { until: NOW + HOUR })), 'committed');
    assertOutcome(await w.intelligence.execute(w.command('dismiss', w.pinId, 0)), 'committed');
    await w.intelligence.upsertSignals(RECIPE, [inferredDraft({ noteId: 'n5', blockId: 't1', subject: 'call' })]);
    await w.intelligence.invalidate({ cause: 'model-changed', match: { modelId: 'gemma-3n' } });
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: 9 });
    assert.deepEqual(await w.noteSnapshot(['n5']), before);
    assert.equal(w.noteCalls.length, 0);
  });
});
