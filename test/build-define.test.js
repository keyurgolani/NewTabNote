'use strict';

// The define allowlist (#300, from #27's "Security"). build/define-allowlist.json holds each value
// the build inlines beyond three named keys: a row, read in first-party code as __NTN_<name>__,
// with its owner issue and its release, dev and test values. npm run build inlines each row's
// release value and build:dev its dev value, and first-party code that reads an __NTN_ name the
// file has no row for fails as define/unknown. test/helpers/load-background.js starts the worker
// with every row at its release value. The fixtures define-unknown-row, define-file and
// env-import-meta (test/build-fixtures/) show the rules in a build.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../scripts/build/vite-config.js');
const { checkEnvironment, checkSourceEnvironment } = require('../scripts/build/environment.js');
const { packageOf } = require('./helpers/source-package.js');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'build', 'define-allowlist.json');

/** scripts/build/define-allowlist.js, required in each case that uses it */
const allowlist = () => require('../scripts/build/define-allowlist.js');

/** The file's rows, read without the module under test */
const fileRows = () => JSON.parse(fs.readFileSync(FILE, 'utf8')).rows;

/** A row that reads as one */
const ROW = Object.freeze({ owner: 2, release: false, dev: false, test: false, reason: 'what it gates, and when it turns on' });

/**
 * The three keys the define sets that aren't rows: the mode, the build's ID, and the module shim
 * @param {string} mode
 */
function namedKeys(mode) {
  return { 'process.env.NODE_ENV': JSON.stringify(mode), __NTN_BUILD_ID__: JSON.stringify('build-x'), module: 'undefined' };
}

/**
 * Each pass's configuration in `mode`, with `defineRows` as the allowlist's rows
 * @param {string} mode
 * @param {object} defineRows
 */
function passes(mode, defineRows) {
  const options = { root: '/repo', outDir: '/repo/.dist-staging-x', mode, buildId: 'build-x', defineRows, report: { chunks: [], assets: [] }, logger: /** @type {any} */ ({}), onLog: () => {} };
  return [config.pagesConfig(options), config.recoveryConfig(options), config.backgroundConfig(options), config.guardConfig({ ...options, guardRows: [] })];
}

