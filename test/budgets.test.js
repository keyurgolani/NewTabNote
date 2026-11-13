// #27 slice 4b: the analyzer and the budget gate (scripts/build/budgets.js) on a bundle the test
// writes, build/budgets.json with the owner's numbers, and the timing and heap summary CI's perf
// job writes (scripts/perf/gate-report.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyze, checkBudgets, readBudgets, fileProblems, matches, packageOf, startChunksOf, WORKER_ONLY_MODULES, LAZY_ONLY_MODULES } = require('../scripts/build/budgets.js');
const { fromMap } = require('../scripts/build/package-files.js');
const { gateReport } = require('../scripts/perf/gate-report.js');
const { fixtureProblems } = require('../scripts/perf-probe.js');

const ROOT = path.join(__dirname, '..');
const BUDGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/budgets.json'), 'utf8'));
const KIB = 1024;

/**
 * A chunk as the bundler's report has it
 * @param {Partial<import('../scripts/build/vite-config.js').ChunkReport> & {fileName: string}} chunk
 */
const chunk = chunk => ({
  pass: 'pages',
  name: path.posix.basename(chunk.fileName, '.js'),
  isEntry: false,
  isDynamicEntry: false,
  facadeModuleId: null,
  moduleIds: [],
  imports: [],
  dynamicImports: [],
  importedCss: [],
  commonJs: [],
  ...chunk,
});
const id = file => path.join(ROOT, file);

/** A small built package: a page that boots a loader chunk, a popup, and with `sidePanel` a side panel */
function bundleFixture({ extraStart = [], popupBytes = 10, sidePanel = false } = {}) {
  const files = new Map([
    ['newtab.html', Buffer.from('<link rel="stylesheet" href="/assets/newtab.css"><link rel="modulepreload" href="/js/runtime/lazy.js"><script type="module" src="/assets/newtab.js"></script><script src="js/entries/boot-guard.js"></script>')],
    ['popup.html', Buffer.from('<script type="module" src="/assets/popup.js"></script>')],
    ['js/background.js', Buffer.from('self.x = 1;')],
    ['js/entries/boot-guard.js', Buffer.from('window.guard = 1;')],
    ['js/runtime/lazy.js', Buffer.from('export const loader = 1;')],
    ['assets/newtab.js', Buffer.from('import "../js/runtime/lazy.js"; import("./workspace.js");')],
    ['assets/newtab.css', Buffer.from('@font-face { src: url(./font.woff2); } body { margin: 0 }')],
    ['assets/font.woff2', Buffer.from('font')],
    ['assets/workspace.js', Buffer.from('import "./host.js"; import("./trust.js"); new Worker(new URL("./indexer.js", import.meta.url));')],
    ['assets/workspace.css', Buffer.from('.w { color: red }')],
    ['assets/host.js', Buffer.from('export const host = 1;')],
    ['assets/trust.js', Buffer.from('export const trust = 1;')],
    ['assets/indexer.js', Buffer.from('self.onmessage = () => {};')],
    ['assets/popup.js', Buffer.from('x'.repeat(popupBytes))],
    ['js/lib/chart.js', Buffer.from('window.Chart = 1;')],
    ['js/lib/fuse.js', Buffer.from('window.Fuse = 1;')],
    ['js/lib/jszip.min.js', Buffer.from('window.JSZip = 1;')],
    ['js/lib/transformers.js', Buffer.from('window.transformers = 1;')],
  ]);
  if (sidePanel) {
    files.set('sidepanel.html', Buffer.from('<script type="module" src="/assets/sidepanel.js"></script>'));
    files.set('assets/sidepanel.js', Buffer.from('export const panel = 1;'));
  }
  const chunks = [
    chunk({ fileName: 'assets/newtab.js', isEntry: true, imports: ['js/runtime/lazy.js'], dynamicImports: ['assets/workspace.js'], moduleIds: [id('js/entries/newtab.js')] }),
    chunk({ fileName: 'js/runtime/lazy.js', moduleIds: [id('js/runtime/lazy.js')] }),
    chunk({ fileName: 'assets/workspace.js', isDynamicEntry: true, imports: ['assets/host.js'], dynamicImports: ['assets/trust.js'], importedCss: ['assets/workspace.css'], moduleIds: [id('js/workspace.js'), id('js/llm.js'), ...extraStart.map(id)] }),
    chunk({ fileName: 'assets/host.js', moduleIds: [id('js/kernel/composition/host.js'), id('js/lib/valibot/index.mjs')] }),
    chunk({ fileName: 'assets/trust.js', isDynamicEntry: true, moduleIds: [id('js/trust/core/journal.js')] }),
    chunk({ fileName: 'assets/indexer.js', pass: 'worker', isEntry: true, moduleIds: [id('js/workers/indexer.js'), id('node_modules/some-parser/index.js')] }),
    chunk({ fileName: 'assets/popup.js', isEntry: true, moduleIds: [id('js/popup.js'), id('js/lib/valibot/index.mjs')] }),
    chunk({ fileName: 'js/background.js', pass: 'background', isEntry: true, moduleIds: [id('js/background.js')] }),
    ...(sidePanel ? [chunk({ fileName: 'assets/sidepanel.js', isEntry: true, moduleIds: [id('js/sidepanel.js'), id('js/lib/valibot/index.mjs')] })] : []),
  ];
  const loaderChunks = { workspace: 'assets/workspace.js', trust: 'assets/trust.js', newtab: 'assets/newtab.js', popup: 'assets/popup.js' };
  return { files: fromMap(files, 'the fixture'), chunks, loaderChunks: sidePanel ? { ...loaderChunks, sidepanel: 'assets/sidepanel.js' } : loaderChunks };
}

/** A row with room for anything the fixtures build */
const ROOMY = Object.freeze({ raw: 100 * KIB, gzip: 100 * KIB });
/** The package row: the zip's number, and update size waiting on #31's release gate (#300) */
const PACKAGE_ROW = Object.freeze({ zipBytes: 10 * KIB * KIB, updateBytes: null, waitsOn: { updateBytes: '#31' }, reason: 'the zip' });

/**
 * A budget file for the fixture, `entries` merged over the default rows. Each row the fixture's
 * build needs holds a number, or names the issue it waits on (#300)
 */
function budgetsFor(entries = {}) {
  return {
    package: PACKAGE_ROW,
    forbidden: {
      'chart-library': { about: 'Chart.js', paths: ['js/lib/chart.js'] },
      trust: { about: 'the trust code', paths: ['js/trust/**'] },
      'remote-ai': { about: 'remote AI clients', paths: ['js/llm.js'] },
      'model-runtime': { about: 'model runtimes', paths: ['js/lib/transformers.js'] },
      'archive-trash': { about: 'none yet', paths: [] },
    },
    entries: {
      newtab: {
        page: 'newtab.html',
        startChunks: ['workspace'],
        reason: 'the tab',
        start: { js: { raw: 100 * KIB, gzip: 100 * KIB }, css: ROOMY, html: ROOMY, fonts: ROOMY },
        modules: 100,
        forbidden: ['chart-library', 'trust', 'model-runtime'],
        dependencies: ['@xenova/transformers', 'chart.js', 'fuse.js', 'jszip', 'some-parser', 'valibot'],
      },
      popup: { page: 'popup.html', reason: 'the popup', start: { js: { raw: 1000, gzip: 1000 }, html: ROOMY }, modules: 100, forbidden: ['remote-ai', 'trust'], dependencies: ['valibot'] },
      background: { reason: 'the worker', start: { js: ROOMY }, modules: 100, coldStart: null, waitsOn: { coldStart: '#35' } },
      moment: { chunk: 'moment', planned: true, reason: 'not built yet', start: {}, waitsOn: { js: '#2', css: '#2', html: '#2', fonts: '#2', modules: '#2' }, forbidden: ['remote-ai', 'trust', 'chart-library'], dependencies: [] },
      ...entries,
    },
  };
}

