'use strict';

/**
 * The background's own checks (#27 "Entries"). The service worker builds in a pass of its own
 * into one self-contained ES module, js/background.js, and a worker can't load anything after it
 * starts or wait at its top level: a static import, `import()`, `importScripts()`, or top-level
 * await in what ships fails (`background/not-self-contained`, `background/top-level-await`), and
 * so does `import()`, `importScripts()`, or top-level await in a first-party module of its graph,
 * which the bundler would otherwise fold in.
 *
 * The worker has no `document` or `window` either, and its graph shares js/utils.js and
 * js/storage.js with the pages, so a first-party module in it reads them only behind a typeof
 * check (`background/dom`), in the forms scripts/build/js-scope.js knows. A name declared in a
 * scope around the read, such as a parameter or a local of an enclosing block, isn't the global,
 * and `typeof document` reads nothing.
 */

const ts = require('typescript');
const { problem } = require('./diagnostics.js');
const { parse, at, isFunctionLike, isGuarded, isDeclaredInScope, isRead } = require('./js-scope.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */

/** Where the background ships, a stable name the manifest gives */
const BACKGROUND = 'js/background.js';

/** The page globals a service worker doesn't have */
const PAGE_GLOBALS = ['document', 'window'];

/**
 * What in one script would stop a service worker from starting or loading: static imports and
 * re-exports (only when `imports` is true; a module of the graph has them, the shipped file
 * mustn't), `import()`, `importScripts()`, and await at the top level
 * @param {string} file
 * @param {string} text
 * @param {{imports: boolean}} options
 * @returns {Array<{code: 'background/not-self-contained' | 'background/top-level-await', what: string, at: string}>}
 */
function loadingProblems(file, text, { imports }) {
  const source = parse(file, text);
  /** @type {Array<{code: 'background/not-self-contained' | 'background/top-level-await', what: string, at: string}>} */
  const found = [];
  /**
   * @param {ts.Node} node
   * @param {boolean} topLevel
   */
  const visit = (node, topLevel) => {
    if (imports && (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier))) {
      found.push({ code: 'background/not-self-contained', what: 'a static import', at: at(source, node) });
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        found.push({ code: 'background/not-self-contained', what: 'import()', at: at(source, node) });
      } else {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text
          : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ['self', 'globalThis'].includes(callee.expression.text) ? callee.name.text : '';
        if (name === 'importScripts') found.push({ code: 'background/not-self-contained', what: 'importScripts()', at: at(source, node) });
      }
    }
    if (topLevel && (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier))) {
      found.push({ code: 'background/top-level-await', what: 'top-level await', at: at(source, node) });
    }
    const inner = topLevel && !isFunctionLike(node);
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(source, true);
  return found;
}

/**
 * The unguarded reads of `document` and `window` in one module
 * @param {string} file
 * @param {string} text
 * @returns {Array<{name: string, at: string}>}
 */
function pageGlobalReads(file, text) {
  const source = parse(file, text);
  /** @type {Array<{name: string, at: string}>} */
  const found = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isIdentifier(node) && PAGE_GLOBALS.includes(node.text) && isRead(node)
      && !isGuarded(node, node.text) && !isDeclaredInScope(node, node.text)) {
      found.push({ name: node.text, at: at(source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The checks on what ships: js/background.js, self-contained
 * @param {{has(file: string): boolean, text(file: string): string, label: string}} files
 * @returns {Problem[]}
 */
function checkBackgroundOutput(files) {
  if (!files.has(BACKGROUND)) return [problem('closure/missing', BACKGROUND, `${files.label} has no ${BACKGROUND}, the service worker the manifest names`)];
  return loadingProblems(BACKGROUND, files.text(BACKGROUND), { imports: true })
    .map(({ code, what, at: where }) => problem(code, `${BACKGROUND}:${where}`, `${what} in the service worker, which can't load anything after it starts${code === 'background/top-level-await' ? ' or wait at its top level' : ''}`));
}

/**
 * The checks on the background's graph: each first-party module, by its path in the sources
 * @param {Array<{file: string, text: string}>} modules
 * @returns {Problem[]}
 */
function checkBackgroundSources(modules) {
  /** @type {Problem[]} */
  const problems = [];
  for (const { file, text } of modules) {
    for (const { code, what, at: where } of loadingProblems(file, text, { imports: false })) {
      problems.push(problem(code, `${file}:${where}`, `${what} in the service worker's graph, which the worker can't run. Import it statically.`));
    }
    for (const { name, at: where } of pageGlobalReads(file, text)) {
      problems.push(problem('background/dom', `${file}:${where}`, `reads ${name}, which the service worker doesn't have, outside a typeof check. Guard it: typeof ${name} !== 'undefined'.`));
    }
  }
  return problems;
}

module.exports = { BACKGROUND, checkBackgroundOutput, checkBackgroundSources, pageGlobalReads, loadingProblems };
