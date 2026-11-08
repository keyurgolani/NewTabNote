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
 * The most an answer, or a query's request, may encode to, in bytes: 1 MiB. A command the catalog
 * doesn't size small declares COMMAND_CEILING_BYTES instead (#259).
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * The most a command the catalog doesn't size small may come to as a runtime port sends it, the
 * codec's text once Chrome encodes it as JSON again (codec.js, wireBytes), in bytes: 32 MiB,
 * half the largest frame Chrome 156.0.8078.4's port carried in #259's measure, 67,108,864 bytes, so a
 * later Chrome that carries less still takes every frame this sends (#259, the lead's O3). Journaled
 * commands declare exactly this, and so does any command whose request carries content or a list as
 * long as the user makes it.
 */
export const COMMAND_CEILING_BYTES = 32 * 1024 * 1024;

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
 * How long one turn on the coordinator's queue may run, from the turn's start, not its request's,
 * before the queue cuts it and starts the next (#35 slice 4b-1): four command deadlines. The
 * integrity check, the longest thing the worker runs, is off the queue. A caller with a client
 * deadline has had its answer from that client for at least 89 s by then, since a client gives up
 * 31 s after it sends, and a turn starts no earlier than its send. One that sends with none, as the
 * journal drain's replays and js/background.js's rerun of a capture with no entry do, gets its
 * answer from the cut.
 */
export const TURN_LIMIT_MS = 120_000;

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

/**
 * The longest the router holds a hello's welcome while the coordinator's start is still
 * running (#35), so a worker that starts cold can welcome its first page as ready. A start
 * that takes longer gets its welcome at the cap, saying what the coordinator says then:
 * `starting`, or `migrating` while its run upgrades the database. It's half of
 * RECONNECTING_AFTER_MS, so the hold alone never shows Reconnecting, and a fifth of
 * HANDSHAKE_TIMEOUT_MS, so no client counts a held hello as a failed attempt.
 */
export const WELCOME_WAIT_MS = 1000;

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