describe('the analyzer (scripts/build/budgets.js)', () => {
  it("counts a page's start: its scripts, preloads, stylesheets and fonts, and the loader chunks it boots, with what they import", () => {
    const { files, chunks, loaderChunks } = bundleFixture();
    const graphs = analyze({ chunks, files, loaderChunks, budgets: budgetsFor() });
    const newtab = graphs.newtab;
    assert.deepEqual(newtab.start.files.map(entry => [entry.file, entry.type]), [
      ['assets/font.woff2', 'fonts'],
      ['assets/host.js', 'js'],
      ['assets/newtab.css', 'css'],
      ['assets/newtab.js', 'js'],
      ['assets/workspace.css', 'css'],
      ['assets/workspace.js', 'js'],
      ['js/entries/boot-guard.js', 'js'],
      ['js/runtime/lazy.js', 'js'],
      ['newtab.html', 'html'],
    ]);
    assert.equal(newtab.start.bytes.js.files, 5);
    assert.equal(newtab.start.bytes.js.raw, ['assets/host.js', 'assets/newtab.js', 'assets/workspace.js', 'js/entries/boot-guard.js', 'js/runtime/lazy.js'].reduce((sum, file) => sum + files.read(file).length, 0));
    assert.ok(newtab.start.modules.includes('js/workspace.js') && newtab.start.modules.includes('js/llm.js'));
    // What the workspace's import() loads, and the libraries the loader puts in, are lazy
    assert.deepEqual(newtab.lazy.files.map(entry => entry.file), ['assets/trust.js', 'js/lib/chart.js', 'js/lib/fuse.js', 'js/lib/jszip.min.js', 'js/lib/transformers.js']);
    assert.deepEqual(newtab.workers.files.map(entry => entry.file), ['assets/indexer.js']);
    assert.deepEqual(newtab.start.packages, ['valibot']);
    assert.deepEqual(newtab.lazy.packages, ['@xenova/transformers', 'chart.js', 'fuse.js', 'jszip']);
    assert.deepEqual(newtab.workers.packages, ['some-parser']);
    assert.deepEqual(graphs.popup.start.packages, ['valibot']);
    assert.equal(graphs.moment, undefined, 'a planned chunk the build lacks has no graph');
  });

  it("counts the network guard, the guard pass's classic script each page loads first, in the page's start, with the modules it bundles (#21 slice 1b)", () => {
    const guard = 'var g=1;'.repeat(50);
    const files = fromMap(new Map([
      ['popup.html', Buffer.from('<script src="js/network-guard.js"></script><script type="module" src="/assets/popup.js"></script>')],
      ['js/network-guard.js', Buffer.from(guard)],
      ['assets/popup.js', Buffer.from('x'.repeat(10))],
    ]), 'the fixture');
    const chunks = [
      chunk({ fileName: 'js/network-guard.js', pass: 'guard', name: 'network-guard', isEntry: true, moduleIds: [id('js/kernel/composition/destination-match.js'), id('js/kernel/composition/network-guard.js'), id('js/network-guard.js')] }),
      chunk({ fileName: 'assets/popup.js', isEntry: true, moduleIds: [id('js/popup.js')] }),
    ];
    const budgets = { forbidden: { 'destination-client': { about: 'the full client', paths: ['js/kernel/composition/destinations.js'] } }, entries: { popup: { page: 'popup.html', reason: 'the popup', start: { js: { raw: 1000, gzip: 1000 } }, forbidden: ['destination-client'], dependencies: [] } } };
    const popup = analyze({ chunks, files, loaderChunks: { popup: 'assets/popup.js' }, budgets }).popup;
    assert.deepEqual(popup.start.files.filter(entry => entry.type === 'js').map(entry => entry.file), ['assets/popup.js', 'js/network-guard.js']);
    assert.equal(popup.start.bytes.js.raw, guard.length + 10);
    assert.ok(popup.start.modules.includes('js/kernel/composition/network-guard.js'), popup.start.modules.join(', '));
    assert.ok(!popup.start.modules.includes('js/kernel/composition/destinations.js'));
  });

  it('counts the chunk the root loads at once as start, not lazy, so the row measures the tab and not only its root', () => {
    const { files, chunks, loaderChunks } = bundleFixture();
    const booted = analyze({ chunks, files, loaderChunks, budgets: budgetsFor() }).newtab;
    assert.deepEqual(booted.boots, [{ chunk: 'workspace', as: 'start', file: 'assets/workspace.js', from: 'assets/newtab.js' }]);
    assert.equal(booted.unclassified, undefined);
    // Without startChunks the workspace and what it imports would be lazy, the way the byte-mode
    // probe files them, and start JS would be the root, its loader and the boot guard
    const rootOnly = analyze({ chunks, files, loaderChunks, budgets: budgetsFor({ newtab: { ...budgetsFor().entries.newtab, startChunks: undefined } }) }).newtab;
    assert.ok(rootOnly.lazy.files.some(entry => entry.file === 'assets/workspace.js') && rootOnly.lazy.files.some(entry => entry.file === 'assets/host.js'));
    assert.ok(!booted.lazy.files.some(entry => entry.file === 'assets/workspace.js' || entry.file === 'assets/host.js'));
    const sum = list => list.reduce((total, file) => total + files.read(file).length, 0);
    assert.equal(rootOnly.start.bytes.js.raw, sum(['assets/newtab.js', 'js/entries/boot-guard.js', 'js/runtime/lazy.js']));
    assert.equal(booted.start.bytes.js.raw, rootOnly.start.bytes.js.raw + sum(['assets/workspace.js', 'assets/host.js']));
    assert.ok(booted.start.modules.includes('js/kernel/composition/host.js'));
    // The root's import() of the workspace is then named nowhere, which the gate refuses
    assert.deepEqual(rootOnly.unclassified, ['assets/workspace.js']);
  });

  it("reads the service worker's graph from its own pass", () => {
    const fixture = bundleFixture();
    fixture.chunks = fixture.chunks.map(entry => (entry.pass === 'background' ? { ...entry, moduleIds: [...entry.moduleIds, id('js/lib/valibot/index.mjs')] } : entry));
    const worker = analyze({ ...fixture, budgets: budgetsFor() }).background;
    assert.equal(worker.kind, 'worker');
    assert.deepEqual(worker.start.files.map(entry => entry.file), ['js/background.js']);
    assert.deepEqual(worker.start.modules, ['js/background.js', 'js/lib/valibot/index.mjs']);
    assert.deepEqual(worker.start.packages, ['valibot']);
  });

  it('names a package by node_modules or its vendored record, and matches globs by folder', () => {
    const vendored = new Map([['js/lib/chart.js', 'chart.js'], ['js/lib/valibot/', 'valibot']]);
    assert.equal(packageOf('node_modules/@scope/pkg/x.js', vendored), '@scope/pkg');
    assert.equal(packageOf('js/lib/valibot/index.mjs', vendored), 'valibot');
    assert.equal(packageOf('js/lib/chart.js', vendored), 'chart.js');
    assert.equal(packageOf('js/app.js', vendored), null);
    assert.ok(matches('js/trust/**', 'js/trust/core/journal.js'));
    assert.ok(matches('**/*.wasm', 'assets/ort.wasm'));
    assert.ok(!matches('js/trust/*', 'js/trust/core/journal.js'));
    assert.ok(!matches('js/workspace.js', 'js/kernel/core/application/workspace-data.js'));
  });
});

