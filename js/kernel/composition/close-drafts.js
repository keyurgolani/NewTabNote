/**
 * Close-time drafts at a root's start (#33, the stack's close-time PR): the page's localStorage
 * and Web Locks, which this port reads from the page's globals and hands to the applier
 * (core/application/close-drafts.js) so kernel core touches no browser API (the lead's Q2), and
 * the root's whenReady, which resolves once the page's drafts are applied, so the page's first
 * read of its notes has every closing tab's edit in.
 *
 * Most starts have nothing to apply, so a synchronous look at localStorage comes first: only a
 * draft's key, or 1.4.3's catch-up key, which the first stack start reads and then removes, gives
 * a page work. With neither, nothing loads, no lock is taken and nothing is sent. With one, the
 * root's `load` hands over the applier: the new tab's has it in its start, and Popup's and Side
 * Panel's import it then, the `close-drafts-chunk` chunk (the lead's option 1), so their start loads
 * none of it. The untold lists alone give no page work here: only the new tab reads them, for
 * its toasts.
 */

import { CATCH_UP_KEY, DRAFT_PREFIX } from '../core/domain/close-draft-keys.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../core/application/close-drafts.js').DraftStorage} DraftStorage */
/** @typedef {import('../core/application/close-drafts.js').DraftLocks} DraftLocks */
/** @typedef {import('../core/application/close-drafts.js').ApplyResult} ApplyResult */

/**
 * What a root applies its page's drafts with, which it loads when the page holds one
 * @typedef {Pick<typeof import('../core/application/close-drafts.js'), 'applyCloseDrafts' | 'closeDraftStore'>} Applier
 */

/**
 * The page's localStorage and Web Locks, from its globals. A page without localStorage, as the
 * worker is, has no drafts.
 * @returns {{storage: DraftStorage | undefined, locks: DraftLocks | null}}
 */
export function pageDrafts() {
  /** @type {DraftStorage | undefined} */
  let storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    storage = undefined;
  }
  const locks = /** @type {DraftLocks | null} */ (/** @type {unknown} */ (globalThis.navigator?.locks || null));
  return { storage, locks };
}

/**
 * Whether `storage` gives a start anything to apply: a draft, or 1.4.3's catch-up key.
 * Synchronous, and never throws: a page without localStorage, or without access to it, has none.
 * @param {DraftStorage | undefined} storage
 * @returns {boolean}
 */
export function holdsDrafts(storage) {
  try {
    if (!storage) return false;
    if (storage.getItem(CATCH_UP_KEY) !== null) return true;
    for (let index = 0; index < storage.length; index += 1) {
      if (String(storage.key(index)).startsWith(DRAFT_PREFIX)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Tells of a draft refused or an apply that couldn't run, never a draft's text */
const consoleLogger = Object.freeze({
  warn: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) =>
    console.warn(`NewTabNote close-time drafts: ${event}`, detail),
});

/**
 * `client`, whose whenReady resolves once the page's drafts are applied, which runs the first
 * time it's asked: the new tab's note list reads once whenReady resolves, and Popup and Side
 * Panel read right after it. A kernel that couldn't open applies nothing. An applier that can't
 * load, or an apply that fails, leaves the drafts for the next start, and the page starts on
 * what's stored.
 * @param {Client} client
 * @param {{storage: DraftStorage | undefined, locks: DraftLocks | null}} page
 * @param {{load: () => Promise<Applier>, logger?: {warn: (event: string, detail: Record<string, unknown>) => void}}} applier
 * @returns {Client & {applied: () => Promise<ApplyResult | null>}}
 */
export function applyingCloseDrafts(client, { storage, locks }, { load, logger = consoleLogger }) {
  /** @type {Promise<ApplyResult | null> | null} */
  let applying = null;
  const applied = () =>
    (applying ||= client.whenReady().then(async failure => {
      if (failure || !holdsDrafts(storage)) return null;
      try {
        const { applyCloseDrafts, closeDraftStore } = await load();
        return await applyCloseDrafts({ client, store: closeDraftStore(storage), locks, logger });
      } catch (error) {
        logger.warn('close-drafts-not-applied', { error });
        return null;
      }
    }));
  return Object.freeze({ ...client, whenReady: () => applied().then(() => client.whenReady()), applied });
}
