'use strict';

/**
 * The notice, source-map, and vendor checks (#27 AC9, "Third-party code"), over the package's
 * files:
 *   notices/missing-file  LICENSE or THIRD_PARTY_NOTICES isn't at the package root
 *   notices/banner        a vendored file shipped without the license banner its record names
 *   notices/no-entry      a shipped vendored file's package has no THIRD_PARTY_NOTICES heading
 *   source-map/file       the package holds a .map file
 *   source-map/comment    a shipped script, stylesheet, or page has a sourceMappingURL comment
 *   vendor/mismatch       a shipped js/lib/ file isn't the one its js/lib/vendor.json record names
 *   vendor/unlisted       a shipped js/lib/ file has no record
 * The build runs them all on what it's about to write as dist/. npm run check:notices runs all
 * but the first on the zip, beside #33's checks, which compare LICENSE and THIRD_PARTY_NOTICES
 * there with the repository's.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');
const { locator } = require('./markup.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */

/**
 * @typedef {object} VendoredFile
 * @property {string} sha256
 * @property {string | null} banner
 * @property {string} notice - its package's THIRD_PARTY_NOTICES heading, without the number
 */

const ROOT = path.join(__dirname, '..', '..');
const NOTICE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES'];
const LIB = 'js/lib/';
const SOURCE_MAP_COMMENT = /[#@]\s*sourceMappingURL\s*=/;

/**
 * Every vendored file that ships, by its path in the package, from js/lib/vendor.json and the
 * records it points to
 * @param {string} [root]
 * @returns {Map<string, VendoredFile>}
 */
function readVendor(root = ROOT) {
  const record = JSON.parse(fs.readFileSync(path.join(root, LIB, 'vendor.json'), 'utf8'));
  /** @type {Map<string, VendoredFile>} */
  const files = new Map();
  for (const [name, file] of Object.entries(record.files)) {
    files.set(`${LIB}${name}`, { sha256: file.sha256, banner: file.banner, notice: file.notice });
  }
  for (const [dir, entry] of Object.entries(record.records || {})) {
    const nested = JSON.parse(fs.readFileSync(path.join(root, LIB, entry.record), 'utf8'));
    for (const [name, file] of Object.entries(nested.files)) {
      if (file.ships) files.set(`${LIB}${dir}${name}`, { sha256: file.sha256, banner: null, notice: entry.notice });
    }
  }
  return files;
}

/**
 * @param {Buffer} data
 * @returns {string}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * LICENSE and THIRD_PARTY_NOTICES at the package root
 * @param {PackageFiles} files
 * @returns {Problem[]}
 */
function checkNoticeFiles(files) {
  return NOTICE_FILES.filter((name) => !files.has(name))
    .map((name) => problem('notices/missing-file', name, `${files.label} has no ${name} at its root`));
}

/**
 * Each shipped vendored file keeps its banner, and its package has a notice heading
 * @param {PackageFiles} files
 * @param {Map<string, VendoredFile>} [vendor]
 * @returns {Problem[]}
 */
function checkBanners(files, vendor = readVendor()) {
  /** @type {Problem[]} */
  const problems = [];
  const notices = files.has('THIRD_PARTY_NOTICES') ? files.text('THIRD_PARTY_NOTICES') : null;
  const headings = notices === null ? null : new Set([...notices.matchAll(/^\d+\. (.+?)\r?$/gm)].map((match) => match[1]));
  for (const [file, record] of vendor) {
    if (!files.has(file)) continue;
    if (record.banner !== null && !files.text(file).includes(record.banner)) {
      const first = record.banner.split('\n').find((line) => /\w/.test(line)) || record.banner;
      problems.push(problem('notices/banner', file, `shipped without its license banner (${first.replace(/^[\s/*!]+/, '')}). js/lib/ files ship byte for byte (CLASSIC_SCRIPTS in scripts/build/vite-config.js).`));
    }
    if (headings !== null && !headings.has(record.notice)) {
      problems.push(problem('notices/no-entry', file, `THIRD_PARTY_NOTICES has no "${record.notice}" heading for it`));
    }
  }
  return problems;
}

/**
 * No source map ships, and no shipped text names one
 * @param {PackageFiles} files
 * @returns {Problem[]}
 */
function checkSourceMaps(files) {
  /** @type {Problem[]} */
  const problems = [];
  for (const file of files.paths) {
    if (/\.map$/i.test(file)) {
      problems.push(problem('source-map/file', file, 'source maps stay out of the package'));
      continue;
    }
    if (!/\.(?:m?js|css|html?)$/i.test(file)) continue;
    const text = files.text(file);
    const match = SOURCE_MAP_COMMENT.exec(text);
    if (match) {
      problems.push(problem('source-map/comment', `${file}:${locator(text)(match.index)}`, 'names a source map the package doesn\'t ship. Delete the comment, and record the edit in js/lib/vendor.json for a vendored file.'));
    }
  }
  return problems;
}

/**
 * Each shipped js/lib/ file is the one its record names
 * @param {PackageFiles} files
 * @param {Map<string, VendoredFile>} [vendor]
 * @returns {Problem[]}
 */
function checkVendor(files, vendor = readVendor()) {
  /** @type {Problem[]} */
  const problems = [];
  for (const file of files.paths) {
    if (!file.startsWith(LIB)) continue;
    const record = vendor.get(file);
    if (!record) {
      problems.push(problem('vendor/unlisted', file, 'js/lib/vendor.json has no record of it'));
      continue;
    }
    const digest = sha256(files.read(file));
    if (digest !== record.sha256) {
      problems.push(problem('vendor/mismatch', file, `its SHA-256 is ${digest}, and its record says ${record.sha256}. Record a local edit in js/lib/vendor.json, or restore the file.`));
    }
  }
  return problems;
}

/**
 * The vendored modules the bundler folds into chunks, which don't ship as files (#27 slice 2):
 * each one bundled has to be its record's file, and its package needs a THIRD_PARTY_NOTICES
 * heading. Valibot is today's, which the kernel's contracts import.
 * @param {string[]} modules - every source module the bundle holds, by its path in the sources
 * @param {PackageFiles} files - the build, for its THIRD_PARTY_NOTICES
 * @param {string} [root]
 * @param {Map<string, VendoredFile>} [vendor]
 * @returns {Problem[]}
 */
function checkBundledVendor(modules, files, root = ROOT, vendor = readVendor(root)) {
  /** @type {Problem[]} */
  const problems = [];
  const notices = files.has('THIRD_PARTY_NOTICES') ? files.text('THIRD_PARTY_NOTICES') : null;
  const headings = notices === null ? null : new Set([...notices.matchAll(/^\d+\. (.+?)\r?$/gm)].map((match) => match[1]));
  for (const file of modules) {
    if (!file.startsWith(LIB)) continue;
    const record = vendor.get(file);
    if (!record) {
      problems.push(problem('vendor/unlisted', file, 'the bundle holds it, and js/lib/vendor.json has no record of it'));
      continue;
    }
    const digest = sha256(fs.readFileSync(path.join(root, file)));
    if (digest !== record.sha256) {
      problems.push(problem('vendor/mismatch', file, `the bundle holds it with SHA-256 ${digest}, and its record says ${record.sha256}. Record a local edit, or restore the file.`));
    }
    if (headings !== null && !headings.has(record.notice)) {
      problems.push(problem('notices/no-entry', file, `the bundle holds it, and THIRD_PARTY_NOTICES has no "${record.notice}" heading for it`));
    }
  }
  return problems;
}

module.exports = { readVendor, checkNoticeFiles, checkBanners, checkSourceMaps, checkVendor, checkBundledVendor, NOTICE_FILES };
