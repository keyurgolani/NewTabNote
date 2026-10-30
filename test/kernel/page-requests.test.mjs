// #13's page-addressed requests (core/messaging/page-requests.js) on the hint channel, over
// the Chrome fake's BroadcastChannel with several pages listening: only the page that owns
// the addressed session or holds the addressed lock answers, every other page stays silent,
// and the answer is checked like port traffic (#13, AC2 and AC4).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { openHintChannel } from '../../js/kernel/adapters/messaging/hint-channel.js';
import { decode, encode } from '../../js/kernel/core/contracts/codec.js';
import { entityId, id } from '../../js/kernel/core/contracts/fields.js';
import { HINT_CHANNEL } from '../../js/kernel/core/contracts/hint-channel.js';
import { QUERY_DEADLINE_MS, SMALL_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { committed, failed, ready } from '../../js/kernel/core/contracts/outcomes.js';
import { queryStateSchema } from '../../js/kernel/core/contracts/outcome-schemas.js';
import { createLookup, operationOf } from '../../js/kernel/core/messaging/operations.js';
import { createPageRequester, createPageResponder } from '../../js/kernel/core/messaging/page-requests.js';
import { OPERATIONS, settle, testScheduler } from './messaging-support.mjs';
import { createChromeFake } from './chrome-fake.mjs';
import { NOW, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/page-requests.js').PageHandler} PageHandler */

/** A page-addressed entry, as #6's holder lookup and #35's offscreen.runJob will be */
const addressed = Object.freeze({
  kind: /** @type {const} */ ('query'),
  version: 1,
  schema: './operations/test-who-has.js',
  surfaces: Object.freeze(/** @type {const} */ (['worker-internal', 'newtab'])),
  maxBytes: SMALL_MESSAGE_BYTES,
  deadlineMs: QUERY_DEADLINE_MS,
  cancellable: /** @type {const} */ ('any-time'),
  idempotency: /** @type {const} */ ('none'),
  journaled: false,
  entityTypes: Object.freeze(/** @type {const} */ (['note'])),
  destinations: Object.freeze([]),
});

const whoHas = operationOf(addressed, {
  payload: v.strictObject({
    type: v.literal('test.whoHas'),
    noteId: entityId('note'),
    folderId: v.optional(entityId('folder')),
  }),
  result: queryStateSchema(v.strictObject({ sessionId: id })),
});

/** One that answers with a number, which its schema takes whatever it is */
const measure = operationOf(
  { ...addressed, schema: './operations/test-measure.js' },
  {
    payload: v.strictObject({ type: v.literal('test.measure'), noteId: entityId('note') }),
    result: queryStateSchema(v.strictObject({ n: v.number() })),
  },
);

/** What each page and the worker know */
const lookup = createLookup({ 'test.whoHas': whoHas, 'test.measure': measure, setPinned: OPERATIONS.setPinned });

/**
 * The worker as requester, and three pages, each answering for its own session and the locks
 * it holds. `posted` counts the frames each kind the channel carried, and `warnings` the
 * events the pages warned of.
 * @param {{handler?: (session: string) => PageHandler, measured?: PageHandler}} [options]
 */
function pages({
  handler = session => () => ready(NOW, { sessionId: session }),
  measured = () => ready(NOW, { n: 1 }),
} = {}) {
  const fake = createChromeFake();
  fake.worker.install(() => {});
  fake.worker.start();
  const worker = /** @type {NonNullable<typeof fake.worker.context>} */ (fake.worker.context);
  const scheduler = testScheduler();
  const channelOf = (/** @type {{BroadcastChannel: any}} */ context) =>
    openHintChannel({ origin: fake.origin, BroadcastChannel: context.BroadcastChannel });
  /** @type {Record<string, string[]>} */
  const locks = { 's-editor': ['ntn-editor:n1'], 's-other': [], 's-offscreen': ['job:j1'] };
  /** @type {string[]} */
  const warnings = [];
  for (const [sessionId, held] of Object.entries(locks)) {
    createPageResponder({
      channel: channelOf(fake.page(sessionId === 's-offscreen' ? 'offscreen' : 'newtab')),
      sessionId,
      holds: lock => held.includes(lock),
      lookup,
      // A handler under a command's name serves nothing, since no command is page-addressed
      handlers: {
        'test.whoHas': handler(sessionId),
        'test.measure': measured,
        setPinned: () => committed('note-pinned', ['n1']),
      },
      clock: scheduler.clock,
      logger: { warn: event => warnings.push(event) },
    });
  }
  // A page that only watches what the channel carries
  /** @type {string[]} */
  const posted = [];
  const watcher = new (fake.page('sidepanel').BroadcastChannel)(HINT_CHANNEL);
  watcher.addEventListener('message', (/** @type {{data: unknown}} */ event) => {
    posted.push(/** @type {any} */ (decode(event.data)).frame);
  });
  const requester = createPageRequester({
    channel: channelOf(worker),
    lookup,
    ids: testIds('page-request'),
    ...scheduler,
  });
  return { fake, scheduler, requester, posted, warnings };
}

const ask = { type: 'test.whoHas', noteId: 'n1' };

describe('page-addressed requests (#13, "Topology")', () => {
  it('reach only the page that owns the addressed session, and the others stay silent', async () => {
    const { requester, posted } = pages();
    const state = await requester.request(ask, { kind: 'session', sessionId: 's-other' });
    assert.deepEqual(state, ready(NOW, { sessionId: 's-other' }));
    assert.deepEqual(posted, ['page-request', 'page-response']);
  });

  it('reach only the page holding the addressed lock, and fail at the deadline when no page does', async () => {
    const { requester, scheduler, posted } = pages();
    assert.deepEqual(
      await requester.request(ask, { kind: 'lock', lock: 'ntn-editor:n1' }),
      ready(NOW, { sessionId: 's-editor' }),
    );
    /** @type {unknown[]} */
    const answers = [];
    void requester.request(ask, { kind: 'lock', lock: 'ntn-editor:n2' }).then(state => answers.push(state));
    await scheduler.advance(QUERY_DEADLINE_MS - 1);
    assert.deepEqual(answers, []);
    await scheduler.advance(1);
    assert.deepEqual(answers, [failed('coordinator', 'deadline-exceeded')]);
    assert.deepEqual(posted, ['page-request', 'page-response', 'page-request']);
  });

  it("get a typed refusal from the addressed page for what it won't run, and none from the rest", async () => {
    const { fake, requester, posted } = pages({
      handler: session => payload => {
        const { noteId } = /** @type {{noteId: string}} */ (payload);
        if (noteId === 'throws') throw new Error('a broken handler');
        if (noteId === 'invalid') return ready(NOW, { sessionId: session, extra: true });
        return ready(NOW, { sessionId: session });
      },
    });
    const to = /** @type {const} */ ({ kind: 'session', sessionId: 's-editor' });
    // A requester built against another catalog version of the operation
    const stale = createPageRequester({
      channel: openHintChannel({ origin: fake.origin, BroadcastChannel: fake.page('popup').BroadcastChannel }),
      lookup: createLookup({ 'test.whoHas': operationOf({ ...addressed, version: 2 }, whoHas) }),
      ids: testIds('stale'),
      ...testScheduler(),
    });
    assert.deepEqual(
      await Promise.all([
        requester.request({ type: 'test.whoHas', noteId: 'throws' }, to),
        requester.request({ type: 'test.whoHas', noteId: 'invalid' }, to),
        stale.request(ask, to),
      ]),
      [
        failed('coordinator', 'unavailable'),
        failed('coordinator', 'unavailable'),
        failed('validation', 'unsupported-version'),
      ],
    );
    // Refused before anything is posted, so no page hears it: a command, no operation at all,
    // a payload its schema refuses, an id of a type its entry doesn't declare, or no target
    assert.deepEqual(
      await Promise.all([
        requester.request({ type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true }, to),
        requester.request({ type: 'noSuchThing' }, to),
        requester.request({ type: 'test.whoHas', noteId: '' }, to),
        requester.request({ ...ask, folderId: 'f1' }, to),
        requester.request(ask, /** @type {any} */ ({ kind: 'tab', tabId: 4 })),
      ]),
      [
        failed('validation', 'unknown-operation'),
        failed('validation', 'unknown-operation'),
        failed('validation', 'invalid-payload'),
        failed('policy', 'forbidden-for-surface'),
        failed('validation', 'invalid-payload'),
      ],
    );
    assert.equal(posted.filter(frame => frame === 'page-request').length, 3);
    // Posted by hand, the addressed page refuses the same: a command is no page-addressed
    // request, whatever the page knows of it, and the payload and scope checks hold there too
    const raw = new (fake.page('newtab').BroadcastChannel)(HINT_CHANNEL);
    /** @type {Record<string, unknown>} */
    const answers = {};
    raw.addEventListener('message', (/** @type {{data: unknown}} */ event) => {
      const frame = /** @type {any} */ (decode(event.data));
      if (frame.frame === 'page-response') answers[frame.requestId] = frame.result;
    });
    /**
     * @param {string} requestId
     * @param {Record<string, unknown>} payload
     */
    const post = (requestId, payload) =>
      raw.postMessage(
        encode({
          frame: 'page-request',
          requestId,
          operation: payload.type,
          version: 1,
          deadline: NOW + 1000,
          target: to,
          payload,
        }),
      );
    post('raw-1', { type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true });
    post('raw-2', { type: 'test.whoHas', noteId: '' });
    post('raw-3', { ...ask, folderId: 'f1' });
    await settle();
    assert.deepEqual(answers, {
      'raw-1': failed('validation', 'unknown-operation'),
      'raw-2': failed('validation', 'invalid-payload'),
      'raw-3': failed('policy', 'forbidden-for-surface'),
    });
    // Six went, and only the addressed page answered each
    assert.equal(posted.filter(frame => frame === 'page-request').length, 6);
    assert.equal(posted.filter(frame => frame === 'page-response').length, 6);
  });

  it("answer unavailable at once, and warn, when the codec can't carry what the handler gave", async () => {
    const { requester, warnings, posted } = pages({ measured: () => ready(NOW, { n: Infinity }) });
    /** @type {unknown[]} */
    const answers = [];
    void requester
      .request({ type: 'test.measure', noteId: 'n1' }, { kind: 'session', sessionId: 's-other' })
      .then(state => answers.push(state));
    await settle();
    await settle();
    assert.deepEqual(answers, [failed('coordinator', 'unavailable')]);
    assert.deepEqual(warnings, ['page-handler-unencodable-answer']);
    assert.deepEqual(posted, ['page-request', 'page-response']);
  });

  it("hold a handler to its entry's deadline, however far off the request puts it, and post no answer after it", async () => {
    /** @type {number[]} */
    const deadlines = [];
    /** @type {Array<(state: unknown) => void>} */
    const finish = [];
    const { fake, scheduler, warnings } = pages({
      measured: (_, { deadline }) => {
        deadlines.push(deadline);
        return new Promise(resolve => finish.push(resolve));
      },
    });
    const raw = new (fake.page('newtab').BroadcastChannel)(HINT_CHANNEL);
    /** @type {string[]} */
    const answered = [];
    raw.addEventListener('message', (/** @type {{data: unknown}} */ event) => {
      const frame = /** @type {any} */ (decode(event.data));
      if (frame.frame === 'page-response') answered.push(frame.requestId);
    });
    /**
     * @param {string} requestId
     * @param {number} deadline
     */
    const post = (requestId, deadline) =>
      raw.postMessage(
        encode({
          frame: 'page-request',
          requestId,
          operation: 'test.measure',
          version: 1,
          deadline,
          target: { kind: 'session', sessionId: 's-other' },
          payload: { type: 'test.measure', noteId: 'n1' },
        }),
      );
    post('far', NOW + 10 * QUERY_DEADLINE_MS);
    post('near', NOW + 1000);
    await settle();
    assert.deepEqual(deadlines, [NOW + QUERY_DEADLINE_MS, NOW + 1000]);
    // The near one answers in time, and the far one only after its entry's deadline
    finish[1](ready(NOW, { n: 2 }));
    await settle();
    await scheduler.advance(QUERY_DEADLINE_MS);
    finish[0](ready(NOW, { n: 1 }));
    await settle();
    await settle();
    assert.deepEqual(answered, ['near']);
    assert.deepEqual(warnings, ['page-answer-too-late']);
  });

  it('take only a valid answer to their own request, whoever else posts one', async () => {
    const { fake, requester } = pages({
      handler: session => () => new Promise(resolve => setImmediate(() => resolve(ready(NOW, { sessionId: session })))),
    });
    const rogue = new (fake.page('newtab').BroadcastChannel)(HINT_CHANNEL);
    rogue.addEventListener('message', (/** @type {{data: unknown}} */ event) => {
      const frame = /** @type {any} */ (decode(event.data));
      if (frame.frame !== 'page-request') return;
      rogue.postMessage(
        encode({ frame: 'page-response', requestId: 'someone-else', result: ready(NOW, { sessionId: 'rogue' }) }),
      );
      rogue.postMessage(encode({ frame: 'page-response', requestId: frame.requestId, result: { kind: 'ready' } }));
    });
    const state = await requester.request(ask, { kind: 'session', sessionId: 's-offscreen' });
    assert.deepEqual(state, ready(NOW, { sessionId: 's-offscreen' }));
  });

  it('end as cancelled when their signal aborts, before or after they go', async () => {
    const { requester } = pages({ handler: () => () => new Promise(() => {}) });
    const before = new AbortController();
    before.abort();
    const after = new AbortController();
    const going = requester.request(ask, { kind: 'session', sessionId: 's-editor' }, { signal: after.signal });
    await settle();
    after.abort();
    assert.deepEqual(
      [
        await requester.request(ask, { kind: 'session', sessionId: 's-editor' }, { signal: before.signal }),
        await going,
      ],
      [failed('validation', 'cancelled'), failed('validation', 'cancelled')],
    );
  });
});
