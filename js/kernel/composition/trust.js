/**
 * A context's failure events (#20 slice 1b, "Diagnostic journal"): what today's failure sites
 * call to put a failure in the diagnostic journal, and the incident its code names in
 * NewTabNoteTrust (js/trust/core/event-codes.js). The sites are background capture and the
 * worker's storage open (js/background.js), and on the new tab the embedding model's load
 * (js/embeddings.js), auto-backup (js/controllers/settings-controller.js), and the indexer's
 * start (js/controllers/notes-manager.js).
 *
 * It's best effort and never in a site's way. `event` never throws and answers nothing, so a
 * site does exactly what it did before, whether NewTabNoteTrust opens, its writes fail, the
 * journal refuses the event, or the browser has no IndexedDB. Each site's console output
 * stays as it was.
 *
 * Nothing opens until the first event: loading this module and creating the events touch no
 * browser API, so the service worker imports it statically (it has no import()) and still
 * registers its listeners first. That static import adds the trust code (12 modules, about
 * 118 KB) to every worker start, and a trust file that fails to load or evaluate stops the
 * worker, which `check:dist` and `test:extension` guard. A records build that rejects (no
 * IndexedDB global, say) is kept, so later events in that context are dropped. The first
 * event opens NewTabNoteTrust and, when that fails, the records fall back to
 * chrome.storage.local's `trust.lastStorageIncident`.
 *
 * A context's events run one at a time, each through to its flush, so a success's count is
 * read before any later event in the context is processed. A success at a site
 * (`capture.committed`, `indexer.started`, `backup.auto-succeeded`) reads chrome.storage.local's
 * `trust.openSites` at its own moment: `{failure code: {incident key: occurrences}}`, which a
 * failure there writes once its raise lands. It opens the records only when its site has an
 * entry, and resolves only an incident whose occurrences still equal that count, so another
 * context's failure after the read stays open. A success that leaves nothing open removes the
 * site. It's best effort with no lock across contexts: a lost, stale or cleared entry only
 * mismatches or skips, leaving an incident open (a false alarm), never resolving one.
 *
 * `reconcile()` opens the records when the settings copy holds sightings a context couldn't
 * store, so NewTabNoteTrust's own incidents reconcile at a start, not only at the next
 * failure. It skips the attempt within RETRY_OPEN_MS of a held `open-failed` sighting, while
 * the store is likely still broken, so a broken store isn't retried, and its count bumped, at
 * every start. Both keys are `diagnostic`: never in a backup or in sync.
 *
 * What failed reaches the journal only as value-free evidence (failureEvidence): an error's
 * or DOMException's registered name, a registered error code, an outcome's cause, and whether
 * it's retryable. Never a message, a title, a URL, or anything a note holds.
 */

import { FAIL_CAUSES } from '../core/contracts/outcomes.js';
import { systemClock } from '../core/ports/runtime.js';
import { createTrustDatabase } from '../adapters/indexeddb/trust.js';
import { ERROR_CODES, EXCEPTION_NAMES } from '../../trust/core/codes.js';
import { EVENT_CODES, isEventCode } from '../../trust/core/event-codes.js';
import { SETTINGS_KEYS } from '../../trust/core/ports.js';
import { OPEN_FAILED_KEY, RETRY_OPEN_MS } from '../../trust/core/trust-records.js';
import { createDiagnosticJournal } from '../../trust/core/journal.js';
import { createTrustRecords } from '../../trust/core/trust-records.js';

/**
 * Whether the settings copy `copy` holds sightings, and none of NewTabNoteTrust's failed open
 * from the last RETRY_OPEN_MS before `now`
 * @param {unknown} copy
 * @param {number} now
 */
export function reconcileDue(copy, now) {
  const entries = copy && typeof copy === 'object' ? /** @type {{entries?: unknown}} */ (copy).entries : null;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return !entries.some(
    entry =>
      entry &&
      typeof entry === 'object' &&
      entry.key === OPEN_FAILED_KEY &&
      typeof entry.at === 'number' &&
      now - entry.at < RETRY_OPEN_MS,
  );
}

/** @typedef {import('../core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../../trust/core/ports.js').SettingsPort} SettingsPort */
/** @typedef {import('../../trust/core/ports.js').Locks} Locks */
/** @typedef {import('../../trust/core/ports.js').Clock} Clock */
/** @typedef {import('../../trust/core/ports.js').Ids} Ids */
/** @typedef {import('../../trust/core/ports.js').Timers} Timers */
/** @typedef {import('../../trust/core/journal.js').DiagnosticJournal} DiagnosticJournal */
/** @typedef {import('../../trust/core/journal.js').RejectionReason} RejectionReason */

/**
 * What a context's trust records run on
 * @typedef {object} TrustHost
 * @property {IDBFactory} indexedDB
 * @property {{upperBound(bound: unknown, open?: boolean): IDBKeyRange}} [keyRange] - IDBKeyRange unless given
 * @property {SettingsPort} settings - chrome.storage.local
 * @property {Locks | null} locks - navigator.locks
 * @property {Clock} clock
 * @property {Ids} ids
 * @property {Timers} [timers] - setTimeout and clearTimeout, which bound the records' reads of
 *   the settings copy; without them a read waits as long as it takes
 */

