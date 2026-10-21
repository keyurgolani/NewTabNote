/**
 * The connection every transport gives the router and its clients (#13, "Topology"), so the
 * two never see which transport carries them: a runtime port, a MessagePort (slice 4), or the
 * in-process pair. A link carries text, which contracts/codec.js writes and reads, and says
 * when the other end has gone.
 */

/**
 * Why a link closed: `closed` when the other end went away or the link was closed, and
 * `unreachable` when the other end was never there, as when waking the worker fails
 * @typedef {'closed' | 'unreachable'} CloseReason
 */

/**
 * One end of a connection
 * @typedef {object} Link
 * @property {(text: string) => void} send - throws once the link has closed
 * @property {(listener: (text: string) => void) => void} onMessage
 * @property {(listener: (reason: CloseReason) => void) => void} onClose
 *   Called once, when the other end goes. Closing this end tells only the other one, as
 *   closing a port does.
 * @property {() => void} close
 */

/**
 * How a client reaches the router. connect() opens a link at once, and that link can close
 * before anything arrives, when the other end can't be reached.
 * @typedef {object} Transport
 * @property {() => Link} connect
 */

/**
 * A connection the router accepts: its end of the link, and the surface the transport
 * verified for the other end, from the sender a runtime port reports or from the composition
 * root that made an in-process transport
 * @typedef {object} Connection
 * @property {Link} link
 * @property {import('../contracts/surfaces.js').Surface} surface
 */

export {};
