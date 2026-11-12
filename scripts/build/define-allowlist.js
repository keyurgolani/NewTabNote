'use strict';

/**
 * The define allowlist (#300, from #27's "Security"). The build gets no secrets, and inlines only
 * three named keys, which scripts/build/vite-config.js's define sets itself (process.env.NODE_ENV,
 * __NTN_BUILD_ID__ and the module shim), and the rows of build/define-allowlist.json. A row is a
 * name, which first-party code reads as __NTN_<name>__, with the issue that owns it, the values
 * release, dev and test builds inline, and why it's there. npm run build inlines each row's
 * release value and build:dev its dev value; build:test, with the test values, comes with #301.
 * test/helpers/load-background.js starts the worker with every row at its release value.
 *   define/file      the file is missing, doesn't parse, or doesn't read as a define allowlist
 *   define/unknown   first-party code reads an __NTN_ name with no row (scripts/build/environment.js)
 */

const path = require('node:path');
const { problem } = require('./diagnostics.js');
const { isObject, readList } = require('./json-file.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {'production' | 'development'} Mode */
/**
 * What the build writes, as a literal, in a read's place
 * @typedef {boolean | number | string} DefineValue
 */

/**
 * @typedef {object} DefineRow
 * @property {number} owner - the issue that owns it
 * @property {DefineValue} release - what npm run build inlines
 * @property {DefineValue} dev - what npm run build:dev inlines
 * @property {DefineValue} test - what build:test will inline (#301)
 * @property {string} reason
 */

const ROOT = path.join(__dirname, '..', '..');
const ALLOWLIST_FILE = 'build/define-allowlist.json';
const FIELDS = Object.freeze(['owner', 'release', 'dev', 'test', 'reason']);
/**
 * A row's name: a lowercase letter, then letters and digits, so no row reads as the build's ID's
 * __NTN_BUILD_ID__
 */
const ROW_NAME = /^[a-z][A-Za-z0-9]*$/;

/**
 * The name first-party code reads a row by
 * @param {string} name
 * @returns {string}
 */
function defineName(name) {
  return `__NTN_${name}__`;
}

/**
 * @param {unknown} value
 * @returns {value is DefineValue}
 */
function isValue(value) {
  return typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The problems with the allowlist's shape, before it's used
 * @param {unknown} allowlist
 * @returns {Problem[]}
 */
function fileProblems(allowlist) {
  /** @type {Problem[]} */
  const problems = [];
  const fail = (/** @type {string} */ message) => problems.push(problem('define/file', ALLOWLIST_FILE, message));
  const rows = isObject(allowlist) ? allowlist.rows : undefined;
  if (!isObject(allowlist) || !isObject(rows)) {
    fail('has no rows');
    return problems;
  }
  if (typeof allowlist.about !== 'string' || allowlist.about === '') fail('has no about text');
  for (const [name, row] of Object.entries(rows)) {
    if (!ROW_NAME.test(name)) fail(`row ${name} isn't a name ${defineName('<name>')} reads: a lowercase letter, then letters and digits`);
    if (!isObject(row)) {
      fail(`row ${name} isn't an object`);
      continue;
    }
    const extra = Object.keys(row).filter((key) => !FIELDS.includes(key));
    if (extra.length > 0) fail(`row ${name} has ${extra.join(', ')}, which a row doesn't take`);
    if (!Number.isSafeInteger(row.owner) || /** @type {number} */ (row.owner) < 1) fail(`row ${name} has no owner: the number of the issue that owns it`);
    for (const build of ['release', 'dev', 'test']) {
      if (!isValue(row[build])) fail(`row ${name} has no ${build} value: a boolean, a finite number or a string, which the build inlines as a literal`);
    }
    if (typeof row.reason !== 'string' || row.reason === '') fail(`row ${name} has no reason`);
  }
  return problems;
}

/**
 * Read build/define-allowlist.json from `root`. It has no rows when it has a problem.
 * @param {string} [root]
 * @returns {{rows: Record<string, DefineRow>, problems: Problem[]}}
 */
function readAllowlist(root = ROOT) {
  const { value, problems } = readList(root, ALLOWLIST_FILE, 'define/file', fileProblems);
  return { rows: value === undefined ? {} : /** @type {{rows: Record<string, DefineRow>}} */ (value).rows, problems };
}

/**
 * What the define writes for each row in `mode`: its release value in production and its dev
 * value in development, as a literal in place of __NTN_<name>__
 * @param {Mode} mode
 * @param {Record<string, DefineRow>} rows
 * @returns {Record<string, string>}
 */
function defineValues(mode, rows) {
  return Object.fromEntries(Object.entries(rows).map(([name, row]) => [defineName(name), JSON.stringify(mode === 'production' ? row.release : row.dev)]));
}

module.exports = { readAllowlist, fileProblems, defineValues, defineName, ALLOWLIST_FILE };
