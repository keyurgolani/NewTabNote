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
    // Every task of the note is re-derived, since a block cites its note's revision for now
    assert.deepEqual([...edited.changed].sort(), [ids.task, ids.task2].sort());
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

describe('suspension and cited notes (#71 review)', () => {
  it('requests regeneration for an inference that went stale while its note was suspended, once it is restored', async () => {
    const { w, ids } = await seeded();
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: true,
      archived: false,
      isTemplate: false,
    });
    await w.intelligence.invalidate({ cause: 'model-changed', match: { modelId: 'gemma-3n' } });
    assert.deepEqual(w.requests, []);
    const restored = await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: false,
      archived: false,
      isTemplate: false,
    });
    assert.deepEqual(restored.regeneration, [
      { noteId: 'n1', recipeId: RECIPE, signalIds: [ids.inferred], cause: 'model-changed', priority: 1 },
    ]);
    assert.deepEqual(w.requests, restored.regeneration);
  });

  it('suspends a connection when a cited note leaves it under two available sources, and restores it', async () => {
    const { w, ids } = await seeded();
    /** @param {string} noteId @param {boolean} trashed */
    const state = (noteId, trashed) =>
      w.intelligence.noteChanged({ type: 'note-state', noteId, trashed, archived: false, isTemplate: false });
    const opens = async () => {
      const current = await read(w, ids.connection);
      return toSignalViewModel(current.signal, current.decision, current.corrections, NOW, { timeZone: ZONE })
        .actions.filter(action => action.id === 'open')
        .map(action => action.target?.noteId);
    };
    await state('n2', true);
    assert.equal((await read(w, ids.connection)).signal.freshness.state, 'current');
    assert.deepEqual(await opens(), ['n1', 'n3']);
    await state('n3', true);
    const suspended = (await read(w, ids.connection)).signal.freshness;
    assert.equal(suspended.state, 'suspended');
    assert.equal(suspended.cause, 'note-trashed');
    await state('n3', false);
    assert.equal((await read(w, ids.connection)).signal.freshness.state, 'current');
    await state('n2', false);
    assert.deepEqual(await opens(), ['n1', 'n2', 'n3']);
    // The connection's own note still suspends it whatever the others do
    await state('n1', true);
    assert.equal((await read(w, ids.connection)).signal.freshness.state, 'suspended');
    await state('n2', true);
    await state('n1', false);
    assert.equal((await read(w, ids.connection)).signal.freshness.state, 'current');
  });

  it('drops a deleted note from what a connection cites, and invalidates it when one source is left', async () => {
    const { w, ids } = await seeded();
    const before = await read(w, ids.connection);
    await w.intelligence.noteChanged({ type: 'note-deleted', noteId: 'n2' });
    const after = await read(w, ids.connection);
    assert.deepEqual(
      after.signal.sourceRefs.map(source => source.noteId),
      ['n1', 'n3'],
    );
    assert.equal(after.signal.freshness.state, 'current');
    assert.deepEqual(after.decision, before.decision);
    await w.intelligence.noteChanged({ type: 'note-deleted', noteId: 'n3' });
    const gone = await read(w, ids.connection);
    assert.deepEqual(
      gone.signal.sourceRefs.map(source => source.noteId),
      ['n1'],
    );
    assert.equal(gone.signal.freshness.state, 'invalidated');
    assert.equal(gone.signal.freshness.cause, 'source-deleted');
    const targets = toSignalViewModel(gone.signal, gone.decision, gone.corrections, NOW, { timeZone: ZONE })
      .actions.map(action => action.target?.noteId)
      .filter(Boolean);
    assert.ok(targets.every(noteId => noteId === 'n1'));
  });
});

