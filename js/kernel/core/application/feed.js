/**
 * The commit feed (#12, "Commands", item 6). After a command commits, the kernel publishes
 * `{aggregate, ids}`, and this context's projections apply those ids. A listener that throws,
 * or returns a promise that rejects, is reported to the logger and never changes the
 * outcome, and neither does a logger that throws while it reports. The feed carries ids only.
 * The kernel emits no note:saved event. Nothing listens for one any more (#13 removed
 * sync-service.js's subscription), and #19 decides how sync hears of commits.
 */

/** @typedef {import('../contracts/commands.js').Aggregate} Aggregate */
/** @typedef {import('../ports/runtime.js').Logger} Logger */

/**
 * @typedef {object} CommitEvent
 * @property {Aggregate} aggregate
 * @property {readonly string[]} ids
 */

/** @typedef {(event: CommitEvent) => unknown} CommitListener */

/**
 * @typedef {object} CommitFeed
 * @property {(listener: CommitListener) => () => void} subscribe - returns the unsubscribe function
 * @property {(event: {aggregate: Aggregate, ids: readonly string[]}) => void} publish
 */

/**
 * @param {Logger} logger
 * @returns {CommitFeed}
 */
export function createCommitFeed(logger) {
  /** @type {Set<CommitListener>} */
  const listeners = new Set();
  return Object.freeze({
    subscribe(listener) {
      const entry = /** @type {CommitListener} */ (event => listener(event));
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    publish({ aggregate, ids }) {
      /** @type {CommitEvent} */
      const event = Object.freeze({ aggregate, ids: Object.freeze([...ids]) });
      /** @param {unknown} error */
      const report = error => {
        try {
          logger.warn('commit-listener-failed', { aggregate, ids: [...ids], error });
        } catch {
          // A logger that fails has nowhere to report to, and the commit already landed
        }
      };
      for (const listener of [...listeners]) {
        try {
          const result = listener(event);
          if (isThenable(result)) Promise.resolve(result).catch(report);
        } catch (error) {
          report(error);
        }
      }
    },
  });
}

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
function isThenable(value) {
  return (
    value !== null && typeof value === 'object' && typeof (/** @type {{then?: unknown}} */ (value).then) === 'function'
  );
}
