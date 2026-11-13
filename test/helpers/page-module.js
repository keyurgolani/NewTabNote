'use strict';

/**
 * Evaluates a page's entry module in a test/helpers/legacy-env.js page context, the way
 * Chrome loads `<script type="module">`: each module read from disk unmodified, linked by
 * its relative specifiers, and evaluated once, imports first. Popup and Side Panel load
 * their entries this way, so their tests do too. It takes vm.SourceTextModule, so node runs
 * with --experimental-vm-modules (npm test passes it).
 *
 * A module's import() resolves as a static import does, through the same modules and the same
 * relative-only rule, and its module is linked and evaluated before it's handed back, as
 * Chrome's is (#237), so a case of a path behind a lazy chunk runs that path. A case of a failed
 * load passes `dynamicImports: false`, and each import() then rejects.
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
 * @param {{dynamicImports?: boolean}} [options] - `dynamicImports`: a module's import() loads
 *   the module it names, unless a test passes false
 * @returns {Promise<Object>}
 */
async function loadPageModule(env, file, { dynamicImports = true } = {}) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('test/helpers/page-module.js runs page modules with vm.SourceTextModule, '
      + 'which needs node --experimental-vm-modules (npm test passes it)');
  }
  const modules = new Map();
  /** Each module an import() named, linked and evaluated once */
  const imported = new Map();
  const linker = (specifier, referencing) => {
    if (!/^\.{1,2}\//.test(specifier)) {
      throw new Error(`${fileURLToPath(referencing.identifier)} imports ${JSON.stringify(specifier)}; pages resolve only relative specifiers`);
    }
    return moduleFor(fileURLToPath(new URL(specifier, referencing.identifier)));
  };
  const importModuleDynamically = (specifier, referencing) => {
    const module = linker(specifier, referencing);
    if (!imported.has(module)) {
      imported.set(module, (async () => {
        if (module.status === 'unlinked') await module.link(linker);
        if (module.status !== 'evaluated') await module.evaluate();
        return module;
      })());
    }
    return imported.get(module);
  };
  const moduleFor = (full) => {
    if (!modules.has(full)) {
      modules.set(full, new vm.SourceTextModule(fs.readFileSync(full, 'utf8'), {
        context: env.context,
        identifier: pathToFileURL(full).href,
        ...(dynamicImports ? { importModuleDynamically } : {}),
      }));
    }
    return modules.get(full);
  };
  const entry = moduleFor(path.join(ROOT, file));
  await entry.link(linker);
  await entry.evaluate();
  return entry.namespace;
}

module.exports = { loadPageModule };
