'use strict';

// #20's slice 4 prerequisites, part 2 (on #17 PR 1b): the worker journals its migration run.
// A run that stops short of space, or waits on an older build's open page, journals
// storage.migration-blocked; one that fails with version 8 left working journals
// storage.migration-failed; one that upgrades a 1.4.x database journals
// storage.migration-completed. A blocked upgrade no longer journals storage.open-failed, and no
// migration event raises an incident: capture keeps working at 8, and storage's check reports
// the state. Each event holds value-free evidence only, and the same one is journaled once per
// worker start however often a page's request runs it again.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { IDBKeyRange } = require('fake-indexeddb');
const { createDatabase, note, block } = require('./helpers/legacy-env');
const { loadBackground } = require('./helpers/load-background');

/** @type {any} */
let core;
/** @type {any} */
let support;

before(async () => {
  support = await import('./kernel/trust-support.mjs');
  core = {
    ...(await import('../js/trust/core/trust-records.js')),
    ...(await import('../js/kernel/adapters/indexeddb/trust.js')),
  };
});

/** What NewTabNoteTrust in `factory` holds: its events and incidents */
async function inspect(factory) {
  const store = core.createTrustDatabase({ indexedDB: factory, keyRange: IDBKeyRange });
  const clock = { now: () => Date.now() };
  const records = core.createTrustRecords({ store, settings: support.settingsArea(), clock, ids: { next: () => crypto.randomUUID() } });
  await records.open();
  const events = (await records.events()).filter(event => !event.code.startsWith('diagnostics.'));
  const incidents = await records.incidents();
  store.close();
  return { events: events.map(event => [event.code, event.fields]), incidents };
}

/** A 1.4.x database at version 8, with a note */
async function profileAt8(env) {
  await createDatabase(env.indexedDB, {
    records: { canvases: [note('n1', { name: 'Groceries' })], elements: [block('b1', 'n1', 0, 'Milk')] },
  });
}

const codes = seen => seen.events.map(([code]) => code);

describe("the worker journals its migration run (js/background.js, #17's runner)", () => {
  it('a 1.4.x database upgraded to 9 journals storage.migration-completed, with no incident', async () => {
    const worker = await loadBackground({ setup: profileAt8 });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(seen.events, [['storage.migration-completed', { schemaVersion: 9, surface: 'worker-internal' }]]);
    assert.deepEqual(seen.incidents, []);
  });

  it('a fresh profile, whose run only makes the database, journals nothing', async () => {
    const worker = await loadBackground();
    await worker.drain();
    const opened = await worker.indexedDB.databases();
    assert.ok(!opened.some(database => database.name === 'NewTabNoteTrust'), 'it opened NewTabNoteTrust');
  });

  it('a run short of space journals storage.migration-blocked once, with the reason, and leaves 8 working', async () => {
    const worker = await loadBackground({
      opens: false,
      setup: async env => {
        await profileAt8(env);
        env.global.navigator.storage = { estimate: async () => ({ quota: 100 * 1024 ** 2, usage: 99 * 1024 ** 2 }) };
      },
    });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(seen.events, [
      ['storage.migration-blocked', { errorCode: 'space-short', schemaVersion: 9, surface: 'worker-internal' }],
    ]);
    assert.deepEqual(seen.incidents, []);
  });

  it('an upgrade an older build holds journals storage.migration-blocked, never storage.open-failed, then completed once it goes', async () => {
    const worker = await loadBackground({
      opens: false,
      setup: async env => {
        await profileAt8(env);
        // An older build's page that closes only a while after the upgrade asks it to
        const blocker = await new Promise((resolve, reject) => {
          const request = env.indexedDB.open('CanvasTabDB');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        blocker.onversionchange = () => setTimeout(() => blocker.close(), 300);
      },
    });
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    assert.deepEqual(seen.events, [
      ['storage.migration-blocked', { errorCode: 'blocked-upgrade', schemaVersion: 9, surface: 'worker-internal' }],
      ['storage.migration-completed', { schemaVersion: 9, surface: 'worker-internal' }],
    ]);
    assert.ok(!codes(seen).includes('storage.open-failed'));
    assert.deepEqual(seen.incidents, []);
  });

  it('a run that fails with 8 left working journals storage.migration-failed once, however often it runs again', async () => {
    const worker = await loadBackground({
      opens: false,
      setup: async env => {
        await profileAt8(env);
        env.global.navigator.locks = {
          request: () => {
            throw new DOMException('no locks', 'InvalidStateError');
          },
        };
      },
    });
    await worker.drain();
    // Each capture after a run that read nothing runs it again at once
    await worker.dispatch('commands.onCommand', 'capture-selection', worker.tab);
    await worker.drain();
    const seen = await inspect(worker.indexedDB);
    const failed = seen.events.filter(([code]) => code === 'storage.migration-failed');
    assert.equal(failed.length, 1, JSON.stringify(seen.events));
    const [, fields] = failed[0];
    assert.deepEqual(Object.keys(fields).sort().filter(name => !['cause', 'errorCode', 'exception', 'retryable'].includes(name)), ['schemaVersion', 'surface']);
    assert.ok(!codes(seen).includes('storage.open-failed'));
    assert.deepEqual(seen.incidents.filter(incident => incident.providerId === 'storage'), []);
  });
});
