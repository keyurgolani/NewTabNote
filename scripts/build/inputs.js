'use strict';

/**
 * What a build reads (#27 slice 2): the inputs scripts/build/vite-config.js lists (the pages,
 * the background's entry, the classic scripts, and the static files), the source directories
 * the pages and the worker import from, and the build's own inputs. A copy of the tree with
 * these builds as the tree does, which npm run verify:fixtures relies on.
 */

const { PAGES, BACKGROUND_ENTRY, CLASSIC_SCRIPTS, STATIC_FILES } = require('./vite-config.js');

/**
 * What the build reads besides the files it bundles and copies: the toolchain pin, the
 * lockfile, the type gate's projects and baseline, the reviewed lists the checks read, and the
 * build code
 */
const BUILD_INPUTS = Object.freeze([
  '.nvmrc',
  'package.json',
  'package-lock.json',
  'jsconfig.json',
  'tsconfig.kernel.json',
  'tsconfig.strict.json',
  'ci',
  'build',
  'scripts',
]);

/** The directories the pages' stylesheets and every module graph read from */
const SOURCE_DIRS = Object.freeze(['js', 'css']);

/**
 * Every input the build lists, each of which has to be there (build/missing-input)
 * @returns {string[]}
 */
function listedInputs() {
  return [...Object.values(PAGES), BACKGROUND_ENTRY, ...Object.keys(CLASSIC_SCRIPTS), ...STATIC_FILES];
}

/**
 * The top-level entries a build reads, sorted
 * @returns {string[]}
 */
function buildEntries() {
  return [...new Set([...BUILD_INPUTS, ...SOURCE_DIRS, ...listedInputs().map((entry) => entry.split('/')[0])])].sort();
}

module.exports = { BUILD_INPUTS, SOURCE_DIRS, listedInputs, buildEntries };
