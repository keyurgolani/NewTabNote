// #7 slice 1, cross-surface state (approved AC3): fake Popup, Side Panel, and Workspace
// surfaces run lifecycle commands against one in-memory repository and hear its typed events
// through #13's hint publisher and subscriber, over a channel that reorders, duplicates, and
// drops them. Each surface reads state rather than applying events, re-reading a signal when a
// hint's commitSeq is past what it holds and catching up from #17's change log, so all three
// converge on the repository's one decision per identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHintPublisher, createHintSubscriber } from '../../js/kernel/core/messaging/hints.js';
import { hintOf } from '../../js/kernel/core/intelligence/events.js';
import { RECIPE, idOf, inferredDraft, intelligenceWorld, taskDraft, todo } from './intelligence-fixtures.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/kernel/core/intelligence/operations.js').DecisionState} DecisionState */
/** @typedef {import('../../js/kernel/core/intelligence/operations.js').IntelligenceOutcome} IntelligenceOutcome */
/** @typedef {Awaited<ReturnType<typeof intelligenceWorld>>} World */

/**
 * A small seeded generator, so a failing order can be run again
 * @param {number} seed
 */
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/**
 * A hint channel that holds every frame the publisher posts until the test delivers them, to
 * each surface in its own shuffled order, some twice and, at `dropRate`, some never
 * @param {() => number} next
 * @param {number} dropRate
 */
function unreliableChannel(next, dropRate) {
  /** @type {string[]} */
  const posted = [];
  /** @type {Array<(text: string) => void>} */
  const listeners = [];
  return {
    publisherSide: { post: (/** @type {string} */ text) => posted.push(text), onMessage: () => {}, close: () => {} },
    /** A surface's side of the channel */
    surfaceSide() {
      return {
        post: () => {},
        onMessage: (/** @type {(text: string) => void} */ listener) => listeners.push(listener),
        close: () => {},
      };
    },
    /** Delivers what's been posted, shuffled per surface, with duplicates and drops */
    deliver() {
      const frames = posted.splice(0);
      for (const listener of listeners) {
        const copy = frames.flatMap(frame => {
          const roll = next();
          if (roll < dropRate) return [];
          if (roll > 0.7) return [frame, frame];
          return [frame];
        });
        for (let index = copy.length - 1; index > 0; index -= 1) {
          const other = Math.floor(next() * (index + 1));
          [copy[index], copy[other]] = [copy[other], copy[index]];
        }
        for (const frame of copy) listener(frame);
      }
    },
  };
}

/**
 * A fake surface: it holds each signal's decision state with the commitSeq it read it at, and
 * reads a signal again on a later hint for it
 * @param {World} world
 * @param {string} name
 * @param {ReturnType<typeof unreliableChannel>} channel
 */
function surface(world, name, channel) {
  /** @type {Map<string, {state: DecisionState, asOf: number}>} */
  const view = new Map();
  /** @type {Promise<unknown>[]} */
  const reading = [];
  let count = 0;

  /** @param {string} signalId */
  const refresh = async signalId => {
    const read = await world.intelligence.readSignal(signalId);
    if (read.kind !== 'ready') return;
    const known = view.get(signalId);
    if (!known || read.asOfCommitSeq >= known.asOf) view.set(signalId, { state: read.state, asOf: read.asOfCommitSeq });
  };

  const subscriber = createHintSubscriber({ channel: channel.surfaceSide() });
  subscriber.subscribe(hint => {
    if (hint.entityType !== 'intelligence') return;
    if (hint.commitSeq > (view.get(hint.entityId)?.asOf ?? 0)) reading.push(refresh(hint.entityId));
  });

  return {
    name,
    view,
    refresh,
    /** Waits for every read a hint started */
    settle: async () => {
      while (reading.length > 0) await Promise.all(reading.splice(0));
    },
    /** Reads every signal #17's change log names past what it holds, as a surface does on open */
    async catchUp() {
      const floor = Math.min(...[...view.values()].map(entry => entry.asOf), 0);
      const changes = await world.commitLog.readChangesSince(floor, 1000);
      if (changes.kind !== 'changes') throw new Error('resync');
      for (const entry of changes.entries) {
        if (entry.entityType === 'intelligence' && entry.commitSeq > (view.get(entry.entityId)?.asOf ?? 0)) {
          await refresh(entry.entityId);
        }
      }
    },
    /**
     * Runs a lifecycle command against the revision it holds, and takes a conflict's state
     * @param {string} type
     * @param {string} signalId
     * @param {Record<string, unknown>} [fields]
     * @returns {Promise<IntelligenceOutcome>}
     */
    async act(type, signalId, fields = {}) {
      const known = view.get(signalId);
      const outcome = await world.intelligence.execute({
        type: `intelligence.${type}`,
        commandId: `${name}-${++count}`,
        signalId,
        expectedDecisionRevision: known?.state.decisionRevision ?? 0,
        ...fields,
      });
      if (outcome.kind === 'conflict' && 'current' in outcome) {
        // The conflict carries the state that stands, but no commitSeq, so the surface reads it
        await refresh(signalId);
      }
      return outcome;
    },
  };
}

