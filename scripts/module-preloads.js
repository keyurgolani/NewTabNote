#!/usr/bin/env node

/**
 * Each page's <link rel="modulepreload"> hints, generated from its module graph
 * (scripts/lib/script-graph.js). A page lists every module two or more imports from its own
 * module scripts: the ones the browser would find only after loading another module, which
 * since #12 slice 4a is each page's kernel graph, six imports deep. With the hints in <head>
 * the browser fetches them all at once, as #27's bundler later makes moot.
 *
 *   node scripts/module-preloads.js           fail when a page's hints and its graph differ
 *   node scripts/module-preloads.js --write   rewrite each page's hints from its graph
 *
 * npm test runs the check on the repository, and check:dist on the build (scripts/check-dist.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readScriptGraph, preloadLinks } = require('./lib/script-graph');

const ROOT_DIR = path.join(__dirname, '..');
const WRITE_COMMAND = 'node scripts/module-preloads.js --write';

/** The block --write puts before a page's </head>, between these */
const BEGIN = '<!-- Module preloads, written by `node scripts/module-preloads.js --write` from the module graph -->';
const END = '<!-- End of module preloads -->';

/**
 * The modules `page` should preload, as hrefs relative to it, in the order a breadth-first
 * walk of its imports reaches them
 * @param {ReturnType<typeof readScriptGraph>} graph
 * @param {string} page
 * @returns {string[]}
 */
function expectedPreloads(graph, page) {
  const base = path.posix.dirname(page);
  return (graph.pageModules.get(page) || [])
    .filter(({ depth }) => depth >= 2)
    .map(({ file }) => path.posix.relative(base, file));
}

/**
 * Where the pages in `root` and their module graphs differ, as problems
 * @param {string} root
 * @param {string[]} pages
 * @returns {Array<{message: string}>}
 */
function preloadProblems(root, pages) {
  const graph = readScriptGraph(root, { pages });
  const problems = [];
  for (const page of [...graph.pages].sort()) {
    const expected = expectedPreloads(graph, page);
    const listed = preloadLinks(fs.readFileSync(path.join(root, page), 'utf8'));
    const missing = expected.filter(href => !listed.includes(href));
    const extra = listed.filter(href => !expected.includes(href));
    const repeated = listed.filter((href, index) => listed.indexOf(href) !== index);
    for (const href of missing) problems.push({ message: `${page} doesn't preload ${href}, which its module graph reaches two or more imports deep` });
    for (const href of extra) problems.push({ message: `${page} preloads ${href}, which isn't two or more imports deep in its module graph` });
    for (const href of new Set(repeated)) problems.push({ message: `${page} preloads ${href} more than once` });
  }
  return problems;
}

/**
 * `html` with its preload block, and any other modulepreload link, replaced by `hrefs`
 * @param {string} html
 * @param {string[]} hrefs
 * @returns {string}
 */
function withPreloads(html, hrefs) {
  let text = html;
  const begin = text.indexOf(BEGIN);
  if (begin !== -1) {
    const end = text.indexOf(END, begin);
    if (end === -1) throw new Error(`a preload block that starts with ${BEGIN} has no ${END}`);
    // The block's own line, indentation and line break included
    const start = text.lastIndexOf('\n', begin) + 1;
    const stop = text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end) + 1;
    text = text.slice(0, start) + text.slice(stop);
  }
  text = text.replace(/^[ \t]*<link\b[^>]*\brel\s*=\s*["']?modulepreload["']?[^>]*>[ \t]*\r?\n?/gim, '');
  if (hrefs.length === 0) return text;
  const close = text.search(/^[ \t]*<\/head>/im);
  if (close === -1) throw new Error('a page with modules to preload has no </head>');
  const block = [BEGIN, ...hrefs.map(href => `<link rel="modulepreload" href="${href}">`), END]
    .map(line => `  ${line}\n`)
    .join('');
  return text.slice(0, close) + block + text.slice(close);
}

/**
 * Rewrite each page's preloads from its graph. Returns the pages it changed.
 * @param {string} root
 * @param {string[]} pages
 * @returns {string[]}
 */
function writePreloads(root, pages) {
  const graph = readScriptGraph(root, { pages });
  const changed = [];
  for (const page of [...graph.pages].sort()) {
    const file = path.join(root, page);
    const html = fs.readFileSync(file, 'utf8');
    const next = withPreloads(html, expectedPreloads(graph, page));
    if (next === html) continue;
    fs.writeFileSync(file, next);
    changed.push(page);
  }
  return changed;
}

/** The pages scripts/build.js ships */
function shippedPages() {
  return require('./build.js').HTML_FILES;
}

/**
 * @param {string[]} argv
 * @returns {number} the exit code
 */
function main(argv = process.argv.slice(2), { log = console.log, error = console.error, root = ROOT_DIR } = {}) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--write')) {
    error('usage: node scripts/module-preloads.js [--write]');
    return 2;
  }
  const pages = shippedPages();
  if (argv[0] === '--write') {
    const changed = writePreloads(root, pages);
    log(changed.length > 0 ? `module-preloads: rewrote ${changed.join(', ')}` : 'module-preloads: every page is up to date');
    return 0;
  }
  const problems = preloadProblems(root, pages);
  if (problems.length > 0) {
    error(`module-preloads failed: ${problems.length} problem${problems.length === 1 ? '' : 's'}. Run \`${WRITE_COMMAND}\`.`);
    problems.forEach(({ message }) => error(`  - ${message}`));
    return 1;
  }
  log(`module-preloads: OK, ${pages.length} pages preload their module graphs`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, expectedPreloads, preloadProblems, withPreloads, writePreloads, WRITE_COMMAND, BEGIN, END };
