// #12's contract suite on #17's IndexedDB adapter (#17 slice 1: "This issue's IndexedDB
// adapter passes #12's contract suite alongside the in-memory adapter"), over fake-indexeddb
// behind the fault-injecting wrapper. And which composition roots load it: the service worker,
// Popup, and Side Panel since #17 PR 1b, and the new tab since #17 PR 4a.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { runContractSuite } from './contract.mjs';
import { reachGraph } from './import-graph.mjs';
import { indexedDbFixture } from './storage-fixture.mjs';

runContractSuite(indexedDbFixture);

const ROOT = path.join(import.meta.dirname, '..', '..');
/** @type {{readScriptGraph: (root: string, options: {pages: string[]}) => {modules: Set<string>, workerFiles: Set<string>, pageModules: Map<string, Array<{file: string}>>, problems: unknown[]}}} */
const { readScriptGraph } = createRequire(import.meta.url)('../../scripts/lib/script-graph.js');

const ADAPTER = 'js/kernel/adapters/indexeddb/adapter.js';
const RUNNER = 'js/kernel/adapters/indexeddb/migrate.js';
const LEGACY_ADAPTER = 'js/kernel/adapters/legacy/adapter.js';
const PAGES = Object.freeze(['newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html']);
/**
 * The import() calls whose specifier no reading can follow, by file: the loader's, of a library
 * by the build's manifest (#27 slice 3)
 */
const COMPUTED_IMPORTS = Object.freeze(['js/runtime/lazy.js']);

/** @param {string} file */
const fromRoot = file => path.relative(ROOT, file).split(path.sep).join('/');

/**
 * Each page's graph: every module its scripts reach through static imports and each import() of
 * a literal specifier, as the chunks it loads (the workspace chunk, and the trust chunk
 * lazy-failure-events.js loads at a page's first failure; R88's read of #79), and the files of
 * the import() calls whose specifier it can't follow. `readFile` reads a module, from disk
 * unless given, so a test can plant an import.
 * @param {(file: string) => string} [readFile]
 */
function pageGraphs(readFile) {
  const all = readScriptGraph(ROOT, { pages: [...PAGES] });
  /** @type {Map<string, {modules: Set<string>, computed: string[]}>} */
  const pages = new Map();
  for (const page of PAGES) {
    const scripts = (all.pageModules.get(page) || []).map(({ file }) => path.join(ROOT, file));
    const { modules, computed } = reachGraph(scripts, readFile ? { readFile } : {});
    pages.set(page, {
      modules: new Set([...modules].map(fromRoot)),
      computed: [...new Set(computed.map(at => fromRoot(at.replace(/:\d+:\d+$/, ''))))],
    });
  }
  return { all, pages };
}

/**
 * What a page's graph breaks of the roots rule: a page that reaches the migration runner or the
 * legacy adapter, Popup, Side Panel, or the new tab without #17's adapter, the offscreen document
 * with any adapter, and an import() no reading can follow but the loader's
 * @param {(file: string) => string} [readFile]
 * @returns {string[]}
 */
function rootProblems(readFile) {
  const problems = [];
  for (const [page, { modules, computed }] of pageGraphs(readFile).pages) {
    if (modules.has(RUNNER)) problems.push(`${page} reaches the migration runner`);
    if (modules.has(LEGACY_ADAPTER)) problems.push(`${page} reaches the legacy adapter`);
    if (page === 'offscreen.html') {
      for (const file of modules) if (file.startsWith('js/kernel/adapters/')) problems.push(`${page} reaches ${file}`);
    } else if (!modules.has(ADAPTER)) {
      problems.push(`${page} doesn't load #17's adapter`);
    }
    for (const file of computed) {
      if (!COMPUTED_IMPORTS.includes(file)) problems.push(`${page} has an import() no reading follows, in ${file}`);
    }
  }
  return problems;
}

it('every root loads the IndexedDB adapter, and none the legacy one; only the worker runs migrations', () => {
  const { all, pages } = pageGraphs();
  assert.deepEqual(all.problems, []);
  // #17 PR 1b: the worker upgrades the database through the runner, then opens #17's adapter
  assert.ok(all.workerFiles.has(ADAPTER), 'the worker loads the adapter');
  assert.ok(all.workerFiles.has(RUNNER), 'the worker loads the migration runner');
  assert.ok(!all.workerFiles.has(LEGACY_ADAPTER), 'the worker is off the legacy adapter');
  // Popup and Side Panel open it as it is (Q3), and so does the new tab since #17 PR 4a, every
  // chunk each loads included, and none runs a migration; the offscreen document only makes
  // #21's API requests, and opens no storage
  assert.deepEqual(rootProblems(), []);
  // The new tab reaches its composition root through the workspace chunk, which the boot root
  // loads at once through the loader (#27 slice 3), and the trust chunk, and reads the
  // pre-update copy (legacy-export.js) for Settings
  const newtab = /** @type {{modules: Set<string>}} */ (pages.get('newtab.html')).modules;
  for (const file of [
    'js/workspace.js',
    'js/kernel/composition/newtab.js',
    'js/kernel/composition/trust.js',
    'js/kernel/adapters/indexeddb/legacy-export.js',
  ]) {
    assert.ok(newtab.has(file), file);
  }
});

it("fails a page that reaches the runner through a chunk it loads with import(), as one planted through the trust chunk would (R88's read of #79)", () => {
  const trust = path.join(ROOT, 'js', 'kernel', 'composition', 'trust.js');
  /** @param {string} file */
  const planted = file => {
    const text = fs.readFileSync(file, 'utf8');
    return file === trust ? `import '../adapters/indexeddb/migrate.js';\n${text}` : text;
  };
  assert.ok(rootProblems(planted).includes('newtab.html reaches the migration runner'));
  // A computed import() a page gains fails it too
  const lazy = path.join(ROOT, 'js', 'kernel', 'composition', 'lazy-failure-events.js');
  /** @param {string} file */
  const computed = file => {
    const text = fs.readFileSync(file, 'utf8');
    return file === lazy ? `${text}\nexport const later = name => import(name);\n` : text;
  };
  assert.ok(
    rootProblems(computed).includes(
      'newtab.html has an import() no reading follows, in js/kernel/composition/lazy-failure-events.js',
    ),
  );
});

it('has every flag, so the ledger declares no gap for it: the backup tasks run on it since #17 PR 4a', () => {
  assert.deepEqual(
    Object.entries(indexedDbFixture.flags).filter(([, has]) => !has),
    [],
  );
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/architecture/kernel-ledger.json'), 'utf8'));
  const gaps = ledger.rows.filter(
    (/** @type {{rule: string, file: string}} */ row) =>
      row.rule === 'declared-gap' && row.file === 'js/kernel/adapters/indexeddb/adapter.js',
  );
  assert.deepEqual(gaps, []);
});
