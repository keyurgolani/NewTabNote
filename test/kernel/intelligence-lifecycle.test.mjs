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
  manualTimers,
  pinDraft,
  taskDraft,
  todo,
  noteCommandsFake,
  realTimers,
} from './intelligence-fixtures.mjs';
import { NOW, testClock } from './support.mjs';

/** @typedef {import('../../js/kernel/core/intelligence/operations.js').IntelligenceOutcome} IntelligenceOutcome */
/** @typedef {Awaited<ReturnType<typeof world>>} World */

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
      noteCommands: noteCommandsFake(async () => assert.fail('no note command')),
      timers: realTimers,
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
      noteCommands: noteCommandsFake(async () => {
        throw new UnavailableError('storage', 'note-write-failed', true);
      }),
      timers: realTimers,
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

describe('the objective-task path under races (#71 review)', () => {
  /** A world with one task, t1 in n5, and its signal id */
  async function taskWorld() {
    const w = await world();
    await w.addNote('n5', [todo('t1', 'Call vendor'), todo('t2', 'Pay invoice')]);
    return { w, id: idOf(taskDraft({ noteId: 'n5', blockId: 't1' })) };
  }

  /**
   * @param {World} w
   * @param {string} id
   */
  const stateOf = async (w, id) => {
    const read = await w.intelligence.readSignal(id);
    if (read.kind !== 'ready') throw new Error('signal missing');
    return read;
  };

  it('lets a complete that started first win in one context, so a concurrent dismiss conflicts with it', async () => {
    const { w, id } = await taskWorld();
    const [complete, dismiss] = await Promise.all([
      w.intelligence.execute(w.command('complete', id, 0)),
      w.intelligence.execute(w.command('dismiss', id, 0)),
    ]);
    assertOutcome(complete, 'committed', 'signal-completed');
    assertOutcome(dismiss, 'conflict', 'signal-decision-conflict');
    if (dismiss.kind === 'conflict' && 'current' in dismiss) {
      assert.equal(dismiss.current.status, 'completed');
      assert.equal(dismiss.current.decisionRevision, 1);
    }
    const read = await stateOf(w, id);
    assert.equal(read.state.status, 'completed');
    assert.equal(read.decision?.history.length, 1);
    assert.equal((await w.readNote('n5'))?.blocks.find(block => block.id === 't1')?.checked, true);
  });

  it('makes a complete that lost the race conflict before it writes the note', async () => {
    const { w, id } = await taskWorld();
    const [dismiss, complete] = await Promise.all([
      w.intelligence.execute(w.command('dismiss', id, 0)),
      w.intelligence.execute(w.command('complete', id, 0)),
    ]);
    assertOutcome(dismiss, 'committed', 'signal-dismissed');
    assertOutcome(complete, 'conflict', 'signal-decision-conflict');
    assert.equal(w.noteCalls.length, 0);
    assert.equal((await w.readNote('n5'))?.blocks.find(block => block.id === 't1')?.checked, false);
    const read = await stateOf(w, id);
    assert.equal(read.signal.checked, false);
    assert.equal(read.state.status, 'dismissed');
  });

  it('across contexts, a note write that landed wins: the decision goes on top and the answer is committed', async () => {
    const { w, id } = await taskWorld();
    const race = { dismissed: /** @type {Promise<IntelligenceOutcome> | null} */ (null) };
    const other = w.anotherContext();
    // The other context dismisses while this one's note command is in flight
    const racing = w.anotherContext({
      ...w.noteCommands,
      async setTodoChecked(command) {
        const outcome = await w.noteCommands.setTodoChecked(command);
        race.dismissed = other.execute(w.command('dismiss', id, 0));
        await race.dismissed;
        return outcome;
      },
    });
    const complete = w.command('complete', id, 0);
    const outcome = await racing.execute(complete);
    assertOutcome(outcome, 'committed', 'signal-completed');
    assertOutcome(await /** @type {Promise<IntelligenceOutcome>} */ (race.dismissed), 'committed', 'signal-dismissed');
    if (outcome.kind === 'committed') assert.equal(outcome.revision, 2);
    const read = await stateOf(w, id);
    assert.equal(read.state.status, 'completed');
    assert.equal(read.signal.checked, true);
    assert.deepEqual(
      read.decision?.history.map(entry => entry.action),
      ['dismiss', 'complete'],
    );
    // A retry answers the same committed outcome
    assert.deepEqual(await racing.execute({ ...complete }), outcome);
  });

  it('answers an in-flight duplicate with the first one’s outcome, in one context and across two', async () => {
    const { w, id } = await taskWorld();
    const complete = w.command('complete', id, 0);
    const [first, second] = await Promise.all([
      w.intelligence.execute(complete),
      w.intelligence.execute({ ...complete }),
    ]);
    assertOutcome(first, 'committed', 'signal-completed');
    assert.deepEqual(second, first);
    assert.equal(w.noteCalls.length, 1);

    const reopen = w.command('reopen', id, 1);
    const [a, b] = await Promise.all([w.intelligence.execute(reopen), w.anotherContext().execute({ ...reopen })]);
    assertOutcome(a, 'committed', 'signal-reopened');
    assert.deepEqual(b, a);
    const read = await stateOf(w, id);
    assert.equal(read.state.decisionRevision, 2);
    assert.equal(read.signal.checked, false);
  });

  it('completes a task once another block’s edit has been heard, and recovers on the next try when it hasn’t', async () => {
    const { w, id } = await taskWorld();
    await w.editBlock('n5', todo('t2', 'Pay the invoice'));
    const revision = (await w.readNote('n5'))?.revision;
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't2', revision: revision ?? null });
    assertOutcome(await w.intelligence.execute(w.command('complete', id, 0)), 'committed', 'signal-completed');

    const other = idOf(taskDraft({ noteId: 'n5', blockId: 't2' }));
    // An edit nobody told the domain about: the first try conflicts and re-reads the anchor
    await w.editBlock('n5', todo('t1', 'Call vendor'));
    const conflict = await w.intelligence.execute(w.command('complete', other, 0));
    assertOutcome(conflict, 'conflict', 'note-revision-conflict');
    const after = (await w.readNote('n5'))?.revision;
    const read = await stateOf(w, other);
    assert.equal(read.signal.sourceRefs[0].revision, after);
    if (conflict.kind === 'conflict' && 'current' in conflict) assert.deepEqual(conflict.current, read.state);
    assertOutcome(await w.intelligence.execute(w.command('complete', other, 0)), 'committed', 'signal-completed');
  });
});

