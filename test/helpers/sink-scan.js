'use strict';

/**
 * Finds every raw markup sink in block code (#14 slice 2, the rendering boundary), read from
 * the syntax tree, so a comment or a string never counts: an assignment to `innerHTML` or
 * `outerHTML` (`=` or `+=`) or `srcdoc`, and a call to `insertAdjacentHTML`,
 * `setHTMLUnsafe`, `createContextualFragment`, `document.write`, `document.writeln`, or
 * `execCommand('insertHTML', ...)`. Each comes with the function it's in and what it puts in:
 * - `static`: a string or a template with no substitutions, which is packaged markup;
 * - `dynamic`: anything else.
 * Assigning the empty string puts nothing in, so it isn't a sink. security/render-sinks.json
 * lists the files that are block code, and the sinks each may have.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');
const ASSIGNED = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const CALLED = new Set(['insertAdjacentHTML', 'setHTMLUnsafe', 'createContextualFragment']);
const WRITES = new Set(['write', 'writeln']);

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

/**
 * The sink `node` is, with the markup it puts in, or null
 * @param {ts.Node} node
 * @returns {{sink: string, value: ts.Node | undefined} | null}
 */
function sinkOf(node) {
  if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && ASSIGNED.has(node.left.name.text)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.PlusEqualsToken) {
      // Nothing to put in
      if (op === ts.SyntaxKind.EqualsToken && isStaticText(node.right) && /** @type {ts.StringLiteral} */ (node.right).text === '') return null;
      return { sink: node.left.name.text, value: node.right };
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text;
    if (CALLED.has(name)) return { sink: name, value: node.arguments[name === 'insertAdjacentHTML' ? 1 : 0] };
    if (WRITES.has(name) && /document$/i.test(node.expression.expression.getText())) return { sink: `document.${name}`, value: node.arguments[0] };
    if (name === 'execCommand' && node.arguments[0] && isStaticText(node.arguments[0])) {
      const command = /** @type {ts.StringLiteral} */ (node.arguments[0]).text.toLowerCase();
      if (command === 'inserthtml') return { sink: 'execCommand insertHTML', value: node.arguments[2] };
    }
  }
  return null;
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
    const site = sinkOf(node);
    if (site) {
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
