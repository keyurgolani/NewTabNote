'use strict';

/**
 * Finds every network call in first-party code (#21 slice 1b, the credentialed-call ledger):
 * `fetch(...)`, `new XMLHttpRequest()`, `new WebSocket(...)`, `new EventSource(...)`, and
 * `navigator.sendBeacon(...)`, each with the function it's in, read from the syntax tree, so a
 * comment or a string never counts. js/lib/ is vendored, and the guard covers it.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');
const CONSTRUCTORS = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource']);
const GLOBALS = new Set(['globalThis', 'window', 'self']);

/**
 * The name of the function `node` is in: a method, a function, or the binding an arrow or
 * function expression is given; `(top level)` outside any
 * @param {ts.Node} node
 * @returns {string}
 */
function enclosingName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isGetAccessor(current)) && current.name) {
      return current.name.getText();
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      const owner = current.parent;
      if ((ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner)) && owner.name) {
        return owner.name.getText();
      }
    }
  }
  return '(top level)';
}

/**
 * What network API `node` calls, or null
 * @param {ts.Node} node
 * @returns {string | null}
 */
function apiOf(node) {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'fetch') return 'fetch';
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      const target = callee.expression;
      if (name === 'fetch' && ts.isIdentifier(target) && GLOBALS.has(target.text)) return 'fetch';
      if (name === 'sendBeacon') return 'sendBeacon';
    }
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && CONSTRUCTORS.has(node.expression.text)) {
    return node.expression.text;
  }
  return null;
}

/**
 * The network calls in `source`, as `{api, function, line}`
 * @param {string} source
 * @param {string} [fileName]
 * @returns {Array<{api: string, function: string, line: number}>}
 */
function scanSource(source, fileName = 'source.js') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {Array<{api: string, function: string, line: number}>} */
  const found = [];
  const visit = (/** @type {ts.Node} */ node) => {
    const api = apiOf(node);
    if (api) found.push({ api, function: enclosingName(node), line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Every first-party script under js/, js/lib/ left out
 * @returns {string[]} paths from the repo root
 */
function firstPartyFiles() {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (file !== 'js/lib') walk(file);
      } else if (/\.m?js$/.test(entry.name)) {
        files.push(file);
      }
    }
  };
  walk('js');
  return files.sort();
}

/**
 * Every network call in first-party code, counted per file and function
 * @returns {Map<string, {file: string, function: string, count: number, apis: string[], lines: number[]}>}
 */
function networkCalls() {
  const calls = new Map();
  for (const file of firstPartyFiles()) {
    for (const site of scanSource(fs.readFileSync(path.join(ROOT, file), 'utf8'), file)) {
      const key = `${file}#${site.function}`;
      const entry = calls.get(key) || { file, function: site.function, count: 0, apis: [], lines: [] };
      entry.count += 1;
      if (!entry.apis.includes(site.api)) entry.apis.push(site.api);
      entry.lines.push(site.line);
      calls.set(key, entry);
    }
  }
  return calls;
}

module.exports = { networkCalls, scanSource, firstPartyFiles };
