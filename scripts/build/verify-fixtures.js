#!/usr/bin/env node
'use strict';

/**
 * npm run verify:fixtures (#27 test plan): one fixture per build failure rule, under
 * test/build-fixtures/<name>/fixture.json. Each is a copy of this tree with one defect, written
 * as edits to it. Three kinds:
 *   build    the build fails, in production and development mode, reports exactly the
 *            fixture's codes, and leaves no dist/ and no staging directory
 *   package  the build passes, `distEdits` break dist/, and npm run package fails with exactly
 *            the fixture's codes and leaves no zip
 *   canary   with a made-up secret set in the environment under the names release secrets
 *            use, the build and npm run package pass, and the secret is in neither their logs
 *            nor dist/ nor the zip (#27 AC9)
 *
 *   npm run verify:fixtures                        every fixture
 *   npm run verify:fixtures -- <name>...           the ones named
 *   npm run verify:fixtures -- --jobs <n> ...      at most n at once (4 by default)
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CODES, plural } = require('./diagnostics.js');
const { canaryLeaks } = require('./environment.js');
const { fromDirectory } = require('./package-files.js');
const { copyTree, runScript } = require('./tree.js');

/** @typedef {import('./tree.js').Run} Run */

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'build-fixtures');
const MODES = /** @type {const} */ (['production', 'development']);
/** The environment names the canary goes under: the release workflow's secrets, and common ones */
const CANARY_NAMES = ['NTN_CANARY_SECRET', 'CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN', 'CHROME_EXTENSION_ID', 'CHROME_PUBLISHER_ID', 'GITHUB_TOKEN', 'NPM_TOKEN'];

/**
 * @typedef {object} Edit
 * @property {string} [file] - the file to edit, relative to the tree
 * @property {string} [append]
 * @property {string} [prepend]
 * @property {string} [replace] - text that occurs exactly once in the file
 * @property {string} [with] - what replaces it
 * @property {string} [write] - the file's whole new content
 * @property {string} [remove] - a file or directory to delete
 */

/**
 * @typedef {object} Fixture
 * @property {string} name
 * @property {string} rule - what it breaks, in a sentence
 * @property {'build' | 'package' | 'canary'} [kind]
 * @property {string[]} [expect] - every code the build or package has to report, and only those
 * @property {Array<'production' | 'development'>} [modes]
 * @property {Edit[]} [edits]
 * @property {Edit[]} [distEdits] - for a package fixture, edits to the built tree before packaging
 * @property {Record<string, string>} [env] - set in the build's environment
 */

/**
 * @returns {Fixture[]}
 */
function readFixtures() {
  return fs.readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ ...JSON.parse(fs.readFileSync(path.join(FIXTURES, entry.name, 'fixture.json'), 'utf8')), name: entry.name }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Apply edits to the tree at `dir`. An edit that matches nothing throws, so a fixture can't
 * quietly stop breaking anything.
 * @param {string} dir
 * @param {Edit[]} edits
 */
function applyEdits(dir, edits) {
  for (const edit of edits) {
    if (edit.remove !== undefined) {
      const target = path.join(dir, edit.remove);
      if (!fs.existsSync(target)) throw new Error(`there's no ${edit.remove} to remove`);
      fs.rmSync(target, { recursive: true });
      continue;
    }
    if (edit.file === undefined) throw new Error(`an edit names no file: ${JSON.stringify(edit)}`);
    const target = path.join(dir, edit.file);
    if (edit.write !== undefined) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, edit.write);
      continue;
    }
    const text = fs.readFileSync(target, 'utf8');
    let next = text;
    if (edit.append !== undefined) next += edit.append;
    if (edit.prepend !== undefined) next = edit.prepend + next;
    if (edit.replace !== undefined) {
      if (next.split(edit.replace).length !== 2) throw new Error(`${edit.file} doesn't hold ${JSON.stringify(edit.replace)} exactly once`);
      next = next.replace(edit.replace, () => edit.with ?? '');
    }
    if (next === text) throw new Error(`the edit to ${edit.file} changes nothing`);
    fs.writeFileSync(target, next);
  }
}

