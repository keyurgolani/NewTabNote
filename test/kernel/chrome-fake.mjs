// A Chrome-semantics fake of what #13's transports use (#13, "Test plan"), for node:test: the
// service worker and extension pages, chrome.runtime ports between them, and BroadcastChannel
// by origin. #28 (contract tests) reuses it. It keeps the behavior a transport depends on:
// - A page's connect() returns a port at once, and the worker starts for it, running its
//   top-level code again after each stop. A worker that can't start, or has no onConnect
//   listener, ends the port with the lastError Chrome sets, readable only in onDisconnect.
// - Messages are JSON, as Chrome serializes them, and arrive on a later microtask, in order.
// - disconnect() tells only the other end. A worker that stops disconnects every port it
//   held, and a page that closes every port it opened. A disconnected port throws on
//   postMessage, as Chrome's does.
// - A port's sender is what Chrome reports for its page: the extension's id, the page's URL
//   and origin, and a tab only where there is one, as for a popup opened as a tab. A content
//   script's sender carries the web page's URL and origin, and another extension's connect()
//   reaches only onConnectExternal.
// - A page whose extension was reloaded or updated under it has no runtime.id, and its
//   connect() throws "Extension context invalidated.".
// - BroadcastChannel delivers a structured clone to every other open channel of the same name
//   and origin, never to the one that posted, with the sender's origin on the event.
// Only the worker receives connections, since no page listens on onConnect
// (test/kernel/runtime-listeners.test.mjs holds that).

/** A made-up extension id, in the 32 letters a to p Chrome uses */
export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** The page each surface loads */
export const PAGE_FILES = Object.freeze({
  newtab: 'newtab.html',
  popup: 'popup.html',
  sidepanel: 'sidepanel.html',
  offscreen: 'offscreen.html',
  recovery: 'recovery.html',
});

/** What Chrome sets on a port whose connection couldn't be made */
export const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

/**
 * A chrome.events-like event
 * @template {unknown[]} A
 */
class FakeEvent {
  constructor() {
    /** @type {Array<(...args: A) => void>} */
    this.listeners = [];
  }

  /** @param {(...args: A) => void} listener */
  addListener(listener) {
    this.listeners.push(listener);
  }

  /** @param {(...args: A) => void} listener */
  removeListener(listener) {
    this.listeners = this.listeners.filter(other => other !== listener);
  }

  /** @param {(...args: A) => void} listener */
  hasListener(listener) {
    return this.listeners.includes(listener);
  }

  hasListeners() {
    return this.listeners.length > 0;
  }

