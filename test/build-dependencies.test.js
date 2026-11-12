'use strict';

// The dependency report (#300, from #27's Outputs). A production build writes
// dist-report/dependencies.json beside the chunk graph, for #31's release pipeline: for each entry,
// its packages from node_modules, with the version and license each package.json gives, and its
// vendored files under js/lib/, with the package, version and license js/lib/vendor.json, or the
// record a vendored folder holds, gives. Both lists are sorted, so one graph writes the same bytes
// every time, and npm run verify:reproducible compares the report across its two builds.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** scripts/build/dependencies.js, required in each case that uses it */
const dependencies = () => require('../scripts/build/dependencies.js');

/**
 * A chunk graph entry whose start, lazy and workers parts hold these modules
 * @param {{start?: string[], lazy?: string[], workers?: string[]}} modules
 */
function entry({ start = [], lazy = [], workers = [] }) {
  const part = (/** @type {string[]} */ list) => ({ files: [], bytes: {}, modules: list, packages: [] });
  return { kind: 'page', at: 'page.html', start: part(start), lazy: part(lazy), workers: part(workers) };
}

/**
 * A tree at `dir` with two vendored files, a vendored folder and two node_modules packages
 * @param {string} dir
 */
function tree(dir) {
  const write = (/** @type {string} */ file, /** @type {unknown} */ json) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(json));
  };
  write('js/lib/vendor.json', { files: { 'chart.js': { package: 'chart.js', version: '4.4.1', license: 'MIT' }, 'jszip.min.js': { package: 'jszip', version: '3.10.1', license: 'MIT' } } });
  write('js/lib/valibot/vendor.json', { package: 'valibot', version: '1.5.0', license: 'MIT', files: {} });
  write('node_modules/zeta/package.json', { name: 'zeta', version: '2.0.0', license: 'ISC' });
  write('node_modules/@scope/alpha/package.json', { name: '@scope/alpha', version: '1.2.3', license: 'Apache-2.0' });
}

const VALIBOT = Object.freeze({ file: 'js/lib/valibot/index.mjs', package: 'valibot', version: '1.5.0', license: 'MIT' });
const GRAPH = Object.freeze({
  newtab: entry({
    start: ['js/app.js', 'node_modules/zeta/index.js'],
    lazy: ['js/lib/jszip.min.js', 'js/lib/chart.js', 'node_modules/@scope/alpha/dist/a.js', 'node_modules/zeta/other.js'],
    workers: ['js/lib/valibot/index.mjs'],
  }),
  popup: entry({ lazy: ['js/lib/valibot/index.mjs'] }),
  offscreen: entry({ start: ['js/offscreen.js'] }),
});

describe('dist-report/dependencies.json (#300)', () => {
  it("lists each entry's node_modules packages and js/lib/ vendored files with the version and license their records give, the entries and both lists sorted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-dependencies-'));
    try {
      tree(dir);
      const report = JSON.parse(dependencies().dependencyReport(GRAPH, { buildId: 'build-x', root: dir }));
      assert.deepEqual(report, {
        buildId: 'build-x',
        entries: {
          newtab: {
            packages: [{ name: '@scope/alpha', version: '1.2.3', license: 'Apache-2.0' }, { name: 'zeta', version: '2.0.0', license: 'ISC' }],
            vendored: [
              { file: 'js/lib/chart.js', package: 'chart.js', version: '4.4.1', license: 'MIT' },
              { file: 'js/lib/jszip.min.js', package: 'jszip', version: '3.10.1', license: 'MIT' },
              VALIBOT,
            ],
          },
          offscreen: { packages: [], vendored: [] },
          popup: { packages: [], vendored: [VALIBOT] },
        },
      });
      assert.deepEqual(Object.keys(report.entries), ['newtab', 'offscreen', 'popup']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the same bytes for one graph twice, whatever order its entries and modules come in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-dependencies-'));
    try {
      tree(dir);
      const { dependencyReport } = dependencies();
      const first = dependencyReport(GRAPH, { buildId: 'build-x', root: dir });
      assert.equal(dependencyReport(GRAPH, { buildId: 'build-x', root: dir }), first);
      const reversed = (/** @type {any} */ graphEntry) => entry({ start: [...graphEntry.start.modules].reverse(), lazy: [...graphEntry.lazy.modules].reverse(), workers: [...graphEntry.workers.modules].reverse() });
      const shuffled = { popup: reversed(GRAPH.popup), offscreen: reversed(GRAPH.offscreen), newtab: reversed(GRAPH.newtab) };
      assert.equal(dependencyReport(shuffled, { buildId: 'build-x', root: dir }), first);
      assert.ok(first.endsWith('}\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads next's own records: js/lib/vendor.json for a vendored file, and a vendored folder's record for valibot's module", () => {
    const vendor = JSON.parse(fs.readFileSync(path.join(ROOT, 'js', 'lib', 'vendor.json'), 'utf8')).files['chart.js'];
    const valibot = JSON.parse(fs.readFileSync(path.join(ROOT, 'js', 'lib', 'valibot', 'vendor.json'), 'utf8'));
    const report = JSON.parse(dependencies().dependencyReport({ newtab: entry({ lazy: ['js/lib/valibot/index.mjs', 'js/lib/chart.js'] }) }, { buildId: 'build-x' }));
    assert.deepEqual(report.entries.newtab.vendored, [
      { file: 'js/lib/chart.js', package: 'chart.js', version: vendor.version, license: vendor.license },
      { file: 'js/lib/valibot/index.mjs', package: 'valibot', version: valibot.version, license: valibot.license },
    ]);
  });

  it('is written beside dist-report/chunk-graph.json, and npm run verify:reproducible fails two builds whose reports differ', () => {
    const { DEPENDENCIES, CHUNK_GRAPH } = require('../scripts/build/main.js');
    assert.equal(DEPENDENCIES, path.join(ROOT, 'dist-report', 'dependencies.json'));
    assert.equal(path.dirname(DEPENDENCIES), path.dirname(CHUNK_GRAPH));
    const { buildDifferences } = require('../scripts/build/verify-reproducible.js');
    const build = (/** @type {string} */ report) => ({ dir: '/build', zip: Buffer.from('zip'), info: { buildId: 'build-x', outputDigest: 'digest' }, dependencies: Buffer.from(report) });
    assert.deepEqual(buildDifferences(build('{"entries":{}}\n'), build('{"entries":{}}\n')), []);
    const found = buildDifferences(build('{"entries":{}}\n'), build('{"entries":{"newtab":{}}}\n'));
    assert.equal(found.length, 1, found.join('\n'));
    assert.match(found[0], /^dist-report\/dependencies\.json differs: [0-9a-f]{64} and [0-9a-f]{64}$/);
  });
});
