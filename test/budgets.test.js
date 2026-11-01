// #27 slice 4b: the analyzer and the budget gate (scripts/build/budgets.js) on a bundle the test
// writes, build/budgets.json with the owner's numbers, and the timing and heap summary CI's perf
// job writes (scripts/perf/gate-report.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyze, checkBudgets, readBudgets, fileProblems, matches, packageOf, startChunksOf } = require('../scripts/build/budgets.js');
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

/** A small built package: a page that boots a loader chunk, and a popup */
function bundleFixture({ extraStart = [], popupBytes = 10 } = {}) {
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
  const chunks = [
    chunk({ fileName: 'assets/newtab.js', isEntry: true, imports: ['js/runtime/lazy.js'], dynamicImports: ['assets/workspace.js'], moduleIds: [id('js/entries/newtab.js')] }),
    chunk({ fileName: 'js/runtime/lazy.js', moduleIds: [id('js/runtime/lazy.js')] }),
    chunk({ fileName: 'assets/workspace.js', isDynamicEntry: true, imports: ['assets/host.js'], dynamicImports: ['assets/trust.js'], importedCss: ['assets/workspace.css'], moduleIds: [id('js/workspace.js'), id('js/llm.js'), ...extraStart.map(id)] }),
    chunk({ fileName: 'assets/host.js', moduleIds: [id('js/kernel/composition/host.js'), id('js/lib/valibot/index.mjs')] }),
    chunk({ fileName: 'assets/trust.js', isDynamicEntry: true, moduleIds: [id('js/trust/core/journal.js')] }),
    chunk({ fileName: 'assets/indexer.js', pass: 'worker', isEntry: true, moduleIds: [id('js/workers/indexer.js'), id('node_modules/some-parser/index.js')] }),
    chunk({ fileName: 'assets/popup.js', isEntry: true, moduleIds: [id('js/popup.js'), id('js/lib/valibot/index.mjs')] }),
    chunk({ fileName: 'js/background.js', pass: 'background', isEntry: true, moduleIds: [id('js/background.js')] }),
  ];
  return { files: fromMap(files, 'the fixture'), chunks, loaderChunks: { workspace: 'assets/workspace.js', trust: 'assets/trust.js', newtab: 'assets/newtab.js', popup: 'assets/popup.js' } };
}

/** A budget file for the fixture, `entries` merged over the default rows */
function budgetsFor(entries = {}) {
  return {
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
        start: { js: { raw: 100 * KIB, gzip: 100 * KIB }, css: null, html: null, fonts: null },
        forbidden: ['chart-library', 'trust', 'model-runtime'],
        dependencies: ['@xenova/transformers', 'chart.js', 'fuse.js', 'jszip', 'some-parser', 'valibot'],
      },
      popup: { page: 'popup.html', reason: 'the popup', start: { js: { raw: 1000, gzip: 1000 } }, forbidden: ['remote-ai', 'trust'], dependencies: ['valibot'] },
      background: { reason: 'the worker', start: {} },
      moment: { chunk: 'moment', planned: true, reason: 'not built yet', start: {}, forbidden: ['remote-ai', 'trust', 'chart-library'], dependencies: [] },
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
    const gzipOnly = run(budgetsFor({ popup: { ...budgetsFor().entries.popup, start: { js: { raw: 1e6, gzip: 1 } } } }));
    assert.match(gzipOnly.join('\n'), /^budget\/bytes popup: its start JS is \d+ bytes gzip/);
  });

  it('fails a forbidden module on the start path, not in a lazy chunk', () => {
    assert.deepEqual(run(budgetsFor(), bundleFixture({ extraStart: ['js/lib/chart.js'] })), [
      'budget/forbidden newtab: its start path holds chart-library (Chart.js): js/lib/chart.js',
    ]);
    // The trust code is in the fixture's lazy trust chunk, and passes
    assert.ok(!run(budgetsFor()).some(line => line.includes('trust')));
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
    assert.deepEqual(run(budgetsFor({ background: { reason: 'the worker', start: {}, dependencies: ['nanoid'] } }), fixture), []);
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
    const bad = budgetsFor({ popup: { page: 'popup.html', reason: '', start: { js: { raw: 1.5, gzip: 2 }, jss: { raw: 1, gzip: 1 } }, forbidden: ['nothing'], startChunks: 'workspace' } });
    bad.forbidden.trust = { about: 'the trust code', paths: 'js/trust/**' };
    assert.deepEqual(fileProblems(bad).map(({ message }) => message), [
      "forbidden category trust's paths isn't a list of paths",
      "entry popup's startChunks isn't a list of names",
      'entry popup has no reason',
      "entry popup forbids nothing, which isn't a category",
      "entry popup's js row isn't whole numbers of bytes, raw and gzip",
      "entry popup's start has a jss row, which isn't one of html, js, css, fonts",
    ]);
  });
});

