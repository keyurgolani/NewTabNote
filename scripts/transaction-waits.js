#!/usr/bin/env node

/**
 * Transaction waits (#17 PR 4b, R88's read of #17 PR 4a's close-race fix): nothing in js/ waits
 * on an IndexedDB transaction's `complete` or `abort` itself, outside
 * js/kernel/adapters/indexeddb/requests.js, whose endOf(tx) also ends on the connection's
 * `close`. Chrome fires neither event on a transaction a forced close catches, so a wait on them
 * alone never settles.
 *
 * A wait is an `oncomplete` or `onabort` handler set on anything, by any assignment (`=`, `??=`,
 * `||=`, ...), as an object literal's key (as Object.assign takes it), or by a call that names it
 * (Object.defineProperty, Reflect.set), and a `complete` or `abort` listener added with
 * addEventListener, called as a method, through brackets, with `.call` or `.apply`, or bound
 * with `.bind`. A listener for an event the scan can't read, one named by a variable, a
 * constant, or a loop's item, counts as one too, and so does a handler set on a transaction
 * through a key it can't read (`tx[key] = …`), so every event and handler name is a literal,
 * but in js/lib/: its vendored files, each pinned by its SHA-256 (js/lib/vendor.json), name
 * events through variables as minified code does, and take every other rule. A `const` item of
 * a loop over string literals alone is read as each of them, as the network guard's refused
 * socket names its `error` and `close` listeners. An `abort` on an AbortSignal (`signal`, or a
 * `.signal` property) or on a FileReader the file makes with `new FileReader()` isn't one.
 * Anything else fails, whatever it's on, so a new wait goes through endOf or is told apart here
 * (R131).
 *
 * It guards against a wait written by accident, not one written to get past it: Reflect.apply,
 * addEventListener taken off a transaction and called later, or a handler name built at run
 * time on something that doesn't read as a transaction, such as one held as `t`, all get by.
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
/** The vendored libraries, minified, whose event names the scan doesn't hold to literals */
const VENDORED = 'js/lib/';
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

/** Whether `block`'s own statements declare `name`, which then hides a loop's item of that name */
function declares(block, name) {
  return block.statements.some(
    statement =>
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name)) ||
      ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name && statement.name.text === name),
  );
}

/**
 * The names `node` takes when it's the item of a `for (const name of ['a', 'b'])` loop around it
 * over string literals alone, which the scan reads as those literals, or null. A function, or a
 * block or another loop that declares the name, between them hides the item, so it's null then.
 */
function loopNames(node) {
  const n = node && strip(node);
  if (!n || !ts.isIdentifier(n)) return null;
  let child = n;
  for (let at = n.parent; at; child = at, at = at.parent) {
    if (ts.isFunctionLike(at) || ts.isCatchClause(at)) return null;
    if (ts.isBlock(at) && declares(at, n.text)) return null;
    const head = ts.isForStatement(at) || ts.isForInStatement(at) || ts.isForOfStatement(at) ? at.initializer : null;
    if (!head || !ts.isVariableDeclarationList(head)) continue;
    const bound = head.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === n.text);
    if (!bound) continue;
    if (!ts.isForOfStatement(at) || child !== at.statement || !(head.flags & ts.NodeFlags.Const)) return null;
    const items = strip(at.expression);
    if (!ts.isArrayLiteralExpression(items) || head.declarations.length !== 1) return null;
    const names = items.elements.map(literal);
    return names.every(name => name !== null) ? names : null;
  }
  return null;
}

/** The member `node` reads, `x.name` or `x['name']`, or null */
function memberName(node) {
  const n = strip(node);
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) return literal(n.argumentExpression);
  return null;
}

/** An object literal member's name, a plain, quoted, or computed one, or null */
function keyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) ? literal(name.expression) : null;
}

/** Whether `node` names an AbortSignal: `signal`, or `x.signal` */
function isSignal(node) {
  const n = strip(node);
  return (ts.isIdentifier(n) && n.text === 'signal') || (ts.isPropertyAccessExpression(n) && n.name.text === 'signal');
}

/**
 * Whether `node` reads as a transaction: `tx`, `txn` or `transaction`, a name ending in `Tx`,
 * `Txn` or `Transaction`, either as a property, or a `transaction(…)` call
 */
function isTransactionLike(node) {
  const n = strip(node);
  const named = text => /^(?:tx|txn|transaction)$|(?:Tx|Txn|Transaction)$/.test(text);
  if (ts.isIdentifier(n)) return named(n.text);
  if (ts.isPropertyAccessExpression(n)) return named(n.name.text);
  return ts.isCallExpression(n) && memberName(n.expression) === 'transaction';
}

/** Whether `n` is an assignment of any kind: `=`, `??=`, `||=`, `+=`, ... */
const isAssignment = n =>
  ts.isBinaryExpression(n) &&
  n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

