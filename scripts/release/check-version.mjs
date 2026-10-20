#!/usr/bin/env node

/**
 * Release preflight: a release tag must be `v` plus the version every release file declares.
 *
 *   node scripts/release/check-version.mjs <tag>
 *       compares the tag with manifest.json, package.json, and both version fields in
 *       package-lock.json (top level and packages[""]) at the repository root
 *   node scripts/release/check-version.mjs <tag> --manifest <path>
 *       compares the tag with one manifest.json, such as the one inside a release zip
 *   node scripts/release/check-version.mjs <tag> --format-only
 *       checks only that the tag is a release tag, before anything else uses it
 *
 * The part after `v` is MAJOR.MINOR.PATCH, each a number from 0 to 65535 with no leading
 * zero, so both npm and Chrome accept it (tag.mjs). Exits 1 naming every field that differs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TAG_FORM, versionFromTag } from './tag.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = 'Usage: node scripts/release/check-version.mjs <tag> [--manifest <path> | --format-only]';

class Refusal extends Error {}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Refusal(`can't read ${label} (${error.code || error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Refusal(`${label} is not valid JSON (${error.message})`);
  }
}

/**
 * Every version field a tag must match, as [label, value] pairs
 */
function versionFields(manifestPath) {
  if (manifestPath !== undefined) {
    return [[`${manifestPath} version`, readJson(path.resolve(manifestPath), manifestPath).version]];
  }
  const manifest = readJson(path.join(ROOT_DIR, 'manifest.json'), 'manifest.json');
  const pkg = readJson(path.join(ROOT_DIR, 'package.json'), 'package.json');
  const lock = readJson(path.join(ROOT_DIR, 'package-lock.json'), 'package-lock.json');
  return [
    ['manifest.json version', manifest.version],
    ['package.json version', pkg.version],
    ['package-lock.json version', lock.version],
    ['package-lock.json packages[""].version', lock.packages?.['']?.version],
  ];
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { manifest: { type: 'string' }, 'format-only': { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new Refusal(`${error.message}\n${USAGE}`);
  }
  const { manifest, 'format-only': formatOnly } = parsed.values;
  if (parsed.positionals.length !== 1 || (manifest !== undefined && formatOnly)) throw new Refusal(USAGE);

  const [tag] = parsed.positionals;
  const version = versionFromTag(tag);
  if (version === null) {
    throw new Refusal(`${JSON.stringify(tag)} is not a release tag. Expected ${TAG_FORM}.`);
  }
  if (formatOnly) {
    console.log(`✓ ${tag} is a release tag`);
    return;
  }

  const fields = versionFields(manifest);
  const mismatches = fields.filter(([, value]) => value !== version);
  if (mismatches.length > 0) {
    const lines = mismatches.map(([label, value]) => `   ${label} is ${value === undefined ? 'missing' : JSON.stringify(value)}`);
    throw new Refusal(`Tag ${tag} names version ${version}, but:\n${lines.join('\n')}`);
  }

  console.log(`✓ ${tag} matches ${fields.map(([label]) => label).join(', ')}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  console.error(`✗ ${error.message}`);
  console.error('See "Publishing a release" in docs/release-plan.md.');
  process.exitCode = 1;
}
