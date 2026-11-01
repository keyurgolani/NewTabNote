#!/usr/bin/env node
'use strict';

/**
 * npm run check:security-baseline (#21 slice 1b, PR 3): a built extension's manifest, and the
 * sources that hold its network rules, against security/ (scripts/build/security-baseline.js).
 * The build runs the same check on what it writes. With --base, security/changes.json is also
 * held to the base branch's copy: every entry there stays as it is, so entries only get
 * appended. In CI (CI set) a base it can't read fails the check; locally it says so and goes on.
 *
 *   npm run check:security-baseline                          check dist/
 *   npm run check:security-baseline -- <dir>                 check another build
 *   npm run check:security-baseline -- --base origin/next    and the history against that ref
 *   npm run check:security-baseline -- --history-only --base <ref>
 *                                                            only the history, with no build
 *   npm run check:security-baseline -- --print               what an entry for the tree as it
 *                                                            is records, to copy into
 *                                                            security/changes.json with its
 *                                                            issue, files and rationale
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { checkSecurityBaseline, checkHistory, recordOf, inputsFrom, CHANGES_FILE } = require('./build/security-baseline.js');
const { format, plural } = require('./build/diagnostics.js');

const ROOT = path.join(__dirname, '..');
const USAGE = 'usage: node scripts/check-security-baseline.js [<dir>] [--base <git ref>] [--history-only] [--print]';

/**
 * security/changes.json at `ref`: its text, null when the ref's tree has no such file, or why
 * git couldn't read the ref or its tree, which is never taken for a missing file
 * @param {string} ref
 * @param {string} root
 * @param {(args: string[]) => string} [git] - runs git in `root`, unless a test hands in another
 * @returns {{text: string | null} | {unreadable: string}}
 */
function baseCopy(ref, root, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return { unreadable: `git can't resolve ${ref} to a commit; fetch it, or check out with enough history` };
  }
  let listed;
  try {
    // Empty for a tree without the file; an error only when git can't read the tree
    listed = git(['ls-tree', '--name-only', ref, '--', CHANGES_FILE]);
  } catch (reason) {
    return { unreadable: `git can't read ${ref}'s tree: ${reason instanceof Error ? reason.message : reason}` };
  }
  if (!listed.split('\n').includes(CHANGES_FILE)) return { text: null };
  try {
    return { text: git(['show', `${ref}:${CHANGES_FILE}`]) };
  } catch (reason) {
    return { unreadable: `git can't show ${CHANGES_FILE} at ${ref}: ${reason instanceof Error ? reason.message : reason}` };
  }
}

/**
 * @param {string[]} [argv]
 * @param {{log?: (line: string) => void, error?: (line: string) => void, env?: NodeJS.ProcessEnv, root?: string}} [io]
 * @returns {number}
 */
function main(argv = process.argv.slice(2), { log = console.log, error = console.error, env = process.env, root = ROOT } = {}) {
  let print = false;
  let historyOnly = false;
  /** @type {string | null} */
  let base = null;
  /** @type {string[]} */
  const dirs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--print') print = true;
    else if (argv[i] === '--history-only') historyOnly = true;
    else if (argv[i] === '--base' && argv[i + 1] && !argv[i + 1].startsWith('-')) base = argv[++i];
    else if (argv[i].startsWith('-') || dirs.length > 0) {
      error(USAGE);
      return 2;
    } else dirs.push(argv[i]);
  }
  const ci = Boolean(env.CI);
  /** @type {import('./build/diagnostics.js').Problem[]} */
  const problems = [];

  if (base === null) {
    if (historyOnly && ci) {
      error(`check:security-baseline failed: --history-only needs --base, the ref whose ${CHANGES_FILE} the entries are held to`);
      return 1;
    }
    if (!print) log(`check:security-baseline: ${CHANGES_FILE}'s history isn't checked; pass --base <ref> to hold it to the base branch's copy`);
  } else {
    const copy = baseCopy(base, root);
    if ('unreadable' in copy) {
      if (ci) {
        error(`check:security-baseline failed: can't read the base: ${copy.unreadable}`);
        return 1;
      }
      log(`check:security-baseline: can't read the base, so ${CHANGES_FILE}'s history isn't checked: ${copy.unreadable}`);
    } else {
      if (copy.text === null) log(`check:security-baseline: ${base} has no ${CHANGES_FILE}, so no entry is held yet`);
      problems.push(...checkHistory({ current: fs.readFileSync(path.join(root, CHANGES_FILE), 'utf8'), base: copy.text }));
    }
  }

  if (!historyOnly) {
    const dir = path.resolve(dirs[0] || path.join(root, 'dist'));
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      error(`check:security-baseline failed: no build at ${path.relative(process.cwd(), dir) || '.'}. Run \`npm run build\` first.`);
      return 1;
    }
    const inputs = inputsFrom(dir, root);
    if (print) {
      log(JSON.stringify(recordOf(inputs), null, 2));
      if (problems.length === 0) return 0;
      error(`check:security-baseline failed: ${plural(problems.length, 'problem')}`);
      problems.forEach((found) => error(`  - ${format(found)}`));
      return 1;
    }
    problems.push(...checkSecurityBaseline(inputs));
  }

  if (problems.length > 0) {
    error(`check:security-baseline failed: ${plural(problems.length, 'problem')}`);
    problems.forEach((found) => error(`  - ${format(found)}`));
    return 1;
  }
  log(historyOnly
    ? `check:security-baseline: OK, ${CHANGES_FILE} keeps every entry ${base} has`
    : 'check:security-baseline: OK, the manifest, the CSP, the permissions, the destinations, the ledger and the network sources match security/');
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, baseCopy };
