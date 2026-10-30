// #13's runtime-port transport (adapters/messaging/runtime-port.js) on the Chrome fake: the
// principal it reads from a port's sender, deny by default (#13, AC4), and the link it makes
// of a port, which closes as unreachable when the worker couldn't be woken.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PORT_NAME,
  createRuntimePortTransport,
  installRuntimePort,
  principalOf,
} from '../../js/kernel/adapters/messaging/runtime-port.js';
import { EXTENSION_ID, createChromeFake } from './chrome-fake.mjs';
import { settle } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/link.js').Connection} Connection */

const OWN = `chrome-extension://${EXTENSION_ID}`;

/**
 * A fake whose worker installs the runtime port, with a router that keeps what it accepts
 * and echoes what arrives
 */
function installed() {
  const fake = createChromeFake();
  /** @type {Connection[]} */
  const accepted = [];
  const router = {
    /** @param {Connection} connection */
    accept(connection) {
      accepted.push(connection);
      connection.link.onMessage(text => connection.link.send(`echo ${text}`));
    },
  };
  fake.worker.install(chrome => installRuntimePort({ runtime: chrome.runtime, router }));
  return { fake, accepted };
}

describe('the runtime port: the principal (#13, "Outcomes and authorization")', () => {
  it("names each of this extension's pages by its path, whatever its query, hash, or tab", () => {
    /** @type {Array<[string, string]>} */
    const pages = [
      ['/newtab.html', 'newtab'],
      ['/popup.html', 'popup'],
      ['/sidepanel.html', 'sidepanel'],
      ['/offscreen.html', 'offscreen'],
      ['/recovery.html', 'recovery'],
      ['/newtab.html?note=n1#top', 'newtab'],
      ['/popup.html#quick', 'popup'],
    ];
    for (const [path, surface] of pages) {
      assert.equal(principalOf({ id: EXTENSION_ID, url: `${OWN}${path}`, origin: OWN }, EXTENSION_ID), surface, path);
    }
    // The popup opened as a tab is still the popup, and nothing reads the tab
    const tabbed = {
      id: EXTENSION_ID,
      url: `${OWN}/popup.html`,
      origin: OWN,
      get tab() {
        throw new Error('sender.tab was read');
      },
    };
    assert.equal(principalOf(tabbed, EXTENSION_ID), 'popup');
    // A sender without an origin, as an older Chrome reports one, still needs this extension's URL
    assert.equal(principalOf({ id: EXTENSION_ID, url: `${OWN}/sidepanel.html` }, EXTENSION_ID), 'sidepanel');
  });

  it("refuses every sender that isn't one of this extension's pages", () => {
    const other = 'ponmlkjihgfedcbaponmlkjihgfedcba';
    /** @type {Array<[string, unknown]>} */
    const senders = [
      [
        'a content script in a web page',
        { id: EXTENSION_ID, url: 'https://example.test/newtab.html', origin: 'https://example.test' },
      ],
      [
        'another extension',
        { id: other, url: `chrome-extension://${other}/newtab.html`, origin: `chrome-extension://${other}` },
      ],
      ["this extension's id with another's page", { id: EXTENSION_ID, url: `chrome-extension://${other}/newtab.html` }],
      ['a page with another origin', { id: EXTENSION_ID, url: `${OWN}/newtab.html`, origin: 'https://example.test' }],
      ['an origin that only starts like this one', { id: EXTENSION_ID, url: `${OWN}x/newtab.html` }],
      ['a page that is no surface', { id: EXTENSION_ID, url: `${OWN}/options.html`, origin: OWN }],
      ['the worker script', { id: EXTENSION_ID, url: `${OWN}/js/background.js`, origin: OWN }],
      [
        'a path that only starts like a page',
        { id: EXTENSION_ID, url: `${OWN}/newtab.html/../evil.html`, origin: OWN },
      ],
      ['no id', { url: `${OWN}/newtab.html`, origin: OWN }],
      ['no URL', { id: EXTENSION_ID, origin: OWN }],
      ['no sender', undefined],
      ['a sender that is no object', 'newtab'],
    ];
    for (const [name, sender] of senders) assert.equal(principalOf(sender, EXTENSION_ID), null, name);
    // Nor does any sender name a surface when this context has no extension id
    assert.equal(principalOf({ id: undefined, url: '/newtab.html' }, undefined), null);
  });
});

