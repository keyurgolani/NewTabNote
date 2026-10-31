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
 * A success at a site (SUCCESS_SITES) imports the trust code only while chrome.storage.local's
 * `trust.openSites` lists its site's failure, and `reconcile()` only while the settings copy
 * holds sightings, so a tab with nothing to resolve still loads no trust code. This module
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

  const ready = () => {
    if (!events)
      events = Promise.resolve()
        .then(load)
        .then(module => module.createFailureEvents({ surface }));
    return events;
  };

  /**
   * Tracks `work` until it settles
   * @param {Promise<unknown>} work
   */
  const track = work => {
    const done = work.then(
      () => {},
      () => {},
    );
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
        const pass = () =>
          ready().then(loaded => {
            loaded.event(code, fields, failure);
            return loaded.flush();
          });
        track(
          site === null
            ? pass()
            : readKey(OPEN_SITES_KEY).then(sites =>
                Array.isArray(sites) && sites.includes(site) ? pass() : undefined,
              ),
        );
      } catch {
        // Best effort: a failure site never hears of the journal's
      }
    },

    reconcile() {
      return track(
        readKey(COPY_KEY).then(copy => {
          const entries = copy && typeof copy === 'object' ? /** @type {{entries?: unknown}} */ (copy).entries : null;
          if (!Array.isArray(entries) || entries.length === 0) return undefined;
          return ready().then(loaded => loaded.reconcile());
        }),
      );
    },

    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  });
}
