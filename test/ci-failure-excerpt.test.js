const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ci', 'failure-excerpt.js');
const { excerpt, MAX_LINES } = require(SCRIPT);

const numbered = (count, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

test('starts at the first line that matches the marker', () => {
  const log = [...numbered(50), '✖ failing tests:', 'test at test/a.test.js:4:1', ...numbered(50, 'detail')].join('\n');
  const lines = excerpt(log, '^✖ failing tests:').split('\n');
  assert.equal(lines[0], '✖ failing tests:');
  assert.equal(lines.length, MAX_LINES);
});

test('takes the last lines when nothing matches the marker', () => {
  const lines = excerpt(`${numbered(50).join('\n')}\n\n`, '^never$').split('\n');
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines[lines.length - 1], 'line 50');
});

test('strips color codes and shortens very long lines', () => {
  const out = excerpt(`\u001b[31m✗ js/a.js: refused\u001b[39m\n${'x'.repeat(5000)}`, '✗ ');
  assert.equal(out.split('\n')[0], '✗ js/a.js: refused');
  assert.ok(out.split('\n')[1].length < 400);
});

test('writes a delimited step output, including for a missing log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-excerpt-'));
  try {
    const output = path.join(dir, 'github-output');
    const log = path.join(dir, 'job.log');
    fs.writeFileSync(log, 'npm error code E404\nnpm error 404 Not Found\n');
    execFileSync(process.execPath, [SCRIPT, log], { env: { ...process.env, GITHUB_OUTPUT: output } });
    execFileSync(process.execPath, [SCRIPT, path.join(dir, 'missing.log')], { env: { ...process.env, GITHUB_OUTPUT: output } });

    const blocks = [...fs.readFileSync(output, 'utf8').matchAll(/^excerpt<<(EXCERPT_[0-9a-f]+)\n([\s\S]*?)\n\1$/gm)];
    assert.deepEqual(blocks.map(match => match[2]), ['npm error code E404\nnpm error 404 Not Found', '(no output captured)']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
