// #12's contract suite on #17's IndexedDB adapter (#17 slice 1: "This issue's IndexedDB
// adapter passes #12's contract suite alongside the in-memory adapter"), over fake-indexeddb
// behind the fault-injecting wrapper. And, until a composition root moves to it, that no
// page or the service worker loads it.

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

it("no page or the service worker loads the IndexedDB adapter yet, only the helpers the legacy adapter shares with it, and the worker's NewTabNoteTrust", () => {
  const graph = readScriptGraph(ROOT, { pages: ['newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html'] });
  assert.deepEqual(graph.problems, []);
  assert.ok(graph.workerFiles.has('js/kernel/composition/background.js'), 'the graph reaches the kernel');
  // #12 slice 4's roots build on the legacy adapter, which takes the store names, setting
  // keys, and request helpers from here, so the two adapters agree; a root moves to #17's
  // adapter itself later (#17, AC4)
  const loaded = [...new Set([...graph.modules, ...graph.workerFiles])]
    .filter(file => file.startsWith('js/kernel/adapters/indexeddb/'))
    .sort();
  // The worker's failure events (#20 slice 1b) open NewTabNoteTrust on #17's transaction
  // rules, which takes failures.js too; CanvasTabDB's adapter.js stays unloaded
  assert.deepEqual(loaded, [
    'js/kernel/adapters/indexeddb/failures.js',
    'js/kernel/adapters/indexeddb/requests.js',
    'js/kernel/adapters/indexeddb/schema.js',
    'js/kernel/adapters/indexeddb/settings.js',
    'js/kernel/adapters/indexeddb/trust.js',
  ]);
});

it("recovery.html loads NewTabNoteTrust and the readers its checks run through, and still not CanvasTabDB's adapter (#20 slice 4b)", () => {
  const graph = readScriptGraph(ROOT, { pages: ['recovery.html'] });
  assert.deepEqual(graph.problems, []);
  // The page's own modules, which the manifest's pages and the worker don't share
  const page = graph.pageModules.get('recovery.html');
  assert.ok(page, 'the graph reads recovery.html');
  const loaded = page
    .map(({ file }) => file)
    .filter(file => file.startsWith('js/kernel/adapters/indexeddb/'))
    .sort();
  // Its root opens NewTabNoteTrust (trust.js, records.js, registry.js) and builds the readers
  // the health checks use (health.js, legacy-secrets.js, recovery-points.js, shapes.js); the
  // notes database it reaches through the legacy adapter, as Side Panel does
  assert.deepEqual(loaded, [
    'js/kernel/adapters/indexeddb/failures.js',
    'js/kernel/adapters/indexeddb/health.js',
    'js/kernel/adapters/indexeddb/legacy-secrets.js',
    'js/kernel/adapters/indexeddb/records.js',
    'js/kernel/adapters/indexeddb/recovery-points.js',
    'js/kernel/adapters/indexeddb/registry.js',
    'js/kernel/adapters/indexeddb/requests.js',
    'js/kernel/adapters/indexeddb/schema.js',
    'js/kernel/adapters/indexeddb/settings.js',
    'js/kernel/adapters/indexeddb/shapes.js',
    'js/kernel/adapters/indexeddb/trust.js',
  ]);
  assert.ok(!loaded.includes('js/kernel/adapters/indexeddb/adapter.js'));
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
