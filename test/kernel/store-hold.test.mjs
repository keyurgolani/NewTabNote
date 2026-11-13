// #28 slice 4's hung-repository fault (#301) in Node, over fake-indexeddb: the store hold
// (test/support/faults/store-hold.js) keeps a database's stores until its release, so #17's
// adapter's write waits behind it, and a held upgrade keeps every other open of the database
// waiting. e2e/store-hold.spec.js holds the same hold from an extension page and from the worker.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { adapterOn, closeAll, kernelOn, profile, recordsOf } from './storage-fixture.mjs';
import { faultyFactory } from '../support/faults/storage-faults.mjs';

/** @type {typeof import('../support/faults/index.js')} */
const { holdStores, holdUpgrade } = createRequire(import.meta.url)('../support/faults/index.js');

/** `count` turns of the event loop, in each of which fake-indexeddb answers a request */
async function turns(count = 20) {
  for (let turn = 0; turn < count; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

/**
 * Whether `promise` has settled, read at any time after
 * @param {Promise<unknown>} promise
 * @returns {() => boolean}
 */
function settledYet(promise) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return () => settled;
}

/**
 * CanvasTabDB's version, read on a connection of its own
 * @param {IDBFactory} factory
 * @returns {Promise<number>}
 */
function versionOf(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open('CanvasTabDB');
    request.onsuccess = () => {
      const { version } = request.result;
      request.result.close();
      resolve(version);
    };
    request.onerror = () => reject(request.error);
  });
}

/** A profile whose CanvasTabDB #17's adapter has made, and a kernel on it */
async function opened() {
  const of = profile();
  const adapter = adapterOn(of);
  await adapter.open();
  return { of, kernel: kernelOn(adapter) };
}

describe('the store hold, in Node', () => {
  it("resolves only once its first get succeeds, so a hold behind another context's transaction isn't held yet", async () => {
    const { of } = await opened();
    const first = await holdStores(of.real, ['elements']);
    const second = holdStores(of.real, ['elements']);
    const held = settledYet(second);
    await turns();
    assert.equal(held(), false, "the second hold's transaction waits behind the first's");
    assert.equal(await first.release(), 'complete');
    const hold = await second;
    assert.equal(await hold.active(), true);
    assert.equal(await hold.release(), 'complete');
    closeAll(of);
  });

  it("keeps a write by #17's adapter waiting until its release, which answers complete", async () => {
    const { of, kernel } = await opened();
    const hold = await holdStores(of.real, ['canvases']);
    const created = kernel.execute({ type: 'createNote', commandId: 'create-held', noteId: 'held', name: 'Held' });
    const answered = settledYet(created);
    await turns(100);
    assert.equal(answered(), false, 'the write waits behind the hold, so it has no answer');
    await hold.stillHeld('while the write waits');
    assert.equal(await hold.release(), 'complete');
    assert.equal((await created).kind, 'committed');
    assert.deepEqual((await recordsOf(of, 'canvases')).map(note => note.id), ['held']);
    closeAll(of);
  });

  it('fails at once at its release, naming its database and stores, when it ended first', async () => {
    const { of } = await opened();
    const faults = faultyFactory(of.real);
    const hold = await holdStores(faults.factory, ['canvases', 'elements']);
    // Its next get fails as a damaged file's read does, which aborts its transaction
    faults.failNextRead('canvases', 'NotReadableError');
    await turns();
    assert.equal(await hold.active(), false);
    await assert.rejects(hold.stillHeld('once its read failed'), /the hold on CanvasTabDB's canvases, elements no longer holds once its read failed: it ended \(abort\)/);
    await assert.rejects(hold.release(), /the hold on CanvasTabDB's canvases, elements ended \(abort\) before its release/);
    closeAll(of);
  });

  it('holds an upgrade, so the next open waits until the release, which leaves the version as it was', async () => {
    const { of } = await opened();
    closeAll(of);
    const before = await versionOf(of.real);
    const hold = await holdUpgrade(of.real);
    const opening = versionOf(of.real);
    const answered = settledYet(opening);
    await turns();
    assert.equal(answered(), false, 'the open waits behind the held upgrade');
    assert.equal(await hold.release(), 'abort');
    assert.equal(await opening, before);
  });
});
