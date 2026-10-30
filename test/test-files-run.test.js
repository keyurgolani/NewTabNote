'use strict';

// Every *.test.js and *.test.mjs file under test/ is run by an npm script that
// .github/workflows/pr-checks.yml runs, through node --test. A test file no such script's glob
// reaches (one in a new subfolder, or with an extension the globs leave out) would never run
// in CI, and its tests would count as evidence nobody collected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_FILE = /\.test\.m?js$/;

/**
 * A shell glob as a RegExp over a path relative to the root: `*` and `?` stay within one
 * folder, `**` spans folders, and `{a,b}` is either.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      // `**/` is any number of folders, none included
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:[^/]+/)*' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) throw new Error(`unclosed { in ${glob}`);
      source += `(?:${glob.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * The npm scripts a workflow runs: each `npm test` and `npm run <name>` in it, and the
 * scripts those run in turn
 * @param {string} workflow - The workflow file's text
 * @param {Object<string, string>} scripts - package.json's scripts
 * @returns {string[]}
 */
function scriptsRunBy(workflow, scripts) {
  const named = (text) => [...text.matchAll(/\bnpm (?:test\b|run ([\w:.-]+))/g)].map(([, name]) => name || 'test');
  const found = new Set();
  const pending = named(workflow);
  while (pending.length > 0) {
    const name = pending.shift();
    if (found.has(name) || !(name in scripts)) continue;
    found.add(name);
    pending.push(...named(scripts[name]));
  }
  return [...found];
}

/**
 * The test paths and globs each of `names` hands a test runner (`node --test`): the words of
 * its command that name a path under test/. A script that runs no test runner, a formatter
 * over test/ say, runs no test file.
 * @param {Object<string, string>} scripts
 * @param {string[]} [names] - The scripts to read, all of them unless given
 * @returns {Array<{script: string, glob: string}>}
 */
function scriptGlobs(scripts, names = Object.keys(scripts)) {
  return names
    .filter((script) => /\bnode\b[^&|;]*\s--test\b/.test(scripts[script]))
    .flatMap((script) => scripts[script]
      .split(/\s+/)
      .map((word) => word.replace(/^['"]|['"]$/g, ''))
      .filter((word) => /^(\.\/)?test\//.test(word))
      .map((word) => ({ script, glob: word.replace(/^\.\//, '') })));
}

/**
 * Every test file under `dir`, relative to the root, with / between folders
 * @param {string} dir
 * @returns {string[]}
 */
function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return TEST_FILE.test(entry.name) ? [path.relative(ROOT, full).split(path.sep).join('/')] : [];
  });
}

/**
 * The test files no glob matches
 * @param {string[]} files
 * @param {Array<{glob: string}>} globs
 */
function unrun(files, globs) {
  const patterns = globs.map(({ glob }) => globToRegExp(glob));
  return files.filter((file) => !patterns.some((pattern) => pattern.test(file)));
}

const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PR_CHECKS = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pr-checks.yml'), 'utf8');

test('every test file under test/ is run by an npm script the PR checks run', () => {
  const files = testFiles(path.join(ROOT, 'test'));
  const ran = scriptsRunBy(PR_CHECKS, scripts);
  const globs = scriptGlobs(scripts, ran);
  // Guards the scan: an empty list would let the check pass
  assert.ok(files.length > 0, 'found no test files under test/');
  assert.ok(ran.includes('test'), 'the PR checks run no npm test');
  assert.ok(globs.some(({ script }) => script === 'test'), 'npm test passes no test globs');
  assert.ok(files.includes('test/test-files-run.test.js'), 'the scan missed this file');
  assert.deepEqual(unrun(files, globs), [], `none of ${ran.join(', ')} runs these; add them to one, or move them where one does`);
});

test('the globs match as the shell does', () => {
  const matches = (glob, file) => globToRegExp(glob).test(file);
  assert.equal(matches('test/*.test.js', 'test/a.test.js'), true);
  assert.equal(matches('test/*.test.js', 'test/kernel/a.test.js'), false, '* stays in its folder');
  assert.equal(matches('test/*.test.js', 'test/a.test.mjs'), false);
  assert.equal(matches('test/kernel/*.test.mjs', 'test/kernel/a.test.mjs'), true);
  assert.equal(matches('test/**/*.test.js', 'test/a.test.js'), true, '**/ includes no folder');
  assert.equal(matches('test/**/*.test.js', 'test/x/y/a.test.js'), true);
  assert.equal(matches('test/*.test.{js,mjs}', 'test/a.test.mjs'), true);
  assert.equal(matches('test/?.test.js', 'test/ab.test.js'), false);
  assert.equal(matches('test/a.test.js', 'test/aXtest.js'), false, 'a dot is a dot');
});

test('a test file in a folder no glob reaches is reported', () => {
  const globs = scriptGlobs({
    test: 'node --test test/*.test.js "test/kernel/*.test.mjs"',
    lint: 'eslint js',
  });
  assert.deepEqual(globs, [{ script: 'test', glob: 'test/*.test.js' }, { script: 'test', glob: 'test/kernel/*.test.mjs' }]);
  const files = ['test/a.test.js', 'test/kernel/b.test.mjs', 'test/kernel/c.test.js', 'test/new/d.test.js', 'test/e.test.mjs'];
  assert.deepEqual(unrun(files, globs), ['test/kernel/c.test.js', 'test/new/d.test.js', 'test/e.test.mjs']);
});

test('only scripts the PR checks run, and that run node --test, count', () => {
  const fake = {
    test: 'node --test test/*.test.js && npm run test:deep',
    'test:deep': 'node --test "test/deep/*.test.js"',
    'test:local': 'node --test test/local/*.test.js',
    format: 'prettier --write test/**',
    'lint:tests': 'eslint test/*.test.js',
  };
  const workflow = [
    '      - run: npm test 2>&1 | tee -a "$RUNNER_TEMP/job.log"',
    '      - run: npm run format',
    '      - run: npm run lint:tests',
  ].join('\n');
  const ran = scriptsRunBy(workflow, fake);
  assert.deepEqual(ran.sort(), ['format', 'lint:tests', 'test', 'test:deep']);
  const globs = scriptGlobs(fake, ran);
  assert.deepEqual(globs.map(({ glob }) => glob), ['test/*.test.js', 'test/deep/*.test.js']);
  const files = ['test/a.test.js', 'test/deep/b.test.js', 'test/local/c.test.js', 'test/x/d.test.js'];
  assert.deepEqual(unrun(files, globs), ['test/local/c.test.js', 'test/x/d.test.js']);
});
