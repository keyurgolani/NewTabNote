// #35 slice 3's journal store: NewTabNoteJournal (js/kernel/adapters/indexeddb/journal.js) and
// the memory journal the drain's tests run on (js/kernel/core/memory/journal.js), through the
// journal store suite (journal-store-suite.mjs), then NewTabNoteJournal's own rules: its layout
// frozen at version 1, #17's transaction rules, a write issued in its caller's task, and a newer
// database left alone. InContextStores opens it once per context, and only when it's asked for.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import {
  JOURNAL_DB_NAME,
  JOURNAL_DB_STORES,
  JOURNAL_DB_VERSION,
  JOURNAL_STORE,
  createJournalDatabase,
  journalExists,
} from '../../js/kernel/adapters/indexeddb/journal.js';
import { ownerLock } from '../../js/kernel/core/domain/journal.js';
import { createMemoryJournal } from '../../js/kernel/core/memory/journal.js';
import { describeJournalStore, entryOf } from './journal-store-suite.mjs';
import { faultyFactory } from './storage-faults.mjs';

const { IDBFactory } = createRequire(import.meta.url)('fake-indexeddb');

/** @type {Array<{close: () => void}>} */
const opened = [];
after(() => opened.forEach(store => store.close()));

/** A fresh fake-indexeddb behind the fault wrapper */
function profile() {
  const real = new IDBFactory();
  return { real, faults: faultyFactory(real) };
}

describeJournalStore('memory', { make: () => createMemoryJournal() });
describeJournalStore('NewTabNoteJournal (fake-indexeddb)', {
  make: () => {
    const store = createJournalDatabase({ indexedDB: profile().faults.factory });
    opened.push(store);
    return store;
  },
});

describe('NewTabNoteJournal (#35 slice 3, "The journal")', () => {
  it('has one store, entries, keyed by opId, with its three indexes, frozen at version 1', async () => {
    const { real, faults } = profile();
    const store = createJournalDatabase({ indexedDB: faults.factory });
    opened.push(store);
    assert.equal(await journalExists(real), false, 'no database before the first open');
    await store.open();
    assert.equal(await journalExists(real), true);
    assert.equal(JOURNAL_DB_VERSION, 1);
    const db = /** @type {IDBDatabase} */ (
      await new Promise(resolve => {
        const request = real.open(JOURNAL_DB_NAME);
        request.onsuccess = () => resolve(request.result);
      })
    );
    assert.equal(db.version, 1);
    assert.deepEqual([...db.objectStoreNames], [JOURNAL_STORE]);
    const objectStore = db.transaction([JOURNAL_STORE]).objectStore(JOURNAL_STORE);
    assert.deepEqual(
      {
        keyPath: objectStore.keyPath,
        autoIncrement: objectStore.autoIncrement,
        indexes: [...objectStore.indexNames].sort(),
        unique: [...objectStore.indexNames].filter(index => objectStore.index(index).unique),
      },
      { keyPath: 'opId', autoIncrement: false, indexes: ['createdAt', 'noteId', 'ownerSessionId'], unique: [] },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(JOURNAL_DB_STORES)), {
      entries: { keyPath: 'opId', autoIncrement: false, indexes: ['noteId', 'ownerSessionId', 'createdAt'] },
    });
    db.close();
  });

  it('writes in one strict readwrite transaction over entries, and reads in a readonly one', async () => {
    const { faults } = profile();
    const store = createJournalDatabase({ indexedDB: faults.factory });
    opened.push(store);
    await store.open();
    faults.transactions.length = 0;
    await store.put(entryOf('c1'));
    await store.mark('c1', { code: 'note-not-found', at: 1 });
    await store.list();
    await store.remove(['c1']);
    assert.deepEqual(
      faults.transactions.map(({ names, mode, durability }) => [names, mode, durability]),
      [
        [['entries'], 'readwrite', 'strict'],
        [['entries'], 'readwrite', 'strict'],
        [['entries'], 'readonly', undefined],
        [['entries'], 'readwrite', 'strict'],
      ],
    );
  });

  it("issues a put's transaction in the task that calls it, once the database is open", async () => {
    const { faults } = profile();
    const store = createJournalDatabase({ indexedDB: faults.factory });
    opened.push(store);
    await store.open();
    const before = faults.transactions.length;
    const put = store.put(entryOf('c1'));
    // A page's save opens its transaction in its own task (kernel.js), so the entry beside it has to
    assert.equal(faults.transactions.length, before + 1);
    await put;
  });

  it('answers a write only once it committed: one that aborts is stored nowhere, and a transient one runs once more', async () => {
    const { faults } = profile();
    const store = createJournalDatabase({ indexedDB: faults.factory });
    opened.push(store);
    await store.open();
    const refused = faults.abortAfterNextWrite('entries', 'QuotaExceededError');
    await assert.rejects(store.put(entryOf('c1')), { code: 'quota' });
    await refused;
    assert.deepEqual(await store.list(), []);
    const transient = faults.abortAfterNextWrite('entries', 'UnknownError');
    await store.put(entryOf('c2'));
    await transient;
    assert.deepEqual(
      (await store.list()).map(entry => entry.opId),
      ['c2'],
    );
  });

  it('refuses a newer database and leaves it as it was', async () => {
    const { real, faults } = profile();
    await new Promise(resolve => {
      const request = real.open(JOURNAL_DB_NAME, 2);
      request.onupgradeneeded = () => request.result.createObjectStore('future');
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
    });
    const store = createJournalDatabase({ indexedDB: faults.factory });
    opened.push(store);
    await assert.rejects(store.open(), { code: 'version-too-new' });
    await assert.rejects(store.put(entryOf('c1')), { code: 'version-too-new' });
    const db = /** @type {IDBDatabase} */ (
      await new Promise(resolve => {
        const request = real.open(JOURNAL_DB_NAME);
        request.onsuccess = () => resolve(request.result);
      })
    );
    assert.equal(db.version, 2);
    assert.deepEqual([...db.objectStoreNames], ['future']);
    db.close();
  });
});

describe('InContextStores (#35, "In-context writes")', () => {
  it('opens nothing until the journal is asked for, then gives the context one connection', async () => {
    const { real, faults } = profile();
    const stores = inContextStores({ indexedDB: faults.factory });
    assert.equal(await stores.journalExists(), false);
    assert.deepEqual(faults.connections, []);
    const journal = stores.journal();
    opened.push(journal);
    assert.equal(stores.journal(), journal);
    await journal.open();
    await journal.put(entryOf('c1'));
    assert.equal(faults.connections.length, 1);
    assert.equal(await stores.journalExists(), true);
    assert.equal(await journalExists(real), true);
  });

  it("names each owner's lock by its session", () => {
    assert.equal(ownerLock('session-1'), 'journal.owner.session-1');
  });
});
