'use strict';

// The sources a build reads, as a package, without building (#27 slice 2): the pages, every
// script under js/ (vendored js/lib/ included), the stylesheets, and the static files, at
// their source paths. The output checks (scripts/build/) read only a package's files, so they
// run on this in a moment and see the references the sources make, before the bundler folds
// the modules into chunks. Unlike dist/, it holds modules no entry imports yet, which the
// bundler leaves out.

const fs = require('node:fs');
const path = require('node:path');
const { PAGES, CLASSIC_SCRIPTS, STATIC_FILES } = require('../../scripts/build/vite-config.js');
const { fromMap } = require('../../scripts/build/package-files.js');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Every file under `dir` in the repository, relative to the root
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir.replace(/\/$/, '')}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

/**
 * The sources as a package, with `edits`: a path to its new text, or null to leave it out
 * @param {{edits?: Record<string, string | Buffer | null>}} [options]
 */
function sourcePackage({ edits = {} } = {}) {
  const files = new Map();
  const add = (file) => files.set(file, fs.readFileSync(path.join(ROOT, file)));
  filesUnder('js').filter((file) => /\.m?js$/.test(file)).forEach(add);
  filesUnder('css').filter((file) => file.endsWith('.css')).forEach(add);
  [...Object.values(PAGES), ...Object.keys(CLASSIC_SCRIPTS), ...STATIC_FILES].forEach(add);
  for (const [file, data] of Object.entries(edits)) {
    if (data === null) files.delete(file);
    else files.set(file, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
  return fromMap(files, 'the package');
}

/**
 * A small package from scratch: path to text
 * @param {Record<string, string | Buffer>} contents
 */
function packageOf(contents) {
  return fromMap(new Map(Object.entries(contents).map(([file, data]) => [file, Buffer.isBuffer(data) ? data : Buffer.from(data)])), 'the package');
}

module.exports = { ROOT, sourcePackage, packageOf, filesUnder };
