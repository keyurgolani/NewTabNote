'use strict';

// The package scripts/build.js's lists describe, read straight from the sources: the files a
// build ships, unminified, without building. The output checks (scripts/build/) read only a
// package's files, so they run on this in a moment and see the same paths and references a
// built dist/ has.

const fs = require('node:fs');
const path = require('node:path');
const build = require('../../scripts/build.js');
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
 * The package, with `jsFiles` in place of JS_FILES if given, and `edits`: a path to its new
 * text, or null to leave it out
 * @param {{jsFiles?: string[], edits?: Record<string, string | Buffer | null>}} [options]
 */
function sourcePackage({ jsFiles = build.JS_FILES, edits = {} } = {}) {
  const files = new Map();
  const add = (file) => files.set(file, fs.readFileSync(path.join(ROOT, file)));
  jsFiles.forEach(add);
  for (const dir of build.JS_DIRS) filesUnder(dir).filter((file) => /\.m?js$/.test(file) && !files.has(file)).forEach(add);
  [...build.CSS_FILES, ...build.HTML_FILES, ...build.STATIC_FILES].forEach(add);
  build.STATIC_DIRS.forEach((dir) => filesUnder(dir).forEach(add));
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
