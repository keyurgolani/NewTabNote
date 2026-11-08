'use strict';

// scripts/mutants.js on a small tree of its own: what it counts as killed, survived, stale,
// and invalid, that it fails the run for any but the first, that a named test failing before
// any mutant stops the run, that a signal stops it without leaving its scratch copy, and that
// it never changes the tree it reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadCatalog, named, occurrences, runTestFile } = require('../scripts/mutants.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'mutants.js');

const LIB = `'use strict';
exports.add = (a, b) => a + b;
exports.isPositive = (n) => n > 0;
exports.twice = (n) => n * 2;
`;

const LIB_TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { add, isPositive, twice } = require('./lib.js');
test('adds', () => assert.equal(add(2, 3), 5));
test('knows a positive number', () => assert.equal(isPositive(1), true));
test.describe('one', () => { test('doubles', () => assert.equal(twice(2), 4)); });
test.describe('two', () => { test('doubles', () => assert.equal(twice(3), 6)); });
`;

// A script loaded into a fresh vm context in each test, as test/helpers/legacy-env.js loads
// the legacy scripts, so a file that doesn't load fails every test, the named one included
const VM_LIB = `var add = (a, b) => a + b;
var isPositive = (n) => n > 0;
`;

const VM_TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const load = () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'vmlib.js'), 'utf8'), context);
  return context;
};
test('vm adds', () => assert.equal(load().add(2, 3), 5));
test('vm knows a positive number', () => assert.equal(load().isPositive(1), true));
`;

// Tests whose setup and bodies throw, so a names-only run that ran any of them fails them. Each
// file takes node:test's named exports, as a CommonJS module and as an ES module.
const BODIES = `before(() => { throw new Error('a setup hook ran'); });
beforeEach(() => { throw new Error('a setup hook ran'); });
it('throws', () => { throw new Error('a body ran'); });
describe('a suite', () => {
  it('throws too', () => { throw new Error('a body ran'); });
  it.skip('is skipped', () => { throw new Error('a body ran'); });
});
`;
const BODIES_CJS = `'use strict';\nconst { before, beforeEach, describe, it } = require('node:test');\n${BODIES}`;
const BODIES_ESM = `import { before, beforeEach, describe, it } from 'node:test';\n${BODIES}`;

/**
 * A mutant over vmlib.js
 * @param {string} id
 * @param {string} find
 * @param {string} replace
 */
const vmMutant = (id, find, replace) => ({
  id,
  behavior: 'arithmetic',
  protects: 'The script does its sums.',
  file: 'vmlib.js',
  find,
  replace,
  test: 'vm.test.js',
  name: 'vm adds',
});

/**
 * A mutant over lib.js
 * @param {string} id
 * @param {string} find
 * @param {string} replace
 * @param {string} name
 */
const mutant = (id, find, replace, name) => ({
  id,
  behavior: 'arithmetic',
  protects: 'The library does its sums.',
  file: 'lib.js',
  find,
  replace,
  test: 'lib.test.js',
  name,
});

/**
 * A scratch tree with lib.js, its test, and `catalog` as test/mutants/catalog.json
 * @param {object} catalog
 * @param {string} [testSource]
 * @returns {string}
 */
function tree(catalog, testSource = LIB_TEST) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-mutants-test-'));
  fs.writeFileSync(path.join(root, 'lib.js'), LIB);
  fs.writeFileSync(path.join(root, 'lib.test.js'), testSource);
  fs.writeFileSync(path.join(root, 'vmlib.js'), VM_LIB);
  fs.writeFileSync(path.join(root, 'vm.test.js'), VM_TEST);
  fs.mkdirSync(path.join(root, 'test', 'mutants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'mutants', 'catalog.json'), JSON.stringify(catalog));
  return root;
}

/**
 * @param {string} root
 * @returns {{status: number | null, report: any, stderr: string}}
 */
function run(root) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json'], { encoding: 'utf8' });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // No report: the run stopped, and stderr says why
  }
  return { status: result.status, report, stderr: result.stderr };
}

