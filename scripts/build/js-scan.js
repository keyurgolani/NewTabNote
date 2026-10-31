'use strict';

/**
 * What the output checks read from a shipped script, from one parse with the TypeScript
 * compiler API: the paths it names (closure), the URL-like literals and where they sit
 * (remote code), and its environment reads (environment). Each file is parsed once per
 * content however many checks ask.
 */

const crypto = require('node:crypto');
const ts = require('typescript');

/**
 * @typedef {'import' | 'dynamic-import' | 'worker' | 'import-scripts' | 'get-url' | 'offscreen-document' | 'tabs-create' | 'icon-url'} ReferenceKind
 */

/**
 * @typedef {object} Reference
 * @property {ReferenceKind} kind
 * @property {string | null} value - the path as written, or null when it's built at run time
 * @property {string} at - line:column, both counted from 1
 */

/**
 * @typedef {'import' | 'importScripts' | 'Worker' | 'wasmPaths'} UrlContext
 */

/**
 * @typedef {object} UrlLiteral
 * @property {string} value - the literal's text, with `${...}` where a template has an expression
 * @property {string} at
 * @property {UrlContext | null} context - the call or property it's an argument or value of
 */

/**
 * @typedef {object} ScriptScan
 * @property {Reference[]} references
 * @property {UrlLiteral[]} urls - string and template literals with `//` in them
 * @property {Array<{what: string, name: string | null, at: string}>} environment - process.env and
 *   import.meta.env reads: the variable's name for a read of one, such as NODE_ENV, or null for
 *   any other use, which could read them all. `process.env && ...` reads nothing.
 */

/** @type {Map<string, ScriptScan>} */
const cache = new Map();

/** Prefixes that name the global object, so self.importScripts is importScripts */
const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis']);

/**
 * The dotted names of a member expression, like ['chrome', 'runtime', 'getURL'], without a
 * leading window., self., or globalThis., or null when a part is computed
 * @param {ts.Expression} expression
 * @returns {string[] | null}
 */
function memberPath(expression) {
  /** @type {string[]} */
  const names = [];
  let node = expression;
  for (;;) {
    if (ts.isIdentifier(node)) {
      names.unshift(node.text);
      break;
    }
    if (ts.isPropertyAccessExpression(node)) {
      names.unshift(node.name.text);
      node = node.expression;
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      names.unshift(node.argumentExpression.text);
      node = node.expression;
    } else if (ts.isParenthesizedExpression(node)) {
      node = node.expression;
    } else {
      return null;
    }
  }
  while (names.length > 1 && GLOBAL_OBJECTS.has(names[0])) names.shift();
  return names;
}

/**
 * Whether `node` is process.env or process['env']
 * @param {ts.Node} node
 * @returns {boolean}
 */
function isProcessEnv(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'env' && ts.isIdentifier(node.expression) && node.expression.text === 'process';
  if (ts.isElementAccessExpression(node)) return ts.isIdentifier(node.expression) && node.expression.text === 'process' && literal(node.argumentExpression) === 'env';
  return false;
}

/**
 * A string literal's text, or null for anything else, a template with an expression included
 * @param {ts.Node | undefined} node
 * @returns {string | null}
 */
function literal(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return null;
}

/**
 * The value of property `name` in an object literal, or undefined
 * @param {ts.Node | undefined} node
 * @param {string} name
 * @returns {ts.Expression | undefined}
 */
function propertyValue(node, name) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property.initializer;
  }
  return undefined;
}

/**
 * @param {ts.PropertyName} name
 * @returns {string | null}
 */
function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * Parse and read one script
 * @param {string} file - its path, for the parser's diagnostics only
 * @param {string} text
 * @returns {ScriptScan}
 */
