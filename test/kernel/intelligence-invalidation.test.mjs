// #7 slice 1, the invalidation table (approved AC4): a test for every row, with the version,
// model, runtime, route, and scope causes going through the hook with fake producer
// descriptors, the regeneration requests a stale inference sends, and the user's decision
// surviving every row but anchor deleted (tombstoned) and note deleted (deleted).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { INVALIDATION_TABLE, regenerationRequestSchema } from '../../js/kernel/core/intelligence/invalidation.js';
import { toSignalViewModel } from '../../js/kernel/core/intelligence/view-model.js';
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
import { NOW } from './support.mjs';

/** @typedef {Awaited<ReturnType<typeof intelligenceWorld>>} World */

/**
 * A note with a task (t1), an inferred deadline anchored to t1's sibling (t2), a pin, and a
 * connection, each with a decision the user made first
 * @param {Parameters<typeof intelligenceWorld>[0]} [options]
 */
async function seeded(options) {
  const w = await intelligenceWorld(options);
  await w.addNote('n1', [todo('t1', 'Call vendor'), todo('t2', 'Draft Q3 report')]);
  const inferred = inferredDraft({ blockId: 't2', time: { dueDate: '2026-10-22' } });
  await w.intelligence.upsertSignals(RECIPE, [inferred]);
  await w.intelligence.upsertSignals(PINS, [pinDraft()]);
  await w.intelligence.upsertSignals(LINKS, [connectionDraft()]);
  const ids = {
    task: idOf(taskDraft({ blockId: 't1' })),
    task2: idOf(taskDraft({ blockId: 't2' })),
    inferred: idOf(inferred),
    pin: idOf(pinDraft()),
    connection: idOf(connectionDraft()),
  };
  let count = 0;
  for (const [signalId, until] of [
    [ids.task, NOW + 60_000],
    [ids.inferred, NOW + 120_000],
  ]) {
    const outcome = await w.intelligence.execute({
      type: 'intelligence.snooze',
      commandId: `seed-${++count}`,
      signalId,
      expectedDecisionRevision: 0,
      until,
    });
    assert.equal(outcome.kind, 'committed');
  }
  const corrected = await w.intelligence.execute({
    type: 'intelligence.correct',
    commandId: 'seed-correct',
    signalId: ids.inferred,
    expectedDecisionRevision: 1,
    entryId: 'seed-entry',
    change: { field: 'category', after: 'today' },
  });
  assert.equal(corrected.kind, 'committed');
  w.requests.length = 0;
  w.events.length = 0;
  return { w, ids };
}

/**
 * @param {World} w
 * @param {string} signalId
 */
async function read(w, signalId) {
  const state = await w.intelligence.readSignal(signalId);
  assert.equal(state.kind, 'ready', `signal ${signalId} reads`);
  if (state.kind !== 'ready') throw new Error('unreachable');
  return state;
}

/**
 * The decisions of `ids`, as their statuses and revisions
 * @param {World} w
 * @param {string[]} ids
 */
async function decisions(w, ids) {
  return Promise.all(
    ids.map(async id => {
      const state = await w.intelligence.readSignal(id);
      return state.kind === 'ready'
        ? state.decision && { status: state.decision.status, rev: state.decision.decisionRevision }
        : 'gone';
    }),
  );
}

