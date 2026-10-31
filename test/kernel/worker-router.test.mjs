// The worker's router (composition/background.js), which js/background.js installs at its top
// level (#13, "Topology"): a page's port reaches it on the Chrome fake, and it serves only the
// handshake and system.messagingHealth until #35 adds its handlers. Installing it never
// throws, since a throw while the worker evaluates would stop every listener it registers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PORT_NAME } from '../../js/kernel/adapters/messaging/runtime-port.js';
import { installWorkerRouter } from '../../js/kernel/composition/background.js';
import { decode, encode } from '../../js/kernel/core/contracts/codec.js';
import { PROTOCOL_VERSION } from '../../js/kernel/core/contracts/limits.js';
import { createChromeFake } from './chrome-fake.mjs';
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
