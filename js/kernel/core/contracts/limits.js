/**
 * The fixed limits of #13's message contracts ("Cancellation, deadlines, payloads", "Stream").
 * The catalog and the codec read them, and #13's later slices build the router, client, and
 * streams on them. Nothing here imports Valibot, so the catalog can read it without loading a
 * schema.
 */

/**
 * The protocol a handshake names. The major version must match exactly, and minors only add,
 * so an operation a minor added is unknown to an older peer.
 */
export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });

/**
 * The most any one message may encode to, in bytes: 1 MiB. Journaled operations declare exactly
 * this, and so does any operation whose request carries content or a list as long as the user
 * makes it.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** The most a request of ids, flags, and codes may encode to, envelope included: 16 KiB */
export const SMALL_MESSAGE_BYTES = 16 * 1024;

/**
 * How long a command has from when it's sent to its answer. The coordinator enforces it, and no
 * client gives up sooner. #35 (background coordinator) can tune it once it queues commands.
 */
export const COMMAND_DEADLINE_MS = 30_000;

/** How long a query has from when it's sent to its answer */
export const QUERY_DEADLINE_MS = 15_000;

/**
 * How long startup maintenance has: the time its integrity check took to read every note, which
 * it kept when the check went with #17 PR 4a
 */
export const MAINTENANCE_DEADLINE_MS = 120_000;

/**
 * How long past a request's deadline a client waits for its answer before it gives up. The
 * router answers at the deadline itself, so this only covers the answer's way back, and no
 * client timeout is shorter than the deadline.
 */
export const DEADLINE_GRACE_MS = 1000;

/**
 * How long a user-visible request waits with no welcomed connection before its surface shows
 * Reconnecting, so a worker that starts cold never flashes it
 */
export const RECONNECTING_AFTER_MS = 2000;

/**
 * The waits before each reconnect once an attempt fails. When the attempt after the last of
 * them fails too, the coordinator is unavailable.
 */
export const RECONNECT_DELAYS_MS = Object.freeze(/** @type {const} */ ([500, 1000, 2000]));

/**
 * How long a client waits for an in-process read of the idempotency ledger (#17) before it
 * gives up on it: the command's outcome stays unknown, and nothing is sent again
 */
export const LEDGER_READ_TIMEOUT_MS = 5000;

/** How long a client waits for the welcome before it counts the attempt failed */
export const HANDSHAKE_TIMEOUT_MS = 5000;

/** The most one stream chunk may encode to, in bytes: 256 KiB */
export const MAX_CHUNK_BYTES = 256 * 1024;

/** How many chunks a stream's receiver grants at a time */
export const STREAM_CREDIT = 16;

/** How deep a message may nest objects and arrays, so a hostile one can't exhaust the stack */
export const MAX_DEPTH = 64;

/**
 * The upper bounds of the latency buckets system.messagingHealth counts answers in, in
 * milliseconds. An answer slower than the last falls in the bucket past it.
 */
export const LATENCY_BUCKETS_MS = Object.freeze(/** @type {const} */ ([10, 50, 100, 500, 1000, 5000]));
