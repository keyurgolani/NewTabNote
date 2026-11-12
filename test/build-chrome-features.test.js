'use strict';

// The Chrome features table (#300, from #27's Toolchain and AC10). build/chrome-features.json lists
// each Chrome API and web feature first-party code uses, with the first Chrome version that has it
// and the public page that says so. The build scans the sources for each chrome.* member, listed web
// global and listed CSS at-rule: a hit with no row fails as chrome/feature, a row above
// manifest.json's minimum_chrome_version as chrome/version, and a table that doesn't read as
// chrome/file. The bundler's target is the highest row (test/bundler.test.js). The fixtures
// chrome-feature-unlisted, chrome-feature-above-minimum and chrome-features-file show the rules in a
// build.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanScript } = require('../scripts/build/js-scan.js');

const ROOT = path.join(__dirname, '..');

/** scripts/build/chrome-features.js, required in each case that uses it */
const features = () => require('../scripts/build/chrome-features.js');

/** The table's rows, read without the module under test */
const tableRows = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'chrome-features.json'), 'utf8')).rows;

/** A row that reads as one */
const ROW = Object.freeze({ version: 88, source: 'https://developer.chrome.com/docs/extensions/reference/api/action' });

/**
 * The features a script reads, as `name line:column`
 * @param {string} text
 */
const read = (text) => (scanScript('js/a.js', text).features || []).map(({ name, at }) => `${name} ${at}`);

