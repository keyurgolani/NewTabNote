// #13's router (core/messaging/router.js): the handshake, the checks every request passes
// before a handler sees it (AC4), deny by default, and the one answer each request it accepts
// gets. Tests speak frames to it over the in-process link, as a client's transport would.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { welcomeSchema } from '../../js/kernel/core/contracts/envelope.js';
import { entityId, id } from '../../js/kernel/core/contracts/fields.js';
import { PROTOCOL_VERSION, QUERY_DEADLINE_MS, SMALL_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { committed, ready } from '../../js/kernel/core/contracts/outcomes.js';
import { queryStateSchema } from '../../js/kernel/core/contracts/outcome-schemas.js';
import { check } from '../../js/kernel/core/contracts/validate.js';
import { createLookup, operationOf } from '../../js/kernel/core/messaging/operations.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { NOW, testClock } from './support.mjs';
import { OPERATIONS, VERSION, hello, lookup, rawConnection, request, settle } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/router.js').Handler} Handler */
/** @typedef {import('../../js/kernel/core/messaging/router.js').RouterOptions} RouterOptions */
/** @typedef {import('../../js/kernel/core/ports/policy.js').PolicyPort} PolicyPort */

/**
 * A router over the whole catalog with the baseline policy, unless `options` says otherwise
 * @param {Partial<RouterOptions>} [options]
 */
const makeRouter = (options = {}) =>
  createRouter({
    lookup,
    policy: createBaselinePolicy(),
    clock: testClock(),
    coordinatorId: 'coordinator-1',
    extensionVersion: VERSION,
    ...options,
  });

/**
 * A connection from `surface` that has said hello
 * @param {ReturnType<typeof makeRouter>} router
 * @param {import('../../js/kernel/core/contracts/surfaces.js').Surface} surface
 */
async function opened(router, surface) {
  const peer = rawConnection(router, surface);
  peer.send(hello(surface));
  await settle();
  assert.equal(peer.frames.shift()?.frame, 'welcome');
  return peer;
}

/** A handler that answers what a getNote for a missing note answers */
const noNote = () => ({ kind: 'failed', cause: 'storage', code: 'note-not-found' });

/** @type {PolicyPort} */
const allowAll = { authorize: () => ({ allowed: true }) };

describe('the router: handshake (#13, "Handshake and compatibility")', () => {
  it('welcomes a hello with its protocol, extension version, instance, and status', async () => {
    const peer = rawConnection(makeRouter(), 'newtab');
    peer.send(hello('newtab'));
    await settle();
    assert.deepEqual(peer.frames, [
      {
        frame: 'welcome',
        protocol: PROTOCOL_VERSION,
        extensionVersion: VERSION,
        coordinatorId: 'coordinator-1',
        status: 'ready',
      },
    ]);
    assert.equal(check(welcomeSchema, peer.frames[0]).ok, true);

    // #35 answers before its start-up maintenance, and says why it's degraded
    const degraded = rawConnection(
      makeRouter({ status: () => ({ status: 'degraded', reason: 'migrating' }) }),
      'popup',
    );
    degraded.send(hello('popup'));
    await settle();
    assert.deepEqual(
      degraded.frames.map(frame => [frame.status, frame.reason]),
      [['degraded', 'migrating']],
    );
    // A status it can't read is degraded, never a welcome the client would refuse
    for (const status of [
      () => {
        throw new Error('broken');
      },
      () => ({ status: 'stopped' }),
      () => ({ status: 'degraded', reason: 'Not a code' }),
    ]) {
      const peer = rawConnection(makeRouter({ status: /** @type {any} */ (status) }), 'newtab');
      peer.send(hello('newtab'));
      await settle();
      assert.deepEqual([peer.frames[0].status, peer.frames[0].reason], ['degraded', 'status-unknown']);
      assert.equal(check(welcomeSchema, peer.frames[0]).ok, true);
    }
  });

  it('holds a hello to the surface the transport verified, and closes a connection that claims another', async () => {
    const router = makeRouter();
    const peer = rawConnection(router, 'popup');
    peer.send(hello('newtab'));
    await settle();
    assert.deepEqual(peer.frames, []);
    assert.equal(peer.closed, true);
  });

  it('refuses a request before the hello, and closes a connection that says hello twice', async () => {
    const router = makeRouter({ handlers: { getNote: noNote } });
    const peer = rawConnection(router, 'newtab');
    peer.send(request('r1', { type: 'getNote', noteId: 'n1' }));
    await settle();
    assert.deepEqual(peer.frames, [{ frame: 'error', requestId: 'r1', code: 'unauthorized-sender' }]);
    peer.send(hello('newtab'));
    await settle();
    assert.equal(peer.frames[1].frame, 'welcome');
    peer.send(hello('newtab'));
    await settle();
    assert.equal(peer.closed, true);
  });

  it("answers a hello of another major version with its own, then refuses that connection's every request", async () => {
    const router = makeRouter({ handlers: { getNote: noNote } });
    const peer = rawConnection(router, 'newtab');
    peer.send(hello('newtab', 's1', { major: PROTOCOL_VERSION.major + 1, minor: 0 }));
    peer.send(request('r1', { type: 'getNote', noteId: 'n1' }));
    await settle();
    assert.deepEqual(peer.frames[0].protocol, PROTOCOL_VERSION);
    assert.deepEqual(peer.frames[1], { frame: 'error', requestId: 'r1', code: 'unsupported-version' });

    // Minors only add, so another minor is served
    const newer = rawConnection(router, 'newtab');
    newer.send(hello('newtab', 's2', { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor + 3 }));
    newer.send(request('r1', { type: 'getNote', noteId: 'n1' }));
    await settle();
    assert.deepEqual(newer.frames[1], { frame: 'response', requestId: 'r1', result: noNote() });
  });
});

describe('the router: checks before dispatch (#13, AC4)', () => {
  it('refuses what the validators refuse, each with its code, and runs no handler', async () => {
    let ran = 0;
    const router = makeRouter({
      handlers: {
        getNote: () => {
          ran += 1;
          return noNote();
        },
      },
    });
    const peer = await opened(router, 'newtab');
    peer.send(request('r1', { type: 'noSuchThing' }));
    peer.send(request('r2', { type: 'constructor' }));
    peer.send(request('r3', { type: 'getNote', noteId: 'n1' }, { version: 2 }));
    peer.send(request('r4', { type: 'getNote', noteId: 'n1', extra: 'x' }));
    // getNote's request may encode to 16 KiB, and its size is checked before its schema
    peer.send(request('r5', { type: 'getNote', noteId: 'x'.repeat(SMALL_MESSAGE_BYTES) }));
    await settle();
    assert.deepEqual(
      peer.frames.map(frame => [frame.frame, frame.requestId, frame.code]),
      [
        ['error', 'r1', 'unknown-operation'],
        ['error', 'r2', 'unknown-operation'],
        ['error', 'r3', 'unsupported-version'],
        ['error', 'r4', 'invalid-payload'],
        ['error', 'r5', 'payload-too-large'],
      ],
    );
    assert.equal(ran, 0);
  });

  it('refuses a request whose deadline has come', async () => {
    const router = makeRouter({ handlers: { getNote: noNote } });
    const peer = await opened(router, 'newtab');
    peer.send(request('r1', { type: 'getNote', noteId: 'n1' }, { deadline: NOW }));
    peer.send(request('r2', { type: 'getNote', noteId: 'n1' }, { deadline: NOW + 1 }));
    await settle();
    assert.deepEqual(peer.frames, [
      { frame: 'error', requestId: 'r1', code: 'deadline-exceeded' },
      { frame: 'response', requestId: 'r2', result: noNote() },
    ]);
  });

  it("asks the policy with the caller it verified, the transport's surface and the hello's session, and maps its denials", async () => {
    /** @type {Array<[unknown, unknown]>} */
    const asked = [];
    const baseline = createBaselinePolicy();
    const router = makeRouter({
      handlers: { getNote: noNote, setPinned: () => committed('note-pinned', ['n1']) },
      policy: {
        authorize(request, caller) {
          asked.push([request, caller]);
          return baseline.authorize(request, caller);
        },
      },
    });
    const peer = await opened(router, 'popup');
    peer.send(request('r1', { type: 'getNote', noteId: 'n1' }));
    peer.send(request('r2', { type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true }));
    await settle();
    assert.deepEqual(asked, [
      [
        { type: 'getNote', noteId: 'n1' },
        { surface: 'popup', contextId: 'popup-session' },
      ],
      [
        { type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true },
        { surface: 'popup', contextId: 'popup-session' },
      ],
    ]);
    // Popup may read a note but not pin one. A refusal goes at once, ahead of an answer.
    assert.deepEqual(
      peer.frames.map(frame => [frame.requestId, frame.frame, frame.code]),
      [
        ['r2', 'error', 'forbidden-for-surface'],
        ['r1', 'response', undefined],
      ],
    );

    // Deny by default: only `allowed: true` allows, and a policy that throws denies
    for (const [answer, code] of /** @type {Array<[() => unknown, string]>} */ ([
      [() => ({ allowed: false, code: 'unknown-caller' }), 'unauthorized-sender'],
      [() => ({ allowed: false, code: 'unknown-operation' }), 'unknown-operation'],
      [() => ({ allowed: false, code: 'not-on-surface' }), 'forbidden-for-surface'],
      [() => ({ allowed: false, code: 'scope-denied' }), 'forbidden-for-surface'],
      [() => ({ allowed: 'yes' }), 'forbidden-for-surface'],
      [() => undefined, 'forbidden-for-surface'],
      [
        () => {
          throw new Error('broken policy');
        },
        'forbidden-for-surface',
      ],
    ])) {
      const denied = await opened(
        makeRouter({ handlers: { getNote: noNote }, policy: /** @type {PolicyPort} */ ({ authorize: answer }) }),
        'newtab',
      );
      denied.send(request('r1', { type: 'getNote', noteId: 'n1' }));
      await settle();
      assert.deepEqual(denied.frames, [{ frame: 'error', requestId: 'r1', code }], code);
    }
  });

  it("refuses an id of a type the operation's entry doesn't declare, and a destination it doesn't list", async () => {
    const entry = Object.freeze({
      kind: /** @type {const} */ ('query'),
      version: 1,
      schema: './operations/test-scoped.js',
      surfaces: Object.freeze(/** @type {const} */ (['newtab'])),
      maxBytes: SMALL_MESSAGE_BYTES,
      deadlineMs: QUERY_DEADLINE_MS,
      cancellable: /** @type {const} */ ('any-time'),
      idempotency: /** @type {const} */ ('none'),
      journaled: false,
      entityTypes: Object.freeze(/** @type {const} */ (['note'])),
      destinations: Object.freeze(['d1']),
    });
    const scoped = operationOf(entry, {
      payload: v.strictObject({
        type: v.literal('test.scoped'),
        noteId: entityId('note'),
        folderId: v.optional(v.nullable(entityId('folder'))),
        blocks: v.optional(v.array(v.strictObject({ id: entityId('block') }))),
        to: v.optional(v.pipe(id, v.metadata({ destination: true }))),
      }),
      result: queryStateSchema(v.boolean()),
    });
    // A schema the walk can't read all of is out of scope, whatever its payload holds
    const opaque = operationOf(entry, {
      payload: v.strictObject({ type: v.literal('test.opaque'), later: v.optional(v.lazy(() => id)) }),
      result: queryStateSchema(v.boolean()),
    });
    const router = makeRouter({
      lookup: createLookup({ 'test.scoped': scoped, 'test.opaque': opaque }),
      handlers: { 'test.scoped': () => ready(NOW, true), 'test.opaque': () => ready(NOW, true) },
      policy: allowAll,
    });
    const peer = await opened(router, 'newtab');
    const sent = [
      ['served', { noteId: 'n1' }],
      ['served', { noteId: 'n1', folderId: null }],
      ['served', { noteId: 'n1', blocks: [] }],
      ['served', { noteId: 'n1', to: 'd1' }],
      ['refused', { noteId: 'n1', folderId: 'f1' }],
      ['refused', { noteId: 'n1', blocks: [{ id: 'b1' }] }],
      ['refused', { noteId: 'n1', to: 'd2' }],
    ];
    sent.forEach(([, fields], index) =>
      peer.send(request(`r${index}`, { type: 'test.scoped', .../** @type {object} */ (fields) })),
    );
    peer.send(request('opaque', { type: 'test.opaque' }));
    await settle();
    assert.deepEqual(
      Object.fromEntries(
        peer.frames.map(frame => [frame.requestId, frame.frame === 'response' ? 'served' : frame.code]),
      ),
      Object.fromEntries([
        ...sent.map(([outcome], index) => [`r${index}`, outcome === 'served' ? 'served' : 'forbidden-for-surface']),
        ['opaque', 'forbidden-for-surface'],
      ]),
    );
  });

  it('refuses an operation it has no handler for', async () => {
    const peer = await opened(makeRouter(), 'newtab');
    peer.send(request('r1', { type: 'getNote', noteId: 'n1' }));
    await settle();
    assert.deepEqual(peer.frames, [{ frame: 'error', requestId: 'r1', code: 'unknown-operation' }]);
  });

  it("drops what it can't read and the frames only it sends, and keeps serving the connection", async () => {
    const router = makeRouter({ handlers: { getNote: noNote } });
    const peer = await opened(router, 'newtab');
    peer.sendText('not json');
    peer.sendText(JSON.stringify({ frame: 'request', requestId: 'r0' }));
    peer.send({
      frame: 'welcome',
      protocol: PROTOCOL_VERSION,
      extensionVersion: VERSION,
      coordinatorId: 'c',
      status: 'ready',
    });
    peer.send({ frame: 'response', requestId: 'r0', result: null });
    peer.send(request('r1', { type: 'getNote', noteId: 'n1' }));
    await settle();
    assert.deepEqual(peer.frames, [{ frame: 'response', requestId: 'r1', result: noNote() }]);
    assert.equal(peer.closed, false);
  });
});

describe('the router: answers', () => {
  it('answers each request by its requestId, in whatever order the handlers finish', async () => {
    /** @type {Map<string, (state: unknown) => void>} */
    const waiting = new Map();
    const router = makeRouter({
      handlers: {
        getNote: payload =>
          new Promise(resolve => waiting.set(/** @type {{noteId: string}} */ (payload).noteId, resolve)),
      },
    });
    const peer = await opened(router, 'newtab');
    peer.send(request('r1', { type: 'getNote', noteId: 'n1' }));
    peer.send(request('r2', { type: 'getNote', noteId: 'n2' }));
    await settle();
    waiting.get('n2')?.(ready(NOW, { note: { id: 'n2' } }));
    await settle();
    waiting.get('n1')?.(ready(NOW, { note: { id: 'n1' } }));
    await settle();
    assert.deepEqual(peer.frames, [
      { frame: 'response', requestId: 'r2', result: { kind: 'ready', asOf: NOW, data: { note: { id: 'n2' } } } },
      { frame: 'response', requestId: 'r1', result: { kind: 'ready', asOf: NOW, data: { note: { id: 'n1' } } } },
    ]);
  });

  it('passes a handler the payload that arrived, the caller it verified, and the deadline', async () => {
    /** @type {unknown[]} */
    const seen = [];
    const router = makeRouter({
      handlers: {
        getNote: (payload, context) => {
          seen.push(payload, context.caller, context.deadline);
          return noNote();
        },
      },
    });
    const peer = await opened(router, 'sidepanel');
    peer.send(request('r1', { type: 'getNote', noteId: 'n1' }, { deadline: NOW + 500 }));
    await settle();
    assert.deepEqual(seen, [
      { type: 'getNote', noteId: 'n1' },
      { surface: 'sidepanel', contextId: 'sidepanel-session' },
      NOW + 500,
    ]);
  });

  it("answers a command that failed after it began as outcome-unknown, before it began as unavailable, and a query that couldn't answer as unavailable", async () => {
    /** @type {Record<string, Handler>} */
    const handlers = {
      setPinned: (payload, context) => {
        const { noteId } = /** @type {{noteId: string}} */ (payload);
        if (noteId === 'throws-first') throw new Error('before its transaction');
        context.begin();
        if (noteId === 'throws-after') return Promise.reject(new Error('after its transaction opened'));
        // Not an outcome its schema takes
        return { kind: 'committed', code: 'Pinned!' };
      },
      getNoteBlocks: payload => {
        const { noteId } = /** @type {{noteId: string}} */ (payload);
        if (noteId === 'throws') throw new Error('broken read');
        if (noteId === 'invalid') return { kind: 'ready', asOf: NOW };
        // A block's content takes any value its schema can, but the codec carries none of these
        if (noteId === 'unencodable') return ready(NOW, [{ id: 'b1', canvasId: noteId, content: new Date(NOW) }]);
        return ready(NOW, [{ id: 'b1', canvasId: noteId, content: 'x'.repeat(1024 * 1024) }]);
      },
    };
    const peer = await opened(makeRouter({ handlers }), 'newtab');
    const pin = (/** @type {string} */ noteId) => ({
      type: 'setPinned',
      commandId: `c-${noteId}`,
      noteId,
      pinned: true,
    });
    peer.send(request('c1', pin('throws-first')));
    peer.send(request('c2', pin('throws-after')));
    peer.send(request('c3', pin('invalid')));
    peer.send(request('q1', { type: 'getNoteBlocks', noteId: 'throws' }));
    peer.send(request('q2', { type: 'getNoteBlocks', noteId: 'invalid' }));
    peer.send(request('q3', { type: 'getNoteBlocks', noteId: 'unencodable' }));
    peer.send(request('q4', { type: 'getNoteBlocks', noteId: 'too-large' }));
    await settle();
    assert.deepEqual(Object.fromEntries(peer.frames.map(frame => [frame.requestId, `${frame.frame} ${frame.code}`])), {
      c1: 'error unavailable',
      c2: 'error outcome-unknown',
      c3: 'error outcome-unknown',
      q1: 'error unavailable',
      q2: 'error unavailable',
      q3: 'error unavailable',
      // Answering a 1.5 MiB block in one message waits for streams (#13 slice 4)
      q4: 'error payload-too-large',
    });
  });

  it('hands a later begin() true for a command that has begun, and a query its answer whenever it comes', async () => {
    /** @type {boolean[]} */
    const begun = [];
    const router = makeRouter({
      handlers: {
        setPinned: (payload, context) => {
          begun.push(context.begin(), context.begin());
          return committed('note-pinned', ['n1']);
        },
        getNote: (payload, context) => {
          begun.push(context.begin());
          return noNote();
        },
      },
    });
    const peer = await opened(router, 'newtab');
    peer.send(request('c1', { type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true }));
    peer.send(request('q1', { type: 'getNote', noteId: 'n1' }));
    await settle();
    assert.deepEqual(begun, [true, true, true]);
    assert.deepEqual(
      peer.frames.map(frame => [frame.requestId, frame.frame]),
      [
        ['c1', 'response'],
        ['q1', 'response'],
      ],
    );
  });

  it('serves its connections apart: one closing ends none of the others', async () => {
    const router = makeRouter({ handlers: { getNote: noNote } });
    const first = await opened(router, 'newtab');
    const second = await opened(router, 'popup');
    first.close();
    await settle();
    second.send(request('r1', { type: 'getNote', noteId: 'n1' }));
    await settle();
    assert.deepEqual(second.frames, [{ frame: 'response', requestId: 'r1', result: noNote() }]);
    // The operations a composition root hands the router are the catalog's own
    assert.equal(lookup('getNote'), OPERATIONS.getNote);
  });
});
