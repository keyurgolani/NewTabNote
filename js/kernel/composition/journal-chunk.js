/**
 * The journal's chunk on a page (#35 slice 3b): what the new tab, Popup and Side Panel load on
 * their first journaled command, or at idle once their first read is in (host.js,
 * journalingClient), so no page's start holds it. Its start, startPageJournal:
 * - The page's journaling (core/application/journaling.js), on `NewTabNoteJournal`, which it opens
 *   only once it's needed: at its start when the database is there, and otherwise at the first
 *   entry it writes, so a profile with no journal opens nothing and makes none until it does.
 * - The entries closed pages left. When an editor save the apply takes is among them, it loads the
 *   apply (core/application/journal-apply.js), from the `close-drafts-chunk` chunk, which the
 *   apply's own command loads anyway, so a start with nothing to apply loads none of it, and
 *   takes no DRAFTS_LOCK: a newer build's save, or one the worker holds, is left as it is. When an
 *   entry the worker replays or keeps is among them, or the apply leaves one to it, it wakes the
 *   worker's drain (DRAIN_MESSAGE), once.
 *
 * The page's globals are read when it starts, unless a test passes them. Nothing here throws into
 * the page: a journal that can't be read leaves the entries for the next start, and says so on the
 * console, with the failure's code at most.
 */

import { inContextStores } from '../adapters/in-context.js';
import { createJournaling } from '../core/application/journaling.js';
import { isRecord } from '../core/contracts/checks.js';
import { DRAIN_MESSAGE, OWNER_LOCK_PREFIX, PAGES_APPLY, isJournalRecord, isPagesSave } from '../core/domain/journal.js';
import { systemClock } from '../core/ports/runtime.js';
import { pageDrafts } from './close-drafts.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../adapters/in-context.js').InContextStores} InContextStores */
/** @typedef {import('../core/application/journaling.js').Journaling} Journaling */
/** @typedef {import('../core/application/journaling.js').JournalingLocks} JournalingLocks */
/** @typedef {import('../core/application/journal-apply.js').JournalApplyResult} JournalApplyResult */
/** @typedef {import('../core/application/close-drafts.js').DraftStorage} DraftStorage */
/** @typedef {import('../core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../core/domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../core/ports/journal.js').JournalStore} JournalStore */

/** The apply of editor saves, with the store its toasts' lists are on */
const loadApplier = () => import('../core/application/close-drafts-chunk.js');

/**
 * Warns of what the journal couldn't do, with the failure's code at most
 * @param {string} event
 * @param {unknown} error
 */
const warnOf = (event, error) => {
  const code =
    error && typeof error === 'object' && 'code' in error ? /** @type {{code: unknown}} */ (error).code : null;
  console.warn(`NewTabNote journal: ${event}`, { code });
};

/**
 * The journal on `stores`, opened at each call that needs it. A put on an open journal issues
 * its transaction in its caller's task, as the database's own does.
 * @param {InContextStores} stores
 * @returns {JournalStore}
 */
function openedJournal(stores) {
  /**
   * @template T
   * @param {(journal: ReturnType<InContextStores['journal']>) => Promise<T>} call
   * @returns {Promise<T>}
   */
  const opened = call => {
    const journal = stores.journal();
    return journal.state() === 'open' ? call(journal) : journal.open().then(() => call(journal));
  };
  return Object.freeze({
    open: () => stores.journal().open(),
    put: entry => opened(journal => journal.put(entry)),
    remove: opIds => opened(journal => journal.remove(opIds)),
    mark: (opId, unreplayable) => opened(journal => journal.mark(opId, unreplayable)),
    list: () => opened(journal => journal.list()),
  });
}

/**
 * The sessions whose owner lock is held now, or null when `locks` can't say
 * @param {JournalingLocks | null} locks
 * @returns {Promise<ReadonlySet<string> | null>}
 */
async function liveOwners(locks) {
  if (!locks || typeof locks.query !== 'function') return null;
  const { held = [] } = (await locks.query()) || {};
  /** @type {Set<string>} */
  const live = new Set();
  for (const lock of held) {
    const name = lock && typeof lock.name === 'string' ? lock.name : '';
    if (name.startsWith(OWNER_LOCK_PREFIX)) live.add(name.slice(OWNER_LOCK_PREFIX.length));
  }
  return live;
}

/**
 * Whether `entry` is an editor save with a draft: the pages apply it, or leave it as it is when
 * it's a newer build's or one the worker holds, so the drain has nothing to do for it either way
 * @param {JournalRecord} entry
 */
const isEditorSave = entry =>
  isRecord(entry.command) && Object.hasOwn(PAGES_APPLY, String(entry.command.type)) && entry.draft !== undefined;

/**
 * The page's journal, and the apply of what closed pages left, which starts now. The shim calls
 * it with its arguments in order (host.js, journalingClient), so the pages' start carries none of
 * their names.
 * @param {Client} client
 * @param {string} sessionId
 * @param {Surface} surface
 * @param {{
 *   stores?: InContextStores,
 *   locks?: JournalingLocks | null,
 *   storage?: DraftStorage,
 *   runtime?: {sendMessage?: (message: unknown) => Promise<unknown>} | null,
 *   clock?: {now(): number},
 * }} [globals] - the page's own unless a test passes them
 * @returns {Journaling & {applied: Promise<JournalApplyResult | null>}}
 *   `applied`: what the apply did, null when nothing was there for it. Never rejects.
 */
export function startPageJournal(
  client,
  sessionId,
  surface,
  {
    stores = inContextStores(),
    locks = /** @type {JournalingLocks | null} */ (pageDrafts().locks),
    storage = pageDrafts().storage,
    runtime = globalThis.chrome?.runtime ?? null,
    clock = systemClock,
  } = {},
) {
  const journal = openedJournal(stores);
  const journaling = createJournaling({ journal, locks, sessionId, surface, clock, warn: warnOf });
  let woken = false;
  const wake = () => {
    if (woken) return;
    woken = true;
    try {
      if (runtime && typeof runtime.sendMessage === 'function') {
        Promise.resolve(runtime.sendMessage({ type: DRAIN_MESSAGE })).catch(() => {});
      }
    } catch {
      // The worker drains at its next start
    }
  };
  const applied = (async () => {
    try {
      if (!(await stores.journalExists())) return null;
      const live = await liveOwners(locks);
      if (!live) return null;
      const left = (await journal.list()).filter(
        entry =>
          isJournalRecord(entry) &&
          entry.state === 'submitted' &&
          entry.ownerSessionId !== sessionId &&
          !live.has(entry.ownerSessionId),
      );
      /** @type {JournalApplyResult | null} */
      let result = null;
      if (left.some(isPagesSave)) {
        const { applyJournalSaves, closeDraftStore } = await loadApplier();
        result = await applyJournalSaves({
          journal,
          client,
          liveOwners: () => liveOwners(locks),
          sessionId,
          locks,
          store: closeDraftStore(storage),
          wake,
        });
      }
      if (!left.every(isEditorSave)) wake();
      return result;
    } catch (error) {
      warnOf('entries-not-applied', error);
      return null;
    }
  })();
  return Object.freeze({ ...journaling, applied });
}
