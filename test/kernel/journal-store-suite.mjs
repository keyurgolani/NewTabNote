// The journal store's conformance suite (#35 slice 3, js/kernel/core/ports/journal.js), which
// test/kernel/journal-store.test.mjs runs on the memory journal and on NewTabNoteJournal: the
// order entries are read in, a put that replaces and keeps a copy, a remove of those there are,
// and a mark that puts back no entry that went. conformance-inventory.mjs binds both to it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inJournalOrder, journalEntry } from '../../js/kernel/core/domain/journal.js';

/** @typedef {import('../../js/kernel/core/domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../../js/kernel/core/ports/journal.js').JournalStore} JournalStore */
/** @typedef {import('../../js/kernel/core/ports/journal.js').JournalReader} JournalReader */

/**
 * A capture's entry, as the worker writes it
 * @param {string} opId
 * @param {{createdAt?: number, seq?: number, owner?: string}} [options]
 * @returns {JournalRecord}
 */
export function entryOf(opId, { createdAt = 1000, seq = 1, owner = 'session-1' } = {}) {
  return journalEntry({
    command: {
      type: 'captureToDailyNote',
      commandId: opId,
      noteId: `n-${opId}`,
      blockId: `b-${opId}`,
      capture: { type: 'text', content: `Words of ${opId}` },
      at: createdAt,
    },
    v: 1,
    noteId: `n-${opId}`,
    surface: 'worker-internal',
    ownerSessionId: owner,
    seq,
    createdAt,
  });
}

/**
 * @param {string} name
 * @param {{make: () => JournalStore & JournalReader}} options - a new, empty store each call
 */
export function describeJournalStore(name, { make }) {
  describe(`the journal store: ${name} (#35 slice 3)`, () => {
    it("lists every entry oldest first, by when it was written, then its writer's count, then its key", async () => {
      const store = make();
      await store.open();
      const entries = [
        entryOf('c3', { createdAt: 2000, seq: 1 }),
        entryOf('c2', { createdAt: 1000, seq: 2 }),
        entryOf('c1', { createdAt: 1000, seq: 1 }),
        entryOf('c0', { createdAt: 1000, seq: 2, owner: 'session-2' }),
      ];
      for (const entry of entries) await store.put(entry);
      assert.deepEqual(
        (await store.list()).map(entry => entry.opId),
        ['c1', 'c0', 'c2', 'c3'],
      );
      assert.deepEqual(await store.list(), inJournalOrder(entries));
      // #13's client reads the version and the command alone
      assert.deepEqual(
        (await store.inFlight()).map(entry => Object.keys(entry).sort()),
        [
          ['command', 'v'],
          ['command', 'v'],
          ['command', 'v'],
          ['command', 'v'],
        ],
      );
    });

    it('replaces the entry under its opId, removes the ones named, and keeps a copy of nothing it was handed', async () => {
      const store = make();
      await store.open();
      const entry = entryOf('c1');
      await store.put(entry);
      entry.noteId = 'changed after the put';
      await store.put(entryOf('c1', { seq: 7 }));
      await store.put(entryOf('c2'));
      assert.deepEqual(
        (await store.list()).map(({ opId, seq, noteId }) => [opId, seq, noteId]),
        [
          ['c2', 1, 'n-c2'],
          ['c1', 7, 'n-c1'],
        ],
      );
      await store.remove(['c1', 'c9']);
      await store.remove([]);
      assert.deepEqual(
        (await store.list()).map(({ opId }) => opId),
        ['c2'],
      );
    });

    it('marks an entry that is there, and puts back none that went', async () => {
      const store = make();
      await store.open();
      await store.put(entryOf('c1'));
      await store.mark('c1', { code: 'unsupported-version', at: 5000 });
      await store.mark('c9', { code: 'unsupported-version', at: 5000 });
      const [marked, ...rest] = await store.list();
      assert.deepEqual(rest, []);
      assert.deepEqual(marked, { ...entryOf('c1'), unreplayable: { code: 'unsupported-version', at: 5000 } });
    });
  });
}
