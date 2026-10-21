// Transport selection (composition/messaging.js, #13, "Topology"): a page takes the runtime
// port only where chrome.runtime has an id and connect(), and otherwise reaches a router of
// its own in-process, and the worker's own code always goes in-process as worker-internal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installRuntimePort } from '../../js/kernel/adapters/messaging/runtime-port.js';
import {
  canConnect,
  hostTimers,
  pageTransport,
  randomIds,
  workerTransport,
} from '../../js/kernel/composition/messaging.js';
import { createChromeFake } from './chrome-fake.mjs';
import { settle } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/link.js').Connection} Connection */

/** A router that keeps the surface of each connection it accepts, and where it came */
function recording(/** @type {string} */ where) {
  /** @type {string[]} */
  const accepted = [];
  return {
    accepted,
    router: {
      /** @param {Connection} connection */
      accept: connection => accepted.push(`${where} ${connection.surface}`),
    },
  };
}

describe('transport selection (#13, "Topology")', () => {
  it("takes the runtime port from an extension page, and builds no router of the page's own", async () => {
    const fake = createChromeFake();
    const worker = recording('worker');
    fake.worker.install(chrome => installRuntimePort({ runtime: chrome.runtime, router: worker.router }));
    let built = 0;
    const transport = pageTransport({
      surface: 'popup',
      runtime: fake.page('popup').chrome.runtime,
      localRouter: () => {
        built += 1;
        return recording('page').router;
      },
    });
    transport.connect();
    await settle();
    assert.deepEqual([worker.accepted, built], [['worker popup'], 0]);
  });

  it('goes in-process to a router of its own where chrome.runtime has no id or no connect()', () => {
    const fake = createChromeFake();
    const gone = fake.page('newtab');
    gone.invalidate();
    /** @type {Array<[string, unknown]>} */
    const runtimes = [
      // js/storage.js installs this when it runs outside the extension
      ['the storage.js mock', { lastError: null, sendMessage: () => {} }],
      ['no chrome at all', undefined],
      ['an extension context that is gone', gone.chrome.runtime],
      ['an empty id', { id: '', connect: () => {} }],
    ];
    for (const [name, runtime] of runtimes) {
      assert.equal(canConnect(runtime), false, name);
      const page = recording('page');
      pageTransport({ surface: 'newtab', runtime, localRouter: () => page.router }).connect();
      assert.deepEqual(page.accepted, ['page newtab'], name);
    }
  });

  it("sends the worker's own requests in-process as worker-internal", () => {
    const worker = recording('worker');
    workerTransport(worker.router).connect();
    assert.deepEqual(worker.accepted, ['worker worker-internal']);
  });

  it("gives the host's timers and random ids", async () => {
    let ran = 0;
    hostTimers.set(() => (ran += 1), 0);
    hostTimers.clear(hostTimers.set(() => (ran += 10), 0));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(ran, 1);
    const [one, two] = [randomIds.next(), randomIds.next()];
    assert.match(one, /^[0-9a-f-]{36}$/);
    assert.notEqual(one, two);
  });
});
