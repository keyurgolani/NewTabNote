#!/usr/bin/env node

/**
 * Release check for license notices and the privacy policy. Run after
 * `npm run package`; reads the packaged zip with the vendored JSZip.
 *
 * Fails when:
 * - the zip lacks LICENSE or THIRD_PARTY_NOTICES at its root, or they differ from the repository copies;
 * - a js/lib file is missing from the zip or differs from its source (headers included);
 * - PRIVACY_POLICY.md's "## Permissions" bullets (`- **<permission>**: <use>`) differ from
 *   manifest.json `permissions`, or a host permission isn't described;
 * - PRIVACY_POLICY.md doesn't name a network destination the code uses;
 * - js/lib/README.md lacks a License entry for a js/lib file.
 *
 * Usage: node scripts/check-notices.js [path/to/package.zip]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('../js/lib/jszip.min.js');

const ROOT = path.join(__dirname, '..');
const NOTICE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES'];
const VENDOR_DIR = 'js/lib';
const VENDOR_SKIP = new Set(['README.md']);

/** Network destinations the extension's code can contact, which the policy must name. */
const REQUIRED_DESTINATIONS = [
  'huggingface.co',
  'cdn.jsdelivr.net',
  'google.com/s2/favicons',
  'youtube.com',
  'player.vimeo.com',
  'http://localhost',
];

/**
 * Library files under js/lib (the README is documentation, not shipped).
 * @param {string} [root]
 * @returns {string[]}
 */
function vendoredFiles(root = ROOT) {
  return fs.readdirSync(path.join(root, VENDOR_DIR))
    .filter((name) => !VENDOR_SKIP.has(name) && fs.statSync(path.join(root, VENDOR_DIR, name)).isFile())
    .sort();
}

/**
 * Text of a "## Heading" section, up to the next level-2 heading.
 * @param {string} markdown
 * @param {string} heading
 * @returns {string|null}
 */
function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return lines.slice(start + 1, end).join('\n');
}

/**
 * Permission names from the policy's `- **<permission>**: <use>` bullets.
 * @param {string} policy
 * @returns {{names: string[], malformed: string[]}}
 */
function policyPermissions(policy) {
  const body = section(policy, 'Permissions') || '';
  const names = [];
  const malformed = [];
  for (const line of body.split(/\r?\n/)) {
    if (!/^\s*[-*]\s/.test(line)) continue;
    const match = line.match(/^- \*\*([^*]+)\*\*: (\S.*)$/);
    if (match) names.push(match[1].trim());
    else malformed.push(line.trim());
  }
  return { names, malformed };
}

/**
 * Hostname a host permission pattern grants, e.g. "https://api.openai.com/*" -> "api.openai.com".
 * @param {string} pattern
 * @returns {string}
 */