/**
 * Each mutant whose find doesn't occur exactly once in its file, as `id: count`. The run counts
 * such a mutant stale and never makes it, so the test that protects its behavior goes unchecked (#257).
 * @param {Array<{id: string, file: string, find: string}>} mutants
 * @param {string} root
 * @returns {string[]}
 */
const staleFinds = (mutants, root) =>
  mutants.flatMap((entry) => {
    const count = occurrences(fs.readFileSync(path.join(root, entry.file), 'utf8'), entry.find);
    return count === 1 ? [] : [`${entry.id}: ${count}`];
  });

/**
 * Each mutant whose name doesn't match exactly one test in its test file, as `id: count`, by the
 * run's own rule: its own name, or its suites' names and its own joined by ` > `. The run counts
 * such a mutant stale too. Each test file runs once with its tests registered and none of them
 * run, so this lists the names a run would, those a shared suite or a loop gives included (#257).
 * @param {Array<{id: string, test: string, name: string}>} mutants
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function staleNames(mutants, root) {
  const tests = new Map();
  for (const file of new Set(mutants.map((entry) => entry.test))) {
    const listed = await runTestFile(root, file, 120, { namesOnly: true });
    assert.equal(listed.timedOut, false, `${file} timed out with its tests registered and none run`);
    tests.set(file, listed.tests);
  }
  return mutants.flatMap((entry) => {
    const count = named(tests.get(entry.test), entry.name).length;
    return count === 1 ? [] : [`${entry.id}: ${count}`];
  });
}

test('kills a mutant its named test catches, and fails the run for one that survives, is stale, or is invalid', (t) => {
  const catalog = {
    pending: [{ behavior: 'sanitizer rules', protects: 'Pasted HTML loses its scripts.', waitsFor: 21 }],
    mutants: [
      mutant('killed', '(a, b) => a + b', '(a, b) => a - b', 'adds'),
      // knows a positive number only checks 1, so a boundary mutant lives
      mutant('survived', 'n > 0', 'n >= 0', 'knows a positive number'),
      mutant('missing-find', 'a * b', 'a / b', 'adds'),
      mutant('missing-test', '(a, b) => a + b', '(a, b) => b + a', 'subtracts'),
      mutant('ambiguous-test', 'n * 2', 'n * 3', 'doubles'),
      mutant('qualified-test', 'n * 2', 'n * 3', 'two > doubles'),
      // A file that doesn't parse proves nothing, whichever tests it fails
      mutant('load-error', "exports.isPositive = (n) => n > 0;", 'exports.isPositive = (n) => n >;', 'knows a positive number'),
      vmMutant('vm-killed', 'a + b', 'a - b'),
      vmMutant('vm-syntax-error', 'a + b;', 'a +;'),
      // It parses, but throws as it loads, so every test in the file fails
      vmMutant('vm-throws-at-load', 'var isPositive = (n) => n > 0;', "var isPositive = (n) => n > 0;\nthrow new Error('at load');"),
    ],
  };
  const root = tree(catalog);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { status, report, stderr } = run(root);
  assert.equal(status, 1, stderr);
  const statuses = Object.fromEntries(report.results.map((result) => [result.id, result.status]));
  assert.deepEqual(statuses, {
    killed: 'killed',
    survived: 'survived',
    'missing-find': 'stale',
    'missing-test': 'stale',
    'ambiguous-test': 'stale',
    'qualified-test': 'killed',
    'load-error': 'invalid',
    'vm-killed': 'killed',
    'vm-syntax-error': 'invalid',
    'vm-throws-at-load': 'invalid',
  });
  assert.deepEqual(report.summary, { mutants: 10, killed: 3, survived: 1, stale: 3, invalid: 3, pending: 1 });
  const reasons = Object.fromEntries(report.results.map((result) => [result.id, result.reason]));
  assert.match(reasons['load-error'], /^lib\.js doesn't parse with the mutant: /);
  assert.match(reasons['vm-syntax-error'], /^vmlib\.js doesn't parse with the mutant: /);
  assert.equal(reasons['vm-throws-at-load'], 'every test in vm.test.js failed, so the mutant broke its load');
  const killed = report.results.find((result) => result.id === 'killed');
  assert.deepEqual(killed.otherFailures, [], 'a kill records what else failed');
  assert.equal(fs.readFileSync(path.join(root, 'lib.js'), 'utf8'), LIB, 'the tree it read is as it was');
  assert.equal(fs.readFileSync(path.join(root, 'vmlib.js'), 'utf8'), VM_LIB);
  assert.deepEqual(fs.readdirSync(root).sort(), ['lib.js', 'lib.test.js', 'test', 'vm.test.js', 'vmlib.js']);
});

test('passes once every mutant is killed', (t) => {
  const root = tree({ mutants: [mutant('killed', '(a, b) => a + b', '(a, b) => a * b', 'adds')] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { status, report, stderr } = run(root);
  assert.equal(status, 0, stderr);
  assert.deepEqual(report.summary, { mutants: 1, killed: 1, survived: 0, stale: 0, invalid: 0, pending: 0 });
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`a ${signal} while a test file runs removes the scratch copy and exits ${code}`, async (t) => {
    const slow = LIB_TEST.replace("test('adds',", "test('waits', () => new Promise((resolve) => setTimeout(resolve, 30000)));\ntest('adds',");
    const root = tree({ mutants: [mutant('killed', '(a, b) => a + b', '(a, b) => a - b', 'adds')] }, slow);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-mutants-signal-'));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    });
    const child = spawn(process.execPath, [SCRIPT, '--root', root, '--json'], {
      env: { ...process.env, TMPDIR: temp },
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => child.on('exit', (status) => resolve(status)));
    // The scratch copy exists, and its baseline run has started
    const deadline = Date.now() + 15000;
    while (!fs.readdirSync(temp).some((entry) => entry.startsWith('ntn-mutants-'))) {
      assert.ok(Date.now() < deadline, 'the scratch copy never appeared');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill(signal);
    assert.equal(await exited, code);
    assert.deepEqual(fs.readdirSync(temp), [], 'no scratch copy left');
  });
}

test('stops when a named test fails before any mutant, since a kill would prove nothing', (t) => {
  const broken = LIB_TEST.replace('add(2, 3), 5', 'add(2, 3), 6');
  const root = tree({ mutants: [mutant('killed', '(a, b) => a + b', '(a, b) => a - b', 'adds')] }, broken);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { status, report, stderr } = run(root);
  assert.equal(status, 1);
  assert.equal(report, null);
  assert.match(stderr, /baseline: "adds" in lib\.test\.js fails without any mutant/);
});

test('refuses a catalog entry with a missing field, an unknown one, no change, a repeated id, or a path outside the tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-mutants-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'catalog.json');
  const good = mutant('one', 'a + b', 'a - b', 'adds');
  const cases = [
    [{ mutants: [{ ...good, name: '' }] }, /needs name/],
    [{ mutants: [{ ...good, suite: 'x' }] }, /unknown fields suite/],
    [{ mutants: [{ ...good, replace: good.find }] }, /changes nothing/],
    [{ mutants: [good, good] }, /listed twice/],
    [{ mutants: [{ ...good, file: '../lib.js' }] }, /file isn't a path inside the tree/],
    [{ mutants: [{ ...good, test: '/tmp/lib.test.js' }] }, /test isn't a path inside the tree/],
    [{ mutants: [], pending: [{ behavior: 'x', protects: 'y' }] }, /pending entry needs waitsFor/],
  ];
  for (const [catalog, problem] of cases) {
    fs.writeFileSync(file, JSON.stringify(catalog));
    assert.throws(() => loadCatalog(file, root), problem);
  }
  fs.writeFileSync(file, JSON.stringify({ mutants: [good] }));
  assert.equal(loadCatalog(file, root).mutants.length, 1);
});

test("the repository's catalog reads, and every behavior the approved test plan samples has a mutant or waits on its issue", () => {
  const root = path.join(__dirname, '..');
  const { mutants, pending } = loadCatalog(path.join(root, 'test', 'mutants', 'catalog.json'), root);
  // #28's approved test plan samples these
  const plan = ['commit waits', 'schema fields', 'backup inclusion', 'placeholder health', 'auth checks', 'sanitizer rules', 'conflict branches'];
  const covered = new Set([...mutants.map((entry) => entry.behavior), ...pending.map((entry) => entry.behavior)]);
  assert.deepEqual(plan.filter((behavior) => !covered.has(behavior)), []);
});

test("every mutant in the repository's catalog finds its text exactly once in its file (#257)", () => {
  const root = path.join(__dirname, '..');
  const { mutants } = loadCatalog(path.join(root, 'test', 'mutants', 'catalog.json'), root);
  assert.deepEqual(staleFinds(mutants, root), []);
});

test('reports a mutant whose find is missing from its file, and one whose find is there twice (#257)', (t) => {
  const root = tree({
    mutants: [
      mutant('once', '(a, b) => a + b', '(a, b) => a - b', 'adds'),
      mutant('missing', '(a, b) => a * b', '(a, b) => a / b', 'adds'),
      // `(n) => n` begins both isPositive and twice
      mutant('twice', '(n) => n', '(n) => -n', 'doubles'),
    ],
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { mutants } = loadCatalog(path.join(root, 'test', 'mutants', 'catalog.json'), root);
  assert.deepEqual(staleFinds(mutants, root), ['missing: 0', 'twice: 2']);
});

test("every mutant in the repository's catalog names exactly one test in its test file (#257)", async () => {
  const root = path.join(__dirname, '..');
  const { mutants } = loadCatalog(path.join(root, 'test', 'mutants', 'catalog.json'), root);
  assert.deepEqual(await staleNames(mutants, root), []);
});

test('reports a mutant whose test was renamed, and one whose name two tests share (#257)', async (t) => {
  const root = tree({
    mutants: [
      mutant('named', '(a, b) => a + b', '(a, b) => a - b', 'adds'),
      // Still the test's old name, as a rename of "adds" would leave it
      mutant('renamed', '(a, b) => a + b', '(a, b) => a - b', 'sums'),
      mutant('shared', 'n * 2', 'n * 3', 'doubles'),
      mutant('qualified', 'n * 2', 'n * 3', 'two > doubles'),
    ],
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { mutants } = loadCatalog(path.join(root, 'test', 'mutants', 'catalog.json'), root);
  assert.deepEqual(await staleNames(mutants, root), ['renamed: 0', 'shared: 2']);
});

test("lists a file's tests in a names-only run, and runs none of their bodies or setup hooks (#257)", async (t) => {
  const root = tree({ mutants: [] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'bodies.test.js'), BODIES_CJS);
  fs.writeFileSync(path.join(root, 'bodies.test.mjs'), BODIES_ESM);
  for (const file of ['bodies.test.js', 'bodies.test.mjs']) {
    const { tests } = await runTestFile(root, file, 60, { namesOnly: true });
    const listed = tests.map((entry) => [entry.path.join(' > '), entry.outcome, entry.skipped]);
    assert.deepEqual(listed, [['throws', 'pass', false], ['a suite > throws too', 'pass', false], ['a suite > is skipped', 'pass', true]], file);
  }
});

test('counts every occurrence of a find, overlapping ones too', () => {
  assert.equal(occurrences('abab', 'ab'), 2);
  assert.equal(occurrences('aaa', 'aa'), 2);
  assert.equal(occurrences('abc', 'd'), 0);
});
