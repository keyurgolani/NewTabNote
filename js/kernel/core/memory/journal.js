/**
 * The in-memory journal (ports/journal.js, JournalStore and JournalReader), which the tests run
 * the drain and the journaling contexts on in place of `NewTabNoteJournal`
 * (adapters/indexeddb/journal.js). Everything goes in and out as a copy, and `list` answers
 * oldest first, as the database's does. `failNext` makes the next call of that kind reject with
 * an UnavailableError, as a failing IndexedDB transaction would.
 */

import { clone } from '../contracts/clone.js';
import { UnavailableError } from '../contracts/outcomes.js';
import { inJournalOrder } from '../domain/journal.js';

/** @typedef {import('../domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../ports/journal.js').JournalStore} JournalStore */
/** @typedef {import('../ports/journal.js').JournalReader} JournalReader */

/**
 * @typedef {JournalStore & JournalReader & {
 *   failNext: (call: 'open' | 'put' | 'remove' | 'mark' | 'list') => void,
 *   entries: () => JournalRecord[],
 *   opened: () => number,
 * }} MemoryJournal
 *   `entries` is a copy of what it holds, oldest first, read with no call counted, and
 *   `opened` how many times `open` was called
 */

/** @returns {MemoryJournal} */
export function createMemoryJournal() {
  /** @type {Map<string, JournalRecord>} */
  const entries = new Map();
  /** @type {Set<string>} */
  const failing = new Set();
  let opened = 0;

  /** @param {string} call */
  const check = call => {
    if (!failing.has(call)) return;
    failing.delete(call);
    throw new UnavailableError('storage', 'transaction-aborted', true);
  };

  const ordered = () => inJournalOrder([...entries.values()]).map(entry => clone(entry));

  return Object.freeze({
    async open() {
      opened += 1;
      check('open');
    },
    async put(entry) {
      check('put');
      entries.set(entry.opId, clone(entry));
    },
    async remove(opIds) {
      check('remove');
      for (const opId of opIds) entries.delete(opId);
    },
    async mark(opId, unreplayable) {
      check('mark');
      const entry = entries.get(opId);
      if (entry) entries.set(opId, { ...entry, unreplayable: { ...unreplayable } });
    },
    async list() {
      check('list');
      return ordered();
    },
    async inFlight() {
      check('list');
      return ordered().map(({ v, command }) => ({ v, command }));
    },
    failNext(call) {
      failing.add(call);
    },
    entries: ordered,
    opened: () => opened,
  });
}