describe('keys and snoozes (#71 review)', () => {
  it('refuses a key reused with another payload after its first command was rejected', async () => {
    const w = await world();
    const first = await w.intelligence.execute({
      type: 'intelligence.snooze',
      commandId: 'K',
      signalId: w.deadlineId,
      expectedDecisionRevision: 0,
      until: NOW,
    });
    assertOutcome(first, 'rejected', 'snooze-not-future');
    const reused = await w.intelligence.execute({
      type: 'intelligence.dismiss',
      commandId: 'K',
      signalId: w.deadlineId,
      expectedDecisionRevision: 0,
    });
    assertOutcome(reused, 'rejected', 'idempotency-key-reuse');
  });

  it('measures a floating due date to the end of its local day before warning a snooze is past due', async () => {
    const w = await intelligenceWorld();
    const tomorrow = inferredDraft({ time: { dueDate: '2026-10-21' } });
    await w.intelligence.upsertSignals(RECIPE, [tomorrow]);
    const nineOnTheDay = Date.parse('2026-10-21T13:00:00Z'); // 09:00 EDT
    const onTime = await w.intelligence.execute({
      type: 'intelligence.snooze',
      commandId: 's1',
      signalId: idOf(tomorrow),
      expectedDecisionRevision: 0,
      until: nineOnTheDay,
    });
    assertOutcome(onTime, 'committed', 'signal-snoozed');
    const late = await w.intelligence.execute({
      type: 'intelligence.snooze',
      commandId: 's2',
      signalId: idOf(tomorrow),
      expectedDecisionRevision: 1,
      until: nineOnTheDay + 24 * HOUR,
    });
    assertOutcome(late, 'committed', 'signal-snoozed-past-due');
  });
});

