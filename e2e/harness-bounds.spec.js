/**
 * The harness's own IndexedDB waits in the worker each have a bound under the test's timeout
 * (#286), so a stall there fails naming what it waited on, apart from a failure of the state under
 * test: the profile store's open of CanvasTabDB (test/fixtures/storage/profile-store.mjs),
 * shortOfSpace's deletes, and the wait for the worker's storage upgrade
 * (e2e/characterization/driver.js), and the fixture host's wait for that upgrade, its deletes, and
 * its wait for the updated worker's upgrade (e2e/harness/fixture-host.js). Each case stalls one of
 * them on purpose and expects it to fail inside its bound.
 */

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./harness');
const { profileStore } = require('./harness/profile-store');
const { fixtureHost } = require('./harness/fixture-host');
const { holdUpgrade } = require('../test/support/faults');
const driver = require('./characterization/driver');

/** Well inside the test's 30 s, and past each bound: 10 s for an open or a delete, 15 s for the upgrade */
const INSIDE_MS = 20_000;

/** A 1.4.x fixture, CanvasTabDB at version 8, which loads over the install's database with a delete and an update in place */
function fixtureAtV8() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'storage', 'recorded', 'v8.v1.4.0.json'), 'utf8'));
}

/** Plants, in `worker`, a storageUpgrade that never settles, as a run stalled behind another context's does */
function stallStorageUpgrade(worker) {
  return worker.evaluate(() => {
    Object.defineProperty(self, 'storageUpgrade', { get: () => new Promise(() => {}), configurable: true });
  });
}

/** An extension page that opens no database of its own, as startCoordinator's offscreen tab is */
async function quietPage(extension) {
  const page = await extension.context.newPage();
  await page.goto(extension.url('offscreen.html'));
  return page;
}

test("seedNotes's write fails inside its bound, naming CanvasTabDB's open, while another page holds its upgrade", async ({ extension }) => {
  await extension.seedOnboarded();
  // The worker's run is in, so what stalls next is the profile store's own open
  await driver.seedNotes(extension, []);
  const hold = await holdUpgrade(await quietPage(extension));
  const started = Date.now();
  await expect(profileStore(extension.worker).seedNotes([{ name: 'Held', blocks: [{ type: 'text', content: 'held' }] }]))
    .rejects.toThrow(/CanvasTabDB's open got no answer in 10 s/);
  expect(Date.now() - started, 'inside its bound, not at the test timeout').toBeLessThan(INSIDE_MS);
  expect(await hold.release(), 'the upgrade, rolled back').toBe('abort');
});

test("shortOfSpace fails inside its bound, naming CanvasTabDB's delete, while another connection stays open", async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, []);
  const holder = await quietPage(extension);
  // A connection that stays open through another context's versionchange, as no app page's does
  await holder.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('CanvasTabDB');
    request.onsuccess = () => {
      globalThis.__ntnKept = request.result;
      resolve();
    };
    request.onerror = () => reject(request.error);
  }));
  const started = Date.now();
  await expect(driver.shortOfSpace(extension)).rejects.toThrow(/deleting CanvasTabDB got no answer in 10 s, blocked by a connection still open/);
  expect(Date.now() - started, 'inside its bound, not at the test timeout').toBeLessThan(INSIDE_MS);
  await holder.evaluate(() => globalThis.__ntnKept.close());
});

test("seedNotes fails inside its bound, naming the worker's storage upgrade, while the upgrade stays pending", async ({ extension }) => {
  await extension.seedOnboarded();
  // Planted: the worker's storageUpgrade never settles, as a run stalled behind another context's does
  await extension.worker.evaluate(() => {
    Object.defineProperty(self, 'storageUpgrade', { get: () => new Promise(() => {}), configurable: true });
  });
  const started = Date.now();
  await expect(driver.seedNotes(extension, [{ name: 'Held', blocks: [{ type: 'text', content: 'held' }] }]))
    .rejects.toThrow(/the worker's storageUpgrade didn't settle in 15 s/);
  expect(Date.now() - started, 'inside its bound, not at the test timeout').toBeLessThan(INSIDE_MS);
});

test("a fixture load fails inside its bound, naming CanvasTabDB's delete, while another connection stays open", async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, []);
  const holder = await quietPage(extension);
  // A connection that stays open through another context's versionchange, as no app page's does
  await holder.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('CanvasTabDB');
    request.onsuccess = () => {
      globalThis.__ntnKept = request.result;
      resolve();
    };
    request.onerror = () => reject(request.error);
  }));
  const started = Date.now();
  await expect(fixtureHost(extension.worker).loadFixture(fixtureAtV8()))
    .rejects.toThrow(/deleting CanvasTabDB got no answer in 10 s, blocked by a connection still open/);
  expect(Date.now() - started, 'inside its bound, not at the test timeout').toBeLessThan(INSIDE_MS);
  await holder.evaluate(() => globalThis.__ntnKept.close());
});

test("a fixture load fails inside its bound, naming the worker's storage upgrade, while the upgrade stays pending", async ({ extension }) => {
  await extension.seedOnboarded();
  await stallStorageUpgrade(extension.worker);
  const started = Date.now();
  await expect(fixtureHost(extension.worker).loadFixture(fixtureAtV8()))
    .rejects.toThrow(/the worker's storageUpgrade didn't settle in 15 s/);
  expect(Date.now() - started, 'inside its bound, not at the test timeout').toBeLessThan(INSIDE_MS);
});

test("a fixture load over the install's database fails inside its bound, naming the updated worker's storage upgrade, while that upgrade stays pending", async ({ extension }) => {
  await extension.seedOnboarded();
  // Planted once the harness has updated the extension in place, in the worker the update started
  let stalled = null;
  const update = extension.update.bind(extension);
  extension.update = async options => {
    await update(options);
    await stallStorageUpgrade(extension.worker);
    stalled = Date.now();
  };
  await expect(fixtureHost(extension.worker).loadFixture(fixtureAtV8()))
    .rejects.toThrow(/the updated worker's storageUpgrade didn't settle in 15 s/);
  expect(stalled, 'the load updated the extension in place').not.toBeNull();
  expect(Date.now() - stalled, 'inside its bound, not at the test timeout').toBeLessThan(INSIDE_MS);
});
