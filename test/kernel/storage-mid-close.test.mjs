// #17 PR 4a, R88's read of #121: what #17's adapter, as the new tab's root opens it, answers when
// its connection goes while a command's transaction or a read is open. connection.js's header
// says every call on a connection that's gone answers reload-required, which no resend fixes. Two
// ways it goes: Chrome closing it (the database deleted, or its storage failing), and another
// context's upgrade, whose close waits for what's open.
//
// Chrome closes it in an order of its own, which e2e/connection-closing.spec.js pins: it aborts
// what's open on the connection, whose requests fail while the connection still takes a new
// transaction, and the page hears of the close only after those aborts. So a read in flight
// answers transaction-failed, as next's legacy adapter's and 1.4.1's did there, and every call
// once the close has reached the page answers reload-required. A command's run again, and any
// call that starts between the two, fails once the close has reached the page, which the
// adapter's closing check turns into reload-required, where a command answered
// retries-exhausted before it.
//
// R88's mid-command-close probe, adopted, with Chrome's order in place of a close that came with
// the abort, the saves an abort finds overtaken, the worker's ports, a read that starts between
// the abort and the close, and the worker's own open, whose upgrade IndexedDB refuses a
// transaction during as it does on a closing connection.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { createNewTabAdapter } from '../../js/kernel/composition/newtab.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { dump, legacyEnv, newProfile, profileWith, recordsIn, run, synthesized } from './migration-support.mjs';
import { CALLERS } from './support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

/** @type {{IDBDatabase: typeof IDBDatabase, forceCloseDatabase: (db: IDBDatabase) => void}} */
const fake = createRequire(import.meta.url)('fake-indexeddb');

let count = 0;
const ids = { next: () => `mc-${(count += 1)}` };
const clock = { now: () => Date.UTC(2026, 9, 31, 12), zone: () => 'UTC' };

/**
 * v8.basic after the worker's run, and the new tab's kernel on it, as its root opens #17's
 * adapter, with the backup tasks the root turns on
 */
async function newTab() {
  const of = await profileWith(/** @type {any} */ (synthesized().get('v8.basic')));
  assert.equal((await run(of)).status, 'migrated');
  const adapter = createNewTabAdapter({
    indexedDB: of.real,
    settings: of.chrome.api.storage.local,
    awaitUpgrade: async () => {},
    locks: null,
  });
  const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock });
  await adapter.open();
  return { of, adapter, kernel };
}

/**
 * Runs `then(db, tx)` once, as the first transaction of `mode` over `store` opens on any connection
 * @param {IDBTransactionMode} mode
 * @param {string} store
 * @param {(db: IDBDatabase, tx: IDBTransaction) => void} then
 * @returns {() => void} what takes the watch off
 */
function onFirst(mode, store, then) {
  const { transaction } = fake.IDBDatabase.prototype;
  let done = false;
  /**
   * @this {IDBDatabase}
   * @param {string | string[]} names
   * @param {IDBTransactionMode} [txMode]
   * @param {IDBTransactionOptions} [options]
   */
  fake.IDBDatabase.prototype.transaction = function watched(names, txMode, options) {
    const tx = transaction.call(this, names, txMode, options);
    if (!done && (txMode || 'readonly') === mode && [names].flat().includes(store)) {
      done = true;
      then(this, tx);
    }
    return tx;
  };
  return () => {
    fake.IDBDatabase.prototype.transaction = transaction;
  };
}

/**
 * Chrome's forced close of a connection, in Chrome's order (e2e/connection-closing.spec.js).
 * Once the first transaction of `mode` over `store` opens, the browser aborts each transaction
 * open on that connection, and any that opens before those aborts have reached the page, whose
 * requests fail with an AbortError while the connection still takes a new transaction. The close
 * reaches the page only after the aborts have: as the next transaction opens on the connection,
 * which the browser never runs, or a task later when none does. Then every transaction still
 * open on it aborts, the connection refuses new ones, and close fires once they've finished.
 * fake-indexeddb's forceCloseDatabase lets an open transaction finish, so this aborts each.
 * @param {IDBTransactionMode} mode
 * @param {string} store
 * @param {{onAborted?: () => void}} [options] - runs as the aborts reach the page, before the close does
 * @returns {{unwatch: () => void, closed: Promise<void>}} `closed` resolves once the close has reached the page
 */
