// #35's architecture test (scope AC1, "One committer"; slice 4a): every repository write commits
// through the background coordinator, in the service worker, apart from the in-context writes
// docs/architecture/committers.json lists. It reads every root the build has, each page in
// scripts/build/vite-config.js's PAGES by the scripts its HTML loads, the worker from
// manifest.json, and each module worker a root starts (and each one that worker starts), through
// static imports and every import() of a literal (import-graph.mjs), so a root #2 or #3 adds is
// checked with no edit here. Three rules:
// 1. Only the worker's graph reaches a module that writes CanvasTabDB (`indexeddb`'s writers),
//    but for a page on `untilMoved`, whose graph may hold #17's adapter and what it imports until
//    its own slice, and a module `reads` names for a page that loads it only to read.
// 2. A page writes only what the list names: each kernel module in its graph where
//    scripts/write-paths.js's scanSource finds a persistence write is on `inContext` or `reads`,
//    or is #17's adapter's on an `untilMoved` page. js/ outside js/kernel is write-paths.md's,
//    which test/write-paths.test.js holds. A write through a handed-in handle is a `handles` row.
// 3. `untilMoved` only shrinks: each row's page still reaches the adapter, and no page joins it.
//    recovery.html joined once, with #20 slice 4b, by the lead's ruling of 2026-11-05, so its
//    row is on a list of its own, and no other page can join.
// Every module under js/kernel/adapters/indexeddb/ is classified, and an import() whose specifier
// is computed is one `computedImports` names. The planted cases break each rule on purpose.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { reachGraph } from './import-graph.mjs';

// Not named `require`, so the kernel's typecheck doesn't follow it into the build's scripts
const requireCommonJs = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { PAGES } = requireCommonJs('../../scripts/build/vite-config.js');
const { scanSource } = requireCommonJs('../../scripts/write-paths.js');

/** The list, as committed */
const LIST = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'architecture', 'committers.json'), 'utf8'));

/** The pages 4a's `untilMoved` starts with, which no page may join: only a row's removal changes it */
const UNTIL_MOVED_4A = Object.freeze(['popup', 'sidepanel', 'newtab']);

/**
 * The page that joined `untilMoved` after 4a, once: recovery.html, with #20 slice 4b, by the lead's
 * ruling of 2026-11-05, as #35's slice 4 plan foresaw. Its remediations commit in-process, as the
 * three pages' writes do, until #35 moves them onto #13's port. Only a row's removal changes it
 */
const UNTIL_MOVED_JOINED = Object.freeze(['recovery']);

/** The folder every module of which `indexeddb` classifies */
const INDEXEDDB = 'js/kernel/adapters/indexeddb';

/** @param {string} file */
const defaultRead = file => fs.readFileSync(file, 'utf8');

/** @param {string} file */
const relative = file => path.relative(ROOT, file).split(path.sep).join('/');

/** What the scan finds in a module's text, kept, since every case reads the same modules */
/** @type {Map<string, {hits: Array<{call: string}>, problems: unknown[]}>} */
const scans = new Map();

/**
 * The writes scripts/write-paths.js's scanSource finds in `file`, whose text is `text`
 * @param {string} file
 * @param {string} text
 */
function scanned(file, text) {
  const key = `${file}\u0000${text}`;
  let found = scans.get(key);
  if (!found) {
    found = scanSource(file, text);
    scans.set(key, /** @type {{hits: Array<{call: string}>, problems: unknown[]}} */ (found));
  }
  return /** @type {{hits: Array<{call: string}>, problems: unknown[]}} */ (found);
}

/**
 * The scripts an HTML page loads, module and classic, by their path from the repository root
 * @param {string} text
 * @returns {string[]}
 */
