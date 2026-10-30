// Seeded envelope fuzzing (#13, "Test plan" and AC4): versions, operations, payloads,
// senders, duplicates, reordering, and oversized messages, generated from a seed with no new
// dependency. 2a and 2b test each refusal by hand (envelope.test.mjs, router.test.mjs,
// runtime-port.test.mjs, hints.test.mjs); this holds the same code to invariants over inputs
// nobody wrote by hand: the router dispatches only what its schemas take and answers each
// request once, the client settles each call once with an answer its schema takes, only this
// extension's own pages are principals, and hints and catch-up apply each commit once, in
// order, however they arrive. A failure prints its seed: run it again with NTN_FUZZ_SEED=<seed>.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { principalOf } from '../../js/kernel/adapters/messaging/runtime-port.js';
import { MAX_DEPTH, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '../../js/kernel/core/contracts/limits.js';
import { failed, rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { isTransportCode } from '../../js/kernel/core/contracts/transport-codes.js';
import { check, checkResult, readFrame } from '../../js/kernel/core/contracts/validate.js';
import { createCatchUp } from '../../js/kernel/core/messaging/catch-up.js';
import { createClient } from '../../js/kernel/core/messaging/client.js';
import { createHintSubscriber } from '../../js/kernel/core/messaging/hints.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { SYSTEM_OPERATIONS } from '../../js/kernel/core/messaging/system-operations.js';
import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { EXTENSION_ID, PAGE_FILES } from './chrome-fake.mjs';
import { NOW, testIds } from './support.mjs';
import {
  OPERATIONS,
  VERSION,
  hello,
  lookup,
  rawConnection,
  scriptedCoordinator,
  settle,
  testScheduler,
} from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/hints.js').Hint} Hint */
/** @typedef {import('../../js/kernel/core/ports/commit-log.js').ChangeEntry} ChangeEntry */

/** The seeds each property runs with, unless NTN_FUZZ_SEED names one */
const SEEDS = process.env.NTN_FUZZ_SEED ? [Number(process.env.NTN_FUZZ_SEED)] : [13, 1013, 20261030];

/**
 * A seeded generator, mulberry32
 * @param {number} seed
 */
function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** @param {number} n */
  const int = n => Math.floor(next() * n);
  return {
    next,
    int,
    /** @param {number} p */
    chance: p => next() < p,
    /**
     * @template T
     * @param {readonly T[]} items
     * @returns {T}
     */
    pick: items => items[int(items.length)],
    /**
     * @template T
     * @param {T[]} items
     * @returns {T[]}
     */
    shuffle(items) {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = int(index + 1);
        [copy[index], copy[other]] = [copy[other], copy[index]];
      }
      return copy;
    },
  };
}

/** @typedef {ReturnType<typeof generator>} Random */

/**
 * Runs `property` once per seed, and names the seed when it fails
 * @param {(random: Random, seed: number) => Promise<void>} property
 */
const seeded = property => async () => {
  for (const seed of SEEDS) {
    try {
      await property(generator(seed), seed);
    } catch (error) {
      const message = `fuzz failed with seed ${seed}; replay with NTN_FUZZ_SEED=${seed}`;
      console.error(message);
      throw new Error(`${message}: ${/** @type {Error} */ (error).message}`, { cause: error });
    }
  }
};

/**
 * A value of any JSON shape, a few levels deep
 * @param {Random} random
 * @param {number} [depth]
 * @returns {unknown}
 */
const anyValue = (random, depth = 0) => {
  const kinds = depth > 2 ? 5 : 7;
  switch (random.int(kinds)) {
    case 0:
      return null;
    case 1:
      return random.chance(0.5);
    case 2:
      return random.pick([0, -1, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER, 7]);
    case 3:
      return random.pick(['', 'n1', 'constructor', '__proto__', 'x'.repeat(random.int(300)), 'ünï', 'https://a.test/']);
    case 4:
      return random.pick(['note', 'block', 'folder', 'setting']);
    case 5:
      return Array.from({ length: random.int(4) }, () => anyValue(random, depth + 1));
    default:
      return Object.fromEntries(
        Array.from({ length: random.int(4) }, () => [
          random.pick(['a', 'id', 'type', 'noteId', '__proto__']),
          anyValue(random, depth + 1),
        ]),
      );
  }
};