describe('the anchor revision only moves forward (#71 round 2)', () => {
  /** A world with tasks t1 and t2 in n5 */
  async function taskWorld(options = {}) {
    const w = await intelligenceWorld(options);
    await w.addNote('n5', [todo('t1', 'Call vendor'), todo('t2', 'Pay invoice')]);
    let count = 0;
    /**
     * @param {string} type
     * @param {number} expectedDecisionRevision
     * @param {Record<string, unknown>} [fields]
     */
    const command = (type, expectedDecisionRevision, fields = {}) => ({
      type: `intelligence.${type}`,
      commandId: `r2-${++count}`,
      signalId: idOf(taskDraft({ noteId: 'n5', blockId: 't1' })),
      expectedDecisionRevision,
      ...fields,
    });
    return { w, id: idOf(taskDraft({ noteId: 'n5', blockId: 't1' })), command };
  }

  /**
   * @param {Awaited<ReturnType<typeof intelligenceWorld>>} w
   * @param {string} id
   */
  const stateOf = async (w, id) => {
    const read = await w.intelligence.readSignal(id);
    if (read.kind !== 'ready') throw new Error('signal missing');
    return read;
  };

  /** @param {Awaited<ReturnType<typeof intelligenceWorld>>} w */
  const checkedOf = async w => (await w.readNote('n5'))?.blocks.find(block => block.id === 't1')?.checked === true;

  it('in one context, a slow re-derive never lands over a complete that came after it', async () => {
    const { w, id, command } = await taskWorld();
    let release = () => {};
    w.tasks.hold = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    await w.editBlock('n5', todo('t2', 'Pay the invoice'));
    const edited = w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't2', revision: null });
    // Let the derive read the note before the complete starts
    await new Promise(resolve => setTimeout(resolve, 5));
    const completing = w.intelligence.execute(command('complete', 0));
    await new Promise(resolve => setTimeout(resolve, 5));
    w.tasks.hold = null;
    release();
    await edited;
    assertOutcome(await completing, 'committed', 'signal-completed');
    const read = await stateOf(w, id);
    assert.equal(await checkedOf(w), true);
    assert.equal(read.signal.checked, true);
    assert.equal(read.state.status, 'completed');
    assert.equal(read.signal.sourceRefs[0].revision, (await w.readNote('n5'))?.revision);
  });

  it('across contexts, a re-derive that read an older revision is skipped', async () => {
    const { w, id, command } = await taskWorld();
    const other = w.anotherContext();
    let release = () => {};
    w.tasks.hold = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const slow = other.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null });
    await new Promise(resolve => setTimeout(resolve, 5));
    w.tasks.hold = null;
    assertOutcome(await w.intelligence.execute(command('complete', 0)), 'committed', 'signal-completed');
    release();
    await slow;
    const read = await stateOf(w, id);
    assert.equal(read.signal.checked, true);
    assert.equal(read.signal.sourceRefs[0].revision, (await w.readNote('n5'))?.revision);
  });

  it('across contexts, a phase 2 behind a newer note write answers the state that stands, not a completion', async () => {
    const { w, id, command } = await taskWorld();
    const other = w.anotherContext();
    const race = { reopened: /** @type {Promise<unknown> | null} */ (null) };
    const racing = w.anotherContext({
      ...w.noteCommands,
      async setTodoChecked(note) {
        const outcome = await w.noteCommands.setTodoChecked(note);
        // The other context hears the write, re-derives, and the user reopens there
        await other.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null });
        race.reopened = other.execute(command('reopen', 0));
        await race.reopened;
        return outcome;
      },
    });
    const outcome = await racing.execute(command('complete', 0));
    assert.notEqual(outcome.kind, 'committed');
    assertOutcome(outcome, 'conflict', 'note-revision-conflict');
    assert.equal(await checkedOf(w), false);
    const read = await stateOf(w, id);
    assert.equal(read.signal.checked, false);
    assert.equal(read.state.status, 'active');
    if (outcome.kind === 'conflict' && 'current' in outcome) assert.deepEqual(outcome.current, read.state);
  });

  it('keeps a decision another context committed while the note write was in flight', async () => {
    const { w, id, command } = await taskWorld();
    const other = w.anotherContext();
    const racing = w.anotherContext({
      ...w.noteCommands,
      async setTodoChecked(note) {
        const outcome = await w.noteCommands.setTodoChecked(note);
        await other.execute(command('dismiss', 0, { reason: 'not-actionable' }));
        return outcome;
      },
    });
    assertOutcome(await racing.execute(command('complete', 0)), 'committed', 'signal-completed');
    const read = await stateOf(w, id);
    assert.equal(read.decision?.status, 'dismissed');
    assert.equal(read.decision?.dismissReason, 'not-actionable');
    assert.deepEqual(
      read.decision?.history.map(entry => entry.action),
      ['dismiss', 'complete'],
    );
    assert.equal(read.state.status, 'completed');
  });

  it('leaves the note’s tasks as they are when derive throws, and counts it', async () => {
    const { w, id, command } = await taskWorld();
    w.tasks.fail = () => true;
    const failed = await w.intelligence.noteChanged({
      type: 'block-edited',
      noteId: 'n5',
      blockId: 't2',
      revision: null,
    });
    assert.equal(failed.failed.length, 2);
    for (const signalId of [id, idOf(taskDraft({ noteId: 'n5', blockId: 't2' }))]) {
      assert.equal((await stateOf(w, signalId)).signal.freshness.state, 'current');
    }
    w.tasks.fail = null;
    assertOutcome(await w.intelligence.execute(command('complete', 0)), 'committed', 'signal-completed');
  });

  it('bounds the note command, so a hung port leaves the signal’s queue moving', { timeout: 5000 }, async () => {
    const timers = manualTimers();
    const { w, id, command } = await taskWorld({ timers });
    const hung = w.anotherContext({ ...w.noteCommands, setTodoChecked: () => new Promise(() => {}) });
    const completing = hung.execute(command('complete', 0));
    const dismissing = hung.execute(command('dismiss', 0));
    await new Promise(resolve => setTimeout(resolve, 5));
    timers.fireAll();
    const outcome = await completing;
    assertOutcome(outcome, 'unknown', 'note-command-timeout');
    assertOutcome(await dismissing, 'committed', 'signal-dismissed');
    assert.equal(timers.size(), 0);
    assert.equal((await stateOf(w, id)).state.status, 'dismissed');
  });

  it('writes nothing and publishes nothing for a task an edit left as it was', async () => {
    const { w, id } = await taskWorld();
    const before = await stateOf(w, id);
    w.events.length = 0;
    await w.editBlock('n5', todo('t2', 'Pay the invoice'));
    const edited = await w.intelligence.noteChanged({
      type: 'block-edited',
      noteId: 'n5',
      blockId: 't2',
      revision: null,
    });
    // t1 moved only in the note revision it cites; t2's title changed
    assert.ok(edited.changed.includes(idOf(taskDraft({ noteId: 'n5', blockId: 't2' }))));
    const again = await w.intelligence.noteChanged({
      type: 'block-edited',
      noteId: 'n5',
      blockId: 't2',
      revision: null,
    });
    assert.deepEqual(again.changed, []);
    assert.ok((await stateOf(w, id)).signal.revision > before.signal.revision);
    const revisionNow = (await stateOf(w, id)).signal.revision;
    w.events.length = 0;
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't2', revision: null });
    assert.deepEqual(w.events, []);
    assert.equal((await stateOf(w, id)).signal.revision, revisionNow);
  });
});

