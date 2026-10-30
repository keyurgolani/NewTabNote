/**
 * #13's catch-up (#13, "Idempotency and catch-up"): how a page's projection stays current
 * across hints it missed, a worker that restarted, and its own reload, without reading
 * ephemeral events as the record (portfolio finding F10). Hints only say something changed,
 * and the commit log (ports/commit-log.js) says what, from the page's cursor:
 *
 * 1. It subscribes to hints first, so nothing that commits while it reads goes unheard.
 * 2. It reads the projection, which answers its asOfCommitSeq, the cursor from then on. A
 *    page that kept a projection and its cursor, as one restored after a reload or a discard,
 *    starts from that cursor instead.
 * 3. It applies the log's entries after the cursor, a page of commits at a time, and moves the
 *    cursor past each page it applied. `resync-required` reads the projection again.
 *
 * A hint at or below the cursor is a duplicate or out of order, already covered, and is
 * dropped without reading the log. Hints that come while it reads coalesce into one more read.
 * After its client reconnects, which it does lazily on its next request, it reads the
 * projection again, since the coordinator it reached may be a new one. A read or an apply that
 * fails leaves the cursor where it was, so the next hint catches up from there. Nothing here
 * polls: it reads only when started, hinted, or reconnected.
 */

import { CHANGES_PAGE } from '../ports/commit-log.js';
import { silentLogger } from '../ports/runtime.js';

/** @typedef {import('./hints.js').Hint} Hint */
/** @typedef {import('./client.js').ConnectionState} ConnectionState */
/** @typedef {import('../ports/commit-log.js').ChangeEntry} ChangeEntry */
/** @typedef {import('../ports/commit-log.js').CommitLog} CommitLog */
/** @typedef {import('../ports/runtime.js').Logger} Logger */

/**
 * @typedef {object} CatchUpOptions
 * @property {(listener: (hint: Hint) => void) => () => void} subscribe
 *   The hint subscriber's (messaging/hints.js), which already drops a hint no later than the
 *   last for its entity
 * @property {CommitLog} commitLog - #17's, read in-process
 * @property {() => Promise<number>} project
 *   Reads the projection, authoritatively, in-process, and answers its asOfCommitSeq: the
 *   log's head, read no later than the records it covers
 * @property {(entries: ChangeEntry[]) => unknown} apply
 *   Applies a page of the log's entries, as reading those entities again. It may return a
 *   promise, and is never called again before that settles.
 * @property {{subscribe(listener: (state: ConnectionState) => void): () => void, state?: () => ConnectionState}} [client]
 *   The page's client, whose reconnects read the projection again
 * @property {number} [limit] - the most commits a read asks for, CHANGES_PAGE unless a test passes another
 * @property {Logger} [logger]
 */

/**
 * @typedef {object} CatchUp
 * @property {(cursor?: number) => Promise<void>} start
 *   Subscribes, then reads the projection, or starts from `cursor`, then catches up
 * @property {() => Promise<void>} refresh - reads the projection again, then catches up
 * @property {() => number | null} cursor - the last commitSeq the projection covers, once known
 * @property {() => void} stop
 */

/**
 * @param {CatchUpOptions} options
 * @returns {CatchUp}
 */
export function createCatchUp({
  subscribe,
  commitLog,
  project,
  apply,
  client,
  limit = CHANGES_PAGE,
  logger = silentLogger,
}) {
  /** @type {number | null} */
  let cursor = null;
  let stopped = false;
  /** @type {Array<() => void>} */
  const unsubscribe = [];
  /** @type {Promise<void>} what it's doing now, which the next step waits for */
  let queue = Promise.resolve();
  /** Whether a read of the log is queued and not yet begun */
  let pulling = false;

  /**
   * @param {string} event
   * @param {Record<string, unknown>} detail
   */
  const warn = (event, detail) => {
    try {
      logger.warn(event, detail);
    } catch {
      // Nothing to tell
    }
  };

  /**
   * Runs `step` once everything before it is done, so reads and applies never overlap
   * @param {() => Promise<void>} step
   * @returns {Promise<void>}
   */
  const then = step => {
    const next = queue.then(() => (stopped ? undefined : step()));
    queue = next.catch(error => warn('catch-up-failed', { error }));
    return queue;
  };

  /** Reads the projection, whose asOfCommitSeq becomes the cursor */
  const reproject = async () => {
    cursor = await project();
  };

  /**
   * Applies every page after the cursor. One resync-required reads the projection again, and
   * a second in the same catch-up leaves the rest to the next hint.
   */
  const pull = async () => {
    pulling = false;
    if (cursor === null) await reproject();
    let resynced = false;
    for (;;) {
      if (stopped) return;
      const read = await commitLog.readChangesSince(/** @type {number} */ (cursor), limit);
      if (read.kind === 'resync-required') {
        if (resynced) {
          warn('catch-up-resync-repeated', { floor: read.floor, head: read.head });
          return;
        }
        resynced = true;
        await reproject();
        continue;
      }
      if (read.entries.length > 0) await apply(read.entries);
      // A log that says more follow without moving the cursor would be read forever
      if (read.more && read.cursor <= /** @type {number} */ (cursor)) {
        warn('catch-up-cursor-stuck', { cursor });
        return;
      }
      cursor = read.cursor;
      if (!read.more) return;
    }
  };

  /** Queues one read of the log, unless one is queued already */
  const catchUp = () => {
    if (pulling) return queue;
    pulling = true;
    return then(pull);
  };

  /** @param {Hint} hint */
  const heard = hint => {
    if (stopped) return;
    if (cursor !== null && hint.commitSeq <= cursor) return;
    void catchUp();
  };

  /** Reads the projection again once the client reconnects, never on its first connection */
  const watchClient = () => {
    if (!client) return;
    let connectedBefore = client.state?.() === 'connected';
    let lostSince = false;
    unsubscribe.push(
      client.subscribe(state => {
        if (state !== 'connected') {
          if (connectedBefore) lostSince = true;
          return;
        }
        if (connectedBefore && lostSince) void refresh();
        connectedBefore = true;
        lostSince = false;
      }),
    );
  };

  const refresh = () =>
    then(async () => {
      await reproject();
      await pull();
    });

  return Object.freeze({
    start(from) {
      unsubscribe.push(subscribe(heard));
      watchClient();
      return then(async () => {
        if (from === undefined) await reproject();
        else cursor = from;
        await pull();
      });
    },
    refresh,
    cursor: () => cursor,
    stop() {
      stopped = true;
      for (const off of unsubscribe.splice(0)) off();
    },
  });
}