  /** @param {A} args */
  dispatch(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

/**
 * What a port's receiving end reports of the context that opened it
 * @typedef {object} Sender
 * @property {string} [id]
 * @property {string} [url]
 * @property {string} [origin]
 * @property {{id: number, url?: string}} [tab]
 * @property {number} [frameId]
 * @property {string} [documentId]
 */

/**
 * One extension context: a page, the worker, a content script, or another extension's page
 * @typedef {object} Context
 * @property {Sender} sender - what a port it opens reports
 * @property {{runtime: any}} chrome - typed loosely, so it stands in for chrome.runtime
 * @property {new (name: string) => FakeBroadcastChannel} BroadcastChannel - on its origin
 * @property {Set<FakePort>} ports - the port ends it holds
 * @property {Set<FakeBroadcastChannel>} channels
 * @property {() => void} close - as the page closing, or the worker stopping
 * @property {() => void} invalidate - as its extension reloading or updating under it
 */

/** One end of a port */
class FakePort {
  /**
   * @param {string} name
   * @param {Sender | undefined} sender - the opener's, which only the receiving end has
   * @param {Context} owner
   */
  constructor(name, sender, owner) {
    this.name = name;
    if (sender) this.sender = sender;
    this.owner = owner;
    this.connected = true;
    /** @type {FakePort | null} */
    this.other = null;
    /** @type {FakeEvent<[unknown, FakePort]>} */
    this.onMessage = new FakeEvent();
    /** @type {FakeEvent<[FakePort]>} */
    this.onDisconnect = new FakeEvent();
    owner.ports.add(this);
  }

  /** @param {unknown} message */
  postMessage(message) {
    if (!this.connected) throw new Error('Attempting to use a disconnected port object');
    const json = JSON.stringify(message);
    if (json === undefined) throw new TypeError('Could not serialize message.');
    const copy = JSON.parse(json);
    // Read at delivery, since a message posted before the worker took the port waits for it
    Promise.resolve().then(() => {
      const target = this.other;
      if (target?.connected) target.onMessage.dispatch(copy, target);
    });
  }

  disconnect() {
    if (!this.connected) return;
    this.cut();
    const target = this.other;
    Promise.resolve().then(() => target?.lose());
  }

  /** This end stops, telling no one */
  cut() {
    this.connected = false;
    this.owner.ports.delete(this);
  }

  /**
   * The other end went: this end stops and its listeners hear it, with `lastError` set while
   * they run when the connection was never made
   * @param {string} [lastError]
   */
  lose(lastError) {
    if (!this.connected) return;
    this.cut();
    const { runtime } = this.owner.chrome;
    if (lastError) runtime.lastError = { message: lastError };
    try {
      this.onDisconnect.dispatch(this);
    } finally {
      delete runtime.lastError;
    }
  }
}

/** @typedef {{data: unknown, origin: string}} ChannelMessage */

class FakeBroadcastChannel {
  /**
   * @param {string} name
   * @param {Map<string, Set<FakeBroadcastChannel>>} bus
   * @param {Context} context
   * @param {string} origin
   */
  constructor(name, bus, context, origin) {
    this.name = name;
    this.origin = origin;
    this.closed = false;
    /** @type {((event: ChannelMessage) => void) | null} */
    this.onmessage = null;
    /** @type {Array<(event: ChannelMessage) => void>} */
    this.listeners = [];
    const key = `${origin} ${name}`;
    if (!bus.has(key)) bus.set(key, new Set());
    this.peers = /** @type {Set<FakeBroadcastChannel>} */ (bus.get(key));
    this.peers.add(this);
    this.context = context;
    context.channels.add(this);
  }

  /** @param {unknown} data */
  postMessage(data) {
    if (this.closed) throw new DOMException('BroadcastChannel is closed.', 'InvalidStateError');
    for (const peer of this.peers) {
      if (peer === this) continue;
      const copy = structuredClone(data);
      Promise.resolve().then(() => peer.deliver({ data: copy, origin: this.origin }));
    }
  }

  /** @param {ChannelMessage} event */
  deliver(event) {
    if (this.closed) return;
    this.onmessage?.(event);
    for (const listener of [...this.listeners]) listener(event);
  }

  /**
   * @param {string} type
   * @param {(event: ChannelMessage) => void} listener
   */
  addEventListener(type, listener) {
    if (type === 'message') this.listeners.push(listener);
  }

  /**
   * @param {string} type
   * @param {(event: ChannelMessage) => void} listener
   */
  removeEventListener(type, listener) {
    this.listeners = this.listeners.filter(other => other !== listener);
  }

  close() {
    this.closed = true;
    this.peers.delete(this);
    this.context.channels.delete(this);
  }
}

/**
 * @param {{id?: string}} [options]
 */
export function createChromeFake({ id = EXTENSION_ID } = {}) {
  const origin = `chrome-extension://${id}`;
  /** @type {Map<string, Set<FakeBroadcastChannel>>} */
  const bus = new Map();
  /** @type {((chrome: Context['chrome']) => void) | null} */
  let main = null;
  let wakeable = true;
  let starts = 0;
  /** @type {Context | null} */
  let worker = null;
  let documents = 0;
  let tabs = 0;

  /**
   * The worker, started if it isn't running. Its top-level code runs then, and a worker that
   * throws there doesn't start.
   * @returns {Context | null}
   */
  const running = () => {
    if (worker) return worker;
    if (!wakeable || !main) return null;
    const context = makeContext({ id, url: `${origin}/js/background.js`, origin }, origin);
    try {
      main(context.chrome);
    } catch {
      context.close();
      return null;
    }
    starts += 1;
    worker = context;
    return context;
  };

  /**
   * A port from `context` to this extension's worker: its onConnect for the extension's own
   * contexts, and its onConnectExternal for another extension's
   * @param {Context} context
   * @param {string} name
   * @param {string} to - the extension it connects to
   */
  const connect = (context, name, to) => {
    const opener = new FakePort(name, undefined, context);
    Promise.resolve().then(() => {
      if (!opener.connected) return;
      const receiving = to === id ? running() : null;
      const runtime = receiving?.chrome.runtime;
      const event = context.sender.id === id ? runtime?.onConnect : runtime?.onConnectExternal;
      if (!receiving || !event?.hasListeners()) {
        opener.lose(NO_RECEIVER);
        return;
      }
      const receiver = new FakePort(name, context.sender, receiving);
      opener.other = receiver;
      receiver.other = opener;
      event.dispatch(receiver);
    });
    return opener;
  };

  /**
   * @param {Sender} sender
   * @param {string} contextOrigin
   * @returns {Context}
   */
  function makeContext(sender, contextOrigin) {
    let valid = true;
    /** @type {Record<string, any>} */
    const runtime = {
      id: sender.id,
      onConnect: new FakeEvent(),
      onConnectExternal: new FakeEvent(),
      onMessageExternal: new FakeEvent(),
      getManifest: () => ({ manifest_version: 3, version: '2.0.0' }),
      /**
       * @param {unknown} [first] - the extension to connect to, or the connect info
       * @param {{name?: string}} [second]
       */
      connect(first, second) {
        if (!valid) throw new Error('Extension context invalidated.');
        const to = typeof first === 'string' ? first : /** @type {string} */ (sender.id);
        const info = /** @type {{name?: string} | undefined} */ (typeof first === 'string' ? second : first);
        return connect(context, info?.name ?? '', to);
      },
    };
    /** @type {Context} */
    const context = {
      sender,
      chrome: { runtime },
      BroadcastChannel: class extends FakeBroadcastChannel {
        /** @param {string} name */
        constructor(name) {
          super(name, bus, context, contextOrigin);
        }
      },
      ports: new Set(),
      channels: new Set(),
      close() {
        for (const port of [...context.ports]) {
          port.cut();
          const other = port.other;
          Promise.resolve().then(() => other?.lose());
        }
        for (const channel of [...context.channels]) channel.close();
        if (worker === context) worker = null;
      },
      invalidate() {
        valid = false;
        delete runtime.id;
        context.close();
      },
    };
    return context;
  }

  return {
    id,
    origin,
    worker: {
      /**
       * The worker's top-level code, which runs each time it starts
       * @param {(chrome: Context['chrome']) => void} code
       */
      install(code) {
        main = code;
      },
      /** @param {boolean} value - whether waking the worker succeeds */
      set wakeable(value) {
        wakeable = value;
      },
      get running() {
        return worker !== null;
      },
      /** How many times it has started */
      get starts() {
        return starts;
      },
      /** The running worker's context */
      get context() {
        return worker;
      },
      start: () => running() !== null,
      /** Chrome stopping the worker: its ports disconnect, and its memory goes */
      stop() {
        worker?.close();
        worker = null;
      },
    },
    /**
     * An extension page
     * @param {keyof typeof PAGE_FILES | {path: string}} which - a surface's page, or a path
     * @param {{tab?: boolean}} [options] - whether it's in a tab, as a popup opened as a tab is
     */
    page(which, { tab = which === 'newtab' } = {}) {
      const path = typeof which === 'string' ? PAGE_FILES[which] : which.path;
      documents += 1;
      const url = `${origin}/${path}`;
      /** @type {Sender} */
      const sender = { id, url, origin, frameId: 0, documentId: `document-${documents}` };
      if (tab) sender.tab = { id: (tabs += 1), url };
      return makeContext(sender, origin);
    },
    /**
     * A content script in a web page, whose ports reach the worker's onConnect with the web
     * page's URL and origin
     * @param {string} url
     */
    contentScript(url) {
      tabs += 1;
      const pageOrigin = new URL(url).origin;
      return makeContext({ id, url, origin: pageOrigin, tab: { id: tabs, url }, frameId: 0 }, pageOrigin);
    },
    /**
     * Another extension's page, whose connect() to this extension reaches only
     * onConnectExternal
     * @param {string} otherId
     */
    otherExtension(otherId) {
      const otherOrigin = `chrome-extension://${otherId}`;
      return makeContext(
        { id: otherId, url: `${otherOrigin}/page.html`, origin: otherOrigin, frameId: 0 },
        otherOrigin,
      );
    },
  };
}