/** Whether `n` is a member of an object literal with a name: a property, a method, an accessor */
const isLiteralMember = n =>
  (ts.isPropertyAssignment(n) ||
    ts.isShorthandPropertyAssignment(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)) &&
  ts.isObjectLiteralExpression(n.parent);

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
 * What an object literal holding a handler sets it on: the first argument of the call it's
 * passed to after it, as in Object.assign(tx, {…}), or the literal itself
 */
function holderOf(object) {
  const call = object.parent;
  if (ts.isCallExpression(call) && call.arguments.length > 1 && call.arguments[0] !== object) return call.arguments[0];
  return object;
}

/**
 * Each wait on a transaction's end in one file's source, as {file, line, event, named, on}: the
 * event waited for, or null with `named`, the expression, for an event name the scan can't read,
 * and what it's set on as the source writes it
 */
function scanSource(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const readers = readersOf(sf);
  const waits = [];
  const textOf = node => node.getText(sf).replace(/\s+/g, ' ').slice(0, 60);
  /**
   * @param {ts.Node} node - where the wait is
   * @param {'complete' | 'abort' | null} event - null for a name the scan can't read
   * @param {ts.Node | undefined} receiver
   * @param {ts.Node} [named] - the expression naming an event the scan can't read
   */
  const add = (node, event, receiver, named) => {
    const on = receiver ? strip(receiver) : node;
    const exempt = isSignal(on) || isNewReader(on) || (ts.isIdentifier(on) && readers.has(on.text));
    if (event !== 'complete' && exempt) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    waits.push({ file, line: line + 1, event, named: named ? textOf(named) : null, on: textOf(on) });
  };
  const vendored = file.startsWith(VENDORED);
  /** A listener for the event `name` names, added on `receiver` */
  const listener = (node, name, receiver) => {
    if (!name) return;
    const event = literal(name);
    const events = event === null ? loopNames(name) : [event];
    if (events === null && !vendored) add(node, null, receiver, name);
    for (const each of events || []) if (EVENTS.has(each)) add(node, each, receiver);
  };
  (function walk(n) {
    // x.oncomplete = …, x.onabort ??= …, x['oncomplete'] ||= …, and tx[key] = … with a key it
    // can't read
    if (isAssignment(n)) {
      const left = strip(n.left);
      const name = memberName(left);
      if (name !== null && HANDLERS.has(name)) add(n, HANDLERS.get(name), left.expression);
      const unread = ts.isElementAccessExpression(left) && name === null && !vendored;
      if (unread && isTransactionLike(left.expression)) {
        const handlers = loopNames(left.argumentExpression);
        if (handlers === null) add(n, null, left.expression, left.argumentExpression);
        for (const each of handlers || []) if (HANDLERS.has(each)) add(n, HANDLERS.get(each), left.expression);
      }
    }
    // { oncomplete: …, onabort() {…} }, as Object.assign(tx, …) takes it
    if (isLiteralMember(n)) {
      const name = keyName(n.name);
      if (name !== null && HANDLERS.has(name)) add(n, HANDLERS.get(name), holderOf(n.parent));
    }
    if (ts.isCallExpression(n)) {
      const callee = strip(n.expression);
      // Object.defineProperty(x, 'oncomplete', …), Reflect.set(x, 'onabort', …)
      for (const arg of n.arguments) {
        const name = literal(arg);
        if (name !== null && HANDLERS.has(name)) add(n, HANDLERS.get(name), arg === n.arguments[0] ? undefined : n.arguments[0]);
      }
      // x.addEventListener(…), x?.addEventListener(…), x['addEventListener'](…)
      if (memberName(callee) === 'addEventListener') listener(n, n.arguments[0], callee.expression);
      // ….addEventListener.call(x, …), ….addEventListener.apply(x, […]), and
      // ….addEventListener.bind(x), whose calls name events the scan can't follow
      if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && memberName(callee.expression) === 'addEventListener') {
        const how = memberName(callee);
        if (how === 'call') listener(n, n.arguments[1], n.arguments[0]);
        if (how === 'apply' && n.arguments[1]) {
          const list = strip(n.arguments[1]);
          listener(n, ts.isArrayLiteralExpression(list) ? list.elements[0] || list : list, n.arguments[0]);
        }
        if (how === 'bind' && !vendored) add(n, null, n.arguments[0] || strip(callee.expression).expression, n);
      }
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
  `${wait.file}:${wait.line} ${
    wait.event === null
      ? `names an event or a handler on ${wait.on} through ${wait.named}, which the scan can't read: name it with a literal, and`
      : `waits on ${wait.on}'s ${wait.event}:`
  } wait on a transaction's end with endOf(tx) from ${ALLOWED}, which also ends when the connection closes, since Chrome fires neither event on a transaction a forced close catches`;

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

module.exports = { ALLOWED, VENDORED, scanSource, listFiles, collect, problemOf, main };
