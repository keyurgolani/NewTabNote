'use strict';

// scripts/ci/ledger-base.js: which commit's kernel ledger the kernel job's check:boundaries
// compares with, for each event pr-checks.yml runs on, and the workflow lines that use it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pickBase, main } = require('../scripts/ci/ledger-base.js');

const WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'pr-checks.yml'), 'utf8');
const BEFORE = '0123456789abcdef0123456789abcdef01234567';
const NEW_REF = '0'.repeat(40);

test("a pull request compares with HEAD^1, its merge commit's base-branch parent", () => {
  assert.deepEqual(pickBase({ eventName: 'pull_request', before: '', defaultBranch: 'main' }), { base: 'HEAD^1', fetch: null });
});

test('a push compares with what the branch held before it, so every pushed commit counts', () => {
  assert.deepEqual(pickBase({ eventName: 'push', before: BEFORE, defaultBranch: 'main' }), { base: BEFORE, fetch: BEFORE });
});

test('a push that creates its branch or tag compares with the default branch', () => {
  const fallback = { base: 'origin/main', fetch: '+refs/heads/main:refs/remotes/origin/main' };
  assert.deepEqual(pickBase({ eventName: 'push', before: NEW_REF, defaultBranch: 'main' }), fallback);
  assert.deepEqual(pickBase({ eventName: 'push', before: '', defaultBranch: 'main' }), fallback);
  assert.deepEqual(pickBase({ eventName: 'push', before: 'not-a-sha', defaultBranch: 'main' }), fallback);
});

function runMain(env, failFetch = () => false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-ledger-base-'));
  const output = path.join(dir, 'output');
  fs.writeFileSync(output, '');
  const fetched = [];
  const lines = [];
  try {
    const code = main({
      env: { GITHUB_OUTPUT: output, ...env },
      git: args => {
        fetched.push(args[args.length - 1]);
        if (failFetch(args[args.length - 1])) throw new Error('fatal: remote error: upload-pack: not our ref');
      },
      log: line => lines.push(line),
    });
    return { code, written: fs.readFileSync(output, 'utf8'), fetched, log: lines.join('\n') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('main fetches the base it picked and writes it to GITHUB_OUTPUT', () => {
  const { code, written, fetched, log } = runMain({ EVENT: 'push', BEFORE, DEFAULT_BRANCH: 'main' });
  assert.equal(code, 0);
  assert.deepEqual(fetched, [BEFORE]);
  assert.equal(written, `base=${BEFORE}\n`);
  assert.match(log, new RegExp(`compares with ${BEFORE}`));

  const pr = runMain({ EVENT: 'pull_request', BEFORE: '', DEFAULT_BRANCH: 'main' });
  assert.deepEqual(pr.fetched, []);
  assert.equal(pr.written, 'base=HEAD^1\n');
});

test("main falls back to the default branch when the push's before commit can't be fetched", () => {
  const { code, written, fetched, log } = runMain({ EVENT: 'push', BEFORE, DEFAULT_BRANCH: 'main' }, ref => ref === BEFORE);
  assert.equal(code, 0);
  assert.deepEqual(fetched, [BEFORE, '+refs/heads/main:refs/remotes/origin/main']);
  assert.equal(written, 'base=origin/main\n');
  assert.match(log, /::warning::/);
});

test('the kernel job compares with the base ledger-base.js picks', () => {
  assert.match(WORKFLOW, /node scripts\/ci\/ledger-base\.js/);
  assert.match(WORKFLOW, /BASE: \$\{\{ steps\.ledger-base\.outputs\.base \}\}/);
  assert.match(WORKFLOW, /npm run check:boundaries -- --base "\$BASE"/);
  assert.doesNotMatch(WORKFLOW, /check:boundaries -- --base HEAD\^1/);
});

test("pr-gate's local command for the kernel job names the pull request's base branch", () => {
  const kernel = WORKFLOW.split('\n').find(line => /"kernel":/.test(line));
  assert.ok(kernel, 'no "kernel" entry in pr-gate COMMANDS');
  assert.match(kernel, /github\.base_ref/);
  assert.doesNotMatch(kernel, /--base origin\/next/);
});