/**
 * The codes a failed build or package run reported, from its summary lines
 * @param {Run} run
 * @returns {string[]}
 */
function reportedCodes(run) {
  const text = `${run.stdout}\n${run.stderr}`;
  const codes = [...text.matchAll(/^ {2,3}(?:✗ )?\[([a-z-]+\/[a-z-]+)\] /gm)].map((match) => match[1]);
  return [...new Set(codes)].sort();
}

/**
 * The last lines of a run, to show why it didn't do what a fixture expected
 * @param {Run} run
 * @returns {string}
 */
function tail(run) {
  return `${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-12).map((line) => `      ${line}`).join('\n');
}

/**
 * Leftover build output in a tree: dist/, staging directories, and zips
 * @param {string} dir
 * @returns {string[]}
 */
function leftovers(dir) {
  const found = fs.readdirSync(dir).filter((entry) => entry === 'dist' || entry.startsWith('.dist-staging-'));
  const releases = path.join(dir, 'releases');
  if (fs.existsSync(releases)) found.push(...fs.readdirSync(releases).filter((name) => name.endsWith('.zip')).map((name) => `releases/${name}`));
  return found;
}

/**
 * @param {string[]} expected
 * @param {string[]} got
 * @returns {boolean}
 */
function sameCodes(expected, got) {
  const want = [...new Set(expected)].sort();
  return want.length === got.length && want.every((code, i) => code === got[i]);
}

/**
 * Run one fixture. Returns what it proved, or why it failed.
 * @param {Fixture} fixture
 * @returns {Promise<{ok: boolean, lines: string[]}>} each line starting ✓ or ✗
 */
async function runFixture(fixture) {
  const kind = fixture.kind || 'build';
  const expected = fixture.expect || [];
  const unknown = expected.filter((code) => !Object.hasOwn(CODES, code));
  if (unknown.length > 0) return { ok: false, lines: [`✗ ${fixture.name}: expects unknown codes ${unknown.join(', ')}`] };
  if (kind !== 'canary' && expected.length === 0) return { ok: false, lines: [`✗ ${fixture.name}: expects no code`] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ntn-fixture-${fixture.name}-`));
  /** @type {string[]} */
  const lines = [];
  let ok = true;
  const failed = (/** @type {string} */ line) => {
    ok = false;
    lines.push(`✗ ${line}`);
  };
  const passed = (/** @type {string} */ line) => lines.push(`✓ ${line}`);
  try {
    copyTree(ROOT, dir);
    applyEdits(dir, fixture.edits || []);

    if (kind === 'build') {
      for (const mode of fixture.modes || MODES) {
        const run = await runScript(dir, 'scripts/build.js', mode === 'development' ? ['--dev'] : [], { ...process.env, ...fixture.env });
        const codes = reportedCodes(run);
        const left = leftovers(dir);
        if (run.status !== 1) failed(`${fixture.name} (${mode}): the build exited ${run.status}, not 1\n${tail(run)}`);
        else if (!sameCodes(expected, codes)) failed(`${fixture.name} (${mode}): expected [${expected.join(', ')}], got [${codes.join(', ')}]\n${tail(run)}`);
        else if (left.length > 0) failed(`${fixture.name} (${mode}): the failed build left ${left.join(', ')}`);
        else passed(`${fixture.name} (${mode}): ${codes.join(', ')}, and no dist/`);
      }
    } else if (kind === 'package') {
      const built = await runScript(dir, 'scripts/build.js', []);
      if (built.status !== 0) {
        failed(`${fixture.name}: the build it packages failed\n${tail(built)}`);
      } else {
        applyEdits(dir, fixture.distEdits || []);
        const run = await runScript(dir, 'scripts/package.js', []);
        const codes = reportedCodes(run);
        const zips = leftovers(dir).filter((entry) => entry.startsWith('releases/'));
        if (run.status !== 1) failed(`${fixture.name}: npm run package exited ${run.status}, not 1\n${tail(run)}`);
        else if (!sameCodes(expected, codes)) failed(`${fixture.name}: expected [${expected.join(', ')}], got [${codes.join(', ')}]\n${tail(run)}`);
        else if (zips.length > 0) failed(`${fixture.name}: the failed package left ${zips.join(', ')}`);
        else passed(`${fixture.name}: ${codes.join(', ')}, and no zip`);
      }
    } else {
      const canary = `ntn-canary-${crypto.randomBytes(16).toString('hex')}`;
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...process.env };
      for (const name of CANARY_NAMES) env[name] = canary;
      const built = await runScript(dir, 'scripts/build.js', [], env);
      const packed = built.status === 0 ? await runScript(dir, 'scripts/package.js', [], env) : null;
      if (built.status !== 0 || !packed || packed.status !== 0) {
        failed(`${fixture.name}: the build or package with the canary set failed\n${tail(packed || built)}`);
      } else {
        const zipName = fs.readdirSync(path.join(dir, 'releases')).find((name) => name.endsWith('.zip'));
        const leaks = canaryLeaks(canary, {
          logs: { 'the build log': `${built.stdout}${built.stderr}`, 'the package log': `${packed.stdout}${packed.stderr}` },
          files: fromDirectory(path.join(dir, 'dist'), 'dist/'),
          zip: zipName ? fs.readFileSync(path.join(dir, 'releases', zipName)) : undefined,
        });
        if (!zipName) failed(`${fixture.name}: npm run package wrote no zip`);
        else if (leaks.length > 0) leaks.forEach((leak) => failed(`${fixture.name}: [${leak.code}] ${leak.subject}: ${leak.message}`));
        else passed(`${fixture.name}: a canary under ${CANARY_NAMES.length} names is in neither log, dist/, nor ${zipName}`);
      }
    }
  } catch (error) {
    failed(`${fixture.name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ok, lines };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
async function main(argv) {
  let jobs = Math.max(1, Math.min(4, os.availableParallelism()));
  /** @type {string[]} */
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--jobs') {
      jobs = Number(argv[++i]);
      if (!Number.isInteger(jobs) || jobs < 1) {
        console.error('usage: node scripts/build/verify-fixtures.js [--jobs <n>] [<fixture>...]');
        return 2;
      }
    } else {
      names.push(argv[i]);
    }
  }
  const all = readFixtures();
  const missing = names.filter((name) => !all.some((fixture) => fixture.name === name));
  if (missing.length > 0) {
    console.error(`verify:fixtures failed: no fixture named ${missing.join(', ')} in test/build-fixtures/`);
    return 1;
  }
  const fixtures = names.length > 0 ? all.filter((fixture) => names.includes(fixture.name)) : all;
  console.log(`verify:fixtures: ${plural(fixtures.length, 'fixture')}, ${jobs} at a time`);

  const started = Date.now();
  /** @type {Array<{ok: boolean, lines: string[]}>} */
  const results = new Array(fixtures.length);
  let next = 0;
  const worker = async () => {
    while (next < fixtures.length) {
      const i = next++;
      results[i] = await runFixture(fixtures[i]);
      for (const line of results[i].lines) console.log(`  ${line}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, fixtures.length) }, worker));

  const failures = results.filter((result) => !result.ok);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.error(`verify:fixtures failed: ${failures.length} of ${plural(fixtures.length, 'fixture')} in ${seconds}s`);
    failures.forEach((result) => result.lines.filter((line) => line.startsWith('✗')).forEach((line) => console.error(`  ${line.slice(2)}`)));
    return 1;
  }
  console.log(`verify:fixtures: OK, ${plural(fixtures.length, 'fixture')} in ${seconds}s`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { readFixtures, applyEdits, reportedCodes, runFixture, FIXTURES };
