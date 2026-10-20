'use strict';

// test/known-defects.json and the expected failures match both ways: each test the ledger
// lists exists as an expected failure, and each expected failure is listed under the id its
// title carries. Harness tests come from Playwright's listing, which needs no browser, and
// node tests from the expectFailure() calls in test/.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadKnownDefects } = require('../e2e/harness/known-defects.js');
const { runExpectedFailure } = require('./helpers/expect-failure.js');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = __dirname;
const ID = /\bKD-\d{3}\b/;
// An expectFailure( call whose title is a string literal that starts with a ledger id
const NODE_CALL = /\bexpectFailure\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`)/g;

/**
 * Every harness test as { title, file, expectedFailure }, from
 * `playwright test --list --reporter=json -c e2e/playwright.config.js`. A test declared
 * with test.fail(title, body) carries a `fail` annotation before it runs.
 */
function harnessTests() {
  const cli = require.resolve('@playwright/test/cli');
  const output = execFileSync(process.execPath, [cli, 'test', '--list', '--reporter=json', '-c', 'e2e/playwright.config.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(output);
  if (report.errors.length > 0) {
    throw new Error(`playwright test --list reported errors:\n${report.errors.map(error => error.message).join('\n')}`);
  }
  const tests = [];
  const walk = suite => {
    for (const spec of suite.specs || []) {
      tests.push({
        title: spec.title,
        file: path.posix.join('e2e', spec.file),
        expectedFailure: spec.tests.some(run => run.annotations.some(annotation => annotation.type === 'fail')),
      });
    }
    (suite.suites || []).forEach(walk);
  };
  report.suites.forEach(walk);
  return tests;
}

/**
 * Every expectFailure() call under test/ whose title is a literal starting with an id, as
 * { title, file }
 */
function nodeExpectedFailures(dir = TEST_DIR) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...nodeExpectedFailures(file));
    } else if (entry.name.endsWith('.js')) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(NODE_CALL)) {
        const literal = [match[1], match[2], match[3]].find(group => group !== undefined);
        const title = literal.replace(/\\(.)/gs, '$1');
        if (/^KD-\d{3}\b/.test(title)) found.push({ title, file: path.relative(ROOT, file) });
      }
    }
  }
  return found;
}

const defects = loadKnownDefects();
const harness = harnessTests();
const node = nodeExpectedFailures();

test('each test the ledger lists is one expected failure: a harness test.fail() or a node expectFailure()', () => {
  const problems = [];
  for (const { id, tests } of defects) {
    // An entry with no tests only lists uncaught messages, which smoke checks
    for (const title of tests) {
      const matches = [...harness.filter(t => t.title === title), ...node.filter(t => t.title === title)];
      if (matches.length === 0) {
        problems.push(`${id}: no harness test or expectFailure() call is titled "${title}"`);
      } else if (matches.length > 1) {
        problems.push(`${id}: ${matches.length} tests are titled "${title}" (${matches.map(t => t.file).join(', ')})`);
      } else if (matches[0].expectedFailure === false) {
        problems.push(`${id}: "${title}" (${matches[0].file}) has to be declared with test.fail(title, body)`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('each harness test.fail() and each test carrying an id is listed under that id', () => {
  const listedAs = new Map(defects.flatMap(({ id, tests }) => tests.map(title => [title, id])));
  const problems = [];
  for (const { title, file, expectedFailure } of [...harness, ...node]) {
    const carried = ID.exec(title);
    if (!carried) {
      if (expectedFailure) problems.push(`${file}: "${title}" is expected to fail but carries no ledger id; add a test/known-defects.json entry and put its id in the title`);
      continue;
    }
    if (listedAs.get(title) !== carried[0]) {
      problems.push(`${file}: "${title}" isn't listed under ${carried[0]} in test/known-defects.json`);
    } else if (expectedFailure === false) {
      problems.push(`${file}: "${title}" carries ${carried[0]} but isn't declared with test.fail(title, body)`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the scans find the expected failures in both tiers', () => {
  // Guards the scans themselves: an empty listing would let every check above pass
  assert.ok(harness.length > 0, 'playwright test --list listed no harness tests');
  const listed = defects.flatMap(({ tests }) => tests);
  assert.ok(listed.length > 0, 'the ledger lists no tests');
  assert.ok(listed.every(title => harness.some(t => t.title === title) || node.some(t => t.title === title)));
});

test('the node scan reads single-, double-, and back-quoted titles, escapes included', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ntn-known-defects-scan-'));
  try {
    // CALL stands in for the helper's name, so the scan of this file doesn't find these
    const source = [
      "CALL('KD-901 single \\'quoted\\'', () => {});",
      'CALL("KD-902 double \\"quoted\\" today\'s", () => {});',
      'CALL(`KD-903 back-quoted`, () => {});',
      'CALL(`KD-904 ${"template"}`, () => {});',
      "CALL('not a ledger title', () => {});",
      'function CALL(title, body) {}',
    ].join('\n').replaceAll('CALL', 'expectFailure');
    fs.writeFileSync(path.join(dir, 'sample.test.js'), source);
    assert.deepEqual(nodeExpectedFailures(dir).map(t => t.title), [
      "KD-901 single 'quoted'",
      'KD-902 double "quoted" today\'s',
      'KD-903 back-quoted',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('expectFailure() passes on a failed assertion, and fails when the step passes or throws anything else', async () => {
  assert.equal(await runExpectedFailure('KD-900', () => assert.equal(1, 2)), 'Expected values to be strictly equal: got 1');
  await assert.rejects(runExpectedFailure('KD-900', () => {}), {
    name: 'AssertionError',
    message: /^KD-900 passed, so its defect looks fixed: delete its entry from test\/known-defects.json/,
  });
  await assert.rejects(runExpectedFailure('KD-900', async () => { throw new TypeError('broken step'); }), { name: 'TypeError', message: 'broken step' });
});