/**
 * @typedef {object} FailureEvents
 * @property {(code: string, fields?: Record<string, unknown>, failure?: unknown, options?: {seen?: Readonly<Record<string, number>>}) => void} event
 *   Journals `code` with `fields`, `surface` when the code lists it, and what `failure` (an
 *   Error, a DOMException, or a kernel outcome) gives as value-free evidence. Never throws.
 * @property {() => Promise<void>} flush - resolves once every event so far has been written or dropped
 * @property {() => Promise<void>} reconcile
 *   Opens the records when the settings copy holds sightings, so they replay and NewTabNoteTrust's
 *   own incidents resolve by the records' rules. Never rejects.
 * @property {() => Promise<Readonly<Record<RejectionReason, number>> | null>} rejected
 *   The journal's refusals, by reason, or null before the first event or when the records
 *   couldn't be built
 */

/** The failure codes a success resolves (event-codes.js), whose counts `trust.openSites` keeps */
const SITE_FAILURES = new Set(
  Object.values(EVENT_CODES)
    .map(entry => entry.resolves)
    .filter(code => code !== undefined),
);

/**
 * `trust.openSites` as `{failure code: {incident key: occurrences}}`, dropping anything else
 * @param {unknown} value
 * @returns {Record<string, Record<string, number>>}
 */
function openSitesOf(value) {
  /** @type {Record<string, Record<string, number>>} */
  const sites = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sites;
  for (const [site, counts] of Object.entries(value)) {
    if (!SITE_FAILURES.has(site) || !counts || typeof counts !== 'object' || Array.isArray(counts)) continue;
    /** @type {Record<string, number>} */
    const kept = {};
    for (const [key, occurrences] of Object.entries(counts)) {
      if (typeof occurrences === 'number' && Number.isSafeInteger(occurrences) && occurrences > 0)
        kept[key] = occurrences;
    }
    if (Object.keys(kept).length > 0) sites[site] = kept;
  }
  return sites;
}

/**
 * This browser context's host: IndexedDB, chrome.storage.local, Web Locks, the time, and
 * crypto.randomUUID, read when the first event happens
 * @returns {TrustHost}
 */
export function browserTrustHost() {
  const scope = /** @type {{navigator?: {locks?: Locks}}} */ (globalThis);
  return {
    indexedDB: globalThis.indexedDB,
    settings: {
      get: keys => chrome.storage.local.get(keys),
      set: items => chrome.storage.local.set(items),
    },
    locks: (scope.navigator && scope.navigator.locks) || null,
    clock: systemClock,
    ids: { next: () => crypto.randomUUID() },
    timers: {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: handle => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
    },
  };
}

/**
 * `object[name]` when it's a string. A getter that throws reads as none.
 * @param {object} object
 * @param {string} name
 * @returns {string | null}
 */
function stringAt(object, name) {
  try {
    const value = /** @type {Record<string, unknown>} */ (object)[name];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * What `failure` says as evidence, and nothing else: its name when it's a registered
 * exception name, its code when that's a registered error code (js/storage.js's `OPEN_FAILED`
 * reads as `open-failed`), an outcome's or UnavailableError's cause when it's a registered
 * one, and `retryable` when it's a boolean. Never its message or any other field.
 * @param {unknown} failure
 * @returns {{exception?: string, errorCode?: string, cause?: string, retryable?: boolean}}
 */
export function failureEvidence(failure) {
  if (failure === null || typeof failure !== 'object') return {};
  /** @type {{exception?: string, errorCode?: string, cause?: string, retryable?: boolean}} */
  const evidence = {};
  const name = stringAt(failure, 'name');
  if (name !== null && EXCEPTION_NAMES.includes(name)) evidence.exception = name;
  const code = stringAt(failure, 'code');
  const errorCode = code === null ? null : code.toLowerCase().replace(/_/g, '-');
  if (errorCode !== null && ERROR_CODES.includes(errorCode)) evidence.errorCode = errorCode;
  // An UnavailableError keeps its cause apart from Error's own `cause`, the error it wraps
  const cause = stringAt(failure, 'unavailableCause') ?? stringAt(failure, 'cause');
  if (cause !== null && /** @type {readonly string[]} */ (FAIL_CAUSES).includes(cause)) evidence.cause = cause;
  try {
    const retryable = /** @type {{retryable?: unknown}} */ (failure).retryable;
    if (typeof retryable === 'boolean') evidence.retryable = retryable;
  } catch {
    // A getter that throws says nothing
  }
  return evidence;
}

/**
 * The fields an event of `code` holds: what `failure` gives and `surface`, each only when the
 * code lists it, then the site's own `fields`, which the journal checks against the allowlist
 * @param {string} code
 * @param {Surface} surface
 * @param {Record<string, unknown> | undefined} fields
 * @param {unknown} failure
 * @returns {Record<string, unknown>}
 */
function fieldsOf(code, surface, fields, failure) {
  // What isn't an object goes to the journal as it is, which refuses it as `not-an-object`
  if (fields !== undefined && (fields === null || typeof fields !== 'object' || Array.isArray(fields))) {
    return /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (fields));
  }
  const listed = isEventCode(code) ? EVENT_CODES[code].fields : [];
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [name, value] of Object.entries(failureEvidence(failure))) {
    if (listed.includes(name)) out[name] = value;
  }
  if (listed.includes('surface')) out.surface = surface;
  return Object.assign(out, fields);
}

