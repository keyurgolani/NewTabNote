// Smoke test for the kernel's module seam (#12 slice 1). Node loads js/kernel/ as ES modules
// (js/kernel/package.json), and the service worker's composition root, which
// js/background.js imports before it registers a listener, loads without a browser API and
// leaves the global object as it found it.

import test from 'node:test';
import assert from 'node:assert/strict';

const BROWSER_GLOBALS = ['chrome', 'self', 'window', 'document', 'indexedDB'];

test('the service worker composition root loads with no browser globals and adds none', async () => {
  const present = BROWSER_GLOBALS.filter(name => name in globalThis);
  assert.deepEqual(present, [], "these are defined here, so this test can't show the root loads without them");
  const before = new Set(Reflect.ownKeys(globalThis));

  const root = await import('../../js/kernel/composition/background.js');

  assert.equal(Object.prototype.toString.call(root), '[object Module]');
  const added = Reflect.ownKeys(globalThis).filter(key => !before.has(key));
  assert.deepEqual(added, []);
});
