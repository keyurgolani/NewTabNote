/**
 * A page's failure events, loaded only after its first failure (#20 slice 1b). The new tab's
 * composition root makes these, so the tab's module graph, and with it what loads before
 * Moment can capture, stays as it was: trust code (./trust.js, js/trust/core/, and
 * NewTabNoteTrust's adapter) loads through import() the first time a failure site reports.
 * The service worker has no import(), so it imports ./trust.js itself.
 *
 * Like ./trust.js's events, `event` never throws and answers nothing: an import that fails
 * drops the event, and the site does what it did before. The failed import is kept, so every
 * later event on that page is dropped too until the page reloads.
 *
 * The page's events run one at a time. A success at a site (SUCCESS_SITES) reads
 * chrome.storage.local's `trust.openSites` at its own moment, imports the trust code only
 * when its site has an entry, and passes that count on, so a failure that lands while the code
 * loads stays open. `reconcile()` imports it only while the settings copy holds sightings and
 * no failed open of NewTabNoteTrust from the last RETRY_OPEN_MS, so a tab with nothing to
 * resolve still loads no trust code. This module
 * names those codes and keys itself, since importing them would load the trust code;
 * test/kernel/trust-before-s4.test.mjs holds them equal to js/trust/core/'s.
 */

/** Each success code, by the failure code whose incident it resolves (event-codes.js) */
export const SUCCESS_SITES = Object.freeze({
  'capture.committed': 'capture.failed',
  'backup.auto-succeeded': 'backup.auto-failed',
  'indexer.started': 'indexer.start-failed',
});

/** js/trust/core/ports.js's SETTINGS_KEYS.openSites and .lastStorageIncident */
export const OPEN_SITES_KEY = 'trust.openSites';
export const COPY_KEY = 'trust.lastStorageIncident';

/** js/trust/core/trust-records.js's OPEN_FAILED_KEY and RETRY_OPEN_MS */
export const OPEN_FAILED_KEY = 'storage/open-failed/NewTabNoteTrust';
export const RETRY_OPEN_MS = 30_000;

/**
 * chrome.storage.local's answer for `keys`, or none when there's no chrome.storage
 * @param {string[]} keys
 * @returns {Promise<Record<string, unknown>>}
 */
const chromeRead = async keys => {
  const scope =
    /** @type {{chrome?: {storage?: {local?: {get(keys: string[]): Promise<Record<string, unknown>>}}}}} */ (
      globalThis
    );
  const local = scope.chrome && scope.chrome.storage && scope.chrome.storage.local;
  return local ? local.get(keys) : {};
};

/** @typedef {import('../core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('./trust.js').FailureEvents} FailureEvents */

/**
 * @param {{
 *   surface: Surface,
 *   load?: () => Promise<{createFailureEvents: typeof import('./trust.js').createFailureEvents}>,
 *   read?: (keys: string[]) => Promise<Record<string, unknown>>,
 * }} options
 *   `load` imports ./trust.js and `read` reads chrome.storage.local, unless a test passes others
 * @returns {Pick<FailureEvents, 'event' | 'flush' | 'reconcile'>}
 */
export function lazyFailureEvents({ surface, load = () => import('./trust.js'), read = chromeRead }) {
  /** @type {Promise<FailureEvents> | null} */
  let events = null;
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  /** The page's events, one at a time */
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  const ready = () => {
    if (!events)
      events = Promise.resolve()
        .then(load)
        .then(module => module.createFailureEvents({ surface }));
    return events;
  };

  /**
   * Runs `work` after every event before it on this page, and tracks it until it settles
   * @param {() => Promise<unknown>} work
   */
  const track = work => {
    const done = queue.then(work).then(
      () => {},
      () => {},
    );
    queue = done;
    pending.add(done);
    done.then(() => pending.delete(done));
    return done;
  };

  /**
   * What chrome.storage.local holds under `key`, or undefined when it can't be read
   * @param {string} key
   */
  const readKey = async key => {
    try {
      return (await read([key]))[key];
    } catch {
      return undefined;
    }
  };

  return Object.freeze({
    event(code, fields, failure) {
      try {
        const site = Object.prototype.hasOwnProperty.call(SUCCESS_SITES, code)
          ? SUCCESS_SITES[/** @type {keyof typeof SUCCESS_SITES} */ (code)]
          : null;
        /** @param {Record<string, number>} [seen] */
        const pass = seen =>
          ready().then(loaded => {
            loaded.event(code, fields, failure, seen ? { seen } : {});
            return loaded.flush();
          });
        track(async () => {
          if (site === null) return pass();
          // The count at the success's own moment, which the trust code resolves against
          const sites = await readKey(OPEN_SITES_KEY);
          const seen = sites && typeof sites === 'object' ? /** @type {Record<string, unknown>} */ (sites)[site] : null;
          if (!seen || typeof seen !== 'object' || Object.keys(seen).length === 0) return undefined;
          return pass(/** @type {Record<string, number>} */ (seen));
        });
      } catch {
        // Best effort: a failure site never hears of the journal's
      }
    },

    reconcile() {
      return track(async () => {
        const copy = await readKey(COPY_KEY);
        const entries = copy && typeof copy === 'object' ? /** @type {{entries?: unknown}} */ (copy).entries : null;
        if (!Array.isArray(entries) || entries.length === 0) return undefined;
        // A context failed to open NewTabNoteTrust just now: likely still broken
        const now = Date.now();
        const recent = entries.some(
          entry =>
            entry && entry.key === OPEN_FAILED_KEY && typeof entry.at === 'number' && now - entry.at < RETRY_OPEN_MS,
        );
        if (recent) return undefined;
        return ready().then(loaded => loaded.reconcile());
      });
    },

    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  });
}
