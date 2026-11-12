'use strict';

/**
 * The dependency report (#300, from #27's Outputs), for #31's release pipeline. A production build
 * writes dist-report/dependencies.json beside the chunk graph (scripts/build/budgets.js), and like
 * it, the report never ships. For each entry it lists the third-party code the entry's start, lazy
 * chunks and workers hold: its packages from node_modules, each with the version and license its
 * package.json gives, and its vendored files under js/lib/, each with the package, version and
 * license js/lib/vendor.json gives, or the record a vendored folder holds, such as
 * js/lib/valibot/vendor.json. The entries and both lists are sorted, so one graph writes the same
 * bytes every time, and npm run verify:reproducible compares the report across its two builds.
 */

const fs = require('node:fs');
const path = require('node:path');

/** @typedef {import('./budgets.js').EntryGraph} EntryGraph */
/** @typedef {{version: string | null, license: string | null}} Release */

const ROOT = path.join(__dirname, '..', '..');
/** A module path's package under node_modules, scoped or not */
const NODE_MODULE = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/;

/**
 * A record's version and license, as strings or null
 * @param {any} record
 * @returns {Release}
 */
function releaseOf(record) {
  return { version: typeof record.version === 'string' ? record.version : null, license: typeof record.license === 'string' ? record.license : null };
}

/**
 * Each vendored file, and each vendored folder by its path with a trailing /, to its package,
 * version and license
 * @param {string} root
 * @returns {Map<string, {package: string} & Release>}
 */
function vendoredRecords(root) {
  /** @type {Map<string, {package: string} & Release>} */
  const records = new Map();
  const top = JSON.parse(fs.readFileSync(path.join(root, 'js', 'lib', 'vendor.json'), 'utf8'));
  for (const [name, file] of Object.entries(/** @type {Record<string, any>} */ (top.files || {}))) records.set(`js/lib/${name}`, { package: file.package, ...releaseOf(file) });
  for (const dir of fs.readdirSync(path.join(root, 'js', 'lib'), { withFileTypes: true })) {
    const nested = path.join(root, 'js', 'lib', dir.name, 'vendor.json');
    if (!dir.isDirectory() || !fs.existsSync(nested)) continue;
    const record = JSON.parse(fs.readFileSync(nested, 'utf8'));
    records.set(`js/lib/${dir.name}/`, { package: record.package, ...releaseOf(record) });
  }
  return records;
}

/**
 * A node_modules package's name, version and license, from its package.json, or nulls where it
 * has none
 * @param {string} root
 * @param {string} name
 * @returns {{name: string} & Release}
 */
function packageRelease(root, name) {
  const file = path.join(root, 'node_modules', name, 'package.json');
  return { name, ...(fs.existsSync(file) ? releaseOf(JSON.parse(fs.readFileSync(file, 'utf8'))) : { version: null, license: null }) };
}

/**
 * The report's text for `graph`
 * @param {Record<string, EntryGraph>} graph
 * @param {{buildId: string, root?: string}} options
 * @returns {string}
 */
function dependencyReport(graph, { buildId, root = ROOT }) {
  const vendored = vendoredRecords(root);
  const folders = [...vendored].filter(([prefix]) => prefix.endsWith('/'));
  /** @type {Record<string, {packages: Array<{name: string} & Release>, vendored: Array<{file: string, package: string} & Release>}>} */
  const entries = {};
  for (const name of Object.keys(graph).sort()) {
    const { start, lazy, workers } = graph[name];
    const modules = [...new Set([...start.modules, ...lazy.modules, ...workers.modules])].sort();
    /** @type {Set<string>} */
    const packages = new Set();
    /** @type {Array<{file: string, package: string} & Release>} */
    const files = [];
    for (const file of modules) {
      const npm = NODE_MODULE.exec(file);
      if (npm) {
        packages.add(npm[1]);
        continue;
      }
      const folder = folders.find(([prefix]) => file.startsWith(prefix));
      const record = vendored.get(file) || (folder && folder[1]);
      if (record) files.push({ file, ...record });
    }
    entries[name] = { packages: [...packages].sort().map((pkg) => packageRelease(root, pkg)), vendored: files };
  }
  return `${JSON.stringify({ buildId, entries }, null, 2)}\n`;
}

module.exports = { dependencyReport };