describe("build/budgets.json, with the owner's numbers (2026-10-31)", () => {
  it('reads as a budget file', () => {
    assert.deepEqual(readBudgets(ROOT).problems, []);
  });

  it('holds the approved rows exactly', () => {
    const { entries } = BUDGETS;
    assert.deepEqual(entries.newtab.start, { js: { raw: 700 * KIB, gzip: 200 * KIB }, css: { raw: 105 * KIB, gzip: 19 * KIB }, html: { raw: 72 * KIB, gzip: 12 * KIB }, fonts: null });
    // The workspace loads at boot, so it's start; nothing the root loads is named lazy
    assert.deepEqual(entries.newtab.startChunks, ['workspace']);
    assert.equal(entries.newtab.lazyChunks, undefined);
    assert.deepEqual(entries.background.dependencies, ['valibot']);
    assert.deepEqual(entries.popup.start.js, { raw: 115 * KIB, gzip: 40 * KIB });
    assert.deepEqual(entries.sidepanel.start.js, { raw: 112 * KIB, gzip: 40 * KIB });
    assert.equal(BUDGETS.timing.tolerancePct, 7);
    assert.deepEqual([BUDGETS.heap.limitMiB, BUDGETS.heap.tolerancePct], [4.45, 3]);
    // Timing gates the perf job since 14 valid CI runs; heap reports until the owner answers on its row
    assert.deepEqual([BUDGETS.timing.mode, BUDGETS.heap.mode], ['gate', 'report']);
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
});

describe("CI's perf summary (scripts/perf/gate-report.js)", () => {
  // The shipped rows with both set to report, for the cases that read a summary without failing
  const REPORTING = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'report' }, heap: { ...BUDGETS.heap, mode: 'report' } };
  const ratio = (median, extra = {}) => ({ median, q1: median - 0.01, q3: median + 0.01, values: Array(12).fill(median), ...extra });
  // The candidate's ratio to the first 1.4.0 copy alone is set apart from its ratio to both, so
  // a summary that read the first would show
  const probe = (self, both, heapMiB, { first = both + 0.2, failures = [], problems = [], rounds = 12 } = {}) => ({
    environment: { cpu: 'test', cores: 4, platform: 'linux' },
    timing: {
      browser: '156',
      runs: rounds,
      profiles: {
        typical: {
          packages: {
            '1.4.0': { interactionReadyMs: ratio(900), heapBytes: ratio(4 * 1048576), failures: [] },
            '1.4.0-again': { interactionReadyMs: ratio(905), heapBytes: ratio(4 * 1048576), failures: [] },
            candidate: { interactionReadyMs: ratio(950), heapBytes: ratio(heapMiB * 1048576), failures },
          },
          ratios: {
            '1.4.0-again': { self: true, interactionReady: ratio(self, { values: Array(rounds).fill(self) }) },
            candidate: { interactionReady: ratio(first, { values: Array(rounds).fill(first) }), againstBoth: { interactionReady: ratio(both, { values: Array(rounds).fill(both) }) } },
          },
        },
      },
    },
    problems,
  });

  it('says valid, pass or fail for timing and heap, and fails nothing while the rows report', () => {
    // Against the first copy alone the candidate is +25%: the summary reads both
    const passing = gateReport(probe(1.01, 1.05, 4.4, { first: 1.25 }), REPORTING);
    assert.deepEqual(passing.verdicts, [{ profile: 'typical', valid: true, timing: 'pass', heap: 'pass', problems: [] }]);
    assert.equal(passing.failed, false);
    assert.match(passing.markdown, /\| typical \| 12 \| \+1\.0% .* \| yes \| \+5\.0% .* \| pass \| 4\.40 MiB \| pass \|/);
    // Against the first copy alone it's +1%: the summary reads both
    const failing = gateReport(probe(1.01, 1.09, 4.7, { first: 1.01 }), REPORTING);
    assert.deepEqual(failing.verdicts, [{ profile: 'typical', valid: true, timing: 'fail', heap: 'fail', problems: [] }]);
    assert.equal(failing.failed, false, 'report-only rows fail nothing');
    assert.deepEqual(gateReport(probe(1.09, 1.0, 4.4), REPORTING).verdicts[0], { profile: 'typical', valid: false, timing: 'invalid', heap: 'pass', problems: [] });
  });

  it('calls a profile invalid when a round failed, the probe reported a problem, or rounds fall short', () => {
    const gated = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'gate' }, heap: { ...BUDGETS.heap, mode: 'gate' } };
    const cases = [
      [{ failures: [{ round: 3, message: 'the page never marked ready' }] }, 'candidate round 3 failed: the page never marked ready'],
      [{ problems: ["the typical fixture isn't the one build/budgets.json measured (aaaa, not bbbb), so its numbers don't compare"] }, "the probe: the typical fixture isn't the one build/budgets.json measured (aaaa, not bbbb), so its numbers don't compare"],
      [{ rounds: 9 }, '9 rounds, fewer than the 12 build/budgets.json takes'],
    ];
    for (const [options, reason] of cases) {
      const reported = gateReport(probe(1.01, 1.05, 4.4, options), REPORTING);
      assert.deepEqual(reported.verdicts[0], { profile: 'typical', valid: false, timing: 'invalid', heap: 'invalid', problems: [reason] }, reason);
      assert.equal(reported.failed, false, 'report mode fails nothing');
      assert.ok(reported.markdown.includes(`- typical: ${reason}`), reason);
      assert.equal(gateReport(probe(1.01, 1.05, 4.4, options), gated).failed, true, reason);
    }
  });

  it("fails the job on build/budgets.json's own rows: timing over its 7% fails, and heap over its row only reports", () => {
    // Timing is a gate as shipped: a candidate 9% slower than both 1.4.0 runs fails the job
    const slow = gateReport(probe(1.01, 1.09, 4.4), BUDGETS);
    assert.equal(slow.verdicts[0].timing, 'fail');
    assert.equal(slow.failed, true);
    // An invalid run fails it too: a gate can't pass on a run it can't read
    assert.equal(gateReport(probe(1.09, 1.0, 4.4), BUDGETS).failed, true);
    // Heap reports: over its row, it's written as a fail and fails nothing
    const heavy = gateReport(probe(1.01, 1.05, 4.7), BUDGETS);
    assert.deepEqual([heavy.verdicts[0].timing, heavy.verdicts[0].heap, heavy.failed], ['pass', 'fail', false]);
    // Within both rows, nothing fails
    assert.equal(gateReport(probe(1.01, 1.05, 4.4), BUDGETS).failed, false);
    // The same slow candidate with timing back on report passes the job
    assert.equal(gateReport(probe(1.01, 1.09, 4.4), REPORTING).failed, false);
  });

  it('fails once a row is a gate', () => {
    const gated = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'gate' } };
    assert.equal(gateReport(probe(1.01, 1.09, 4.4), gated).failed, true);
    assert.equal(gateReport(probe(1.09, 1.0, 4.4), gated).failed, true, 'an invalid run fails a gate');
    assert.equal(gateReport(probe(1.01, 1.05, 4.4), gated).failed, false);
  });

  it('writes a profile with a package that measured nothing as invalid, instead of throwing', () => {
    const gated = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'gate' }, heap: { ...BUDGETS.heap, mode: 'gate' } };
    // Every candidate round failed: the probe writes null for what it couldn't summarize
    const failures = Array.from({ length: 12 }, (_, index) => ({ round: index + 1, message: 'the page never marked ready' }));
    const empty = probe(1.01, 1.05, 4.4, { failures });
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
    const none = probe(1.01, 1.05, 4.4);
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
    assert.match(gate, /needs: \[unit, typecheck, kernel, build, extension\]/, "timing blocks a merge only once pr-gate needs it, or a ruleset requires it: the owner's call");
    assert.ok(!/uses: \.\/\.github\/workflows\/perf\.yml|workflow_run/.test(gate), "pr-gate doesn't call or wait on the perf workflow");
    // Every ruleset that requires a check requires pr-gate alone, not perf
    for (const name of fs.readdirSync(path.join(ROOT, '.github/rulesets'))) {
      const ruleset = JSON.parse(fs.readFileSync(path.join(ROOT, '.github/rulesets', name), 'utf8'));
      const contexts = (ruleset.rules || []).filter(rule => rule.type === 'required_status_checks').flatMap(rule => rule.parameters.required_status_checks.map(check => check.context));
      assert.ok(contexts.every(context => context === 'pr-gate'), `${name} requires ${contexts.join(', ')}`);
    }
  });

  it('lets npm run perf:probe --baseline read build/budgets.json', () => {
    const timing = { profiles: { typical: { fixtureDigest: BUDGETS.fixtureDigests.typical, ratios: { again: { self: true, interactionReady: { median: 1.08 } } } } } };
    assert.deepEqual(fixtureProblems(timing, path.join(ROOT, 'build/budgets.json')), [
      'invalid run on typical: the reference against itself (again) is 8.0% off, more than the 7% tolerance',
    ]);
  });
});
