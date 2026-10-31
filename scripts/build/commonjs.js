'use strict';

/**
 * The CommonJS check on the modules the bundle holds (#27 slice 2, #99's review and delta). A
 * page has no CommonJS module. The legacy files end with a dual export for the Node tests that
 * require() them:
 *   if (typeof module !== 'undefined' && module.exports) { module.exports = X; } else { window.X = X; }
 * The bundler wraps a module that names a free module, exports, or require as CommonJS and hands
 * it a module object, so the file would take its Node branch and the page would never get its
 * global. The build defines module as undefined (scripts/build/vite-config.js), so the dual
 * export stays an ES module and takes its browser branch, and any other read of module becomes
 * undefined.exports, which throws. The bundler also swaps a free require for its require shim, a
 * function, so `typeof require` takes the Node branch on a page. So a module the bundle holds,
 * first-party or vendored, reads module only behind a typeof check, in the forms
 * scripts/build/js-scope.js knows, names no free exports or require, and doesn't check typeof
 * require (`build/commonjs`). A module the bundler wraps anyway fails the build by name too,
 * whatever made it wrap (commonJsProblems in scripts/build/bundle.js).
 */

const ts = require('typescript');
const { problem } = require('./diagnostics.js');
const { parse, at, isGuarded, isDeclaredInScope, isRead } = require('./js-scope.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */

/** The names a CommonJS module reads */
const COMMONJS_NAMES = ['module', 'exports', 'require'];

/**
 * The CommonJS one module names: each read of a free exports or require, each typeof of a free
 * require, and each read of a free module outside a typeof check
 * @param {string} file
 * @param {string} text
 * @returns {Array<{name: string, at: string}>} `name` is `typeof require` for a typeof
 */
function commonJsReads(file, text) {
  const source = parse(file, text);
  /** @type {Array<{name: string, at: string}>} */
  const found = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isIdentifier(node) && COMMONJS_NAMES.includes(node.text) && !isDeclaredInScope(node, node.text)) {
      if (node.text === 'require' && ts.isTypeOfExpression(node.parent)) {
        found.push({ name: 'typeof require', at: at(source, node) });
      } else if (isRead(node) && !(node.text === 'module' && isGuarded(node, 'module'))) {
        found.push({ name: node.text, at: at(source, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * What a finding of commonJsReads means, and what to do about it
 * @param {string} name
 * @returns {string}
 */
function message(name) {
  if (name === 'module') {
    return 'reads module outside a typeof check, and the build defines module as undefined, so in the bundle this reads undefined.exports and throws. Keep the Node export inside `if (typeof module !== \'undefined\' && module.exports)`.';
  }
  if (name === 'typeof require') {
    return 'checks typeof require, and the bundler swaps a free require for its require shim, a function, so on a page the check takes its Node branch. Check typeof module, which the build defines as undefined.';
  }
  return `names ${name}, so the bundler would wrap the file as CommonJS and hand it a module object, and a page would never get its global. Export it, or keep the Node export inside the typeof module check.`;
}

/**
 * The CommonJS check on the modules the bundle holds, vendored ones included, by their paths in
 * the sources
 * @param {Array<{file: string, text: string}>} modules
 * @returns {Problem[]}
 */
function checkCommonJs(modules) {
  /** @type {Problem[]} */
  const problems = [];
  for (const { file, text } of modules) {
    for (const { name, at: where } of commonJsReads(file, text)) problems.push(problem('build/commonjs', `${file}:${where}`, message(name)));
  }
  return problems;
}

module.exports = { checkCommonJs, commonJsReads, COMMONJS_NAMES };
