'use strict';

// e2e/harness/fixture-host.js loading a 1.4.x fixture over what the extension already holds
// (#17 PR 1b's worker makes CanvasTabDB at 9 as the extension installs), on a stand-in for the
// service worker: a 1.4.x package's load deletes nothing and never updates the extension; a run
// that didn't migrate keeps the database it made and fails the load; and after one that did,
// the load deletes that database, loads the fixture, and hands over to the harness's update,
// which only a harness worker has. e2e/fixture-host.spec.js runs the update in Chromium.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IDBFactory } = require('fake-indexeddb');
const { fixtureHost } = require('../e2e/harness/fixture-host');

const RECORDED = path.join(__dirname, 'fixtures', 'storage', 'recorded', 'v8.v1.4.0.json');
const recorded = () => JSON.parse(fs.readFileSync(RECORDED, 'utf8'));
const GLOBALS = ['self', 'indexedDB', 'chrome'];

/** A Playwright Worker's evaluate, run in this process on the globals the worker would have */
const worker = { evaluate: async (call, arg) => (typeof call === 'function' ? call(arg) : (0, eval)(call)) };

/** What a database holds now: its version, and how many records `store` has */
async function heldIn(factory, name, store) {
  const listed = (await factory.databases()).find(db => db.name === name);
  if (!listed) return null;
  const db = await new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const count = await new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { version: db.version, count };
  } finally {
    db.close();
  }
}

/** CanvasTabDB at `version` with an empty `canvases` store, as an install made it */
function installed(factory, version) {
  return new Promise((resolve, reject) => {
    const request = factory.open('CanvasTabDB', version);
    request.onupgradeneeded = () => request.result.createObjectStore('canvases', { keyPath: 'id' });
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe('the fixture host over an install that made CanvasTabDB (#17 PR 1b)', () => {
  /** @type {Record<string, unknown>} */
  let saved;
  /** @type {IDBFactory} */
  let factory;

  beforeEach(() => {
    saved = Object.fromEntries(GLOBALS.map(name => [name, globalThis[name]]));
    factory = new IDBFactory();
    globalThis.indexedDB = factory;
    globalThis.chrome = { storage: { local: { set: async () => {} } }, runtime: { getManifest: () => ({ version: '1.5.0' }) } };
    globalThis.self = {};
  });

  afterEach(() => {
    for (const name of GLOBALS) {
      if (saved[name] === undefined) delete globalThis[name];
      else globalThis[name] = saved[name];
    }
  });

  it("a 1.4.x package's load deletes nothing and never updates the extension", async () => {
    // A 1.4.x worker publishes no run; it made nothing, or CanvasTabDB at the fixture's 8, with
    // its stores and nothing in them
    for (const made of [null, 8]) {
      factory = new IDBFactory();
      globalThis.indexedDB = factory;
      if (made) {
        const empty = recorded();
        for (const store of empty.databases[0].stores) store.records = [];
        await fixtureHost(worker).loadFixture(empty, { storage: false });
      }
      // The stand-in isn't a harness worker, so an update would reject
      assert.deepEqual(await fixtureHost(worker).loadFixture(recorded(), { storage: false }), { databases: ['CanvasTabDB'] });
      assert.deepEqual(await heldIn(factory, 'CanvasTabDB', 'canvases'), { version: 8, count: 8 }, String(made));
    }
  });

  it("a run that didn't migrate keeps the database it made, and the load fails", async () => {
    for (const run of [{ status: 'failed' }, { status: 'refused' }, null]) {
      factory = new IDBFactory();
      globalThis.indexedDB = factory;
      await installed(factory, 9);
      globalThis.self = run ? { storageUpgrade: Promise.resolve(run) } : {};
      await assert.rejects(
        fixtureHost(worker).loadFixture(recorded(), { storage: false }),
        new RegExp(`answered ${JSON.stringify(run && run.status)}, not "migrated", so CanvasTabDB stays`),
      );
      assert.deepEqual(await heldIn(factory, 'CanvasTabDB', 'canvases'), { version: 9, count: 0 }, JSON.stringify(run));
    }
  });

  it('after a run that migrated, it deletes that database, loads the fixture, and then asks the harness to update in place', async () => {
    await installed(factory, 9);
    globalThis.self = { storageUpgrade: Promise.resolve({ status: 'migrated' }) };
    await assert.rejects(fixtureHost(worker).loadFixture(recorded(), { storage: false }), /needs the harness's worker, to update the extension in place/);
    assert.deepEqual(await heldIn(factory, 'CanvasTabDB', 'canvases'), { version: 8, count: 8 });
  });
});
