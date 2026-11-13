'use strict';

// test/fixtures/releases/manifest.json (#28 slice 3, #301): each public release's tag, commit and
// assets, with the SHA-256 #30's release corpus checks its downloads against. Every entry holds to
// its tag in this clone. CI's unit job fetches the tags and sets NTN_RELEASE_TAGS, so there a tag
// with no entry, or an entry with no tag, fails; a clone without the tags skips those checks.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'releases', 'manifest.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

describe("the releases manifest", () => {
  it('lists each release once, in version order, with its commit and each asset its name, size and SHA-256', () => {
    assert.equal(typeof MANIFEST.about, 'string');
    const tags = MANIFEST.releases.map(release => release.tag);
    assert.deepEqual(tags, [...new Set(tags)], 'a tag is listed once');
    const order = tag => tag.slice(1).split('.').map(Number);
    assert.deepEqual([...tags].sort((a, b) => order(a).reduce((d, n, i) => d || n - order(b)[i], 0)), tags, 'in version order');
    for (const { tag, commit, assets } of MANIFEST.releases) {
      assert.match(tag, /^v\d+\.\d+\.\d+$/);
      assert.match(commit, /^[0-9a-f]{40}$/, `${tag}'s commit`);
      assert.ok(assets.length > 0, `${tag} has an asset`);
      for (const asset of assets) {
        assert.match(asset.name, new RegExp(`^new-tab-note-${tag.replaceAll('.', '\\.')}\\.(zip|crx|zip\\.sha256)$`), `${tag}'s asset ${asset.name} names its release`);
        assert.ok(Number.isInteger(asset.size) && asset.size > 0, `${asset.name}'s size`);
        assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${asset.name}'s SHA-256`);
      }
    }
    // #28: 1.1.0 shipped only a .crx, which the recorder strips of its header
    assert.deepEqual(MANIFEST.releases.find(release => release.tag === 'v1.1.0').assets.map(asset => asset.name), ['new-tab-note-v1.1.0.crx']);
  });

  it("has CI's unit job fetch every listed tag and the next major's, so a 2.0.0 entry finds its tag there", () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pr-checks.yml'), 'utf8');
    const fetches = [...workflow.matchAll(/'\+refs\/tags\/([^:']+):refs\/tags\/\1'/g)].map((match) => match[1]);
    assert.equal(fetches.length, 1, "one tag fetch, the unit job's");
    const takes = new RegExp(`^${fetches[0].replaceAll('.', '\\.').replaceAll('*', '.*')}$`);
    const wanted = [...MANIFEST.releases.map((release) => release.tag), 'v2.0.0'];
    assert.deepEqual(wanted.filter((tag) => !takes.test(tag)), [], `the unit job fetches only ${fetches[0]}`);
  });

  it("holds every entry to its tag's commit, and lists every release tag but the newest, which may wait for its entry PR", (t) => {
    const local = git('tag', '--list', 'v*').split('\n').filter(tag => /^v\d+\.\d+\.\d+$/.test(tag));
    if (local.length === 0) {
      assert.notEqual(process.env.NTN_RELEASE_TAGS, 'required', "this clone has no release tags, and NTN_RELEASE_TAGS requires them");
      t.skip('this clone has no release tags: run `git fetch --tags` to check the manifest against them');
      return;
    }
    const listed = MANIFEST.releases.map(release => release.tag);
    const order = tag => tag.slice(1).split('.').map(Number);
    const newest = [...local].sort((a, b) => order(a).reduce((d, n, i) => d || n - order(b)[i], 0)).at(-1);
    // Tagging a release mustn't turn every PR red, so the newest tag's entry may land in a PR of its own
    if (!listed.includes(newest)) t.diagnostic(`${newest}, the newest release tag, has no entry yet, which only the newest may lack until its entry PR lands`);
    assert.deepEqual(local.filter(tag => !listed.includes(tag) && tag !== newest), [],
      `release tags with no entry: run scripts/fixtures/release-manifest.mjs. Only the newest tag, ${newest}, may wait for its entry PR`);
    for (const { tag, commit } of MANIFEST.releases) {
      if (!local.includes(tag)) {
        assert.notEqual(process.env.NTN_RELEASE_TAGS, 'required', `${tag} isn't in this clone, and NTN_RELEASE_TAGS requires it`);
        continue;
      }
      assert.equal(git('rev-parse', `${tag}^{commit}`), commit, `${tag}'s commit`);
    }
  });
});