function scanScript(file, text) {
  const key = `${file}\0${crypto.createHash('sha256').update(text).digest('hex')}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // ScriptKind.JS detects module syntax itself, so a classic script parses as one
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const at = (/** @type {ts.Node} */ node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${line + 1}:${character + 1}`;
  };
  /** @type {ScriptScan} */
  const scan = { references: [], urls: [], environment: [] };
  const reference = (/** @type {ReferenceKind} */ kind, /** @type {ts.Node | undefined} */ node, /** @type {ts.Node} */ where) => {
    scan.references.push({ kind, value: literal(node), at: at(node || where) });
  };

  /**
   * @param {ts.Node} node
   * @param {UrlContext | null} context
   */
  const visit = (node, context) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      reference('import', node.moduleSpecifier, node);
      ts.forEachChild(node, (child) => visit(child, child === node.moduleSpecifier ? 'import' : context));
      return;
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text.includes('//')) scan.urls.push({ value: node.text, at: at(node), context });
    } else if (ts.isTemplateExpression(node)) {
      const value = node.head.text + node.templateSpans.map((span) => `\${...}${span.literal.text}`).join('');
      if (value.includes('//')) scan.urls.push({ value, at: at(node), context });
    }

    // A read of one variable, such as process.env.NODE_ENV: the object is part of it
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isProcessEnv(node.expression)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression);
      scan.environment.push({ what: name === null ? 'process.env[...]' : `process.env.${name}`, name, at: at(node) });
      if (ts.isElementAccessExpression(node)) visit(node.argumentExpression, context);
      return;
    }
    // In `a && process.env && b`, process.env only checks that there's an environment and reads
    // nothing. As the last operand it's the chain's value, so it counts there.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      /** @type {ts.Expression[]} */
      const operands = [];
      /** @type {ts.Expression} */
      let current = node;
      while (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        operands.unshift(current.right);
        current = current.left;
      }
      operands.unshift(current);
      operands.forEach((operand, i) => {
        if (i < operands.length - 1 && isProcessEnv(operand)) return;
        visit(operand, context);
      });
      return;
    }
    if (isProcessEnv(node)) {
      scan.environment.push({ what: 'process.env', name: null, at: at(node) });
      return;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'env' && ts.isMetaProperty(node.expression)
      && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
      scan.environment.push({ what: 'import.meta.env', name: null, at: at(node) });
    }

    // Each argument of these calls is visited with the call as its context
    /** @type {UrlContext | null} */
    let argumentContext = null;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const names = callee.kind === ts.SyntaxKind.ImportKeyword ? null : memberPath(callee);
      const name = names ? names.join('.') : '';
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        reference('dynamic-import', node.arguments[0], node);
        argumentContext = 'import';
      } else if (name === 'importScripts') {
        if (node.arguments.length === 0) reference('import-scripts', undefined, node);
        node.arguments.forEach((argument) => reference('import-scripts', argument, argument));
        argumentContext = 'importScripts';
      } else if (name === 'chrome.runtime.getURL') {
        reference('get-url', node.arguments[0], node);
      } else if (name === 'chrome.offscreen.createDocument') {
        reference('offscreen-document', propertyValue(node.arguments[0], 'url'), node);
      } else if (name === 'chrome.tabs.create') {
        const url = propertyValue(node.arguments[0], 'url');
        // A URL built by a call, such as getURL, is that call's reference
        if (url && !ts.isCallExpression(url)) reference('tabs-create', url, url);
      }
    } else if (ts.isNewExpression(node)) {
      const names = memberPath(node.expression);
      const name = names ? names.join('.') : '';
      if (name === 'Worker' || name === 'SharedWorker') {
        reference('worker', node.arguments ? node.arguments[0] : undefined, node);
        argumentContext = 'Worker';
      }
    } else if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'iconUrl' && !ts.isCallExpression(node.initializer)) {
      reference('icon-url', node.initializer, node.initializer);
    }

    if (argumentContext && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
      visit(node.expression, context);
      (node.arguments || []).forEach((argument) => visit(argument, argumentContext));
      return;
    }
    // A wasmPaths assignment or property: what it's set to is the WASM runtime's location
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      const names = memberPath(node.left);
      if (names && names[names.length - 1] === 'wasmPaths') {
        visit(node.left, context);
        visit(node.right, 'wasmPaths');
        return;
      }
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'wasmPaths') {
      visit(node.initializer, 'wasmPaths');
      return;
    }
    ts.forEachChild(node, (child) => visit(child, context));
  };
  visit(source, null);

  cache.set(key, scan);
  return scan;
}

module.exports = { scanScript, memberPath };
