#!/usr/bin/env node
// Writes test/fixtures/releases/manifest.json (#28 slice 3, #301): each public release's tag, the
// commit the tag points at, and each asset GitHub serves for it, with the size and the SHA-256 the
// releases API reports. Nothing is downloaded. #30's release corpus checks the zips it downloads
// against these hashes, and test/release-manifest.test.js holds every entry to its tag. Run it by
// hand, after `git fetch --tags`, once a release is published:
//
//   node scripts/fixtures/release-manifest.mjs
//
// It reads the releases through `gh api`, so gh has to be signed in to GitHub. Each release takes
// a line of its own and each asset one line, so a new release's entry reads as a few lines in review.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'fixtures', 'releases', 'manifest.json');
const REPO = 'keyurgolani/NewTabNote';
const ABOUT =
  'Each public release of NewTabNote: its tag, the commit the tag points at, and each asset GitHub serves for it, ' +
  'with the size and SHA-256 the releases API reports. scripts/fixtures/release-manifest.mjs writes it, and nothing ' +
  "is downloaded to make it. #30's release corpus checks the zips it downloads against these hashes, and " +
  'test/release-manifest.test.js holds every entry to its tag.';

/** @param {string} command @param {string[]} args */
const read = (command, args) => execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' });
/** @param {string} tag */
const version = tag => tag.slice(1).split('.').map(Number);

/** @type {Array<{tag_name: string, draft: boolean, prerelease: boolean, assets: Array<{name: string, size: number, digest?: string}>}>} */
const listed = JSON.parse(read('gh', ['api', '--paginate', '--slurp', `repos/${REPO}/releases?per_page=100`])).flat();
const releases = listed
  .filter(release => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
  .map(release => ({
    tag: release.tag_name,
    commit: read('git', ['rev-parse', `${release.tag_name}^{commit}`]).trim(),
    assets: release.assets
      .map(asset => {
        if (!/^sha256:[0-9a-f]{64}$/.test(asset.digest || '')) {
          throw new Error(`${release.tag_name}'s ${asset.name} has no SHA-256 digest in the releases API`);
        }
        return { name: asset.name, size: asset.size, sha256: String(asset.digest).slice('sha256:'.length) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  }))
  .sort((a, b) => {
    const [x, y] = [version(a.tag), version(b.tag)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });

const lines = ['{', `  "about": ${JSON.stringify(ABOUT)},`, '  "releases": ['];
releases.forEach((release, i) => {
  lines.push(`    { "tag": ${JSON.stringify(release.tag)}, "commit": ${JSON.stringify(release.commit)}, "assets": [`);
  release.assets.forEach((asset, j) => lines.push(`      ${JSON.stringify(asset)}${j < release.assets.length - 1 ? ',' : ''}`));
  lines.push(`    ] }${i < releases.length - 1 ? ',' : ''}`);
});
lines.push('  ]', '}');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
console.log(`release-manifest: ${releases.length} releases, ${releases[0].tag} to ${releases.at(-1)?.tag}, written to ${path.relative(ROOT, OUT)}`);
