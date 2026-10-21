// The Chrome-semantics fake (chrome-fake.mjs), held to the Chrome behavior #13's transports
// depend on, so a test that passes on it says something about Chrome (#13, "Test plan")

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NO_RECEIVER, createChromeFake } from './chrome-fake.mjs';
import { settle } from './messaging-support.mjs';

/**
 * A fake whose worker keeps each port it's handed and what arrives on it
 * @param {{echo?: boolean}} [options]
 */
function withWorker({ echo = false } = {}) {
  const fake = createChromeFake();
  /** @type {any[]} */
  const ports = [];
  /** @type {unknown[]} */
  const heard = [];
  fake.worker.install(chrome => {
    chrome.runtime.onConnect.addListener((/** @type {any} */ port) => {
      ports.push(port);
      port.onMessage.addListener((/** @type {unknown} */ message) => {
        heard.push(message);
        if (echo) port.postMessage({ echo: message });
      });
    });
  });
  return { fake, ports, heard };
}

describe('the Chrome fake (#13, "Test plan")', () => {
  it('starts the worker for a connect, and carries JSON both ways, in order, on later microtasks', async () => {
    const { fake, ports, heard } = withWorker({ echo: true });
    const page = fake.page('newtab');
    const port = page.chrome.runtime.connect({ name: 'ntn-rpc' });
    /** @type {unknown[]} */
    const back = [];
    port.onMessage.addListener((/** @type {unknown} */ message) => back.push(message));
    port.postMessage({ at: new Date(0), gone: undefined, text: 'one' });
    port.postMessage('two');
    assert.deepEqual([ports.length, heard, back], [0, [], []]);
    await settle();
    // JSON, as Chrome serializes a message: a Date arrives as its string, undefined not at all
    const one = { at: '1970-01-01T00:00:00.000Z', text: 'one' };
    assert.deepEqual(heard, [one, 'two']);
    assert.deepEqual(back, [{ echo: one }, { echo: 'two' }]);
    assert.deepEqual(
      [ports[0].name, ports[0].sender.url, fake.worker.starts],
      ['ntn-rpc', `${fake.origin}/newtab.html`, 1],
    );
    assert.throws(() => port.postMessage(() => {}), TypeError);
  });

  it('tells only the other end of a disconnect, and refuses a message on a disconnected port', async () => {
    const { fake, ports } = withWorker();
    const port = fake.page('popup').chrome.runtime.connect({ name: 'ntn-rpc' });
    await settle();
    /** @type {string[]} */
    const gone = [];
    port.onDisconnect.addListener(() => gone.push('page'));
    ports[0].onDisconnect.addListener(() => gone.push('worker'));
    port.disconnect();
    assert.throws(() => port.postMessage('late'), /Attempting to use a disconnected port object/);
    await settle();
    assert.deepEqual(gone, ['worker']);
    assert.throws(() => ports[0].postMessage('late'), /Attempting to use a disconnected port object/);
  });

  it('delivers what a port posted before it disconnected, then the disconnect, and drops what was on its way to a port that disconnected itself', async () => {
    const { fake, ports, heard } = withWorker();
    const page = fake.page('newtab');
    const port = page.chrome.runtime.connect({ name: 'ntn-rpc' });
    await settle();
    ports[0].onDisconnect.addListener(() => heard.push('disconnect'));
    // As a page's last journaled command goes on pagehide, just before its port closes
    port.postMessage('the last command');
    port.disconnect();
    await settle();
    assert.deepEqual(heard, ['the last command', 'disconnect']);

    const again = page.chrome.runtime.connect({ name: 'ntn-rpc' });
    await settle();
    /** @type {unknown[]} */
    const back = [];
    again.onMessage.addListener((/** @type {unknown} */ message) => back.push(message));
    ports[1].postMessage('on its way');
    again.disconnect();
    await settle();
    assert.deepEqual(back, []);
  });

  it('disconnects every port when the worker stops, with no lastError, and runs its top-level code again on the next connect', async () => {
    const { fake } = withWorker();
    const page = fake.page('sidepanel');
    const port = page.chrome.runtime.connect({ name: 'ntn-rpc' });
    await settle();
    /** @type {unknown[]} */
    const errors = [];
    port.onDisconnect.addListener(() => errors.push(page.chrome.runtime.lastError));
    fake.worker.stop();
    await settle();
    assert.deepEqual([errors, fake.worker.running], [[undefined], false]);
    page.chrome.runtime.connect({ name: 'ntn-rpc' });
    await settle();
    assert.deepEqual([fake.worker.running, fake.worker.starts], [true, 2]);
  });

  it("ends a port with Chrome's lastError when no worker takes it, readable only while onDisconnect runs", async () => {
    /** @type {Array<[string, (fake: ReturnType<typeof createChromeFake>) => void, boolean]>} */
    const cases = [
      [
        "a worker that can't be woken",
        fake => {
          fake.worker.wakeable = false;
        },
        false,
      ],
      // It starts, as a worker with no listener for the event does, but nothing takes the port
      ['a worker with no onConnect listener', fake => fake.worker.install(() => {}), true],
      [
        'a worker that throws as it starts',
        fake =>
          fake.worker.install(() => {
            throw new Error('broken worker');
          }),
        false,
      ],
    ];
    for (const [name, arrange, starts] of cases) {
      const { fake } = withWorker();
      arrange(fake);
      const page = fake.page('newtab');
      const port = page.chrome.runtime.connect({ name: 'ntn-rpc' });
      /** @type {unknown[]} */
      const errors = [];
      port.onDisconnect.addListener(() => errors.push(page.chrome.runtime.lastError?.message));
      await settle();
      assert.deepEqual(errors, [NO_RECEIVER], name);
      assert.equal(page.chrome.runtime.lastError, undefined, name);
      assert.equal(fake.worker.running, starts, name);
      assert.throws(() => port.postMessage('late'), /disconnected port/, name);
    }
  });

  it("reports each sender as Chrome does: the page's URL and origin, and a tab only where there is one", async () => {
    const { fake, ports } = withWorker();
    const contexts = [
      fake.page('newtab'),
      fake.page('popup'),
      fake.page('popup', { tab: true }),
      fake.page('sidepanel'),
      fake.page('offscreen'),
      fake.contentScript('https://example.test/page?q=1'),
    ];
    for (const context of contexts) context.chrome.runtime.connect({ name: 'ntn-rpc' });
    await settle();
    assert.deepEqual(
      ports.map(port => [port.sender.id, port.sender.url, port.sender.origin, Boolean(port.sender.tab)]),
      [
        [fake.id, `${fake.origin}/newtab.html`, fake.origin, true],
        [fake.id, `${fake.origin}/popup.html`, fake.origin, false],
        [fake.id, `${fake.origin}/popup.html`, fake.origin, true],
        [fake.id, `${fake.origin}/sidepanel.html`, fake.origin, false],
        [fake.id, `${fake.origin}/offscreen.html`, fake.origin, false],
        [fake.id, 'https://example.test/page?q=1', 'https://example.test', true],
      ],
    );
  });

  it('lets another extension reach only onConnectExternal', async () => {
    const { fake, ports } = withWorker();
    const other = fake.otherExtension('ponmlkjihgfedcbaponmlkjihgfedcba');
    const port = other.chrome.runtime.connect(fake.id, { name: 'ntn-rpc' });
    /** @type {unknown[]} */
    const errors = [];
    port.onDisconnect.addListener(() => errors.push(other.chrome.runtime.lastError?.message));
    await settle();
    assert.deepEqual([errors, ports.length], [[NO_RECEIVER], 0]);
    // Had the worker listened there, the sender would be the other extension
    /** @type {any[]} */
    const external = [];
    fake.worker.context?.chrome.runtime.onConnectExternal.addListener((/** @type {any} */ p) => external.push(p));
    other.chrome.runtime.connect(fake.id, { name: 'ntn-rpc' });
    await settle();
    assert.deepEqual(
      [external.length, external[0]?.sender.id, ports.length],
      [1, 'ponmlkjihgfedcbaponmlkjihgfedcba', 0],
    );
  });

  it('leaves a page whose extension reloaded under it with no runtime.id, and a connect() that throws', async () => {
    const { fake, ports } = withWorker();
    const page = fake.page('newtab');
    page.chrome.runtime.connect({ name: 'ntn-rpc' });
    await settle();
    /** @type {string[]} */
    const gone = [];
    ports[0].onDisconnect.addListener(() => gone.push('worker heard'));
    page.invalidate();
    await settle();
    assert.deepEqual([page.chrome.runtime.id, gone], [undefined, ['worker heard']]);
    assert.throws(() => page.chrome.runtime.connect({ name: 'ntn-rpc' }), /Extension context invalidated/);
  });

  it('delivers a BroadcastChannel message to every other channel of its name and origin, as a copy', async () => {
    const fake = createChromeFake();
    const first = fake.page('newtab');
    const second = fake.page('sidepanel');
    const web = fake.contentScript('https://example.test/');
    /** @type {Array<[string, unknown, string]>} */
    const heard = [];
    const listen = (/** @type {string} */ who, /** @type {any} */ channel) =>
      channel.addEventListener('message', (/** @type {{data: unknown, origin: string}} */ event) =>
        heard.push([who, event.data, event.origin]),
      );
    const sender = new first.BroadcastChannel('ntn-hints');
    listen('sender', sender);
    listen('same page, other name', new first.BroadcastChannel('other'));
    listen('second page', new second.BroadcastChannel('ntn-hints'));
    listen('web page', new web.BroadcastChannel('ntn-hints'));
    const sent = { ids: ['n1'] };
    sender.postMessage(sent);
    sent.ids.push('changed after');
    await settle();
    assert.deepEqual(heard, [['second page', { ids: ['n1'] }, fake.origin]]);
    sender.close();
    assert.throws(() => sender.postMessage('late'), { name: 'InvalidStateError' });
  });
});
