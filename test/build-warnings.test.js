'use strict';

// The warning allowlist (#300, from #27's AC1). A warning Vite or the bundler prints fails the
// build unless build/warning-allowlist.json has a row for it: in a production build, a chunk row
// for each chunk the bundler's chunk-size warning covers, which the build names by the bytes each
// pass wrote, since the warning names none; in either mode, a row holding any other warning's
// first line. A CSS warning fails whatever the rows say. The list only shrinks: a row whose warning
// doesn't come fails as build/warning-stale. The fixtures warning-stale, warning-chunk-size and
// warning-file (test/build-fixtures/) show the rules in a build, and bundler-warning one no row has.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'build', 'warning-allowlist.json');

/** scripts/build/warning-allowlist.js, required in each case that uses it */
const allowlist = () => require('../scripts/build/warning-allowlist.js');

/** The bundler's chunk-size warning, as its reporter words it: it names no chunk */
const CHUNK_SIZE = '\n(!) Some chunks are larger than 500 kB after minification. Consider:\n- Using dynamic import() to code-split the application';
/** The warning Vite prints for a page's classic script it can't bundle, the bundler-warning fixture's */
const CLASSIC = '<script src="js/x.js"> in "/popup.html" can\'t be bundled without type="module" attribute';
/** A stylesheet's warning, which fails the build as an error does */
const CSS = '[vite:css][lightningcss] Unknown pseudo-class: ntn-unknown\n  css/premium-chat.css:900:13';
/** What a production build's pages pass wrote: the workspace chunk over 500 kB, and two chunks not */
const WRITTEN = Object.freeze([{ pass: 'pages', name: 'workspace', bytes: 591069 }, { pass: 'pages', name: 'host', bytes: 55942 }, { pass: 'pages', name: 'edge', bytes: 500000 }]);

const ROW = Object.freeze({ owner: 3, reason: 'why it stays, and what removes it' });

/**
 * checkWarnings over `warnings`, each printed by the pass `passes` names (the pages pass's by
 * default), with `chunks` and `rows` as the list's two kinds of row, in a build whose passes all ran
 * unless `complete` says otherwise
 * @param {string[]} warnings
 * @param {{chunks?: object, rows?: object[], mode?: string, complete?: boolean, written?: readonly object[], passes?: string[]}} [build]
 */
function check(warnings, { chunks = {}, rows = [], mode = 'production', complete = true, written = WRITTEN, passes = warnings.map(() => 'pages') } = {}) {
  const found = allowlist().checkWarnings(warnings, { chunks, warnings: rows }, { mode, complete, chunks: written, passes });
  return { ...found, problems: found.problems.map(({ code, subject }) => `${code} ${subject}`) };
}