/**
 * Three surfaces over one world, with the domain's events going out as #13's hints
 * @param {number} seed
 * @param {number} dropRate
 */
async function surfaces(seed, dropRate) {
  const world = await intelligenceWorld();
  const next = random(seed);
  const channel = unreliableChannel(next, dropRate);
  const publisher = createHintPublisher({ channel: channel.publisherSide });
  await world.addNote('n1', [todo('t1', 'Call vendor')]);
  await world.intelligence.upsertSignals(RECIPE, [inferredDraft({ blockId: 't1', subject: 'call vendor' })]);
  const ids = [idOf(taskDraft({ blockId: 't1' })), idOf(inferredDraft({ blockId: 't1', subject: 'call vendor' }))];
  const clients = ['popup', 'sidepanel', 'workspace'].map(name => surface(world, name, channel));
  for (const client of clients) for (const id of ids) await client.refresh(id);
  // From here on the domain's events reach the surfaces only as hints
  let published = world.events.length;
  const pump = async () => {
    for (const event of world.events.slice(published)) publisher.publish(hintOf(event));
    published = world.events.length;
    await Promise.resolve();
    channel.deliver();
    for (const client of clients) await client.settle();
  };
  return { world, next, clients, ids, pump };
}

const ACTIONS = /** @type {const} */ ([
  ['complete', {}],
  ['reopen', {}],
  ['dismiss', {}],
  ['snooze', { until: NOW + 3_600_000 }],
]);

describe('cross-surface convergence (#7, approved AC3)', () => {
  /**
   * Runs rounds where every surface acts at once on what it last saw, so some race and some
   * act on stale state, then checks each surface holds the repository's state
   * @param {number} seed
   * @param {{dropRate: number, catchUp: boolean}} options
   */
  async function run(seed, { dropRate, catchUp }) {
    const { world, next, clients, ids, pump } = await surfaces(seed, dropRate);
    /** @type {Record<string, number>} */
    const tally = { committed: 0, conflict: 0 };
    for (let round = 0; round < 12; round += 1) {
      const outcomes = await Promise.all(
        clients.map(client => {
          const [type, fields] = ACTIONS[Math.floor(next() * ACTIONS.length)];
          const signalId = ids[Math.floor(next() * ids.length)];
          return client.act(type, signalId, fields);
        }),
      );
      for (const outcome of outcomes) {
        if (outcome.kind === 'committed' || outcome.kind === 'conflict') tally[outcome.kind] += 1;
      }
      await pump();
    }
    assert.ok(tally.committed > 0);
    assert.ok(tally.conflict > 0);
    // A surface that missed hints catches up from the change log, as it does on open
    if (catchUp) for (const client of clients) await client.catchUp();

    for (const id of ids) {
      const read = await world.intelligence.readSignal(id);
      assert.equal(read.kind, 'ready');
      if (read.kind !== 'ready') return;
      // One decision for the identity, its revision the number of commits that won
      assert.equal(read.decision?.signalId ?? id, id);
      assert.equal(read.decision?.history.length ?? 0, read.state.decisionRevision);
      for (const client of clients) assert.deepEqual(client.view.get(id)?.state, read.state, `${client.name} ${id}`);
    }
    // The task's completion stayed with its block: the block's checked and the signal agree
    const block = (await world.readNote('n1'))?.blocks.find(candidate => candidate.id === 't1');
    const task = await world.intelligence.readSignal(ids[0]);
    if (task.kind === 'ready') assert.equal(task.signal.checked, block?.checked === true);
  }

  for (const seed of [1, 7, 42, 2026, 31337]) {
    it(`converges three surfaces on hints alone when they arrive reordered and duplicated (seed ${seed})`, () =>
      run(seed, { dropRate: 0, catchUp: false }));
    it(`converges three surfaces once they catch up when hints are also dropped (seed ${seed})`, () =>
      run(seed, { dropRate: 0.25, catchUp: true }));
  }
});