describe('every writer goes through the signal’s queue (#71 round 3)', () => {
  const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
  const identity = { producerId: TASKS, noteId: 'n5', anchorBlockId: 't1', subjectKey: 'task' };

  /** @param {Parameters<typeof intelligenceWorld>[0]} [options] */
  async function taskWorld(options = {}) {
    const w = await intelligenceWorld(options);
    await w.addNote('n5', [todo('t1', 'Call vendor'), todo('t2', 'Pay invoice')]);
    let count = 0;
    const id = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
    /**
     * @param {string} type
     * @param {number} expectedDecisionRevision
     * @param {Record<string, unknown>} [fields]
     */
    const command = (type, expectedDecisionRevision, fields = {}) => ({
      type: `intelligence.${type}`,
      commandId: `r3-${++count}`,
      signalId: id,
      expectedDecisionRevision,
      ...fields,
    });
    return { w, id, command };
  }

  /** @param {Awaited<ReturnType<typeof intelligenceWorld>>} w */
  const checkedOf = async w => (await w.readNote('n5'))?.blocks.find(block => block.id === 't1')?.checked === true;

  /**
   * @param {Awaited<ReturnType<typeof intelligenceWorld>>} w
   * @param {string} id
   */
  const stateOf = async (w, id) => {
    const read = await w.intelligence.readSignal(id);
    if (read.kind !== 'ready') throw new Error('signal missing');
    return read;
  };

  /** Every way the domain writes a signal, each a call that touches t1's */
  const WRITERS = /** @type {const} */ ([
    'upsertSignals',
    'noteChanged block-edited',
    'noteChanged block-deleted',
    'noteChanged note-state',
    'noteChanged note-deleted',
    'invalidate producer-version',
    'execute',
  ]);

  it('lists the writers: the API is readSignal and these, and each waits behind the signal’s queue', async () => {
    const probe = await taskWorld();
    assert.deepEqual(Object.keys(probe.w.intelligence).sort(), [
      'execute',
      'invalidate',
      'noteChanged',
      'readSignal',
      'upsertSignals',
    ]);
    for (const name of WRITERS) {
      const { w, id, command } = await taskWorld();
      const old = await w.tasks.derive?.(identity);
      assert.ok(old);
      /** @type {Record<(typeof WRITERS)[number], () => Promise<unknown>>} */
      const write = {
        upsertSignals: () => w.intelligence.upsertSignals(TASKS, [{ ...old, title: 'Call the vendor' }]),
        'noteChanged block-edited': async () => {
          await w.editBlock('n5', todo('t1', 'Call the vendor'));
          return w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null });
        },
        'noteChanged block-deleted': () =>
          w.intelligence.noteChanged({ type: 'block-deleted', noteId: 'n5', blockId: 't1' }),
        'noteChanged note-state': () =>
          w.intelligence.noteChanged({
            type: 'note-state',
            noteId: 'n5',
            trashed: true,
            archived: false,
            isTemplate: false,
          }),
        'noteChanged note-deleted': () => w.intelligence.noteChanged({ type: 'note-deleted', noteId: 'n5' }),
        'invalidate producer-version': () => {
          w.tasks.version = 2;
          return w.intelligence.invalidate({ cause: 'producer-version', match: { producerId: TASKS, version: 2 } });
        },
        execute: () => w.intelligence.execute(command('dismiss', 0)),
      };
      const before = await stateOf(w, id);
      // A complete holds t1's queue while its note command waits at the gate
      let release = () => {};
      w.noteGate.hold = new Promise(resolve => {
        release = () => resolve(undefined);
      });
      const holding = w.intelligence.execute(command('complete', 0));
      await tick();
      let settled = false;
      const writing = write[name]().then(() => {
        settled = true;
      });
      await tick(20);
      assert.equal(settled, false, `${name} finished while t1's queue was held`);
      const during = await w.intelligence.readSignal(id);
      assert.equal(
        during.kind === 'ready' ? during.signal.revision : -1,
        before.signal.revision,
        `${name} wrote early`,
      );
      w.noteGate.hold = null;
      release();
      await holding;
      await writing;
    }
  });

  it('never lets an older producer draft put back an older checked', async () => {
    const { w, id, command } = await taskWorld();
    const old = await w.tasks.derive?.(identity);
    assert.ok(old);
    assertOutcome(await w.intelligence.execute(command('complete', 0)), 'committed', 'signal-completed');
    await w.intelligence.upsertSignals(TASKS, [old]);
    const read = await stateOf(w, id);
    assert.equal(read.signal.checked, await checkedOf(w));
    assert.equal(read.signal.checked, true);
    assert.equal(read.signal.sourceRefs[0].revision, (await w.readNote('n5'))?.revision);
  });

  it('never brings back a signal whose anchor was deleted', async () => {
    const { w, id } = await taskWorld();
    const old = await w.tasks.derive?.(identity);
    assert.ok(old);
    await w.intelligence.noteChanged({ type: 'block-deleted', noteId: 'n5', blockId: 't1' });
    const result = await w.intelligence.upsertSignals(TASKS, [old]);
    assert.deepEqual(result.refused, ['anchor-deleted']);
    const read = await stateOf(w, id);
    assert.equal(read.signal.freshness.state, 'invalidated');
    assert.equal(read.signal.freshness.cause, 'anchor-deleted');
  });

  it('keeps a producer upsert landing between a complete’s phases from undoing it', async () => {
    const { w, id, command } = await taskWorld();
    const old = await w.tasks.derive?.(identity);
    assert.ok(old);
    const racing = w.anotherContext({
      ...w.noteCommands,
      async setTodoChecked(note) {
        const outcome = await w.noteCommands.setTodoChecked(note);
        await w.intelligence.upsertSignals(TASKS, [old]);
        return outcome;
      },
    });
    assertOutcome(await racing.execute(command('complete', 0)), 'committed', 'signal-completed');
    const read = await stateOf(w, id);
    assert.equal(read.signal.checked, true);
    assert.equal(await checkedOf(w), true);
  });

  it(
    'bounds a hung derive by its own short deadline, after which the queue moves and it counts as failed',
    { timeout: 5000 },
    async () => {
      const timers = manualTimers();
      const { w, id, command } = await taskWorld({ timers });
      w.tasks.hold = new Promise(() => {});
      const edited = w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't2', revision: null });
      await tick();
      // The derive runs in the signal's queue, so a dismiss waits for it, up to its deadline
      const dismissing = w.intelligence.execute(command('dismiss', 0));
      const raced = await Promise.race([
        dismissing.then(outcome => outcome.kind),
        tick(50).then(() => 'still-waiting'),
      ]);
      assert.equal(raced, 'still-waiting');
      timers.fireAll();
      w.tasks.hold = null;
      const result = await edited;
      assert.ok(result.failed.includes(id));
      assertOutcome(await dismissing, 'committed', 'signal-dismissed');
      assert.equal((await stateOf(w, id)).signal.freshness.state, 'current');
    },
  );

  it('never lets a slow null derive wipe out the newer signal a producer wrote meanwhile', async () => {
    const { w, id } = await taskWorld();
    await w.editBlock('n5', { id: 't1', type: 'text', content: 'Call vendor' });
    let release = () => {};
    w.tasks.hold = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const edited = w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null });
    await tick();
    w.tasks.hold = null;
    await w.editBlock('n5', todo('t1', 'Call vendor'));
    const fresh = await w.tasks.derive?.(identity);
    assert.ok(fresh);
    const upserting = w.intelligence.upsertSignals(TASKS, [fresh]);
    await tick();
    release();
    await edited;
    await upserting;
    const read = await stateOf(w, id);
    assert.equal(read.signal.freshness.state, 'current');
    assert.equal(read.signal.sourceRefs[0].revision, (await w.readNote('n5'))?.revision);
  });

  it('writes no checked onto a signal whose anchor was deleted before a retry, and tombstones its decision', async () => {
    const timers = manualTimers();
    const { w, id, command } = await taskWorld({ timers });
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    let first = true;
    const slow = w.anotherContext({
      ...w.noteCommands,
      async setTodoChecked(note) {
        if (first) {
          first = false;
          await gate;
        }
        return w.noteCommands.setTodoChecked(note);
      },
    });
    const complete = command('complete', 0);
    const pending = slow.execute(complete);
    await tick();
    timers.fireAll();
    assertOutcome(await pending, 'unknown', 'note-command-timeout');
    release();
    await tick(20);
    assert.equal(
      (await w.kernel.execute({ type: 'deleteBlocks', commandId: 'del-t1', noteId: 'n5', blockIds: ['t1'] })).kind,
      'committed',
    );
    await slow.noteChanged({ type: 'block-deleted', noteId: 'n5', blockId: 't1' });
    await slow.execute({ ...complete });
    const read = await stateOf(w, id);
    assert.equal(read.signal.freshness.cause, 'anchor-deleted');
    assert.equal(read.signal.checked, false);
    assert.ok(read.decision?.tombstone);
  });

  it('clears the deadline timer when the note command answers in time', async () => {
    const timers = manualTimers();
    const { w, command } = await taskWorld({ timers });
    assertOutcome(await w.intelligence.execute(command('complete', 0)), 'committed', 'signal-completed');
    assert.equal(timers.size(), 0);
  });

  it('answers committed when an unrelated edit overtook the write but the checked asked for stands', async () => {
    const { w, id, command } = await taskWorld();
    const other = w.anotherContext();
    const racing = w.anotherContext({
      ...w.noteCommands,
      async setTodoChecked(note) {
        const outcome = await w.noteCommands.setTodoChecked(note);
        await w.editBlock('n5', todo('t2', 'Pay the invoice'));
        await other.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't2', revision: null });
        return outcome;
      },
    });
    assertOutcome(await racing.execute(command('complete', 0)), 'committed', 'signal-completed');
    const read = await stateOf(w, id);
    assert.equal(read.state.status, 'completed');
    assert.deepEqual(
      read.decision?.history.map(entry => entry.action),
      ['complete'],
    );
  });

  it('resends a timed-out note command unchanged, so the retry gets the kernel’s kept outcome', async () => {
    for (const heard of [true, false]) {
      const timers = manualTimers();
      const { w, id, command } = await taskWorld({ timers });
      let release = () => {};
      const gate = new Promise(resolve => {
        release = () => resolve(undefined);
      });
      let first = true;
      const slow = w.anotherContext({
        ...w.noteCommands,
        async setTodoChecked(note) {
          if (first) {
            first = false;
            await gate;
          }
          return w.noteCommands.setTodoChecked(note);
        },
      });
      const complete = command('complete', 0);
      const pending = slow.execute(complete);
      await tick();
      timers.fireAll();
      assertOutcome(await pending, 'unknown', 'note-command-timeout');
      release();
      await tick(20);
      if (heard) await slow.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null });
      const retry = await slow.execute({ ...complete });
      assertOutcome(retry, 'committed', 'signal-completed');
      const read = await stateOf(w, id);
      assert.equal(read.signal.checked, true);
      assert.deepEqual(
        read.decision?.history.map(entry => entry.action),
        ['complete'],
      );
    }
  });

  it('answers a duplicate of a command that got a note conflict with that conflict', async () => {
    const { w, command } = await taskWorld();
    await w.editBlock('n5', todo('t2', 'Pay the invoice'));
    const complete = command('complete', 0);
    const first = await w.intelligence.execute(complete);
    assertOutcome(first, 'conflict', 'note-revision-conflict');
    assert.deepEqual(await w.intelligence.execute({ ...complete }), first);
  });

  it('answers a duplicate in flight beside a concurrent dismiss with the first one’s outcome', async () => {
    const { w, id } = await taskWorld();
    const complete = { type: 'intelligence.complete', commandId: 'x1', signalId: id, expectedDecisionRevision: 0 };
    const [a, b, d] = await Promise.all([
      w.intelligence.execute(complete),
      w.intelligence.execute({ ...complete }),
      w.intelligence.execute({
        type: 'intelligence.dismiss',
        commandId: 'x2',
        signalId: id,
        expectedDecisionRevision: 0,
      }),
    ]);
    assert.deepEqual(a, b);
    assert.equal(w.noteCalls.length, 1);
    assert.equal(d.kind, 'conflict');
  });

  it('refuses to build without sourceStates or timers', () => {
    const repository = createMemoryIntelligenceRepository();
    const port = noteCommandsFake(async () => assert.fail('no note command'));
    assert.throws(
      () =>
        createIntelligence({
          repository,
          noteCommands: /** @type {any} */ ({ setTodoChecked: port.setTodoChecked }),
          timeZone: ZONE,
          timers: realTimers,
        }),
      TypeError,
    );
    assert.throws(
      () =>
        createIntelligence({ repository, noteCommands: port, timeZone: ZONE, timers: /** @type {any} */ (undefined) }),
      TypeError,
    );
  });
});