function chromeCloses(mode, store, { onAborted } = {}) {
  const { transaction } = fake.IDBDatabase.prototype;
  /** @type {IDBTransaction[]} */
  const opened = [];
  /** @type {'open' | 'aborting' | 'aborted' | 'closed'} */
  let phase = 'open';
  let left = 0;
  /** @type {() => void} */
  let reached = () => {};
  /** @type {Promise<void>} */
  const closed = new Promise(resolve => {
    reached = resolve;
  });
  /** @param {IDBDatabase} db */
  const closeReaches = db => {
    if (phase === 'closed') return;
    phase = 'closed';
    for (const tx of opened) {
      try {
        tx.abort();
      } catch {
        // It finished already
      }
    }
    fake.forceCloseDatabase(db);
    reached();
  };
  /**
   * @param {IDBDatabase} db
   * @param {IDBTransaction} tx
   */
  const browserAborts = (db, tx) => {
    try {
      tx.abort();
    } catch {
      // It finished already, or it's aborting
      return;
    }
    left += 1;
    tx.addEventListener('abort', () => {
      left -= 1;
      if (left > 0 || phase !== 'aborting') return;
      phase = 'aborted';
      if (onAborted) onAborted();
      setImmediate(() => closeReaches(db));
    });
  };
  /**
   * @this {IDBDatabase}
   * @param {string | string[]} names
   * @param {IDBTransactionMode} [txMode]
   * @param {IDBTransactionOptions} [options]
   */
  fake.IDBDatabase.prototype.transaction = function watched(names, txMode, options) {
    const tx = transaction.call(this, names, txMode, options);
    const db = this;
    opened.push(tx);
    if (phase === 'aborting') {
      queueMicrotask(() => (phase === 'aborting' ? browserAborts(db, tx) : closeReaches(db)));
    } else if (phase === 'aborted') {
      queueMicrotask(() => closeReaches(db));
    } else if (phase === 'open' && (txMode || 'readonly') === mode && [names].flat().includes(store)) {
      phase = 'aborting';
      queueMicrotask(() => {
        for (const each of [...opened]) browserAborts(db, each);
      });
    }
    return tx;
  };
  return {
    unwatch: () => {
      fake.IDBDatabase.prototype.transaction = transaction;
    },
    closed,
  };
}

/** @param {any} outcome */
const answer = outcome => [outcome.kind, outcome.cause ?? null, outcome.code ?? null, outcome.retryable ?? null];

/**
 * What a call rejected with, as its cause, code, and whether a resend can work, or `answered`
 * @param {Promise<unknown>} call
 */
const rejection = call =>
  call.then(
    () => 'answered',
    (/** @type {any} */ error) => [error.unavailableCause, error.code, error.retryable],
  );

/**
 * @param {Profile} of
 * @param {string} id
 */
const noteIn = async (of, id) =>
  recordsIn(await dump(of), 'CanvasTabDB', 'canvases').find((/** @type {any} */ record) => record.key === id)?.value;

const RELOAD = ['unavailable', 'storage', 'reload-required', false];