describe('the budget gate', () => {
  const run = (budgets, fixture = bundleFixture()) => {
    const graphs = analyze({ ...fixture, budgets });
    return checkBudgets(graphs, budgets, fixture).map(({ code, subject, message }) => `${code} ${subject}: ${message}`);
  };

  it('passes a build within its rows', () => {
    assert.deepEqual(run(budgetsFor()), []);
  });

  it("fails an entry's start over a row, raw or gzip", () => {
    const problems = run(budgetsFor(), bundleFixture({ popupBytes: 1200 }));
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /^budget\/bytes popup: its start JS is \d+ bytes raw \(1\.\d KiB\), over its 1000 \(1\.0 KiB\)/);
    const { popup } = budgetsFor().entries;
    const gzipOnly = run(budgetsFor({ popup: { ...popup, start: { ...popup.start, js: { raw: 1e6, gzip: 1 } } } }));
    assert.match(gzipOnly.join('\n'), /^budget\/bytes popup: its start JS is \d+ bytes gzip/);
  });

  it("fails an entry's start over its module row, the count the build's line prints, and gates nothing on a null row that names the issue it waits on (#300)", () => {
    const { newtab, popup, background } = budgetsFor().entries;
    // The fixture's Popup starts with popup.html, js/popup.js and valibot, and the worker is its one module
    assert.deepEqual(run(budgetsFor({ popup: { ...popup, modules: 3 }, background: { ...background, modules: 1 } })), []);
    assert.deepEqual(run(budgetsFor({ popup: { ...popup, modules: 2 }, background: { ...background, modules: 0 } })), [
      'budget/modules popup: its start has 3 modules, over its 2; a number over a row goes to the owner, not into the row',
      'budget/modules background: its start has 1 module, over its 0; a number over a row goes to the owner, not into the row',
    ]);
    // The new tab's start holds 11, beside a lazy chunk, the four libraries and a worker, which the row
    // doesn't count: it holds the start alone, as the build's line does
    assert.deepEqual(run(budgetsFor({ newtab: { ...newtab, modules: 11 } })), []);
    assert.deepEqual(run(budgetsFor({ newtab: { ...newtab, modules: 10 } })), [
      'budget/modules newtab: its start has 11 modules, over its 10; a number over a row goes to the owner, not into the row',
    ]);
    assert.deepEqual(run(budgetsFor({ popup: { ...popup, modules: null, waitsOn: { modules: '#4' } } })), []);
  });

  it("fails a row an entry needs that's null or missing with no issue named for it in waitsOn, so a deferred row reads apart from a missing one (#300)", () => {
    const { newtab, popup, background, moment } = budgetsFor().entries;
    const missing = (/** @type {string} */ name, /** @type {string} */ row) => `budget/entry ${name}: its ${row} row has no number and no issue named for it in waitsOn: set its number by review, from CI's figure, or name the issue it waits on`;
    // Rows the build has something for: the new tab's start CSS, Popup's modules, the worker's cold start
    assert.deepEqual(run(budgetsFor({
      newtab: { ...newtab, start: { ...newtab.start, css: null } },
      popup: { ...popup, modules: undefined },
      background: { ...background, waitsOn: undefined },
    })), [missing('newtab', 'start CSS'), missing('popup', 'modules'), missing('background', 'coldStart')]);
    // Named, each waits on its issue and gates nothing
    assert.deepEqual(run(budgetsFor({ newtab: { ...newtab, start: { ...newtab.start, css: null }, waitsOn: { css: '#16' } }, popup: { ...popup, modules: null, waitsOn: { modules: '#4' } } })), []);
    // A type the start doesn't have needs no row: the fixture's Popup loads no stylesheet
    assert.deepEqual(run(budgetsFor({ popup: { ...popup, start: { ...popup.start, css: null } } })), []);
    // A planned row names the issue that builds it, for each row it leaves null
    const { fonts, ...rest } = moment.waitsOn;
    assert.equal(fonts, '#2');
    assert.deepEqual(run(budgetsFor({ moment: { ...moment, waitsOn: rest } })), [missing('moment', 'start FONTS')]);
    // The package's rows: the zip's, and update size's, which #31's release gate sets (#31 slice 3)
    const budgets = budgetsFor();
    budgets.package = { ...PACKAGE_ROW, zipBytes: null, waitsOn: {} };
    assert.deepEqual(run(budgets), [missing('package', 'zipBytes'), missing('package', 'updateBytes')]);
  });

  it("refuses a reads row outside the new tab's routes, and a reads or requests row that isn't a whole number, and lets waitsOn name either (#300)", () => {
    const { newtab, popup } = budgetsFor().entries;
    const file = (/** @type {object} */ entries) => fileProblems(budgetsFor(entries)).map(({ message }) => message);
    assert.deepEqual(file({ newtab: { ...newtab, reads: 40, requests: 0 }, popup: { ...popup, requests: 2 } }), []);
    assert.deepEqual(file({ popup: { ...popup, reads: 3 } }), ['entry popup has a reads row, which only the new tab and Moment have']);
    for (const value of [1.5, -1, '3']) {
      assert.deepEqual(file({ newtab: { ...newtab, reads: value } }), ["entry newtab's reads row isn't a whole number"], String(value));
      assert.deepEqual(file({ popup: { ...popup, requests: value } }), ["entry popup's requests row isn't a whole number"], String(value));
    }
    assert.deepEqual(file({ newtab: { ...newtab, reads: null, waitsOn: { reads: '#16' } }, popup: { ...popup, requests: null, waitsOn: { requests: '#4' } } }), []);
  });

  it("refuses a waitsOn that names a row the entry can't have, a row with a number, or no issue, and a cold start or update size that isn't whole (#300)", () => {
    const { popup, background } = budgetsFor().entries;
    const file = (/** @type {object} */ entries, /** @type {object} */ row = {}) => fileProblems({ ...budgetsFor(entries), package: { ...PACKAGE_ROW, ...row } }).map(({ message }) => message);
    assert.deepEqual(file({ popup: { ...popup, waitsOn: '#4' } }), ["entry popup's waitsOn isn't a map of rows to issues"]);
    assert.deepEqual(file({ popup: { ...popup, waitsOn: { jss: '#4' } } }), ["entry popup's waitsOn names jss, which isn't one of its rows"]);
    assert.deepEqual(file({ popup: { ...popup, waitsOn: { coldStart: '#35' } } }), ["entry popup's waitsOn names coldStart, which isn't one of its rows"]);
    assert.deepEqual(file({ popup: { ...popup, waitsOn: { css: '4' } } }), ["entry popup's waitsOn gives css 4, which isn't an issue like #31"]);
    assert.deepEqual(file({ popup: { ...popup, waitsOn: { modules: '#4' } } }), ["entry popup's modules row has a number, and waitsOn still names #4 for it"]);
    assert.deepEqual(file({ popup: { ...popup, coldStart: 900 } }), ['entry popup has a coldStart row, which only the service worker has']);
    for (const coldStart of [1.5, -1, '900']) assert.deepEqual(file({ background: { ...background, coldStart, waitsOn: undefined } }), ["entry background's coldStart row isn't a whole number of milliseconds"], String(coldStart));
    for (const updateBytes of [1.5, -1, '900']) assert.deepEqual(file({}, { updateBytes, waitsOn: undefined }), ["the package's updateBytes row isn't a whole number of bytes"], String(updateBytes));
    assert.deepEqual(file({}, { waitsOn: { zipBytes: '#31', updateBytes: '#31' } }), ["the package's zipBytes row has a number, and waitsOn still names #31 for it"]);
  });

  it("refuses a module row that isn't a whole number of modules, and a package row that isn't whole bytes with a reason (#300)", () => {
    const { popup } = budgetsFor().entries;
    for (const modules of [1.5, -1, '60', {}]) {
      assert.deepEqual(fileProblems(budgetsFor({ popup: { ...popup, modules } })).map(({ message }) => message), ["entry popup's modules row isn't a whole number of modules"], String(modules));
    }
    const zip = (/** @type {unknown} */ row) => fileProblems({ ...budgetsFor(), package: row }).map(({ message }) => message);
    assert.deepEqual(zip({ zipBytes: 1000, reason: 'the zip' }), []);
    assert.deepEqual(zip({ zipBytes: null, reason: 'the zip' }), []);
    for (const zipBytes of [1.5, -1, '1000', {}]) assert.deepEqual(zip({ zipBytes, reason: 'the zip' }), ["the package's zipBytes row isn't a whole number of bytes"], String(zipBytes));
    assert.deepEqual(zip({ zipBytes: 1000 }), ['the package row has no reason']);
    assert.deepEqual(zip('the zip'), ["the package row isn't a row"]);
  });

  it('fails a forbidden module on the start path, not in a lazy chunk', () => {
    assert.deepEqual(run(budgetsFor(), bundleFixture({ extraStart: ['js/lib/chart.js'] })), [
      'budget/forbidden newtab: its start path holds chart-library (Chart.js): js/lib/chart.js',
    ]);
    // The trust code is in the fixture's lazy trust chunk, and passes
    assert.ok(!run(budgetsFor()).some(line => line.includes('trust')));
  });

  // The worker's modules #35 slice 3c moved off the pages' start, and the page commands' operations
  // #35 slice 4d keeps off them, as the test's own copy: the gate's list is pinned to it, and the
  // cases after the pin put each one on each page's start
  const WORKER_ONLY = [
    'js/kernel/adapters/indexeddb/integrity.js',
    'js/kernel/adapters/indexeddb/ledger-sweep.js',
    'js/kernel/adapters/indexeddb/worker-tasks.js',
    'js/kernel/composition/page-operations.js',
    'js/kernel/core/application/integrity-check.js',
    'js/kernel/core/application/record-catch-up.js',
  ];
  /** Side Panel's row, for a fixture that has its page */
  const sidePanelRow = { page: 'sidepanel.html', reason: 'the side panel', start: { js: { raw: 1000, gzip: 1000 }, html: ROOMY }, modules: 100, forbidden: ['remote-ai', 'trust'], dependencies: ['valibot'] };
  const workerOnly = (/** @type {string} */ page, /** @type {string} */ file) => `budget/worker-only ${page}: its start holds ${file}, which only the service worker runs`;

  it("fails a page's start that holds a module only the service worker runs, by the module and the page, and passes the worker that holds it (#35 slice 3c)", () => {
    // The gate's list is the copy above, each a file of the tree
    assert.deepEqual(WORKER_ONLY_MODULES, WORKER_ONLY);
    for (const file of WORKER_ONLY_MODULES) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is in the tree`);
    // On the new tab's start, through the chunk its root boots
    assert.deepEqual(run(budgetsFor(), bundleFixture({ extraStart: ['js/kernel/core/application/record-catch-up.js'] })), [
      'budget/worker-only newtab: its start holds js/kernel/core/application/record-catch-up.js, which only the service worker runs',
    ]);
    // On Popup's, in its own chunk
    const popup = bundleFixture();
    popup.chunks = popup.chunks.map(entry => (entry.fileName === 'assets/popup.js' ? { ...entry, moduleIds: [...entry.moduleIds, id('js/kernel/adapters/indexeddb/integrity.js')] } : entry));
    assert.deepEqual(run(budgetsFor(), popup), [
      'budget/worker-only popup: its start holds js/kernel/adapters/indexeddb/integrity.js, which only the service worker runs',
    ]);
    // The service worker holds them, and a page's start without one passes
    const worker = bundleFixture();
    worker.chunks = worker.chunks.map(entry => (entry.pass === 'background' ? { ...entry, moduleIds: [...entry.moduleIds, id('js/kernel/core/application/record-catch-up.js')] } : entry));
    assert.deepEqual(run(budgetsFor(), worker), []);
  });

  it("fails each of the worker's modules on the new tab's, Popup's and Side Panel's start, each by the module and the page (#35 slice 3c)", () => {
    const budgets = budgetsFor({ sidepanel: sidePanelRow });
    assert.deepEqual(run(budgets, bundleFixture({ sidePanel: true })), []);
    for (const file of WORKER_ONLY) {
      for (const [page, entryChunk] of [['newtab', 'assets/newtab.js'], ['popup', 'assets/popup.js'], ['sidepanel', 'assets/sidepanel.js']]) {
        const fixture = bundleFixture({ sidePanel: true });
        fixture.chunks = fixture.chunks.map(entry => (entry.fileName === entryChunk ? { ...entry, moduleIds: [...entry.moduleIds, id(file)] } : entry));
        assert.deepEqual(run(budgets, fixture), [workerOnly(page, file)], `${file} on ${page}'s start`);
      }
    }
  });

  it("fails each page whose start reaches one of the worker's modules through a chunk the pages share, as all three reached the integrity check through the host chunk (#35 slice 3c)", () => {
    // The host chunk: the new tab's start reaches it through the chunk its root boots, and
    // Popup's and Side Panel's through their own entries' imports
    const fixture = bundleFixture({ sidePanel: true });
    fixture.chunks = fixture.chunks.map(entry => {
      if (entry.fileName === 'assets/host.js') return { ...entry, moduleIds: [...entry.moduleIds, id('js/kernel/adapters/indexeddb/integrity.js')] };
      if (entry.fileName === 'assets/popup.js' || entry.fileName === 'assets/sidepanel.js') return { ...entry, imports: ['assets/host.js'] };
      return entry;
    });
    assert.deepEqual(
      run(budgetsFor({ sidepanel: sidePanelRow }), fixture),
      ['newtab', 'popup', 'sidepanel'].map(page => workerOnly(page, 'js/kernel/adapters/indexeddb/integrity.js')),
    );
  });

  // The modules that load only at their first use, as the test's own copy: the gate's list is
  // pinned to it, and the case puts each one on each page's start and in a lazy chunk
  const LAZY_ONLY = [
    'js/kernel/composition/trust-status-ask.js',
    'js/kernel/composition/trust-status.js',
    'js/ui/menu-keys.js',
  ];
  const lazyOnly = (/** @type {string} */ page, /** @type {string} */ file) => `budget/lazy-only ${page}: its start holds ${file}, which loads only at its first use, through the page's loader`;

  it("fails a page's start that holds a module that loads only at its first use, by the module and the page, and passes the lazy chunk that holds it (#14 slice 4)", () => {
    // The gate's list is the copy above, each a file of the tree: the new tab's status read's
    // ask, first in its deferred work, and its status lines, when an answer could put a line in
    // the sidebar or Settings opens, and the block menus' roles and keys, at a menu's first open
    assert.deepEqual(LAZY_ONLY_MODULES, LAZY_ONLY);
    for (const file of LAZY_ONLY_MODULES) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is in the tree`);
    const budgets = budgetsFor({ sidepanel: sidePanelRow });
    for (const file of LAZY_ONLY) {
      // Imported statically: on the new tab's start, through the chunk its root boots, and on
      // Popup's and Side Panel's, in their own chunks
      for (const [page, holder] of [['newtab', 'assets/workspace.js'], ['popup', 'assets/popup.js'], ['sidepanel', 'assets/sidepanel.js']]) {
        const fixture = bundleFixture({ sidePanel: true });
        fixture.chunks = fixture.chunks.map(entry => (entry.fileName === holder ? { ...entry, moduleIds: [...entry.moduleIds, id(file)] } : entry));
        assert.deepEqual(run(budgets, fixture), [lazyOnly(page, file)], `${file} on ${page}'s start`);
      }
      // In a chunk the new tab's start loads with import(), it's lazy, and passes
      const lazy = bundleFixture({ sidePanel: true });
      lazy.chunks = lazy.chunks.map(entry => (entry.fileName === 'assets/trust.js' ? { ...entry, moduleIds: [...entry.moduleIds, id(file)] } : entry));
      const graph = analyze({ ...lazy, budgets }).newtab;
      assert.ok(graph.lazy.modules.includes(file) && !graph.start.modules.includes(file), `${file} is lazy`);
      assert.deepEqual(run(budgets, lazy), []);
    }
  });

  // #35 slice 4b-2's chunk layout, as 4d leaves it. The first page pass has two named groups:
  // host, which every page's start shares and which holds Vite's preload helper, and adapter, the
  // half of #17's adapter no page's start loads, since each reads through #17's reader. Recovery's
  // own pass takes neither.
  const HELPER = '\0vite/preload-helper.js';
  /**
   * The pages after 4d, with `changes` applied: the new tab boots the workspace chunk, which
   * imports host, and with `newTabAdapter` the adapter chunk too; Popup imports host and loads its
   * send chunk, which holds valibot, with import(); Side Panel imports host; recovery has its own
   * entry and its own copy of the helper
   * @param {{helperChunk?: boolean, newTabAdapter?: boolean, popupAdapter?: boolean, popupValibot?: boolean, sidePanelAdapter?: boolean, recoveryAdapter?: boolean}} [changes]
   */
  function layoutFixture({ helperChunk = false, newTabAdapter = false, popupAdapter = false, popupValibot = false, sidePanelAdapter = false, recoveryAdapter = false } = {}) {
    const helperFile = helperChunk ? ['assets/preload-helper.js'] : [];
    const files = new Map([
      ['newtab.html', Buffer.from('<link rel="modulepreload" href="/js/runtime/lazy.js"><script type="module" src="/assets/newtab.js"></script>')],
      ['popup.html', Buffer.from('<script type="module" src="/assets/popup.js"></script>')],
      ['sidepanel.html', Buffer.from('<script type="module" src="/assets/sidepanel.js"></script>')],
      ['recovery.html', Buffer.from('<script type="module" src="/assets/recovery.js"></script>')],
      ['js/background.js', Buffer.from('self.x = 1;')],
      ['js/runtime/lazy.js', Buffer.from('export const loader = 1;')],
      ['assets/newtab.js', Buffer.from('import "../js/runtime/lazy.js"; import("./workspace.js");')],
      ['assets/workspace.js', Buffer.from(newTabAdapter ? 'import "./host.js"; import "./adapter.js";' : 'import "./host.js";')],
      ['assets/host.js', Buffer.from('export const host = 1;')],
      ['assets/adapter.js', Buffer.from('export const adapter = 1;')],
      ['assets/popup.js', Buffer.from('import "./host.js"; import("./popup-send-chunk.js");')],
      ['assets/popup-send-chunk.js', Buffer.from('export const send = 1;')],
      ['assets/sidepanel.js', Buffer.from('import "./host.js";')],
      ['assets/recovery.js', Buffer.from('export const recovery = 1;')],
      ['assets/recovery-adapter.js', Buffer.from('export const adapter = 1;')],
      ['assets/preload-helper.js', Buffer.from('export const preload = 1;')],
    ]);
    const kernel = [id('js/kernel/composition/host.js')];
    const chunks = [
      chunk({ fileName: 'assets/newtab.js', isEntry: true, imports: ['js/runtime/lazy.js', ...helperFile], dynamicImports: ['assets/workspace.js'], moduleIds: [id('js/entries/newtab.js')] }),
      chunk({ fileName: 'js/runtime/lazy.js', moduleIds: [id('js/runtime/lazy.js')] }),
      chunk({
        fileName: 'assets/workspace.js',
        isDynamicEntry: true,
        imports: ['assets/host.js', ...(newTabAdapter ? ['assets/adapter.js'] : [])],
        moduleIds: [id('js/workspace.js')],
      }),
      chunk({ fileName: 'assets/host.js', moduleIds: helperChunk ? kernel : [...kernel, HELPER] }),
      chunk({ fileName: 'assets/adapter.js', moduleIds: [id('js/kernel/adapters/indexeddb/adapter.js')] }),
      chunk({ fileName: 'assets/preload-helper.js', moduleIds: [HELPER] }),
      chunk({
        fileName: 'assets/popup.js',
        isEntry: true,
        imports: ['assets/host.js', ...(popupAdapter ? ['assets/adapter.js'] : []), ...helperFile],
        dynamicImports: ['assets/popup-send-chunk.js'],
        moduleIds: [id('js/popup.js'), ...(popupValibot ? [id('js/lib/valibot/index.mjs')] : [])],
      }),
      chunk({ fileName: 'assets/popup-send-chunk.js', isDynamicEntry: true, moduleIds: [id('js/kernel/composition/popup-send-chunk.js'), id('js/lib/valibot/index.mjs')] }),
      chunk({ fileName: 'assets/sidepanel.js', isEntry: true, imports: ['assets/host.js', ...(sidePanelAdapter ? ['assets/adapter.js'] : []), ...helperFile], moduleIds: [id('js/sidepanel.js')] }),
      chunk({ fileName: 'assets/recovery.js', isEntry: true, imports: recoveryAdapter ? ['assets/recovery-adapter.js'] : [], moduleIds: [id('js/recovery.js'), HELPER] }),
      chunk({ fileName: 'assets/recovery-adapter.js', name: 'adapter', moduleIds: [id('js/kernel/adapters/indexeddb/adapter.js')] }),
      chunk({ fileName: 'js/background.js', pass: 'background', isEntry: true, moduleIds: [id('js/background.js')] }),
    ];
    const loaderChunks = { workspace: 'assets/workspace.js', 'popup-send-chunk': 'assets/popup-send-chunk.js', newtab: 'assets/newtab.js', popup: 'assets/popup.js', sidepanel: 'assets/sidepanel.js', recovery: 'assets/recovery.js' };
    return { files: fromMap(files, 'the fixture'), chunks, loaderChunks };
  }
  /** The fixture's rows: Popup allows valibot lazy only, in its send chunk */
  const layoutBudgets = () => {
    const page = (/** @type {string} */ html, /** @type {object} */ rest = {}) => ({ page: html, reason: 'the page', start: { js: ROOMY, css: ROOMY, html: ROOMY, fonts: ROOMY }, modules: 1000, forbidden: [], dependencies: [], ...rest });
    return {
      package: PACKAGE_ROW,
      forbidden: {},
      entries: {
        newtab: page('newtab.html', { startChunks: ['workspace'] }),
        popup: page('popup.html', { lazyChunks: ['popup-send-chunk'], lazyDependencies: ['valibot'] }),
        sidepanel: page('sidepanel.html'),
        recovery: page('recovery.html'),
        background: budgetsFor().entries.background,
      },
    };
  };
  const layout = (/** @type {string} */ page, /** @type {string} */ message) => `budget/layout ${page}: ${message}`;

  it("passes the pages' layout: Vite's preload helper in host, no page's start on the adapter chunk, and valibot in Popup's send chunk (#35 slices 4b-2, 4c and 4d)", () => {
    assert.deepEqual(run(layoutBudgets(), layoutFixture()), []);
    // The chunk graph names the helper on each start that holds it
    const graphs = analyze({ ...layoutFixture(), budgets: layoutBudgets() });
    for (const page of ['newtab', 'popup', 'sidepanel', 'recovery']) assert.ok(graphs[page].start.modules.includes('vite/preload-helper.js'), `${page}'s start names the helper`);
    // P1 is the first page pass's: recovery's own pass keeps its own copy of the helper, in its
    // entry chunk, and passes
    assert.ok(layoutFixture().chunks.find(entry => entry.fileName === 'assets/recovery.js').moduleIds.includes(HELPER));
    assert.ok(!graphs.recovery.start.files.some(entry => entry.file === 'assets/host.js'));
    assert.deepEqual(graphs.popup.start.packages, []);
    assert.deepEqual(graphs.popup.lazy.packages, ['valibot']);
  });

  it("fails each first-pass page whose start loads Vite's preload helper from a chunk of its own, not from host, as the tip's did (#35 slice 4b-2, P1)", () => {
    assert.deepEqual(
      run(layoutBudgets(), layoutFixture({ helperChunk: true })),
      ['newtab', 'popup', 'sidepanel'].map(page => layout(page, "its start loads Vite's preload helper from assets/preload-helper.js, not from the host chunk every page's start shares")),
    );
  });

  /** P2's words, since no page's start loads the adapter chunk (#35 slice 4d) */
  const onAdapter = "its start loads the adapter chunk (assets/adapter.js), which no page's start loads, since each reads through #17's reader";

  it("fails Popup's start that loads the adapter chunk (#35 slice 4b-2, P2)", () => {
    assert.deepEqual(run(layoutBudgets(), layoutFixture({ popupAdapter: true })), [layout('popup', onAdapter)]);
  });

  it("fails Side Panel's start that loads the adapter chunk, as Popup's (#35 slice 4c, P2)", () => {
    assert.deepEqual(run(layoutBudgets(), layoutFixture({ sidePanelAdapter: true })), [layout('sidepanel', onAdapter)]);
  });

  it("fails the new tab's start that loads the adapter chunk, as Popup's and Side Panel's, since it reads through #17's reader too (#35 slice 4d, P2)", () => {
    assert.deepEqual(run(layoutBudgets(), layoutFixture({ newTabAdapter: true })), [layout('newtab', onAdapter)]);
  });

  it("fails valibot on Popup's start, which its row allows lazy only (#35 slice 4b-2, P3, Q8)", () => {
    assert.deepEqual(run(layoutBudgets(), layoutFixture({ popupValibot: true })), [
      'budget/dependency popup: its start holds valibot, which its row allows lazy only',
    ]);
  });

  it("fails recovery's start that loads a chunk the first page pass's groups name, so its own pass took them (#35 slice 4b-2, P5)", () => {
    assert.deepEqual(run(layoutBudgets(), layoutFixture({ recoveryAdapter: true })), [
      layout('recovery', "its start loads adapter (assets/recovery-adapter.js), a chunk only the first page pass's groups name, so recovery's own pass took them"),
    ]);
  });

  it("fails a package its row doesn't allow, and an allowed one its graph no longer holds", () => {
    const newtab = budgetsFor().entries.newtab;
    assert.deepEqual(run(budgetsFor({ newtab: { ...newtab, dependencies: ['chart.js', 'fuse.js', 'jszip', 'valibot', 'left-pad', '@xenova/transformers'] } })), [
      "budget/dependency newtab: its graph holds some-parser, which its row doesn't allow",
      'budget/dependency newtab: its row allows left-pad, which its graph no longer holds: take it out',
    ]);
  });

  it('holds the row to the chunk the root boots: a row between the root and the tab fails', () => {
    const newtab = budgetsFor().entries.newtab;
    const graphs = analyze({ ...bundleFixture(), budgets: budgetsFor() });
    const root = graphs.newtab.start.bytes.js.raw - [...graphs.newtab.start.files].filter(entry => entry.file === 'assets/workspace.js' || entry.file === 'assets/host.js').reduce((sum, entry) => sum + entry.raw, 0);
    const between = { ...newtab, start: { ...newtab.start, js: { raw: root + 1, gzip: 100 * KIB } } };
    assert.match(run(budgetsFor({ newtab: between })).join('\n'), /^budget\/bytes newtab: its start JS is \d+ bytes raw/);
    // Without the workspace named, or with an empty list, the row can't fall back to the root:
    // the root's import() of the workspace is named nowhere, and the build fails
    const unnamed = "budget/entry newtab: its page's start loads workspace (assets/workspace.js) with import(), and its row names it in neither startChunks nor lazyChunks: say whether it loads at start or later, or the row measures less than the page loads";
    assert.deepEqual(run(budgetsFor({ newtab: { ...between, startChunks: undefined } })), [unnamed]);
    assert.deepEqual(run(budgetsFor({ newtab: { ...between, startChunks: [] } })), [unnamed]);
  });

  it("fails a startChunks or lazyChunks name the build doesn't have, or one nothing on the page's start loads", () => {
    const newtab = budgetsFor().entries.newtab;
    assert.deepEqual(run(budgetsFor({ newtab: { ...newtab, startChunks: ['workspace', 'shell'] } })), [
      "budget/entry newtab: its row's startChunks names shell, and the build has no loader chunk by that name, so its graph would leave out what the page loads",
    ]);
    assert.deepEqual(run(budgetsFor({ newtab: { ...newtab, lazyChunks: ['later'] } })), [
      "budget/entry newtab: its row's lazyChunks names later, and the build has no loader chunk by that name, so its graph would leave out what the page loads",
    ]);
    const fixture = bundleFixture();
    fixture.chunks[0] = { ...fixture.chunks[0], dynamicImports: [] };
    assert.deepEqual(run(budgetsFor(), fixture), [
      "budget/entry newtab: its row's startChunks names workspace (assets/workspace.js), and nothing on the page's start loads it with import(): the row says the page loads a chunk it doesn't",
    ]);
  });

  it('takes a chunk the row names as lazy out of start, and still counts it in the graph', () => {
    const newtab = budgetsFor().entries.newtab;
    const budgets = budgetsFor({ newtab: { ...newtab, startChunks: [], lazyChunks: ['workspace'] } });
    const graph = analyze({ ...bundleFixture(), budgets }).newtab;
    assert.ok(graph.lazy.files.some(entry => entry.file === 'assets/workspace.js'));
    assert.ok(!graph.start.files.some(entry => entry.file === 'assets/workspace.js'));
    assert.deepEqual(run(budgets), []);
    // The build's line names only what loads at boot
    assert.deepEqual(startChunksOf(graph), []);
    assert.deepEqual(startChunksOf(analyze({ ...bundleFixture(), budgets: budgetsFor() }).newtab), ['workspace']);
  });

  it("fails a package in the service worker its row doesn't allow", () => {
    const fixture = bundleFixture();
    fixture.chunks = fixture.chunks.map(entry => (entry.pass === 'background' ? { ...entry, moduleIds: [...entry.moduleIds, id('node_modules/nanoid/index.js')] } : entry));
    assert.deepEqual(run(budgetsFor(), fixture), ["budget/dependency background: its graph holds nanoid, which its row doesn't allow"]);
    assert.deepEqual(run(budgetsFor({ background: { ...budgetsFor().entries.background, dependencies: ['nanoid'] } }), fixture), []);
  });

  it('fails a built entry with no row, and a row for an entry the build lacks', () => {
    const budgets = budgetsFor();
    delete budgets.entries.popup;
    budgets.entries.sidepanel = { page: 'sidepanel.html', reason: 'gone', start: {} };
    assert.deepEqual(run(budgets), [
      'budget/entry popup: the build has it, and build/budgets.json has no row for it',
      "budget/entry sidepanel: build/budgets.json has a row for it, and the build doesn't have it",
    ]);
  });

  it("switches the moment row's full list on once the build has a moment chunk", () => {
    const fixture = bundleFixture();
    fixture.chunks.push(chunk({ fileName: 'assets/moment.js', isDynamicEntry: true, moduleIds: [id('js/moment.js'), id('js/llm.js')] }));
    fixture.files = fromMap(new Map([...fixture.files.paths.map(file => [file, fixture.files.read(file)]), ['assets/moment.js', Buffer.from('moment')]]), 'the fixture');
    // Not built yet: the planned row is quiet
    assert.deepEqual(run(budgetsFor(), bundleFixture()), []);
    const built = { ...fixture, loaderChunks: { ...fixture.loaderChunks, moment: 'assets/moment.js' } };
    // Built while planned: its numbers have to be set first
    assert.deepEqual(run(budgetsFor(), built), [
      'budget/entry moment: the build has it, and its row is still planned: set its numbers, and planned to false, by review',
    ]);
    // Set, and the full list holds: remote AI on Moment's start fails
    const moment = { ...budgetsFor().entries.moment, planned: false };
    assert.deepEqual(run(budgetsFor({ moment }), built), ['budget/forbidden moment: its start path holds remote-ai (remote AI clients): js/llm.js']);
  });

  it('refuses a budget file it can\'t read as one', () => {
    assert.deepEqual(fileProblems({}).map(({ message }) => message), ['has no entries']);
    const bad = budgetsFor({ popup: { page: 'popup.html', reason: '', start: { js: { raw: 1.5, gzip: 2 }, jss: { raw: 1, gzip: 1 } }, forbidden: ['nothing'], startChunks: 'workspace', lazyDependencies: 'valibot' } });
    bad.forbidden.trust = { about: 'the trust code', paths: 'js/trust/**' };
    assert.deepEqual(fileProblems(bad).map(({ message }) => message), [
      "forbidden category trust's paths isn't a list of paths",
      "entry popup's startChunks isn't a list of names",
      "entry popup's lazyDependencies isn't a list of names",
      'entry popup has no reason',
      "entry popup forbids nothing, which isn't a category",
      "entry popup's js row isn't whole numbers of bytes, raw and gzip",
      "entry popup's start has a jss row, which isn't one of html, js, css, fonts",
    ]);
    // A package allowed lazy only is allowed nowhere else
    const popup = budgetsFor().entries.popup;
    assert.deepEqual(fileProblems(budgetsFor({ popup: { ...popup, dependencies: ['valibot'], lazyDependencies: ['valibot'] } })).map(({ message }) => message), [
      'entry popup allows valibot both anywhere and lazy only',
    ]);
  });
});

