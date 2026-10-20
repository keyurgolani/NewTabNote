const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'release', 'is-latest.mjs');

/**
 * Run is-latest.mjs for `tag`, with `input` on stdin as the workflow's `gh release list`
 * prints the published releases' tags
 */
function isLatest(tag, input) {
  const result = spawnSync(process.execPath, [SCRIPT, ...[tag].flat()], { input, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

const lines = tags => `${tags.join('\n')}\n`;

function assertLatest(tag, tags, expected) {
  const result = isLatest(tag, lines(tags));
  assert.equal(result.code, 0, result.output);
  assert.equal(result.stdout, `${expected}\n`, `${tag} among ${tags.join(', ')}: ${result.output}`);
}

describe('is-latest.mjs', () => {
  it('marks the highest release Latest', () => {
    assertLatest('v1.5.0', ['v1.3.0', 'v1.4.0', 'v1.4.1', 'v1.5.0'], true);
    assert.match(isLatest('v1.5.0', lines(['v1.4.1', 'v1.5.0'])).stderr, /No published release is higher than v1\.5\.0/);
  });

  it('keeps Latest off a patch tagged after a newer milestone', () => {
    assertLatest('v1.4.2', ['v1.4.0', 'v1.4.1', 'v1.5.0', 'v1.4.2'], false);
    assert.match(isLatest('v1.4.2', lines(['v1.5.0', 'v1.4.2'])).stderr, /v1\.4\.2 is lower than the v1\.5\.0 release/);
  });

  it('compares versions as numbers, part by part', () => {
    assertLatest('v1.10.0', ['v1.9.0', 'v1.10.0'], true);
    assertLatest('v1.9.0', ['v1.9.0', 'v1.9.1', 'v1.10.0'], false);
    assertLatest('v10.0.0', ['v9.9.9', 'v10.0.0'], true);
    assertLatest('v2.0.0', ['v1.99.99', 'v2.0.0'], true);
    assertLatest('v1.4.10', ['v1.4.9', 'v1.4.10'], true);
  });

  it('ignores tags that are not release tags', () => {
    const noise = ['v2.0.0-beta.1', 'v3', 'v9.9', 'v01.0.0', 'release-v9.0.0', 'V9.0.0', 'v1.4.0.1', 'v65536.0.0', 'vnext'];
    assertLatest('v1.5.0', ['v1.4.0', 'v1.5.0', ...noise], true);
  });

  it('counts the tag itself, whose release the workflow creates afterwards', () => {
    assertLatest('v1.5.0', ['v1.4.0'], true);
    assertLatest('v1.4.2', ['v1.5.0'], false);
  });

  it('marks the first release Latest', () => {
    for (const input of ['', '\n']) {
      const result = isLatest('v1.0.0', input);
      assert.equal(result.stdout, 'true\n', result.output);
    }
  });

  it('reads CRLF line endings and padded lines', () => {
    const result = isLatest('v1.5.0', 'v1.5.0\r\n  v1.6.0  \r\n');
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout, 'false\n');
  });

  it('exits 1 without an answer on a tag that is not a release tag, or on wrong arguments', () => {
    for (const tag of ['v1.4', '1.4.1', 'v1.4.1-rc.1', '']) {
      const result = isLatest(tag, lines(['v1.4.0']));
      assert.equal(result.code, 1, result.output);
      assert.match(result.stderr, /is not a release tag/);
      assert.equal(result.stdout, '');
    }
    for (const args of [[], ['v1.4.1', 'v1.4.2']]) {
      const result = isLatest(args, lines(['v1.4.0']));
      assert.equal(result.code, 1, result.output);
      assert.match(result.stderr, /Usage:/);
      assert.equal(result.stdout, '');
    }
  });
});