describe("#17's adapter, as the new tab's root opens it, when its connection goes while a call runs (#17 PR 4a)", () => {
  it('Chrome closes it while a command commits: reload-required once its run again fails there, nothing written, and the next call the same', async () => {
    const { of, adapter, kernel } = await newTab();
    const chrome = chromeCloses('readwrite', 'canvases');
    let during;
    try {
      during = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'during', name: 'During' });
    } finally {
      chrome.unwatch();
    }
    const next = await kernel.execute({ type: 'createNote', commandId: 'c2', noteId: 'after', name: 'After' });
    // Without the closing check, the run again's failure answered retries-exhausted
    assert.deepEqual(answer(during), RELOAD);
    assert.deepEqual(answer(next), RELOAD);
    assert.deepEqual([Boolean(await noteIn(of, 'during')), Boolean(await noteIn(of, 'after'))], [false, false]);
    assert.equal(adapter.openState(), 'closed-by-browser');
    adapter.close();
  });

  it('Chrome closes it while a query reads: transaction-failed, as Chrome aborts the read before the page hears of the close, and reload-required once it has', async () => {
    const { adapter, kernel } = await newTab();
    const chrome = chromeCloses('readonly', 'canvases');
    let during;
    try {
      during = await kernel.query({ type: 'listNotes', view: 'active' });
      await chrome.closed;
    } finally {
      chrome.unwatch();
    }
    const next = await kernel.query({ type: 'listNotes', view: 'active' });
    assert.deepEqual(answer(during), ['failed', 'storage', 'transaction-failed', null]);
    assert.deepEqual(answer(next), ['failed', 'storage', 'reload-required', null]);
    adapter.close();
  });

  it('Chrome closes it while Export JSON reads: transaction-failed, and no file, then reload-required', async () => {
    const { adapter, kernel } = await newTab();
    const chrome = chromeCloses('readonly', 'elements');
    let during;
    try {
      during = await kernel.query({ type: 'exportBackup', backup: false });
      await chrome.closed;
    } finally {
      chrome.unwatch();
    }
    const next = await kernel.query({ type: 'exportBackup', backup: false });
    assert.deepEqual(answer(during), ['failed', 'storage', 'transaction-failed', null]);
    assert.deepEqual(answer(next), ['failed', 'storage', 'reload-required', null]);
    adapter.close();
  });

  it('Chrome closes it while the automatic backup reads: transaction-failed, and no backup kept', async () => {
    const { of, adapter, kernel } = await newTab();
    const chrome = chromeCloses('readonly', 'elements');
    let during;
    try {
      during = await kernel.execute({ type: 'createAutoBackup', commandId: 'b1' });
      await chrome.closed;
    } finally {
      chrome.unwatch();
    }
    assert.deepEqual(answer(during), ['unavailable', 'storage', 'transaction-failed', true]);
    assert.deepEqual(
      Object.keys(of.chrome.local).filter(key => key.startsWith('auto_backup_')),
      [],
    );
    adapter.close();
  });

  it("a read that starts once Chrome's aborts have reached the page, before its close does: reload-required", async () => {
    const { adapter, kernel } = await newTab();
    /** @type {Promise<unknown> | undefined} */
    let between;
    const chrome = chromeCloses('readonly', 'canvases', {
      onAborted: () => {
        between = rejection(adapter.read(['notes'], async tx => tx.getAll('notes')));
      },
    });
    let during;
    try {
      during = await kernel.query({ type: 'listNotes', view: 'active' });
      await chrome.closed;
    } finally {
      chrome.unwatch();
    }
    assert.deepEqual(answer(during), ['failed', 'storage', 'transaction-failed', null]);
    // Its transaction opened on a connection the browser had closed, so it fails as the close
    // arrives, and the closing check sees the connection refuse a transaction
    assert.deepEqual(await between, ['storage', 'reload-required', false]);
    adapter.close();
  });

  it("another context's upgrade lands while a command commits: the command commits, and the next call is reload-required", async () => {
    const { of, adapter, kernel } = await newTab();
    /** @type {Promise<void> | undefined} */
    let upgrade;
    const unwatch = onFirst('readwrite', 'canvases', db => {
      upgrade = legacyEnv
        .requestToPromise(of.real.open('CanvasTabDB', db.version + 1))
        .then((/** @type {IDBDatabase} */ opened) => opened.close());
    });
    let during;
    try {
      during = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'during', name: 'During' });
    } finally {
      unwatch();
    }
    await upgrade;
    const next = await kernel.execute({ type: 'createNote', commandId: 'c2', noteId: 'after', name: 'After' });
    // The close waits for the open transaction, so the command commits, and the next call can't
    assert.equal(during.kind, 'committed', JSON.stringify(during));
    assert.deepEqual(answer(next), RELOAD);
    assert.deepEqual([Boolean(await noteIn(of, 'during')), Boolean(await noteIn(of, 'after'))], [true, false]);
    assert.equal(adapter.openState(), 'version-changed');
    adapter.close();
  });

  it('Chrome closes it while two saves of one note are in flight: the older, which the newer overtook, transaction-failed, and the newer reload-required once its run again fails there', async () => {
    const { of, adapter, kernel } = await newTab();
    await kernel.execute({
      type: 'createNote',
      commandId: 'seed',
      noteId: 'n1',
      blocks: [{ id: 'b1', content: 'v0' }],
    });
    const chrome = chromeCloses('readwrite', 'elements');
    /** @type {any[]} */
    let answers;
    try {
      /** @param {string} commandId @param {string} content */
      const save = (commandId, content) =>
        kernel.execute({ type: 'saveNoteContent', commandId, noteId: 'n1', blocks: [{ id: 'b1', content }] });
      answers = await Promise.all([save('a', 'older'), save('b', 'newer')]);
    } finally {
      chrome.unwatch();
    }
    // The older isn't run again, as the newer opened behind it. Without the closing check the
    // newer's run again answered retries-exhausted.
    assert.deepEqual(answers.map(answer), [['unavailable', 'storage', 'transaction-failed', true], RELOAD]);
    const block = recordsIn(await dump(of), 'CanvasTabDB', 'elements').find(
      (/** @type {any} */ record) => record.key === 'b1',
    );
    assert.equal(block?.value.content, 'v0', 'neither save landed');
    assert.equal(adapter.openState(), 'closed-by-browser');
    adapter.close();
  });

  it("Chrome closes it while the worker's ports read: the change log, the ledger, and its sweep answer transaction-failed, as a read does", async () => {
    /** @type {Array<[string, (adapter: import('../../js/kernel/adapters/indexeddb/adapter.js').IndexedDbAdapter) => Promise<unknown>]>} */
    const calls = [
      ['changes', adapter => adapter.commitLog.readChangesSince(0, 10)],
      [
        'operations',
        adapter =>
          adapter.ledger.read(/** @type {any} */ ({ type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'N' })),
      ],
      ['meta', adapter => adapter.sweepLedger()],
    ];
    for (const [store, call] of calls) {
      const { adapter } = await newTab();
      const chrome = chromeCloses('readonly', store);
      let failure;
      try {
        failure = await rejection(call(adapter));
        await chrome.closed;
      } finally {
        chrome.unwatch();
      }
      assert.deepEqual(failure, ['storage', 'transaction-failed', true], store);
      assert.deepEqual(await rejection(call(adapter)), ['storage', 'reload-required', false], store);
      assert.equal(adapter.openState(), 'closed-by-browser', store);
      adapter.close();
    }
  });
});

