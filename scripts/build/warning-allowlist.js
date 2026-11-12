'use strict';

/**
 * The warning allowlist (#300, from #27's AC1). A warning Vite or the bundler prints fails the build
 * unless build/warning-allowlist.json has a row for it (scripts/build/bundle.js), and a CSS warning
 * fails it whatever the rows say. Each row names the issue that owns it and why it's there.
 *   chunks     a row for each chunk the bundler's chunk-size warning covers, by the chunk's name. The
 *              warning names no chunk, so the build names each one a pass wrote whose file is over the
 *              limit the warning states. The bundler measures only a minified pass, so these rows hold
 *              in production, and build:dev checks none.
 *   warnings   a row for any other warning, holding its first line exactly
 * The list only shrinks: once every pass has run, a row whose warning didn't come is stale.
 *   build/warning-file    the file is missing, doesn't parse, or doesn't read as the list
 *   build/warning-stale   a row whose warning didn't come
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {'production' | 'development'} Mode */
/** @typedef {{owner: number, reason: string}} ChunkRow - the issue that owns it, and why it's there */
/** @typedef {ChunkRow & {warning: string}} WarningRow - with the warning's first line */
/** @typedef {{chunks: Record<string, ChunkRow>, warnings: WarningRow[]}} WarningAllowlist - chunk rows by the chunk's name */

const ROOT = path.join(__dirname, '..', '..');
const ALLOWLIST_FILE = 'build/warning-allowlist.json';
const FIELDS = Object.freeze({ list: ['about', 'chunks', 'warnings'], chunk: ['owner', 'reason'], warning: ['warning', 'owner', 'reason'] });
/** A stylesheet's warning, which fails the build as an error does (#89's review): no row allows one */
const CSS_WARNING = /lightningcss|\[vite:css/i;
/** The bundler's chunk-size warning, and the limit it states in kB of 1,000 bytes */
const CHUNK_SIZE = /Some chunks are larger than (\d+) kB after minification/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * What's wrong with a row: a field it doesn't take, no owner, or no reason
 * @param {string} label - the row, as a message names it
 * @param {unknown} row
 * @param {readonly string[]} fields
 * @returns {string[]}
 */
function rowFaults(label, row, fields) {
  if (!isObject(row)) return [`${label} isn't an object`];
  /** @type {string[]} */
  const faults = [];
  const extra = Object.keys(row).filter((key) => !fields.includes(key));
  if (extra.length > 0) faults.push(`${label} has ${extra.join(', ')}, which a row doesn't take`);
  if (!Number.isSafeInteger(row.owner) || /** @type {number} */ (row.owner) < 1) faults.push(`${label} has no owner: the number of the issue that owns it`);
  if (typeof row.reason !== 'string' || row.reason === '') faults.push(`${label} has no reason`);
  return faults;
}

/**
 * The problems with the allowlist's shape, before it's used
 * @param {unknown} allowlist
 * @returns {Problem[]}
 */
function fileProblems(allowlist) {
  const fail = (/** @type {string[]} */ faults) => faults.map((fault) => problem('build/warning-file', ALLOWLIST_FILE, fault));
  if (!isObject(allowlist) || !isObject(allowlist.chunks) || !Array.isArray(allowlist.warnings)) {
    return fail(['has no rows: chunks, an object of chunk rows by name, and warnings, a list of warning rows']);
  }
  /** @type {string[]} */
  const faults = [];
  if (typeof allowlist.about !== 'string' || allowlist.about === '') faults.push('has no about text');
  const extra = Object.keys(allowlist).filter((key) => !FIELDS.list.includes(key));
  if (extra.length > 0) faults.push(`has ${extra.join(', ')}, which the list doesn't take`);
  for (const [name, row] of Object.entries(allowlist.chunks)) faults.push(...rowFaults(`chunk row ${name}`, row, FIELDS.chunk));
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [i, row] of allowlist.warnings.entries()) {
    faults.push(...rowFaults(`warning row ${i + 1}`, row, FIELDS.warning));
    const text = isObject(row) ? row.warning : undefined;
    if (typeof text !== 'string' || text === '' || text.includes('\n')) faults.push(`warning row ${i + 1} has no warning: the warning's first line, exactly`);
    else if (seen.has(text)) faults.push(`warning row ${i + 1} repeats ${JSON.stringify(text)}`);
    else seen.add(text);
  }
  return fail(faults);
}

/**
 * Read build/warning-allowlist.json from `root`. It has no rows when it has a problem.
 * @param {string} [root]
 * @returns {{allowlist: WarningAllowlist, problems: Problem[]}}
 */
