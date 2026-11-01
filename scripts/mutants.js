#!/usr/bin/env node

/**
 * The mutation review (#28, AC4): proves each critical test fails when the behavior it
 * protects is broken. test/mutants/catalog.json lists mutants, each one exact edit to one
 * file and the test that has to fail once it's made. docs/testing.md says how to add one.
 *
 * It copies the tree to a scratch directory (node_modules is linked, not copied) and never
 * edits the working tree. Then:
 * 1. A mutant whose `find` doesn't occur exactly once in its file is stale.
 * 2. Each test file the mutants name runs once as it is, with the flags `npm test` uses. The
 *    run stops when a named test fails there, since a kill would prove nothing. A mutant
 *    whose test name isn't in its file, or is there more than once, is stale.
 * 3. Each mutant is applied in the scratch copy, its test file runs, and the file goes back.
 *    A mutated file that doesn't parse (`node --check`) is invalid, and its tests don't run.
 *    The mutant is killed when its named test fails, unless every test in the file failed:
 *    test/helpers/legacy-env.js loads the legacy scripts inside each test, so a mutant that
 *    makes one throw as it loads fails them all, and that's invalid too. It survived when its
 *    named test passes or doesn't run. What else failed is recorded either way.
 * A survived, stale, or invalid mutant fails the run. `pending` entries are behaviors waiting
 * on an issue, listed and not run. SIGINT and SIGTERM stop the run, remove the scratch copy
 * (unless --keep), and exit 130 and 143.
 *
 * It's slow, so `npm test` and CI don't run it. Run it when reviewing a test PR that touches
 * a protected behavior.
 *
 *   npm run test:mutants                         every mutant
 *   npm run test:mutants -- --only <id>          one mutant (repeatable)
 *   npm run test:mutants -- --json               the report as JSON on stdout
 *   npm run test:mutants -- --keep               leave the scratch copy, and print where it is
 *
 * --catalog <file> and --root <dir> point it at another catalog and tree (its own tests use
 * them). --timeout <seconds> bounds each test file's run (300 unless given); a run that
 * times out doesn't kill its mutant.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT_DIR = path.join(__dirname, '..');
const CATALOG = 'test/mutants/catalog.json';
const REPORTER = path.join(__dirname, 'lib', 'mutant-reporter.mjs');
// The element-assert guard npm test loads first (docs/testing.md), from this tree, since a scratch
// tree a test of this script makes has no test/helpers
const ELEMENT_GUARD = pathToFileURL(path.join(ROOT_DIR, 'test', 'helpers', 'element-assert-guard.mjs')).href;
const MARK = '@@mutant-result ';
const FIELDS = ['id', 'behavior', 'protects', 'file', 'find', 'replace', 'test', 'name'];
const PENDING_FIELDS = ['behavior', 'protects', 'waitsFor'];
// Not copied: history, dependencies (linked instead), and build and test output
const SKIP = new Set(['.git', 'node_modules', 'dist', 'releases', 'test-results', 'playwright-report', '.claude']);
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];

/**
 * @typedef {object} Mutant
 * @property {string} id
 * @property {string} behavior - the behavior it samples: the approved test plan's, or a gate's that protects one
 * @property {string} protects - the protected behavior, in a sentence
 * @property {string} file - the file it edits, from the root
 * @property {string} find - occurs exactly once in `file`
 * @property {string} replace
 * @property {string} test - the test file that has to fail, from the root
 * @property {string} name - the test in it that has to fail
 */

/** @typedef {'killed' | 'survived' | 'stale' | 'invalid'} Status */

/**
 * @typedef {{id: string, behavior: string, status: Status, reason?: string, otherFailures?: string[]}} Result
 */

/** @type {readonly Status[]} */
const STATUSES = ['killed', 'survived', 'stale', 'invalid'];

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { only: /** @type {string[]} */ ([]), json: false, keep: false, catalog: '', root: ROOT_DIR, timeout: 300 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--only') options.only.push(value());
    else if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--catalog') options.catalog = path.resolve(value());
    else if (arg === '--root') options.root = path.resolve(value());
    else if (arg === '--timeout') {
      options.timeout = Number(value());
      if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout takes seconds');
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.catalog) options.catalog = path.join(options.root, CATALOG);
  return options;
}

