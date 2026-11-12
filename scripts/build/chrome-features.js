'use strict';

/**
 * The Chrome features check (#300, from #27's Toolchain and AC10). build/chrome-features.json lists
 * each Chrome API and web feature first-party code uses, with the first Chrome version that has it
 * and the public page that gives it: Chrome's extension API reference, or MDN's compatibility data
 * on the page named. Before it bundles, the build scans the first-party sources, js/ but js/lib/ and
 * css/, for each chrome.* member and each web global scripts/build/js-scan.js reads (featureOf,
 * WEB_GLOBALS), and each CSS at-rule of AT_RULES. manifest.json's minimum_chrome_version has to be
 * at least the highest row, which is the bundler's target (scripts/build/vite-config.js).
 *   chrome/feature  a feature the sources read with no row, chrome read whole among them
 *   chrome/version  a row above manifest.json's minimum_chrome_version
 *   chrome/file     build/chrome-features.json is missing, doesn't parse, or doesn't read as the table
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {{version: number, source: string}} FeatureRow */

const ROOT = path.join(__dirname, '..', '..');
const TABLE_FILE = 'build/chrome-features.json';
/** The CSS at-rules the scan reads: ones Chrome added late enough that a use could raise the version the extension needs */
const AT_RULES = Object.freeze(['@container', '@property', '@layer', '@scope', '@starting-style', '@counter-style', '@font-palette-values', '@view-transition', '@position-try']);
/** Where a row's version comes from: a page of Chrome's extension API reference or of MDN */
const SOURCE = /^https:\/\/(developer\.chrome\.com|developer\.mozilla\.org)\//;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The problems with the table's shape, before it's used
 * @param {unknown} table
 * @returns {Problem[]}
 */
function tableProblems(table) {
  /** @type {Problem[]} */
  const problems = [];
  const fail = (/** @type {string} */ message) => problems.push(problem('chrome/file', TABLE_FILE, message));
  const rows = isObject(table) ? table.rows : undefined;
  if (!isObject(table) || !isObject(rows)) {
    fail('has no rows');
    return problems;
  }
  if (typeof table.about !== 'string' || table.about === '') fail('has no about text');
  for (const [name, row] of Object.entries(rows)) {
    if (!isObject(row)) {
      fail(`row ${name} isn't an object`);
      continue;
    }
    const extra = Object.keys(row).filter((key) => key !== 'version' && key !== 'source');
    if (extra.length > 0) fail(`row ${name} has ${extra.join(', ')}, which a row doesn't take`);
    if (!Number.isSafeInteger(row.version) || /** @type {number} */ (row.version) < 1) fail(`row ${name}'s version isn't a whole number`);
    if (typeof row.source !== 'string' || !SOURCE.test(row.source)) fail(`row ${name} names no page of Chrome's extension API reference or MDN that gives its version`);
  }
  return problems;
}

/**
 * Read build/chrome-features.json from `root`. It has no rows when it has a problem.
 * @param {string} [root]
 * @returns {{rows: Record<string, FeatureRow>, problems: Problem[]}}
 */
function readTable(root = ROOT) {
  const file = path.join(root, TABLE_FILE);
  if (!fs.existsSync(file)) return { rows: {}, problems: [problem('chrome/file', TABLE_FILE, 'is missing')] };
  /** @type {unknown} */
  let table;
  try {
    table = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { rows: {}, problems: [problem('chrome/file', TABLE_FILE, `doesn't parse: ${error instanceof Error ? error.message : error}`)] };
  }
  const problems = tableProblems(table);
  if (problems.length > 0) return { rows: {}, problems };
  return { rows: /** @type {Record<string, FeatureRow>} */ (/** @type {{rows: unknown}} */ (table).rows), problems };
}

/**
 * The highest row's version, or 0 for a table with none
 * @param {Record<string, FeatureRow>} rows
 * @returns {number}
 */
function highestVersion(rows) {
  return Object.values(rows).reduce((highest, row) => Math.max(highest, row.version), 0);
}

