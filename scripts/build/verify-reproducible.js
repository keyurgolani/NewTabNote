#!/usr/bin/env node
'use strict';

/**
 * npm run verify:reproducible (#27 AC4): two clean builds of the commit, in different
 * directories at different times, have to package the same zip byte for byte, with the same
 * buildId and outputDigest. Each build runs in a clone of HEAD that shares this repository's
 * objects (git clone --shared), with node_modules linked, so both use the toolchain installed
 * here and neither is dirty. The second one runs after the first, with every file's
 * modification time a day later, another umask, and another time zone, none of which may
 * reach the zip. SOURCE_DATE_EPOCH is left unset, so both take it from the commit.
 *
 * It builds the commit, not the working tree: uncommitted changes are in neither build.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { plural } = require('./diagnostics.js');
const { readZip } = require('./zip.js');
const { sha256 } = require('./build-info.js');
const { runScript } = require('./tree.js');

/** @typedef {import('./tree.js').Run} Run */

const ROOT = path.join(__dirname, '..', '..');
const DAY_SECONDS = 24 * 60 * 60;
/** @type {string[]} Every clone this run made, removed when it ends */
const clones = [];

/**
 * Run git in `cwd`, failing loudly
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(result.stderr || (result.error && result.error.message) || '').trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Every file under `dir` but .git, node_modules, and what the build writes
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFiles(dir) {
  /** @type {string[]} */
  const found = [];
  const visit = (/** @type {string} */ current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (current === dir && ['.git', 'node_modules', 'dist', 'releases'].includes(entry.name)) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  visit(dir);
  return found;
}

/**
 * @typedef {object} Build
 * @property {string} dir
 * @property {Buffer} zip
 * @property {{buildId: string, outputDigest: string}} info
 */

/**
 * Clone HEAD into a new directory and build and package it there
 * @param {string} commit
 * @param {string} name
 * @param {{later?: boolean}} [options]
 * @returns {Promise<Build>}
 */
async function cleanBuild(commit, name, { later = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ntn-reproducible-${name}-`));
  clones.push(dir);
  git(ROOT, ['clone', '--quiet', '--shared', '--no-checkout', ROOT, dir]);
  git(dir, ['checkout', '--quiet', '--detach', commit]);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // The link is the clone's own business, not a change to the tree
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n/node_modules\n');
  if (later) {
    const shifted = new Date(Date.now() + DAY_SECONDS * 1000);
    for (const file of sourceFiles(dir)) fs.utimesSync(file, shifted, shifted);
  }
  const status = git(dir, ['status', '--porcelain']);
  if (status !== '') throw new Error(`the clone in ${dir} isn't clean:\n${status}`);

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, TZ: later ? 'Pacific/Kiritimati' : 'UTC' };
  delete env.SOURCE_DATE_EPOCH;
  const umask = process.umask(later ? 0o077 : 0o022);
  /** @type {Run} */
  let built;
  /** @type {Run | null} */
  let packed = null;
  try {
    built = await runScript(dir, 'scripts/build.js', [], env);
    if (built.status === 0) packed = await runScript(dir, 'scripts/package.js', [], env);
  } finally {
    process.umask(umask);
  }
  const failed = packed === null ? built : packed;
  if (failed.status !== 0) {
    const lines = `${failed.stdout}\n${failed.stderr}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`the ${name} build in ${dir} failed:\n${lines}`);
  }
  const zipName = fs.readdirSync(path.join(dir, 'releases')).find((file) => file.endsWith('.zip'));
  if (!zipName) throw new Error(`the ${name} build in ${dir} wrote no zip`);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'dist', 'build-info.json'), 'utf8'));
  return { dir, zip: fs.readFileSync(path.join(dir, 'releases', zipName)), info };
}

/**
 * What differs between two zips, entry by entry
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {string[]}
 */
function zipDifferences(a, b) {
  const left = readZip(a);
  const right = readZip(b);
  /** @type {string[]} */
  const differences = [];
  const names = (/** @type {Array<{path: string}>} */ entries) => entries.map((entry) => entry.path).join('\n');
  if (names(left) !== names(right)) differences.push('the entries differ in name or order');
  const byPath = new Map(right.map((entry) => [entry.path, entry]));
  for (const entry of left) {
    const other = byPath.get(entry.path);
    if (!other) continue;
    if (!entry.data.equals(other.data)) differences.push(`${entry.path}: its contents differ`);
    if (entry.date !== other.date || entry.time !== other.time) differences.push(`${entry.path}: its dates differ`);
    if (entry.mode !== other.mode) differences.push(`${entry.path}: its modes differ (${entry.mode.toString(8)}, ${other.mode.toString(8)})`);
  }
  if (differences.length === 0) differences.push('the entries match, so the headers or compression differ');
  return differences;
}

/**
 * @returns {Promise<number>} the exit code
 */
async function main() {
  const commit = git(ROOT, ['rev-parse', 'HEAD']);
  if (git(ROOT, ['status', '--porcelain']) !== '') {
    console.log('verify:reproducible: the working tree has changes, which neither build includes');
  }
  console.log(`verify:reproducible: building ${commit} twice, in two clean clones`);
  /** @type {Build[]} */
  const builds = [];
  try {
    builds.push(await cleanBuild(commit, 'first'));
    builds.push(await cleanBuild(commit, 'second', { later: true }));
    const [first, second] = builds;
    /** @type {string[]} */
    const problems = [];
    if (first.info.buildId.endsWith('-dirty')) problems.push(`buildId ${first.info.buildId} is dirty, though the clone was clean`);
    if (first.info.buildId !== second.info.buildId) problems.push(`buildId differs: ${first.info.buildId} and ${second.info.buildId}`);
    if (first.info.outputDigest !== second.info.outputDigest) problems.push(`outputDigest differs: ${first.info.outputDigest} and ${second.info.outputDigest}`);
    if (!first.zip.equals(second.zip)) {
      problems.push(`the zips differ: ${sha256(first.zip)} and ${sha256(second.zip)}`, ...zipDifferences(first.zip, second.zip).map((line) => `  ${line}`));
    }
    if (problems.length > 0) {
      console.error(`verify:reproducible failed: ${plural(problems.filter((line) => !line.startsWith('  ')).length, 'difference')} between two builds of ${commit}`);
      problems.forEach((line) => console.error(`  ${line}`));
      return 1;
    }
    console.log(`verify:reproducible: OK, both builds of ${commit} packaged the same ${first.zip.length}-byte zip, SHA-256 ${sha256(first.zip)}`);
    console.log(`  buildId ${first.info.buildId}`);
    console.log(`  outputDigest ${first.info.outputDigest}`);
    return 0;
  } catch (error) {
    console.error(`verify:reproducible failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    for (const dir of clones) fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { zipDifferences };
