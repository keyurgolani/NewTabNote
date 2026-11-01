'use strict';

/**
 * Finds every raw markup sink in block code (#14 slice 2, the rendering boundary), read from
 * the syntax tree, so a comment or a string never counts. A member is named as `el.name`,
 * `el['name']` or either in parentheses, and the sinks are:
 * - an assignment to `innerHTML`, `outerHTML` or `srcdoc`, by `=`, `+=`, `||=`, `??=` or
 *   `&&=`, or through `Object.assign` with an object literal or `Reflect.set`;
 * - `setAttribute('srcdoc', ...)`;
 * - a call to `insertAdjacentHTML`, `setHTMLUnsafe` or `createContextualFragment`;
 * - a document's `write` or `writeln`, on any receiver whose name has "doc" in it;
 * - `execCommand('insertHTML', ...)`, and `execCommand` with a command that isn't a literal;
 * - markup parsed into nodes, which the page can adopt: `parseFromString` (DOMParser's) and
 *   `parseHTMLUnsafe` (Document's). The scan can't follow the nodes, so the parse counts.
 * Each comes with the function it's in and what it puts in:
 * - `static`: a string or a template with no substitutions, which is packaged markup;
 * - `dynamic`: anything else.
 * A sink given the empty string, or an `execCommand` given no value, puts nothing in, so it
 * isn't one.
 *
 * What it can't see, so a review has to:
 * - a sink reached through a reference to its method or setter: `.call`, `.apply`, `.bind`,
 *   a destructured method, `Reflect.apply`, or an `innerHTML` descriptor's setter;
 * - `Object.assign` with a computed key, a spread, or a source that isn't an object literal,
 *   and any other key that isn't a literal;
 * - `setAttribute` with a name that isn't a literal, `setAttributeNS`, and an iframe's `src`
 *   set to a `data:` address;
 * - `write` or `writeln` on a receiver whose name has no "doc" in it, or one reached through a
 *   call, such as `open().write(...)`.
 * security/render-sinks.json lists the files that are block code, and the sinks each may have.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');
const ASSIGNED = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const CALLED = new Set(['insertAdjacentHTML', 'setHTMLUnsafe', 'createContextualFragment']);
const WRITES = new Set(['write', 'writeln']);
const PARSED = new Set(['parseFromString', 'parseHTMLUnsafe']);

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

/** @param {ts.Node} node */
const isStaticText = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** @param {ts.Node | undefined} node */
const isEmptyText = node => node !== undefined && isStaticText(node) && /** @type {ts.StringLiteral} */ (node).text === '';

/** The assignments that can put markup into a member */
const ASSIGNING = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/**
 * `node` without the parentheses around it
 * @param {ts.Node} node
 * @returns {ts.Node}
 */