describe('build/chrome-features.json (#300)', () => {
  it("has a row for each feature next's first-party sources read and no other, each with its first Chrome version and the public page that says so", () => {
    const rows = tableRows();
    const { firstPartySources, featuresOf, versionProblems } = features();
    assert.deepEqual(Object.keys(featuresOf(firstPartySources())).sort(), Object.keys(rows).sort());
    for (const [name, row] of Object.entries(rows)) {
      assert.ok(Number.isSafeInteger(row.version) && row.version > 0, name);
      assert.match(row.source, /^https:\/\/(developer\.chrome\.com|developer\.mozilla\.org)\//, name);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    assert.deepEqual(versionProblems(manifest.minimum_chrome_version, rows), []);
  });
});

describe('the Chrome features scan (#300)', () => {
  it('reads chrome, its namespace and the member read in it, through the global object too, an event as itself, and chrome read whole as chrome', () => {
    assert.deepEqual(read([
      'chrome.storage.local.get(["k"]);',
      'chrome.runtime.onMessage.addListener(() => {});',
      'globalThis.chrome.sidePanel.open({ windowId: 1 });',
      'const area = chrome.storage;',
      'if (typeof chrome === "undefined") throw new Error("no chrome");',
      'const { tabs } = chrome;',
      'export function own(chrome) { return chrome.alarms.create("a"); }',
      // An && operand but the last only checks that chrome is there
      'const runtime = globalThis.chrome && globalThis.chrome.runtime;',
      'export const all = ok && chrome;',
    ].join('\n')), ['chrome.storage.local 1:1', 'chrome.runtime.onMessage 2:1', 'chrome.sidePanel.open 3:1', 'chrome.storage 4:14', 'chrome 6:18', 'chrome.runtime 8:38', 'chrome 9:26']);
  });

  it('reads each listed web global, as a free name or through the global object, and leaves alone a property of another object, a binding of its own and typeof', () => {
    assert.deepEqual(read([
      'navigator.locks.request("x", () => {});',
      'self.crypto.randomUUID();',
      'const copy = structuredClone(value);',
      'window.documentPictureInPicture.requestWindow();',
      'const segments = new Intl.Segmenter("en");',
      'settings.navigator.locks.request();',
      'export function own(structuredClone) { return structuredClone(1); }',
      'if (typeof structuredClone === "function") {}',
      'const Segmenter = /** @type {any} */ (Intl).Segmenter;',
    ].join('\n')), ['navigator.locks 1:1', 'crypto.randomUUID 2:1', 'structuredClone 3:14', 'documentPictureInPicture 4:1', 'Intl.Segmenter 5:22', 'Intl.Segmenter 9:39']);
  });

  it('reads each listed CSS at-rule from a stylesheet, and no other at-rule', () => {
    const css = '@property --x { syntax: "<length>"; inherits: false; initial-value: 0px; }\n@media (min-width: 1px) { a { color: red; } }\n.c { container-type: inline-size; }\n@container (min-width: 10px) { a { color: blue; } }\n';
    assert.deepEqual(features().featuresOf([{ file: 'css/a.css', text: css }]), { '@property': ['css/a.css:1'], '@container': ['css/a.css:4'] });
  });

  it('fails a feature with no row as chrome/feature, once, at its first read, and passes one with a row', () => {
    const sources = [
      { file: 'js/a.js', text: 'chrome.tabs.query({});\nchrome.alarms.create("a");' },
      { file: 'js/b.js', text: 'chrome.alarms.create("b");\nconst { tabs } = chrome;' },
    ];
    const found = features().checkChromeFeatures(sources, { 'chrome.tabs.query': ROW });
    assert.deepEqual(found.map(({ code, subject }) => `${code} ${subject}`), ['chrome/feature js/b.js:2:18', 'chrome/feature js/a.js:2:1']);
  });

  it("fails a row above manifest.json's minimum_chrome_version as chrome/version, and leaves a minimum that isn't a whole number to build/manifest", () => {
    const { versionProblems, highestVersion } = features();
    const rows = { 'chrome.a.b': { ...ROW, version: 116 }, 'chrome.c.d': { ...ROW, version: 117 }, '@scope': { ...ROW, version: 118 } };
    assert.deepEqual(versionProblems('116', rows).map(({ code, subject }) => `${code} ${subject}`), ['chrome/version @scope', 'chrome/version chrome.c.d']);
    assert.deepEqual(versionProblems('118', rows), []);
    for (const minimum of [undefined, '', 'x', '116.0']) assert.deepEqual(versionProblems(minimum, rows), [], String(minimum));
    assert.deepEqual([highestVersion(rows), highestVersion({})], [118, 0]);
  });

  it('fails a row with no whole-number version or no public page, and a table that is missing, does not parse or has no rows, each as chrome/file', () => {
    const { tableProblems, readTable } = features();
    const table = (/** @type {object} */ rows) => ({ about: 'what the rows are', rows });
    assert.deepEqual(tableProblems(table({ 'chrome.a.b': ROW })), []);
    const broken = {
      'no version': { 'chrome.a.b': { source: ROW.source } },
      'a version as text': { 'chrome.a.b': { ...ROW, version: '88' } },
      'a version of zero': { 'chrome.a.b': { ...ROW, version: 0 } },
      'no source': { 'chrome.a.b': { version: 88 } },
      'a source that is no public docs page': { 'chrome.a.b': { ...ROW, source: 'http://example.com/a' } },
      'a field a row does not take': { 'chrome.a.b': { ...ROW, notes: 'x' } },
    };
    for (const [label, rows] of Object.entries(broken)) assert.deepEqual(tableProblems(table(rows)).map(({ code }) => code), ['chrome/file'], label);
    for (const shape of [null, [], { rows: { 'chrome.a.b': ROW } }, { about: 'no rows' }]) {
      assert.deepEqual(tableProblems(shape).map(({ code }) => code), ['chrome/file'], JSON.stringify(shape));
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-chrome-features-'));
    try {
      assert.deepEqual(readTable(dir).problems.map(({ code, subject, message }) => `${code} ${subject} ${message}`), ['chrome/file build/chrome-features.json is missing']);
      fs.mkdirSync(path.join(dir, 'build'));
      fs.writeFileSync(path.join(dir, 'build', 'chrome-features.json'), '{"rows": ');
      const unparsed = readTable(dir);
      assert.deepEqual([unparsed.rows, unparsed.problems.map(({ code }) => code)], [{}, ['chrome/file']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
