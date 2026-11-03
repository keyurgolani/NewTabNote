// #35 slice 3's worker journal (js/kernel/composition/journal.js): the service worker's own
// entries, written before a capture is sent and removed once it's answered for good, and the
// coordinator's drain of every context's, under Web Lock journal.replay. It opens nothing until
// a capture or a drain needs the journal, holds its owner lock before its first entry, leaves an
// entry in flight to its capture, and tells the diagnostic journal what it couldn't replay.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import { createWorkerJournal } from '../../js/kernel/composition/journal.js';
import { WORKER_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { WORKER_CATALOG } from '../../js/kernel/core/contracts/worker-catalog.js';
import { journalEntry } from '../../js/kernel/core/domain/journal.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { faultyFactory } from './storage-faults.mjs';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';
import { createKernel } from './test-kernel.mjs';

const { IDBFactory } = createRequire(import.meta.url)('fake-indexeddb');

/** This worker instance's id */
const INSTANCE = 'coordinator-1';

/**
 * Exclusive Web Locks, granted per name in request order, that log each request and grant, and
 * answer query() as navigator.locks does
 */
function locks() {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();
  /** @type {Map<string, number>} */
  const holding = new Map();
  /** @type {string[]} */
  const log = [];
  return {
    log,
    /**
     * @template T
     * @param {string} name
     * @param {{mode: 'exclusive'}} options
     * @param {() => Promise<T>} callback
     * @returns {Promise<T>}
     */
    request(name, options, callback) {
      log.push(`request ${name}`);
      const turn = (tails.get(name) || Promise.resolve()).then(() => {
        log.push(`granted ${name}`);
        holding.set(name, (holding.get(name) || 0) + 1);
        return callback();
      });
      const release = () => holding.set(name, /** @type {number} */ (holding.get(name)) - 1);
      turn.then(release, release);
      tails.set(
        name,
        turn.catch(() => {}),
      );
      return turn;
    },
    async query() {
      return { held: [...holding].filter(([, count]) => count > 0).map(([name]) => ({ name })) };
    },
  };
}

/**
 * A worker's journal on a fresh fake-indexeddb, with the worker's kernel on a memory adapter
 * @param {{factory?: IDBFactory}} [options]
 */
function worker({ factory } = {}) {
  const real = new IDBFactory();
  const faults = faultyFactory(real);
  const manager = locks();
  /** @type {Array<[string, unknown, unknown]>} */
  const events = [];
  /** @type {string[]} */
  const notified = [];
  /** @type {Array<[string, unknown]>} */
  const warned = [];
  const clock = testClock();
  const journal = createWorkerJournal({
    instanceId: INSTANCE,
    stores: inContextStores({ indexedDB: factory || faults.factory }),
    locks: /** @type {any} */ (manager),
    clock,
    events: { event: (code, fields, failure) => events.push([code, fields, failure]) },
    notify: entry => notified.push(entry.opId),
    warn: (event, error) => warned.push([event, error]),
  });
  const adapter = createMemoryAdapter();
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(WORKER_CATALOG),
    caller: CALLERS['worker-internal'],
    handlers: WORKER_HANDLERS,
    ids: testIds('worker'),
    clock,
  });
  /** @type {string[]} */
  const sent = [];
  const client = {
    /** @param {any} command */
    execute: command => {
      sent.push(command.commandId);
      return kernel.execute(command);
    },
    /** @param {any} query */
    query: query => kernel.query(query),
  };
  return { real, faults, manager, events, notified, warned, journal, kernel, client, sent, adapter, clock };
}

/**
 * A capture as js/background.js builds it
 * @param {string} commandId
 * @param {{at?: number}} [options]
 */
const capture = (commandId, { at = NOW } = {}) => ({
  type: /** @type {const} */ ('captureToDailyNote'),
  commandId,
  noteId: `daily-${commandId}`,
  blockId: `block-${commandId}`,
  capture: { type: 'text', content: 'A quote' },
  at,
});

/**
 * The entries in `real`'s journal, by opId
 * @param {IDBFactory} real
 * @returns {Promise<string[]>}
 */