function scriptsOf(text) {
  return [...text.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1].replace(/^\.?\//, ''));
}

/**
 * Every root the build has: each page in `pages`, by the scripts its HTML loads, and the worker
 * @param {{pages: Record<string, string>, readFile: (file: string) => string}} options
 * @returns {Array<{name: string, worker: boolean, entries: string[]}>}
 */
function rootsOf({ pages, readFile }) {
  const manifest = JSON.parse(readFile(path.join(ROOT, 'manifest.json')));
  return [
    ...Object.entries(pages).map(([name, html]) => ({
      name,
      worker: false,
      entries: scriptsOf(readFile(path.join(ROOT, html))),
    })),
    { name: 'background', worker: true, entries: [manifest.background.service_worker] },
  ];
}

/**
 * What every rule finds wrong in `pages` and `list`, read through `readFile`, one line each
 * @param {{
 *   pages?: Record<string, string>,
 *   list?: typeof LIST,
 *   readFile?: (file: string) => string,
 *   listIndexedDb?: () => string[],
 * }} [options]
 * @returns {string[]}
 */
function problemsOf({
  pages = PAGES,
  list = LIST,
  readFile = defaultRead,
  listIndexedDb = () => fs.readdirSync(path.join(ROOT, INDEXEDDB)).filter(file => file.endsWith('.js')),
} = {}) {
  /** @type {string[]} */
  const problems = [];
  const writers = new Set(
    Object.entries(list.indexeddb)
      .filter(([, role]) => role === 'writer')
      .map(([file]) => `${INDEXEDDB}/${file}`),
  );
  const adapterGraph = new Set(
    [...reachGraph([path.join(ROOT, list.writeAdapter)], { readFile }).modules].map(relative),
  );
  const untilMoved = new Set(list.untilMoved.map(/** @param {{root: string}} row */ row => row.root));
  const inContext = new Set(list.inContext.map(/** @param {{file: string}} row */ row => row.file));
  /** @type {Map<string, Set<string>>} the roots each `reads` file may be loaded by */
  const reads = new Map(
    list.reads.map(/** @param {{file: string, roots: string[]}} row */ row => [row.file, new Set(row.roots)]),
  );
  const computedFiles = new Set(list.computedImports.map(/** @param {{file: string}} row */ row => row.file));

  // Every module under js/kernel/adapters/indexeddb/ has a role, and every role names one
  const present = listIndexedDb().sort();
  const classified = Object.keys(list.indexeddb).sort();
  for (const file of present) {
    if (!['writer', 'shared', 'in-context'].includes(list.indexeddb[file])) {
      problems.push(`${INDEXEDDB}/${file} has no role in the list's indexeddb (writer, shared or in-context)`);
    }
  }
  for (const file of classified) {
    if (!present.includes(file)) problems.push(`the list's indexeddb names ${INDEXEDDB}/${file}, which isn't there`);
  }

  /** @type {Set<string>} every module some page reaches */
  const reachedByPages = new Set();
  /** @type {Map<string, string[]>} each root's graph, `js/lib/` left out */
  const graphs = new Map();
  const roots = rootsOf({ pages, readFile });
  /** @type {Set<string>} each module worker read as a root already, by its path */
  const workerRoots = new Set();
  // A worklist: each module worker a root starts joins it, so one a worker starts does too
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (root.entries.length === 0) {
      problems.push(`${root.name} loads no script the test can read`);
      continue;
    }
    const { modules, computed, workers } = reachGraph(
      root.entries.map(entry => path.join(ROOT, entry)),
      { readFile },
    );
    // A module worker runs in a realm of its own, so it's a root of its own, never on untilMoved
    for (const started of workers.map(relative)) {
      if (workerRoots.has(started)) continue;
      workerRoots.add(started);
      roots.push({ name: started, worker: false, entries: [started] });
    }
    const graph = [...modules].map(relative).filter(file => !file.startsWith('js/lib/'));
    graphs.set(root.name, graph);
    for (const at of computed) {
      const file = relative(at.replace(/:\d+:\d+$/, ''));
      if (!computedFiles.has(file))
        problems.push(`${root.name} has an import() the test can't follow at ${relative(at)}`);
    }
    if (root.worker) continue;
    for (const file of graph) reachedByPages.add(file);
    const moving = untilMoved.has(root.name);
    // Rule 1: only the worker reaches a writer, but for #17's adapter's own on a page still moving
    for (const file of graph) {
      if (!writers.has(file)) continue;
      if (moving && adapterGraph.has(file)) continue;
      if (reads.get(file)?.has(root.name)) continue;
      problems.push(`${root.name} reaches ${file}, which writes CanvasTabDB: only the worker may (rule 1)`);
    }
    // Rule 2: a write the scan sees in a kernel module is one the list names for it
    for (const file of graph) {
      if (!file.startsWith('js/kernel/')) continue;
      const { hits } = scanned(file, readFile(path.join(ROOT, file)));
      if (hits.length === 0) continue;
      if (inContext.has(file)) continue;
      if (reads.get(file)?.has(root.name)) continue;
      if (moving && adapterGraph.has(file)) continue;
      problems.push(`${root.name} writes in ${file} (${hits[0].call}), which the list doesn't name (rule 2)`);
    }
  }
  // A row for a write no page makes any more goes, and so does a page's that no longer moves
  for (const row of [...list.inContext, ...list.handles, ...list.reads]) {
    if (!reachedByPages.has(row.file)) problems.push(`the list names ${row.file}, which no page reaches`);
  }
  for (const row of list.untilMoved) {
    if (!UNTIL_MOVED_4A.includes(row.root) && !UNTIL_MOVED_JOINED.includes(row.root)) {
      problems.push(`${row.root} joined untilMoved, which only shrinks (rule 3)`);
    }
    const graph = graphs.get(row.root);
    if (!graph) {
      problems.push(`untilMoved names ${row.root}, which isn't a page the build has`);
      continue;
    }
    if (!graph.includes(list.writeAdapter)) {
      problems.push(`${row.root} no longer reaches ${list.writeAdapter}, so its untilMoved row goes (rule 3)`);
    }
  }
  return problems;
}

