/**
 * #13's runtime-port transport (#13, "Topology" and "Outcomes and authorization"): Chrome's
 * chrome.runtime ports between extension pages and the worker. A page opens one port, named
 * `ntn-rpc`, when its client first has something to send, and the worker hands each such
 * port to the router with the surface its sender is. The sender is the principal: this
 * extension's id, its own origin, and the page's path, never `sender.tab`, since the popup can
 * open as a tab. A content script, a web page, a path that's no surface's, or anything else
 * gets its port disconnected unread, and nothing here listens for another extension at all.
 *
 * A port carries the codec's text (contracts/codec.js), which Chrome serializes as JSON again,
 * so a message means the same here as in-process.
 */

/** @typedef {import('../../core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../../core/messaging/link.js').CloseReason} CloseReason */
/** @typedef {import('../../core/messaging/link.js').Connection} Connection */
/** @typedef {import('../../core/messaging/link.js').Link} Link */
/** @typedef {import('../../core/messaging/link.js').Transport} Transport */

/**
 * What these take of chrome.runtime
 * @typedef {Pick<typeof chrome.runtime, 'id' | 'connect' | 'onConnect' | 'lastError'>} Runtime
 */

/** The one port name the router answers on */
export const PORT_NAME = 'ntn-rpc';

/**
 * The surface each page is, by its path under the extension's own origin
 * @type {Readonly<Record<string, Surface>>}
 */
const PAGES = Object.freeze({
  '/newtab.html': 'newtab',
  '/popup.html': 'popup',
  '/sidepanel.html': 'sidepanel',
  '/offscreen.html': 'offscreen',
  '/recovery.html': 'recovery',
});

/**
 * The surface a port's sender is, or null for any sender that isn't one of this extension's
 * own pages. Only the id, the URL, and the origin are read.
 * @param {unknown} sender - a chrome.runtime.MessageSender
 * @param {string | undefined} extensionId - chrome.runtime.id
 * @returns {Surface | null}
 */
export function principalOf(sender, extensionId) {
  if (typeof extensionId !== 'string' || extensionId === '') return null;
  if (sender === null || typeof sender !== 'object') return null;
  const { id, url, origin } = /** @type {{id?: unknown, url?: unknown, origin?: unknown}} */ (sender);
  const own = `chrome-extension://${extensionId}`;
  if (id !== extensionId) return null;
  // Chrome reports a page's origin, and it has to be this extension's own
  if (origin !== undefined && origin !== own) return null;
  if (typeof url !== 'string' || !url.startsWith(`${own}/`)) return null;
  const [path] = url.slice(own.length).split(/[?#]/, 1);
  return Object.hasOwn(PAGES, path) ? PAGES[path] : null;
}

/**
 * A link over a port. A port that ends with chrome.runtime.lastError set never connected, as
 * when waking the worker failed, so its link closes as unreachable.
 * @param {chrome.runtime.Port} port
 * @param {Runtime} runtime
 * @param {(error: unknown) => void} report - hears what a listener threw
 * @returns {Link}
 */
function portLink(port, runtime, report) {
  let open = true;
  /** @type {Array<(reason: CloseReason) => void>} */
  const closes = [];
  port.onDisconnect.addListener(() => {
    // Reading lastError here also keeps Chrome from logging it as unchecked
    /** @type {CloseReason} */
    const reason = runtime.lastError ? 'unreachable' : 'closed';
    open = false;
    for (const listener of closes) {
      try {
        listener(reason);
      } catch (error) {
        report(error);
      }
    }
  });
  return {
    send(text) {
      if (!open) throw new Error('The link is closed');
      port.postMessage(text);
    },
    onMessage(listener) {
      port.onMessage.addListener(message => {
        if (typeof message !== 'string') return;
        try {
          listener(message);
        } catch (error) {
          report(error);
        }
      });
    },
    onClose(listener) {
      closes.push(listener);
    },
    close() {
      if (!open) return;
      open = false;
      port.disconnect();
    },
  };
}

/**
 * Hands the router every port one of this extension's pages opens by PORT_NAME. The worker
 * calls it at its top level, synchronously, so the listener is there before Chrome dispatches
 * the connection that woke the worker. A port from anything else is disconnected unread, and
 * a port by another name is left alone.
 * @param {{runtime: Runtime, router: {accept(connection: Connection): void}, report?: (error: unknown) => void}} options
 */
export function installRuntimePort({ runtime, router, report = () => {} }) {
  runtime.onConnect.addListener(port => {
    if (port.name !== PORT_NAME) return;
    const surface = principalOf(port.sender, runtime.id);
    if (surface === null) {
      port.disconnect();
      return;
    }
    router.accept({ link: portLink(port, runtime, report), surface });
  });
}

/**
 * A page's transport to the worker's router, which opens a port by PORT_NAME for each
 * connection. connect() throws when Chrome can't open one at all, as once the extension
 * context is gone, which the client counts as a worker it couldn't wake.
 * @param {{runtime: Runtime, report?: (error: unknown) => void}} options
 * @returns {Transport}
 */
export function createRuntimePortTransport({ runtime, report = () => {} }) {
  return Object.freeze({
    connect: () => portLink(runtime.connect({ name: PORT_NAME }), runtime, report),
  });
}
