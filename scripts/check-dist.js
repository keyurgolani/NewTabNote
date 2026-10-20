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
 *   npm run check:dist                 check dist/
 *   node scripts/check-dist.js <dir>   check another build
 */

const fs = require('fs');
const path = require('path');
const { readScriptGraph } = require('./lib/script-graph');

const ROOT_DIR = path.join(__dirname, '..');

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
 * Check the build in `dir`. Returns the exit code.
 */
function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
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
  if (graph.problems.length > 0) {
    error(`check:dist failed: ${plural(graph.problems.length, 'problem')} in ${name}/`);
    graph.problems.forEach(({ message }) => error(`  - ${message}`));
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

module.exports = { main, pagesIn };
