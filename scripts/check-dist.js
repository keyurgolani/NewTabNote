#!/usr/bin/env node

/**
 * npm run check:dist (#12, folded into #27's closure check by #27 slice 2): the checks a build
 * runs on what it wrote, run again on a build that exists, which CI does on the one its
 * extension job tests. Every path the manifest, a page, a stylesheet, or a script names is in
 * the build, and nothing ships unnamed (scripts/build/closure.js); each page preloads exactly
 * the chunks its module scripts import, and loads no module as a classic script; and the
 * service worker is one self-contained module, which loads nothing after it starts and never
 * waits at its top level (scripts/build/background.js); and each page's first script is the
 * network guard, which wraps every network API it covers (scripts/build/guard.js).
 *
 * #13 AC7 had every module under the contract, messaging, and registry directories ship whether
 * anything imported it yet or not, since a module missing from the copied tree broke whichever
 * context loaded it next. The bundler resolves every import as it builds instead, so a module
 * a context needs is in that context's chunks, and a missing one fails the build.
 *
 *   npm run check:dist                 check dist/
 *   node scripts/check-dist.js <dir>   check another build
 */

const fs = require('fs');
const path = require('path');
const { fromDirectory } = require('./build/package-files.js');
const { checkClosure, checkPreloads, checkClassicScripts } = require('./build/closure.js');
const { checkBackgroundOutput } = require('./build/background.js');
const { checkGuardPages, checkGuardScript } = require('./build/guard.js');
const { format, plural } = require('./build/diagnostics.js');
const { ASSETS_DIR, CLASSIC_SCRIPTS } = require('./build/vite-config.js');

const ROOT_DIR = path.join(__dirname, '..');

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

  const files = fromDirectory(dir, `${name}/`);
  const closure = checkClosure(files);
  const problems = [...closure.problems, ...checkPreloads(files), ...checkClassicScripts(files), ...checkBackgroundOutput(files), ...checkGuardPages(files), ...checkGuardScript(files)];
  if (problems.length > 0) {
    error(`check:dist failed: ${plural(problems.length, 'problem')} in ${name}/`);
    problems.forEach(found => error(`  - ${format(found)}`));
    return 1;
  }

  const pages = files.paths.filter(file => /\.html?$/i.test(file));
  const chunks = files.paths.filter(file => file.startsWith(`${ASSETS_DIR}/`) && /\.m?js$/.test(file));
  const classic = Object.keys(CLASSIC_SCRIPTS).filter(file => files.has(file));
  log(`check:dist: OK, ${name}/ closes over its ${plural(files.paths.length, 'file')}: `
    + `${plural(pages.length, 'page')}, ${plural(chunks.length, 'chunk')}, ${plural(classic.length, 'classic script')}, `
    + 'and a self-contained module service worker (js/background.js)');
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
