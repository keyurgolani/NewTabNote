// #13's status region (adapters/messaging/status-region.js): one polite region that
// announces Reconnecting, Coordinator unavailable, and Unsupported protocol version once
// each, and the resolution after one, never connecting or an idle stop, and never moves
// focus (#13, "Accessibility and performance" and AC3). It runs on a small DOM fake that
// records each change to the region's text.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { STATUS_TEXT, mountStatusRegion } from '../../js/kernel/adapters/messaging/status-region.js';
import { RECONNECT_DELAYS_MS } from '../../js/kernel/core/contracts/limits.js';
import { createClient } from '../../js/kernel/core/messaging/client.js';
import { VERSION, lookup, scriptedCoordinator, settle, testScheduler } from './messaging-support.mjs';
import { testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/client.js').ConnectionState} ConnectionState */

/** An element of the DOM fake: attributes, children, text it records, listeners, and focus */
class FakeNode {
  /**
   * @param {FakeDom} document
   * @param {string} tag
   */
  constructor(document, tag) {
    this.document = document;
    this.tagName = tag.toUpperCase();
    /** @type {FakeNode[]} */
    this.children = [];
    /** @type {FakeNode | null} */
    this.parentNode = null;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {Map<string, Array<() => void>>} */
    this.listeners = new Map();
    this.hidden = false;
    this.type = '';
    this.className = '';
    this.text = '';
    /** @type {string[]} every text it was given */
    this.writes = [];
  }

  get textContent() {
    return this.text;
  }

  set textContent(value) {
    this.text = String(value);
    this.writes.push(this.text);
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** @param {FakeNode} child */
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  /** @param {string} type @param {() => void} listener */
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** @param {string} type */
  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  click() {
    this.dispatch('click');
  }

  focus() {
    const was = this.document.activeElement;
    if (was === this) return;
    this.document.activeElement = this;
    was.dispatch('blur');
  }

  blur() {
    if (this.document.activeElement !== this) return;
    this.document.activeElement = this.document.body;
    this.dispatch('blur');
  }
}

class FakeDom {
  constructor() {
    this.body = new FakeNode(this, 'body');
    this.activeElement = this.body;
  }

  /** @param {string} tag */
  createElement(tag) {
    return new FakeNode(this, tag);
  }
}

/** A client that goes through the states the test gives it */
function fakeClient(/** @type {ConnectionState} */ initial = 'idle') {
  let state = initial;
  let reloadable = true;
  let retries = 0;
  /** @type {Set<(state: ConnectionState) => void>} */
  const listeners = new Set();
  return {
    state: () => state,
    /** @param {(state: ConnectionState) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      retries += 1;
    },
    canReload: () => reloadable,
    /** @param {ConnectionState} next */
    emit(next) {
      state = next;
      for (const listener of [...listeners]) listener(next);
    },
    get retries() {
      return retries;
    },
    /** @param {boolean} value */
    set reloadable(value) {
      reloadable = value;
    },
  };
}

/**
 * The region mounted on a fresh DOM, with its parts
 * @param {ReturnType<typeof fakeClient>} client
 * @param {{reload?: () => void}} [options]
 */
function mounted(client, options = {}) {
  const dom = new FakeDom();
  const region = mountStatusRegion({
    document: /** @type {any} */ (dom),
    parent: /** @type {any} */ (dom.body),
    client,
    ...options,
  });
  const [root] = dom.body.children;
  const [message, retry, reload] = root.children;
  return { dom, region, root, message, retry, reload };
}

describe('the status region (#13, "Accessibility and performance")', () => {
  it('mounts empty and polite, and announces nothing for connecting or an idle stop', () => {
    const client = fakeClient();
    const { message, retry, reload } = mounted(client);
    assert.deepEqual(
      ['role', 'aria-live', 'aria-atomic'].map(name => message.getAttribute(name)),
      ['status', 'polite', 'true'],
    );
    for (const state of /** @type {ConnectionState[]} */ ([
      'connecting',
      'connected',
      'idle',
      'connecting',
      'connected',
    ])) {
      client.emit(state);
    }
    assert.deepEqual([message.writes, retry.hidden, reload.hidden], [[], true, true]);
  });

  it('announces Reconnecting, Coordinator unavailable, and the resolution after them, each once', () => {
    const client = fakeClient();
    const { message } = mounted(client);
    for (const state of /** @type {ConnectionState[]} */ ([
      'connecting',
      'reconnecting',
      'reconnecting',
      'unavailable',
      'reconnecting',
      'connected',
      'idle',
      'connecting',
      'connected',
    ])) {
      client.emit(state);
    }
    // The resolution clears, silently, once the connection goes idle, so the next problem is heard
    assert.deepEqual(message.writes, [
      STATUS_TEXT.reconnecting,
      STATUS_TEXT.unavailable,
      STATUS_TEXT.reconnecting,
      STATUS_TEXT.resolved,
      '',
    ]);
  });

  it('offers Retry while unavailable, keeps focus on it through the retry, and lets it go once focus leaves', () => {
    const client = fakeClient();
    const { dom, retry } = mounted(client);
    client.emit('unavailable');
    assert.equal(retry.hidden, false);
    retry.focus();
    retry.click();
    assert.equal(client.retries, 1);
    client.emit('reconnecting');
    // Withdrawn but still focused, so it stays, disabled, and a click does nothing
    assert.deepEqual([retry.hidden, retry.getAttribute('aria-disabled'), dom.activeElement], [false, 'true', retry]);
    retry.click();
    assert.equal(client.retries, 1);
    client.emit('unavailable');
    assert.deepEqual([retry.hidden, retry.getAttribute('aria-disabled')], [false, null]);
    client.emit('reconnecting');
    client.emit('connected');
    assert.equal(retry.hidden, false);
    retry.blur();
    assert.equal(retry.hidden, true);
    // Without focus, it goes as soon as it's withdrawn
    client.emit('unavailable');
    client.emit('reconnecting');
    assert.equal(retry.hidden, true);
  });

  it('offers Reload on an unsupported protocol only while reloading loses nothing, checking again on click', () => {
    const client = fakeClient();
    /** @type {string[]} */
    const reloads = [];
    const { region, message, reload } = mounted(client, { reload: () => reloads.push('reload') });
    client.reloadable = false;
    client.emit('unsupported');
    assert.deepEqual([message.text, reload.hidden], [STATUS_TEXT.unsupported, true]);
    // Once the composition ends or the commit lands, the page asks again, which says nothing new
    client.reloadable = true;
    region.refresh();
    assert.deepEqual([reload.hidden, message.writes], [false, [STATUS_TEXT.unsupported]]);
    client.reloadable = false;
    reload.click();
    client.reloadable = true;
    reload.click();
    assert.deepEqual(reloads, ['reload']);
  });

  it('never moves focus, whatever it announces', () => {
    const client = fakeClient();
    const { dom } = mounted(client);
    const editor = dom.createElement('div');
    editor.focus();
    for (const state of /** @type {ConnectionState[]} */ ([
      'reconnecting',
      'unavailable',
      'unsupported',
      'connected',
    ])) {
      client.emit(state);
      assert.equal(dom.activeElement, editor, state);
    }
  });

  it("speaks other features' words through announce(), and the next connection problem after them", () => {
    const client = fakeClient();
    const { region, message } = mounted(client);
    region.announce('Responding');
    client.emit('connecting');
    client.emit('reconnecting');
    // A state already announced isn't announced again over what came after it
    region.announce('Response ready');
    region.refresh();
    assert.deepEqual(message.writes, ['Responding', STATUS_TEXT.reconnecting, 'Response ready']);
  });

  it('stops listening and leaves the page when destroyed', () => {
    const client = fakeClient();
    const { dom, region, message } = mounted(client);
    region.destroy();
    client.emit('reconnecting');
    assert.deepEqual([dom.body.children, message.writes], [[], []]);
  });

  it("announces what #13's client goes through when the worker can't be woken, then the resolution", async () => {
    const scheduler = testScheduler();
    const coordinator = scriptedCoordinator();
    coordinator.reach = 'unreachable';
    const client = createClient({
      transport: coordinator.transport,
      surface: 'newtab',
      extensionVersion: VERSION,
      lookup,
      ids: testIds('client'),
      ...scheduler,
    });
    const dom = new FakeDom();
    mountStatusRegion({ document: /** @type {any} */ (dom), parent: /** @type {any} */ (dom.body), client });
    const [message, retry] = dom.body.children[0].children;
    void client.query({ type: 'getNote', noteId: 'n1' });
    await scheduler.advance(RECONNECT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0));
    assert.deepEqual([message.writes, retry.hidden], [[STATUS_TEXT.reconnecting, STATUS_TEXT.unavailable], false]);
    coordinator.reach = 'open';
    retry.click();
    await settle();
    coordinator.last.welcome();
    await settle();
    assert.deepEqual(message.writes, [
      STATUS_TEXT.reconnecting,
      STATUS_TEXT.unavailable,
      STATUS_TEXT.reconnecting,
      STATUS_TEXT.resolved,
    ]);
  });
});
