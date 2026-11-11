/**
 * The status read's ask (#20 slice 4c): a chunk the new tab loads first in its deferred work,
 * through the page loader (js/app.js), with the read's message, its wait, and a check of the
 * answer: whether it's plainly all clear. The status lines' chunk (./trust-status.js), with their
 * words, what they say for each status and the full check of the answer, loads only when an
 * answer isn't, since it could put a line in the sidebar, or when Settings opens, for its Trust
 * Center lines. Nothing shows while nothing needs the user, so a tab with nothing to show doesn't
 * load the words. Their rules load at start all the same, in the new tab's stylesheet
 * (css/editor.css), inside the start's CSS row (decided on 2026-11-07, option A).
 *
 * The check is conservative. It takes an answer as plainly all clear only with exactly the fields
 * the worker answers, in the worker's order, capture safe or unknown, the Trust Center's route,
 * open records, and each group once, one the worker names, with nothing needing action, none of
 * it leading, and no cause. Anything else loads the lines' chunk, no answer and a malformed one included, and the
 * chunk checks it in full (js/trust/core/status-message.js) and draws nothing on what it refuses.
 *
 * Until the lines' chunk has loaded, it asks again when the tab is shown again; from then on the
 * chunk reads for itself, and the ask has it read again each time Settings opens. Lines that
 * started stay, whatever their first read did. It imports nothing, so loading it touches no
 * browser API and holds no trust code: the message's type and the groups repeat
 * status-message.js's and vocabulary.js's, which test/kernel/trust-status-ask.test.mjs holds
 * equal.
 */

/** @typedef {{sendMessage(message: unknown): Promise<unknown> | unknown}} Runtime */
/** @typedef {{setTimeout(callback: () => void, ms: number): unknown, clearTimeout(handle: unknown): void}} Timers */
/** @typedef {{status: string, module?: any}} LoadResult */
/** @typedef {{loadChunk(name: string, load: () => Promise<any>): Promise<LoadResult>}} Loader */
/** @typedef {{read: () => Promise<unknown>, ready: Promise<unknown>}} Lines */
/** @typedef {{startTrustStatus(options: {document?: Document, send: () => Promise<unknown>}): Lines}} LinesChunk */

/** The status read's type, js/trust/core/status-message.js's TRUST_STATUS_MESSAGE */
export const TRUST_STATUS_MESSAGE = 'trust.status';

/** How long an ask waits for the worker's answer, after which it has none */
export const STATUS_WAIT_MS = 5000;

/** The groups the worker names, js/trust/core/vocabulary.js's HEALTH_GROUPS */
export const STATUS_GROUPS = Object.freeze([
  'storage',
  'vault',
  'backup',
  'sync',
  'indexing',
  'inference',
  'permissions',
  'recovery',
  'platform',
]);

/**
 * The status read on `runtime`: what the worker answers it, or undefined when the message couldn't
 * be sent or no answer came within `waitMs`
 * @param {Runtime} runtime
 * @param {{timers?: Timers, waitMs?: number}} [options]
 * @returns {() => Promise<unknown>}
 */
export function statusSender(runtime, { timers = globalThis, waitMs = STATUS_WAIT_MS } = {}) {
  return () =>
    new Promise(resolve => {
      let done = false;
      /** @type {unknown} */
      let timer;
      /** @param {unknown} answer */
      const settle = answer => {
        if (done) return;
        done = true;
        timers.clearTimeout(timer);
        resolve(answer);
      };
      timer = timers.setTimeout(() => settle(undefined), waitMs);
      try {
        Promise.resolve(runtime.sendMessage({ type: TRUST_STATUS_MESSAGE })).then(settle, () => settle(undefined));
      } catch {
        settle(undefined);
      }
    });
}

/**
 * `value`'s fields, in their order, when it's a plain object; null for anything else
 * @param {unknown} value
 */
const fieldsOf = value =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? Object.keys(value).join()
    : null;

/**
 * Whether `answer`, the worker's to the status read, is plainly all clear: exactly its fields, in
 * the worker's order, capture safe or unknown, the Trust Center's route, open records, and each
 * group once, one the worker names, needing no action, none of it leading, and with no cause. The
 * status lines draw no sidebar line for such an answer. False for anything else.
 * @param {unknown} answer
 * @returns {boolean}
 */