/** Payloads each operation's schema takes, which the fuzzer starts from */
const VALID = /** @type {Array<Record<string, unknown> & {type: string}>} */ ([
  { type: 'setPinned', commandId: 'c', noteId: 'n1', pinned: true },
  { type: 'createNote', commandId: 'c', noteId: 'n1', name: 'Plan', blocks: [{ id: 'b1', content: 'a' }] },
  { type: 'renameNote', commandId: 'c', noteId: 'n1', name: 'Plan', origin: 'typed' },
  { type: 'runBulkAction', commandId: 'c', action: 'archive', noteIds: ['n1', 'n2'] },
  { type: 'createFolder', commandId: 'c', folderId: 'f1', name: 'Work', parentId: null },
  { type: 'getNote', noteId: 'n1' },
  { type: 'listNotes', view: 'active' },
  { type: 'listFolders' },
  { type: 'getPreferences', keys: ['theme'] },
  { type: 'system.messagingHealth' },
]);

/** Every operation the router knows */
const KNOWN = { ...OPERATIONS, ...SYSTEM_OPERATIONS };

/**
 * A payload from a valid one, changed or not
 * @param {Random} random
 * @param {number} serial - for its commandId, so commands don't share a key by accident
 */
function payloadFrom(random, serial) {
  const base = structuredClone(random.pick(VALID));
  if ('commandId' in base) base.commandId = `c-${serial}`;
  const keys = Object.keys(base);
  switch (random.int(8)) {
    case 0:
      delete base[random.pick(keys)];
      break;
    case 1:
      base[random.pick(['extra', 'apiKey', 'url', '__proto__'])] = anyValue(random);
      break;
    case 2:
      base[random.pick(keys)] = anyValue(random);
      break;
    case 3:
      base.type = random.pick([...Object.keys(KNOWN), 'nope', 'constructor', 'toString', '']);
      break;
    default:
      // Unchanged, so most requests reach a handler
      break;
  }
  return base;
}

/**
 * Text for one message to the router: a request frame, changed or not, or something else
 * @param {Random} random
 * @param {number} serial
 * @param {string[]} held - requestIds of requests a handler holds open
 */
function messageFrom(random, serial, held) {
  const roll = random.int(20);
  if (roll === 0) return random.pick(['', 'not json', '{', '[]', '7', 'null', '"text"']);
  if (roll === 1) return `${'['.repeat(MAX_DEPTH + 2)}${']'.repeat(MAX_DEPTH + 2)}`;
  if (roll === 2 && random.chance(0.15))
    return JSON.stringify({ frame: 'cancel', requestId: 'x'.repeat(MAX_MESSAGE_BYTES) });
  if (roll === 3) {
    return JSON.stringify({
      frame: random.pick(['response', 'welcome', 'error', 'cancelled', 'too-late', 'nope']),
      requestId: `r-${serial}`,
    });
  }
  if (roll === 4 && held.length > 0) return JSON.stringify({ frame: 'cancel', requestId: random.pick(held) });
  const payload = payloadFrom(random, serial);
  if (roll === 5) payload.blob = 'x'.repeat(random.pick([20 * 1024, MAX_MESSAGE_BYTES]));
  /** @type {Record<string, unknown>} */
  const frame = {
    frame: 'request',
    requestId: roll === 6 && held.length > 0 ? random.pick(held) : `r-${serial}`,
    operation: random.chance(0.85) ? payload.type : random.pick([...Object.keys(KNOWN), 'nope', '__proto__']),
    version: random.chance(0.85) ? 1 : random.pick([0, 2, -1, 1.5, '1', null, 1e9]),
    deadline: random.chance(0.9) ? NOW + 10_000 : random.pick([NOW - 1, NOW, -5, 1.5, 'soon']),
    payload,
  };
  if (roll === 7) frame.extra = anyValue(random);
  if (roll === 8) frame.requestId = random.pick(['', 7, null, 'x'.repeat(200)]);
  return JSON.stringify(frame);
}