function readAllowlist(root = ROOT) {
  const none = () => ({ chunks: {}, warnings: [] });
  const file = path.join(root, ALLOWLIST_FILE);
  if (!fs.existsSync(file)) return { allowlist: none(), problems: [problem('build/warning-file', ALLOWLIST_FILE, 'is missing')] };
  /** @type {unknown} */
  let allowlist;
  try {
    allowlist = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { allowlist: none(), problems: [problem('build/warning-file', ALLOWLIST_FILE, `doesn't parse: ${error instanceof Error ? error.message : error}`)] };
  }
  const problems = fileProblems(allowlist);
  if (problems.length > 0) return { allowlist: none(), problems };
  const { chunks, warnings } = /** @type {WarningAllowlist} */ (allowlist);
  return { allowlist: { chunks, warnings }, problems };
}

/**
 * The chunk rows against the chunk-size warning in a production build every pass finished: each
 * chunk a pass wrote over the limit the warning states needs a row, and a row for any other is
 * stale, as each is when the warning didn't come
 * @param {Record<string, ChunkRow>} rows
 * @param {{limit: number, line: string} | null} warned - the warning's limit in kB and its line, if it came
 * @param {Array<{name: string, bytes: number}>} chunks
 * @returns {{allowed: string[], problems: Problem[]}}
 */
function chunkChecks(rows, warned, chunks) {
  /** @type {string[]} */
  const allowed = [];
  /** @type {Problem[]} */
  const problems = [];
  // The bundler's measure: a chunk's bytes over the limit's kB of 1,000 bytes each
  const over = warned ? chunks.filter((chunk) => chunk.bytes > warned.limit * 1000) : [];
  if (warned && over.length === 0) {
    problems.push(problem('build/bundler-warning', 'the bundle', `"${warned.line}": no chunk a pass wrote is over the bundler's ${warned.limit} kB chunk-size limit, so no row can name the one it warns about`));
  }
  for (const chunk of over) {
    const row = Object.hasOwn(rows, chunk.name) ? rows[chunk.name] : null;
    if (row && warned) allowed.push(`"${warned.line}" for the ${chunk.name} chunk, ${chunk.bytes} bytes (#${row.owner})`);
    else problems.push(problem('build/bundler-warning', chunk.name, `${chunk.bytes} bytes, over the bundler's ${warned ? warned.limit : 0} kB chunk-size limit, and ${ALLOWLIST_FILE} has no row for it. Split the chunk, or add a row with its owner and reason.`));
  }
  for (const name of Object.keys(rows)) {
    if (over.some((chunk) => chunk.name === name)) continue;
    const why = warned ? `the chunk isn't over the bundler's ${warned.limit} kB chunk-size limit` : "the bundler's chunk-size warning didn't come";
    problems.push(problem('build/warning-stale', ALLOWLIST_FILE, `its row for the ${name} chunk: ${why}, so the row goes. The list only shrinks.`));
  }
  return { allowed, problems };
}

/**
 * The warnings a build's passes printed, against the allowlist. A warning a row holds is allowed,
 * and any other is unlisted, for scripts/build/bundle.js to fail. In production the chunk-size
 * warning covers each chunk a pass wrote over its limit, which `chunks` gives. Once every pass has
 * run (`complete`), a row whose warning didn't come is stale; before, no chunk or row is checked.
 * @param {string[]} warnings - as the passes printed them, without color codes
 * @param {WarningAllowlist} allowlist
 * @param {{mode: Mode, complete: boolean, chunks: Array<{name: string, bytes: number}>}} build
 * @returns {{unlisted: string[], allowed: string[], problems: Problem[]}}
 */
function checkWarnings(warnings, allowlist, { mode, complete, chunks }) {
  /** @type {string[]} */
  const unlisted = [];
  /** @type {string[]} */
  const allowed = [];
  /** @type {Problem[]} */
  const problems = [];
  /** @type {Set<WarningRow>} */
  const matched = new Set();
  /** @type {{limit: number, line: string} | null} */
  let warned = null;
  for (const warning of warnings) {
    const size = mode === 'production' ? CHUNK_SIZE.exec(warning) : null;
    if (size) {
      warned = { limit: Number(size[1]), line: (warning.split('\n').find((line) => CHUNK_SIZE.test(line)) || '').trim() };
      continue;
    }
    const first = warning.split('\n')[0];
    const row = CSS_WARNING.test(first) ? undefined : allowlist.warnings.find((candidate) => candidate.warning === first);
    if (!row) {
      unlisted.push(warning);
      continue;
    }
    if (!matched.has(row)) allowed.push(`"${first}" (#${row.owner})`);
    matched.add(row);
  }
  if (!complete) return { unlisted, allowed, problems };
  if (mode === 'production') {
    const sized = chunkChecks(allowlist.chunks, warned, chunks);
    allowed.push(...sized.allowed);
    problems.push(...sized.problems);
  }
  for (const row of allowlist.warnings) {
    if (!matched.has(row)) problems.push(problem('build/warning-stale', ALLOWLIST_FILE, `its row for ${JSON.stringify(row.warning)}: no pass printed it, so the row goes. The list only shrinks.`));
  }
  return { unlisted, allowed, problems };
}

module.exports = { readAllowlist, fileProblems, checkWarnings, CSS_WARNING, ALLOWLIST_FILE };