describe('#71 follow-ups', () => {
  const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

  /** @param {Parameters<typeof intelligenceWorld>[0]} [options] */
  async function taskWorld(options = {}) {
    const w = await intelligenceWorld(options);
    await w.addNote('n5', [todo('t1', 'Call vendor'), todo('t2', 'Pay invoice')]);
    let count = 0;
    const id = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
    /**
     * @param {string} type
     * @param {number} expectedDecisionRevision
     * @param {Record<string, unknown>} [fields]
     */
    const command = (type, expectedDecisionRevision, fields = {}) => ({
      type: `intelligence.${type}`,
      commandId: `fu-${++count}`,
      signalId: id,
      expectedDecisionRevision,
      ...fields,
    });
    return { w, id, command };
  }

  /**
   * @param {Awaited<ReturnType<typeof intelligenceWorld>>} w
   * @param {string} id
   */
  const stateOf = async (w, id) => {
    const read = await w.intelligence.readSignal(id);
    if (read.kind !== 'ready') throw new Error('signal missing');
    return read;
  };

  it(
    'shares one queued re-derive among every hint behind a hung producer, so a dismiss waits two deadlines at most',
    { timeout: 5000 },
    async () => {
      const timers = manualTimers();
      const { w, command } = await taskWorld({ timers });
      w.tasks.hold = new Promise(() => {});
      /** @type {Promise<unknown>[]} */
      const hints = [];
      for (let index = 0; index < 4; index += 1) {
        await w.editBlock('n5', todo('t1', `Call vendor ${index}`));
        hints.push(w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null }));
      }
      await tick();
      const dismissing = w.intelligence.execute(command('dismiss', 0));
      await tick();
      // The derive that's running times out, then the one the other hints share does
      timers.fireAll();
      await tick();
      const afterOne = await Promise.race([dismissing.then(() => 'committed'), tick(20).then(() => 'still-waiting')]);
      assert.equal(afterOne, 'still-waiting');
      timers.fireAll();
      const raced = await Promise.race([
        dismissing.then(outcome => outcome.kind),
        tick(100).then(() => 'still-waiting'),
      ]);
      assert.equal(raced, 'committed');
      w.tasks.hold = null;
      timers.fireAll();
      await Promise.all(hints);
    },
  );

  it('skips a note conflict’s re-derive when the same producer just timed out', { timeout: 5000 }, async () => {
    const timers = manualTimers();
    const { w, command } = await taskWorld({ timers });
    w.tasks.hold = new Promise(() => {});
    await w.editBlock('n5', todo('t2', 'Pay the invoice'));
    const hint = w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't2', revision: null });
    await tick();
    const completing = w.intelligence.execute(command('complete', 0));
    await tick();
    timers.fireAll();
    const raced = await Promise.race([completing.then(outcome => outcome.code), tick(100).then(() => 'still-waiting')]);
    assert.equal(raced, 'note-revision-conflict');
    w.tasks.hold = null;
    timers.fireAll();
    await hint;
  });

  for (const portReplay of [true, false]) {
    it(`answers a retry whose note port refuses the resent command as reused (port replay ${portReplay ? 'on' : 'off'}) from the checked that stands`, async () => {
      const timers = manualTimers();
      const { w, id, command } = await taskWorld({ timers, portReplay });
      let release = () => {};
      const gate = new Promise(resolve => {
        release = () => resolve(undefined);
      });
      let first = true;
      const slow = w.anotherContext({
        ...w.noteCommands,
        async setTodoChecked(note) {
          if (first) {
            first = false;
            await gate;
          }
          return w.noteCommands.setTodoChecked(note);
        },
      });
      const complete = command('complete', 0);
      const pending = slow.execute(complete);
      await tick();
      timers.fireAll();
      assertOutcome(await pending, 'unknown', 'note-command-timeout');
      release();
      await tick(20);
      // An edit between the late write and the retry: the block is still checked
      await w.editBlock('n5', todo('t1', 'Call the vendor', true));
      const retry = await slow.execute({ ...complete });
      assertOutcome(retry, 'committed', 'signal-completed');
      const read = await stateOf(w, id);
      assert.equal(read.signal.checked, true);
      assert.deepEqual(
        read.decision?.history.map(entry => entry.action),
        ['complete'],
      );
      assert.deepEqual(await slow.execute({ ...complete }), retry);
    });
  }

  it('answers a refused resend as a conflict when the checked that stands differs', async () => {
    const timers = manualTimers();
    const { w, id, command } = await taskWorld({ timers, portReplay: false });
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    let first = true;
    const slow = w.anotherContext({
      ...w.noteCommands,
      async setTodoChecked(note) {
        if (first) {
          first = false;
          await gate;
        }
        return w.noteCommands.setTodoChecked(note);
      },
    });
    const complete = command('complete', 0);
    const pending = slow.execute(complete);
    await tick();
    timers.fireAll();
    await pending;
    release();
    await tick(20);
    // The user unchecked it again in the editor
    await w.editBlock('n5', todo('t1', 'Call vendor', false));
    const retry = await slow.execute({ ...complete });
    assertOutcome(retry, 'conflict', 'note-revision-conflict');
    assert.equal((await stateOf(w, id)).signal.checked, false);
  });

  it('brings back a task the producer had stopped finding once its block is a todo again', async () => {
    const { w, id } = await taskWorld();
    await w.editBlock('n5', { id: 't1', type: 'text', content: 'Call vendor' });
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null });
    assert.equal((await stateOf(w, id)).signal.freshness.cause, 'not-reproduced');
    await w.editBlock('n5', todo('t1', 'Call vendor'));
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null });
    const read = await stateOf(w, id);
    assert.equal(read.signal.freshness.state, 'current');
    // Deleted anchors stay deleted
    await w.intelligence.noteChanged({ type: 'block-deleted', noteId: 'n5', blockId: 't1' });
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n5', blockId: 't1', revision: null });
    assert.equal((await stateOf(w, id)).signal.freshness.cause, 'anchor-deleted');
  });
});