export function plainlyClear(answer) {
  if (fieldsOf(answer) !== 'capture,route,records,groups') return false;
  const { capture, route, records, groups } = /** @type {Record<string, unknown>} */ (answer);
  if ((capture !== 'safe' && capture !== 'unknown') || route !== 'trust' || records !== 'open') return false;
  if (!Array.isArray(groups)) return false;
  /** @type {Set<unknown>} */
  const seen = new Set();
  return groups.every(item => {
    if (fieldsOf(item) !== 'group,needsAction,leading,checkedAt,cause') return false;
    const { group, needsAction, leading, checkedAt, cause } = item;
    if (!STATUS_GROUPS.includes(group) || seen.has(group)) return false;
    seen.add(group);
    const time = checkedAt === null || (Number.isSafeInteger(checkedAt) && checkedAt >= 0);
    return needsAction === 0 && leading === 0 && cause === null && time;
  });
}

/**
 * Starts the ask: asks the worker now, and when the tab is shown again until the lines' chunk has
 * loaded, and loads that chunk through `loader` when an answer isn't plainly all clear, or when
 * Settings opens (settingsOpened). The chunk's first read takes the answer that loaded it, and
 * with Settings it reads for itself; once it has loaded, each Settings opening has it read again.
 * A load that fails is tried again at the next one. `send` and `load` are a test's; the browser's
 * are made here.
 * #280's probe: with the page's `client`, the read is trust.status over #13's port, and its answer
 * is the ready state's data, or none for any other state, within the same wait.
 * @param {{loader?: Loader, document?: Document, runtime?: Runtime, send?: () => Promise<unknown>, load?: () => Promise<LinesChunk | null>, client?: {query(request: {type: string}): Promise<any>}}} [options]
 * @returns {{asked: Promise<void>, settingsOpened: () => Promise<void>}} - `asked`: the first ask, and the load it set off
 */
export function startStatusAsk({ loader, document: doc = globalThis.document, runtime, send, load, client } = {}) {
  const ask =
    send ||
    (client
      ? statusSender({
          sendMessage: () =>
            client.query({ type: 'trust.status' }).then(state => (state && state.kind === 'ready' ? state.data : undefined)),
        })
      : statusSender(runtime || /** @type {Runtime} */ (/** @type {any} */ (globalThis).chrome.runtime)));
  const loadLines =
    load ||
    (async () => {
      const result = await /** @type {Loader} */ (loader).loadChunk('trust-status', () => import('./trust-status.js'));
      return result.status === 'loaded' ? result.module : null;
    });
  /** @type {Promise<Lines | null> | null} */
  let lines = null;
  /**
   * The lines' chunk, loaded once and started, its first read taking `heard` when there's one.
   * Answers the lines once that read is done, or null when the chunk didn't load. Lines that
   * started stay, whatever their first read did, so no second set starts beside them.
   * @param {{answer: unknown} | null} heard - what an ask answered
   * @returns {Promise<Lines | null>}
   */
  const start = heard => {
    if (!lines) {
      let held = heard;
      const read = () => {
        if (!held) return ask();
        const { answer } = held;
        held = null;
        return Promise.resolve(answer);
      };
      const failed = () => {
        lines = null;
        return null;
      };
      lines = Promise.resolve()
        .then(loadLines)
        .then(chunk => {
          if (!chunk) return failed();
          const started = chunk.startTrustStatus({ document: doc, send: read });
          return Promise.resolve(started.ready).then(
            () => started,
            () => started,
          );
        })
        .catch(failed);
    }
    return lines;
  };
  /** Asks, unless the lines' chunk reads for itself, and loads it when the answer isn't plainly all clear */
  const check = async () => {
    if (lines) return;
    /** @type {unknown} */
    let answer;
    try {
      answer = await ask();
    } catch {
      answer = undefined;
    }
    if (!lines && !plainlyClear(answer)) await start({ answer });
  };
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') check();
  });
  return {
    asked: check(),
    // Lines that start for Settings read for themselves; lines started already read again
    settingsOpened: async () => {
      const fresh = lines === null;
      const started = await start(null);
      if (started && !fresh) await started.read();
    },
  };
}