describe('build/warning-allowlist.json (#300)', () => {
  it("passes a warning whose first line a row holds exactly, and leaves any other, and a stylesheet's whatever the rows say, to fail", () => {
    const row = { ...ROW, warning: CLASSIC };
    assert.deepEqual(check([CLASSIC], { rows: [row] }), { unlisted: [], allowed: [`"${CLASSIC}" (#3)`], problems: [] });
    assert.deepEqual(check([CLASSIC]), { unlisted: [CLASSIC], allowed: [], problems: [] });
    const other = CLASSIC.replace('js/x.js', 'js/y.js');
    assert.deepEqual(check([other, CLASSIC], { rows: [row] }).unlisted, [other]);
    // The row holds the first line, so the lines under it can differ, and holds it exactly, so a
    // first line that starts with the row's text, or a warning that holds it lower down, is another
    const below = [`${CLASSIC}\n  at popup.html:12`, `${CLASSIC}\n  at popup.html:40`];
    assert.deepEqual(check(below, { rows: [row] }), { unlisted: [], allowed: [`"${CLASSIC}" (#3)`], problems: [] });
    const near = [`${CLASSIC} again`, `PLUGIN_WARNING: another one\n${CLASSIC}`];
    assert.deepEqual(check(near, { rows: [row] }), { unlisted: near, allowed: [], problems: ['build/warning-stale build/warning-allowlist.json'] });
    // A CSS warning fails as build/css (scripts/build/bundle.js's warningProblem), so its row matches nothing
    assert.deepEqual(check([CSS], { rows: [{ ...ROW, warning: CSS.split('\n')[0] }] }), { unlisted: [CSS], allowed: [], problems: ['build/warning-stale build/warning-allowlist.json'] });
    assert.match(allowlist().CSS_WARNING.source, /lightningcss/);
  });

  it('fails a row whose warning no pass printed as build/warning-stale once every pass has run, and no row when a pass threw, since its warnings never came', () => {
    const rows = [{ ...ROW, warning: CLASSIC }];
    for (const mode of ['production', 'development']) {
      assert.deepEqual(check([], { rows, mode }).problems, ['build/warning-stale build/warning-allowlist.json'], mode);
      assert.deepEqual(check([], { rows, mode, complete: false }).problems, [], mode);
    }
    const [stale] = allowlist().checkWarnings([], { chunks: {}, warnings: rows }, { mode: 'production', complete: true, chunks: [], passes: [] }).problems;
    assert.match(stale.message, /only shrinks/);
  });

  it("names each chunk a pass wrote over the limit the chunk-size warning states, by its bytes: one with a row passes, one without fails as build/bundler-warning at its name, and a row for a chunk at or under the limit is stale", () => {
    assert.deepEqual(check([CHUNK_SIZE], { chunks: { workspace: ROW } }), {
      unlisted: [],
      allowed: ['"(!) Some chunks are larger than 500 kB after minification. Consider:" for the workspace chunk, 591069 bytes (#3)'],
      problems: [],
    });
    const unrowed = allowlist().checkWarnings([CHUNK_SIZE], { chunks: {}, warnings: [] }, { mode: 'production', complete: true, chunks: WRITTEN, passes: ['pages'] }).problems;
    assert.deepEqual(unrowed.map(({ code, subject }) => `${code} ${subject}`), ['build/bundler-warning workspace']);
    assert.match(unrowed[0].message, /591069 bytes, over the bundler's 500 kB chunk-size limit/);
    // Over 500 kB is over 500,000 bytes, the bundler's measure, so the edge chunk isn't
    assert.deepEqual(check([CHUNK_SIZE], { chunks: { workspace: ROW, host: ROW, edge: ROW } }).problems, ['build/warning-stale build/warning-allowlist.json', 'build/warning-stale build/warning-allowlist.json']);
    // and a kB is 1,000 bytes, as the bundler counts, so 500,001 bytes are over, under 500 KiB as they are
    const margin = [...WRITTEN, { pass: 'pages', name: 'margin', bytes: 500001 }];
    assert.deepEqual(check([CHUNK_SIZE], { chunks: { workspace: ROW }, written: margin }).problems, ['build/bundler-warning margin']);
    // The limit is the one the warning states
    assert.deepEqual(check([CHUNK_SIZE.replace('500 kB', '400 kB')], { chunks: { workspace: ROW } }).problems, ['build/bundler-warning edge']);
  });

  it("fails the chunk-size warning when no chunk a pass wrote is over its limit, and every chunk row when the warning doesn't come, as with its switch off again", () => {
    assert.deepEqual(check([CHUNK_SIZE.replace('500 kB', '600 kB')]).problems, ['build/bundler-warning the bundle']);
    const [stale] = allowlist().checkWarnings([], { chunks: { workspace: ROW }, warnings: [] }, { mode: 'production', complete: true, chunks: WRITTEN, passes: [] }).problems;
    assert.deepEqual([stale.code, stale.subject], ['build/warning-stale', 'build/warning-allowlist.json']);
    assert.match(stale.message, /workspace chunk/);
  });

  it("checks no chunk row in build:dev, whose passes the bundler doesn't measure since they aren't minified, nor in a build whose pass threw", () => {
    const written = [{ pass: 'pages', name: 'workspace', bytes: 1800000 }];
    assert.deepEqual(check([], { chunks: { workspace: ROW }, mode: 'development', written }), { unlisted: [], allowed: [], problems: [] });
    // A chunk-size warning build:dev never gives isn't one a chunk row covers
    assert.deepEqual(check([CHUNK_SIZE], { chunks: { workspace: ROW }, mode: 'development', written }).unlisted, [CHUNK_SIZE]);
    assert.deepEqual(check([CHUNK_SIZE], { complete: false, written: [] }), { unlisted: [], allowed: [], problems: [] });
  });

  it("ties each pass's chunk-size warning to that pass's own chunks, so another pass's chunk can't answer for it (#321's review)", () => {
    // recovery.html's pass warns, and only the pages pass has a chunk over the limit
    const written = [...WRITTEN, { pass: 'recovery', name: 'recovery', bytes: 284351 }];
    assert.deepEqual(check([CHUNK_SIZE], { chunks: { workspace: ROW }, written, passes: ['recovery'] }).problems, ['build/bundler-warning the bundle', 'build/warning-stale build/warning-allowlist.json']);
    // Each pass that warns answers for its own chunks over the limit
    const both = [...written, { pass: 'recovery', name: 'big', bytes: 600000 }];
    assert.deepEqual(check([CHUNK_SIZE, CHUNK_SIZE], { chunks: { workspace: ROW }, written: both, passes: ['pages', 'recovery'] }).problems, ['build/bundler-warning big']);
  });

  it("fails two chunks over the limit that share a name, since one row would stand for both (#321's review)", () => {
    const written = [{ pass: 'pages', name: 'blocks', bytes: 520000 }, { pass: 'recovery', name: 'blocks', bytes: 530000 }];
    const found = check([CHUNK_SIZE, CHUNK_SIZE], { chunks: { blocks: ROW }, written, passes: ['pages', 'recovery'] });
    assert.deepEqual([found.problems, found.allowed], [['build/bundler-warning blocks'], []]);
  });

  it("reads the chunk-size warning by its own first line, so another warning that quotes it below that line is matched and reported as itself (#321's review)", () => {
    const quoting = 'PLUGIN_WARNING: a plugin warns about its own input\n  it quotes: (!) Some chunks are larger than 500 kB after minification. Consider:';
    assert.deepEqual(check([quoting], { written: [] }).unlisted, [quoting]);
    // A plugin's tag ahead of the reporter's text leaves it the chunk-size warning
    assert.deepEqual(check([`[plugin builtin:vite-reporter]${CHUNK_SIZE}`], { chunks: { workspace: ROW } }).problems, []);
  });

  it("fails a file that is missing, doesn't parse, or has a row with no owner, no reason, no single first line or a field it doesn't take, each as build/warning-file", () => {
    const { fileProblems, readAllowlist } = allowlist();
    const file = (chunks = {}, warnings = []) => ({ about: 'what the rows are', chunks, warnings });
    assert.deepEqual(fileProblems(file({ workspace: ROW }, [{ ...ROW, warning: CLASSIC }])), []);
    const broken = {
      'a chunk row with no owner': file({ workspace: { ...ROW, owner: undefined } }),
      'an owner that is no issue number': file({ workspace: { ...ROW, owner: '#3' } }),
      'no reason': file({ workspace: { ...ROW, reason: '' } }),
      'a field a chunk row does not take': file({ workspace: { ...ROW, warning: CLASSIC } }),
      'a warning row with no warning': file({}, [ROW]),
      'a warning of two lines': file({}, [{ ...ROW, warning: CSS }]),
      'one warning in two rows': file({}, [{ ...ROW, warning: CLASSIC }, { ...ROW, warning: CLASSIC }]),
      'a field a warning row does not take': file({}, [{ ...ROW, warning: CLASSIC, count: 1 }]),
      'no about text': { chunks: {}, warnings: [] },
      'a field the list does not take': { ...file(), rows: {} },
    };
    for (const [label, shape] of Object.entries(broken)) assert.deepEqual(fileProblems(shape).map(({ code }) => code), ['build/warning-file'], label);
    for (const shape of [null, [], { about: 'no rows' }, { about: 'chunks as a list', chunks: [], warnings: [] }, { about: 'warnings as an object', chunks: {}, warnings: {} }]) {
      assert.deepEqual(fileProblems(shape).map(({ code }) => code), ['build/warning-file'], JSON.stringify(shape));
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-warning-allowlist-'));
    try {
      const none = { chunks: {}, warnings: [] };
      const missing = readAllowlist(dir);
      assert.deepEqual([missing.allowlist, missing.problems.map(({ code, subject, message }) => `${code} ${subject} ${message}`)], [none, ['build/warning-file build/warning-allowlist.json is missing']]);
      fs.mkdirSync(path.join(dir, 'build'));
      fs.writeFileSync(path.join(dir, 'build', 'warning-allowlist.json'), '{"chunks": ');
      const unparsed = readAllowlist(dir);
      assert.deepEqual([unparsed.allowlist, unparsed.problems.map(({ code }) => code)], [none, ['build/warning-file']]);
      assert.match(unparsed.problems[0].message, /^doesn't parse/);
      fs.writeFileSync(path.join(dir, 'build', 'warning-allowlist.json'), JSON.stringify(file({ workspace: { ...ROW, owner: 0 } })));
      const malformed = readAllowlist(dir);
      assert.deepEqual([malformed.allowlist, malformed.problems.map(({ code }) => code)], [none, ['build/warning-file']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds the workspace chunk's row, #3's, and nothing else, so the list only shrinks, reads with no problem, and names the timing check that stays off in code", () => {
    const text = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.deepEqual(Object.keys(text.chunks), ['workspace'], 'build/warning-allowlist.json has a new chunk row; the list only shrinks');
    assert.deepEqual(text.warnings, [], 'build/warning-allowlist.json has a warning row; the list only shrinks');
    assert.equal(text.chunks.workspace.owner, 3);
    assert.match(text.chunks.workspace.reason, /#2's Moment/);
    assert.match(text.about, /bundlerTimings/);
    const read = allowlist().readAllowlist();
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.allowlist, { chunks: text.chunks, warnings: text.warnings });
  });
});