describe('#85 review', () => {
  const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
  /**
   * @param {Awaited<ReturnType<typeof intelligenceWorld>>} w
   * @param {string} noteId
   * @param {string} blockId
   */
  const hint = (w, noteId, blockId) =>
    w.intelligence.noteChanged({ type: 'block-edited', noteId, blockId, revision: null });
  /**
   * @param {Awaited<ReturnType<typeof intelligenceWorld>>} w
   * @param {string} id
   */
  const stateOf = async (w, id) => {
    const read = await w.intelligence.readSignal(id);
    if (read.kind !== 'ready') throw new Error('signal missing');
    return read;
  };

  /**
   * A world whose producer hung once, timed out, and works again
   * @param {Parameters<typeof intelligenceWorld>[0]} [options]
   */
  async function hungOnce(options = {}) {
    const timers = manualTimers();
    const w = await intelligenceWorld({ timers, ...options });
    await w.addNote('n5', [todo('t1', 'Call vendor')]);
    await w.addNote('n8', [todo('u1', 'Buy milk')]);
    let release = () => {};
    w.tasks.hold = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const hung = hint(w, 'n5', 't1');
    await tick();
    timers.fireAll();
    assert.equal((await hung).failed.length, 1);
    w.tasks.hold = null;
    release();
    return { w, timers };
  }

  it('runs every hint after a producer timed out, on its own note and others, whether or not the clock moved', async () => {
    for (const [advance, noteId, blockId, block] of /** @type {const} */ ([
      [1000, 'n5', 't1', todo('t1', 'Call vendor before noon')],
      [500, 'n8', 'u1', todo('u1', 'Buy oat milk')],
      [2000, 'n5', 't1', todo('t1', 'Call vendor', true)],
      [0, 'n5', 't1', todo('t1', 'Call vendor x')],
    ])) {
      const { w } = await hungOnce();
      const id = idOf(taskDraft({ noteId, blockId }));
      w.clock.advance(advance);
      await w.editBlock(noteId, block);
      const result = await hint(w, noteId, blockId);
      assert.deepEqual(result.failed, [], `${noteId} after ${advance} ms`);
      const read = await stateOf(w, id);
      assert.equal(read.signal.title, block.content);
      assert.equal(read.signal.checked, block.checked);
    }
  });

  for (const portReplay of [true, false]) {
    it(`answers unknown again when a resend's derive fails, keeps nothing, and decides on a later retry (replay ${portReplay ? 'on' : 'off'})`, async () => {
      const timers = manualTimers();
      const w = await intelligenceWorld({ timers, portReplay });
      await w.addNote('n5', [todo('t1', 'Call vendor')]);
      const id = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
      const inner = w.noteCommands.setTodoChecked;
      let release = () => {};
      const held = new Promise(resolve => {
        release = () => resolve(undefined);
      });
      w.noteCommands.setTodoChecked = async note => {
        await held;
        return inner(note);
      };
      const complete = { type: 'intelligence.complete', commandId: 'k1', signalId: id, expectedDecisionRevision: 0 };
      const first = w.intelligence.execute(complete);
      await tick();
      timers.fireAll();
      assertOutcome(await first, 'unknown', 'note-command-timeout');
      release();
      await tick(10);
      w.noteCommands.setTodoChecked = inner;
      // The user unchecks it in the note, and that hint's derive times out
      await w.editBlock('n5', todo('t1', 'Call vendor', false));
      let releaseDerive = () => {};
      w.tasks.hold = new Promise(resolve => {
        releaseDerive = () => resolve(undefined);
      });
      const hung = hint(w, 'n5', 't1');
      await tick();
      timers.fireAll();
      await hung;
      w.tasks.hold = null;
      releaseDerive();
      // Inside the still-hung window the resend can't re-derive, so it can't say
      const retry = await w.intelligence.execute({ ...complete });
      assert.equal(retry.kind, 'unknown');
      const during = await stateOf(w, id);
      assert.equal(during.signal.checked, false);
      assert.equal(during.decision, null);
      // Once the window has passed, a retry decides from a real derive
      w.clock.advance(10000);
      const later = await w.intelligence.execute({ ...complete });
      assertOutcome(later, 'conflict', 'note-revision-conflict');
      assert.equal((await stateOf(w, id)).signal.checked, false);
    });
  }

  it('brings back a not-reproduced signal on the next draft even when the draft is the same as before', async () => {
    const w = await intelligenceWorld();
    await w.addNote('n5', [todo('t1', 'Call vendor')]);
    const id = idOf(taskDraft({ noteId: 'n5', blockId: 't1' }));
    const base = /** @type {NonNullable<typeof w.tasks.derive>} */ (w.tasks.derive);
    let once = true;
    w.tasks.derive = async identity => {
      if (once) {
        once = false;
        return null;
      }
      return base.call(w.tasks, identity);
    };
    await hint(w, 'n5', 't1');
    assert.equal((await stateOf(w, id)).signal.freshness.cause, 'not-reproduced');
    await hint(w, 'n5', 't1');
    assert.equal((await stateOf(w, id)).signal.freshness.state, 'current');
    // And through a producer upsert of the same draft
    once = true;
    await hint(w, 'n5', 't1');
    const draft = await base.call(w.tasks, {
      producerId: TASKS,
      noteId: 'n5',
      anchorBlockId: 't1',
      subjectKey: 'task',
    });
    assert.ok(draft);
    assert.deepEqual((await w.intelligence.upsertSignals(TASKS, [draft])).changed, [id]);
    assert.equal((await stateOf(w, id)).signal.freshness.state, 'current');
  });
});
