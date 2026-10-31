'use strict';

/**
 * The remote-code scan (#27 AC6, "Security"). Shipped code may run only what the package
 * holds, so the scan fails on a remote executable URL:
 *   - any http:, https:, or protocol-relative URL given to import() or a static import,
 *     importScripts(), or new Worker(), or held by a wasmPaths setting;
 *   - any such URL whose path ends in .js, .mjs, or .wasm, anywhere in a script or a page;
 *   - a page's <script src> or <link rel="modulepreload"> on another host.
 * build/remote-allowlist.json lists the occurrences reviewed to stay, each with its reason and
 * the issue that removes it. The list only shrinks: a row with more occurrences than the
 * package holds fails as stale, and test/remote-code.test.js pins the rows it may hold.
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');
const { scanScript } = require('./js-scan.js');
const { htmlTags } = require('./markup.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */
/** @typedef {{file: string, url: string, context: string, count: number, reason: string, issue: number}} AllowlistRow */

const ALLOWLIST = path.join(__dirname, '..', '..', 'build', 'remote-allowlist.json');

const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'`<>]+/gi;
// A protocol-relative URL only at the start of a literal, so `// a comment` in a string isn't one
const PROTOCOL_RELATIVE = /^\/\/[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}(?:[/?#:][^\s"'`<>]*)?$/i;
const EXECUTABLE = /\.(?:m?js|wasm)$/i;

/**
 * The remote URLs in a literal's text
 * @param {string} text
 * @returns {string[]}
 */
function remoteUrls(text) {
  const found = [...text.matchAll(ABSOLUTE_URL)].map((match) => match[0]);
  if (PROTOCOL_RELATIVE.test(text.trim())) found.push(text.trim());
  return found;
}

/**
 * Whether a URL's path ends in an executable file: .js, .mjs, or .wasm
 * @param {string} url
 * @returns {boolean}
 */
function isExecutable(url) {
  const pathname = url.replace(/^(?:https?:)?\/\/[^/?#]*/i, '').replace(/[?#].*$/, '');
  return EXECUTABLE.test(pathname);
}

/**
 * @param {string} [file]
 * @returns {AllowlistRow[]}
 */
function readAllowlist(file = ALLOWLIST) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).rows;
}

/**
 * Every remote executable URL the package's scripts and pages name
 * @param {PackageFiles} files
 * @returns {Array<{file: string, url: string, context: string, at: string}>}
 */
function remoteOccurrences(files) {
  /** @type {Array<{file: string, url: string, context: string, at: string}>} */
  const found = [];
  for (const file of files.paths) {
    if (/\.m?js$/i.test(file)) {
      for (const literal of scanScript(file, files.text(file)).urls) {
        for (const url of remoteUrls(literal.value)) {
          if (literal.context) found.push({ file, url, context: literal.context, at: literal.at });
          else if (isExecutable(url)) found.push({ file, url, context: 'url', at: literal.at });
        }
      }
    } else if (/\.html?$/i.test(file)) {
      for (const tag of htmlTags(files.text(file))) {
        for (const name of ['src', 'href']) {
          const value = tag.attributes.get(name);
          if (value === undefined) continue;
          const rel = (tag.attributes.get('rel') || '').toLowerCase();
          const loadsCode = (tag.name === 'script' && name === 'src') || (tag.name === 'link' && rel.split(/\s+/).includes('modulepreload'));
          for (const url of remoteUrls(value)) {
            if (loadsCode) found.push({ file, url, context: `<${tag.name} ${name}>`, at: tag.at });
            else if (isExecutable(url)) found.push({ file, url, context: 'url', at: tag.at });
          }
        }
      }
    }
  }
  return found;
}

/**
 * Check the package against the allowlist
 * @param {PackageFiles} files
 * @param {{allowlist?: AllowlistRow[]}} [options]
 * @returns {Problem[]}
 */
function checkRemoteCode(files, { allowlist = readAllowlist() } = {}) {
  const key = (/** @type {{file: string, url: string, context: string}} */ entry) => JSON.stringify([entry.file, entry.url, entry.context]);
  /** @type {Map<string, number>} */
  const allowed = new Map();
  for (const row of allowlist) allowed.set(key(row), (allowed.get(key(row)) || 0) + row.count);

  /** @type {Problem[]} */
  const problems = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const occurrence of remoteOccurrences(files)) {
    const count = (seen.get(key(occurrence)) || 0) + 1;
    seen.set(key(occurrence), count);
    if (count > (allowed.get(key(occurrence)) || 0)) {
      const where = occurrence.context === 'url' ? 'a remote executable URL' : `a remote URL in ${occurrence.context}`;
      problems.push(problem('remote-code/url', `${occurrence.file}:${occurrence.at}`, `${where}, ${occurrence.url}, which build/remote-allowlist.json doesn't cover. Ship the code in the package instead.`));
    }
  }
  for (const row of allowlist) {
    const count = seen.get(key(row)) || 0;
    if (count < row.count) {
      problems.push(problem('remote-code/stale-row', row.file, `build/remote-allowlist.json allows ${row.count} of ${row.url} in ${row.context}, and the package holds ${count}. Lower the row, or remove it.`));
    }
  }
  return problems;
}

module.exports = { checkRemoteCode, remoteOccurrences, remoteUrls, isExecutable, readAllowlist, ALLOWLIST };