describe('build/define-allowlist.json (#300)', () => {
  it('seeds moment (#2) and workspace (#3), each off in release, and reads as the rows it holds, with no problem', () => {
    const rows = fileRows();
    for (const [name, owner] of [['moment', 2], ['workspace', 3]]) {
      assert.ok(Object.hasOwn(rows, name), `no ${name} row`);
      assert.deepEqual([rows[name].owner, rows[name].release], [owner, false], name);
    }
    const read = allowlist().readAllowlist();
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.rows, rows);
  });

  it("inlines each row's release value in build and its dev value in build:dev, beside the three named keys and nothing else, in every pass", () => {
    const rows = fileRows();
    for (const mode of ['production', 'development']) {
      const values = Object.fromEntries(Object.entries(rows).map(([name, row]) => [`__NTN_${name}__`, JSON.stringify(mode === 'production' ? row.release : row.dev)]));
      for (const pass of passes(mode, allowlist().readAllowlist().rows)) assert.deepEqual(pass.define, { ...namedKeys(mode), ...values }, mode);
    }
  });

  it("takes a row's release value in build and its dev value in build:dev, never its test value, each as a literal of its type", () => {
    const defineRows = {
      flag: { ...ROW, dev: true, test: true },
      clientId: { ...ROW, owner: 19, release: 'release-id', dev: 'dev-id', test: 'test-id' },
      limit: { ...ROW, release: 0, dev: 2, test: 3 },
    };
    for (const pass of passes('production', defineRows)) {
      assert.deepEqual(pass.define, { ...namedKeys('production'), __NTN_flag__: 'false', __NTN_clientId__: '"release-id"', __NTN_limit__: '0' });
    }
    for (const pass of passes('development', defineRows)) {
      assert.deepEqual(pass.define, { ...namedKeys('development'), __NTN_flag__: 'true', __NTN_clientId__: '"dev-id"', __NTN_limit__: '2' });
    }
  });

  it('fails a row with no owner, a missing value or no reason, and a file that is missing, does not parse or has no rows, each as define/file', () => {
    const { fileProblems, readAllowlist } = allowlist();
    const file = (/** @type {object} */ rows) => ({ about: 'what the rows are', rows });
    assert.deepEqual(fileProblems(file({ moment: ROW })), []);
    const rows = {
      'no owner': { moment: { ...ROW, owner: undefined } },
      'an owner that is no issue number': { moment: { ...ROW, owner: '#2' } },
      'no release value': { moment: { ...ROW, release: undefined } },
      'no dev value': { moment: { ...ROW, dev: null } },
      'no test value': { moment: { ...ROW, test: undefined } },
      'a value the build cannot inline as a literal': { moment: { ...ROW, dev: { on: true } } },
      'no reason': { moment: { ...ROW, reason: '' } },
      'a field a row does not take': { moment: { ...ROW, issue: 2 } },
      'a name __NTN_<name>__ cannot read': { 'not-a-name': ROW },
      "the build ID's own name": { BUILD_ID: ROW },
    };
    for (const [label, broken] of Object.entries(rows)) assert.deepEqual(fileProblems(file(broken)).map(({ code }) => code), ['define/file'], label);
    for (const shape of [null, [], { rows: { moment: ROW } }, { about: 'no rows' }, { about: 'rows as a list', rows: [] }]) {
      assert.deepEqual(fileProblems(shape).map(({ code }) => code), ['define/file'], JSON.stringify(shape));
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-define-allowlist-'));
    try {
      const missing = readAllowlist(dir);
      assert.deepEqual([missing.rows, missing.problems.map(({ code, subject, message }) => `${code} ${subject} ${message}`)], [{}, ['define/file build/define-allowlist.json is missing']]);
      fs.mkdirSync(path.join(dir, 'build'));
      fs.writeFileSync(path.join(dir, 'build', 'define-allowlist.json'), '{"rows": ');
      const unparsed = readAllowlist(dir);
      assert.deepEqual([unparsed.rows, unparsed.problems.map(({ code }) => code)], [{}, ['define/file']]);
      assert.match(unparsed.problems[0].message, /^doesn't parse/);
      fs.writeFileSync(path.join(dir, 'build', 'define-allowlist.json'), JSON.stringify(file({ moment: { ...ROW, owner: 0 } })));
      const malformed = readAllowlist(dir);
      assert.deepEqual([malformed.rows, malformed.problems.map(({ code }) => code)], [{}, ['define/file']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('define/unknown (#300)', () => {
  it('fails first-party code the bundle holds that reads an __NTN_ name with no row, and passes a row, the build ID, a binding of its own, a property and typeof', () => {
    const lines = [
      'export const a = __NTN_nope__;',
      'export const b = __NTN_moment__ && __NTN_BUILD_ID__;',
      'export function c() { const __NTN_nope__ = 1; return __NTN_nope__; }',
      'export const d = settings.__NTN_nope__ + typeof __NTN_other__;',
      'export const e = { __NTN_moment__, f: __NTN_moment };',
    ];
    const found = checkSourceEnvironment([{ file: 'js/a.js', text: lines.join('\n') }], { defineRows: { moment: ROW } });
    assert.deepEqual(found.map(({ code, subject }) => `${code} ${subject}`), [
      `define/unknown js/a.js:1:${lines[0].indexOf('__NTN_nope__') + 1}`,
      `define/unknown js/a.js:5:${lines[4].lastIndexOf('__NTN_moment') + 1}`,
    ]);
  });

  it("fails an __NTN_ name left in shipped first-party code, a row's included, which the build wrote no value in place of, and leaves the build ID to build/loader", () => {
    const lines = ['var a = __NTN_moment__;', 'var b = __NTN_nope__;', 'var c = __NTN_BUILD_ID__;', 'var d = self.__NTN_nope__;'];
    const shipped = packageOf({ 'js/classic.js': lines.join('\n'), 'js/lib/vendored.js': 'var e = __NTN_nope__;' });
    assert.deepEqual(checkEnvironment(shipped, { vendored: new Set(['js/lib/vendored.js']) }).map(({ code, subject }) => `${code} ${subject}`), [
      'define/unknown js/classic.js:1:9',
      'define/unknown js/classic.js:2:9',
    ]);
  });
});

describe('test/helpers/load-background.js (#300)', () => {
  it('starts the worker with every row of build/define-allowlist.json at its release value, as a release build inlines it', async () => {
    const rows = fileRows();
    const names = Object.keys(rows);
    const { loadBackground } = require('./helpers/load-background.js');
    const read = `\nglobalThis.ntnDefineRows = { ${names.map((name) => `${name}: __NTN_${name}__`).join(', ')} };\n`;
    const worker = await loadBackground({ start: false, rewrite: { 'js/background.js': (source) => source + read } });
    assert.deepEqual({ ...worker.env.global.ntnDefineRows }, Object.fromEntries(names.map((name) => [name, rows[name].release])));
  });
});