/**
 * The catalog, checked for shape: every field a string, ids unique, and paths inside the root
 * @param {string} file
 * @param {string} root
 * @returns {{mutants: Mutant[], pending: Array<Record<string, unknown>>}}
 */
function loadCatalog(file, root) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!catalog || !Array.isArray(catalog.mutants)) throw new Error(`${file}: no mutants list`);
  const pending = catalog.pending === undefined ? [] : catalog.pending;
  if (!Array.isArray(pending)) throw new Error(`${file}: pending isn't a list`);
  const ids = new Set();
  for (const mutant of catalog.mutants) {
    for (const field of FIELDS) {
      if (typeof mutant[field] !== 'string' || (field !== 'replace' && mutant[field] === '')) {
        throw new Error(`${file}: mutant ${mutant.id || '?'} needs ${field}`);
      }
    }
    const extra = Object.keys(mutant).filter(key => !FIELDS.includes(key));
    if (extra.length > 0) throw new Error(`${file}: mutant ${mutant.id} has unknown fields ${extra.join(', ')}`);
    if (mutant.find === mutant.replace) throw new Error(`${file}: mutant ${mutant.id} changes nothing`);
    if (ids.has(mutant.id)) throw new Error(`${file}: mutant ${mutant.id} is listed twice`);
    ids.add(mutant.id);
    for (const field of ['file', 'test']) {
      const resolved = path.resolve(root, mutant[field]);
      if (path.isAbsolute(mutant[field]) || !resolved.startsWith(root + path.sep)) {
        throw new Error(`${file}: mutant ${mutant.id}'s ${field} isn't a path inside the tree`);
      }
    }
  }
  for (const entry of pending) {
    for (const field of PENDING_FIELDS) {
      if (entry[field] === undefined || entry[field] === '') throw new Error(`${file}: a pending entry needs ${field}`);
    }
  }
  return { mutants: catalog.mutants, pending };
}

/**
 * How many times `find` occurs in `text`, overlapping ones included
 * @param {string} text
 * @param {string} find
 * @returns {number}
 */
function occurrences(text, find) {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) count++;
  return count;
}

/**
 * A copy of `root` in a new scratch directory, with node_modules linked
 * @param {string} root
 * @returns {string}
 */
function scratchCopy(root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-mutants-'));
  for (const entry of fs.readdirSync(root)) {
    if (SKIP.has(entry)) continue;
    fs.cpSync(path.join(root, entry), path.join(scratch, entry), {
      recursive: true,
      filter: source => !SKIP.has(path.basename(source)),
    });
  }
  const modules = path.join(root, 'node_modules');
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(scratch, 'node_modules'), 'dir');
  return scratch;
}

/** @typedef {{outcome: 'pass' | 'fail', name: string, path: string[], skipped: boolean}} TestRun */

/**
 * The test file running now, so a signal can stop it
 * @type {import('child_process').ChildProcess | null}
 */
let running = null;

/**
 * Runs one test file in `cwd` as `npm test` runs it, and reads what each test did. It runs
 * asynchronously, so a signal reaches this process while the file runs.
 * @param {string} cwd
 * @param {string} testFile
 * @param {number} timeoutSeconds
 * @returns {Promise<{tests: TestRun[], timedOut: boolean, status: number | null, output: string}>}
 */
function runTestFile(cwd, testFile, timeoutSeconds) {
  const env = { ...process.env };
  for (const name of PROXY_VARS) delete env[name];
  // Set when this runs under node --test itself, which would make the child report to it
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [`--import=${ELEMENT_GUARD}`, '--experimental-vm-modules', '--test', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', testFile],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    running = child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    child.on('error', error => {
      clearTimeout(timer);
      running = null;
      reject(error);
    });
    child.on('close', status => {
      clearTimeout(timer);
      running = null;
      const tests = stdout
        .split('\n')
        .filter(line => line.startsWith(MARK))
        .map(line => JSON.parse(line.slice(MARK.length)));
      resolve({ tests, timedOut, status, output: `${stdout}${stderr}` });
    });
  });
}

