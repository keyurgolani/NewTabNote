'use strict';

/**
 * The pinned toolchain (#27, "Toolchain"). .nvmrc names the one Node version the build runs
 * on, package.json's engines repeats it, and the build tools are the ones the lockfile
 * installed in node_modules, run from there (never npx, which can fetch).
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */

/** The build tools whose versions go into buildId, with Node's */
const TOOLS = ['typescript', 'terser', 'clean-css'];

/**
 * The exact Node version .nvmrc pins, such as 24.18.0
 * @param {string} root
 * @returns {string}
 */
function pinnedNode(root) {
  const pin = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error(`.nvmrc holds ${JSON.stringify(pin)}, not an exact version like 24.18.0`);
  return pin;
}

/**
 * A problem when this Node isn't the pinned one, or none
 * @param {string} root
 * @param {string} [version] - process.version
 * @returns {Problem[]}
 */
function checkNode(root, version = process.version) {
  let pin;
  try {
    pin = pinnedNode(root);
  } catch (error) {
    return [problem('toolchain/node-version', '.nvmrc', error instanceof Error ? error.message : String(error))];
  }
  if (version === `v${pin}`) return [];
  return [problem('toolchain/node-version', 'node', `this is Node ${version}, and the build runs only on v${pin} (.nvmrc). Switch with your version manager, such as \`nvm use\`.`)];
}

/**
 * The first `node_modules/<...relative>` from `root` upward, the way Node and npm find
 * installed packages, or null
 * @param {string} root
 * @param {string} relative
 * @returns {string | null}
 */
function installed(root, relative) {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', relative);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * The path of `node_modules/.bin/<name>`, or null when it isn't installed
 * @param {string} root
 * @param {string} name
 * @returns {string | null}
 */
function binPath(root, name) {
  return installed(root, path.join('.bin', name));
}

/**
 * Node's version and each build tool's installed version
 * @param {string} root
 * @returns {Record<string, string>}
 */
function toolVersions(root) {
  /** @type {Record<string, string>} */
  const versions = { node: process.version };
  for (const name of TOOLS) {
    const file = installed(root, path.join(name, 'package.json'));
    versions[name] = file ? String(JSON.parse(fs.readFileSync(file, 'utf8')).version) : 'missing';
  }
  return versions;
}

module.exports = { TOOLS, pinnedNode, checkNode, binPath, toolVersions };
