'use strict';

// scripts/ci/ledger-base.js: which commit's kernel ledger the kernel job's check:boundaries
// compares with, for each event pr-checks.yml runs on, the command pr-gate prints to
// reproduce it, and the workflow lines that use both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pickBase, main } = require('../scripts/ci/ledger-base.js');

const WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'pr-checks.yml'), 'utf8');
const BEFORE = '0123456789abcdef0123456789abcdef01234567';
const PARENT = 'fedcba9876543210fedcba9876543210fedcba98';
const NEW_REF = '0'.repeat(40);

test("a pull request compares with HEAD^1, its merge commit's base-branch parent", () => {
  assert.deepEqual(pickBase({ eventName: 'pull_request', before: '' }), { base: 'HEAD^1', fetch: null });
});

test('a push compares with what the branch held before it, so every pushed commit counts', () => {
  assert.deepEqual(pickBase({ eventName: 'push', before: BEFORE }), { base: BEFORE, fetch: BEFORE });
});

test("a tag push, as release.yml's workflow_call runs pr-checks, compares with the tagged commit's parent", () => {
  // A patch tag on release/R<n> is cut at an older milestone than main's tip, so main's
  // ledger, which #12 lowers every milestone, isn't the base
  assert.deepEqual(pickBase({ eventName: 'push', before: NEW_REF }), { base: 'HEAD^1', fetch: null });
});

test('the push that creates a release/** branch compares with its first commit\'s parent', () => {
  assert.deepEqual(pickBase({ eventName: 'push', before: NEW_REF }), { base: 'HEAD^1', fetch: null });
  assert.deepEqual(pickBase({ eventName: 'push', before: '' }), { base: 'HEAD^1', fetch: null });
  assert.deepEqual(pickBase({ eventName: 'push', before: 'not-a-sha' }), { base: 'HEAD^1', fetch: null });
});

/**
 * Run main with a fake git: `fetchFails(ref)` makes a fetch fail, and `parent` is HEAD's
 * parent, or null for a root commit. With `shallow`, the checkout stops at HEAD, so HEAD^1
 * doesn't resolve though HEAD's commit object still names its parent. `catFileFails` makes
 * reading HEAD's commit object fail.
 */