describe('the runtime port: the worker side', () => {
  it('hands the router each port a page opens by its name, with the surface its sender is', async () => {
    const { fake, accepted } = installed();
    for (const surface of /** @type {const} */ (['newtab', 'popup', 'sidepanel', 'offscreen'])) {
      fake.page(surface).chrome.runtime.connect({ name: PORT_NAME });
    }
    fake.page('popup', { tab: true }).chrome.runtime.connect({ name: PORT_NAME });
    await settle();
    assert.deepEqual(
      accepted.map(connection => connection.surface),
      ['newtab', 'popup', 'sidepanel', 'offscreen', 'popup'],
    );
  });

  it('disconnects a port from anything else, or by another name, unread', async () => {
    const { fake, accepted } = installed();
    /** @type {string[]} */
    const gone = [];
    const script = fake.contentScript('https://example.test/');
    script.chrome.runtime.connect({ name: PORT_NAME }).onDisconnect.addListener(() => gone.push('content script'));
    const options = fake.page({ path: 'options.html' });
    options.chrome.runtime.connect({ name: PORT_NAME }).onDisconnect.addListener(() => gone.push('options page'));
    // No one in this extension listens for another extension
    const other = fake.otherExtension('ponmlkjihgfedcbaponmlkjihgfedcba');
    other.chrome.runtime
      .connect(fake.id, { name: PORT_NAME })
      .onDisconnect.addListener(() => gone.push(`other extension: ${other.chrome.runtime.lastError?.message}`));
    const legacy = fake.page('newtab').chrome.runtime.connect({ name: 'something-else' });
    legacy.onDisconnect.addListener(() => gone.push('another name'));
    await settle();
    await settle();
    // Nothing else in the extension takes a port, so one by another name would wait for nothing
    assert.deepEqual(gone.sort(), [
      'another name',
      'content script',
      'options page',
      'other extension: Could not establish connection. Receiving end does not exist.',
    ]);
    assert.deepEqual(accepted, []);
    assert.throws(() => legacy.postMessage('closed'));
  });
});

describe('the runtime port: the page side', () => {
  it('carries text each way, and closes the other end when it closes', async () => {
    const { fake, accepted } = installed();
    const link = createRuntimePortTransport({ runtime: fake.page('newtab').chrome.runtime }).connect();
    /** @type {string[]} */
    const heard = [];
    link.onMessage(text => heard.push(text));
    link.send('{"frame":"hello"}');
    await settle();
    assert.deepEqual(heard, ['echo {"frame":"hello"}']);
    /** @type {string[]} */
    const closes = [];
    accepted[0].link.onClose(reason => closes.push(reason));
    link.close();
    assert.throws(() => link.send('late'), /closed/);
    await settle();
    assert.deepEqual(closes, ['closed']);
  });

  it('delivers what an end sent before it closed, then the close, and drops what was on its way to an end that closed, as the in-process transport does', async () => {
    const fake = createChromeFake();
    /** @type {Connection[]} */
    const accepted = [];
    fake.worker.install(chrome =>
      installRuntimePort({ runtime: chrome.runtime, router: { accept: connection => accepted.push(connection) } }),
    );
    const runtime = fake.page('newtab').chrome.runtime;
    const link = createRuntimePortTransport({ runtime }).connect();
    await settle();
    /** @type {string[]} */
    const heard = [];
    accepted[0].link.onMessage(text => heard.push(text));
    accepted[0].link.onClose(reason => heard.push(`close ${reason}`));
    link.send('the last command');
    link.close();
    await settle();
    assert.deepEqual(heard, ['the last command', 'close closed']);

    const again = createRuntimePortTransport({ runtime }).connect();
    await settle();
    /** @type {string[]} */
    const back = [];
    again.onMessage(text => back.push(text));
    accepted[1].link.send('on its way');
    again.close();
    await settle();
    assert.deepEqual(back, []);
  });

  it('closes as unreachable when the worker could not be woken, and as closed when it stops', async () => {
    const { fake } = installed();
    const runtime = fake.page('newtab').chrome.runtime;
    /** @type {string[]} */
    const closes = [];
    const live = createRuntimePortTransport({ runtime }).connect();
    live.onClose(reason => closes.push(`live ${reason}`));
    await settle();
    fake.worker.stop();
    fake.worker.wakeable = false;
    const dead = createRuntimePortTransport({ runtime }).connect();
    dead.onClose(reason => closes.push(`dead ${reason}`));
    await settle();
    await settle();
    assert.deepEqual(closes.sort(), ['dead unreachable', 'live closed']);
  });

  it('throws from connect() once the extension context is gone, as Chrome does', () => {
    const { fake } = installed();
    const page = fake.page('sidepanel');
    page.invalidate();
    assert.throws(
      () => createRuntimePortTransport({ runtime: page.chrome.runtime }).connect(),
      /Extension context invalidated/,
    );
  });

  it('keeps a listener that throws from stopping the others, and reports what it threw', async () => {
    const { fake } = installed();
    /** @type {unknown[]} */
    const reported = [];
    const link = createRuntimePortTransport({
      runtime: fake.page('newtab').chrome.runtime,
      report: error => reported.push(error),
    }).connect();
    /** @type {string[]} */
    const heard = [];
    link.onMessage(() => {
      throw new Error('a broken listener');
    });
    link.onMessage(text => heard.push(text));
    link.send('ping');
    await settle();
    assert.deepEqual([heard, reported.length], [['echo ping'], 1]);
  });
});
