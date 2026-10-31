// #13's IdempotencyLedger and CommitLog port suites on #17's durable ledger and change log
// (#17 PR 2a): the `operations` and `changes` stores step 10 makes in a profile's CanvasTabDB,
// read on a connection as the adapter's are, and the ledger's retention sweep.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { appendChanges, createIndexedDbCommitLog, pruneChanges } from '../../js/kernel/adapters/indexeddb/changes.js';
import { createConnection } from '../../js/kernel/adapters/indexeddb/connection.js';
import {
  LEDGER_MAX_AGE_MS,
  LEDGER_SWEEP_EVERY_MS,
  SWEPT_KEY,
  createIndexedDbLedger,
  ledgerRow,
  sweepLedger,
} from '../../js/kernel/adapters/indexeddb/ledger.js';
import { result } from '../../js/kernel/adapters/indexeddb/requests.js';
import { isId } from '../../js/kernel/core/contracts/checks.js';
import { UnavailableError, committed } from '../../js/kernel/core/contracts/outcomes.js';
import { describeCommitLog } from './commit-log-suite.mjs';
import { describeIdempotencyLedger } from './idempotency-ledger-suite.mjs';
import { KeyRange, profile, recordsOf } from './storage-fixture.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/kernel/core/ports/idempotency-ledger.js').KeyedCommand} KeyedCommand */
/** @typedef {import('./storage-fixture.mjs').Profile} Profile */

/**
 * A profile's database at this build's version, opened as the worker opens it
 * @returns {Promise<{of: Profile, database: () => IDBDatabase, close: () => void}>}
 */
async function opened() {
  const of = profile();
  const connection = createConnection({ indexedDB: of.faults.factory, mode: 'versioned' });
  await connection.open();
  return { of, database: () => connection.database(), close: () => connection.close() };
}

/**
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
const completion = tx =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });

describeIdempotencyLedger({
  name: 'IndexedDB (#17)',
  async start() {
    const { of, database, close } = await opened();
    const ledger = createIndexedDbLedger({ database });
    return {
      ledger,
      // As the adapter keeps a row, in a strict transaction, unless the key has one
      async record(command, outcome) {
        if (!isId(/** @type {unknown} */ (command?.commandId)))
          throw new UnavailableError('adapter', 'invalid-key', false);
        const tx = database().transaction('operations', 'readwrite', { durability: 'strict' });
        const done = completion(tx);
        const store = tx.objectStore('operations');
        if (!(await result(store.get(command.commandId)))) store.put(ledgerRow(command, outcome, NOW));
        await done;
        return ledger.read(command);
      },
      failNextRead: async () => of.faults.failNextRead('operations', 'NotReadableError'),
      stored: () => recordsOf(of, 'operations'),
      close: async () => close(),
    };
  },
});

describeCommitLog({
  name: 'IndexedDB (#17)',
  async start() {
    const { of, database, close } = await opened();
    let ops = 0;
    return {
      log: createIndexedDbCommitLog({ database, keyRange: KeyRange }),
      append: changes => appendChanges(database(), changes, `op-${(ops += 1)}`),
      prune: through => pruneChanges(database(), KeyRange, through),
      failNextRead: async () => of.faults.failNextRead('meta', 'NotReadableError'),
      close: async () => close(),
    };
  },
});

describe("#17's change log rows", () => {
  it('keep ids, types, revisions, the commandId, and an empty ops, in the order the commit wrote them', async () => {
    const { of, database, close } = await opened();
    try {
      await appendChanges(
        database(),
        [
          { entityType: 'note', entityId: 'n2', revision: 3 },
          { entityType: 'folder', entityId: 'f1', revision: 0 },
        ],
        'c1',
      );
      assert.deepEqual(
        (await recordsOf(of, 'changes')).map(({ seq, entityType, entityId, revision, opId, ops, position }) => [
          seq,
          entityType,
          entityId,
          revision,
          opId,
          ops,
          position,
        ]),
        [
          [1, 'folder', 'f1', 0, 'c1', [], 1],
          [1, 'note', 'n2', 3, 'c1', [], 0],
        ],
      );
      assert.deepEqual(
        (await recordsOf(of, 'meta')).find(record => record.key === 'changes'),
        { key: 'changes', head: 1, floor: 0 },
      );
    } finally {
      close();
    }
  });
});

