#!/usr/bin/env node

/**
 * Release check for license notices and the privacy policy. Run after
 * `npm run package`; reads the packaged zip with the vendored JSZip.
 *
 * Fails when:
 * - the zip lacks LICENSE or THIRD_PARTY_NOTICES at its root, or they differ from the repository copies;
 * - a js/lib file that ships as a file, Valibot's license included, is missing from the zip (the
 *   bundler folds Valibot's build into the chunks that import it, so that one ships as code)
 *   or differs from its source (headers included);
 * - PRIVACY_POLICY.md's "## Permissions" bullets (`- **<permission>**: <use>`) differ from
 *   manifest.json `permissions`, or a host permission isn't described;
 * - PRIVACY_POLICY.md doesn't name a network destination the code uses;
 * - js/lib/README.md lacks a License entry for a js/lib file;
 * - a vendored file lost its license banner, a file under js/lib differs from its
 *   js/lib/vendor.json record or has none, or the zip holds a source map or a sourceMappingURL
 *   comment (#27 AC9, scripts/build/notices.js).
 *
 * Usage: node scripts/check-notices.js [path/to/package.zip]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('../js/lib/jszip.min.js');
const { format } = require('./build/diagnostics.js');
const { fromZip } = require('./build/package-files.js');
const { checkBanners, checkSourceMaps, checkVendor } = require('./build/notices.js');

const ROOT = path.join(__dirname, '..');
const NOTICE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES'];
const VENDOR_DIR = 'js/lib';
/** js/lib files that don't ship: this README, the vendor records, and Valibot's type declarations */
const VENDOR_SKIP = new Set(['README.md', 'vendor.json', 'valibot/index.d.mts', 'valibot/vendor.json']);
/**
 * js/lib modules the bundler folds into the chunks that import them (#27 slice 2), so they ship
 * as code and not as files. The build checks each against its record and its notice
 * (checkBundledVendor in scripts/build/notices.js).
 */
const BUNDLED = new Set(['valibot/index.mjs']);

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
 * Library files under js/lib that ship, relative to it, subdirectories included (VENDOR_SKIP
 * lists the ones that don't).
 * @param {string} [root]
 * @returns {string[]}
 */
function vendoredFiles(root = ROOT) {
  const files = [];
  const walk = (prefix) => {
    for (const entry of fs.readdirSync(path.join(root, VENDOR_DIR, prefix), { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && !VENDOR_SKIP.has(name)) files.push(name);
    }
  };
  walk('');
  return files.sort();
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
 * A row whose File cell names a directory (`valibot/`) covers every file under it.
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
  const covers = (cell, file) => cell === file || (cell.endsWith('/') && file.startsWith(cell));
  for (const file of files) {
    const row = rows.find((cells) => covers((cells[fileColumn] || '').replace(/`/g, ''), file));
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
  for (const name of shippedFiles(root)) {
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

  const zip = fs.readFileSync(zipPath);
  const files = fromZip(zip, 'the package');
  const problems = [
    ...(await checkZip(zip)),
    // #27 AC9. #33's checkZip already covers LICENSE and THIRD_PARTY_NOTICES at the root.
    ...[...checkBanners(files), ...checkSourceMaps(files), ...checkVendor(files)].map(format),
    ...checkPolicy(fs.readFileSync(path.join(ROOT, 'PRIVACY_POLICY.md'), 'utf8'), manifest),
    ...checkLibReadme(fs.readFileSync(path.join(ROOT, VENDOR_DIR, 'README.md'), 'utf8'), vendoredFiles()),
  ];

  if (problems.length > 0) {
    console.error(`check:notices failed with ${problems.length} problem(s):`);
    problems.forEach((problem) => console.error(`  - ${problem}`));
    process.exit(1);
  }
  console.log(`check:notices passed: ${path.relative(ROOT, zipPath)} carries ${NOTICE_FILES.join(' and ')} and `
    + `${shippedFiles().length} js/lib files as committed and recorded, with their license banners and no source map; the privacy policy and js/lib/README.md match.`);
}

/**
 * The js/lib files that ship as files: every vendored file but the ones the bundler folds in
 * @param {string} [root]
 * @returns {string[]}
 */
function shippedFiles(root = ROOT) {
  return vendoredFiles(root).filter((name) => !BUNDLED.has(name));
}

module.exports = { REQUIRED_DESTINATIONS, BUNDLED, vendoredFiles, shippedFiles, policyPermissions, checkPolicy, checkLibReadme, checkZip };

if (require.main === module) {
  main().catch((error) => {
    console.error('check:notices failed:', error);
    process.exit(1);
  });
}
