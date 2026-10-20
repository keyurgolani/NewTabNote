#!/usr/bin/env node

/**
 * Whether a release should be marked Latest. Prints `true` when no published release has a
 * higher version than the tag, comparing versions part by part, and `false` otherwise.
 * Reads the published releases' tag names from stdin and ignores any that aren't release
 * tags (tag.mjs).
 *
 *   gh release list --exclude-drafts --exclude-pre-releases --json tagName --jq '.[].tagName' \
 *     | node scripts/release/is-latest.mjs <tag>
 *
 * So a patch tagged on release/R<n> after a newer milestone prints `false` and doesn't take
 * Latest from it. It reads releases rather than tags, so a tag with no release, such as one
 * a failed preflight left behind, doesn't keep Latest off. Exits 1 when <tag> isn't a
 * release tag.
 */

import { compareVersions, TAG_FORM, versionFromTag } from './tag.mjs';

async function main(argv) {
  if (argv.length !== 1) {
    console.error("✗ Usage: git tag --list 'v*' | node scripts/release/is-latest.mjs <tag>");
    return 1;
  }
  const [tag] = argv;
  const version = versionFromTag(tag);
  if (version === null) {
    console.error(`✗ ${JSON.stringify(tag)} is not a release tag. Expected ${TAG_FORM}.`);
    return 1;
  }

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const highest = input
    .split(/\r?\n/)
    .map(line => versionFromTag(line.trim()))
    .filter(Boolean)
    .reduce((max, other) => (compareVersions(other, max) > 0 ? other : max), version);

  const latest = compareVersions(highest, version) === 0;
  console.log(String(latest));
  console.error(latest
    ? `No published release is higher than ${tag}, so its release is marked Latest.`
    : `${tag} is lower than the v${highest} release, so its release isn't marked Latest.`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
