// Smoke test for the kernel's module seam (#12 slice 1). Node loads js/kernel/ as ES modules
// (js/kernel/package.json), and each composition root, the service worker's included, which
// js/background.js imports before it registers a listener, loads without a browser API and
// leaves the global object as it found it. test/kernel/roots.test.mjs checks what they build.

import test from 'node:test';
import assert from 'node:assert/strict';

const BROWSER_GLOBALS = ['chrome', 'self', 'window', 'document', 'indexedDB'];
const ROOTS = ['background', 'newtab', 'popup', 'sidepanel'];

test('each composition root loads with no browser globals and adds none', async () => {
  const present = BROWSER_GLOBALS.filter(name => name in globalThis);
  assert.deepEqual(present, [], "these are defined here, so this test can't show the roots load without them");
  const before = new Set(Reflect.ownKeys(globalThis));

  for (const root of ROOTS) {
    const module = await import(`../../js/kernel/composition/${root}.js`);
    assert.equal(Object.prototype.toString.call(module), '[object Module]', root);
  }
  const added = Reflect.ownKeys(globalThis).filter(key => !before.has(key));
  assert.deepEqual(added, []);
});
