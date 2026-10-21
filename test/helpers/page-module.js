'use strict';

/**
 * Evaluates a page's entry module in a test/helpers/legacy-env.js page context, the way
 * Chrome loads `<script type="module">`: each module read from disk unmodified, linked by
 * its relative specifiers, and evaluated once, imports first. Popup and Side Panel load
 * their entries this way, so their tests do too. It takes vm.SourceTextModule, so node runs
 * with --experimental-vm-modules (npm test passes it).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL, fileURLToPath } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Evaluate `file`, relative to the repository root, and the modules it imports in `env`.
 * Resolves with its exports once the graph has evaluated, so its listeners are registered,
 * and rejects with what a module threw while it evaluated.
 * @param {ReturnType<import('./legacy-env').createLegacyEnv>} env
 * @param {string} file
 * @returns {Promise<Object>}
 */
async function loadPageModule(env, file) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('test/helpers/page-module.js runs page modules with vm.SourceTextModule, '
      + 'which needs node --experimental-vm-modules (npm test passes it)');
  }
  const modules = new Map();
  const moduleFor = (full) => {
    if (!modules.has(full)) {
      modules.set(full, new vm.SourceTextModule(fs.readFileSync(full, 'utf8'), {
        context: env.context,
        identifier: pathToFileURL(full).href,
      }));
    }
    return modules.get(full);
  };
  const entry = moduleFor(path.join(ROOT, file));
  await entry.link((specifier, referencing) => {
    if (!/^\.{1,2}\//.test(specifier)) {
      throw new Error(`${fileURLToPath(referencing.identifier)} imports ${JSON.stringify(specifier)}; pages resolve only relative specifiers`);
    }
    return moduleFor(fileURLToPath(new URL(specifier, referencing.identifier)));
  });
  await entry.evaluate();
  return entry.namespace;
}

module.exports = { loadPageModule };
