#!/usr/bin/env node

/**
 * Check that a build can load every script it names (#12, docs/adr/0001-kernel-stack.md):
 * the manifest's background.service_worker and pages, each page's <script src>, and every
 * static import and importScripts() name reached from them resolve to files inside the
 * build. In the service worker's graph it also fails on top-level await, import(), and, in
 * a module worker, importScripts(), each of which stops the worker before its listeners
 * register. A kernel file missing from dist/ breaks the module graph and boots a blank new
 * tab, so CI runs this on the build the extension job tests.
 *
 * Every module under #13's contract and messaging directories, #15's registry kit, and
 * Valibot's build, must be in the build too, whether or not anything reached from a page or
 * the worker imports it yet (#13, AC7). A missing one would break whichever context loads it
 * next. And each page has to preload exactly the modules its graph reaches two or more
 * imports deep (scripts/module-preloads.js).
 *
 *   npm run check:dist                 check dist/
 *   node scripts/check-dist.js <dir>   check another build
 */

const fs = require('fs');
const path = require('path');
const { readScriptGraph } = require('./lib/script-graph');
const { preloadProblems } = require('./module-preloads');

const ROOT_DIR = path.join(__dirname, '..');

/**
 * Source directories whose every .js and .mjs file must be in the build (#13, AC7), and #15's
 * registry kit, which no page or worker imports until its first family does
 */
const SHIPPED_DIRS = [
  'js/kernel/core/contracts/',
  'js/kernel/core/messaging/',
  'js/kernel/adapters/messaging/',
  'js/kernel/registry/',
  'js/lib/valibot/',
];

/**
 * Every .js and .mjs file under `dir` in `root`, relative to `root` and sorted, or none when
 * the directory doesn't exist yet
 */
function modulesUnder(root, dir) {
  const top = path.join(root, dir);
  if (!fs.existsSync(top)) return [];
  return fs.readdirSync(top, { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}${entry.name}`;
    if (entry.isDirectory()) return modulesUnder(root, `${file}/`);
    return /\.m?js$/.test(entry.name) ? [file] : [];
  }).sort();
}

/**
 * The SHIPPED_DIRS modules in `root`'s sources that the build in `dir` lacks
 */
function missingModules(dir, root = ROOT_DIR) {
  return SHIPPED_DIRS.flatMap(shipped => modulesUnder(root, shipped)
    .filter(file => !fs.existsSync(path.join(dir, file)))
    .map(file => ({ message: `${file} is missing; every module under ${shipped} ships, imported yet or not` })));
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Every .html file under `dir`, relative to it and sorted
 */
function pagesIn(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap(entry => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return pagesIn(dir, file);
    return entry.name.endsWith('.html') ? [file] : [];
  }).sort();
}

/**
 * Check the build in `dir`, built from the sources in `sources`. Returns the exit code.
 */
function main(argv = process.argv.slice(2), { log = console.log, error = console.error, sources = ROOT_DIR } = {}) {
  if (argv.length > 1 || argv.some(arg => arg.startsWith('-'))) {
    error('usage: node scripts/check-dist.js [dir]');
    return 2;
  }
  const dir = path.resolve(argv[0] || path.join(ROOT_DIR, 'dist'));
  const shown = path.relative(process.cwd(), dir);
  const name = !shown ? '.' : (shown.startsWith('..') ? dir : shown);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    error(`check:dist failed: no build at ${name}. Run \`npm run build\` first.`);
    return 1;
  }

  const graph = readScriptGraph(dir, { pages: pagesIn(dir), inspectClassic: true });
  const problems = [...graph.problems, ...missingModules(dir, sources), ...preloadProblems(dir, pagesIn(dir))];
  if (problems.length > 0) {
    error(`check:dist failed: ${plural(problems.length, 'problem')} in ${name}/`);
    problems.forEach(({ message }) => error(`  - ${message}`));
    return 1;
  }

  const worker = graph.worker
    ? `a ${graph.worker.module ? 'module' : 'classic'} service worker (${graph.worker.file}, ${plural(graph.workerFiles.size, 'file')})`
    : 'no service worker';
  log(`check:dist: OK, ${name}/ resolves all ${plural(graph.references, 'reference')}: `
    + `${plural(graph.pages.size, 'page')}, ${plural(graph.modules.size, 'ES module')}, `
    + `${plural(graph.classic.size, 'classic script')}, and ${worker}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, pagesIn, SHIPPED_DIRS, missingModules };
