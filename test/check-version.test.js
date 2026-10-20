const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release', 'check-version.mjs');

// The four fields a release tag must match, with how to set each in a fixture
const FIELDS = {
  'manifest.json version': (files, version) => { files['manifest.json'].version = version; },
  'package.json version': (files, version) => { files['package.json'].version = version; },
  'package-lock.json version': (files, version) => { files['package-lock.json'].version = version; },
  'package-lock.json packages[""].version': (files, version) => { files['package-lock.json'].packages[''].version = version; },
};

const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-check-version-'));
  temps.push(dir);
  return dir;
}

/**
 * A repository root holding the script and release files at `version`, after `edit`
 * changes them. Returns the copied script's path.
 */
function tree(version, edit = () => {}) {
  const dir = tempDir();
  const files = {
    'manifest.json': { manifest_version: 3, name: 'NewTabNote', version },
    'package.json': { name: 'new-tab-note', version, private: true },
    'package-lock.json': { name: 'new-tab-note', version, lockfileVersion: 3, packages: { '': { name: 'new-tab-note', version } } },
  };
  edit(files);
  for (const [name, json] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof json === 'string' ? json : `${JSON.stringify(json, null, 2)}\n`);
  }
  const script = path.join(dir, 'scripts', 'release', 'check-version.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(SCRIPT, script);
  return script;
}

function check(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

function assertRefused(result, pattern) {
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, pattern);
  assert.match(result.stderr, /See "Publishing a release" in docs\/release-plan\.md\./);
  assert.equal(result.stdout, '');
}

describe('check-version.mjs on the repository files', () => {
  it('passes when the tag is v plus the version in every field', () => {
    const result = check(tree('1.4.1'), ['v1.4.1']);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout, `✓ v1.4.1 matches ${Object.keys(FIELDS).join(', ')}\n`);
  });

  it("passes on this repository's own release files", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const result = check(SCRIPT, [`v${version}`]);
    assert.equal(result.code, 0, result.output);
  });

  it('accepts each version part up to 65535', () => {
    assert.equal(check(tree('65535.0.0'), ['v65535.0.0']).code, 0);
    assert.equal(check(tree('0.0.65535'), ['v0.0.65535']).code, 0);
  });

  for (const [field, set] of Object.entries(FIELDS)) {
    it(`fails naming ${field} when only it differs from the tag`, () => {
      const result = check(tree('1.4.1', files => set(files, '1.4.0')), ['v1.4.1']);
      assertRefused(result, /Tag v1\.4\.1 names version 1\.4\.1, but:/);
      const named = Object.keys(FIELDS).filter(label => result.stderr.includes(`   ${label} is `));
      assert.deepEqual(named, [field]);
      assert.ok(result.stderr.includes(`   ${field} is "1.4.0"`), result.stderr);
    });

    it(`fails when ${field} is missing`, () => {
      const result = check(tree('1.4.1', files => set(files, undefined)), ['v1.4.1']);
      assertRefused(result, new RegExp(`${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is missing`));
    });
  }

  it('fails naming every field when the tag names another version', () => {
    const result = check(tree('1.4.1'), ['v1.4.2']);
    assertRefused(result, /Tag v1\.4\.2 names version 1\.4\.2, but:/);
    for (const field of Object.keys(FIELDS)) assert.ok(result.stderr.includes(`   ${field} is "1.4.1"`), result.stderr);
  });

  it('fails when a field holds the version as a number', () => {
    const result = check(tree('1.4.1', files => { files['manifest.json'].version = 1.4; }), ['v1.4.1']);
    assertRefused(result, /manifest\.json version is 1\.4\n/);
  });

  it('fails when a release file is missing or not JSON', () => {
    let result = check(tree('1.4.1', files => { files['package.json'] = '{ "version": '; }), ['v1.4.1']);
    assertRefused(result, /package\.json is not valid JSON/);

    const script = tree('1.4.1');
    fs.rmSync(path.join(path.dirname(script), '..', '..', 'package-lock.json'));
    result = check(script, ['v1.4.1']);
    assertRefused(result, /can't read package-lock\.json \(ENOENT\)/);
  });
});

describe('check-version.mjs on malformed tags', () => {
  const MALFORMED = [
    '1.4.1', 'V1.4.1', 'v1.4', 'v1', 'v', '', 'v1.4.1.0', 'v1.4.1-beta.1', 'v1.4.1+build.5', 'v01.4.1', 'v1.04.1',
    'v1.4.01', 'v65536.0.0', 'v1.65536.0', 'v1.4.x', 'v1..4', ' v1.4.1', 'v1.4.1 ', 'v1.4.1\n', 'refs/tags/v1.4.1',
    'release-v1.4.1', 'v1.4.1/x', 'v１.4.1',
  ];

  for (const tag of MALFORMED) {
    it(`refuses ${JSON.stringify(tag)}`, () => {
      // Every field holds the version the tag seems to name, so only the tag's form fails
      const version = tag.replace(/^\D*/, '').trim() || '1.4.1';
      const result = check(tree(version), [tag]);
      assertRefused(result, /is not a release tag\. Expected v<major>\.<minor>\.<patch>, each part 0 to 65535 with no leading zero/);
      assert.ok(result.stderr.includes(JSON.stringify(tag)), result.stderr);
    });
  }
});

describe('check-version.mjs --manifest', () => {
  function manifest(json) {
    const file = path.join(tempDir(), 'manifest.json');
    fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
    return file;
  }

  it('compares the tag with only that manifest', () => {
    // The repository files disagree with the tag, and only the given manifest counts
    const file = manifest({ manifest_version: 3, version: '1.4.1' });
    const result = check(tree('1.0.0'), ['v1.4.1', '--manifest', file]);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout, `✓ v1.4.1 matches ${file} version\n`);
  });

  it('fails naming the manifest when its version differs from the tag', () => {
    const file = manifest({ manifest_version: 3, version: '1.4.0' });
    const result = check(tree('1.4.1'), ['v1.4.1', '--manifest', file]);
    assertRefused(result, new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} version is "1\\.4\\.0"`));
  });

  it('fails on a missing, unreadable, or versionless manifest', () => {
    assertRefused(check(SCRIPT, ['v1.4.1', '--manifest', path.join(tempDir(), 'none.json')]), /can't read .*none\.json \(ENOENT\)/);
    assertRefused(check(SCRIPT, ['v1.4.1', '--manifest', manifest('not json')]), /is not valid JSON/);
    assertRefused(check(SCRIPT, ['v1.4.1', '--manifest', manifest({ manifest_version: 3 })]), /version is missing/);
  });

  it('still refuses a malformed tag', () => {
    assertRefused(check(SCRIPT, ['1.4.1', '--manifest', manifest({ version: '1.4.1' })]), /is not a release tag/);
  });
});

describe('check-version.mjs usage', () => {
  it('fails without exactly one tag or on an unknown option', () => {
    for (const args of [[], ['v1.4.1', 'v1.4.2'], ['v1.4.1', '--manifest'], ['v1.4.1', '--strict']]) {
      const result = check(SCRIPT, args);
      assertRefused(result, /Usage: node scripts\/release\/check-version\.mjs <tag> \[--manifest <path>\]/);
    }
  });
});
