/**
 * #27 slice 4a's performance probe, the parts that need no browser: what each page of a
 * package loads and its bytes (scripts/perf/package-bytes.js), the options, the medians, and
 * the fixture profiles. The timed runs are e2e/perf-probe.spec.js's.
 */

const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { packageBytes, moduleReferences, cssReferences, htmlReferences } = require('../scripts/perf/package-bytes');
const { parseArgs, summary, roundOrder, fixtureProblems, gateProblems, packageDigest, main } = require('../scripts/perf-probe');
const { profileFixture, PROFILES } = require('../scripts/perf/profiles');

const made = [];
after(() => made.forEach(root => fs.rmSync(root, { recursive: true, force: true })));

/**
 * A package in a temporary directory, from `files` (path -> text)
 * @param {Record<string, string>} files
 */
function packageOf(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-perf-probe-'));
  made.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const gzip = text => zlib.gzipSync(Buffer.from(text), { level: 9 }).length;

const LEGACY = {
  'manifest.json': JSON.stringify({ manifest_version: 3, version: '1.4.0', chrome_url_overrides: { newtab: 'newtab.html' }, side_panel: { default_path: 'sidepanel.html' } }),
  'newtab.html': [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="css/app.css">',
    '<!-- <script src="js/commented.js"></script> -->',
    '</head><body>',
    '<script src="js/lib/vendor.js"></script>',
    '<script type="module" src="js/main.js"></script>',
    '</body></html>',
  ].join('\n'),
  'css/app.css': '@import "./theme.css";\nbody { background: url("../assets/bg.png"); }\n',
  'css/theme.css': '@font-face { font-family: X; src: url(../fonts/x.woff2) format("woff2"); }\n',
  'fonts/x.woff2': 'font-bytes',
  'assets/bg.png': 'png-bytes',
  'js/lib/vendor.js': 'window.Vendor = {};\n',
  'js/main.js': "import './a.js';\nexport { b } from './b.js';\nconst later = () => import('./lazy.js');\n",
  'js/a.js': "import { b } from './b.js';\nwindow.a = b;\n",
  'js/b.js': 'export const b = 1;\n',
  'js/lazy.js': 'export default 1;\n',
  'popup.html': '<script type="module" src="js/b.js"></script>',
  'sidepanel.html': '<script src="js/lib/vendor.js"></script>',
};

describe("what a package's pages load (scripts/perf/package-bytes.js)", () => {
  it('follows script tags, module imports, stylesheets, @import and fonts, and counts what it reads', () => {
    const root = packageOf(LEGACY);
    const { pages, problems } = packageBytes(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.keys(pages), ['newtab', 'popup', 'sidepanel']);
    const newtab = pages.newtab;
    assert.deepEqual(
      newtab.files.map(entry => [entry.file, entry.type]),
      [
        ['css/app.css', 'css'],
        ['css/theme.css', 'css'],
        ['fonts/x.woff2', 'fonts'],
        ['js/a.js', 'js'],
        ['js/b.js', 'js'],
        ['js/lazy.js', 'lazy'],
        ['js/lib/vendor.js', 'js'],
        ['js/main.js', 'js'],
        ['newtab.html', 'html'],
      ],
    );
    assert.equal(newtab.modules, 3);
    assert.equal(newtab.classicScripts, 1);
    assert.equal(newtab.dynamicImports, 1);
    const js = ['js/a.js', 'js/b.js', 'js/lib/vendor.js', 'js/main.js'];
    assert.deepEqual(newtab.js, {
      raw: js.reduce((sum, file) => sum + Buffer.byteLength(LEGACY[file]), 0),
      gzip: js.reduce((sum, file) => sum + gzip(LEGACY[file]), 0),
      files: 4,
    });
    assert.deepEqual(newtab.html, { raw: Buffer.byteLength(LEGACY['newtab.html']), gzip: gzip(LEGACY['newtab.html']), files: 1 });
    assert.equal(newtab.total.files, 8);
    assert.deepEqual(newtab.lazy, { raw: Buffer.byteLength(LEGACY['js/lazy.js']), gzip: gzip(LEGACY['js/lazy.js']), files: 1 });
    assert.equal(newtab.total.raw, newtab.html.raw + newtab.js.raw + newtab.css.raw + newtab.fonts.raw);
    // popup.html, with no action.default_popup, is the file the harness opens
    assert.equal(pages.popup.file, 'popup.html');
    assert.equal(pages.popup.modules, 1);
    assert.equal(pages.sidepanel.classicScripts, 1);
  });

  it("reads a bundler's minified output the same way", () => {
    const root = packageOf({
      'manifest.json': JSON.stringify({ chrome_url_overrides: { newtab: 'newtab.html' } }),
      'newtab.html': '<script type=module crossorigin src="/assets/newtab-a1.js"></script><link rel="modulepreload" href="/assets/chunk-b2.js"><link rel=stylesheet href="/assets/newtab-c3.css">',
      'assets/newtab-a1.js': 'import{a as o}from"./chunk-b2.js";import"./chunk-d4.js";o();const l=()=>import("./lazy-e5.js");',
      'assets/chunk-b2.js': 'const a=()=>{};export{a};',
      'assets/chunk-d4.js': 'console.log(1);',
      'assets/lazy-e5.js': 'export default 1;',
      'assets/newtab-c3.css': 'body{margin:0}',
    });
    const { pages, problems } = packageBytes(root);
    assert.deepEqual(problems, ['the package has no popup page: the manifest names none and popup.html is missing', 'the package has no sidepanel page: the manifest names none and sidepanel.html is missing']);
    assert.deepEqual(pages.newtab.files.map(entry => [entry.file, entry.type]), [
      ['assets/chunk-b2.js', 'js'],
      ['assets/chunk-d4.js', 'js'],
      ['assets/lazy-e5.js', 'lazy'],
      ['assets/newtab-a1.js', 'js'],
      ['assets/newtab-c3.css', 'css'],
      ['newtab.html', 'html'],
    ]);
    assert.equal(pages.newtab.modules, 3);
    assert.equal(pages.newtab.dynamicImports, 1);
  });

  it('names a reference that would fail to load: a missing file, a URL, and a bare specifier', () => {
    const root = packageOf({
      'manifest.json': JSON.stringify({ chrome_url_overrides: { newtab: 'newtab.html' } }),
      'newtab.html': '<script src="js/gone.js"></script><script src="https://cdn.example.test/x.js"></script><script type="module" src="js/m.js"></script>',
      'js/m.js': "import 'lib';\n",
    });
    const { problems } = packageBytes(root);
    assert.ok(problems.includes('newtab.html names "js/gone.js", but js/gone.js is missing'), problems.join('\n'));
    assert.ok(problems.includes('newtab.html names "https://cdn.example.test/x.js", a URL outside the package'), problems.join('\n'));
    assert.ok(problems.includes('js/m.js imports "lib", a bare specifier nothing resolves in a package'), problems.join('\n'));
  });

  it('reads HTML, module and CSS references in their own syntax', () => {
    assert.deepEqual(htmlReferences('<link rel="preload stylesheet" href=a.css><script src=\'b.js\' type="MODULE"></script>'), {
      scripts: [{ src: 'b.js', module: true }],
      preloads: [],
      styles: ['a.css'],
    });
    assert.deepEqual(moduleReferences("export * from './x.js'; import y from \"./y.js\"; import('./z.js'); importScripts('w.js');", 'm.js'), {
      imports: ['./x.js', './y.js'],
      dynamicImports: 1,
      lazy: ['./z.js'],
      workers: [],
      importScripts: ['w.js'],
    });
    assert.deepEqual(cssReferences("@import url('a.css'); /* url(b.woff2) */ src: url(c.woff?v=1), url(d.svg);"), {
      imports: ['a.css'],
      fonts: ['c.woff?v=1'],
    });
  });

  it('puts what import() and new Worker() load in buckets of their own, outside the total', () => {
    const root = packageOf({
      'manifest.json': JSON.stringify({ chrome_url_overrides: { newtab: 'newtab.html' } }),
      'newtab.html': '<script type="module" src="js/main.js"></script>',
      'js/main.js': [
        "import { shared } from './shared.js';",
        "const chart = () => import('./chart.js');",
        "new Worker('js/workers/legacy.js');",
        "new Worker(new URL('./workers/module.js', import.meta.url), { type: 'module' });",
        "new Worker('js/workers/gone.js');",
        'const later = name => import(name);',
      ].join('\n'),
      'js/shared.js': 'export const shared = 1;\n',
      'js/chart.js': "import { shared } from './shared.js';\nimport './chart-part.js';\n",
      'js/chart-part.js': 'export {};\n',
      'js/workers/legacy.js': "importScripts('helper.js');\n",
      'js/workers/helper.js': 'self.helper = 1;\n',
      'js/workers/module.js': "import '../shared.js';\nimport './module-part.js';\n",
      'js/workers/module-part.js': 'export {};\n',
      'popup.html': '',
      'sidepanel.html': '',
    });
    const { pages, problems } = packageBytes(root);
    assert.deepEqual(problems, []);
    const newtab = pages.newtab;
    const of = type => newtab.files.filter(entry => entry.type === type).map(entry => entry.file);
    assert.deepEqual(of('js'), ['js/main.js', 'js/shared.js']);
    assert.deepEqual(of('lazy'), ['js/chart-part.js', 'js/chart.js']);
    assert.deepEqual(of('workers'), ['js/workers/helper.js', 'js/workers/legacy.js', 'js/workers/module-part.js', 'js/workers/module.js']);
    assert.equal(newtab.dynamicImports, 2);
    assert.deepEqual(newtab.missing, ['js/workers/gone.js']);
    assert.equal(newtab.total.files, 3);
    assert.equal(newtab.lazy.files, 2);
    assert.equal(newtab.workers.files, 4);
  });

  it("measures the repository's own pages without a problem", () => {
    // The source tree is laid out like the package, which is what scripts/build.js copies
    const { pages, problems } = packageBytes(path.join(__dirname, '..'));
    assert.deepEqual(problems, []);
    assert.ok(pages.newtab.modules > 0 && pages.popup.modules > 0, JSON.stringify(Object.keys(pages)));
  });
});

describe('the probe (scripts/perf-probe.js)', () => {
  it('takes its options, and names a wrong one', () => {
    assert.deepEqual(parseArgs([]), { dists: [], labels: [], timing: false, runs: 11, profiles: [...PROFILES], out: null, baseline: null });
    assert.deepEqual(
      parseArgs(['--dist', 'a', '--label', '1.4.0', '--dist', 'b', '--timing', '--runs', '3', '--profiles', 'typical,maximal', '--out', 'o.json', '--baseline', 'base.json']),
      { dists: ['a', 'b'], labels: ['1.4.0'], timing: true, runs: 3, profiles: ['typical', 'maximal'], out: 'o.json', baseline: 'base.json' },
    );
    assert.throws(() => parseArgs(['--runs', '0']), /at least 1/);
    assert.throws(() => parseArgs(['--profiles', 'lib-10k']), /not lib-10k/);
    assert.throws(() => parseArgs(['--dist']), /needs a value/);
    assert.throws(() => parseArgs(['--label', 'a', '--label', 'b']), /more --label options than packages/);
    assert.throws(() => parseArgs(['--fast']), /unknown option --fast/);
  });

  it('gives the median, quartiles, minimum and maximum of a run', () => {
    assert.deepEqual(summary([30, 10, 20]), { median: 20, q1: 15, q3: 25, min: 10, max: 30, values: [30, 10, 20] });
    assert.equal(summary([4, 1, 3, 2]).median, 2.5);
    assert.equal(summary([]), null);
  });

  it('interleaves packages, rotating the order each round, so two run ABBA', () => {
    assert.deepEqual([0, 1, 2, 3].map(round => roundOrder(2, round)), [[0, 1], [1, 0], [0, 1], [1, 0]]);
    assert.deepEqual([0, 1, 2].map(round => roundOrder(3, round)), [[0, 1, 2], [1, 2, 0], [2, 0, 1]]);
  });

  it('writes each package\'s bytes to --out, labels them apart, and fails on a package with a broken reference', async () => {
    const root = packageOf(LEGACY);
    const broken = packageOf({ ...LEGACY, 'js/a.js': "import './gone.js';\n" });
    const out = path.join(packageOf({}), 'report.json');
    const lines = [];
    const code = await main(['--dist', root, '--dist', root, '--dist', broken, '--out', out], { log: line => lines.push(line) });
    assert.equal(code, 1);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.format, 'ntn-perf-probe/2');
    assert.deepEqual(report.packages.map(entry => entry.label), ['1.4.0', '1.4.0#2', '1.4.0#3']);
    assert.equal(report.packages[0].bytes.newtab.total.files, 8);
    assert.deepEqual(report.packages[0].problems, []);
    assert.deepEqual(report.packages[2].problems, ['js/a.js names "./gone.js", but js/gone.js is missing']);
    assert.equal(report.timing, null);
    assert.ok(lines.some(line => line.startsWith('1.4.0#3 problem: js/a.js names')), lines.join('\n'));
    assert.equal(await main(['--dist', root, '--out', out], { log: () => {} }), 0);
  });

  it('digests a package by its sorted files, the same wherever it is copied', () => {
    const one = packageOf(LEGACY);
    const two = packageOf(LEGACY);
    assert.equal(packageDigest(one), packageDigest(two));
    assert.match(packageDigest(one), /^[0-9a-f]{64}$/);
    assert.notEqual(packageDigest(packageOf({ ...LEGACY, 'js/b.js': 'export const b = 2;\n' })), packageDigest(one));
  });

  it("refuses a gate run whose reference isn't the baseline's, isn't there twice, or has too few or odd rounds", () => {
    const file = path.join(packageOf({}), 'baseline.json');
    fs.writeFileSync(file, JSON.stringify({ reference: { label: '1.4.0', packageDigest: 'r'.repeat(64) } }));
    const reference = { label: '1.4.0', digest: 'r'.repeat(64) };
    const again = { label: '1.4.0-again', digest: 'r'.repeat(64) };
    const next = { label: 'next', digest: 'n'.repeat(64) };
    assert.deepEqual(gateProblems({ packages: [reference, again, next], runs: 12, timing: true }, file), []);
    assert.deepEqual(gateProblems({ packages: [reference, again, next], runs: 12, timing: false }, file), []);
    assert.deepEqual(gateProblems({ packages: [next, reference, again], runs: 12, timing: true }, file), [
      `the first package (next) isn't ${file}'s reference, 1.4.0 (nnnnnnnnnnnn, not rrrrrrrrrrrr)`,
      'a gate run measures the reference twice a round: pass it as the second package too',
    ]);
    assert.deepEqual(gateProblems({ packages: [reference, next], runs: 12, timing: true }, file), [
      'a gate run measures the reference twice a round: pass it as the second package too',
    ]);
    assert.deepEqual(gateProblems({ packages: [reference, again, next], runs: 15, timing: true }, file), []);
    // 14 rounds of three packages put them in each position 5, 4 and 5 times
    assert.deepEqual(gateProblems({ packages: [reference, again, next], runs: 14, timing: true }, file), [
      'a gate run takes at least 12 rounds, a multiple of its 3 packages, so the rotation balances; not 14',
    ]);
    assert.deepEqual(gateProblems({ packages: [reference, again, next], runs: 9, timing: true }, file), [
      'a gate run takes at least 12 rounds, a multiple of its 3 packages, so the rotation balances; not 9',
    ]);
    assert.deepEqual(gateProblems({ packages: [reference, again, next, next], runs: 12, timing: true }, file), []);
  });

  it('calls a run invalid, not a pass, when the reference against itself is off by more than the tolerance', () => {
    const file = path.join(packageOf({}), 'baseline.json');
    fs.writeFileSync(file, JSON.stringify({ fixtureDigests: { typical: 'aaa', maximal: 'bbb' }, proposed: { timing: { tolerancePct: 7 } } }));
    const self = median => ({ '1.4.0-again': { self: true, interactionReady: { median } }, next: { interactionReady: { median: 1.3 } } });
    const timing = { profiles: { typical: { fixtureDigest: 'aaa', ratios: self(1.069) }, maximal: { fixtureDigest: 'bbb', ratios: self(0.92) } } };
    assert.deepEqual(fixtureProblems(timing, file), [
      'invalid run on maximal: the reference against itself (1.4.0-again) is 8.0% off, more than the 7% tolerance',
    ]);
  });

  it("names a fixture that isn't the one the baseline measured", () => {
    const file = path.join(packageOf({}), 'baseline.json');
    fs.writeFileSync(file, JSON.stringify({ fixtureDigests: { typical: 'aaa', maximal: 'bbb' } }));
    const timing = { profiles: { typical: { fixtureDigest: 'aaa' }, maximal: { fixtureDigest: 'ccc' }, 'first-run': { fixtureDigest: null } } };
    assert.deepEqual(fixtureProblems(timing, file), [
      `the maximal fixture isn't the one ${file} measured (ccc, not bbb), so its numbers don't compare`,
      `${file} records no first-run fixture, so this run can't be compared with it`,
    ]);
  });
});

describe("ref-desktop's fixture profiles (scripts/perf/profiles.js)", () => {
  it('seeds nothing for first-run, and an onboarded version-8 profile for typical and maximal, the same each time', async () => {
    assert.deepEqual(await profileFixture('first-run'), { name: 'first-run', fixture: null, digest: null });
    for (const name of ['typical', 'maximal']) {
      const profile = await profileFixture(name);
      assert.equal(profile.fixture.chromeStorageLocal.setting_hasCompletedOnboarding, true, name);
      assert.deepEqual(profile.fixture.databases.map(db => [db.name, db.version]), [['CanvasTabDB', 8]], name);
      assert.equal((await profileFixture(name)).digest, profile.digest, `${name} is the same from one call to the next`);
    }
    const typical = await profileFixture('typical');
    const maximal = await profileFixture('maximal');
    const notes = profile => profile.fixture.databases[0].stores.find(store => store.name === 'canvases').records.length;
    assert.ok(notes(maximal) >= notes(typical));
    await assert.rejects(profileFixture('lib-1k'), /no profile "lib-1k"/);
  });
});