describe('cited notes and requests (#71 round 2)', () => {
  it('counts a source a correction removed when a cited note is trashed', async () => {
    const { w, ids } = await seeded();
    const removed = await w.intelligence.execute({
      type: 'intelligence.correct',
      commandId: 'r2-remove',
      signalId: ids.connection,
      expectedDecisionRevision: 0,
      entryId: 'r2-entry',
      change: { field: 'source', sourceRef: { kind: 'note', noteId: 'n2', revision: 0 }, after: false },
    });
    assert.equal(removed.kind, 'committed');
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n3',
      trashed: true,
      archived: false,
      isTemplate: false,
    });
    assert.equal((await read(w, ids.connection)).signal.freshness.state, 'suspended');
  });

  it('sends no second request on restore for an inference that was stale before its note was trashed', async () => {
    const { w } = await seeded();
    await w.editBlock('n1', todo('t2', 'Draft the Q3 report'));
    await w.intelligence.noteChanged({ type: 'block-edited', noteId: 'n1', blockId: 't2', revision: 3 });
    assert.equal(w.requests.length, 1);
    await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: true,
      archived: false,
      isTemplate: false,
    });
    const restored = await w.intelligence.noteChanged({
      type: 'note-state',
      noteId: 'n1',
      trashed: false,
      archived: false,
      isTemplate: false,
    });
    assert.deepEqual(restored.regeneration, []);
    assert.equal(w.requests.length, 1);
  });

  it('drops a deleted block another note’s signal cites', async () => {
    const w = await intelligenceWorld({ checkSources: true });
    await w.addNote('n1', [todo('t1', 'Call vendor')]);
    await w.addNote('n2', [{ id: 'x1', type: 'text', content: 'Vendor notes' }]);
    const draft = {
      ...inferredDraft({ blockId: 't1', subject: 'cross' }),
      sourceRefs: [
        { kind: /** @type {const} */ ('block'), noteId: 'n1', blockId: 't1', revision: 0 },
        { kind: /** @type {const} */ ('block'), noteId: 'n2', blockId: 'x1', revision: 0 },
      ],
    };
    assert.deepEqual((await w.intelligence.upsertSignals(RECIPE, [draft])).refused, []);
    const deleted = await w.kernel.execute({
      type: 'deleteBlocks',
      commandId: 'del-x1',
      noteId: 'n2',
      blockIds: ['x1'],
    });
    assert.equal(deleted.kind, 'committed');
    await w.intelligence.noteChanged({ type: 'block-deleted', noteId: 'n2', blockId: 'x1' });
    const state = await read(w, idOf(draft));
    assert.deepEqual(
      state.signal.sourceRefs.map(source => source.noteId),
      ['n1'],
    );
    assert.equal(state.signal.freshness.state, 'current');
  });

  it('checks the notes and blocks a new signal cites: a trashed one is unavailable, a missing one dropped', async () => {
    const w = await intelligenceWorld({ checkSources: true });
    await w.addNote('n1', [todo('t1', 'Call vendor')]);
    await w.addNote('n2', []);
    await w.addNote('n3', []);
    const trashed = await w.kernel.execute({ type: 'trashNote', commandId: 'trash-n3', noteId: 'n3' });
    assert.equal(trashed.kind, 'committed');
    const draft = connectionDraft({ others: ['n2', 'n3', 'n9'] });
    assert.deepEqual((await w.intelligence.upsertSignals(LINKS, [draft])).refused, []);
    const state = await read(w, idOf(draft));
    assert.deepEqual(
      state.signal.sourceRefs.map(source => source.noteId),
      ['n1', 'n2', 'n3'],
    );
    assert.deepEqual(state.signal.unavailableNotes, [{ noteId: 'n3', cause: 'note-trashed' }]);
    assert.equal(state.signal.freshness.state, 'current');
    // A signal whose own anchor is gone isn't made at all
    const orphan = inferredDraft({ blockId: 'gone', subject: 'orphan' });
    assert.deepEqual((await w.intelligence.upsertSignals(RECIPE, [orphan])).refused, ['source-missing']);
  });
});

