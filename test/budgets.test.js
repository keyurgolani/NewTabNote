// #27 slice 4b: the analyzer and the budget gate (scripts/build/budgets.js) on a bundle the test
// writes, build/budgets.json with the owner's numbers, and the timing and heap summary CI's perf
// job writes (scripts/perf/gate-report.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyze, checkBudgets, readBudgets, fileProblems, matches, packageOf } = require('../scripts/build/budgets.js');
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
      'model-runtime': { about: 'model runtimes', paths: ['js/lib/transformers.js', '**/*.wasm'] },
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

  it('counts the chunk the root loads at once as start, not lazy, so the row measures the tab and not only its root', () => {
    const { files, chunks, loaderChunks } = bundleFixture();
    const booted = analyze({ chunks, files, loaderChunks, budgets: budgetsFor() }).newtab;
    assert.deepEqual(booted.boots, [{ chunk: 'workspace', file: 'assets/workspace.js', from: 'assets/newtab.js' }]);
    // Without startChunks the workspace and what it imports would be lazy, the way the byte-mode
    // probe files them, and start JS would be the root, its loader and the boot guard
    const rootOnly = analyze({ chunks, files, loaderChunks, budgets: budgetsFor({ newtab: { ...budgetsFor().entries.newtab, startChunks: undefined } }) }).newtab;
    assert.ok(rootOnly.lazy.files.some(entry => entry.file === 'assets/workspace.js') && rootOnly.lazy.files.some(entry => entry.file === 'assets/host.js'));
    assert.ok(!booted.lazy.files.some(entry => entry.file === 'assets/workspace.js' || entry.file === 'assets/host.js'));
    const sum = list => list.reduce((total, file) => total + files.read(file).length, 0);
    assert.equal(rootOnly.start.bytes.js.raw, sum(['assets/newtab.js', 'js/entries/boot-guard.js', 'js/runtime/lazy.js']));
    assert.equal(booted.start.bytes.js.raw, rootOnly.start.bytes.js.raw + sum(['assets/workspace.js', 'assets/host.js']));
    assert.ok(booted.start.modules.includes('js/kernel/composition/host.js'));
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
    // Counting only the root, the same row would pass without checking the tab
    assert.deepEqual(run(budgetsFor({ newtab: { ...between, startChunks: undefined } })), []);
  });

  it("fails a startChunks name the build doesn't have, or one nothing on the page's start loads", () => {
    const newtab = budgetsFor().entries.newtab;
    assert.deepEqual(run(budgetsFor({ newtab: { ...newtab, startChunks: ['workspace', 'shell'] } })), [
      "budget/entry newtab: its row's startChunks names shell, and the build has no loader chunk by that name, so its start would leave out what the page loads at boot",
    ]);
    const fixture = bundleFixture();
    fixture.chunks[0] = { ...fixture.chunks[0], dynamicImports: [] };
    assert.deepEqual(run(budgetsFor(), fixture), [
      "budget/entry newtab: its row's startChunks names workspace (assets/workspace.js), and nothing on the page's start loads it with import(): the row says the page boots a chunk it doesn't",
    ]);
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
    const bad = budgetsFor({ popup: { page: 'popup.html', reason: '', start: { js: { raw: 1.5, gzip: 2 } }, forbidden: ['nothing'] } });
    assert.deepEqual(fileProblems(bad).map(({ message }) => message), [
      'entry popup has no reason',
      "entry popup forbids nothing, which isn't a category",
      "entry popup's js row isn't whole numbers of bytes, raw and gzip",
    ]);
  });
});

describe("build/budgets.json, with the owner's numbers (2026-10-31)", () => {
  it('reads as a budget file', () => {
    assert.deepEqual(readBudgets(ROOT).problems, []);
  });

  it('holds the approved rows exactly', () => {
    const { entries } = BUDGETS;
    assert.deepEqual(entries.newtab.start, { js: { raw: 700 * KIB, gzip: 200 * KIB }, css: { raw: 100 * KIB, gzip: 19 * KIB }, html: { raw: 72 * KIB, gzip: 12 * KIB }, fonts: null });
    assert.deepEqual(entries.popup.start.js, { raw: 115 * KIB, gzip: 40 * KIB });
    assert.deepEqual(entries.sidepanel.start.js, { raw: 112 * KIB, gzip: 40 * KIB });
    assert.equal(BUDGETS.timing.tolerancePct, 7);
    assert.deepEqual([BUDGETS.heap.limitMiB, BUDGETS.heap.tolerancePct], [4.45, 3]);
    assert.deepEqual([BUDGETS.timing.mode, BUDGETS.heap.mode], ['report', 'report']);
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
  const ratio = (median, extra = {}) => ({ median, q1: median - 0.01, q3: median + 0.01, values: Array(12).fill(median), ...extra });
  const probe = (self, both, heapMiB) => ({
    environment: { cpu: 'test', cores: 4, platform: 'linux' },
    timing: {
      browser: '156',
      profiles: {
        typical: {
          packages: {
            '1.4.0': { interactionReadyMs: ratio(900), heapBytes: ratio(4 * 1048576) },
            '1.4.0-again': { interactionReadyMs: ratio(905), heapBytes: ratio(4 * 1048576) },
            candidate: { interactionReadyMs: ratio(950), heapBytes: ratio(heapMiB * 1048576) },
          },
          ratios: {
            '1.4.0-again': { self: true, interactionReady: ratio(self) },
            candidate: { interactionReady: ratio(both), againstBoth: { interactionReady: ratio(both) } },
          },
        },
      },
    },
    problems: [],
  });

  it('says valid, pass or fail for timing and heap, and fails nothing while the rows report', () => {
    const passing = gateReport(probe(1.01, 1.05, 4.4), BUDGETS);
    assert.deepEqual(passing.verdicts, [{ profile: 'typical', valid: true, timing: 'pass', heap: 'pass' }]);
    assert.equal(passing.failed, false);
    assert.match(passing.markdown, /\| typical \| 12 \| \+1\.0% .* \| yes \| \+5\.0% .* \| pass \| 4\.40 MiB \| pass \|/);
    const failing = gateReport(probe(1.01, 1.09, 4.7), BUDGETS);
    assert.deepEqual(failing.verdicts, [{ profile: 'typical', valid: true, timing: 'fail', heap: 'fail' }]);
    assert.equal(failing.failed, false, 'report-only rows fail nothing');
    assert.deepEqual(gateReport(probe(1.09, 1.0, 4.4), BUDGETS).verdicts[0], { profile: 'typical', valid: false, timing: 'invalid', heap: 'pass' });
  });

  it('fails once a row is a gate', () => {
    const gated = { ...BUDGETS, timing: { ...BUDGETS.timing, mode: 'gate' } };
    assert.equal(gateReport(probe(1.01, 1.09, 4.4), gated).failed, true);
    assert.equal(gateReport(probe(1.09, 1.0, 4.4), gated).failed, true, 'an invalid run fails a gate');
    assert.equal(gateReport(probe(1.01, 1.05, 4.4), gated).failed, false);
  });

  it('lets npm run perf:probe --baseline read build/budgets.json', () => {
    const timing = { profiles: { typical: { fixtureDigest: BUDGETS.fixtureDigests.typical, ratios: { again: { self: true, interactionReady: { median: 1.08 } } } } } };
    assert.deepEqual(fixtureProblems(timing, path.join(ROOT, 'build/budgets.json')), [
      'invalid run on typical: the reference against itself (again) is 8.0% off, more than the 7% tolerance',
    ]);
  });
});
