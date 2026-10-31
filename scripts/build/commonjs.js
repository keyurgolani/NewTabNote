'use strict';

/**
 * The CommonJS check on the modules the bundle holds (#27 slice 2, #99's review). A page has no
 * CommonJS module. The legacy files end with a dual export for the Node tests that require()
 * them:
 *   if (typeof module !== 'undefined' && module.exports) { module.exports = X; } else { window.X = X; }
 * The bundler wraps a module that names a free module, exports, or require as CommonJS and hands
 * it a module object, so the file would take its Node branch and the page would never get its
 * global. The build defines module as undefined (scripts/build/vite-config.js), so the dual
 * export stays an ES module and takes its browser branch, and any other read of module becomes
 * undefined.exports, which throws. So a first-party module the bundle holds reads module only
 * behind a typeof check, in the forms scripts/build/js-scope.js knows, and names no free exports
 * or require (`build/commonjs`). A module the bundler wraps anyway fails the build by name too,
 * whatever made it wrap (commonJsProblems in scripts/build/bundle.js).
 */

const ts = require('typescript');
const { problem } = require('./diagnostics.js');
const { parse, at, isGuarded, isDeclaredInScope, isRead } = require('./js-scope.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */

/** The names a CommonJS module reads */
const COMMONJS_NAMES = ['module', 'exports', 'require'];

/**
 * The CommonJS one module names: each read of a free exports or require, and of a free module
 * outside a typeof check
 * @param {string} file
 * @param {string} text
 * @returns {Array<{name: string, at: string}>}
 */
function commonJsReads(file, text) {
  const source = parse(file, text);
  /** @type {Array<{name: string, at: string}>} */
  const found = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isIdentifier(node) && COMMONJS_NAMES.includes(node.text) && isRead(node) && !isDeclaredInScope(node, node.text)
      && !(node.text === 'module' && isGuarded(node, 'module'))) {
      found.push({ name: node.text, at: at(source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The CommonJS check on the bundle's first-party modules, by their paths in the sources
 * @param {Array<{file: string, text: string}>} modules
 * @returns {Problem[]}
 */
function checkCommonJs(modules) {
  /** @type {Problem[]} */
  const problems = [];
  for (const { file, text } of modules) {
    for (const { name, at: where } of commonJsReads(file, text)) {
      problems.push(problem('build/commonjs', `${file}:${where}`, name === 'module'
        ? 'reads module outside a typeof check, and the build defines module as undefined, so in the bundle this reads undefined.exports and throws. Keep the Node export inside `if (typeof module !== \'undefined\' && module.exports)`.'
        : `names ${name}, so the bundler would wrap the file as CommonJS and hand it a module object, and a page would never get its global. Export it, or keep the Node export inside the typeof module check.`));
    }
  }
  return problems;
}

module.exports = { checkCommonJs, commonJsReads, COMMONJS_NAMES };
