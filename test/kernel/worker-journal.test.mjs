// #35 slice 3's worker journal (js/kernel/composition/journal.js): the service worker's own
// entries, written before a capture is sent and removed once it's answered for good, and the
// coordinator's drain of every context's, under Web Lock journal.replay. It opens nothing until
// a capture or a drain needs the journal, holds its owner lock before its first entry, leaves an
// entry in flight to its capture, and tells the diagnostic journal what it couldn't replay. Each
// replay is judged as the surface that wrote its entry, as the port router judges that surface's
// own request (#35 slice 4b-1, F5).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import { createWorkerJournal } from '../../js/kernel/composition/journal.js';
import { WORKER_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { WORKER_CATALOG } from '../../js/kernel/core/contracts/worker-catalog.js';
import { journalEntry } from '../../js/kernel/core/domain/journal.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryJournal } from '../../js/kernel/core/memory/journal.js';
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

  it("journals journal.append-failed, with the capture's note and the failure, for an entry it couldn't write, and raises no incident with it (#35 slice 4a)", async () => {
    const real = new IDBFactory();
    const faults = faultyFactory(real);
    faults.failNextOpen('NewTabNoteJournal', 'UnknownError');
    const w = worker({ factory: faults.factory });
    assert.equal(await w.journal.keep(capture('c1'), { noteId: 'daily-c1' }), false);
    assert.deepEqual(
      w.events.map(([code, fields]) => [code, fields]),
      [['journal.append-failed', { subjectId: 'daily-c1' }]],
    );
    assert.ok(w.events[0][2] && typeof w.events[0][2] === 'object', 'the failure, whose code the event keeps');
    // One it writes says nothing
    assert.equal(await w.journal.keep(capture('c2'), { noteId: 'daily-c2' }), true);
    assert.equal(w.events.length, 1);
  });

  it("journals journal.append-failed once in the worker's life: a second entry it can't write says so on the console alone (#204, F3)", async () => {
    const real = new IDBFactory();
    const faults = faultyFactory(real);
    faults.failNextOpen('NewTabNoteJournal', 'UnknownError');
    faults.failNextOpen('NewTabNoteJournal', 'UnknownError');
    const w = worker({ factory: faults.factory });
    assert.equal(await w.journal.keep(capture('c1'), { noteId: 'daily-c1' }), false);
    assert.equal(await w.journal.keep(capture('c2'), { noteId: 'daily-c2' }), false);
    assert.deepEqual(
      w.events.map(([code, fields]) => [code, fields]),
      [['journal.append-failed', { subjectId: 'daily-c1' }]],
    );
    assert.deepEqual(
      w.warned.map(([event]) => event),
      ['entry-not-written', 'entry-not-written'],
    );
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

  it("raises a stop's incident once for its life, where the entry's mark can't be written as on a full disk, and tells the kept capture nothing", async () => {
    const memory = createMemoryJournal();
    /** @type {import('../../js/kernel/core/ports/journal.js').JournalStore} */
    const journal = Object.freeze({
      open: () => memory.open(),
      put: (/** @type {any} */ entry) => memory.put(entry),
      list: () => memory.list(),
      inFlight: () => memory.inFlight(),
      remove: (/** @type {readonly string[]} */ opIds) => memory.remove(opIds),
      // A full disk refuses this write too
      mark: async () => {
        throw new UnavailableError('quota', 'quota', false);
      },
    });
    // The worker's own capture, which no capture of this instance holds in flight
    await memory.put(
      journalEntry({
        command: /** @type {any} */ (capture('c-kept')),
        v: 1,
        noteId: 'daily-c-kept',
        surface: 'worker-internal',
        ownerSessionId: INSTANCE,
        seq: 1,
        createdAt: NOW,
      }),
    );
    /** @type {Array<[string, unknown]>} */
    const events = [];
    /** @type {string[]} */
    const notified = [];
    const worked = createWorkerJournal({
      instanceId: INSTANCE,
      stores: /** @type {any} */ ({ journal: () => journal, journalExists: async () => true }),
      locks: null,
      clock: testClock(),
      events: { event: (code, fields, failure) => events.push([code, failure]) },
      notify: entry => notified.push(entry.opId),
      warn: () => {},
    });
    const { kernel } = worker();
    const full = {
      kind: 'unavailable',
      cause: 'quota',
      code: 'quota',
      retryable: false,
      messageKey: 'unavailable.quota',
      severity: 'error',
    };
    const client = {
      /** @param {any} command */
      execute: async command => (command.commandId === 'c-kept' ? full : kernel.execute(command)),
      /** @param {any} query */
      query: (/** @type {any} */ query) => kernel.query(query),
    };
    for (let run = 0; run < 3; run++) {
      const result = await worked.drain(/** @type {any} */ (client));
      assert.deepEqual([result?.status, result?.code, result?.left], ['stopped', 'quota', 1], `drain ${run + 1}`);
    }
    // Three drains stopped at it, and it was raised once. The capture is still kept, so it hears
    // nothing more than it heard when it was kept
    assert.deepEqual(events, [['journal.entry-unreplayable', { code: 'quota' }]]);
    assert.deepEqual(notified, []);
  });

  it("counts the drains in a row that stop at an entry on a code it can retry for its life, where the mark can't be written, and raises it on the third, once (slice 3b)", async () => {
    const memory = createMemoryJournal();
    /** @type {import('../../js/kernel/core/ports/journal.js').JournalStore} */
    const journal = Object.freeze({
      open: () => memory.open(),
      put: (/** @type {any} */ entry) => memory.put(entry),
      list: () => memory.list(),
      inFlight: () => memory.inFlight(),
      remove: (/** @type {readonly string[]} */ opIds) => memory.remove(opIds),
      // A full disk refuses the mark, so only the worker's memory can count
      mark: async () => {
        throw new UnavailableError('quota', 'quota', false);
      },
    });
    await memory.put(
      journalEntry({
        command: /** @type {any} */ (capture('c-busy')),
        v: 1,
        noteId: 'daily-c-busy',
        surface: 'worker-internal',
        ownerSessionId: INSTANCE,
        seq: 1,
        createdAt: NOW,
      }),
    );
    /** @type {Array<[string, unknown]>} */
    const events = [];
    /** @type {string[]} */
    const notified = [];
    const worked = createWorkerJournal({
      instanceId: INSTANCE,
      stores: /** @type {any} */ ({ journal: () => journal, journalExists: async () => true }),
      locks: null,
      clock: testClock(),
      events: { event: (code, fields, failure) => events.push([code, failure]) },
      notify: entry => notified.push(entry.opId),
      warn: () => {},
    });
    const { kernel } = worker();
    const timedOut = {
      kind: 'unavailable',
      cause: 'storage',
      code: 'timed-out',
      retryable: true,
      messageKey: 'unavailable.timed-out',
      severity: 'error',
    };
    const client = {
      /** @param {any} command */
      execute: async command => (command.commandId === 'c-busy' ? timedOut : kernel.execute(command)),
      /** @param {any} query */
      query: (/** @type {any} */ query) => kernel.query(query),
    };
    for (const run of [1, 2]) {
      await worked.drain(/** @type {any} */ (client));
      assert.deepEqual(events, [], `drain ${run}`);
    }
    for (let run = 3; run <= 5; run++) await worked.drain(/** @type {any} */ (client));
    assert.deepEqual(events, [['journal.entry-unreplayable', { code: 'timed-out' }]]);
    assert.deepEqual(notified, []);
  });

  it('says which notes its last drain held back and why, for system.coordinatorHealth, and none once a drain gets through (slice 3b)', async () => {
    const w = worker();
    await w.journal.keep(capture('c1'), { noteId: 'daily-c1' });
    w.journal.release('c1');
    assert.deepEqual(w.journal.held(), [], 'before any drain');
    let busy = true;
    const timedOut = {
      kind: 'unavailable',
      cause: 'storage',
      code: 'timed-out',
      retryable: true,
      messageKey: 'unavailable.timed-out',
      severity: 'error',
    };
    const client = {
      /** @param {any} command */
      execute: async command => (busy ? timedOut : w.client.execute(command)),
      /** @param {any} query */
      query: (/** @type {any} */ query) => w.client.query(query),
    };
    await w.journal.drain(/** @type {any} */ (client));
    assert.deepEqual(w.journal.held(), [{ noteId: 'daily-c1', code: 'timed-out' }]);
    busy = false;
    const through = await w.journal.drain(/** @type {any} */ (client));
    assert.deepEqual([through?.replayed, through?.left], [1, 0]);
    assert.deepEqual(w.journal.held(), []);
  });

  it('says the last stop its last drain made at an entry, with how many drains in a row stopped there, for system.coordinatorHealth, and none once a drain gets through (#35 slice 4b-1, Q6)', async () => {
    const w = worker();
    await w.journal.keep(capture('c1'), { noteId: 'daily-c1' });
    w.journal.release('c1');
    assert.equal(w.journal.stuck(), null, 'before any drain');
    let busy = true;
    const timedOut = {
      kind: 'unavailable',
      cause: 'storage',
      code: 'timed-out',
      retryable: true,
      messageKey: 'unavailable.timed-out',
      severity: 'error',
    };
    const client = {
      /** @param {any} command */
      execute: async command => (busy ? timedOut : w.client.execute(command)),
      /** @param {any} query */
      query: (/** @type {any} */ query) => w.client.query(query),
    };
    await w.journal.drain(/** @type {any} */ (client));
    assert.deepEqual(w.journal.stuck(), { code: 'timed-out', count: 1 });
    await w.journal.drain(/** @type {any} */ (client));
    assert.deepEqual(w.journal.stuck(), { code: 'timed-out', count: 2 });
    busy = false;
    await w.journal.drain(/** @type {any} */ (client));
    assert.equal(w.journal.stuck(), null);
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

  it("replays no entry its surface couldn't have sent, refused with the router's code: a Popup capture is unknown-operation and a Popup append forbidden-for-surface, neither runs and both stay, and the worker's own capture still replays (#35 slice 4b-1, F5)", async () => {
    const w = worker();
    const stores = inContextStores({ indexedDB: w.faults.factory });
    const database = stores.journal();
    await database.open();
    // A Popup page's entries, its owner gone: a capture, which only the worker sends, and an
    // append, which only the new tab sends
    await database.put(
      journalEntry({
        command: /** @type {any} */ (capture('c-popup')),
        v: 1,
        noteId: 'daily-c-popup',
        surface: 'popup',
        ownerSessionId: 'page-gone',
        seq: 1,
        createdAt: NOW - 3000,
      }),
    );
    await database.put(
      journalEntry({
        command: {
          type: 'insertBlocks',
          commandId: 'c-append',
          noteId: 'n1',
          blocks: [{ id: 'b2', type: 'text', content: 'From the popup' }],
          atOrder: 1,
        },
        v: 1,
        noteId: 'n1',
        surface: 'popup',
        ownerSessionId: 'page-gone',
        seq: 2,
        createdAt: NOW - 2000,
      }),
    );
    // The worker's own capture, from the instance before this one
    await database.put(
      journalEntry({
        command: /** @type {any} */ (capture('c-own')),
        v: 1,
        noteId: 'daily-c-own',
        surface: 'worker-internal',
        ownerSessionId: 'coordinator-0',
        seq: 1,
        createdAt: NOW - 1000,
      }),
    );
    database.close();
    const result = await w.journal.drain(w.client);
    assert.deepEqual(w.sent, ['c-own'], 'only what its own surface could send runs');
    assert.deepEqual([result?.replayed, result?.left], [1, 2]);
    assert.deepEqual(w.events, [
      ['journal.entry-unreplayable', { surface: 'popup' }, { code: 'unknown-operation' }],
      ['journal.entry-unreplayable', { surface: 'popup' }, { code: 'forbidden-for-surface' }],
      ['capture.committed', {}, undefined],
    ]);
    assert.deepEqual((await storedIn(w.real)).sort(), ['c-append', 'c-popup'], 'both stay');
    // Once each
    await w.journal.drain(w.client);
    assert.deepEqual(w.sent, ['c-own']);
    assert.equal(w.events.length, 3);
  });
});

/** A few macrotask turns, so what's settled has settled */
const turns = async () => {
  for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
};

describe("a closed port's session (#35 slice 4b-2, rule 7)", () => {
  it("waits for the session's owner: ownerGone resolves once the page lets its owner lock go, not before, and at once when no page holds it (#35 slice 4b-2, rule 7)", async () => {
    const w = worker();
    const journal = /** @type {any} */ (w.journal);
    assert.equal(typeof journal.ownerGone, 'function', "the journal waits for a closed session's owner");
    // No page holds popup-1's owner lock, so its owner is gone already
    await journal.ownerGone('popup-1');
    // The page that wrote popup-2's entries holds its owner lock for as long as it lives
    /** @type {() => void} */
    let release = () => {};
    const lives = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    void w.manager.request('journal.owner.popup-2', { mode: 'exclusive' }, () => lives);
    let gone = false;
    const waiting = journal.ownerGone('popup-2').then(() => {
      gone = true;
    });
    await turns();
    assert.equal(gone, false, 'not while the page holds its owner lock');
    release();
    await waiting;
    assert.equal(gone, true);
    // And it lets the lock go at once, so the page's next start can take it
    assert.deepEqual((await w.manager.query()).held, []);
  });
});
