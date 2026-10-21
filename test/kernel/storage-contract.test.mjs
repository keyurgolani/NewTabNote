// #12's contract suite on #17's IndexedDB adapter (#17 slice 1: "This issue's IndexedDB
// adapter passes #12's contract suite alongside the in-memory adapter"), over fake-indexeddb
// behind the fault-injecting wrapper. And, until a composition root moves to it, that no
// page or the service worker loads it.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

import { runContractSuite } from './contract.mjs';
import { indexedDbFixture } from './storage-fixture.mjs';

runContractSuite(indexedDbFixture);

const ROOT = path.join(import.meta.dirname, '..', '..');
/** @type {{readScriptGraph: (root: string, options: {pages: string[]}) => {modules: Set<string>, workerFiles: Set<string>, problems: unknown[]}}} */
const { readScriptGraph } = createRequire(import.meta.url)('../../scripts/lib/script-graph.js');

it('no page or the service worker loads the IndexedDB adapter yet: #17 slice 1 wires nothing, and #12 slice 4 moves the roots', () => {
  const graph = readScriptGraph(ROOT, { pages: ['newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html'] });
  assert.deepEqual(graph.problems, []);
  assert.ok(graph.workerFiles.has('js/kernel/composition/background.js'), 'the graph reaches the kernel');
  const loaded = [...graph.modules, ...graph.workerFiles].filter(file =>
    file.startsWith('js/kernel/adapters/indexeddb/'),
  );
  assert.deepEqual(loaded, []);
});
