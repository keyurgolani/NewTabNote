// The worker's router (composition/background.js), which js/background.js installs at its top
// level (#13, "Topology"): a page's port reaches it on the Chrome fake, and it serves the
// handshake, system.messagingHealth, the system.coordinatorHealth handler #35's coordinator gives
// it, and the commands pages send on the coordinator's queue: Popup's and Side Panel's since #35
// slices 4b-2 and 4c, and the new tab's since slice 4d. Installing it never throws, since a throw
// while the worker evaluates would stop every listener it registers. Its policy is the shared
// catalog's, so no page reaches what only the worker runs (contracts/worker-catalog.js).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { PORT_NAME } from '../../js/kernel/adapters/messaging/runtime-port.js';
import { installWorkerRouter } from '../../js/kernel/composition/background.js';
import { coordinatorHandlers } from '../../js/kernel/composition/coordinator.js';
import * as coordination from '../../js/kernel/composition/coordinator.js';
import { decode, encode } from '../../js/kernel/core/contracts/codec.js';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { committed } from '../../js/kernel/core/contracts/outcomes.js';
import { PROTOCOL_VERSION } from '../../js/kernel/core/contracts/limits.js';
import { WORKER_ONLY_COMMANDS, WORKER_ONLY_QUERIES } from '../../js/kernel/core/contracts/worker-catalog.js';
import { PAGE_FILES, createChromeFake } from './chrome-fake.mjs';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { hello, request, settle } from './messaging-support.mjs';

/** @typedef {keyof typeof import('./chrome-fake.mjs').PAGE_FILES} PageSurface */

/**
 * A fake whose worker installs the router at its top level, and a page's raw end of the port
 * it opens, which sends frames and keeps the frames that come back
 * @param {PageSurface} surface
 */
function connected(surface) {
  const fake = createChromeFake();
  /** @type {unknown[]} */
  const reported = [];
  fake.worker.install(chrome => {
    installWorkerRouter({ runtime: chrome.runtime, report: error => reported.push(error) });
  });
  const port = fake.page(surface).chrome.runtime.connect({ name: PORT_NAME });
  /** @type {Array<Record<string, any>>} */
  const frames = [];
  /** @type {string[]} */
  const ended = [];
  port.onMessage.addListener((/** @type {string} */ text) => {
    frames.push(/** @type {Record<string, any>} */ (decode(text)));
  });
  port.onDisconnect.addListener(() => ended.push('disconnected'));
  return { fake, frames, ended, reported, send: (/** @type {unknown} */ frame) => port.postMessage(encode(frame)) };
}

/** A request the router's own clock still has time for */
const soon = () => ({ deadline: Date.now() + 10_000 });

