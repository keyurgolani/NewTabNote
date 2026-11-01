#!/usr/bin/env node

/**
 * Transaction waits (#17 PR 4b, R88's read of #17 PR 4a's close-race fix): nothing in js/ waits
 * on an IndexedDB transaction's `complete` or `abort` itself, outside
 * js/kernel/adapters/indexeddb/requests.js, whose endOf(tx) also ends on the connection's
 * `close`. Chrome fires neither event on a transaction a forced close catches, so a wait on them
 * alone never settles.
 *
 * A wait is an `oncomplete` or `onabort` handler set on anything, or a `complete` or `abort`
 * listener added with addEventListener. An `abort` on an AbortSignal (`signal`, a name ending in
 * `Signal`, or a `.signal` property) or on a FileReader the file makes with `new FileReader()`
 * isn't one. Anything else fails, whatever it's on, so a new wait goes through endOf or is told
 * apart here.
 *
 *   node scripts/transaction-waits.js [root]   fail when js/ under root, the repository's by default, has one
 *
 * test/transaction-waits.test.js runs it, so `npm test` fails too.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT_DIR = path.join(__dirname, '..');
/** The one file that waits on a transaction's end, with the connection's close beside it */
const ALLOWED = 'js/kernel/adapters/indexeddb/requests.js';
const EVENTS = new Set(['complete', 'abort']);
const HANDLERS = new Map([['oncomplete', 'complete'], ['onabort', 'abort']]);

function strip(node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
  return n;
}

/** A string literal's text, or null */
function literal(node) {
  const n = node && strip(node);
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
}

/** Whether `node` names an AbortSignal: `signal`, a name ending in `Signal`, or `x.signal` */
function isSignal(node) {
  const n = strip(node);
  const name = ts.isIdentifier(n) ? n.text : ts.isPropertyAccessExpression(n) ? n.name.text : null;
  return name !== null && (name === 'signal' || /Signal$/.test(name));
}

/** Whether `node` is `new FileReader()` */
function isNewReader(node) {
  const n = strip(node);
  return ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'FileReader';
}

/** The names a file binds to `new FileReader()` */
function readersOf(sf) {
  const names = new Set();
  (function walk(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isNewReader(n.initializer)) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, walk);
  })(sf);
  return names;
}

/**
 * Each wait on a transaction's end in one file's source, as {file, line, event, on}: the event
 * waited for, and what it's set on as the source writes it
 */
function scanSource(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const readers = readersOf(sf);
  const waits = [];
  const add = (node, event, receiver) => {
    const on = strip(receiver);
    if (event === 'abort' && (isSignal(on) || isNewReader(on) || (ts.isIdentifier(on) && readers.has(on.text)))) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    waits.push({ file, line: line + 1, event, on: on.getText(sf).replace(/\s+/g, ' ').slice(0, 60) });
  };
  (function walk(n) {
    // x.oncomplete = …, x.onabort = …, and x['oncomplete'] = …
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = strip(n.left);
      const name = ts.isPropertyAccessExpression(left)
        ? left.name.text
        : ts.isElementAccessExpression(left)
          ? literal(left.argumentExpression)
          : null;
      if (name !== null && HANDLERS.has(name)) add(n, HANDLERS.get(name), left.expression);
    }
    // x.addEventListener('complete' | 'abort', …)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(strip(n.expression))) {
      const callee = strip(n.expression);
      const event = literal(n.arguments[0]);
      if (callee.name.text === 'addEventListener' && event !== null && EVENTS.has(event)) add(n, event, callee.expression);
    }
    ts.forEachChild(n, walk);
  })(sf);
  return waits;
}

/** The files scanned under `root`, as repository-relative paths: js/ but ALLOWED */
function listFiles(root = ROOT_DIR) {
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.m?js$/.test(entry.name) && rel !== ALLOWED) files.push(rel);
    }
  })('js');
  return files.sort();
}

/** Every wait on a transaction's end in js/ under `root`, but ALLOWED's */
function collect(root = ROOT_DIR) {
  return listFiles(root).flatMap(file => scanSource(file, fs.readFileSync(path.join(root, file), 'utf8')));
}

/** What a wait's problem says */
const problemOf = wait =>
  `${wait.file}:${wait.line} waits on ${wait.on}'s ${wait.event}: wait on a transaction's end with endOf(tx) from ${ALLOWED}, which also ends when the connection closes, since Chrome fires neither event on a transaction a forced close catches`;

function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const root = argv[0] ? path.resolve(argv[0]) : ROOT_DIR;
  const waits = collect(root);
  if (waits.length > 0) {
    waits.forEach(wait => error(problemOf(wait)));
    return 1;
  }
  log(`No wait on a transaction's end in js/ outside ${ALLOWED}`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { ALLOWED, scanSource, listFiles, collect, problemOf, main };
