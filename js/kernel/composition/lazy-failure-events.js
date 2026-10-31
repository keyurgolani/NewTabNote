/**
 * A page's failure events, loaded only after its first failure (#20 slice 1b). The new tab's
 * composition root makes these, so the tab's module graph, and with it what loads before
 * Moment can capture, stays as it was: trust code (./trust.js, js/trust/core/, and
 * NewTabNoteTrust's adapter) loads through import() the first time a failure site reports.
 * The service worker has no import(), so it imports ./trust.js itself.
 *
 * Like ./trust.js's events, `event` never throws and answers nothing: an import that fails
 * drops the event, and the site does what it did before.
 */

/** @typedef {import('../core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('./trust.js').FailureEvents} FailureEvents */

/**
 * @param {{surface: Surface, load?: () => Promise<{createFailureEvents: typeof import('./trust.js').createFailureEvents}>}} options
 *   `load` imports ./trust.js unless a test passes another
 * @returns {Pick<FailureEvents, 'event' | 'flush'>}
 */
export function lazyFailureEvents({ surface, load = () => import('./trust.js') }) {
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

  return Object.freeze({
    event(code, fields, failure) {
      try {
        const done = ready()
          .then(loaded => {
            loaded.event(code, fields, failure);
            return loaded.flush();
          })
          .catch(() => {});
        pending.add(done);
        done.then(() => pending.delete(done));
      } catch {
        // Best effort: a failure site never hears of the journal's
      }
    },

    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  });
}