describe('the invalidation table (#7, "Data and migration")', () => {
  it('documents each row with its objective, inferred, and decision effects', () => {
    assert.deepEqual(Object.keys(INVALIDATION_TABLE).sort(), [
      'anchor-deleted',
      'anchor-edited',
      'model-changed',
      'note-archived',
      'note-deleted',
      'note-restored',
      'note-trashed',
      'producer-version',
      'recipe-version',
      'route-changed',
      'runtime-changed',
      'scope-revoked',
      'template',
    ]);
  });

  it('anchor edited: re-derives the objective signal under the same id, stales the inference, keeps decisions', async () => {
    const { w, ids } = await seeded();
    const before = await decisions(w, [ids.task, ids.inferred]);
    await w.editBlock('n1', todo('t1', 'Call the vendor back'));
    const edited = await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n1', blockId: 't1', revision: 2 });
    assert.deepEqual(edited.changed, [ids.task]);
    const task = await read(w, ids.task);
    assert.equal(task.signal.title, 'Call the vendor back');
    assert.equal(task.signal.freshness.state, 'current');
    assert.equal(task.signal.sourceRefs[0].revision, (await w.readNote('n1'))?.revision);

    // An edit at the revision the inference already read changes nothing about it
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n1', blockId: 't2', revision: 0 });
    assert.equal((await read(w, ids.inferred)).signal.freshness.state, 'current');
    assert.deepEqual(w.requests, []);

    await w.editBlock('n1', todo('t2', 'Draft the Q3 report'));
    const staled = await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n1', blockId: 't2', revision: 3 });
    const inferred = await read(w, ids.inferred);
    assert.deepEqual(
      {
        state: inferred.signal.freshness.state,
        cause: inferred.signal.freshness.cause,
        since: inferred.signal.freshness.since,
      },
      { state: 'stale', cause: 'source-edited', since: NOW },
    );
    assert.deepEqual(staled.regeneration, [
      { noteId: 'n1', recipeId: RECIPE, signalIds: [ids.inferred], cause: 'source-edited', priority: 1 },
    ]);
    assert.deepEqual(w.requests, staled.regeneration);
    assert.deepEqual(await decisions(w, [ids.task, ids.inferred]), before);
    assert.equal(inferred.corrections.length, 1);
  });

  it('anchor edited into something that is no longer a task: the objective signal is invalidated as not reproduced', async () => {
    const { w, ids } = await seeded();
    await w.editBlock('n1', { id: 't1', type: 'text', content: 'Call vendor' });
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n1', blockId: 't1', revision: 2 });
    const task = await read(w, ids.task);
    assert.equal(task.signal.freshness.state, 'invalidated');
    assert.equal(task.signal.freshness.cause, 'not-reproduced');
    assert.equal(task.decision?.status, 'snoozed');
  });

  it('anchor deleted: invalidates both kinds and tombstones their decisions, keeping the status', async () => {
    const { w, ids } = await seeded();
    for (const blockId of ['t1', 't2']) {
      await w.intelligence.noteChanged({ type: 'block-deleted', noteId: 'n1', blockId });
    }
    for (const id of [ids.task, ids.inferred]) {
      const state = await read(w, id);
      assert.equal(state.signal.freshness.state, 'invalidated');
      assert.equal(state.signal.freshness.cause, 'anchor-deleted');
      assert.equal(state.signal.freshness.invalidatedAt, NOW);
      assert.deepEqual(state.decision?.tombstone, { at: NOW, cause: 'anchor-deleted' });
      assert.equal(state.decision?.status, 'snoozed');
      assert.equal(state.decision?.history.at(-1)?.action, 'tombstone');
    }
    // A signal with no decision gets none
    await w.intelligence.upsertSignals(RECIPE, [inferredDraft({ blockId: 't3', subject: 'other' })]);
    await w.intelligence.noteChanged({ type: 'block-deleted', noteId: 'n1', blockId: 't3' });
    assert.equal((await read(w, idOf(inferredDraft({ blockId: 't3', subject: 'other' })))).decision, null);
    // Anchor-null signals cite the note, so a block deletion leaves them
    assert.equal((await read(w, ids.pin)).signal.freshness.state, 'current');
  });

  it('note trashed or archived: suspends every signal of the note, and restoring puts each back as it was', async () => {
    const { w, ids } = await seeded();
    await w.intelligence.invalidate({ cause: 'model-changed', match: { modelId: 'gemma-3n' } });
    const all = [ids.task, ids.inferred, ids.pin, ids.connection];
    const before = await decisions(w, all);
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: true,
      archived: false,
      isTemplate: false,
    });
    for (const id of all) {
      const state = await read(w, id);
      assert.equal(state.signal.freshness.state, 'suspended');
      assert.equal(state.signal.freshness.cause, 'note-trashed');
      assert.equal(
        toSignalViewModel(state.signal, state.decision, state.corrections, NOW, { timeZone: ZONE }).hidden,
        true,
      );
    }
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: true,
      archived: true,
      isTemplate: false,
    });
    // Still trashed, so still suspended
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: false,
      archived: true,
      isTemplate: false,
    });
    assert.equal((await read(w, ids.task)).signal.freshness.cause, 'note-archived');
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: false,
      archived: false,
      isTemplate: false,
    });
    assert.equal((await read(w, ids.task)).signal.freshness.state, 'current');
    const inferred = (await read(w, ids.inferred)).signal.freshness;
    assert.equal(inferred.state, 'stale');
    assert.equal(inferred.cause, 'model-changed');
    assert.deepEqual(await decisions(w, all), before);
  });

  it('note deleted for good: its signals, decisions, and corrections go in one commit, and nothing else does', async () => {
    const { w, ids } = await seeded();
    await w.addNote('n2', [todo('x1', 'Other task')]);
    const other = idOf(taskDraft({ noteId: 'n2', blockId: 'x1' }));
    w.events.length = 0;
    const deleted = await w.intelligence.noteChanged({ type: 'note-deleted', noteId: 'n1' });
    assert.deepEqual([...deleted.removed].sort(), [ids.task, ids.task2, ids.inferred, ids.pin, ids.connection].sort());
    for (const id of deleted.removed) assert.equal((await w.intelligence.readSignal(id)).kind, 'not-found');
    const seqs = new Set(w.events.map(event => event.commitSeq));
    assert.deepEqual([...seqs], [deleted.commitSeq]);
    assert.ok(w.events.some(event => event.type === 'intelligence.decisionRemoved' && event.entityId === ids.inferred));
    assert.ok(
      w.events.some(event => event.type === 'intelligence.correctionsRemoved' && event.entityId === ids.inferred),
    );
    assert.equal((await w.intelligence.readSignal(other)).kind, 'ready');
    // The note itself is the note authority's: the domain deleted nothing of it
    assert.ok(await w.readNote('n1'));
  });

  it('template: suspends the note’s signals, and stopping being one resumes them', async () => {
    const { w, ids } = await seeded();
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: false,
      archived: false,
      isTemplate: true,
    });
    const task = await read(w, ids.task);
    assert.equal(task.signal.freshness.state, 'suspended');
    assert.equal(task.signal.freshness.cause, 'template');
    assert.equal(task.decision?.status, 'snoozed');
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: false,
      archived: false,
      isTemplate: false,
    });
    assert.equal((await read(w, ids.task)).signal.freshness.state, 'current');
  });

  it('producer version: re-derives the objective signals the old version made, under the same ids', async () => {
    const { w, ids } = await seeded();
    const before = await decisions(w, [ids.task]);
    w.tasks.version = 2;
    const result = await w.intelligence.invalidate({
      cause: 'producer-version',
      match: { producerId: TASKS, version: 2 },
    });
    assert.deepEqual([...result.changed].sort(), [ids.task, ids.task2].sort());
    const task = await read(w, ids.task);
    assert.equal(task.signal.producerVersion, 2);
    assert.equal(task.signal.freshness.state, 'current');
    assert.deepEqual(await decisions(w, [ids.task]), before);
    // Signals the new version made aren't matched again
    assert.deepEqual(
      (await w.intelligence.invalidate({ cause: 'producer-version', match: { producerId: TASKS, version: 2 } }))
        .changed,
      [],
    );
    assert.deepEqual(result.regeneration, []);
  });

  it('recipe version: stales the inferences the old version made and requests their regeneration', async () => {
    const { w, ids } = await seeded();
    await w.intelligence.upsertSignals(RECIPE, [
      inferredDraft({ noteId: 'n2', blockId: 'z1', version: 2, subject: 'newer' }),
    ]);
    const result = await w.intelligence.invalidate({
      cause: 'recipe-version',
      match: { producerId: RECIPE, version: 2 },
    });
    assert.deepEqual(result.changed, [ids.inferred]);
    const inferred = await read(w, ids.inferred);
    assert.equal(inferred.signal.freshness.state, 'stale');
    assert.equal(inferred.signal.freshness.cause, 'recipe-version');
    assert.deepEqual(result.regeneration, [
      { noteId: 'n1', recipeId: RECIPE, signalIds: [ids.inferred], cause: 'recipe-version', priority: 1 },
    ]);
    assert.equal(
      (await read(w, idOf(inferredDraft({ noteId: 'n2', blockId: 'z1', subject: 'newer' })))).signal.freshness.state,
      'current',
    );
  });

  for (const [
    cause,
    match,
    untouched,
  ] of /** @type {Array<[string, Record<string, string>, Parameters<typeof inferredDraft>[0]]>} */ ([
    ['model-changed', { modelId: 'gemma-3n' }, { modelId: 'other-model' }],
    ['runtime-changed', { executionClass: 'local-model' }, { executionClass: 'remote' }],
    ['route-changed', { providerId: 'local-runtime' }, { providerId: 'other-provider' }],
  ])) {
    it(`${cause}: stales the matching inferences, leaves objective signals, and requests regeneration`, async () => {
      const { w, ids } = await seeded();
      const spared = inferredDraft({ ...untouched, noteId: 'n3', blockId: 'q1', subject: 'spared' });
      await w.intelligence.upsertSignals(RECIPE, [spared]);
      const before = await decisions(w, [ids.task, ids.inferred]);
      const result = await w.intelligence.invalidate({ cause, match });
      assert.deepEqual(result.changed, [ids.inferred]);
      assert.equal((await read(w, ids.inferred)).signal.freshness.cause, cause);
      assert.equal((await read(w, ids.task)).signal.freshness.state, 'current');
      assert.equal((await read(w, idOf(spared))).signal.freshness.state, 'current');
      assert.equal(result.regeneration.length, 1);
      assert.equal(result.regeneration[0].cause, cause);
      assert.ok(v.is(regenerationRequestSchema, result.regeneration[0]));
      assert.deepEqual(await decisions(w, [ids.task, ids.inferred]), before);
    });
  }

  it('scope revoked: invalidates the matching inferences and clears their title and reason, keeping decisions', async () => {
    const { w, ids } = await seeded();
    const before = await decisions(w, [ids.inferred]);
    const result = await w.intelligence.invalidate({ cause: 'scope-revoked', match: { scopeId: 'scope-notes' } });
    assert.deepEqual(result.changed, [ids.inferred]);
    assert.deepEqual(result.regeneration, []);
    const inferred = await read(w, ids.inferred);
    assert.equal(inferred.signal.freshness.state, 'invalidated');
    assert.equal(inferred.signal.freshness.cause, 'scope-revoked');
    assert.equal(inferred.signal.title, '');
    assert.equal(inferred.signal.confidence?.reason, '');
    assert.deepEqual(await decisions(w, [ids.inferred]), before);
    assert.equal((await read(w, ids.task)).signal.freshness.state, 'current');
  });

  it('refuses a hook call that does not say what it matches', async () => {
    const { w } = await seeded();
    for (const bad of [
      { cause: 'model-changed', match: {} },
      { cause: 'recipe-version', match: { producerId: RECIPE } },
      { cause: 'deleted-everything', match: { noteId: 'n1' } },
      { cause: 'route-changed', match: { providerId: 'p', url: 'https://example.com' } },
    ]) {
      await assert.rejects(w.intelligence.invalidate(bad), TypeError);
    }
    await assert.rejects(w.intelligence.noteChanged({ type: 'note-renamed', noteId: 'n1' }), TypeError);
  });
});

