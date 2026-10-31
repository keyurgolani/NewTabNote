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
 * check (`background/dom`). The guards this knows:
 *   typeof document !== 'undefined' ? document.title : ''      (=== with the branches swapped)
 *   typeof document !== 'undefined' && document.title          (=== with ||)
 *   if (typeof document !== 'undefined') { ... }                (=== with the else branch)
 *   if (typeof document === 'undefined') return; ...            (an exit: return, throw, break,
 *                                                                continue), for what follows it
 * A check may be one of several conditions joined the same way (`a && typeof window !==
 * 'undefined'`). A name declared in a scope around the read, such as a parameter or a local of
 * an enclosing block, isn't the global, and `typeof document` reads nothing.
 */

const ts = require('typescript');
const { problem } = require('./diagnostics.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */

/** Where the background ships, a stable name the manifest gives */
const BACKGROUND = 'js/background.js';

/** The page globals a service worker doesn't have */
const PAGE_GLOBALS = ['document', 'window'];

/**
 * A module's syntax tree, parsed as the ES module it loads as even with no import or export, as
 * the shipped js/background.js has none: as a script, `await (x)` is a call to a function named
 * await, and `await [x]` an index into it
 * @param {string} file
 * @param {string} text
 * @returns {ts.SourceFile}
 */
function parse(file, text) {
  const asModule = (/** @type {ts.SourceFile} */ source) => { /** @type {any} */ (source).externalModuleIndicator = true; };
  return ts.createSourceFile(file, text, { languageVersion: ts.ScriptTarget.Latest, setExternalModuleIndicator: asModule }, true, ts.ScriptKind.JS);
}

/**
 * line:column of a node, both from 1
 * @param {ts.SourceFile} source
 * @param {ts.Node} node
 * @returns {string}
 */
function at(source, node) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${line + 1}:${character + 1}`;
}

/**
 * Whether `node` is a function body boundary, past which an await isn't at the top level
 * @param {ts.Node} node
 * @returns {boolean}
 */
function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node) || ts.isClassStaticBlockDeclaration(node);
}

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
 * Whether `expression`, parentheses aside, is `typeof name OP 'undefined'` either way round,
 * with OP one of `operators`
 * @param {ts.Expression} expression
 * @param {string} name
 * @param {ts.SyntaxKind[]} operators
 * @returns {boolean}
 */
function isTypeofCheck(expression, name, operators) {
  let node = expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isBinaryExpression(node) || !operators.includes(node.operatorToken.kind)) return false;
  const typeofOf = (/** @type {ts.Expression} */ side) => ts.isTypeOfExpression(side) && ts.isIdentifier(side.expression) && side.expression.text === name;
  const undefinedString = (/** @type {ts.Expression} */ side) => ts.isStringLiteralLike(side) && side.text === 'undefined';
  return (typeofOf(node.left) && undefinedString(node.right)) || (undefinedString(node.left) && typeofOf(node.right));
}

const DEFINED = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];
const UNDEFINED = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];

/**
 * The operands of a chain of `operator`, parentheses aside: `a && (b && c)` is [a, b, c]
 * @param {ts.Expression} expression
 * @param {ts.SyntaxKind} operator
 * @returns {ts.Expression[]}
 */
function operandsOf(expression, operator) {
  let node = expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === operator) {
    return [...operandsOf(node.left, operator), ...operandsOf(node.right, operator)];
  }
  return [node];
}

/**
 * Whether `condition` being true means `name` is defined
 * @param {ts.Expression} condition
 * @param {string} name
 * @returns {boolean}
 */
function provesDefined(condition, name) {
  return operandsOf(condition, ts.SyntaxKind.AmpersandAmpersandToken).some((operand) => isTypeofCheck(operand, name, DEFINED));
}

/**
 * Whether `condition` being false means `name` is defined
 * @param {ts.Expression} condition
 * @param {string} name
 * @returns {boolean}
 */
function falseProvesDefined(condition, name) {
  return operandsOf(condition, ts.SyntaxKind.BarBarToken).some((operand) => isTypeofCheck(operand, name, UNDEFINED));
}

/**
 * Whether a statement always leaves the code after it: return, throw, break, or continue, or a
 * block that ends with one
 * @param {ts.Statement} statement
 * @returns {boolean}
 */
function exits(statement) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1];
    return last !== undefined && exits(last);
  }
  return false;
}

/**
 * Whether one of the statements before `statement` in its list is an exit taken when `name`
 * is undefined
 * @param {ts.Node} statement
 * @param {string} name
 * @returns {boolean}
 */
function followsExitGuard(statement, name) {
  const list = ts.isBlock(statement.parent) || ts.isSourceFile(statement.parent) || ts.isCaseClause(statement.parent) || ts.isDefaultClause(statement.parent)
    ? statement.parent.statements
    : null;
  if (!list) return false;
  for (const earlier of list) {
    if (earlier === statement) return false;
    if (ts.isIfStatement(earlier) && !earlier.elseStatement && falseProvesDefined(earlier.expression, name) && exits(earlier.thenStatement)) {
      // The exit is taken when the check says undefined; past it the name is defined
      return true;
    }
  }
  return false;
}

/**
 * Whether the read `node` of `name` sits behind a typeof check
 * @param {ts.Node} node
 * @param {string} name
 * @returns {boolean}
 */
function isGuarded(node, name) {
  /** @type {ts.Node} */
  let child = node;
  let parent = node.parent;
  while (parent) {
    if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue && provesDefined(parent.condition, name)) return true;
      if (child === parent.whenFalse && falseProvesDefined(parent.condition, name)) return true;
    } else if (ts.isBinaryExpression(parent) && child === parent.right) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && provesDefined(parent.left, name)) return true;
      if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && falseProvesDefined(parent.left, name)) return true;
    } else if (ts.isIfStatement(parent)) {
      if (child === parent.thenStatement && provesDefined(parent.expression, name)) return true;
      if (child === parent.elseStatement && falseProvesDefined(parent.expression, name)) return true;
    }
    if (ts.isStatement(child) && followsExitGuard(child, name)) return true;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Whether a binding name, destructured or not, binds `name`
 * @param {ts.BindingName} binding
 * @param {string} name
 * @returns {boolean}
 */
function binds(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name, name));
}

/**
 * Whether a declaration list binds `name`, when it's `var` or not, as `vars` asks
 * @param {ts.VariableDeclarationList} list
 * @param {string} name
 * @param {boolean} vars
 * @returns {boolean}
 */
function listBinds(list, name, vars) {
  const isVar = (list.flags & ts.NodeFlags.BlockScoped) === 0;
  return isVar === vars && list.declarations.some((declaration) => binds(declaration.name, name));
}

/**
 * Whether a function's body declares `name` with var, which binds it for the whole function,
 * nested blocks included and nested functions not
 * @param {ts.Node} body
 * @param {string} name
 * @returns {boolean}
 */
function declaresVar(body, name) {
  let found = false;
  /** @param {ts.Node} inner */
  const look = (inner) => {
    if (found || isFunctionLike(inner)) return;
    if (ts.isVariableDeclarationList(inner) && listBinds(inner, name, true)) {
      found = true;
      return;
    }
    ts.forEachChild(inner, look);
  };
  ts.forEachChild(body, look);
  return found;
}

/**
 * Whether `scope` itself binds `name`: a block's let, const, class, and function declarations
 * (blocks scope functions in a module), a module's vars and imports, a function's parameters,
 * vars, and own name, a loop's or a catch clause's variable, and a class's own name
 * @param {ts.Node} scope
 * @param {string} name
 * @returns {boolean}
 */
function declaresHere(scope, name) {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseBlock(scope)) {
    const statements = ts.isCaseBlock(scope) ? scope.clauses.flatMap((clause) => [...clause.statements]) : [...scope.statements];
    return statements.some((statement) => {
      if (ts.isVariableStatement(statement)) return listBinds(statement.declarationList, name, false) || (ts.isSourceFile(scope) && listBinds(statement.declarationList, name, true));
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name !== undefined && statement.name.text === name;
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.name && clause.name.text === name) return true;
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text === name;
        return Boolean(bindings && bindings.elements.some((element) => element.name.text === name));
      }
      return false;
    });
  }
  if (isFunctionLike(scope)) {
    // A class static block has a body and no parameters
    const fn = /** @type {{parameters?: ts.NodeArray<ts.ParameterDeclaration>, body?: ts.Node}} */ (scope);
    if ((fn.parameters || []).some((parameter) => binds(parameter.name, name))) return true;
    if (ts.isFunctionExpression(scope) && scope.name && scope.name.text === name) return true;
    return fn.body !== undefined && declaresVar(fn.body, name);
  }
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const { initializer } = scope;
    return initializer !== undefined && ts.isVariableDeclarationList(initializer) && listBinds(initializer, name, false);
  }
  if (ts.isCatchClause(scope)) return scope.variableDeclaration !== undefined && binds(scope.variableDeclaration.name, name);
  if (ts.isClassExpression(scope) || ts.isClassDeclaration(scope)) return scope.name !== undefined && scope.name.text === name;
  return false;
}

/**
 * Whether `name` is declared in a scope that holds the read `node`, so that the read isn't of
 * the global: a parameter, a local in a block around it, a var of a function around it, a
 * function or class name, or an import
 * @param {ts.Node} node
 * @param {string} name
 * @returns {boolean}
 */
function isDeclaredInScope(node, name) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (declaresHere(scope, name)) return true;
  }
  return false;
}

/**
 * Whether the identifier `node` reads a variable, as opposed to naming a property, a
 * declaration, or a label, or being the operand of typeof
 * @param {ts.Identifier} node
 * @returns {boolean}
 */
function isRead(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
    || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isTypeOfExpression(parent)) return false;
  return true;
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