describe("the build's line for each entry's start (scripts/build/main.js, #27)", () => {
  const { startLine } = require('../scripts/build/main.js');

  it('prints its start JS in KB as before, then the exact raw / gzip bytes of its JS, CSS and HTML', () => {
    const entry = /** @type {any} */ ({
      kind: 'page',
      at: 'newtab.html',
      start: {
        files: [],
        bytes: { js: { raw: 715048, gzip: 204145, files: 11 }, css: { raw: 106049, gzip: 17206, files: 1 }, html: { raw: 69805, gzip: 11147, files: 1 } },
        modules: ['js/main.js', 'js/app.js'],
        packages: [],
      },
      boots: [{ as: 'start', chunk: 'workspace', file: 'assets/workspace-a1.js' }],
    });
    assert.equal(
      startLine('newtab', entry),
      '  ✓ newtab: start JS 698.3 KB (199.4 KB gzip), 2 modules, with workspace loaded at boot. Start bytes, raw / gzip: JS 715048 / 204145, CSS 106049 / 17206, HTML 69805 / 11147',
    );
  });

  it('says none for a type its start has none of, and names no boot chunk when it loads none', () => {
    const entry = /** @type {any} */ ({
      kind: 'page',
      at: 'js/background.js',
      start: { files: [], bytes: { js: { raw: 256451, gzip: 78637, files: 1 } }, modules: ['js/background.js'], packages: [] },
      boots: [],
    });
    assert.equal(startLine('background', entry), '  ✓ background: start JS 250.4 KB (76.8 KB gzip), 1 module. Start bytes, raw / gzip: JS 256451 / 78637, CSS none, HTML none');
  });
});

