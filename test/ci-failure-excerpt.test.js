const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ci', 'failure-excerpt.js');
const { excerpt, MARKERS, MAX_LINES } = require(SCRIPT);

const numbered = (count, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-excerpt-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('starts at the first line that matches the marker', () => {
  const log = [...numbered(50), '✖ failing tests:', 'test at test/a.test.js:4:1', ...numbered(50, 'detail')].join('\n');
  const lines = excerpt(log, MARKERS.unit).split('\n');
  assert.equal(lines[0], '✖ failing tests:');
  assert.equal(lines.length, MAX_LINES);
});

test('takes the last lines when nothing matches the marker', () => {
  const lines = excerpt(`${numbered(50).join('\n')}\n\n`, /^never$/).split('\n');
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines[lines.length - 1], 'line 50');
});

test('starts a build excerpt at the strict summary, which lists every refusal', () => {
  const log = [
    '  ✓ js/a.js: 1 KB → 500 B (50.0% saved)',
    '  ✗ js/b.js: --strict refused to copy it unminified after a terser error: Name expected (js/b.js:3:7)',
    ...numbered(30, '  ✓ saved'),
    '  ✗ css/c.css: --strict refused to copy it unminified after a CleanCSS error: Broken @import',
    '',
    '✗ Strict build failed: refused 2 fallbacks',
    '   js/b.js: refused to copy it unminified after a terser error: Name expected (js/b.js:3:7)',
    '   css/c.css: refused to copy it unminified after a CleanCSS error: Broken @import',
  ].join('\n');
  const lines = excerpt(log, MARKERS.build).split('\n');
  assert.equal(lines[0], '✗ Strict build failed: refused 2 fallbacks');
  assert.match(lines[1], /js\/b\.js: .*Name expected \(js\/b\.js:3:7\)/);
  assert.match(lines[2], /css\/c\.css: .*Broken @import/);
});

test('starts an extension excerpt at the first failed test, past the github annotations', () => {
  const log = [
    'Running 5 tests using 1 worker',
    '',
    '  ✓  1 e2e/smoke.spec.js:26:3 › new tab, first run: shows the welcome note and the walkthrough (1.9s)',
    '  ✘  2 e2e/smoke.spec.js:26:3 › popup: shows the quick note input and an empty recent list (1.1s)',
    '  ✘  3 e2e/smoke.spec.js:26:3 › popup: shows the quick note input and an empty recent list (retry #1) (1.0s)',
    '::error file=e2e/smoke.spec.js,title=e2e/smoke.spec.js:26:3 › popup,line=35,col=7::  1) e2e/smoke.spec.js:26:3 › popup%0A    Error: uncaught',
    '',
    '  1) e2e/smoke.spec.js:26:3 › popup: shows the quick note input and an empty recent list ───────────',
    '',
    '    Error: uncaught exceptions that no test/known-defects.json entry lists under `uncaught`',
    ...numbered(30, '    detail'),
  ].join('\n');
  const lines = excerpt(log, MARKERS.extension).split('\n');
  assert.match(lines[0], /^ {2}1\) e2e\/smoke\.spec\.js:26:3 › popup/);
  assert.match(lines[2], /Error: uncaught exceptions/);
});

test('starts an extension excerpt at an Error a failed load prints', () => {
  const log = '> playwright test -c e2e/playwright.config.js\n\nError: test/known-defects.json breaks the ledger format:\n  KD-1: `id` has to be KD- and three digits\n';
  assert.equal(excerpt(log, MARKERS.extension).split('\n')[0], 'Error: test/known-defects.json breaks the ledger format:');
});

test('strips color codes and shortens very long lines', () => {
  const out = excerpt(`\u001b[31m✗ js/a.js: refused\u001b[39m\n${'x'.repeat(5000)}`, /^✗ /);
  assert.equal(out.split('\n')[0], '✗ js/a.js: refused');
  assert.ok(out.split('\n')[1].length < 400);
});

test('writes a delimited step output, including for a missing log or an unknown job', () => {
  withTempDir(dir => {
    const output = path.join(dir, 'github-output');
    const log = path.join(dir, 'job.log');
    const env = { ...process.env, GITHUB_OUTPUT: output };
    fs.writeFileSync(log, 'npm error code E404\nnpm error 404 Not Found\n');
    execFileSync(process.execPath, [SCRIPT, log, 'unit'], { env });
    execFileSync(process.execPath, [SCRIPT, path.join(dir, 'missing.log'), 'build'], { env });
    execFileSync(process.execPath, [SCRIPT, log, '__proto__'], { env });

    const blocks = [...fs.readFileSync(output, 'utf8').matchAll(/^excerpt<<(EXCERPT_[0-9a-f]+)\n([\s\S]*?)\n\1$/gm)];
    const npmError = 'npm error code E404\nnpm error 404 Not Found';
    assert.deepEqual(blocks.map(match => match[2]), [npmError, '(no output captured)', npmError]);
  });
});

test('prints the excerpt when GITHUB_OUTPUT is not set, as in a local run', () => {
  withTempDir(dir => {
    const log = path.join(dir, 'job.log');
    fs.writeFileSync(log, `${numbered(5).join('\n')}\n✖ failing tests:\n✖ breaks\n`);
    const env = { ...process.env };
    delete env.GITHUB_OUTPUT;
    const stdout = execFileSync(process.execPath, [SCRIPT, log, 'unit'], { env, encoding: 'utf8' });
    assert.equal(stdout, '✖ failing tests:\n✖ breaks\n');
  });
});