/**
 * The failure events of a context on `surface`. Nothing opens until the first event.
 * @param {{surface: Surface, host?: () => TrustHost}} options - `host` is the browser's unless a test passes another
 * @returns {FailureEvents}
 */
export function createFailureEvents({ surface, host = browserTrustHost }) {
  /** @type {Promise<DiagnosticJournal> | null} */
  let journal = null;
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  /** @type {TrustHost | null} */
  let hosted = null;
  /** This context's events, one at a time */
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  const hostOnce = () => {
    if (!hosted) hosted = host();
    return hosted;
  };

  /**
   * What `trust.openSites` holds, `{failure code: {incident key: occurrences}}`; nothing when
   * it can't be read, or holds anything else
   * @returns {Promise<Record<string, Record<string, number>>>}
   */
  const marked = async () => {
    try {
      const key = SETTINGS_KEYS.openSites;
      return openSitesOf((await hostOnce().settings.get([key]))[key]);
    } catch {
      return {};
    }
  };

  /**
   * Sets `site`'s entry for `key` to `occurrences`, or, with `key` null, removes the site.
   * Best effort: a lost write leaves an incident open.
   * @param {string} site
   * @param {string | null} key
   * @param {number} [occurrences]
   */
  const mark = async (site, key, occurrences) => {
    try {
      const now = await marked();
      const entry = { ...(now[site] || {}) };
      if (key === null) {
        if (!now[site]) return;
        delete now[site];
      } else {
        if (entry[key] === occurrences) return;
        entry[key] = /** @type {number} */ (occurrences);
        now[site] = entry;
      }
      await hostOnce().settings.set({ [SETTINGS_KEYS.openSites]: now });
    } catch {
      // A lost mark errs toward an incident left open
    }
  };

  /**
   * The journal, built and its records opened on the first call. Records that won't open
   * are in fallback and still take events, so this rejects only when nothing could be built.
   */
  const ready = () => {
    if (!journal) {
      journal = Promise.resolve().then(async () => {
        const { indexedDB, keyRange, settings, locks, clock, ids, timers = null } = hostOnce();
        const store = createTrustDatabase({ indexedDB, keyRange });
        // `timers` bound the records' reads of the settings copy (COPY_READ_MS)
        const records = createTrustRecords({ store, settings, clock, ids, locks, timers });
        await records.open();
        // A failure at a site with a success writes its incident's count once the raise lands
        const onRaised = (/** @type {string} */ code, /** @type {{key: string, occurrences: number}} */ incident) =>
          SITE_FAILURES.has(code) ? mark(code, incident.key, incident.occurrences) : undefined;
        return createDiagnosticJournal({ records, clock, onRaised });
      });
    }
    return journal;
  };

  /**
   * Runs `work` after every event before it in this context, and tracks it for flush()
   * @param {() => Promise<void>} work
   * @returns {Promise<void>}
   */
  const enqueue = work => {
    const done = queue.then(work).then(
      () => {},
      () => {},
    );
    queue = done;
    pending.add(done);
    done.then(() => pending.delete(done));
    return done;
  };

  return Object.freeze({
    event(code, fields, failure, options = {}) {
      try {
        const checked = fieldsOf(code, surface, fields, failure);
        const entry = isEventCode(code) ? EVENT_CODES[code] : null;
        const site = entry && entry.resolves !== undefined ? entry.resolves : null;
        const work =
          site !== null
            ? async () => {
                // The count at the success's own moment: the lazy page's read, or this one
                const seen = options.seen || (await marked())[site];
                if (!seen || Object.keys(seen).length === 0) return;
                const events = await ready();
                events.event(code, checked, { seen });
                await events.flush();
                if ((await events.siteOpen(code)) === false) await mark(site, null);
              }
            : async () => {
                const events = await ready();
                events.event(code, checked);
                await events.flush();
              };
        enqueue(work);
      } catch {
        // Best effort: a failure site never hears of the journal's
      }
    },

    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },

    reconcile() {
      return enqueue(async () => {
        const key = SETTINGS_KEYS.lastStorageIncident;
        const { settings, clock } = hostOnce();
        const copy = (await settings.get([key]))[key];
        if (!reconcileDue(copy, clock.now())) return;
        // Opening replays the copy and applies the records' own rules
        await ready();
      });
    },

    async rejected() {
      if (!journal) return null;
      try {
        return (await journal).rejected();
      } catch {
        return null;
      }
    },
  });
}