function runMain(env, { fetchFails = () => false, parent = PARENT, shallow = false, catFileFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-ledger-base-'));
  const output = path.join(dir, 'output');
  fs.writeFileSync(output, '');
  const calls = [];
  const lines = [];
  try {
    const code = main({
      env: { GITHUB_OUTPUT: output, ...env },
      git: args => {
        calls.push(args.join(' '));
        if (args[0] === 'fetch' && fetchFails(args[args.length - 1])) throw new Error('fatal: remote error: upload-pack: not our ref');
        if (args[0] === 'rev-parse') {
          if (parent === null || shallow) throw new Error('Command failed: git rev-parse --verify --quiet HEAD^1^{commit}');
          return `${parent}\n`;
        }
        if (args[0] === 'cat-file') {
          if (catFileFails) throw new Error('fatal: Not a valid object name HEAD');
          const tree = 'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n';
          const author = 'author A <a@example.test> 1700000000 +0000\ncommitter A <a@example.test> 1700000000 +0000\n';
          return `${tree}${parent === null ? '' : `parent ${parent}\n`}${author}\nA commit\n`;
        }
        return '';
      },
      log: line => lines.push(line),
    });
    return { code, written: fs.readFileSync(output, 'utf8'), calls, log: lines.join('\n') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const KERNEL = 'npm run check:boundaries';

test("a pull request writes HEAD^1 as the base and its base branch in the local command", () => {
  const { code, written, calls } = runMain({ EVENT: 'pull_request', BEFORE: '', BASE_REF: 'release/R1' });
  assert.equal(code, 0);
  assert.equal(written, `base=HEAD^1\ncommand=${KERNEL} -- --base origin/release/R1\n`);
  assert.ok(!calls.some(call => call.startsWith('fetch')), calls.join('; '));
});

test('a push fetches its before commit, compares with it, and the local command fetches it too', () => {
  const { code, written, calls, log } = runMain({ EVENT: 'push', BEFORE });
  assert.equal(code, 0);
  assert.ok(calls.includes(`fetch --no-tags --depth=1 origin ${BEFORE}`), calls.join('; '));
  assert.equal(written, `base=${BEFORE}\ncommand=git fetch origin ${BEFORE} && ${KERNEL} -- --base ${BEFORE}\n`);
  assert.match(log, new RegExp(`compares with ${BEFORE}`));
});

test('a tag push writes HEAD^1, and names the parent commit in the local command', () => {
  const { code, written, calls } = runMain({ EVENT: 'push', BEFORE: NEW_REF });
  assert.equal(code, 0);
  assert.ok(!calls.some(call => call.startsWith('fetch')), calls.join('; '));
  assert.equal(written, `base=HEAD^1\ncommand=git fetch origin ${PARENT} && ${KERNEL} -- --base ${PARENT}\n`);
});

test("a push whose before commit can't be fetched falls back to HEAD^1, not another branch", () => {
  const { code, written, log } = runMain({ EVENT: 'push', BEFORE }, { fetchFails: ref => ref === BEFORE });
  assert.equal(code, 0);
  assert.equal(written, `base=HEAD^1\ncommand=git fetch origin ${PARENT} && ${KERNEL} -- --base ${PARENT}\n`);
  assert.match(log, /::warning::Couldn't fetch/);
  assert.doesNotMatch(written, /origin\/main/);
});

test('a root commit has no parent, so check:boundaries runs without --base, with a warning', () => {
  const { code, written, log, calls } = runMain({ EVENT: 'push', BEFORE: NEW_REF }, { parent: null });
  assert.equal(code, 0);
  assert.equal(written, `base=\ncommand=${KERNEL}\n`);
  assert.match(log, /^::warning::.*without --base/m);
  assert.ok(calls.includes('cat-file -p HEAD'), calls.join('; '));
});

test("a checkout that stops short of HEAD's parent fails instead of dropping --base", () => {
  const { code, written, log } = runMain({ EVENT: 'push', BEFORE: NEW_REF }, { shallow: true });
  assert.equal(code, 1);
  assert.equal(written, '');
  assert.match(log, /^::error::.*parent/m);
});

test("failing to read HEAD's commit fails instead of dropping --base", () => {
  const { code, written, log } = runMain({ EVENT: 'pull_request', BEFORE: '', BASE_REF: 'next' }, { shallow: true, catFileFails: true });
  assert.equal(code, 1);
  assert.equal(written, '');
  assert.match(log, /^::error::/m);
});

test('the kernel job compares with the base ledger-base.js picks, and passes on its local command', () => {
  assert.match(WORKFLOW, /node scripts\/ci\/ledger-base\.js/);
  assert.match(WORKFLOW, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(WORKFLOW, /BASE: \$\{\{ steps\.ledger-base\.outputs\.base \}\}/);
  assert.match(WORKFLOW, /command: \$\{\{ steps\.ledger-base\.outputs\.command \}\}/);
  assert.doesNotMatch(WORKFLOW, /DEFAULT_BRANCH|default_branch/);
  assert.doesNotMatch(WORKFLOW, /check:boundaries -- --base HEAD\^1/);
});

test('the check:boundaries step passes --base whenever ledger-base.js wrote one', () => {
  const steps = WORKFLOW.split(/\n(?= {6}- name: )/);
  const step = steps.find(text => text.startsWith('      - name: npm run check:boundaries'));
  assert.ok(step, 'no check:boundaries step in the kernel job');
  assert.match(step, /BASE: \$\{\{ steps\.ledger-base\.outputs\.base \}\}/);
  assert.match(step, /npm run check:boundaries -- \$\{BASE:\+--base "\$BASE"\}/);
});

test("the kernel job holds security/changes.json's history to the same base (#21 slice 1b)", () => {
  const steps = WORKFLOW.split(/\n(?= {6}- name: )/);
  const step = steps.find(text => text.startsWith('      - name: npm run check:security-baseline -- --history-only'));
  assert.ok(step, 'no history step in the kernel job');
  assert.match(step, /BASE: \$\{\{ steps\.ledger-base\.outputs\.base \}\}/);
  assert.match(step, /npm run check:security-baseline -- --history-only \$\{BASE:\+--base "\$BASE"\}/);
});

test("pr-gate prints the kernel job's own local command instead of working out the base again", () => {
  const kernel = WORKFLOW.split('\n').find(line => /"kernel":/.test(line));
  assert.ok(kernel, 'no "kernel" entry in pr-gate COMMANDS');
  assert.match(kernel, /needs\.kernel\.outputs\.command/);
  assert.doesNotMatch(kernel, /github\.event\.before|github\.base_ref|--base/);
});
