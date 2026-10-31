// #12's contract suite on #17's IndexedDB adapter (#17 slice 1: "This issue's IndexedDB
// adapter passes #12's contract suite alongside the in-memory adapter"), over fake-indexeddb
// behind the fault-injecting wrapper. And which composition roots load it since #17 PR 1b:
// the service worker, Popup, and Side Panel.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { runContractSuite } from './contract.mjs';
import { indexedDbFixture } from './storage-fixture.mjs';

runContractSuite(indexedDbFixture);

const ROOT = path.join(import.meta.dirname, '..', '..');
/** @type {{readScriptGraph: (root: string, options: {pages: string[]}) => {modules: Set<string>, workerFiles: Set<string>, pageModules: Map<string, Array<{file: string}>>, problems: unknown[]}}} */
const { readScriptGraph } = createRequire(import.meta.url)('../../scripts/lib/script-graph.js');

it('only these roots load the IndexedDB adapter: the service worker, Popup, and Side Panel; only the worker runs migrations', () => {
  const ADAPTER = 'js/kernel/adapters/indexeddb/adapter.js';
  const RUNNER = 'js/kernel/adapters/indexeddb/migrate.js';
  const all = readScriptGraph(ROOT, { pages: ['newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html'] });
  /** @param {string} page */
  const modulesOf = page => new Set((all.pageModules.get(page) || []).map(({ file }) => file));
  assert.deepEqual(all.problems, []);
  // #17 PR 1b: the worker upgrades the database through the runner, then opens #17's adapter
  assert.ok(all.workerFiles.has(ADAPTER), 'the worker loads the adapter');
  assert.ok(all.workerFiles.has(RUNNER), 'the worker loads the migration runner');
  assert.ok(!all.workerFiles.has('js/kernel/adapters/legacy/adapter.js'), 'the worker is off the legacy adapter');
  // Popup and Side Panel open it as it is (Q3), and never run a migration
  for (const page of ['popup.html', 'sidepanel.html']) {
    const modules = modulesOf(page);
    assert.ok(modules.has(ADAPTER), `${page} loads the adapter`);
    assert.ok(!modules.has(RUNNER), `${page} never loads the runner`);
    assert.ok(!modules.has('js/kernel/adapters/legacy/adapter.js'), `${page} is off the legacy adapter`);
  }
  // The new tab stays on the legacy adapter until #12 moves its writers, and reads the
  // pre-update copy (legacy-export.js) for Settings, but never the adapter or the runner
  const newtab = modulesOf('newtab.html');
  assert.ok(!newtab.has(ADAPTER), 'the new tab is on the legacy adapter');
  assert.ok(!newtab.has(RUNNER), 'the new tab never loads the runner');
  assert.ok(newtab.has('js/kernel/adapters/indexeddb/legacy-export.js'), 'the new tab exports the pre-update copy');
  // The offscreen document only makes #21's API requests, and opens no storage
  assert.deepEqual(
    [...modulesOf('offscreen.html')].filter(file => file.startsWith('js/kernel/adapters/')),
    [],
  );
});

it("lacks only the backups flag the ledger declares, as a gap #18's backup engine closes", () => {
  assert.equal(indexedDbFixture.flags.backups, false);
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/architecture/kernel-ledger.json'), 'utf8'));
  /** @type {Array<{file: string, rule: string, owner: number, verify: string}>} */
  const gaps = ledger.rows.filter(
    (/** @type {{rule: string, file: string}} */ row) =>
      row.rule === 'declared-gap' && row.file === 'js/kernel/adapters/indexeddb/adapter.js',
  );
  assert.deepEqual(
    gaps.map(row => [row.owner, row.verify]),
    [[18, 'npm run test:kernel: the backups check in test/kernel/contract.mjs']],
  );
});