/**
 * Why `file` doesn't parse, or null when it does. JavaScript goes through `node --check`,
 * which reads a .js file as the nearest package.json's type says, and JSON through
 * JSON.parse. Anything else isn't checked.
 * @param {string} file
 * @returns {string | null}
 */
function parseFailure(file) {
  const extension = path.extname(file);
  if (extension === '.json') {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (!['.js', '.mjs', '.cjs'].includes(extension)) return null;
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status === 0) return null;
  const message = (check.stderr || '').split('\n').find(line => /Error/.test(line));
  return (message || `node --check exited ${check.status}`).trim();
}

/**
 * The tests `name` names: its own name, or its suites' names and its own joined by ` > `
 * where its own name alone isn't unique in its file
 * @param {TestRun[]} tests
 * @param {string} name
 */
const named = (tests, name) => tests.filter(test => test.name === name || test.path.join(' > ') === name);

/**
 * @param {ReturnType<typeof parseArgs>} options
 * @param {Mutant[]} mutants
 * @param {string} scratch - the scratch copy
 * @param {(line: string) => void} log
 * @returns {Promise<Result[]>}
 */
async function review(options, mutants, scratch, log) {
  /** @type {Map<string, Result>} */
  const results = new Map();
  const stale = (/** @type {Mutant} */ mutant, /** @type {string} */ reason) =>
    results.set(mutant.id, { id: mutant.id, behavior: mutant.behavior, status: 'stale', reason });

  for (const mutant of mutants) {
    const file = path.join(scratch, mutant.file);
    if (!fs.existsSync(file)) {
      stale(mutant, `${mutant.file} doesn't exist`);
      continue;
    }
    if (!fs.existsSync(path.join(scratch, mutant.test))) {
      stale(mutant, `${mutant.test} doesn't exist`);
      continue;
    }
    const count = occurrences(fs.readFileSync(file, 'utf8'), mutant.find);
    if (count !== 1) stale(mutant, `find occurs ${count} times in ${mutant.file}`);
  }

  // Each named test passes before any mutant is made
  const live = mutants.filter(mutant => !results.has(mutant.id));
  for (const testFile of [...new Set(live.map(mutant => mutant.test))]) {
    log(`baseline ${testFile}`);
    const run = await runTestFile(scratch, testFile, options.timeout);
    if (run.timedOut) throw new Error(`baseline: ${testFile} timed out without any mutant`);
    for (const mutant of live.filter(entry => entry.test === testFile)) {
      const found = named(run.tests, mutant.name);
      if (found.length !== 1) {
        stale(mutant, `${found.length} tests named "${mutant.name}" in ${testFile}`);
        continue;
      }
      if (found[0].skipped) {
        stale(mutant, `"${mutant.name}" is skipped in ${testFile}`);
        continue;
      }
      if (found[0].outcome !== 'pass') {
        throw new Error(`baseline: "${mutant.name}" in ${testFile} fails without any mutant\n${run.output.slice(-4000)}`);
      }
    }
  }

  for (const mutant of mutants) {
    if (results.has(mutant.id)) continue;
    const file = path.join(scratch, mutant.file);
    const original = fs.readFileSync(file, 'utf8');
    const at = original.indexOf(mutant.find);
    fs.writeFileSync(file, original.slice(0, at) + mutant.replace + original.slice(at + mutant.find.length));
    /** @type {string | null} */
    let unparsed = null;
    let run = null;
    try {
      unparsed = parseFailure(file);
      if (!unparsed) run = await runTestFile(scratch, mutant.test, options.timeout);
    } finally {
      fs.writeFileSync(file, original);
    }
    /** @type {Result} */
    const result = { id: mutant.id, behavior: mutant.behavior, status: 'survived' };
    if (!run) {
      result.status = 'invalid';
      result.reason = `${mutant.file} doesn't parse with the mutant: ${unparsed}`;
    } else {
      const found = named(run.tests, mutant.name);
      const ran = run.tests.filter(test => !test.skipped);
      result.otherFailures = run.tests
        .filter(test => test.outcome === 'fail' && !found.includes(test))
        .map(test => test.path.join(' > '));
      const namedFailed = found.length === 1 && found[0].outcome === 'fail';
      // A mutant that fails every test in the file broke its load, not the behavior it names
      if (namedFailed && ran.every(test => test.outcome === 'fail')) {
        result.status = 'invalid';
        result.reason = `every test in ${mutant.test} failed, so the mutant broke its load`;
      } else if (namedFailed) result.status = 'killed';
      else if (run.timedOut) result.reason = `${mutant.test} timed out after ${options.timeout} s`;
      else if (found.length === 0) result.reason = `"${mutant.name}" didn't run`;
      else result.reason = `"${mutant.name}" passed`;
    }
    results.set(mutant.id, result);
    log(`${result.status} ${mutant.id}${result.reason ? `: ${result.reason}` : ''}`);
  }
  return mutants.map(mutant => /** @type {Result} */ (results.get(mutant.id)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = options.json ? () => {} : (/** @type {string} */ line) => console.log(line);
  const { mutants: all, pending } = loadCatalog(options.catalog, options.root);
  const unknown = options.only.filter(id => !all.some(mutant => mutant.id === id));
  if (unknown.length > 0) throw new Error(`no mutant ${unknown.join(', ')} in the catalog`);
  const mutants = options.only.length > 0 ? all.filter(mutant => options.only.includes(mutant.id)) : all;

  const scratch = scratchCopy(options.root);
  // The scratch copy is this run's own, made above
  const cleanUp = () => {
    if (options.keep) console.error(`scratch copy kept at ${scratch}`);
    else fs.rmSync(scratch, { recursive: true, force: true });
  };
  /**
   * Stops the test file running, removes the scratch copy, and exits as a shell reports the signal
   * @param {NodeJS.Signals} signal
   * @param {number} code
   */
  const stop = (signal, code) => {
    if (running) running.kill(signal);
    cleanUp();
    process.exit(code);
  };
  const onInterrupt = () => stop('SIGINT', 130);
  const onTerminate = () => stop('SIGTERM', 143);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  /** @type {Result[]} */
  let results;
  try {
    results = await review(options, mutants, scratch, log);
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    cleanUp();
  }

  const count = (/** @type {Status} */ status) => results.filter(result => result.status === status).length;
  const summary = {
    mutants: results.length,
    ...Object.fromEntries(STATUSES.map(status => [status, count(status)])),
    pending: pending.length,
  };
  if (options.json) {
    console.log(JSON.stringify({ summary, results, pending }, null, 2));
  } else {
    /** @type {Map<string, Result[]>} */
    const byBehavior = new Map();
    for (const result of results) byBehavior.set(result.behavior, [...(byBehavior.get(result.behavior) || []), result]);
    log('');
    for (const [behavior, rows] of byBehavior) {
      log(`${behavior}: ${rows.length} mutants, ${rows.filter(row => row.status === 'killed').length} killed`);
    }
    for (const entry of pending) log(`pending: ${entry.behavior} (waits for #${entry.waitsFor})`);
    for (const result of results.filter(row => row.status !== 'killed')) {
      log(`${result.status.toUpperCase()} ${result.id}: ${result.reason}`);
      if (result.otherFailures && result.otherFailures.length > 0) {
        log(`  other tests failed: ${result.otherFailures.join('; ')}`);
      }
    }
    const collateral = results.filter(row => row.status === 'killed' && row.otherFailures && row.otherFailures.length > 0);
    if (collateral.length > 0) log(`${collateral.length} killed mutants also failed other tests in their file (--json lists them)`);
    log(`${summary.mutants} mutants: ${STATUSES.map(status => `${count(status)} ${status}`).join(', ')}, ${summary.pending} pending`);
  }
  return count('killed') === results.length ? 0 : 1;
}

if (require.main === module) {
  main().then(
    code => {
      process.exitCode = code;
    },
    error => {
      console.error(`mutants: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    },
  );
}

module.exports = { loadCatalog, occurrences, parseArgs };
