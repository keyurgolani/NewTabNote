/**
 * The store hold (test/support/faults/store-hold.js, #28 slice 4's hung-repository fault, #301) in
 * the extension. Held from an extension page or from the service worker, it keeps another
 * context's write to its stores waiting until its release, and it fails at once, naming its
 * stores, when it ended before its release, so a red hold check ends in seconds and not at the
 * test's timeout. test/kernel/store-hold.test.mjs holds the rest in Node. The tests also fail on
 * an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { profileStore } = require('./harness/profile-store');
const { holdStores } = require('../test/support/faults');
const driver = require('./characterization/driver');

/** How long a case watches a held write not answer: far past a write's commit */
const WATCH_MS = 1000;

for (const from of ['an extension page', 'the service worker']) {
  test(`a hold from ${from} keeps another context's write waiting until its release`, async ({ extension }) => {
    await extension.seedOnboarded();
    await driver.seedNotes(extension, [{ name: 'Before', blocks: [{ type: 'text', content: 'kept' }] }]);
    const writer = await extension.openSurface('popup');
    const holder = from === 'the service worker' ? extension.worker : await extension.openSurface('sidepanel');
    const hold = await holdStores(holder, ['canvases']);

    let answered = false;
    const written = profileStore(writer).createNote('Held').then(() => (answered = true));
    await writer.waitForTimeout(WATCH_MS);
    expect(answered, 'the write waits behind the hold').toBe(false);
    await hold.stillHeld('while the write waits');
    expect(await hold.release(), 'the hold, released').toBe('complete');
    await written;
    expect((await profileStore(writer).getAllNotes(true)).map(note => note.name).sort()).toEqual(['Before', 'Held']);
    await expectNoUncaught(extension, writer);
  });
}

test('a hold that ended before its release fails at once, naming its stores', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Before', blocks: [{ type: 'text', content: 'kept' }] }]);
  const holder = await extension.openSurface('sidepanel');
  const hold = await holdStores(holder, ['canvases', 'elements']);
  // Planted: the hold's transaction aborts in its page, as one a damaged read ends does
  await holder.evaluate(() => {
    for (const held of globalThis.__ntnStoreHolds.values()) held.tx.abort();
  });
  const started = Date.now();
  await expect(hold.stillHeld('once its transaction aborted')).rejects.toThrow(/the hold on CanvasTabDB's canvases, elements no longer holds/);
  await expect(hold.release()).rejects.toThrow(/the hold on CanvasTabDB's canvases, elements ended \(abort\) before its release/);
  expect(Date.now() - started, 'in seconds, not at the test timeout').toBeLessThan(5000);
  await expectNoUncaught(extension, holder);
});