describe('regeneration requests (#7, "Producers")', () => {
  it('sends one request per note and recipe, ordered by the most urgent category, and calls no model', async () => {
    const w = await intelligenceWorld();
    const drafts = [
      inferredDraft({ noteId: 'a', blockId: 'a1', subject: 'one', time: { dueDate: '2026-10-25' } }),
      inferredDraft({ noteId: 'a', blockId: 'a2', subject: 'two', time: { dueAt: NOW - 1 } }),
      inferredDraft({ noteId: 'b', blockId: 'b1', subject: 'three', time: { dueDate: '2026-10-20' } }),
      inferredDraft({ noteId: 'c', blockId: 'c1', subject: 'four', category: 'resurface' }),
    ];
    await w.intelligence.upsertSignals(RECIPE, drafts);
    const result = await w.intelligence.invalidate({ cause: 'model-changed', match: { modelId: 'gemma-3n' } });
    assert.deepEqual(
      result.regeneration.map(request => [request.noteId, request.priority, request.signalIds.length]),
      [
        ['a', 0, 2],
        ['b', 1, 1],
        ['c', 3, 1],
      ],
    );
    assert.deepEqual(result.regeneration[0].signalIds, [idOf(drafts[0]), idOf(drafts[1])].sort());
    for (const request of result.regeneration) assert.ok(v.is(regenerationRequestSchema, request));
    assert.deepEqual(w.requests, result.regeneration);
  });

  it('sends none for a suspended note, which goes stale and then back to stale when restored', async () => {
    const { w, ids } = await seeded();
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: true,
      archived: false,
      isTemplate: false,
    });
    const result = await w.intelligence.invalidate({ cause: 'model-changed', match: { modelId: 'gemma-3n' } });
    assert.deepEqual(result.regeneration, []);
    assert.equal((await read(w, ids.inferred)).signal.freshness.state, 'suspended');
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: false,
      archived: false,
      isTemplate: false,
    });
    assert.equal((await read(w, ids.inferred)).signal.freshness.cause, 'model-changed');
  });

  it('a regenerated inference is current again under its id, with the user’s decision and corrections kept', async () => {
    const { w, ids } = await seeded();
    await w.intelligence.invalidate({ cause: 'model-changed', match: { modelId: 'gemma-3n' } });
    const before = await read(w, ids.inferred);
    await w.intelligence.upsertSignals(RECIPE, [
      inferredDraft({
        blockId: 't2',
        modelId: 'gemma-4',
        title: 'Draft the Q3 report',
        time: { dueDate: '2026-10-22' },
      }),
    ]);
    const after = await read(w, ids.inferred);
    assert.equal(after.signal.freshness.state, 'current');
    assert.equal(after.signal.model?.id, 'gemma-4');
    assert.deepEqual(after.decision, before.decision);
    assert.deepEqual(after.corrections, before.corrections);
  });
});
