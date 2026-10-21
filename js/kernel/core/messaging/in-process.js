/**
 * #13's in-process transport (#13, "Topology"): a client and the router in one context, as the
 * worker's own handlers reach it as `worker-internal`, and as tests and the PiP editor through
 * its opener do. Each message is the codec's text, as on a runtime port, and arrives on a later
 * microtask, so the router runs the same checks, schema and size included, and a caller can't
 * tell the transports apart.
 */

/** @typedef {import('./link.js').Link} Link */
/** @typedef {import('./link.js').CloseReason} CloseReason */
/** @typedef {import('./link.js').Transport} Transport */
/** @typedef {import('./link.js').Connection} Connection */
/** @typedef {import('../contracts/surfaces.js').Surface} Surface */

/**
 * Two linked ends. Once either end closes, neither can send, and what an end sent before it
 * closed still arrives, as on a port, unless the end it's for has closed. A listener that
 * throws doesn't stop the others, and `report` hears what it threw.
 * @param {{report?: (error: unknown) => void}} [options]
 * @returns {[Link, Link]}
 */
export function linkPair({ report = () => {} } = {}) {
  let open = true;
  /**
   * @template T
   * @param {Array<(value: T) => void>} listeners
   * @param {T} value
   */
  const tell = (listeners, value) => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        report(error);
      }
    }
  };
  /**
   * Each end's listeners, and whether it closed itself
   * @returns {{messages: Array<(text: string) => void>, closes: Array<(reason: CloseReason) => void>, closed: boolean}}
   */
  const listeners = () => ({ messages: [], closes: [], closed: false });
  const ends = [listeners(), listeners()];

  /**
   * @param {number} self
   * @returns {Link}
   */
  const end = self => {
    const mine = ends[self];
    const other = ends[1 - self];
    return {
      send(text) {
        if (!open) throw new Error('The link is closed');
        Promise.resolve().then(() => {
          if (!other.closed) tell(other.messages, text);
        });
      },
      onMessage(listener) {
        mine.messages.push(listener);
      },
      onClose(listener) {
        mine.closes.push(listener);
      },
      close() {
        if (!open) return;
        open = false;
        mine.closed = true;
        Promise.resolve().then(() => tell(other.closes, /** @type {CloseReason} */ ('closed')));
      },
    };
  };
  return [end(0), end(1)];
}

/**
 * A transport whose every connection reaches `router` in this context, as `surface`
 * @param {{router: {accept(connection: Connection): void}, surface: Surface, report?: (error: unknown) => void}} options
 * @returns {Transport}
 */
export function createInProcessTransport({ router, surface, report }) {
  return Object.freeze({
    connect() {
      const [near, far] = linkPair({ report });
      router.accept({ link: far, surface });
      return near;
    },
  });
}