describe('source checks fail closed (#71 round 3)', () => {
  async function notes() {
    const w = await intelligenceWorld({ checkSources: true });
    await w.addNote('n1', [todo('t1', 'Call vendor')]);
    await w.addNote('n2', []);
    await w.addNote('n3', []);
    return w;
  }

  it('refuses and counts an upsert when sourceStates throws or answers the wrong count', async () => {
    const w = await notes();
    const draft = connectionDraft({ others: ['n2', 'n3'] });
    for (const sourceStates of [
      async () => {
        throw new Error('read failed');
      },
      async () => /** @type {any} */ (['available']),
    ]) {
      const context = w.anotherContext({ ...w.noteCommands, sourceStates });
      const result = await context.upsertSignals(LINKS, [draft]);
      assert.deepEqual(result.refused, ['source-states-unavailable']);
      assert.equal((await w.intelligence.readSignal(idOf(draft))).kind, 'not-found');
    }
  });

  it('refuses a connection left with too few notes', async () => {
    const w = await notes();
    const draft = connectionDraft({ others: ['n8', 'n9'] });
    assert.deepEqual((await w.intelligence.upsertSignals(LINKS, [draft])).refused, ['too-few-sources']);
  });

  it('starts a signal citing an archived or template note with it unavailable', async () => {
    const w = await notes();
    assert.equal(
      (await w.kernel.execute({ type: 'archiveNote', commandId: 'arch-n2', noteId: 'n2' })).kind,
      'committed',
    );
    const template = await w.kernel.execute({
      type: 'createNote',
      commandId: 'tmpl-n4',
      noteId: 'n4',
      name: 'n4',
      blocks: [],
    });
    assert.equal(template.kind, 'committed');
    w.markTemplate('n4');
    const draft = connectionDraft({ others: ['n2', 'n4'] });
    assert.deepEqual((await w.intelligence.upsertSignals(LINKS, [draft])).refused, []);
    const state = await read(w, idOf(draft));
    assert.deepEqual(state.signal.unavailableNotes, [
      { noteId: 'n2', cause: 'note-archived' },
      { noteId: 'n4', cause: 'template' },
    ]);
    assert.equal(state.signal.freshness.state, 'suspended');
  });
});

describe('note keys and source states (#71 round 4)', () => {
  /** @param {Awaited<ReturnType<typeof intelligenceWorld>>} w */
  const gatedContext = w => {
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    /** @type {(states: unknown) => void} */
    let readDone = () => {};
    /** Resolves with what the check read, once it has, before the gate opens */
    const read = new Promise(resolve => {
      readDone = resolve;
    });
    const context = w.anotherContext({
      ...w.noteCommands,
      async sourceStates(sourceRefs) {
        const states = await w.noteCommands.sourceStates(sourceRefs);
        readDone(states);
        await gate;
        return states;
      },
    });
    return { context, release, read };
  };

  async function notes() {
    const w = await intelligenceWorld({ checkSources: true });
    await w.addNote('n1', [todo('t1', 'Call vendor')]);
    await w.addNote('n2', []);
    await w.addNote('n6', []);
    return w;
  }

  it('makes a note’s state change wait for an upsert citing the note, so the new signal is suspended', async () => {
    const w = await notes();
    const { context, release, read: checked } = gatedContext(w);
    const draft = connectionDraft({ others: ['n6'] });
    const upserting = context.upsertSignals(LINKS, [draft]);
    assert.deepEqual(await checked, ['available', 'available']);
    assert.equal(
      (await w.kernel.execute({ type: 'trashNote', commandId: 'trash-n6', noteId: 'n6' })).kind,
      'committed',
    );
    const trashing = context.noteChanged({
      type: 'note-state',
      noteId: 'n6',
      trashed: true,
      archived: false,
      isTemplate: false,
    });
    // Let the note change run as far as it can before the check finishes
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await upserting;
    await trashing;
    const state = await read(w, idOf(draft));
    assert.deepEqual(state.signal.unavailableNotes, [{ noteId: 'n6', cause: 'note-trashed' }]);
    assert.equal(state.signal.freshness.state, 'suspended');
  });

  it('makes a note’s deletion wait for an upsert citing the note, so no signal is left citing it', async () => {
    const w = await notes();
    const { context, release, read: checked } = gatedContext(w);
    const draft = connectionDraft({ others: ['n2', 'n6'] });
    const upserting = context.upsertSignals(LINKS, [draft]);
    assert.deepEqual(await checked, ['available', 'available', 'available']);
    const deleting = context.noteChanged({ type: 'note-deleted', noteId: 'n6' });
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await upserting;
    await deleting;
    const state = await read(w, idOf(draft));
    assert.deepEqual(
      state.signal.sourceRefs.map(source => source.noteId),
      ['n1', 'n2'],
    );
  });

  it('refuses junk source states as unavailable', async () => {
    const w = await notes();
    const draft = connectionDraft({ others: ['n2'] });
    for (const junk of [
      [undefined, undefined],
      ['bogus', 'bogus'],
      [null, null],
      [{}, {}],
    ]) {
      const context = w.anotherContext({ ...w.noteCommands, sourceStates: async () => /** @type {any} */ (junk) });
      assert.deepEqual(
        (await context.upsertSignals(LINKS, [draft])).refused,
        ['source-states-unavailable'],
        String(junk),
      );
    }
  });
});