describe("build/budgets.json, with the owner's numbers (2026-10-31)", () => {
  it('reads as a budget file', () => {
    assert.deepEqual(readBudgets(ROOT).problems, []);
  });

  it("names the issue each row it leaves null waits on: Moment's #2, the service worker's cold start #35, and update size #31, and every other module and zip row is a number (#300)", () => {
    const { entries } = BUDGETS;
    assert.deepEqual(entries.moment.waitsOn, { js: '#2', css: '#2', html: '#2', fonts: '#2', modules: '#2' });
    assert.deepEqual([entries.background.coldStart, entries.background.waitsOn], [null, { coldStart: '#35' }]);
    assert.deepEqual([BUDGETS.package.updateBytes, BUDGETS.package.waitsOn], [null, { updateBytes: '#31' }]);
    for (const [name, entry] of Object.entries(entries)) {
      if (name === 'moment') continue;
      assert.ok(Number.isSafeInteger(entry.modules), `${name}'s modules row`);
      if (name !== 'background') assert.equal(entry.waitsOn, undefined, `${name} waits on nothing`);
    }
    assert.ok(Number.isSafeInteger(BUDGETS.package.zipBytes), "the zip's row");
  });

  it('holds the approved rows exactly', () => {
    const { entries } = BUDGETS;
    // The new tab's start JS: its start on #35 slice 4d with #284, #281, #287, #293 and #292 in, as build
    // job 130354793998 of PR checks run 42969623665 read it on next at f9d63f4f, which #292 doesn't change,
    // 668,515 / 188,933, and its gzip row 188,944: the build id spreads this row over 11 bytes (lazy.js
    // 1,504 to 1,515 gzip, measured over 500 build ids), since js/runtime/lazy.js:385 holds the id, which
    // scripts/build/build-info.js:116 makes the SHA-256 of the commit's tree, package-lock.json, the
    // toolchain's versions and the mode (2026-11-10). Its start CSS: its start with #281, #292 and #296 in
    // as build job 130742183157 of PR checks run 43083605333 read it, 109,349 / 17,940, with no headroom
    // (2026-11-10)
    assert.deepEqual(entries.newtab.start, { js: { raw: 668515, gzip: 188944 }, css: { raw: 109349, gzip: 17940 }, html: { raw: 72 * KIB, gzip: 12 * KIB }, fonts: null });
    // The workspace loads at boot, so it's start; nothing the root loads is named lazy
    assert.deepEqual(entries.newtab.startChunks, ['workspace']);
    assert.equal(entries.newtab.lazyChunks, undefined);
    assert.deepEqual(entries.background.dependencies, ['valibot']);
    // Popup's and Side Panel's start JS rows are their starts with no headroom, since neither start loads
    // js/runtime/lazy.js. Popup's is its start on #35 slice 4d as build job 128853943289 of PR checks run
    // 42520909498 read it (2026-11-08). Side Panel's is its start on #300 slice 5b as build job 131711018907
    // of push run 43372411837 read it at 1fcbef1a (2026-11-12)
    assert.deepEqual(entries.popup.start.js, { raw: 76913, gzip: 26638 });
    assert.deepEqual(entries.sidepanel.start.js, { raw: 73534, gzip: 25553 });
    // Each entry's start modules, Popup's and Side Panel's start CSS and HTML, and the service worker's
    // start JS: next's push run 43397463553 at 088ff88d, plus 5% rounded up to the module or the byte. Moment's
    // module row waits for #2 (#300 slice 6a, 2026-11-13)
    assert.deepEqual(Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.modules])), { newtab: 158, popup: 63, sidepanel: 62, offscreen: 12, recovery: 161, background: 210, moment: null });
    assert.deepEqual([entries.popup.start.css, entries.popup.start.html], [{ raw: 7213, gzip: 2016 }, { raw: 2967, gzip: 1116 }]);
    assert.deepEqual([entries.sidepanel.start.css, entries.sidepanel.start.html], [{ raw: 3503, gzip: 1272 }, { raw: 1536, gzip: 702 }]);
    assert.deepEqual(entries.background.start.js, { raw: 338354, gzip: 103464 });
    // The zip: 834,251 bytes in build job 131822570080 of PR checks run 43406673412, plus 5% rounded up,
    // #300 slice 6a's first CI round's figure: the shipped files are next's except the inlined build ID
    assert.equal(BUDGETS.package.zipBytes, 875964);
    assert.equal(BUDGETS.timing.tolerancePct, 7);
    // Timing takes 12 rounds of each profile, and both rows gate both profiles
    assert.equal(BUDGETS.timing.rounds, 12);
    assert.deepEqual([BUDGETS.timing.profiles, BUDGETS.heap.profiles], [['typical', 'maximal'], ['typical', 'maximal']]);
    // Heap is 3.12 MiB, the median of CI's three readings of next's code at 0caa9c3e with #157's probe,
    // plus about 5% (2026-11-02), failing above 3.378 with its 3%
    assert.deepEqual([BUDGETS.heap.limitMiB, BUDGETS.heap.tolerancePct], [3.28, 3]);
    // Timing gates the perf job since 14 valid CI runs, and heap since its row was set from CI's
    assert.deepEqual([BUDGETS.timing.mode, BUDGETS.heap.mode], ['gate', 'gate']);
    // Offscreen: its JS row is the 27,957 / 8,763 bytes that build job 131711018907 of push run 43372411837
    // measured at 1fcbef1a, after #300 slice 5a, plus 5%, rounded up (2026-11-12). Its HTML stays at the
    // smallest round row over 230 / 174 bytes on 7489d7b3
    assert.deepEqual(entries.offscreen.start, { js: { raw: 29355, gzip: 9202 }, css: null, html: { raw: 1 * KIB, gzip: 1 * KIB }, fonts: null });
    assert.equal(BUDGETS.reference.packageDigest, '50d8ddc57945dc129ddabda2304f45b9354db79eff608017da49d5b845ab554d');
  });

  it("gates the four libraries and the trust code on today's new tab, and the full list on the Popup, the Side Panel, and Moment", () => {
    const { entries, forbidden } = BUDGETS;
    assert.deepEqual(entries.newtab.forbidden, ['chart-library', 'search-library', 'zip-library', 'model-runtime', 'trust']);
    const full = Object.keys(forbidden);
    for (const name of ['popup', 'sidepanel', 'moment']) assert.deepEqual([...entries[name].forbidden].sort(), [...full].sort(), name);
    assert.equal(entries.moment.planned, true);
    assert.equal(entries.moment.chunk, 'moment');
  });

  it("holds recovery.html's row: today's size plus about 5% (2026-11-01), and its lists as the build reported them (#20 slice 4b)", () => {
    const { recovery } = BUDGETS.entries;
    assert.equal(recovery.page, 'recovery.html');
    assert.equal(recovery.planned, undefined);
    // Its start CSS gzip row is 4.75 KiB, about 5% over the 4,639 bytes that build job 130333246078 of PR
    // checks run 42962855381 measured with #292 in (2026-11-10). Its raw row stays 22.5 KiB, which that
    // start isn't over. Its start JS row is the 342,887 / 108,093 bytes that build job 131711018907 of
    // push run 43372411837 measured at 1fcbef1a, after #300 slice 5b, plus 5%, rounded up (2026-11-12)
    assert.deepEqual(recovery.start, { js: { raw: 360032, gzip: 113498 }, css: { raw: 22.5 * KIB, gzip: 4.75 * KIB }, html: { raw: 2 * KIB, gzip: 1 * KIB }, fonts: null });
    // The trust code is the page's own; every other category stays off its start
    assert.deepEqual(recovery.forbidden, [
      'chart-library',
      'search-library',
      'zip-library',
      'model-runtime',
      'charting-analytics',
      'graph-view',
      'search-indexing',
      'import-export',
      'archive-trash',
      'settings',
      'sync',
      'remote-ai',
      'recipes',
      'embeddings',
      'ai-policy',
      'onboarding-walkthrough',
      'workspace',
    ]);
    assert.deepEqual(recovery.dependencies, ['valibot']);
    // The providers' checks load after the page opens, from the catalog's import()s, and the fallback a
    // repair commits on while the coordinator can't run it, from its root's (#35 slice 8)
    assert.equal(recovery.startChunks, undefined);
    assert.deepEqual(recovery.lazyChunks, ['index-lag', 'legacy', 'permissions', 'platform', 'probe', 'recovery-fallback', 'recovery-readiness']);
  });
});

