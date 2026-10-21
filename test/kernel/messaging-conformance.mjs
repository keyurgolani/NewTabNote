// #13's transport conformance suite (AC2): one set of tests every transport passes, through one
// JSON codec, with a client on one side and the router on the other: correlation, deadlines,
// cancellation with too-late, typed errors, the compatibility handshake, round-trip fidelity,
// and a coordinator that goes away. The in-process transport runs it in
// conformance-in-process.test.mjs, and the runtime port on the Chrome fake in
// conformance-runtime-port.test.mjs. Streams with backpressure, and MessagePorts, join it with
// streams (slice 4).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { decode, encode } from '../../js/kernel/core/contracts/codec.js';
import { COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import {
  COMMAND_DEADLINE_MS,
  DEADLINE_GRACE_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  QUERY_DEADLINE_MS,
} from '../../js/kernel/core/contracts/limits.js';
import { committed, failed, ready, rejected, unknown } from '../../js/kernel/core/contracts/outcomes.js';
import { QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { createClient } from '../../js/kernel/core/messaging/client.js';
import { createLookup, operationOf } from '../../js/kernel/core/messaging/operations.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, NOW, testIds } from './support.mjs';
import { OPERATIONS, VERSION, lookup, settle, testScheduler } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../../js/kernel/core/messaging/link.js').Transport} Transport */
/** @typedef {import('../../js/kernel/core/messaging/router.js').Router} Router */
/** @typedef {import('../../js/kernel/core/messaging/router.js').Handler} Handler */
/** @typedef {import('../../js/kernel/core/messaging/client.js').Client} Client */
/** @typedef {import('../../js/kernel/core/ports/runtime.js').Clock} Clock */

/**
 * What a transport gives the suite once the router is in place
 * @typedef {object} Harness
 * @property {(surface: Surface) => Transport} transport - from a context of `surface` to the router
 * @property {() => void | Promise<void>} stop - the coordinator going away, as the worker stopping does
 */

/**
 * Puts `router` where a transport reaches it, as a worker's composition root would
 * @callback Connect
 * @param {Router} router
 * @param {{clock: Clock}} context
 * @returns {Harness | Promise<Harness>}
 */

/**
 * Commands and queries in an order the kernel commits them in, covering every answer shape:
 * a commit, a bulk outcome, a rejection, ready, and empty
 * @type {Array<['command' | 'query', Record<string, unknown> & {type: string}]>}
 */
const SCRIPT = [
  ['command', { type: 'createFolder', commandId: 'c1', folderId: 'f0', name: 'Work', parentId: null }],
  [
    'command',
    {
      type: 'createNote',
      commandId: 'c2',
      noteId: 'n1',
      name: 'Plan',
      folderId: 'f0',
      blocks: [{ id: 'b1', type: 'text', content: 'Line ünïcödé   "quoted"' }],
    },
  ],
  ['command', { type: 'renameNote', commandId: 'c3', noteId: 'n1', name: 'Plan 2', origin: 'typed' }],
  ['command', { type: 'setPinned', commandId: 'c4', noteId: 'n1', pinned: true }],
  [
    'command',
    {
      type: 'saveNoteContent',
      commandId: 'c5',
      noteId: 'n1',
      blocks: [{ id: 'b1', type: 'text', content: 'Line', order: 0 }],
      preview: 'Line',
      todoProgress: { completed: 0, total: 1 },
    },
  ],
  ['command', { type: 'runBulkAction', commandId: 'c6', action: 'archive', noteIds: ['n1', 'gone'] }],
  ['command', { type: 'renameNote', commandId: 'c7', noteId: 'missing', name: 'Nothing', origin: 'typed' }],
  ['query', { type: 'listNotes', view: 'withArchived' }],
  ['query', { type: 'getNote', noteId: 'n1' }],
  ['query', { type: 'getNoteBlocks', noteId: 'n1' }],
  ['query', { type: 'listFolders' }],
  ['query', { type: 'getWorkspaceSession' }],
  ['query', { type: 'getPreferences', keys: ['theme'] }],
];

/**
 * Every kernel operation, served by `kernel` as #35's coordinator will: a command opens its
 * transaction only if the router says it may still begin
 * @param {import('../../js/kernel/core/application/kernel.js').Kernel} kernel
 * @returns {Record<string, Handler>}
 */
function kernelHandlers(kernel) {
  return Object.fromEntries([
    ...COMMAND_TYPES.map(type => [
      type,
      /** @type {Handler} */ (
        (payload, context) =>
          context.begin() ? kernel.execute(/** @type {any} */ (payload)) : rejected('validation', 'cancelled')
      ),
    ]),
    ...QUERY_TYPES.map(type => [type, /** @type {Handler} */ (payload => kernel.query(/** @type {any} */ (payload)))]),
  ]);
}

/** A kernel over its own memory store, on `clock`, as the new tab's */
const newKernel = (/** @type {Clock} */ clock) =>
  createKernel({
    adapter: createMemoryAdapter(),
    policy: createBaselinePolicy(),
    caller: CALLERS.newtab,
    ids: testIds('kernel'),
    clock,
  });

/**
 * Runs the suite against one transport
 * @param {string} name
 * @param {Connect} connect
 */
export function describeConformance(name, connect) {
  /**
   * A router serving the kernel and `handlers`, reached through the transport, and clients
   * to it
   * @param {Record<string, Handler>} [handlers]
   */
  async function start(handlers = {}) {
    const scheduler = testScheduler();
    const router = createRouter({
      lookup,
      handlers: { ...kernelHandlers(newKernel(scheduler.clock)), ...handlers },
      policy: createBaselinePolicy(),
      ...scheduler,
      coordinatorId: 'coordinator-1',
      extensionVersion: VERSION,
    });
    const harness = await connect(router, scheduler);
    let sessions = 0;
    /**
     * @param {Surface} [surface]
     * @param {Partial<import('../../js/kernel/core/messaging/client.js').ClientOptions>} [options]
     */
    const client = (surface = 'newtab', options = {}) =>
      createClient({
        transport: harness.transport(surface),
        surface,
        extensionVersion: VERSION,
        lookup,
        ids: testIds(`${surface}-${(sessions += 1)}`),
        ...scheduler,
        ...options,
      });
    return { scheduler, router, harness, client };
  }

  describe(`the ${name} transport: #13's conformance suite (AC2)`, () => {
    it('carries every answer back as the kernel gave it, through the one JSON codec', async () => {
      const { client, scheduler } = await start();
      const direct = newKernel(scheduler.clock);
      const remote = client();
      for (const [kind, input] of SCRIPT) {
        const expected =
          kind === 'command'
            ? await direct.execute(/** @type {any} */ (structuredClone(input)))
            : await direct.query(/** @type {any} */ (input));
        const answer =
          kind === 'command'
            ? await remote.execute(/** @type {any} */ (input))
            : await remote.query(/** @type {any} */ (input));
        assert.deepEqual(answer, decode(encode(expected)), input.type);
      }
    });

    it('carries a payload up to its size, and refuses a larger one before it goes', async () => {
      const { client } = await start();
      const remote = client();
      const text = 'x'.repeat(MAX_MESSAGE_BYTES - 1024);
      const fits = { type: 'createNote', commandId: 'c1', noteId: 'n1', blocks: [{ id: 'b1', content: text }] };
      assert.equal((await remote.execute(fits)).kind, 'committed');
      const blocks = /** @type {any} */ (await remote.query({ type: 'getNoteBlocks', noteId: 'n1' })).data;
      assert.equal(blocks[0].content, text);
      const over = { ...fits, commandId: 'c2', noteId: 'n2', blocks: [{ id: 'b2', content: `${text}${text}` }] };
      assert.deepEqual(await remote.execute(over), rejected('validation', 'payload-too-large'));
    });

    it('matches every answer to its request, however many are in flight and in whatever order they finish', async () => {
      /** @type {Array<() => void>} */
      const finish = [];
      const { client } = await start({
        getNote: payload =>
          new Promise(resolve =>
            finish.push(() => resolve(ready(NOW, { note: { id: /** @type {any} */ (payload).noteId } }))),
          ),
      });
      const remote = client();
      const ids = Array.from({ length: 20 }, (_, index) => `n${index}`);
      const answers = Promise.all(ids.map(noteId => remote.query({ type: 'getNote', noteId })));
      for (let tries = 0; finish.length < ids.length && tries < 50; tries += 1) await settle();
      for (const done of finish.reverse()) done();
      assert.deepEqual(
        (await answers).map(answer => /** @type {any} */ (answer).data.note.id),
        ids,
      );
    });

    it("ends a query at its deadline on the router's word, and a begun command DEADLINE_GRACE_MS after on the client's", async () => {
      const { client, scheduler } = await start({
        getNote: () => new Promise(() => {}),
        setPinned: (payload, context) => {
          context.begin();
          return new Promise(() => {});
        },
      });
      const remote = client();
      /** @type {unknown[]} */
      const answers = [];
      void remote.query({ type: 'getNote', noteId: 'n1' }).then(answer => answers.push(answer));
      void remote
        .execute({ type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true })
        .then(answer => answers.push(answer));
      await scheduler.advance(QUERY_DEADLINE_MS);
      assert.deepEqual(answers, [failed('coordinator', 'deadline-exceeded')]);
      await scheduler.advance(COMMAND_DEADLINE_MS - QUERY_DEADLINE_MS + DEADLINE_GRACE_MS - 1);
      assert.equal(answers.length, 1);
      await scheduler.advance(1);
      assert.deepEqual(answers[1], unknown('deadline-exceeded', 'c1'));
    });

    it('cancels a query and a command that has not begun, and answers too-late with the outcome once one has', async () => {
      /** @type {Array<() => void>} */
      const commit = [];
      const { client } = await start({
        getNote: () => new Promise(() => {}),
        setPinned: (payload, context) => {
          const { noteId } = /** @type {{noteId: string}} */ (payload);
          if (noteId === 'waits') return new Promise(() => {});
          context.begin();
          return new Promise(resolve => commit.push(() => resolve(committed('note-pinned', [noteId]))));
        },
      });
      const remote = client();
      const controllers = [new AbortController(), new AbortController(), new AbortController()];
      const answers = [
        remote.query({ type: 'getNote', noteId: 'n1' }, { signal: controllers[0].signal }),
        remote.execute(
          { type: 'setPinned', commandId: 'c1', noteId: 'waits', pinned: true },
          { signal: controllers[1].signal },
        ),
        remote.execute(
          { type: 'setPinned', commandId: 'c2', noteId: 'begun', pinned: true },
          { signal: controllers[2].signal },
        ),
      ];
      for (let tries = 0; commit.length === 0 && tries < 50; tries += 1) await settle();
      for (const controller of controllers) controller.abort();
      await settle();
      await settle();
      commit[0]();
      assert.deepEqual(await Promise.all(answers), [
        failed('validation', 'cancelled'),
        rejected('validation', 'cancelled'),
        committed('note-pinned', ['begun']),
      ]);
    });

    it("answers what the router refuses with typed errors, by the request's kind", async () => {
      const { client } = await start();
      const page = client('newtab');
      const popup = client('popup');
      // A client built against another catalog version of getNote
      const stale = client('newtab', {
        lookup: createLookup({ getNote: operationOf({ ...OPERATIONS.getNote.entry, version: 2 }, OPERATIONS.getNote) }),
      });
      assert.deepEqual(
        await Promise.all([
          page.query({ type: 'getNote', noteId: '' }),
          popup.execute({ type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true }),
          stale.query({ type: 'getNote', noteId: 'n1' }),
          page.query({ type: 'system.messagingHealth' }).then(answer => answer.kind),
        ]),
        [
          failed('validation', 'invalid-payload'),
          rejected('policy', 'forbidden-for-surface'),
          failed('validation', 'unsupported-version'),
          'ready',
        ],
      );
    });

    it('answers a hello of another major version with its own, and refuses the requests that follow', async () => {
      const { harness } = await start();
      const link = harness.transport('newtab').connect();
      /** @type {Array<Record<string, any>>} */
      const frames = [];
      link.onMessage(text => frames.push(/** @type {any} */ (decode(text))));
      const major = PROTOCOL_VERSION.major + 1;
      link.send(
        encode({
          frame: 'hello',
          protocol: { major, minor: 0 },
          extensionVersion: VERSION,
          surface: 'newtab',
          sessionId: 's1',
        }),
      );
      link.send(
        encode({
          frame: 'request',
          requestId: 'r1',
          operation: 'getNote',
          version: 1,
          deadline: NOW + 1000,
          payload: { type: 'getNote', noteId: 'n1' },
        }),
      );
      for (let tries = 0; frames.length < 2 && tries < 50; tries += 1) await settle();
      assert.deepEqual(frames[0].protocol, PROTOCOL_VERSION);
      assert.deepEqual(frames[1], { frame: 'error', requestId: 'r1', code: 'unsupported-version' });
    });

    it('settles what was in flight when the coordinator goes, reconnects for the next request, and keeps a listener that throws from stopping the others', async () => {
      const { client, harness } = await start({
        setPinned: (payload, context) => {
          context.begin();
          return new Promise(() => {});
        },
      });
      const remote = client();
      remote.subscribe(() => {
        throw new Error('a broken listener');
      });
      /** @type {string[]} */
      const states = [];
      remote.subscribe(state => states.push(state));
      const pending = remote.execute({ type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true });
      for (let tries = 0; remote.state() !== 'connected' && tries < 50; tries += 1) await settle();
      await settle();
      await harness.stop();
      assert.deepEqual(await pending, unknown('outcome-unknown', 'c1'));
      const again = await remote.query({ type: 'listFolders' });
      assert.equal(again.kind, 'empty');
      assert.deepEqual(states, ['connecting', 'connected', 'idle', 'connecting', 'connected']);
    });
  });
}
