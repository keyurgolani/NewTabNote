#!/usr/bin/env node

/**
 * Pick the commit whose docs/architecture/kernel-ledger.json the kernel job's
 * `check:boundaries --base` compares with, fetch it, and write it to GITHUB_OUTPUT as `base`:
 * - a pull request: HEAD^1, the base branch, since a pull request's HEAD is its merge commit
 * - a push: github.event.before, what the branch held before the push, so every pushed
 *   commit counts. A push that creates its branch or tag has no before (all zeros), and it,
 *   like a before that can't be fetched, compares with the default branch.
 *
 *   EVENT=push BEFORE=<sha> DEFAULT_BRANCH=main node scripts/ci/ledger-base.js
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const SHA = /^[0-9a-f]{40}$/;
const NEW_REF = /^0{40}$/;

function defaultBranchBase(defaultBranch) {
  return { base: `origin/${defaultBranch}`, fetch: `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}` };
}

/**
 * The ref to compare with, and the ref to fetch first (null when the checkout has it)
 */
function pickBase({ eventName, before, defaultBranch }) {
  if (eventName !== 'push') return { base: 'HEAD^1', fetch: null };
  if (SHA.test(before || '') && !NEW_REF.test(before)) return { base: before, fetch: before };
  return defaultBranchBase(defaultBranch);
}

function runGit(args) {
  execFileSync('git', args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

/**
 * Returns the exit code
 */
function main({ env = process.env, git = runGit, log = console.log } = {}) {
  const { EVENT: eventName = '', BEFORE: before = '', DEFAULT_BRANCH: defaultBranch = '', GITHUB_OUTPUT: output } = env;
  if (!output) {
    log('ledger-base: GITHUB_OUTPUT is not set, so there is nowhere to write the base');
    return 1;
  }
  let choice = pickBase({ eventName, before, defaultBranch });
  if (choice.fetch) {
    if (!defaultBranch) {
      log('ledger-base: DEFAULT_BRANCH is not set, so a push has nothing to fall back to');
      return 1;
    }
    const fetch = refspec => git(['fetch', '--no-tags', '--depth=1', 'origin', refspec]);
    try {
      fetch(choice.fetch);
    } catch (error) {
      const fallback = defaultBranchBase(defaultBranch);
      if (choice.base === fallback.base) throw error;
      log(`::warning::Couldn't fetch ${choice.base}, the commit before this push, so check:boundaries compares with ${fallback.base} instead`);
      choice = fallback;
      fetch(choice.fetch);
    }
  }
  fs.appendFileSync(output, `base=${choice.base}\n`);
  log(`ledger-base: check:boundaries compares with ${choice.base}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ledger-base: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { pickBase, main };