describe("#17's ledger retention (sweepLedger)", () => {
  /**
   * Puts `count` rows written at `at(index)`
   * @param {() => IDBDatabase} database
   * @param {number} count
   * @param {(index: number) => number} at
   */
  const fill = async (database, count, at) => {
    const tx = database().transaction('operations', 'readwrite');
    const done = completion(tx);
    for (let index = 0; index < count; index += 1) {
      /** @type {KeyedCommand} */
      const command = {
        type: 'setPinned',
        commandId: `c${String(index).padStart(5, '0')}`,
        noteId: 'n1',
        pinned: true,
      };
      tx.objectStore('operations').put(ledgerRow(command, committed('note-pinned', ['n1']), at(index)));
    }
    await done;
  };

  it('drops rows older than 30 days, oldest first in batches, and keeps the rest', async () => {
    const { of, database, close } = await opened();
    try {
      const old = NOW - LEDGER_MAX_AGE_MS - 1000;
      await fill(database, 250, index => (index < 230 ? old - index : NOW - index));
      const swept = await sweepLedger({ database, now: NOW, batch: 100 });
      assert.deepEqual(swept, { swept: true, deleted: 230 });
      const kept = await recordsOf(of, 'operations');
      assert.equal(kept.length, 20);
      assert.ok(kept.every(row => row.at >= NOW - LEDGER_MAX_AGE_MS));
      assert.deepEqual(
        (await recordsOf(of, 'meta')).find(record => record.key === SWEPT_KEY),
        { key: SWEPT_KEY, sweptAt: NOW },
      );
    } finally {
      close();
    }
  });

  it('drops the oldest rows past the row bound, however new', async () => {
    const { of, database, close } = await opened();
    try {
      await fill(database, 120, index => NOW - 1000 + index);
      assert.deepEqual(await sweepLedger({ database, now: NOW, maxRows: 50, batch: 30 }), { swept: true, deleted: 70 });
      const kept = (await recordsOf(of, 'operations')).map(row => row.opId).sort();
      assert.deepEqual(
        kept,
        Array.from({ length: 50 }, (_, index) => `c${String(index + 70).padStart(5, '0')}`),
      );
    } finally {
      close();
    }
  });

  it('sweeps at most once a day, and finishes a sweep that was cut off the next time', async () => {
    const { of, database, close } = await opened();
    try {
      const old = NOW - LEDGER_MAX_AGE_MS - 1000;
      await fill(database, 10, index => old - index);
      // The worker stops after the first batch, so the second can't start
      let batches = 0;
      const stopping = () =>
        new Proxy(database(), {
          get(target, property) {
            if (property === 'transaction') {
              return (
                /** @type {string[]} */ names,
                /** @type {IDBTransactionMode} */ mode,
                /** @type {any} */ options,
              ) => {
                if (mode === 'readwrite' && String(names) === 'operations' && ++batches > 1) {
                  throw new DOMException('The worker stopped', 'AbortError');
                }
                return target.transaction(names, mode, options);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      await assert.rejects(sweepLedger({ database: stopping, now: NOW, batch: 4 }), UnavailableError);
      assert.equal((await recordsOf(of, 'operations')).length, 6);
      // Its record is written only at the end, so the next start sweeps again and finishes it
      assert.equal(
        (await recordsOf(of, 'meta')).find(record => record.key === SWEPT_KEY),
        undefined,
      );
      assert.deepEqual(await sweepLedger({ database, now: NOW, batch: 4 }), { swept: true, deleted: 6 });
      await fill(database, 3, index => old - index);
      assert.deepEqual(await sweepLedger({ database, now: NOW + LEDGER_SWEEP_EVERY_MS - 1 }), {
        swept: false,
        deleted: 0,
      });
      assert.equal((await recordsOf(of, 'operations')).length, 3);
      assert.deepEqual(await sweepLedger({ database, now: NOW + LEDGER_SWEEP_EVERY_MS }), { swept: true, deleted: 3 });
    } finally {
      close();
    }
  });

  it('does nothing on a database below version 10, which keeps no ledger', async () => {
    const of = profile();
    const env = (await import('./storage-fixture.mjs')).legacyEnv;
    await env.createDatabase(of.real, {});
    const connection = createConnection({ indexedDB: of.faults.factory, mode: 'existing' });
    await connection.open();
    try {
      assert.deepEqual(await sweepLedger({ database: () => connection.database(), now: NOW }), {
        swept: false,
        deleted: 0,
      });
    } finally {
      connection.close();
    }
  });
});