describe("#17's adapter while the worker's open makes the database (#17 PR 4a)", () => {
  it('a call during the upgrade answers open-pending, never reload-required, though IndexedDB refuses a transaction there as on a closing connection', async () => {
    const of = newProfile();
    const adapter = createIndexedDbAdapter({
      indexedDB: of.real,
      settings: of.chrome.api.storage.local,
      mode: 'versioned',
    });
    const { createObjectStore } = fake.IDBDatabase.prototype;
    /** @type {{refused: string, answers: Promise<unknown>[]} | null} */
    let upgrading = null;
    /**
     * The registry's first step, in the open's upgrade: what a transaction over no store is
     * refused with there, and what each call answers meanwhile
     * @this {IDBDatabase}
     * @param {string} name
     * @param {IDBObjectStoreParameters} [options]
     */
    fake.IDBDatabase.prototype.createObjectStore = function watched(name, options) {
      if (!upgrading) {
        let refused = 'nothing';
        try {
          this.transaction([], 'readonly');
        } catch (error) {
          refused = /** @type {Error} */ (error).name;
        }
        upgrading = {
          refused,
          answers: [
            rejection(adapter.read(['notes'], async () => 'read')),
            rejection(adapter.readSettings('idbSettings', ['insightsEnabled'])),
            rejection(
              adapter.ledger.read(
                /** @type {any} */ ({ type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'N' }),
              ),
            ),
          ],
        };
      }
      return createObjectStore.call(this, name, options);
    };
    try {
      await adapter.open();
    } finally {
      fake.IDBDatabase.prototype.createObjectStore = createObjectStore;
    }
    const seen = /** @type {{refused: string, answers: Promise<unknown>[]} | null} */ (upgrading);
    assert.ok(seen, 'the open made the database');
    // The spec's first check of transaction(): refused, as on a closing connection, while the
    // connection's upgrade runs. The closing check asks only once the connection is open.
    assert.equal(seen.refused, 'InvalidStateError');
    const pending = ['storage', 'open-pending', true];
    assert.deepEqual(await Promise.all(seen.answers), [pending, pending, pending]);
    assert.equal(adapter.openState(), 'open');
    assert.equal(await adapter.read(['notes'], async () => 'read'), 'read');
    adapter.close();
  });
});