describe('the worker\'s router (#13, "Topology")', () => {
  it("takes the port that woke the worker, welcomes the page's hello, and answers system.messagingHealth", async () => {
    const page = connected('popup');
    page.send(hello('popup', 's1'));
    page.send(request('r1', { type: 'system.messagingHealth' }, soon()));
    await settle();
    await settle();
    assert.deepEqual(page.ended, []);
    const [welcome, response] = page.frames;
    assert.deepEqual(
      [welcome.frame, welcome.protocol, welcome.extensionVersion, welcome.status],
      ['welcome', PROTOCOL_VERSION, '2.0.0', 'ready'],
    );
    assert.equal(typeof welcome.coordinatorId, 'string');
    assert.deepEqual([response.frame, response.requestId, response.result.kind], ['response', 'r1', 'ready']);
    assert.deepEqual([response.result.data.connections, response.result.data.handshakes], [1, 1]);
    assert.equal(response.result.data.coordinatorId, welcome.coordinatorId);
    assert.deepEqual(page.reported, []);
  });

  it("serves nothing else until #35 adds its handlers, and holds a hello to the page's own surface", async () => {
    const page = connected('sidepanel');
    page.send(hello('sidepanel', 's1'));
    page.send(request('r1', { type: 'getNote', noteId: 'n1' }, soon()));
    await settle();
    await settle();
    assert.deepEqual(page.frames[1], { frame: 'error', requestId: 'r1', code: 'unknown-operation' });

    const claims = connected('sidepanel');
    claims.send(hello('newtab', 's2'));
    await settle();
    await settle();
    assert.deepEqual([claims.frames, claims.ended], [[], ['disconnected']]);
  });

  it('starts again with a router of its own and a new coordinatorId after the worker stops', async () => {
    const first = connected('newtab');
    first.send(hello('newtab', 's1'));
    await settle();
    first.fake.worker.stop();
    const again = first.fake.page('newtab').chrome.runtime.connect({ name: PORT_NAME });
    /** @type {Array<Record<string, any>>} */
    const frames = [];
    again.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    again.postMessage(encode(hello('newtab', 's1')));
    await settle();
    await settle();
    assert.equal(first.fake.worker.starts, 2);
    assert.notEqual(frames[0].coordinatorId, first.frames[0].coordinatorId);
  });

  it("welcomes with the coordinator's id and what it says now, and tells it of each session (#35)", async () => {
    const fake = createChromeFake();
    /** @type {Array<{surface: string, sessionId: string}>} */
    const opened = [];
    /** @type {import('../../js/kernel/core/messaging/router.js').CoordinatorStatus} */
    let status = { status: 'degraded', reason: 'starting' };
    fake.worker.install(chrome => {
      installWorkerRouter({
        runtime: chrome.runtime,
        coordinatorId: 'coordinator-1',
        status: () => status,
        sessions: { opened: session => opened.push({ ...session }) },
      });
    });
    /** @param {string} sessionId */
    const welcomeOf = async sessionId => {
      const port = fake.page('popup').chrome.runtime.connect({ name: PORT_NAME });
      /** @type {Array<Record<string, any>>} */
      const frames = [];
      port.onMessage.addListener((/** @type {string} */ text) => {
        frames.push(/** @type {Record<string, any>} */ (decode(text)));
      });
      port.postMessage(encode(hello('popup', sessionId)));
      await settle();
      await settle();
      const [welcome] = frames;
      return [welcome.coordinatorId, welcome.status, welcome.reason];
    };
    assert.deepEqual(await welcomeOf('s1'), ['coordinator-1', 'degraded', 'starting']);
    status = { status: 'ready' };
    assert.deepEqual(await welcomeOf('s2'), ['coordinator-1', 'ready', undefined]);
    assert.deepEqual(opened, [
      { surface: 'popup', sessionId: 's1' },
      { surface: 'popup', sessionId: 's2' },
    ]);
  });

  it("hands the router the coordinator's settled, so a hello while it starts is welcomed once the start is done (#35)", async () => {
    const fake = createChromeFake();
    /** @type {import('../../js/kernel/core/messaging/router.js').CoordinatorStatus} */
    let status = { status: 'degraded', reason: 'starting' };
    let starts = 0;
    /** @type {() => void} */
    let finish = () => {};
    const done = new Promise(resolve => {
      finish = () => {
        status = { status: 'ready' };
        resolve(undefined);
      };
    });
    fake.worker.install(chrome => {
      installWorkerRouter({
        runtime: chrome.runtime,
        status: () => status,
        settled: () => {
          starts += 1;
          return done;
        },
      });
    });
    const port = fake.page('popup').chrome.runtime.connect({ name: PORT_NAME });
    /** @type {Array<Record<string, any>>} */
    const frames = [];
    port.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    port.postMessage(encode(hello('popup', 's1')));
    await settle();
    await settle();
    assert.deepEqual([frames, starts], [[], 1]);
    finish();
    await settle();
    await settle();
    assert.deepEqual(frames.map(frame => [frame.frame, frame.status, frame.reason]), [['welcome', 'ready', undefined]]);
  });

  it("answers system.coordinatorHealth from the coordinator's handler (#35)", async () => {
    const fake = createChromeFake();
    const health = {
      status: 'ready',
      coordinatorId: 'coordinator-1',
      startedAt: 7,
      commands: [],
      oldestOrphanedEntryAt: null,
      migration: null,
    };
    fake.worker.install(chrome => {
      installWorkerRouter({
        runtime: chrome.runtime,
        coordinatorId: 'coordinator-1',
        handlers: coordinatorHandlers(() => /** @type {any} */ ({ health: () => health })),
      });
    });
    const port = fake.page('popup').chrome.runtime.connect({ name: PORT_NAME });
    /** @type {Array<Record<string, any>>} */
    const frames = [];
    port.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    port.postMessage(encode(hello('popup', 's1')));
    port.postMessage(encode(request('r1', { type: 'system.coordinatorHealth' }, soon())));
    await settle();
    await settle();
    const response = frames.find(frame => frame.frame === 'response');
    assert.deepEqual(response && [response.requestId, response.result.kind, response.result.data], [
      'r1',
      'ready',
      health,
    ]);
  });

  it("hands Popup's createNote and applyCloseDraft to the coordinator's queue as Popup, each with its request's own begin, and refuses at the router a page's command the shared catalog doesn't grant that page (#35 slice 4b-2, rule 5)", async () => {
    /** @type {Array<[unknown, unknown, unknown]>} each command the queue got: its type, its surface, and what its begin() said then */
    const queued = [];
    /** @type {Array<() => boolean>} */
    const begins = [];
    const coordinator = {
      /** @param {any} command @param {any} [dispatch] */
      enqueue: async (command, dispatch = {}) => {
        begins.push(dispatch.begin);
        queued.push([command.type, dispatch.surface, typeof dispatch.begin === 'function' && dispatch.begin()]);
        return committed(command.type === 'createNote' ? 'note-created' : 'close-draft-gone', []);
      },
    };
    const handlers = /** @type {any} */ (coordination).pageCommandHandlers?.(() => coordinator) ?? {};
    const fake = createChromeFake();
    fake.worker.install(chrome => {
      installWorkerRouter({ runtime: chrome.runtime, handlers });
    });
    const port = fake.page('popup').chrome.runtime.connect({ name: PORT_NAME });
    /** @type {Array<Record<string, any>>} */
    const frames = [];
    port.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    const draft = { v: 1, id: 'draft-1', noteId: 'n1', at: 1, base: {}, blocks: [{ id: 'b1' }], deletedBlockIds: [] };
    port.postMessage(encode(hello('popup', 's1')));
    port.postMessage(
      encode(request('r1', { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Quick', blocks: [] }, soon())),
    );
    port.postMessage(encode(request('r2', { type: 'applyCloseDraft', commandId: 'c2', draft }, soon())));
    // Side Panel's createNote, which the shared catalog doesn't grant it, is refused at the router
    const side = fake.page('sidepanel').chrome.runtime.connect({ name: PORT_NAME });
    side.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    side.postMessage(encode(hello('sidepanel', 's2')));
    side.postMessage(
      encode(request('r3', { type: 'createNote', commandId: 'c3', noteId: 'n2', name: 'Side', blocks: [] }, soon())),
    );
    await settle();
    await settle();
    assert.deepEqual(
      frames
        .filter(frame => frame.frame === 'response' || frame.frame === 'error')
        .map(frame => [frame.requestId, frame.frame === 'response' ? frame.result.kind : frame.code])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
      [
        ['r1', 'committed'],
        ['r2', 'committed'],
        ['r3', 'forbidden-for-surface'],
      ],
    );
    assert.deepEqual(
      queued,
      [
        ['createNote', 'popup', true],
        ['applyCloseDraft', 'popup', true],
      ],
      `each reaches the queue as Popup, with its request's begin: ${JSON.stringify(queued)}`,
    );
    // Each begin is its request's own: once the router has answered the request, it answers false
    assert.deepEqual(
      begins.map(begin => begin()),
      [false, false],
    );
  });

  it("hands every command the new tab sends to the coordinator's queue as the new tab, each with its request's own begin, but its session's write and startup maintenance, which the router doesn't know (#35 slice 4d, rule 10)", async () => {
    // The catalog's, not the worker's tables', so a lookup that drops one is caught
    const stayOff = ['saveWorkspaceSession', 'runStartupMaintenance'];
    const sends = Object.keys(COMMANDS).filter(
      type =>
        COMMANDS[/** @type {keyof typeof COMMANDS} */ (type)].surfaces.includes('newtab') && !stayOff.includes(type),
    );
    assert.equal(sends.length, 46);
    /** @type {Array<[unknown, unknown, unknown]>} */
    const queued = [];
    const coordinator = {
      /** @param {any} command @param {any} [dispatch] */
      enqueue: async (command, dispatch = {}) => {
        queued.push([command.type, dispatch.surface, typeof dispatch.begin === 'function' && dispatch.begin()]);
        return committed('note-created', []);
      },
    };
    const handlers = /** @type {any} */ (coordination).pageCommandHandlers?.(() => coordinator) ?? {};
    const fake = createChromeFake();
    fake.worker.install(chrome => {
      installWorkerRouter({ runtime: chrome.runtime, handlers });
    });
    const port = fake.page('newtab').chrome.runtime.connect({ name: PORT_NAME });
    /** @type {Array<Record<string, any>>} */
    const frames = [];
    port.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    port.postMessage(encode(hello('newtab', 's1')));
    for (const type of [...sends, ...stayOff]) {
      const fields = COMMAND_SAMPLES[/** @type {keyof typeof COMMAND_SAMPLES} */ (type)];
      port.postMessage(encode(request(`r-${type}`, { ...fields, type, commandId: `c-${type}` }, soon())));
    }
    for (let round = 0; round < 10; round++) await settle();
    assert.deepEqual(
      frames.filter(frame => frame.frame === 'error').map(frame => [frame.requestId, frame.code]),
      stayOff.map(type => [`r-${type}`, 'unknown-operation']),
    );
    assert.deepEqual(
      [...queued].sort(([a], [b]) => String(a).localeCompare(String(b))),
      sends.map(type => [type, 'newtab', true]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  });

  it('lets a command it received before its port closed run at its turn, and drops its answer, while a query from that port ends and a command whose deadline comes first ends unrun (#35 slice 4d, rule 17)', async () => {
    /** @type {Array<{type: unknown, begin: () => boolean, answer: (value: unknown) => void}>} */
    const held = [];
    const coordinator = {
      /** @param {any} command @param {any} [dispatch] */
      enqueue: (command, dispatch = {}) =>
        new Promise(answer => {
          held.push({ type: command.type, begin: dispatch.begin, answer });
        }),
    };
    /** @type {string[]} */
    const stopped = [];
    const handlers = {
      .../** @type {any} */ (coordination).pageCommandHandlers?.(() => coordinator),
      // A query the router holds open until its port goes
      'system.coordinatorHealth': (/** @type {unknown} */ payload, /** @type {any} */ dispatch) => {
        dispatch.onCancel(() => stopped.push('health'));
        return new Promise(() => {});
      },
    };
    const fake = createChromeFake();
    fake.worker.install(chrome => {
      installWorkerRouter({ runtime: chrome.runtime, handlers });
    });
    const port = fake.page('popup').chrome.runtime.connect({ name: PORT_NAME });
    /** @type {Array<Record<string, any>>} */
    const frames = [];
    port.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    const quick = (/** @type {string} */ id) => ({
      type: 'createNote',
      commandId: `c-${id}`,
      noteId: id,
      name: 'Quick',
      blocks: [],
    });
    port.postMessage(encode(hello('popup', 's1')));
    port.postMessage(encode(request('r1', quick('n1'), soon())));
    port.postMessage(encode(request('r2', { type: 'system.coordinatorHealth' }, soon())));
    port.postMessage(encode(request('r3', quick('n3'), { deadline: Date.now() + 40 })));
    await settle();
    await settle();
    assert.deepEqual(
      held.map(entry => entry.type),
      ['createNote', 'createNote'],
    );
    // The page goes before either command's turn
    port.disconnect();
    await settle();
    await settle();
    assert.deepEqual(stopped, ['health'], 'the query ends with its port');
    await new Promise(resolve => setTimeout(resolve, 100));
    const [first, late] = held;
    assert.equal(first.begin(), true, 'the first runs at its turn');
    assert.equal(late.begin(), false, 'the second, whose deadline came first, ends unrun');
    first.answer(committed('note-created', ['n1']));
    await settle();
    await settle();
    assert.deepEqual(
      frames.filter(frame => frame.frame !== 'welcome'),
      [],
      'nothing goes to the page that went',
    );
  });

  it('answers a command still waiting at its deadline while the coordinator migrates as unavailable, coordinator, migrating, retryable, and one outside a migration deadline-exceeded, as before (#35 slice 4d, rule 18)', async () => {
    /** @type {import('../../js/kernel/core/messaging/router.js').CoordinatorStatus} */
    let status = { status: 'degraded', reason: 'migrating' };
    // A queue whose turn never comes
    const coordinator = { enqueue: () => new Promise(() => {}) };
    const handlers = /** @type {any} */ (coordination).pageCommandHandlers?.(() => coordinator) ?? {};
    const fake = createChromeFake();
    fake.worker.install(chrome => {
      installWorkerRouter({ runtime: chrome.runtime, status: () => status, handlers });
    });
    const port = fake.page('popup').chrome.runtime.connect({ name: PORT_NAME });
    /** @type {Array<Record<string, any>>} */
    const frames = [];
    port.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    const quick = (/** @type {string} */ id) => ({
      type: 'createNote',
      commandId: `c-${id}`,
      noteId: id,
      name: 'Quick',
      blocks: [],
    });
    port.postMessage(encode(hello('popup', 's1')));
    port.postMessage(encode(request('r1', quick('n1'), { deadline: Date.now() + 40 })));
    await new Promise(resolve => setTimeout(resolve, 120));
    status = { status: 'ready' };
    port.postMessage(encode(request('r2', quick('n2'), { deadline: Date.now() + 40 })));
    await new Promise(resolve => setTimeout(resolve, 120));
    await settle();
    const during = frames.find(frame => frame.requestId === 'r1');
    assert.deepEqual(
      during && [
        during.frame,
        during.result?.kind,
        during.result?.cause,
        during.result?.code,
        during.result?.retryable,
      ],
      ['response', 'unavailable', 'coordinator', 'migrating', true],
      JSON.stringify(during),
    );
    const after = frames.find(frame => frame.requestId === 'r2');
    assert.deepEqual(after && [after.frame, after.code], ['error', 'deadline-exceeded'], JSON.stringify(after));
  });

  it('answers a command still waiting at its deadline while another context restores as unavailable, coordinator, restoring, retryable (#35 slice 7)', async () => {
    /** @type {import('../../js/kernel/core/messaging/router.js').CoordinatorStatus} */
    const status = { status: 'degraded', reason: 'restoring' };
    // A queue the pause holds, so the command's turn never comes
    const coordinator = { enqueue: () => new Promise(() => {}) };
    const handlers = /** @type {any} */ (coordination).pageCommandHandlers?.(() => coordinator) ?? {};
    const fake = createChromeFake();
    fake.worker.install(chrome => {
      installWorkerRouter({ runtime: chrome.runtime, status: () => status, handlers });
    });
    const port = fake.page('popup').chrome.runtime.connect({ name: PORT_NAME });
    /** @type {Array<Record<string, any>>} */
    const frames = [];
    port.onMessage.addListener((/** @type {string} */ text) => {
      frames.push(/** @type {Record<string, any>} */ (decode(text)));
    });
    const quick = { type: 'createNote', commandId: 'c-n1', noteId: 'n1', name: 'Quick', blocks: [] };
    port.postMessage(encode(hello('popup', 's1')));
    port.postMessage(encode(request('r1', quick, { deadline: Date.now() + 40 })));
    await new Promise(resolve => setTimeout(resolve, 120));
    await settle();
    const late = frames.find(frame => frame.requestId === 'r1');
    assert.deepEqual(
      late && [late.frame, late.result?.kind, late.result?.cause, late.result?.code, late.result?.retryable],
      ['response', 'unavailable', 'coordinator', 'restoring', true],
      JSON.stringify(late),
    );
  });

  it("serves no page what only the worker runs, even with a handler for each (the catalog split's sixth rule)", async () => {
    const workerOnly = [...Object.keys(WORKER_ONLY_COMMANDS), ...Object.keys(WORKER_ONLY_QUERIES)];
    /** @type {string[]} */
    const ran = [];
    const handlers = Object.fromEntries(
      workerOnly.map(type => [
        type,
        async () => {
          ran.push(type);
          return { kind: 'ready', asOf: 0, data: {} };
        },
      ]),
    );
    for (const surface of /** @type {PageSurface[]} */ (Object.keys(PAGE_FILES))) {
      const fake = createChromeFake();
      fake.worker.install(chrome => {
        installWorkerRouter({ runtime: chrome.runtime, handlers: /** @type {any} */ (handlers) });
      });
      const port = fake.page(surface).chrome.runtime.connect({ name: PORT_NAME });
      /** @type {Array<Record<string, any>>} */
      const frames = [];
      port.onMessage.addListener((/** @type {string} */ text) => {
        frames.push(/** @type {Record<string, any>} */ (decode(text)));
      });
      port.postMessage(encode(hello(surface, `${surface}-1`)));
      for (const [index, type] of workerOnly.entries())
        port.postMessage(encode(request(`r${index}`, { type }, soon())));
      await settle();
      await settle();
      assert.deepEqual(
        frames.filter(frame => frame.frame === 'error').map(frame => [frame.requestId, frame.code]),
        workerOnly.map((_, index) => [`r${index}`, 'unknown-operation']),
        surface,
      );
    }
    assert.deepEqual(ran, []);
  });

  it("builds its router's policy on the shared catalog alone, which a page's grants come from once slice 4 serves commands over the port (the catalog split's sixth rule)", () => {
    const file = path.join(import.meta.dirname, '..', '..', 'js', 'kernel', 'composition', 'background.js');
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    /** @type {string[]} each createRouter call's policy, as written */
    const policies = [];
    /** @param {ts.Node} node */
    const walk = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createRouter') {
        const [options] = node.arguments;
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === 'policy'
            ) {
              policies.push(property.initializer.getText(source));
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    // The baseline policy with no catalog given is the shared catalog's (ports/policy.js)
    assert.deepEqual(policies, ['createBaselinePolicy()']);
  });

  it("never throws, where the runtime can't take its listener, and reports why", () => {
    /** @type {unknown[]} */
    const reported = [];
    assert.equal(
      installWorkerRouter({ runtime: /** @type {any} */ ({}), report: error => reported.push(error) }),
      null,
    );
    assert.equal(installWorkerRouter({ runtime: undefined, report: error => reported.push(error) }), null);
    assert.equal(reported.length, 2);
    assert.ok(reported.every(error => error instanceof TypeError));
  });
});