async function storedIn(real) {
  const database = /** @type {IDBDatabase} */ (
    await new Promise((resolve, reject) => {
      const request = real.open('NewTabNoteJournal');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })
  );
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(['entries']).objectStore('entries').getAllKeys();
      request.onsuccess = () => resolve(/** @type {string[]} */ (request.result));
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

describe("the worker's journal (#35 slice 3)", () => {
  it('opens nothing as it is built, and takes its owner lock before its first entry', async () => {
    const w = worker();
    assert.equal(w.faults.connections.length, 0);
    assert.equal(w.manager.log.length, 0);
    assert.equal(await w.journal.keep(capture('c1'), { noteId: 'daily-c1' }), true);
    assert.deepEqual(w.manager.log, ['request journal.owner.coordinator-1', 'granted journal.owner.coordinator-1']);
    assert.deepEqual(await storedIn(w.real), ['c1']);
    // Held for as long as the worker lives
    assert.deepEqual((await w.manager.query()).held, [{ name: 'journal.owner.coordinator-1' }]);
    await w.journal.keep(capture('c2'), { noteId: 'daily-c2' });
    assert.equal(w.manager.log.filter(line => line.startsWith('request journal.owner')).length, 1);
  });

  it('writes a capture as the worker sends it, under its own instance, removed once it is answered for good', async () => {
    const w = worker();
    await w.journal.keep(capture('c1'), { noteId: 'daily-c1' });
    await w.journal.settle('c1');
    assert.deepEqual(await storedIn(w.real), []);
  });

  it("leaves its own entry in flight to its capture, and replays it once it's released", async () => {
    const w = worker();
    await w.journal.keep(capture('c1', { at: NOW - 24 * 60 * 60 * 1000 }), { noteId: 'daily-c1' });
    const held = await w.journal.drain(w.client);
    assert.deepEqual([held?.status, held?.replayed, held?.left], ['drained', 0, 1]);
    assert.deepEqual(w.sent, []);
    assert.equal(w.journal.oldestOrphanedEntryAt(), null, 'one in flight has a live owner');
    w.journal.release('c1');
    const replayed = await w.journal.drain(w.client);
    assert.deepEqual([replayed?.replayed, replayed?.left], [1, 0]);
    assert.deepEqual(w.sent, ['c1']);
    assert.deepEqual(await storedIn(w.real), []);
    // It landed in the day it was made, and resolves the capture incident its failure raised
    const daily = await w.adapter.read(['notes'], tx => tx.get('notes', 'daily-c1'));
    assert.equal(daily?.dateStr, '2026-10-19');
    assert.deepEqual(w.events, [['capture.committed', {}, undefined]]);
    assert.equal(w.journal.oldestOrphanedEntryAt(), null);
  });

  it('answers false for an entry it could not write, and warns, so the capture runs as it did before', async () => {
    const real = new IDBFactory();
    const faults = faultyFactory(real);
    faults.failNextOpen('NewTabNoteJournal', 'UnknownError');
    const w = worker({ factory: faults.factory });
    assert.equal(await w.journal.keep(capture('c1'), { noteId: 'daily-c1' }), false);
    assert.deepEqual(
      w.warned.map(([event]) => event),
      ['entry-not-written'],
    );
    // Nothing of it is in flight, so nothing keeps a later drain from it
    assert.equal(await w.journal.keep(capture('c2'), { noteId: 'daily-c2' }), true);
  });

  it('reads no journal and makes none on a profile that has none', async () => {
    const w = worker();
    assert.equal(await w.journal.drain(w.client), null);
    assert.deepEqual(w.faults.connections, []);
    assert.deepEqual(await w.real.databases(), []);
    assert.equal(w.journal.oldestOrphanedEntryAt(), null);
  });

  it('drains under journal.replay, and runs once more after one asked for while it ran', async () => {
    const w = worker();
    await w.journal.keep(capture('c1'), { noteId: 'daily-c1' });
    w.journal.release('c1');
    const first = w.journal.drain(w.client);
    const second = w.journal.drain(w.client);
    assert.equal(second, first, 'one asked for meanwhile shares the drain, which runs again');
    const result = await first;
    assert.deepEqual([result?.replayed, result?.left], [1, 0]);
    assert.deepEqual(
      w.manager.log.filter(line => line.endsWith('journal.replay')),
      ['request journal.replay', 'granted journal.replay', 'request journal.replay', 'granted journal.replay'],
    );
  });

  it("tells the diagnostic journal of an entry it can't replay, by why and the surface that wrote it, and notifies for a capture", async () => {
    const w = worker();
    // A newer build's capture, and a page's note it can't read, each orphaned
    const stores = inContextStores({ indexedDB: w.faults.factory });
    const database = stores.journal();
    await database.open();
    await database.put(
      journalEntry({
        command: /** @type {any} */ (capture('c-newer')),
        v: 2,
        noteId: 'daily-c-newer',
        surface: 'worker-internal',
        ownerSessionId: 'coordinator-0',
        seq: 1,
        createdAt: NOW - 5000,
      }),
    );
    await database.put(
      journalEntry({
        command: { type: 'renameNote', commandId: 'c-rename', noteId: 'n1', name: 'Later' },
        v: 1,
        noteId: 'n1',
        surface: 'newtab',
        ownerSessionId: 'page-gone',
        seq: 1,
        createdAt: NOW - 1000,
      }),
    );
    database.close();
    const result = await w.journal.drain(w.client);
    assert.deepEqual([result?.replayed, result?.left], [0, 2]);
    assert.deepEqual(w.events, [
      ['journal.entry-unreplayable', { surface: 'worker-internal' }, { code: 'unsupported-version' }],
      ['journal.entry-unreplayable', { surface: 'newtab' }, { code: 'unknown-operation' }],
    ]);
    assert.deepEqual(w.notified, ['c-newer']);
    assert.equal(w.journal.oldestOrphanedEntryAt(), NOW - 5000);
    // Once each
    await w.journal.drain(w.client);
    assert.equal(w.events.length, 2);
    assert.deepEqual(w.notified, ['c-newer']);
  });
});
