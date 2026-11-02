// #17 PR 4a, R88's read of #121: what #17's adapter, as the new tab's root opens it, answers when
// its connection goes while a command's transaction or a read is open. connection.js's header
// says every call on a connection that's gone answers reload-required, which no resend fixes. Two
// ways it goes: Chrome closing it (the database deleted, or its storage failing), and another
// context's upgrade, whose close waits for what's open.
//
// Chrome closes it in an order of its own, which e2e/connection-closing.spec.js pins: it aborts
// what's open on the connection, whose requests fail while the connection still takes a new
// transaction, and the page hears of the close only after those aborts. A transaction opened in
// between never runs: the close fails its requests and fires neither complete nor abort for it.
// So a read in flight answers transaction-failed, as next's legacy adapter's and 1.4.1's did
// there, and every call once the close has reached the page answers reload-required. A command's
// run again, and any call that starts between the two, opens a transaction the close catches:
// the adapter takes the connection's close as that transaction's end, and the closing check
// makes it reload-required. Before, a command waited on that transaction for good.
//
// R88's mid-command-close probe, adopted, with Chrome's order in place of a close that came with
// the abort, the saves an abort finds overtaken, the worker's ports, a read that starts between
// the abort and the close, an upgrade that lands at 8, and the worker's own open, whose upgrade
// IndexedDB refuses a transaction during as it does on a closing connection. The command cases
// time out where a command waits for good.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { createNewTabAdapter } from '../../js/kernel/composition/newtab.js';
import { createKernel } from './test-kernel.mjs';
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
 * open on that connection, whose requests fail with an AbortError and which fire abort, while the
 * connection still takes a new transaction. Nothing opened on the connection after that runs.
 * The close reaches the page a task after those aborts have: every transaction still open then
 * fails its requests and fires neither complete nor abort, the connection refuses new ones, and
 * close fires, before those requests' errors. fake-indexeddb runs what's opened and fires abort
 * for what it aborts, so this holds the connection with a transaction that never ends until the
 * close, and drops complete and abort for what the close catches.
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
  /** @type {IDBDatabase | null} */
  let closing = null;
  /** @type {() => void} */
  let reached = () => {};
  /** @type {Promise<void>} */
  const closed = new Promise(resolve => {
    reached = resolve;
  });
  /**
   * The close catches `tx`: its requests fail, and neither complete nor abort reaches anyone
   * @param {IDBTransaction} tx
   */
  const caught = tx => {
    const quiet = /** @type {any} */ (tx);
    const dispatch = quiet.dispatchEvent.bind(quiet);
    quiet.dispatchEvent = (/** @type {Event} */ event) =>
      event.type === 'abort' || event.type === 'complete' ? true : dispatch(event);
    try {
      tx.abort();
    } catch {
      // It finished already
    }
  };
  const closeReaches = () => {
    if (phase === 'closed' || !closing) return;
    phase = 'closed';
    for (const tx of opened) caught(tx);
    fake.forceCloseDatabase(closing);
    reached();
  };
  /**
   * The browser's side of the close: what's open aborts, and nothing opened after runs, as a
   * transaction over every store that ends only at the close holds the connection
   * @param {IDBDatabase} db
   */
  const browserAborts = db => {
    closing = db;
    let left = 0;
    for (const tx of [...opened]) {
      try {
        tx.abort();
      } catch {
        // It finished already
        continue;
      }
      left += 1;
      tx.addEventListener('abort', () => {
        left -= 1;
        if (left > 0 || phase !== 'aborting') return;
        phase = 'aborted';
        if (onAborted) onAborted();
        setImmediate(closeReaches);
      });
    }
    const names = [...db.objectStoreNames];
    const held = transaction.call(db, names, 'readwrite');
    opened.push(held);
    const holding = held.objectStore(names[0]);
    const next = () => {
      const request = holding.get('ntn-held');
      request.onsuccess = () => {
        if (phase !== 'closed') next();
      };
      request.onerror = () => {};
    };
    next();
    if (left === 0) {
      phase = 'aborted';
      setImmediate(closeReaches);
    }
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
    if (closing && closing !== db) return tx;
    opened.push(tx);
    if (phase === 'open' && (txMode || 'readonly') === mode && [names].flat().includes(store)) {
      phase = 'aborting';
      queueMicrotask(() => browserAborts(db));
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
  it('Chrome closes it while a command commits: reload-required once its run again fails there, nothing written, and the next call the same', { timeout: 10_000 }, async () => {
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

  it("another context's upgrade lands while a command commits at 8, with no ledger to answer a resend: the command runs once and answers committed", { timeout: 10_000 }, async () => {
    const of = await profileWith(/** @type {any} */ (synthesized().get('v8.basic')));
    const adapter = createNewTabAdapter({
      indexedDB: of.real,
      settings: of.chrome.api.storage.local,
      awaitUpgrade: async () => {},
      locks: null,
    });
    const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock });
    await adapter.open();
    const { transaction } = fake.IDBDatabase.prototype;
    let runs = 0;
    /** @type {Promise<void> | undefined} */
    let upgrade;
    /**
     * Each write over the notes, and the upgrade sent as the first opens
     * @this {IDBDatabase}
     * @param {string | string[]} names
     * @param {IDBTransactionMode} [txMode]
     * @param {IDBTransactionOptions} [options]
     */
    fake.IDBDatabase.prototype.transaction = function watched(names, txMode, options) {
      const tx = transaction.call(this, names, txMode, options);
      if (txMode === 'readwrite' && [names].flat().includes('canvases')) {
        runs += 1;
        if (!upgrade) {
          upgrade = legacyEnv
            .requestToPromise(of.real.open('CanvasTabDB', this.version + 1))
            .then((/** @type {IDBDatabase} */ opened) => opened.close());
        }
      }
      return tx;
    };
    let during;
    try {
      during = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'during', name: 'During' });
      await upgrade;
    } finally {
      fake.IDBDatabase.prototype.transaction = transaction;
    }
    // The close this adapter makes on versionchange fires no close event, and waits for the
    // command, which commits, so it isn't taken for the end of the command's transaction
    assert.equal(during.kind, 'committed', JSON.stringify(during));
    assert.equal(runs, 1, 'the command ran once');
    assert.ok(await noteIn(of, 'during'));
    assert.equal(adapter.openState(), 'version-changed');
    adapter.close();
  });

  it('Chrome closes it while two saves of one note are in flight: the older, which the newer overtook, transaction-failed, and the newer reload-required once its run again fails there', { timeout: 10_000 }, async () => {
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
