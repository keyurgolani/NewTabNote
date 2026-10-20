#!/usr/bin/env node

/**
 * Pick the commit whose docs/architecture/kernel-ledger.json the kernel job's
 * check:boundaries compares with, fetch it, and write two GITHUB_OUTPUT values: `base`, the
 * ref for --base (empty for none), and `command`, the same check to run locally, which
 * pr-gate prints.
 * - a pull request: HEAD^1, the base branch, since a pull request's HEAD is its merge commit
 * - a push: github.event.before, what the branch held before the push, so every pushed
 *   commit counts. A push that creates its branch or tag has no before (all zeros), and it,
 *   like a before that can't be fetched, compares with HEAD^1, the pushed commit's parent,
 *   which the checkout has at fetch-depth 2. release.yml runs pr-checks for a v* tag that
 *   way, and the tag may sit on an older milestone than any branch tip.
 * A root commit gets no --base, so check:boundaries only matches the ledger to the hits,
 * with a warning. Any other failure to find HEAD^1, such as a checkout cut off at HEAD,
 * exits 1, since dropping --base would switch the ratchet off.
 *
 *   EVENT=push BEFORE=<sha> BASE_REF= node scripts/ci/ledger-base.js
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const SHA = /^[0-9a-f]{40}$/;
const NEW_REF = /^0{40}$/;
const CHECK = 'npm run check:boundaries';

/**
 * The ref to compare with, and the commit to fetch first (null when the checkout has it)
 */
function pickBase({ eventName, before }) {
  if (eventName === 'push' && SHA.test(before || '') && !NEW_REF.test(before)) return { base: before, fetch: before };
  return { base: 'HEAD^1', fetch: null };
}

/**
 * Runs git and returns what it printed
 */
function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/**
 * HEAD's parent, or null for a root commit. When HEAD^1 doesn't resolve, HEAD's commit
 * object says whether it has a parent: a shallow checkout cut off at HEAD still records
 * it. Throws when it has one, or when git can't read HEAD.
 */
function parentOf(git) {
  try {
    const parent = git(['rev-parse', '--verify', '--quiet', 'HEAD^1^{commit}']).trim();
    if (parent) return parent;
  } catch {
    // Read HEAD's commit object below
  }
  const header = git(['cat-file', '-p', 'HEAD']).split('\n\n')[0];
  if (/^parent [0-9a-f]+$/m.test(header)) {
    throw new Error("HEAD has a parent this checkout doesn't have, so there's no ledger to compare with (the kernel job checks out with fetch-depth 2)");
  }
  return null;
}

/**
 * Returns the exit code
 */
function main({ env = process.env, git = runGit, log = console.log } = {}) {
  try {
    return pickAndWrite({ env, git, log });
  } catch (error) {
    log(`::error::ledger-base: ${error.message}`);
    return 1;
  }
}

function pickAndWrite({ env, git, log }) {
  const { EVENT: eventName = '', BEFORE: before = '', BASE_REF: baseRef = '', GITHUB_OUTPUT: output } = env;
  if (!output) {
    log('ledger-base: GITHUB_OUTPUT is not set, so there is nowhere to write the base');
    return 1;
  }
  let { base, fetch } = pickBase({ eventName, before });
  if (fetch) {
    try {
      git(['fetch', '--no-tags', '--depth=1', 'origin', fetch]);
    } catch {
      log(`::warning::Couldn't fetch ${fetch}, the commit before this push, so check:boundaries compares with HEAD^1, the pushed commit's parent, instead`);
      base = 'HEAD^1';
    }
  }

  let command = `git fetch origin ${base} && ${CHECK} -- --base ${base}`;
  if (base === 'HEAD^1') {
    const parent = parentOf(git);
    if (!parent) {
      base = '';
      command = CHECK;
    } else if (eventName === 'pull_request' && baseRef) {
      command = `${CHECK} -- --base origin/${baseRef}`;
    } else {
      command = `git fetch origin ${parent} && ${CHECK} -- --base ${parent}`;
    }
  }

  fs.appendFileSync(output, `base=${base}\ncommand=${command}\n`);
  log(base
    ? `ledger-base: check:boundaries compares with ${base}`
    : '::warning::HEAD is a root commit with no ledger before it, so check:boundaries runs without --base and only matches the ledger to the hits');
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { pickBase, main };
