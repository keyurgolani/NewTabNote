'use strict';

/**
 * What the output checks read from a shipped script, from one parse with the TypeScript
 * compiler API: the paths it names (closure), the URL-like literals and where they sit
 * (remote code), its environment reads (environment), and the syntax only a module parses
 * (load mode). Each file is parsed once per content however many checks ask.
 */

const crypto = require('node:crypto');
const ts = require('typescript');

/**
 * @typedef {'import' | 'dynamic-import' | 'worker' | 'worker-url' | 'import-scripts' | 'get-url' | 'offscreen-document' | 'tabs-create' | 'icon-url'} ReferenceKind
 * A `worker-url` is a worker started with `new Worker(new URL(path, import.meta.url))`, whose path
 * resolves against the script itself, as the bundler writes every worker (#27 slice 2).
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
 *   any other use, which could read them all, process read on its own included. `process.env &&
 *   ...` reads nothing.
 * @property {string[]} functionConstructors - where the Function constructor is called or
 *   constructed some way ESLint's no-new-func doesn't see (isFunctionConstructor)
 * @property {string[]} moduleSyntax - where it has syntax only a module parses: an import or
 *   export statement, or import.meta
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
 * Whether `node` is process.env or process['env'], through the global object or not
 * (globalThis.process.env)
 * @param {ts.Node} node
 * @returns {boolean}
 */
function isProcessEnv(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const names = memberPath(node);
  return names !== null && names.length === 2 && names[0] === 'process' && names[1] === 'env';
}

/**
 * Whether the identifier `node` reads a variable: not a property's or a declaration's name,
 * and not the operand of typeof, which reads nothing
 * @param {ts.Identifier} node
 * @returns {boolean}
 */
function isVariableRead(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
    || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false;
  if (ts.isTypeOfExpression(parent)) return false;
  return true;
}

/**
 * Whether `node` is the Function constructor reached some way ESLint's no-new-func doesn't
 * know: through the global object (self.Function, globalThis.Function, window.Function), or as
 * a function literal's constructor (`(() => {}).constructor`)
 * @param {ts.Expression} node
 * @returns {boolean}
 */
function isFunctionConstructor(node) {
  let callee = node;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
  const names = memberPath(callee);
  if (names !== null && names.length === 1 && names[0] === 'Function') return true;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : literal(callee.argumentExpression);
  if (name !== 'constructor') return false;
  /** @type {ts.Expression} */
  let object = callee.expression;
  while (ts.isParenthesizedExpression(object)) object = object.expression;
  return ts.isArrowFunction(object) || ts.isFunctionExpression(object);
}

/**
 * Whether `node` is import.meta.url, or `'' + import.meta.url` as Vite writes it
 * @param {ts.Expression} node
 * @returns {boolean}
 */
function isImportMetaUrl(node) {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    && ts.isStringLiteralLike(expression.left) && expression.left.text === '') expression = expression.right;
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'url'
    && ts.isMetaProperty(expression.expression) && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
}

/**
 * The path argument of `new URL(path, import.meta.url)`, or null when `node` is anything else
 * @param {ts.Expression} node
 * @returns {ts.Expression | null}
 */
function moduleUrl(node) {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isNewExpression(expression) || !expression.arguments || expression.arguments.length !== 2) return null;
  const names = memberPath(expression.expression);
  if (names === null || names.length !== 1 || names[0] !== 'URL') return null;
  return isImportMetaUrl(expression.arguments[1]) ? expression.arguments[0] : null;
}

/**
 * Whether `node` is a chrome.runtime.getURL call, which names its path itself
 * @param {ts.Expression} node
 * @returns {boolean}
 */
function isGetUrlCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const names = memberPath(node.expression);
  return names !== null && names.join('.') === 'chrome.runtime.getURL';
}

/**
 * Whether `source` declares a binding named `name` anywhere: a function or class, a variable or
 * a destructured one, a parameter, or an import
 * @param {ts.SourceFile} source
 * @param {string} name
 * @returns {boolean}
 */
function declares(source, name) {
  let found = false;
  /** @param {ts.Node} node */
  const look = (node) => {
    if (found) return;
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)
      || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
      || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node))
      && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, look);
  };
  look(source);
  return found;
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
    // `{ url }` passes the variable url, a value known only at run time
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
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

  // ScriptKind.JS detects module syntax itself, so a classic script parses as one. Parents are
  // set, since whether an identifier is a read depends on what holds it.
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const at = (/** @type {ts.Node} */ node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${line + 1}:${character + 1}`;
  };
  /** @type {ScriptScan} */
  const scan = { references: [], urls: [], environment: [], functionConstructors: [], moduleSyntax: [] };
  // A file that declares its own process (a function, a local, a parameter, an import) reads
  // that one, not Node's, wherever it names it
  const declaresProcess = declares(source, 'process');
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
    // process itself, handed on or aliased (`const p = process; p.env.X`), could read it all
    if (!declaresProcess && ts.isIdentifier(node) && node.text === 'process' && isVariableRead(node)) {
      scan.environment.push({ what: 'process', name: null, at: at(node) });
      return;
    }
    if ((ts.isPropertyAccessExpression(node) && node.name.text === 'env'
      || ts.isElementAccessExpression(node) && literal(node.argumentExpression) === 'env')
      && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
      scan.environment.push({ what: 'import.meta.env', name: null, at: at(node) });
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isFunctionConstructor(node.expression)) {
      scan.functionConstructors.push(at(node));
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
        node.arguments.forEach((argument) => reference('import-scripts', argument, argument));
        argumentContext = 'importScripts';
      } else if (name === 'chrome.runtime.getURL') {
        reference('get-url', node.arguments[0], node);
      } else if (name === 'chrome.offscreen.createDocument') {
        reference('offscreen-document', propertyValue(node.arguments[0], 'url'), node);
      } else if (name === 'chrome.tabs.create') {
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options) || options.properties.some(ts.isSpreadAssignment)) {
          // Options it can't read, or a spread that may carry the url: a path known only at run time
          reference('tabs-create', undefined, options || node);
        } else {
          const url = propertyValue(options, 'url');
          // A getURL call is its own reference; any other call builds the path at run time
          if (url && !isGetUrlCall(url)) reference('tabs-create', url, url);
        }
      }
    } else if (ts.isNewExpression(node)) {
      const names = memberPath(node.expression);
      const name = names ? names.join('.') : '';
      if (name === 'Worker' || name === 'SharedWorker') {
        const argument = node.arguments ? node.arguments[0] : undefined;
        const url = argument && moduleUrl(argument);
        if (url) reference('worker-url', url, url);
        else reference('worker', argument, node);
        argumentContext = 'Worker';
      }
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'iconUrl') {
      reference('icon-url', node.name, node.name);
    } else if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'iconUrl' && !isGetUrlCall(node.initializer)) {
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

  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) || []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement) || exported) scan.moduleSyntax.push(at(statement));
  }
  const importMeta = (/** @type {ts.Node} */ node) => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) scan.moduleSyntax.push(at(node));
    ts.forEachChild(node, importMeta);
  };
  importMeta(source);

  cache.set(key, scan);
  return scan;
}

module.exports = { scanScript, memberPath };
