'use strict';

/**
 * chrome.runtime ports for test/helpers/legacy-env.js (#35 slice 4b-2). connectPage(chrome, page)
 * gives the chrome.* stub a page shares with the worker the runtime.connect() an extension page's
 * chrome.runtime has, for `page`'s document. Its port reaches each runtime.onConnect listener on
 * the stub. In a worker test/helpers/load-background.js started, that's the one js/background.js
 * adds through installWorkerRouter (adapters/messaging/runtime-port.js), so the page's messages
 * reach the worker's own router. The listener gets the page's sender as Chrome reports it: the
 * extension's id, the page's URL and its origin. As Chrome's ports do:
 * - A message goes as JSON, on a later turn, after what the port sent before it.
 * - disconnect() tells only the other end, after what the port posted before it. A port that
 *   disconnected itself hears nothing more, and throws on postMessage.
 * - A connect with no listener ends the port with the lastError Chrome sets, readable only in
 *   onDisconnect.
 * test/kernel/chrome-fake.mjs holds the same rules for the kernel tests' own fake.
 */

/** What Chrome sets on a port whose connection couldn't be made */
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

/** A chrome.events-like event */
function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    hasListener(listener) { return listeners.includes(listener); },
    dispatch(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

/** One end of a port, on `runtime`, the stub's, whose lastError its disconnect sets */
class Port {
  constructor(name, sender, runtime) {
    this.name = name;
    if (sender) this.sender = sender;
    this.runtime = runtime;
    this.connected = true;
    this.other = null;
    this.onMessage = createEvent();
    this.onDisconnect = createEvent();
  }

  postMessage(message) {
    if (!this.connected) throw new Error('Attempting to use a disconnected port object');
    const json = JSON.stringify(message);
    if (json === undefined) throw new TypeError('Could not serialize message.');
    const copy = JSON.parse(json);
    // Read at delivery, since a message the page sent before the worker took the port waits for it
    setImmediate(() => {
      const target = this.other;
      if (target && target.connected) target.onMessage.dispatch(copy, target);
    });
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    const target = this.other;
    setImmediate(() => target && target.lose());
  }

  /** The other end went: this end stops, and its listeners hear it, with `lastError` set while they run when it never connected */
  lose(lastError) {
    if (!this.connected) return;
    this.connected = false;
    if (lastError) this.runtime.lastError = { message: lastError };
    try {
      this.onDisconnect.dispatch(this);
    } finally {
      if (lastError) this.runtime.lastError = undefined;
    }
  }
}

/**
 * Gives `chrome`'s runtime a connect() for `page`, an extension page by its path, and answers
 * how to close that page's ports, as the page closing does
 * @param {{api: {runtime: any}}} chrome - legacy-env's chrome.* stub, the worker's and the page's
 * @param {string} [page]
 * @returns {{close: () => void}}
 */
function connectPage(chrome, page = 'popup.html') {
  const { runtime } = chrome.api;
  const origin = `chrome-extension://${runtime.id}`;
  const sender = Object.freeze({ id: runtime.id, url: `${origin}/${page}`, origin, frameId: 0 });
  const opened = [];
  runtime.connect = (first, second) => {
    const info = typeof first === 'string' ? second : first;
    const name = (info && info.name) || '';
    const opener = new Port(name, undefined, runtime);
    opened.push(opener);
    setImmediate(() => {
      if (!opener.connected) return;
      if (runtime.onConnect.listeners.length === 0) {
        opener.lose(NO_RECEIVER);
        return;
      }
      const receiver = new Port(name, sender, runtime);
      opener.other = receiver;
      receiver.other = opener;
      for (const listener of [...runtime.onConnect.listeners]) listener(receiver);
    });
    return opener;
  };
  return {
    close() {
      for (const port of opened) port.disconnect();
    },
  };
}

module.exports = { connectPage, NO_RECEIVER };
