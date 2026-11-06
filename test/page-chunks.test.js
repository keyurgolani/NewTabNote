'use strict';

// #35 slice 4b-2: the pages pass's two named chunks (scripts/build/page-chunks.js), held to the
// pages' import graphs as the sources have them, without a build. A page's start is what its
// scripts reach through static imports, and the new tab's adds the workspace chunk its root loads
// at once, as test/kernel/handlers.test.mjs reads them.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HOST_MODULES, ADAPTER_MODULES, PRELOAD_HELPER, pageChunkGroups } = require('../scripts/build/page-chunks.js');

const ROOT = path.join(__dirname, '..');

/** The new tab's, Popup's and Side Panel's starts, each as the modules it holds, from the root */
async function starts() {
  const { importGraph } = await import('./kernel/import-graph.mjs');
  const startOf = (/** @type {string[]} */ entries) =>
    new Set(entries.flatMap((entry) => [...importGraph(path.join(ROOT, entry))].map((file) => path.relative(ROOT, file).split(path.sep).join('/'))));
  return [startOf(['js/entries/newtab.js', 'js/workspace.js']), startOf(['js/popup.js']), startOf(['js/sidepanel.js', 'js/insights-summary.js'])];
}

describe('the pages pass\'s host and adapter chunks (scripts/build/page-chunks.js)', () => {
  it('lists only modules the tree has, each in one list', () => {
    for (const file of [...HOST_MODULES, ...ADAPTER_MODULES]) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is in the tree`);
    assert.deepEqual(HOST_MODULES.filter((file) => ADAPTER_MODULES.includes(file)), []);
  });

  it('puts each kernel module the three starts share in one of the lists, so the bundler splits none of them off', async () => {
    const [newtab, popup, sidepanel] = await starts();
    const shared = [...newtab].filter((file) => file.startsWith('js/kernel/') && popup.has(file) && sidepanel.has(file));
    assert.ok(shared.length > 0, 'the three starts share the kernel');
    assert.deepEqual(shared.filter((file) => !HOST_MODULES.includes(file) && !ADAPTER_MODULES.includes(file)).sort(), []);
  });

  it("knows each list's modules by the sources' path and their real path, as a temporary directory's on macOS, and host knows Vite's preload helper", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-page-chunks-'));
    try {
      const [host, adapter] = pageChunkGroups(dir);
      assert.deepEqual([host.name, adapter.name], ['host', 'adapter']);
      for (const at of [dir, fs.realpathSync(dir)]) {
        assert.ok(HOST_MODULES.every((file) => host.test(path.join(at, file)) && !adapter.test(path.join(at, file))));
        assert.ok(ADAPTER_MODULES.every((file) => adapter.test(path.join(at, file)) && !host.test(path.join(at, file))));
      }
      assert.deepEqual([host.test(PRELOAD_HELPER), adapter.test(PRELOAD_HELPER)], [true, false]);
      assert.equal(host.test(path.join(dir, 'js/kernel/adapters/indexeddb/reader.js')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