function unwrap(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/**
 * The member `node` reads, `el.name` or `el['name']`, as its name and receiver, or null
 * @param {ts.Node} node
 * @returns {{name: string, receiver: ts.Expression} | null}
 */
function memberOf(node) {
  const target = unwrap(node);
  if (ts.isPropertyAccessExpression(target)) return { name: target.name.text, receiver: target.expression };
  if (ts.isElementAccessExpression(target) && isStaticText(target.argumentExpression)) {
    return { name: /** @type {ts.StringLiteral} */ (target.argumentExpression).text, receiver: target.expression };
  }
  return null;
}

/**
 * The name `node` ends in: an identifier's, or a member's
 * @param {ts.Node} node
 * @returns {string}
 */
function lastName(node) {
  const target = unwrap(node);
  if (ts.isIdentifier(target)) return target.text;
  return memberOf(target)?.name ?? '';
}

/**
 * A property's name in an object literal, when it's written out
 * @param {ts.ObjectLiteralElementLike} property
 * @returns {string | null}
 */
function propertyName(property) {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return property.name.text;
  return null;
}

/**
 * The sinks `node` is, each with the markup it puts in
 * @param {ts.Node} node
 * @returns {Array<{sink: string, value: ts.Node | undefined}>}
 */
function sinksOf(node) {
  if (ts.isBinaryExpression(node) && ASSIGNING.has(node.operatorToken.kind)) {
    const member = memberOf(node.left);
    if (member && ASSIGNED.has(member.name) && !isEmptyText(node.right)) return [{ sink: member.name, value: node.right }];
    return [];
  }
  if (!ts.isCallExpression(node)) return [];
  const member = memberOf(node.expression);
  if (!member) return [];
  const { name, receiver } = member;
  const args = node.arguments;
  if (name === 'assign' && lastName(receiver) === 'Object') {
    return args.slice(1).filter(ts.isObjectLiteralExpression).flatMap(source => source.properties.flatMap(property => {
      const key = propertyName(property);
      if (key === null || !ASSIGNED.has(key)) return [];
      const value = ts.isShorthandPropertyAssignment(property) ? property.name : /** @type {ts.PropertyAssignment} */ (property).initializer;
      return isEmptyText(value) ? [] : [{ sink: `Object.assign ${key}`, value }];
    }));
  }
  if (name === 'set' && lastName(receiver) === 'Reflect') {
    const key = args[1] && isStaticText(args[1]) ? /** @type {ts.StringLiteral} */ (args[1]).text : null;
    return key !== null && ASSIGNED.has(key) && !isEmptyText(args[2]) ? [{ sink: `Reflect.set ${key}`, value: args[2] }] : [];
  }
  if (name === 'setAttribute' && args[0] && isStaticText(args[0])) {
    const attribute = /** @type {ts.StringLiteral} */ (args[0]).text.toLowerCase();
    return attribute === 'srcdoc' && !isEmptyText(args[1]) ? [{ sink: 'setAttribute srcdoc', value: args[1] }] : [];
  }
  if (CALLED.has(name)) return [{ sink: name, value: args[name === 'insertAdjacentHTML' ? 1 : 0] }];
  if (PARSED.has(name)) return [{ sink: name, value: args[0] }];
  if (WRITES.has(name) && /doc/i.test(lastName(receiver))) return [{ sink: `document.${name}`, value: args[0] }];
  if (name === 'execCommand' && args[0]) {
    if (isStaticText(args[0])) {
      const command = /** @type {ts.StringLiteral} */ (args[0]).text.toLowerCase();
      return command === 'inserthtml' ? [{ sink: 'execCommand insertHTML', value: args[2] }] : [];
    }
    // A command that isn't a literal may be insertHTML; given no value, it puts nothing in
    const value = args[2];
    const none = value === undefined || isEmptyText(value) || value.kind === ts.SyntaxKind.NullKeyword
      || (ts.isIdentifier(value) && value.text === 'undefined');
    return none ? [] : [{ sink: 'execCommand', value }];
  }
  return [];
}

/**
 * The raw markup sinks in `source`, as `{sink, kind, function, line}`
 * @param {string} source
 * @param {string} [fileName]
 * @returns {Array<{sink: string, kind: 'static' | 'dynamic', function: string, line: number}>}
 */
function scanSource(source, fileName = 'source.js') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {Array<{sink: string, kind: 'static' | 'dynamic', function: string, line: number}>} */
  const found = [];
  const visit = (/** @type {ts.Node} */ node) => {
    for (const site of sinksOf(node)) {
      found.push({
        sink: site.sink,
        kind: site.value && isStaticText(site.value) ? 'static' : 'dynamic',
        function: enclosingName(node),
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The scripts under `scope`, each a file or a directory, that exist, from the repo root
 * @param {string[]} scope
 * @returns {string[]}
 */
function scopeFiles(scope) {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ entry) => {
    const full = path.join(ROOT, entry);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) {
      for (const child of fs.readdirSync(full)) walk(`${entry.replace(/\/$/, '')}/${child}`);
    } else if (/\.m?js$/.test(entry)) {
      files.push(entry);
    }
  };
  scope.forEach(walk);
  return [...new Set(files)].sort();
}

/**
 * Every raw markup sink in the ledger's scope, counted per file, function and kind. `texts`
 * stands in for files' contents, for a test that edits one.
 * @param {string[]} scope
 * @param {{texts?: Record<string, string>}} [options]
 * @returns {Map<string, {file: string, function: string, kind: string, count: number, sinks: string[], lines: number[]}>}
 */
function markupSinks(scope, { texts = {} } = {}) {
  const sinks = new Map();
  for (const file of scopeFiles(scope)) {
    const text = Object.hasOwn(texts, file) ? texts[file] : fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const site of scanSource(text, file)) {
      const key = `${file}#${site.function}#${site.kind}`;
      const entry = sinks.get(key) || { file, function: site.function, kind: site.kind, count: 0, sinks: [], lines: [] };
      entry.count += 1;
      if (!entry.sinks.includes(site.sink)) entry.sinks.push(site.sink);
      entry.lines.push(site.line);
      sinks.set(key, entry);
    }
  }
  return sinks;
}

/**
 * What the ledger gets wrong about `found`: a sink no row covers, a count that changed, and a
 * row whose sink is gone
 * @param {ReturnType<typeof markupSinks>} found
 * @param {{sinks: Array<{file: string, function: string, kind: string, count: number}>}} ledger
 * @returns {string[]}
 */
function ledgerProblems(found, ledger) {
  /** @type {string[]} */
  const problems = [];
  for (const [key, sink] of found) {
    const row = ledger.sinks.find(entry => entry.file === sink.file && entry.function === sink.function && entry.kind === sink.kind);
    if (!row) problems.push(`${key}: ${sink.count} ${sink.sinks.join(', ')} no ledger row covers (lines ${sink.lines.join(', ')})`);
    else if (row.count !== sink.count) problems.push(`${key}: ${sink.count} sinks, the ledger says ${row.count}`);
  }
  for (const entry of ledger.sinks) {
    if (!found.has(`${entry.file}#${entry.function}#${entry.kind}`)) problems.push(`${entry.file}#${entry.function}#${entry.kind}: a ledger row whose sink is gone`);
  }
  return problems;
}

module.exports = { markupSinks, scanSource, scopeFiles, ledgerProblems };