function hostOf(pattern) {
  return pattern.replace(/^[a-z*]+:\/\//, '').replace(/\/.*$/, '').replace(/:\*$/, '');
}

/**
 * @param {string} policy - PRIVACY_POLICY.md
 * @param {{permissions?: string[], host_permissions?: string[]}} manifest
 * @returns {string[]} Problems
 */
function checkPolicy(policy, manifest) {
  const problems = [];
  if (section(policy, 'Permissions') === null) {
    return ['PRIVACY_POLICY.md has no "## Permissions" section'];
  }
  const { names, malformed } = policyPermissions(policy);
  for (const line of malformed) {
    problems.push(`PRIVACY_POLICY.md permission bullet isn't "- **<permission>**: <use>": ${line}`);
  }
  const declared = manifest.permissions || [];
  for (const permission of declared) {
    if (!names.includes(permission)) problems.push(`PRIVACY_POLICY.md doesn't list the "${permission}" permission`);
  }
  for (const name of names) {
    if (!declared.includes(name)) problems.push(`PRIVACY_POLICY.md lists "${name}", which manifest.json doesn't request`);
  }
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  for (const name of new Set(duplicates)) problems.push(`PRIVACY_POLICY.md lists "${name}" more than once`);

  for (const pattern of manifest.host_permissions || []) {
    if (!policy.includes(hostOf(pattern))) problems.push(`PRIVACY_POLICY.md doesn't describe the host permission ${pattern}`);
  }
  for (const destination of REQUIRED_DESTINATIONS) {
    if (!policy.includes(destination)) problems.push(`PRIVACY_POLICY.md doesn't name the network destination ${destination}`);
  }
  return problems;
}

/**
 * @param {string} readme - js/lib/README.md
 * @param {string[]} files - js/lib file names
 * @returns {string[]} Problems
 */
function checkLibReadme(readme, files) {
  const rows = readme.split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
  const header = rows[0] || [];
  const fileColumn = header.findIndex((cell) => cell.toLowerCase() === 'file');
  const licenseColumn = header.findIndex((cell) => cell.toLowerCase() === 'license');
  if (fileColumn === -1 || licenseColumn === -1) {
    return ['js/lib/README.md has no table with File and License columns'];
  }
  const problems = [];
  for (const file of files) {
    const row = rows.find((cells) => (cells[fileColumn] || '').replace(/`/g, '') === file);
    if (!row) problems.push(`js/lib/README.md has no row for ${file}`);
    else if (!row[licenseColumn] || /^-+$/.test(row[licenseColumn])) problems.push(`js/lib/README.md gives no license for ${file}`);
  }
  return problems;
}

/**
 * @param {Buffer} zipBuffer - The packaged extension
 * @param {string} [root] - Repository root holding the source files
 * @returns {Promise<string[]>} Problems
 */
async function checkZip(zipBuffer, root = ROOT) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const problems = [];
  const compare = async (entryName, sourcePath, label) => {
    const entry = zip.file(entryName);
    if (!entry) {
      problems.push(`the package has no ${label}`);
      return;
    }
    const packaged = await entry.async('nodebuffer');
    if (!packaged.equals(fs.readFileSync(sourcePath))) problems.push(`${label} in the package differs from ${path.relative(root, sourcePath)}`);
  };
  for (const name of NOTICE_FILES) {
    await compare(name, path.join(root, name), `${name} at its root`);
  }
  for (const name of vendoredFiles(root)) {
    await compare(`${VENDOR_DIR}/${name}`, path.join(root, VENDOR_DIR, name), `${VENDOR_DIR}/${name}`);
  }
  return problems;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const zipPath = process.argv[2] || path.join(ROOT, 'releases', `new-tab-note-v${manifest.version}.zip`);
  if (!fs.existsSync(zipPath)) {
    console.error(`check:notices failed: no package at ${path.relative(ROOT, zipPath)}. Run \`npm run build && npm run package\` first.`);
    process.exit(1);
  }

  const problems = [
    ...(await checkZip(fs.readFileSync(zipPath))),
    ...checkPolicy(fs.readFileSync(path.join(ROOT, 'PRIVACY_POLICY.md'), 'utf8'), manifest),
    ...checkLibReadme(fs.readFileSync(path.join(ROOT, VENDOR_DIR, 'README.md'), 'utf8'), vendoredFiles()),
  ];

  if (problems.length > 0) {
    console.error(`check:notices failed with ${problems.length} problem(s):`);
    problems.forEach((problem) => console.error(`  - ${problem}`));
    process.exit(1);
  }
  console.log(`check:notices passed: ${path.relative(ROOT, zipPath)} carries ${NOTICE_FILES.join(' and ')} and `
    + `${vendoredFiles().length} unmodified js/lib files; the privacy policy and js/lib/README.md match.`);
}

module.exports = { REQUIRED_DESTINATIONS, vendoredFiles, policyPermissions, checkPolicy, checkLibReadme, checkZip };

if (require.main === module) {
  main().catch((error) => {
    console.error('check:notices failed:', error);
    process.exit(1);
  });
}