/**
 * `readFile` with `plants` over the files they name, by their path from the repository root
 * @param {Record<string, (text: string) => string>} plants
 */
const planted = plants => (/** @type {string} */ file) => {
  const name = relative(file);
  if (Object.hasOwn(plants, name)) return plants[name](fs.existsSync(file) ? defaultRead(file) : '');
  return defaultRead(file);
};

describe("one committer: #35's architecture test (scope AC1, slice 4a)", () => {
  it('finds nothing wrong in the tree: the worker commits, four pages move in their slices, and each page write is one the list names', () => {
    assert.deepEqual(problemsOf(), []);
  });

  it("reads every page the build has, the worker, and the scripts each page's HTML loads", () => {
    const roots = rootsOf({ pages: PAGES, readFile: defaultRead });
    assert.deepEqual(roots.map(root => root.name).sort(), [...Object.keys(PAGES), 'background'].sort());
    for (const root of roots) assert.ok(root.entries.length > 0, root.name);
    assert.ok(roots.find(root => root.name === 'newtab')?.entries.includes('js/entries/newtab.js'));
  });

  it('fails a page off the list that imports the write adapter (rule 1)', () => {
    const problems = problemsOf({
      readFile: planted({ 'js/offscreen.js': text => `import './kernel/adapters/indexeddb/adapter.js';\n${text}` }),
    });
    assert.ok(
      problems.some(problem => problem.startsWith('offscreen reaches js/kernel/adapters/indexeddb/adapter.js')),
      problems.join('\n'),
    );
  });

  it('fails a page that reaches the write adapter through a literal import() alone (rule 1)', () => {
    const problems = problemsOf({
      readFile: planted({
        'js/offscreen.js': text =>
          `${text}\nexport const later = () => import('./kernel/adapters/indexeddb/adapter.js');\n`,
      }),
    });
    assert.ok(
      problems.some(problem => problem.startsWith('offscreen reaches js/kernel/adapters/indexeddb/adapter.js')),
      problems.join('\n'),
    );
  });

  it("checks a root the build gains with no edit here: a planted Moment page whose script reaches Popup's root fails (rule 1)", () => {
    const problems = problemsOf({
      pages: { ...PAGES, moment: 'moment.html' },
      readFile: planted({
        'moment.html': () => '<script type="module" src="js/moment-planted.js"></script>',
        'js/moment-planted.js': () => "import './kernel/composition/popup.js';\n",
      }),
    });
    assert.ok(
      problems.some(problem => problem.startsWith('moment reaches js/kernel/adapters/indexeddb/adapter.js')),
      problems.join('\n'),
    );
  });

  it('reads each module worker a root starts as a root of its own: the indexer importing the write adapter fails (rule 1, #204, F2)', () => {
    const problems = problemsOf({
      readFile: planted({
        'js/workers/indexer.js': text =>
          `import { createIndexedDbAdapter } from '../kernel/adapters/indexeddb/adapter.js';\nexport const planted = createIndexedDbAdapter;\n${text}`,
      }),
    });
    assert.ok(
      problems.some(problem =>
        problem.startsWith('js/workers/indexer.js reaches js/kernel/adapters/indexeddb/adapter.js'),
      ),
      problems.join('\n'),
    );
  });

  it('reads each module worker a worker starts as a root of its own too: a worker the indexer starts, importing the write adapter, fails (rule 1, #204, F2)', () => {
    const problems = problemsOf({
      readFile: planted({
        'js/workers/indexer.js': text =>
          `${text}\nexport const nested = () => new Worker(new URL('./nested.js', import.meta.url), { type: 'module' });\n`,
        'js/workers/nested.js': () =>
          "import { createIndexedDbAdapter } from '../kernel/adapters/indexeddb/adapter.js';\nexport const planted = createIndexedDbAdapter;\n",
      }),
    });
    assert.ok(
      problems.some(problem =>
        problem.startsWith('js/workers/nested.js reaches js/kernel/adapters/indexeddb/adapter.js'),
      ),
      problems.join('\n'),
    );
  });

  it("reaches no writer from the modules #17's read-only reader opens and reads with: connection.js, shapes.js and ledger.js (#35 slice 4b-0)", () => {
    const writers = new Set(
      Object.entries(LIST.indexeddb)
        .filter(([, role]) => role === 'writer')
        .map(([file]) => `${INDEXEDDB}/${file}`),
    );
    const files = ['connection.js', 'shapes.js', 'ledger.js'];
    const reached = Object.fromEntries(
      files.map(file => [
        file,
        [...reachGraph([path.join(ROOT, INDEXEDDB, file)], { readFile: defaultRead }).modules]
          .map(relative)
          .filter(module => writers.has(module)),
      ]),
    );
    assert.deepEqual(reached, Object.fromEntries(files.map(file => [file, []])));
  });

  it("reaches the registry's steps from no page: registry.js is in the worker's graph alone, every page's adapter takes none (#35 slice 4b-0b)", () => {
    const registry = `${INDEXEDDB}/registry.js`;
    const pages = rootsOf({ pages: PAGES, readFile: defaultRead }).filter(root => !root.worker);
    for (const name of ['newtab', 'popup', 'sidepanel', 'offscreen', 'recovery']) {
      assert.ok(
        pages.some(root => root.name === name),
        name,
      );
    }
    const reaching = pages
      .filter(root => {
        const { modules } = reachGraph(
          root.entries.map(entry => path.join(ROOT, entry)),
          { readFile: defaultRead },
        );
        return [...modules].map(relative).includes(registry);
      })
      .map(root => root.name);
    assert.deepEqual(reaching, []);
    const worker = rootsOf({ pages: PAGES, readFile: defaultRead }).find(root => root.worker);
    const { modules } = reachGraph(
      (worker?.entries || []).map(entry => path.join(ROOT, entry)),
      { readFile: defaultRead },
    );
    assert.ok([...modules].map(relative).includes(registry), "the worker's graph holds the steps");
  });

  it("fails a page's write the list doesn't name (rule 2)", () => {
    const problems = problemsOf({
      readFile: planted({
        'js/kernel/composition/sidepanel.js': text =>
          `${text}\nexport const planted = () => localStorage.setItem('planted', '1');\n`,
      }),
    });
    assert.ok(
      problems.some(problem => problem.startsWith('sidepanel writes in js/kernel/composition/sidepanel.js')),
      problems.join('\n'),
    );
  });

  it('fails recovery.html without its untilMoved row, which reaches the write adapter (rule 1, #115)', () => {
    const list = {
      ...LIST,
      untilMoved: LIST.untilMoved.filter(/** @param {{root: string}} row */ row => row.root !== 'recovery'),
    };
    const problems = problemsOf({ list });
    assert.ok(
      problems.includes(
        'recovery reaches js/kernel/adapters/indexeddb/adapter.js, which writes CanvasTabDB: only the worker may (rule 1)',
      ),
      problems.join('\n'),
    );
  });

  it("reaches #17's reader alone from Popup's start, with its untilMoved row gone: no writer, and no write but the reader's open, which the list reads on popup (#35 slice 4b-2)", () => {
    const connection = 'js/kernel/adapters/indexeddb/connection.js';
    const list = {
      ...LIST,
      untilMoved: LIST.untilMoved.filter(/** @param {{root: string}} row */ row => row.root !== 'popup'),
      reads: [
        ...LIST.reads.filter(/** @param {{file: string}} row */ row => row.file !== connection),
        { file: connection, roots: ['popup'], why: "the reader's open, in existing mode", owner: 35 },
      ],
    };
    assert.deepEqual(
      problemsOf({ list }).filter(problem => problem.startsWith('popup ')),
      [],
    );
  });

  it('fails an untilMoved row whose page no longer reaches the adapter, and a page that joins the list (rule 3)', () => {
    const list = {
      ...LIST,
      untilMoved: [
        ...LIST.untilMoved,
        { root: 'offscreen', builds: 'js/offscreen.js', writes: 'nothing', owner: 35, removeWhen: 'never' },
      ],
    };
    const problems = problemsOf({ list });
    assert.ok(problems.includes('offscreen joined untilMoved, which only shrinks (rule 3)'), problems.join('\n'));
    // recovery.html's one join opens the list to no other page
    assert.ok(!problems.some(problem => problem.startsWith('recovery joined')), problems.join('\n'));
    assert.ok(
      problems.includes(
        'offscreen no longer reaches js/kernel/adapters/indexeddb/adapter.js, so its untilMoved row goes (rule 3)',
      ),
      problems.join('\n'),
    );
  });

  it('fails a module under adapters/indexeddb/ the list gives no role, and a role for one that went', () => {
    const problems = problemsOf({
      listIndexedDb: () => [...Object.keys(LIST.indexeddb).filter(file => file !== 'space.js'), 'planted.js'],
    });
    assert.ok(
      problems.includes(`${INDEXEDDB}/planted.js has no role in the list's indexeddb (writer, shared or in-context)`),
      problems.join('\n'),
    );
    assert.ok(
      problems.includes(`the list's indexeddb names ${INDEXEDDB}/space.js, which isn't there`),
      problems.join('\n'),
    );
  });

  it("fails a list row for a write no page makes any more, and an import() it can't follow", () => {
    const list = {
      ...LIST,
      handles: [...LIST.handles, { file: 'js/product/topology.js', writes: 'sessionStorage', owner: 1 }],
    };
    const stale = problemsOf({ list });
    assert.ok(stale.includes('the list names js/product/topology.js, which no page reaches'), stale.join('\n'));
    const computed = problemsOf({
      readFile: planted({ 'js/offscreen.js': text => `${text}\nexport const anywhere = name => import(name);\n` }),
    });
    assert.ok(
      computed.some(problem =>
        problem.startsWith("offscreen has an import() the test can't follow at js/offscreen.js:"),
      ),
      computed.join('\n'),
    );
  });
});