/**
 * A problem for each row above manifest.json's minimum_chrome_version. A minimum that isn't a
 * whole number is build/manifest's to report.
 * @param {unknown} minimum
 * @param {Record<string, FeatureRow>} rows
 * @returns {Problem[]}
 */
function versionProblems(minimum, rows) {
  if (typeof minimum !== 'string' || !/^\d+$/.test(minimum)) return [];
  const highest = highestVersion(rows);
  return Object.keys(rows).sort().filter((name) => rows[name].version > Number(minimum)).map((name) => problem('chrome/version', name,
    `its first Chrome version, ${rows[name].version}, is above manifest.json's minimum_chrome_version, ${minimum}. Raise minimum_chrome_version to ${highest}, or don't use it.`));
}

/**
 * Every file under `dir` in `root`, as a path from `root`, and none when it isn't there
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(root, dir) {
  if (!fs.existsSync(path.join(root, dir))) return [];
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(root, file) : [file];
  });
}

/**
 * The sources the scan reads: the scripts under js/ but js/lib/, which is vendored, and the
 * stylesheets under css/
 * @param {string} [root]
 * @returns {Array<{file: string, text: string}>}
 */
function firstPartySources(root = ROOT) {
  const scripts = filesUnder(root, 'js').filter((file) => /\.m?js$/.test(file) && !file.startsWith('js/lib/'));
  const sheets = filesUnder(root, 'css').filter((file) => file.endsWith('.css'));
  return [...scripts, ...sheets].sort().map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));
}

/**
 * Each feature `sources` read, with where: line:column in a script, the line in a stylesheet
 * @param {Array<{file: string, text: string}>} sources
 * @returns {Record<string, string[]>}
 */
function featuresOf(sources) {
  const { scanScript } = require('./js-scan.js');
  /** @type {Record<string, string[]>} */
  const found = {};
  const add = (/** @type {string} */ name, /** @type {string} */ at) => (found[name] ||= []).push(at);
  for (const { file, text } of sources) {
    if (!file.endsWith('.css')) {
      for (const { name, at } of scanScript(file, text).features) add(name, `${file}:${at}`);
      continue;
    }
    // An at-rule starts a statement, out of a comment
    const uncommented = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
    for (const match of uncommented.matchAll(/(^|[\s{};])@([a-z][a-z-]*)/gi)) {
      const name = `@${match[2].toLowerCase()}`;
      if (AT_RULES.includes(name)) add(name, `${file}:${uncommented.slice(0, match.index + match[1].length).split('\n').length}`);
    }
  }
  return found;
}

/**
 * A problem for each feature `sources` read that has no row, at its first read
 * @param {Array<{file: string, text: string}>} sources
 * @param {Record<string, FeatureRow>} rows
 * @returns {Problem[]}
 */
function checkChromeFeatures(sources, rows) {
  const found = featuresOf(sources);
  return Object.keys(found).sort().filter((name) => !Object.hasOwn(rows, name)).map((name) => problem('chrome/feature', found[name][0], name === 'chrome'
    ? `chrome read whole, which hides the members it reaches from ${TABLE_FILE}. Read each member as chrome.<namespace>.<member>.`
    : `${name}, which ${TABLE_FILE} has no row for, read ${found[name].length === 1 ? 'here' : `here and in ${found[name].length - 1} more places`}. Add its row, with the first Chrome version that has it and the page that gives it.`));
}

/**
 * The table's checks on the sources at `root`: a row above the manifest's minimum_chrome_version,
 * which manifestProblems reads the shape of, and a feature with no row
 * @param {string} root
 * @param {Record<string, FeatureRow>} rows
 * @returns {Problem[]}
 */
function chromeProblems(root, rows) {
  /** @type {unknown} */
  let minimum;
  try {
    minimum = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).minimum_chrome_version;
  } catch {
    // A manifest that doesn't read is build/manifest's
  }
  return [...versionProblems(minimum, rows), ...checkChromeFeatures(firstPartySources(root), rows)];
}

module.exports = { readTable, tableProblems, highestVersion, versionProblems, firstPartySources, featuresOf, checkChromeFeatures, chromeProblems, TABLE_FILE, AT_RULES };
