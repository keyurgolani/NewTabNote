/**
 * InContextStores (#35, "In-context writes"): what a context writes itself rather than through
 * the coordinator, or typing would wait on the worker. Slice 3 opens only `NewTabNoteJournal`
 * here (indexeddb/journal.js), which a page writes before it sends a journaled command and the
 * worker writes before a capture. `NewTabNoteTrust`, #20's `chrome.storage.local` keys and #17's
 * session-state keys move behind it with slice 4a's architecture test, which holds the list of
 * what a context may write on its own (the lead's answer to the plan's Q7).
 *
 * Nothing opens until it's asked for, each context gets one journal connection, and the
 * context's IndexedDB is read then, unless a test passes one.
 */

import { createJournalDatabase, journalExists } from './indexeddb/journal.js';

/** @typedef {import('./indexeddb/journal.js').JournalDatabase} JournalDatabase */

/**
 * @typedef {object} InContextStores
 * @property {() => JournalDatabase} journal - this context's journal, made on the first call
 * @property {() => Promise<boolean>} journalExists - whether the journal database exists yet
 */

/**
 * @param {{indexedDB?: IDBFactory}} [options]
 * @returns {InContextStores}
 */
export function inContextStores({ indexedDB } = {}) {
  /** @returns {IDBFactory} */
  const factory = () => indexedDB ?? globalThis.indexedDB;
  /** @type {JournalDatabase | null} */
  let journal = null;
  return Object.freeze({
    journal() {
      if (!journal) journal = createJournalDatabase({ indexedDB: factory() });
      return journal;
    },
    journalExists: () => journalExists(factory()),
  });
}
