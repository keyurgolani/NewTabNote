'use strict';

/**
 * What every output check reads: the files of a build directory (dist/, or the build's
 * staging copy before it becomes dist/) or of the package zip, by path. The checks see only
 * this, never scripts/build.js's lists, so they hold whatever pipeline writes the output.
 */

const fs = require('node:fs');
const path = require('node:path');
const { byPath, readZip } = require('./zip.js');

/**
 * @typedef {object} PackageFiles
 * @property {string} label - where the files are, for messages
 * @property {string[]} paths - every file, in byte order of the path, with / between folders
 * @property {(file: string) => boolean} has
 * @property {(file: string) => Buffer} read
 * @property {(file: string) => string} text - the file as UTF-8
 */

/**
 * Package files over an in-memory map
 * @param {Map<string, Buffer>} contents
 * @param {string} label
 * @returns {PackageFiles}
 */
function fromMap(contents, label) {
  const paths = [...contents.keys()].sort(byPath);
  const read = (/** @type {string} */ file) => {
    const data = contents.get(file);
    if (!data) throw new Error(`${label} has no ${file}`);
    return data;
  };
  return {
    label,
    paths,
    has: (file) => contents.has(file),
    read,
    text: (file) => read(file).toString('utf8'),
  };
}

/**
 * Every file under `dir`, relative to it, with / between folders
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const found = [];
  const visit = (/** @type {string} */ relative) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) found.push(name);
      else throw new Error(`${path.join(dir, name)} is neither a file nor a directory`);
    }
  };
  visit('');
  return found.sort(byPath);
}

/**
 * The files of a build directory, read when a check asks for them
 * @param {string} dir
 * @param {string} [label]
 * @returns {PackageFiles}
 */
function fromDirectory(dir, label = dir) {
  const paths = walk(dir);
  const known = new Set(paths);
  const read = (/** @type {string} */ file) => {
    if (!known.has(file)) throw new Error(`${label} has no ${file}`);
    return fs.readFileSync(path.join(dir, file));
  };
  return {
    label,
    paths,
    has: (file) => known.has(file),
    read,
    text: (file) => read(file).toString('utf8'),
  };
}

/**
 * The files of a zip. A directory entry, which some zip writers add for each folder, isn't a
 * file, so it's left out.
 * @param {Buffer} buffer
 * @param {string} label
 * @returns {PackageFiles}
 */
function fromZip(buffer, label) {
  const files = readZip(buffer).filter((entry) => !entry.path.endsWith('/'));
  return fromMap(new Map(files.map((entry) => [entry.path, entry.data])), label);
}

module.exports = { walk, fromMap, fromDirectory, fromZip };