describe("CI's perf summary (scripts/perf/gate-report.js)", () => {
  // The shipped rows with both set to report, for the cases that read a summary without failing
  const REPORTING = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'report' }, heap: { ...BUDGETS.heap, mode: 'report' } };
  const ratio = (median, extra = {}) => ({ median, q1: median - 0.01, q3: median + 0.01, values: Array(12).fill(median), ...extra });
  // The candidate's ratio to the first 1.4.0 copy alone is set apart from its ratio to both, so
  // a summary that read the first would show. Both profiles the rows gate get the same numbers.
  // `paired` is how many rounds have a run of every package: a package that recorded fewer, on
  // either side, leaves its other rounds unpaired
  const probe = (self, both, heapMiB, { first = both + 0.2, failures = [], problems = [], rounds = 12, paired = rounds } = {}) => ({
    environment: { cpu: 'test', cores: 4, platform: 'linux' },
    timing: {
      browser: '156',
      runs: rounds,
      profiles: Object.fromEntries(
        ['typical', 'maximal'].map(name => [
          name,
          {
            packages: {
              '1.4.0': { interactionReadyMs: ratio(900), heapBytes: ratio(4 * 1048576), failures: [] },
              '1.4.0-again': { interactionReadyMs: ratio(905), heapBytes: ratio(4 * 1048576), failures: [] },
              candidate: { interactionReadyMs: ratio(950), heapBytes: ratio(heapMiB * 1048576), failures },
            },
            ratios: {
              '1.4.0-again': { self: true, interactionReady: ratio(self, { values: Array(paired).fill(self) }) },
              candidate: { interactionReady: ratio(first, { values: Array(paired).fill(first) }), againstBoth: { interactionReady: ratio(both, { values: Array(paired).fill(both) }) } },
            },
          },
        ]),
      ),
    },
    problems,
  });
  const each = verdict => ['typical', 'maximal'].map(profile => ({ profile, ...verdict }));

  it('says valid, pass or fail for timing and heap, and fails nothing while the rows report', () => {
    // Against the first copy alone the candidate is +25%: the summary reads both
    const passing = gateReport(probe(1.01, 1.05, 2.7, { first: 1.25 }), REPORTING);
    assert.deepEqual(passing.verdicts, each({ valid: true, timing: 'pass', heap: 'pass', problems: [] }));
    assert.equal(passing.failed, false);
    assert.match(passing.markdown, /\| typical \| 12 \| \+1\.0% .* \| yes \| \+5\.0% .* \| pass \| 2\.70 MiB \| pass \|/);
    // Against the first copy alone it's +1%: the summary reads both
    const failing = gateReport(probe(1.01, 1.09, 3.5, { first: 1.01 }), REPORTING);
    assert.deepEqual(failing.verdicts, each({ valid: true, timing: 'fail', heap: 'fail', problems: [] }));
    assert.equal(failing.failed, false, 'report-only rows fail nothing');
    assert.deepEqual(gateReport(probe(1.09, 1.0, 2.7), REPORTING).verdicts[0], { profile: 'typical', valid: false, timing: 'invalid', heap: 'pass', problems: [] });
  });

  it('calls a profile invalid when a round failed, the probe reported a problem, or rounds fall short', () => {
    const gated = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'gate' }, heap: { ...BUDGETS.heap, mode: 'gate' } };
    const cases = [
      [{ failures: [{ round: 3, message: 'the page never marked ready' }] }, 'candidate round 3 failed: the page never marked ready'],
      [{ problems: ["the typical fixture isn't the one build/budgets.json measured (aaaa, not bbbb), so its numbers don't compare"] }, "the probe: the typical fixture isn't the one build/budgets.json measured (aaaa, not bbbb), so its numbers don't compare"],
      [{ rounds: 9 }, '9 rounds, fewer than the 12 build/budgets.json takes'],
      // 12 asked, and a package, on either side, recorded 11 with no failure listed. The row's 12
      // already caught this one
      [{ paired: 11 }, '11 rounds, fewer than the 12 build/budgets.json takes'],
      // Past the 12 the row takes, every round asked still counts
      [{ rounds: 15, paired: 14 }, 'only 14 of the 15 rounds asked have a run of every package'],
    ];
    for (const [options, reason] of cases) {
      const reported = gateReport(probe(1.01, 1.05, 2.7, options), REPORTING);
      assert.deepEqual(reported.verdicts[0], { profile: 'typical', valid: false, timing: 'invalid', heap: 'invalid', problems: [reason] }, reason);
      assert.equal(reported.failed, false, 'report mode fails nothing');
      assert.ok(reported.markdown.includes(`- typical: ${reason}`), reason);
      assert.equal(gateReport(probe(1.01, 1.05, 2.7, options), gated).failed, true, reason);
    }
  });

  it('calls a profile the rows take invalid when the run has no rounds of it, so a run that measured nothing fails a gate', () => {
    const missing = { profile: 'maximal', valid: false, timing: 'invalid', heap: 'invalid', problems: ['the run has no rounds of this profile, which build/budgets.json takes'] };
    // The run measured typical alone
    const typicalOnly = probe(1.01, 1.05, 2.7);
    delete typicalOnly.timing.profiles.maximal;
    const reported = gateReport(typicalOnly, REPORTING);
    assert.deepEqual(reported.verdicts, [{ profile: 'typical', valid: true, timing: 'pass', heap: 'pass', problems: [] }, missing]);
    assert.equal(reported.failed, false, 'report mode fails nothing');
    assert.match(reported.markdown, /\| maximal \| 0 \| n\/a \| \*\*no\*\* \| n\/a \| invalid \| n\/a \| invalid \|/);
    assert.ok(reported.markdown.includes('- maximal: the run has no rounds of this profile, which build/budgets.json takes'));
    assert.equal(gateReport(typicalOnly, BUDGETS).failed, true);
    // A run with no profiles, and one with no timing at all: both profiles are invalid
    const noProfiles = probe(1.01, 1.05, 2.7);
    noProfiles.timing.profiles = {};
    for (const nothing of [noProfiles, { ...probe(1.01, 1.05, 2.7), timing: null }]) {
      const report = gateReport(nothing, BUDGETS);
      assert.deepEqual(report.verdicts, [{ ...missing, profile: 'typical' }, missing]);
      assert.equal(report.failed, true);
    }
  });

  it('fails each row only on the profiles it takes', () => {
    // Heap takes typical alone, and timing reports: maximal's heap can't fail the job, nor can its absence
    const heapTypical = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'report' }, heap: { ...BUDGETS.heap, profiles: ['typical'] } };
    const heavyMaximal = probe(1.01, 1.05, 2.7);
    heavyMaximal.timing.profiles.maximal.packages.candidate.heapBytes = ratio(3.5 * 1048576);
    const heavy = gateReport(heavyMaximal, heapTypical);
    assert.deepEqual(heavy.verdicts.map(verdict => [verdict.profile, verdict.heap]), [['typical', 'pass'], ['maximal', 'fail']]);
    assert.equal(heavy.failed, false);
    const typicalOnly = probe(1.01, 1.05, 2.7);
    delete typicalOnly.timing.profiles.maximal;
    assert.equal(gateReport(typicalOnly, heapTypical).failed, false);
    // Timing takes both, so as a gate it fails on the missing profile
    assert.equal(gateReport(typicalOnly, { ...heapTypical, timing: BUDGETS.timing }).failed, true);
    // Heap still fails on the profile it takes
    const heavyTypical = probe(1.01, 1.05, 2.7);
    heavyTypical.timing.profiles.typical.packages.candidate.heapBytes = ratio(3.5 * 1048576);
    assert.equal(gateReport(heavyTypical, heapTypical).failed, true);
    // Timing takes typical alone, and heap reports: maximal's timing can't fail the job, typical's can
    const timingTypical = { ...BUDGETS, timing: { ...BUDGETS.timing, profiles: ['typical'] }, heap: { ...BUDGETS.heap, mode: 'report' } };
    const slowMaximal = probe(1.01, 1.05, 2.7);
    slowMaximal.timing.profiles.maximal.ratios.candidate.againstBoth.interactionReady = ratio(1.09);
    const slow = gateReport(slowMaximal, timingTypical);
    assert.deepEqual(slow.verdicts.map(verdict => [verdict.profile, verdict.timing]), [['typical', 'pass'], ['maximal', 'fail']]);
    assert.equal(slow.failed, false);
    const slowTypical = probe(1.01, 1.05, 2.7);
    slowTypical.timing.profiles.typical.ratios.candidate.againstBoth.interactionReady = ratio(1.09);
    assert.equal(gateReport(slowTypical, timingTypical).failed, true);
  });

  it('fails the job when a gate row names no profile, however little the run measured', () => {
    const nothing = { ...probe(1.01, 1.05, 2.7), timing: null };
    for (const profiles of [[], undefined]) {
      const unnamed = { ...BUDGETS, timing: { ...BUDGETS.timing, profiles }, heap: { ...BUDGETS.heap, profiles } };
      const report = gateReport(nothing, unnamed);
      assert.deepEqual(report.verdicts, []);
      assert.equal(report.failed, true, String(profiles));
      assert.ok(report.markdown.includes("- build/budgets.json's timing row names no profile"));
      assert.ok(report.markdown.includes("- build/budgets.json's heap row names no profile"));
    }
    // Either row alone, on a run whose numbers pass: the unnamed row fails it
    for (const label of ['timing', 'heap']) {
      const report = gateReport(probe(1.01, 1.05, 2.7), { ...BUDGETS, [label]: { ...BUDGETS[label], profiles: [] } });
      assert.equal(report.failed, true, label);
      assert.ok(report.markdown.includes(`- build/budgets.json's ${label} row names no profile`), label);
    }
    // A report row that names none fails nothing
    const reportOnly = { ...REPORTING, timing: { ...REPORTING.timing, profiles: [] }, heap: { ...REPORTING.heap, profiles: [] } };
    assert.equal(gateReport(nothing, reportOnly).failed, false);
  });

  it("calls a profile invalid when build/budgets.json's timing row doesn't say how many rounds it takes", () => {
    const unset = { ...BUDGETS, timing: { ...BUDGETS.timing, rounds: undefined } };
    const one = gateReport(probe(1.01, 1.05, 2.7, { rounds: 1 }), unset);
    assert.deepEqual(one.verdicts, each({ valid: false, timing: 'invalid', heap: 'invalid', problems: ["build/budgets.json's timing row doesn't say how many rounds it takes"] }));
    assert.equal(one.failed, true);
  });

  it("fails the job on build/budgets.json's own rows: timing over its 7%, and heap over 3.28 MiB plus 3%", () => {
    // Timing is a gate as shipped: a candidate 9% slower than both 1.4.0 runs fails the job
    const slow = gateReport(probe(1.01, 1.09, 2.7), BUDGETS);
    assert.equal(slow.verdicts[0].timing, 'fail');
    assert.equal(slow.failed, true);
    // An invalid run fails it too: a gate can't pass on a run it can't read
    assert.equal(gateReport(probe(1.09, 1.0, 2.7), BUDGETS).failed, true);
    // Heap is a gate too: over 3.378 MiB, it fails the job with timing passing
    const heavy = gateReport(probe(1.01, 1.05, 3.5), BUDGETS);
    assert.deepEqual([heavy.verdicts[0].timing, heavy.verdicts[0].heap, heavy.failed], ['pass', 'fail', true]);
    // At the edge: 3.37 MiB passes, 3.38 fails
    assert.equal(gateReport(probe(1.01, 1.05, 3.37), BUDGETS).failed, false);
    assert.equal(gateReport(probe(1.01, 1.05, 3.38), BUDGETS).failed, true);
    // The three readings of next the row was set from, 3.12, 3.12 and 3.12 with #157's probe, pass
    for (const heapMiB of [3.12, 3.12, 3.12]) assert.equal(gateReport(probe(1.01, 1.05, heapMiB), BUDGETS).verdicts[0].heap, 'pass', heapMiB);
    // Within both rows, nothing fails
    assert.equal(gateReport(probe(1.01, 1.05, 2.7), BUDGETS).failed, false);
    // The same slow, heavy candidate with both rows back on report passes the job
    assert.equal(gateReport(probe(1.01, 1.09, 3.5), REPORTING).failed, false);
  });

  it('holds each count to its row on each profile the timing row takes: a null row reports, and a number fails a count over it, or a run with no count (#300)', () => {
    const counted = (/** @type {any} */ max) => ({
      ...probe(1.01, 1.05, 2.7),
      counts: { runs: 2, profiles: Object.fromEntries(['typical', 'maximal'].map(name => [name, { packages: { candidate: { runs: [], max, failures: [] } } }])) },
    });
    const rows = (/** @type {number | null} */ reads, /** @type {number | null} */ requests) => ({
      ...REPORTING,
      entries: { newtab: { ...BUDGETS.entries.newtab, reads, requests }, popup: { ...BUDGETS.entries.popup, requests } },
    });
    const max = { newtab: { reads: 40, requests: 0 }, popup: { requests: 1 } };
    const verdicts = (/** @type {any} */ report) => report.countVerdicts.map((/** @type {any} */ v) => `${v.profile} ${v.entry} ${v.row} ${v.count} ${v.limit} ${v.verdict}`);
    // Null rows report what the run counted, and fail nothing
    const reported = gateReport(counted(max), rows(null, null));
    assert.deepEqual(verdicts(reported), ['typical newtab reads 40 null report', 'typical newtab requests 0 null report', 'typical popup requests 1 null report', 'maximal newtab reads 40 null report', 'maximal newtab requests 0 null report', 'maximal popup requests 1 null report']);
    assert.equal(reported.failed, false);
    assert.match(reported.markdown, /\| typical \| newtab \| IndexedDB reads before its mark \| 40 \| none yet \| report \|/);
    // Set, a count at its row passes and one over it fails, however timing and heap report
    const gated = gateReport(counted(max), rows(40, 0));
    assert.deepEqual(verdicts(gated).slice(0, 3), ['typical newtab reads 40 40 pass', 'typical newtab requests 0 0 pass', 'typical popup requests 1 0 fail']);
    assert.equal(gated.failed, true);
    assert.equal(gateReport(counted({ newtab: { reads: 40, requests: 0 }, popup: { requests: 0 } }), rows(40, 0)).failed, false);
    // A set row the run has no count for fails, so a run that counted nothing can't pass
    const none = gateReport({ ...probe(1.01, 1.05, 2.7) }, rows(40, 0));
    assert.deepEqual(verdicts(none).slice(0, 2), ['typical newtab reads undefined 40 invalid', 'typical newtab requests undefined 0 invalid']);
    assert.equal(none.failed, true);
  });

  it('fails once a row is a gate', () => {
    const gated = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'gate' } };
    assert.equal(gateReport(probe(1.01, 1.09, 2.7), gated).failed, true);
    assert.equal(gateReport(probe(1.09, 1.0, 2.7), gated).failed, true, 'an invalid run fails a gate');
    assert.equal(gateReport(probe(1.01, 1.05, 2.7), gated).failed, false);
  });

  it('writes a profile with a package that measured nothing as invalid, instead of throwing', () => {
    const gated = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'gate' }, heap: { ...BUDGETS.heap, mode: 'gate' } };
    // Every candidate round failed: the probe writes null for what it couldn't summarize
    const failures = Array.from({ length: 12 }, (_, index) => ({ round: index + 1, message: 'the page never marked ready' }));
    const empty = probe(1.01, 1.05, 2.7, { failures });
    const typical = empty.timing.profiles.typical;
    typical.packages.candidate = { ...typical.packages.candidate, interactionReadyMs: null, heapBytes: null };
    typical.ratios.candidate = { rounds: 0, interactionReady: null, heap: null, againstBoth: { rounds: 0, interactionReady: null, heap: null } };
    const reported = gateReport(empty, REPORTING);
    assert.equal(reported.failed, false, 'report mode still summarizes');
    assert.equal(reported.verdicts[0].timing, 'invalid');
    assert.equal(reported.verdicts[0].heap, 'invalid');
    assert.ok(reported.verdicts[0].problems.includes('candidate measured no round'), reported.verdicts[0].problems.join('; '));
    assert.ok(reported.verdicts[0].problems.includes('the candidate has no round paired with both 1.4.0 runs'));
    assert.match(reported.markdown, /\| typical \| 0 \| .* \| \*\*no\*\* \| n\/a \| invalid \| n\/a \| invalid \|/);
    assert.equal(gateReport(empty, gated).failed, true, 'gate mode still fails');
    // 1.4.0 measured nothing either, and a run with no pair at all
    const none = probe(1.01, 1.05, 2.7);
    none.timing.profiles.typical.ratios = {};
    const unpaired = gateReport(none, REPORTING);
    assert.equal(unpaired.failed, false);
    assert.deepEqual(unpaired.verdicts[0], { profile: 'typical', valid: false, timing: 'invalid', heap: 'invalid', problems: ['the run has no 1.4.0 pair and candidate'] });
    assert.equal(gateReport(none, gated).failed, true);
  });

  it("writes the summary when the probe exits 1, and stays out of pr-gate's needs and the rulesets, so a gate row blocks no merge", () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/perf.yml'), 'utf8');
    const step = name => workflow.slice(workflow.indexOf(`- name: ${name}`), workflow.indexOf('- name:', workflow.indexOf(`- name: ${name}`) + 1));
    // The runner's shell has -e: the probe's exit is caught with ||, not read after the command
    assert.match(step('Time 1.4.0'), /--out dist-report\/perf\.json \|\| code=\$\?/);
    assert.match(step('Time 1.4.0'), /if \[ "\$code" -ge 2 \]; then exit "\$code"; fi/);
    assert.match(step('Summarize'), /if: always\(\)/);
    // Every step runs as bash -e -o pipefail because of the workflow's default shell, so tee can't
    // hide a gate row's exit 1; the step's own set -o pipefail matters only if that default changes
    assert.match(workflow, /\ndefaults:\n {2}run:\n {4}shell: bash\n/);
    assert.ok(!/\n {4}defaults:|\n {8}shell:/.test(workflow), 'no job or step overrides the shell');
    assert.match(step('Summarize'), /node scripts\/perf\/gate-report\.js .* \| tee -a "\$GITHUB_STEP_SUMMARY"/);
    const gate = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-checks.yml'), 'utf8');
    assert.match(gate, /needs: \[unit, typecheck, kernel, build, fixtures-1, fixtures-2, extension\]/, "timing blocks a merge only once pr-gate needs it, or a ruleset requires it: the owner's call");
    assert.ok(!/uses: \.\/\.github\/workflows\/perf\.yml|workflow_run/.test(gate), "pr-gate doesn't call or wait on the perf workflow");
    // Every ruleset that requires a check requires pr-gate alone, not perf
    for (const name of fs.readdirSync(path.join(ROOT, '.github/rulesets'))) {
      const ruleset = JSON.parse(fs.readFileSync(path.join(ROOT, '.github/rulesets', name), 'utf8'));
      const contexts = (ruleset.rules || []).filter(rule => rule.type === 'required_status_checks').flatMap(rule => rule.parameters.required_status_checks.map(check => check.context));
      assert.ok(contexts.every(context => context === 'pr-gate'), `${name} requires ${contexts.join(', ')}`);
    }
  });

  it("has CI's probe step ask for at least the rounds the timing row takes, and every profile either row takes", () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/perf.yml'), 'utf8');
    const start = workflow.indexOf('- name: Time 1.4.0');
    const step = workflow.slice(start, workflow.indexOf('- name:', start + 1));
    const command = step.slice(step.indexOf('npm run perf:probe'));
    const runs = /--runs (\d+)/.exec(command);
    const profiles = /--profiles (\S+)/.exec(command);
    assert.ok(runs && Number(runs[1]) >= BUDGETS.timing.rounds, 'the probe step asks for the rounds');
    assert.ok(profiles, 'the probe step names its profiles');
    for (const name of [...BUDGETS.timing.profiles, ...BUDGETS.heap.profiles]) assert.ok(profiles[1].split(',').includes(name), name);
  });

  it('lets npm run perf:probe --baseline read build/budgets.json', () => {
    const timing = { profiles: { typical: { fixtureDigest: BUDGETS.fixtureDigests.typical, ratios: { again: { self: true, interactionReady: { median: 1.08 } } } } } };
    assert.deepEqual(fixtureProblems(timing, path.join(ROOT, 'build/budgets.json')), [
      'invalid run on typical: the reference against itself (again) is 8.0% off, more than the 7% tolerance',
    ]);
  });
});