describe('seeded envelope fuzzing (#13, "Test plan")', { timeout: 30_000 }, () => {
  it(
    'the router dispatches only payloads their schemas take, answers each request once, and counts nothing a sender chose',
    seeded(async random => {
      /** @type {Array<{operation: string, payload: Record<string, unknown>, surface: string}>} */
      const dispatched = [];
      /** @type {Array<() => void>} */
      const release = [];
      const handlers = Object.fromEntries(
        Object.keys(OPERATIONS).map(name => [
          name,
          /** @type {import('../../js/kernel/core/messaging/router.js').Handler} */ (
            (payload, context) => {
              const record = /** @type {Record<string, unknown>} */ (payload);
              dispatched.push({ operation: name, payload: record, surface: context.caller.surface });
              const isCommand = OPERATIONS[name].entry.kind === 'command';
              const answer = isCommand ? rejected('validation', 'fuzzed') : failed('storage', 'fuzzed');
              if (isCommand) context.begin();
              if (record.noteId === 'n1' && random.chance(0.2)) {
                return new Promise(resolve => release.push(() => resolve(answer)));
              }
              return answer;
            }
          ),
        ]),
      );
      const scheduler = testScheduler();
      const router = createRouter({
        lookup,
        handlers,
        policy: createBaselinePolicy(),
        ...scheduler,
        coordinatorId: 'coordinator-1',
        extensionVersion: VERSION,
      });
      const peer = rawConnection(router, 'newtab');
      peer.send(hello('newtab'));
      await settle();
      assert.equal(peer.frames.shift()?.frame, 'welcome');

      /** @type {Map<string, number>} how many answers each readable request should get */
      const expected = new Map();
      /** @type {Set<string>} requestIds a handler holds open */
      const running = new Set();
      for (let serial = 0; serial < 400; serial += 1) {
        const text = messageFrom(random, serial, [...running]);
        const read = readFrame(text);
        if (read.ok && read.frame.frame === 'request') {
          const { requestId } = read.frame;
          // A request reusing a running one's id gets no answer of its own
          if (!running.has(requestId)) expected.set(requestId, (expected.get(requestId) ?? 0) + 1);
        }
        const before = release.length;
        const seen = peer.frames.length;
        peer.sendText(text);
        await settle();
        if (release.length > before && read.ok && read.frame.frame === 'request') running.add(read.frame.requestId);
        // A held request the router answered, as a query cancelled, isn't running any more
        for (const frame of peer.frames.slice(seen)) {
          if (frame.frame !== 'too-late') running.delete(frame.requestId);
        }
        if (random.chance(0.1)) {
          for (const go of release.splice(0)) go();
          running.clear();
          await settle();
        }
      }
      for (const go of release.splice(0)) go();
      await settle();

      for (const { operation, payload, surface } of dispatched) {
        assert.equal(surface, 'newtab');
        assert.equal(payload.type, operation);
        assert.ok(check(KNOWN[operation].payload, payload).ok, `${operation} dispatched a payload its schema refuses`);
      }
      /** @type {Map<string, number>} */
      const answers = new Map();
      for (const frame of peer.frames) {
        assert.ok(readFrame(JSON.stringify(frame)).ok, 'every frame it sends is one its schema takes');
        assert.ok(['response', 'error', 'cancelled', 'too-late'].includes(frame.frame), frame.frame);
        if (frame.frame === 'error') assert.ok(isTransportCode(frame.code), frame.code);
        if (frame.frame === 'response' || frame.frame === 'error' || frame.frame === 'cancelled') {
          answers.set(frame.requestId, (answers.get(frame.requestId) ?? 0) + 1);
        }
      }
      assert.deepEqual(new Map([...answers].sort()), new Map([...expected].sort()));
      const known = new Set(Object.keys(KNOWN));
      for (const { operation } of router.health().requests) assert.ok(known.has(operation), operation);

      // It still serves the connection after all of that
      peer.frames.length = 0;
      peer.send({
        frame: 'request',
        requestId: 'last',
        operation: 'getNote',
        version: 1,
        deadline: NOW + 10_000,
        payload: { type: 'getNote', noteId: 'n2' },
      });
      await settle();
      assert.deepEqual(peer.frames, [{ frame: 'response', requestId: 'last', result: failed('storage', 'fuzzed') }]);
    }),
  );

  it(
    'a hello is welcomed only when its schema takes it and it names the surface its transport verified',
    seeded(async random => {
      const router = createRouter({
        lookup,
        policy: createBaselinePolicy(),
        ...testScheduler(),
        coordinatorId: 'coordinator-1',
        extensionVersion: VERSION,
      });
      for (let round = 0; round < 100; round += 1) {
        const frame = /** @type {Record<string, unknown>} */ (hello(random.pick(['newtab', 'popup', 'sidepanel'])));
        const field = random.pick(['protocol', 'extensionVersion', 'surface', 'sessionId', 'extra', 'none']);
        if (field !== 'none') frame[field] = random.chance(0.5) ? anyValue(random) : random.pick(['newtab', '1', 2]);
        if (random.chance(0.2)) frame.protocol = { major: random.pick([0, 1, 2]), minor: random.int(3) };
        const peer = rawConnection(router, 'newtab');
        const text = JSON.stringify(frame);
        peer.sendText(text);
        await settle();
        const read = readFrame(text);
        const welcomed = read.ok && read.frame.frame === 'hello' && read.frame.surface === 'newtab';
        assert.equal(peer.frames[0]?.frame === 'welcome', welcomed, text);
        assert.equal(peer.closed, read.ok && read.frame.frame === 'hello' && !welcomed, text);
        if (welcomed) assert.deepEqual(peer.frames[0].protocol, PROTOCOL_VERSION);
        peer.close();
      }
    }),
  );

  it(
    "the client settles each call once, with an answer its operation's result schema takes, whatever the coordinator sends",
    seeded(async random => {
      const scheduler = testScheduler();
      const coordinator = scriptedCoordinator();
      const client = createClient({
        transport: coordinator.transport,
        surface: 'newtab',
        extensionVersion: VERSION,
        lookup,
        ids: testIds('client'),
        ...scheduler,
      });
      /** @type {Array<{name: string, settled: number, answer?: unknown}>} */
      const calls = [];
      for (let serial = 0; serial < 30; serial += 1) {
        const base = structuredClone(random.pick(VALID));
        if ('commandId' in base) base.commandId = `c-${serial}`;
        /** @type {{name: string, settled: number, answer?: unknown}} */
        const call = { name: base.type, settled: 0 };
        calls.push(call);
        const kind = OPERATIONS[base.type]?.entry.kind ?? 'query';
        const answer = kind === 'command' ? client.execute(/** @type {any} */ (base)) : client.query(base);
        void answer.then(result => {
          call.settled += 1;
          call.answer = result;
        });
      }
      await settle();
      coordinator.last.welcome();
      await settle();
      const requests = coordinator.last.requests();
      for (let round = 0; round < 200; round += 1) {
        const requestId = random.chance(0.8) && requests.length > 0 ? random.pick(requests).requestId : `r-${round}`;
        const frame = random.pick([
          () => ({ frame: 'response', requestId, result: anyValue(random) }),
          () => ({
            frame: 'response',
            requestId,
            result: random.pick([rejected('validation', 'fuzzed'), failed('storage', 'fuzzed')]),
          }),
          () => ({
            frame: 'error',
            requestId,
            code: random.pick(['unavailable', 'outcome-unknown', 'invalid-payload', 'nope']),
          }),
          () => ({ frame: 'cancelled', requestId }),
          () => ({ frame: 'too-late', requestId, outcome: anyValue(random) }),
          () => ({
            frame: 'welcome',
            protocol: { major: 9, minor: 0 },
            extensionVersion: '9',
            coordinatorId: 'x',
            status: 'ready',
          }),
        ])();
        try {
          coordinator.last.send(random.chance(0.05) ? anyValue(random) : frame);
        } catch {
          // What the codec can't carry never reaches the client
        }
      }
      await settle();
      coordinator.last.close();
      for (let tries = 0; calls.some(call => call.settled === 0) && tries < 50; tries += 1) await settle();
      for (const call of calls) {
        assert.equal(call.settled, 1, `${call.name} settled once`);
        assert.ok(
          checkResult(KNOWN[call.name], call.answer).ok,
          `${call.name} answered ${JSON.stringify(call.answer)}`,
        );
      }
    }),
  );

  it(
    "only this extension's own pages are principals, whatever a sender claims",
    seeded(async random => {
      const own = `chrome-extension://${EXTENSION_ID}`;
      const files = Object.entries(PAGE_FILES);
      for (let round = 0; round < 500; round += 1) {
        const [surface, file] = random.pick(files);
        const url = random.pick([
          `${own}/${file}`,
          `${own}/${file}?x=1#y`,
          `${own}/${file.toUpperCase()}`,
          `${own}/js/${file}`,
          `${own}/${file}/../popup.html`,
          `${own}evil/${file}`,
          `chrome-extension://${'b'.repeat(32)}/${file}`,
          `https://example.test/${file}`,
          `${own}`,
          `${own}//${file}`,
          anyValue(random),
        ]);
        /** @type {Record<string, unknown>} */
        const sender = {
          id: random.chance(0.8) ? EXTENSION_ID : random.pick([undefined, 'b'.repeat(32), '', 7]),
          url,
          origin: random.chance(0.6)
            ? own
            : random.pick([undefined, 'https://example.test', 'null', own.toUpperCase()]),
        };
        if (random.chance(0.3)) sender.tab = { id: random.int(9), url: anyValue(random) };
        if (random.chance(0.1)) delete sender.url;
        const replaced = random.chance(0.02);
        const extensionId = random.chance(0.97) ? EXTENSION_ID : undefined;
        const surfaceOf = principalOf(replaced ? anyValue(random) : sender, extensionId);
        const page =
          !replaced &&
          extensionId === EXTENSION_ID &&
          typeof sender.url === 'string' &&
          [`${own}/${file}`, `${own}/${file}?x=1#y`].includes(sender.url) &&
          sender.id === EXTENSION_ID &&
          (sender.origin === undefined || sender.origin === own);
        assert.equal(surfaceOf, page ? surface : null, JSON.stringify(sender));
      }
    }),
  );

  it(
    "a page hears each entity's hints in commitSeq order, once each, however they are duplicated, reordered, or forged",
    seeded(async random => {
      /** @type {Array<(text: string) => void>} */
      const listeners = [];
      const subscriber = createHintSubscriber({
        channel: { post() {}, onMessage: listener => listeners.push(listener), close() {} },
      });
      /** @type {Hint[]} */
      const heard = [];
      subscriber.subscribe(hint => heard.push(hint));
      /** @type {Map<string, number>} */
      const highest = new Map();
      const entities = ['n1', 'n2', 'f1'];
      /** @type {Array<Record<string, any>>} */
      const posted = [];
      for (let seq = 1; seq <= 60; seq += 1) {
        const entityId = random.pick(entities);
        posted.push({
          frame: 'hint',
          entityType: entityId.startsWith('f') ? 'folder' : 'note',
          entityId,
          revision: seq,
          commitSeq: seq,
        });
      }
      const traffic = random.shuffle([
        ...posted,
        ...posted.filter(() => random.chance(0.4)),
        ...Array.from({ length: 20 }, () => ({ frame: 'hint', .../** @type {object} */ (anyValue(random)) })),
      ]);
      /** @type {Array<Record<string, any>>} the hints that went out intact */
      const intact = [];
      for (const frame of traffic) {
        const garbled = random.chance(0.05);
        if (!garbled && posted.includes(frame)) intact.push(frame);
        const text = garbled ? String(anyValue(random)) : JSON.stringify(frame);
        for (const listener of listeners) listener(text);
      }
      /** @type {Map<string, number>} */
      const last = new Map();
      for (const hint of heard) {
        const key = `${hint.entityType} ${hint.entityId}`;
        assert.ok((last.get(key) ?? 0) < hint.commitSeq, `${key} heard ${hint.commitSeq} after ${last.get(key)}`);
        last.set(key, hint.commitSeq);
        assert.ok(
          posted.some(frame => frame.entityId === hint.entityId && frame.commitSeq === hint.commitSeq),
          'only what was posted',
        );
      }
      for (const frame of intact) {
        const key = `${frame.entityType} ${frame.entityId}`;
        highest.set(key, Math.max(highest.get(key) ?? 0, frame.commitSeq));
      }
      for (const [key, seq] of highest) assert.equal(last.get(key), seq, `${key} heard its latest`);
    }),
  );

  it(
    'catch-up applies each commit once, in order, whatever order hints arrive in and however many repeat',
    seeded(async random => {
      const log = createMemoryCommitLog();
      /** @type {Set<(hint: Hint) => void>} */
      const listeners = new Set();
      /** @type {ChangeEntry[]} */
      const applied = [];
      const start = random.int(5);
      for (let seq = 1; seq <= start; seq += 1) log.append([{ entityType: 'note', entityId: `n${seq}`, revision: 1 }]);
      const catchUp = createCatchUp({
        subscribe: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        commitLog: log,
        project: () => log.head(),
        apply: entries => {
          applied.push(...entries);
        },
        limit: 1 + random.int(4),
      });
      await catchUp.start();
      /** @type {Hint[]} */
      const hints = [];
      for (let round = 0; round < 40; round += 1) {
        const ids = Array.from({ length: 1 + random.int(2) }, () => `n${random.int(6)}`);
        const changes = [...new Set(ids)].map(entityId => ({
          entityType: /** @type {const} */ ('note'),
          entityId,
          revision: round,
        }));
        const commitSeq = log.append(changes);
        for (const change of changes) hints.push({ ...change, commitSeq });
        if (random.chance(0.3)) {
          for (const hint of random.shuffle(hints.filter(() => random.chance(0.5)))) {
            for (const listener of listeners) listener(hint);
          }
          if (random.chance(0.5)) await settle();
        }
      }
      for (const hint of random.shuffle(hints)) for (const listener of listeners) listener(hint);
      await settle();
      await settle();
      const expected = await log.readChangesSince(start, 1000);
      assert.equal(expected.kind, 'changes');
      assert.deepEqual(applied, expected.kind === 'changes' ? expected.entries : []);
      assert.equal(catchUp.cursor(), await log.head());
    }),
  );
});
