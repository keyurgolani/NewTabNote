// The check behind conformance-inventory.mjs (#28 slice 2): what counts as an implementation,
// a suite, and a run, read from the source with TypeScript, so a name in a comment or a string
// counts for nothing. Nothing asks an implementation's author to mark it. It's found by:
//
// - where it lives: every module under js/kernel/, outside the areas NOT_IMPLEMENTATIONS
//   names, is bound, a helper, a composer, or unshared, so a new js/kernel/core/durable/ or
//   js/kernel/adapters/<anything>/ module is caught wherever #17 puts it;
// - its type: an export of a module #12's strict program (tsconfig.kernel.json) checks whose
//   value, return value, or instance has the members of a port's typedef, each method taking
//   what the port's passes it (return types aside, since JS infers `string` where the port
//   says `'absent'`), is an implementation of that port. That catches a ledger, a log, a
//   repository, or a transport by what it is, whatever it's called;
// - its shape, for what a type can't see: in js/kernel/, an object or class with a `connect`
//   method is a transport; anywhere, a call of `defineFamily` as imported from
//   js/kernel/registry/family.js, under any alias, is a registry family; and a module that
//   defines a `local` key, however its value is made, and members named `get` and `set` is a
//   chrome.storage implementation. js/, e2e/ outside specs, and test/ outside *.test.* files
//   are searched.
//
// A suite is a test/ module, outside *.test.* files, that exports `describe...` or
// `run...Suite`, or that a port lists. A run is a file `npm test` runs (an e2e spec that
// `npm run test:extension` runs, for a browser host) that loads the implementation itself or
// through a module other than the suite, and calls the suite's runner where it runs: at the top
// level, in a top-level loop or block, or in the callback of a describe that isn't skipped, with
// an argument made from what it loaded from the implementation.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import * as inventory from './conformance-inventory.mjs';

/** @typedef {typeof inventory} Inventory */
/** @typedef {{list: () => string[], read: (file: string) => string | undefined}} Tree */
/** @typedef {{file: string, port: string, why: string, node: ts.Node, source: ts.SourceFile}} Found */

export const ROOT = path.join(import.meta.dirname, '..', '..');

const SCANNED = ['js', 'test', 'e2e'];
// js/lib holds vendored bundles, and test/fixtures/storage/releases the v1.4.0 and v1.4.1
// js/storage.js and js/utils.js frozen byte for byte as #17's rollback and import fixtures
// (Q11), release artifacts that implement nothing here
const SKIPPED = new Set(['js/lib', 'test/fixtures/storage/releases']);
const MODULE = /\.(m?js|cjs)$/;
const TEST_FILE = /\.test\.(m?js|cjs)$/;
const SPEC_FILE = /\.spec\.js$/;
const SUITE_EXPORT = /^(describe[A-Z]\w*|run\w*Suite)$/;
const TRANSPORT_EXPORT = /^create\w*Transport$/;
const FAMILY_MODULE = 'js/kernel/registry/family.js';
const KERNEL_CONFIG = 'tsconfig.kernel.json';
// A describe whose callback runs, in node:test or Playwright, and the modifiers that stop it
const DESCRIBES = new Set(['describe', 'suite']);
const DESCRIBE_MODIFIERS = new Set(['describe', 'serial', 'parallel', 'only']);
const NOT_RUN = new Set(['skip', 'todo', 'fixme']);

/**
 * The repository's modules, as paths from its root with forward slashes
 * @param {string} [root]
 * @returns {Tree}
 */
export function repoTree(root = ROOT) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(file) && entry.name !== 'node_modules') walk(file);
      } else if (MODULE.test(entry.name)) {
        files.push(file);
      }
    }
  };
  for (const dir of SCANNED) if (fs.existsSync(path.join(root, dir))) walk(dir);
  files.push('package.json', KERNEL_CONFIG);
  return {
    list: () => files,
    read: file => (fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : undefined),
  };
}

/**
 * `tree` with `files` added or replaced; a file whose text is null is gone
 * @param {Tree} tree
 * @param {Record<string, string | null>} files
 * @returns {Tree}
 */
export function withFiles(tree, files) {
  const listed = new Set([...tree.list(), ...Object.keys(files)]);
  for (const [file, text] of Object.entries(files)) if (text === null) listed.delete(file);
  return {
    list: () => [...listed],
    read: file => (Object.hasOwn(files, file) ? (files[file] ?? undefined) : tree.read(file)),
  };
}

// ─── Reading modules ───

/** @type {Map<string, ts.SourceFile>} */
const parsed = new Map();

/**
 * @param {string} text
 * @returns {ts.SourceFile}
 */
function parse(text) {
  let source = parsed.get(text);
  if (!source) {
    source = ts.createSourceFile('module.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    parsed.set(text, source);
  }
  return source;
}

/** @type {WeakMap<ts.Node, ts.Node[]>} */
const allNodes = new WeakMap();
/** @type {WeakMap<ts.SourceFile, {specifier: string, names: string[]}[]>} */
const allLoads = new WeakMap();

/**
 * Every node of `source`, depth first
 * @param {ts.Node} root
 * @returns {ts.Node[]}
 */
function nodesOf(root) {
  const known = allNodes.get(root);
  if (known) return known;
  /** @type {ts.Node[]} */
  const nodes = [];
  allNodes.set(root, nodes);
  /** @param {ts.Node} node */
  const visit = node => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

/**
 * The name a property, method, or element is declared under, when it's written out
 * @param {ts.PropertyName | ts.BindingName | undefined} name
 */
function nameText(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
}

/**
 * What a module loads, with a string literal: static imports and re-exports, require(), and
 * import(), each with the names it binds here, if any
 * @param {ts.SourceFile} source
 * @returns {{specifier: string, names: string[]}[]}
 */
function loadsOf(source) {
  const known = allLoads.get(source);
  if (known) return known;
  /** @type {{specifier: string, names: string[]}[]} */
  const loads = [];
  allLoads.set(source, loads);
  for (const node of nodesOf(source)) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      /** @type {string[]} */
      const names = [];
      if (clause?.name) names.push(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map(element => element.name.text));
      loads.push({ specifier: node.moduleSpecifier.text, names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      loads.push({ specifier: node.moduleSpecifier.text, names: [] });
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind !== ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(callee) && callee.text === 'require')) continue;
      const declaration = node.parent && ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
      loads.push({ specifier: node.arguments[0].text, names: declaration ? bindingNames(declaration.name) : [] });
    }
  }
  return loads;
}

/**
 * The names a binding (a name or a destructuring pattern) declares
 * @param {ts.BindingName} name
 * @returns {string[]}
 */
function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

/**
 * The module `specifier` names from `from`, as a listed path, or undefined
 * @param {Set<string>} files
 * @param {string} from
 * @param {string} specifier
 */
function resolve(files, from, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`].find(candidate => files.has(candidate));
}

/**
 * The names a module exports, as an ES module or through module.exports
 * @param {ts.SourceFile} source
 * @returns {Map<string, ts.Node>}
 */
function exportsOf(source) {
  /** @type {Map<string, ts.Node>} */
  const names = new Map();
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name && exported) names.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) names.set(name, declaration);
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.set(element.name.text, element);
    }
  }
  for (const node of nodesOf(source)) {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const target = node.left.getText(source);
    if (target === 'module.exports' && ts.isObjectLiteralExpression(node.right)) {
      for (const property of node.right.properties) {
        const name = nameText(property.name);
        if (name) names.set(name, property);
      }
    } else if (/^(module\.)?exports\.\w+$/.test(target)) {
      names.set(target.slice(target.lastIndexOf('.') + 1), node);
    }
  }
  return names;
}

/**
 * The calls in `root` of a function by one of `names`, or of `method` on one of `namespaces`
 * @param {ts.Node} root
 * @param {Set<string>} names
 * @param {{method: string, namespaces: Set<string>}} [on]
 * @returns {ts.CallExpression[]}
 */
function callsOf(root, names, on) {
  return nodesOf(root).filter(
    /** @returns {node is ts.CallExpression} */
    node => {
      if (!ts.isCallExpression(node)) return false;
      const callee = node.expression;
      if (ts.isIdentifier(callee)) return names.has(callee.text);
      return Boolean(on) && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && /** @type {{method: string, namespaces: Set<string>}} */ (on).namespaces.has(callee.expression.text)
        && callee.name.text === /** @type {{method: string, namespaces: Set<string>}} */ (on).method;
    },
  );
}

/**
 * The identifiers `root` reads, leaving out property names
 * @param {ts.Node} root
 * @returns {Set<string>}
 */
function readsOf(root) {
  /** @type {Set<string>} */
  const reads = new Set();
  for (const node of nodesOf(root)) {
    if (!ts.isIdentifier(node)) continue;
    const parent = node.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) continue;
    if (parent && (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) continue;
    reads.add(node.text);
  }
  return reads;
}

/**
 * The top-level statement `node` is in
 * @param {ts.Node} node
 * @returns {ts.Node}
 */
function statementOf(node) {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  return current;
}

// ─── Runs ───

/**
 * The names a describe-like callee goes by, `test.describe.serial` as ['test', 'describe', 'serial']
 * @param {ts.Expression} callee
 * @returns {string[] | undefined}
 */
function calleeChain(callee) {
  if (ts.isIdentifier(callee)) return [callee.text];
  if (ts.isPropertyAccessExpression(callee)) {
    const head = calleeChain(callee.expression);
    return head && [...head, callee.name.text];
  }
  return undefined;
}

/**
 * Whether a call is to a describe whose callback runs: node:test's describe or suite, or
 * Playwright's test.describe, with no skip, todo, or fixme
 * @param {ts.CallExpression} call
 */
function runsItsCallback(call) {
  const chain = calleeChain(call.expression);
  if (!chain || chain.some(name => NOT_RUN.has(name))) return false;
  // node:test's options: { skip: true } or { todo: true } (anything but a literal false)
  const skipped = call.arguments.some(argument => ts.isObjectLiteralExpression(argument) && argument.properties.some(property => {
    const name = nameText(property.name);
    if (!name || !NOT_RUN.has(name)) return false;
    return !(ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword);
  }));
  if (skipped) return false;
  const [head, ...rest] = chain;
  if (DESCRIBES.has(head)) return rest.every(name => DESCRIBE_MODIFIERS.has(name));
  return head === 'test' && rest[0] === 'describe' && rest.slice(1).every(name => DESCRIBE_MODIFIERS.has(name));
}

/**
 * Whether `call` runs when its file loads: at the top level, in a top-level loop or block, or in
 * the callback of a describe that itself runs. Under a condition, in a function nothing calls,
 * or under skip, todo, or fixme, it doesn't.
 * @param {ts.Node} call
 */
function runsOnLoad(call) {
  let node = call;
  for (;;) {
    const parent = node.parent;
    if (!parent || ts.isSourceFile(parent)) return true;
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      const outer = parent.parent;
      if (!outer || !ts.isCallExpression(outer) || !outer.arguments.includes(/** @type {ts.Expression} */ (parent)) || !runsItsCallback(outer)) return false;
      node = outer;
    } else if (ts.isBlock(parent)) {
      const owner = parent.parent;
      const runs = !owner || ts.isSourceFile(owner) || ts.isBlock(owner) || ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)
        || ((ts.isForOfStatement(owner) || ts.isForInStatement(owner) || ts.isForStatement(owner)) && owner.statement === parent);
      if (!runs) return false;
      node = parent;
    } else if (ts.isForOfStatement(parent) || ts.isForInStatement(parent) || ts.isForStatement(parent)) {
      if (parent.statement !== node) return false;
      node = parent;
    } else if (ts.isExpressionStatement(parent) || ts.isVariableStatement(parent) || ts.isVariableDeclarationList(parent)
      || (ts.isVariableDeclaration(parent) && parent.initializer === node) || ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) {
      node = parent;
    } else {
      return false;
    }
  }
}

/**
 * The identifiers in `source` made from what it loads from `sources`, through declarations,
 * loops, and assignments
 * @param {ts.SourceFile} source
 * @param {Set<string>} roots
 */
function madeFrom(source, roots) {
  const tainted = new Set(roots);
  /** @type {[string[], ts.Node][]} */
  const flows = [];
  for (const node of nodesOf(source)) {
    if (ts.isVariableDeclaration(node) && node.initializer) flows.push([bindingNames(node.name), node.initializer]);
    if (ts.isFunctionDeclaration(node) && node.name && node.body) flows.push([[node.name.text], node.body]);
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
      flows.push([node.initializer.declarations.flatMap(declaration => bindingNames(declaration.name)), node.expression]);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      flows.push([[node.left.text], node.right]);
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [names, from] of flows) {
      if (names.every(name => tainted.has(name))) continue;
      if ([...readsOf(from)].some(name => tainted.has(name))) {
        for (const name of names) tainted.add(name);
        changed = true;
      }
    }
  }
  return tainted;
}

/**
 * The files a package.json script's arguments name or match, as a test
 * @param {string} script
 * @returns {(file: string) => boolean}
 */
function scriptRuns(script) {
  const patterns = script.split(/\s+/).filter(word => MODULE.test(word));
  const expressions = patterns.map(
    pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*/g, match => (match === '*' ? '[^/]*' : '(?:.*/)?'))}$`),
  );
  return file => expressions.some(expression => expression.test(file));
}

// ─── Types ───

/** @type {Map<string, ts.SourceFile>} */
const declarationFiles = new Map();
/** @type {Map<string, ts.SourceFile>} each module of a kernel program, by its path and text */
const kernelFiles = new Map();
/** @type {ts.Program | undefined} */
let lastProgram;
/** @type {Map<string, [string, string, string, string][]>} what typedImplementations found, by the program's files and texts */
const typedFound = new Map();

/**
 * #12's strict program over `tree`: the files tsconfig.kernel.json includes, read from the tree
 * @param {Tree} tree
 */
function kernelProgram(tree) {
  const config = ts.parseConfigFileTextToJson(KERNEL_CONFIG, tree.read(KERNEL_CONFIG) ?? '{}').config ?? {};
  const { options } = ts.convertCompilerOptionsFromJson(config.compilerOptions ?? {}, ROOT);
  const roots = tree.list().filter(file => (/^js\/kernel\/.*\.m?js$/.test(file) || /^test\/kernel\/.*\.mjs$/.test(file))).map(file => path.join(ROOT, file));
  const host = ts.createCompilerHost(options, true);
  /** @param {string} fileName */
  const inTree = fileName => {
    const relative = path.relative(ROOT, fileName).split(path.sep).join('/');
    return relative.startsWith('..') || relative.includes('node_modules') ? undefined : relative;
  };
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = fileName => {
    const file = inTree(fileName);
    return file ? tree.read(file) !== undefined : ts.sys.fileExists(fileName);
  };
  host.readFile = fileName => {
    const file = inTree(fileName);
    return file ? tree.read(file) : ts.sys.readFile(fileName);
  };
  host.getSourceFile = (fileName, language, ...rest) => {
    const file = inTree(fileName);
    if (!file) {
      // Library and @types declarations, the same in every tree
      let declarations = declarationFiles.get(fileName);
      if (!declarations) {
        declarations = getSourceFile(fileName, language, ...rest);
        if (declarations) declarationFiles.set(fileName, declarations);
      }
      return declarations;
    }
    const text = tree.read(file);
    if (text === undefined) return undefined;
    // The same file with the same text is the same SourceFile, so the next program reuses it
    const key = `${fileName}\0${text}`;
    let kept = kernelFiles.get(key);
    if (!kept) {
      kept = ts.createSourceFile(fileName, text, language, true, ts.ScriptKind.JS);
      kernelFiles.set(key, kept);
    }
    return kept;
  };
  lastProgram = ts.createProgram({ rootNames: roots, options, host, oldProgram: lastProgram });
  return lastProgram;
}

/**
 * Whether `type` has the members of `port`, each method taking what the port's is passed
 * @param {ts.TypeChecker} checker
 * @param {ts.Type} type
 * @param {ts.Type} port
 */
function implementsPort(checker, type, port) {
  if (checker.isTypeAssignableTo(type, port)) return true;
  const wanted = checker.getPropertiesOfType(port);
  if (wanted.length === 0) return false;
  return wanted.every(member => {
    const own = checker.getPropertyOfType(type, member.name);
    if (!own) return false;
    const portSignatures = checker.getTypeOfSymbol(member).getCallSignatures();
    if (portSignatures.length === 0) return true;
    const ownSignatures = checker.getTypeOfSymbol(own).getCallSignatures();
    return portSignatures.some(portSignature => ownSignatures.some(ownSignature => {
      const passed = portSignature.getParameters();
      const taken = ownSignature.getParameters();
      const required = taken.filter(parameter => {
        const declaration = parameter.valueDeclaration;
        return !(declaration && ts.isParameter(declaration) && (declaration.initializer || declaration.questionToken || declaration.dotDotDotToken));
      });
      if (required.length > passed.length) return false;
      return taken.every((parameter, index) => index >= passed.length
        || checker.isTypeAssignableTo(checker.getTypeOfSymbol(passed[index]), checker.getTypeOfSymbol(parameter)));
    }));
  });
}

/**
 * Each export, in the kernel program, whose type implements one of the typedefs `wanted` names
 * by contract file: [file, export, typedef, contract]
 * @param {Tree} tree
 * @param {Map<string, readonly string[]>} wanted
 * @returns {[string, string, string, string][]}
 */
function typedImplementations(tree, wanted) {
  // A tree whose kernel files and contracts are the same as one already read gets the same answer
  const key = JSON.stringify([
    [...wanted],
    tree.list().filter(file => /^(js|test)\/kernel\/.*\.m?js$/.test(file) || file === KERNEL_CONFIG).sort().map(file => [file, tree.read(file)]),
  ]);
  const known = typedFound.get(key);
  if (known) return known;
  const found = readTypes(tree, wanted);
  typedFound.set(key, found);
  return found;
}

/**
 * typedImplementations, read from the program
 * @param {Tree} tree
 * @param {Map<string, readonly string[]>} wanted
 * @returns {[string, string, string, string][]}
 */
function readTypes(tree, wanted) {
  const program = kernelProgram(tree);
  const checker = program.getTypeChecker();
  /** @type {[string, ts.Type, string][]} */
  const ports = [];
  for (const [contract, types] of wanted) {
    const source = program.getSourceFile(path.join(ROOT, contract));
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) continue;
    for (const name of types) {
      const typedef = checker.getExportsOfModule(symbol).find(candidate => candidate.name === name);
      if (typedef) ports.push([name, checker.getDeclaredTypeOfSymbol(typedef), contract]);
    }
  }
  /** @type {[string, string, string, string][]} */
  const found = [];
  for (const source of program.getSourceFiles()) {
    const file = path.relative(ROOT, source.fileName).split(path.sep).join('/');
    if (file.startsWith('..') || file.includes('node_modules') || !isShared(file)) continue;
    const symbol = checker.getSymbolAtLocation(source);
    if (!symbol) continue;
    for (const exported of checker.getExportsOfModule(symbol)) {
      const declaration = exported.valueDeclaration;
      if (!declaration) continue;
      const type = checker.getTypeOfSymbolAtLocation(exported, declaration);
      const made = [type];
      for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
        const returned = checker.getReturnTypeOfSignature(signature);
        made.push(returned, checker.getAwaitedType(returned) ?? returned);
      }
      for (const [name, port, contract] of ports) {
        const matches = made.some(candidate => !(candidate.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never))
          && implementsPort(checker, candidate, port));
        if (matches) found.push([file, exported.name, name, contract]);
      }
    }
  }
  return found;
}

// ─── Shapes ───

/**
 * Whether `file` is a shared module, one that isn't itself a test or a spec
 * @param {string} file
 */
const isShared = file => !TEST_FILE.test(file) && !SPEC_FILE.test(file);

/**
 * The objects and classes in `source` with a `connect` method, or a function under that name
 * @param {ts.SourceFile} source
 * @returns {ts.Node[]}
 */
function connectables(source) {
  /** @param {ts.Node} member */
  const isConnect = member => {
    if (!('name' in member) || nameText(/** @type {ts.PropertyName} */ (member.name)) !== 'connect') return false;
    if (ts.isMethodDeclaration(member)) return true;
    const value = ts.isPropertyAssignment(member) || ts.isPropertyDeclaration(member) ? member.initializer : undefined;
    return Boolean(value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)));
  };
  return nodesOf(source).filter(node => (ts.isObjectLiteralExpression(node) && node.properties.some(isConnect))
    || (ts.isClassLike(node) && node.members.some(isConnect)));
}

/**
 * The `local` keys `source` defines, when it also defines members named get and set: a
 * chrome.storage area, whatever makes its value
 * @param {ts.SourceFile} source
 * @returns {ts.Node[]}
 */
function storageAreas(source) {
  /** @type {Set<string>} */
  const members = new Set();
  /** @type {ts.Node[]} */
  const locals = [];
  for (const node of nodesOf(source)) {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const name = nameText(property.name);
        if (name) members.add(name);
        if (name === 'local') locals.push(property);
      }
    }
    if (ts.isClassLike(node)) for (const member of node.members) { const name = nameText(member.name); if (name) members.add(name); }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      const name = ts.isPropertyAccessExpression(target) ? target.name.text
        : ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression) ? target.argumentExpression.text : undefined;
      if (name === 'local') locals.push(node);
      if (name === 'get' || name === 'set') members.add(name);
    }
  }
  return members.has('get') && members.has('set') ? locals : [];
}

/**
 * The calls in `source` of defineFamily as js/kernel/registry/family.js exports it
 * @param {Set<string>} files
 * @param {string} file
 * @param {ts.SourceFile} source
 * @returns {ts.Node[]}
 */
function familyCalls(files, file, source) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<string>} */
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (resolve(files, file, statement.moduleSpecifier.text) !== FAMILY_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'defineFamily') names.add(element.name.text);
    }
  }
  return callsOf(source, names, { method: 'defineFamily', namespaces });
}

// ─── The check ───

/**
 * What's wrong with the repository's conformance coverage, one line each, or nothing
 * @param {Tree} tree
 * @param {Inventory} [given]
 * @returns {string[]}
 */
export function coverageProblems(tree, given = inventory) {
  const { PORTS, WITHOUT_SUITE, NOT_IMPLEMENTATIONS, HELPERS, COMPOSERS, UNSHARED, EXEMPT } = given;
  /** @type {string[]} */
  const problems = [];
  const files = new Set(tree.list());
  /** @param {string} file */
  const sourceOf = file => {
    const text = tree.read(file);
    return text === undefined ? undefined : parse(text);
  };
  /**
   * Every module `file` reaches through what it loads, `file` included, never entering `avoid`
   * @param {string} file
   * @param {string} [avoid]
   */
  const reach = (file, avoid) => {
    const seen = new Set([file]);
    const pending = [file];
    while (pending.length > 0) {
      const next = /** @type {string} */ (pending.pop());
      const source = sourceOf(next);
      if (!source) continue;
      for (const { specifier } of loadsOf(source)) {
        const target = resolve(files, next, specifier);
        if (target && target !== avoid && !seen.has(target)) {
          seen.add(target);
          pending.push(target);
        }
      }
    }
    return seen;
  };
  const pkg = JSON.parse(tree.read('package.json') ?? '{}');
  const npmTest = scriptRuns(pkg.scripts?.test ?? '');
  /** @param {string} file */
  const extensionRuns = file => Boolean(pkg.scripts?.['test:extension']) && file.startsWith('e2e/') && SPEC_FILE.test(file);

  /** @type {Map<string, string>} each implementation module, by the port it's bound to */
  const bound = new Map();
  for (const [id, port] of Object.entries(PORTS)) {
    if (!port.browser && !files.has(port.contract)) problems.push(`${id}: its contract ${port.contract} doesn't exist`);
    const suite = sourceOf(port.suite.module);
    if (!suite) problems.push(`${id}: its suite ${port.suite.module} doesn't exist`);
    else if (!exportsOf(suite).has(port.suite.runner)) problems.push(`${id}: ${port.suite.module} doesn't export ${port.suite.runner}`);
    if (port.implementations.length === 0) problems.push(`${id}: the suite ${port.suite.module} has no implementation bound`);
    // A fake of a browser API is only as good as its agreement with the browser
    if (port.browser && !port.implementations.some(implementation => implementation.host !== undefined)) {
      problems.push(`${id}: ${port.contract} is a browser API, so its suite needs a run in the browser too`);
    }

    for (const implementation of port.implementations) {
      const { run } = implementation;
      const target = implementation.module ?? implementation.via;
      const label = implementation.module ?? implementation.host;
      if (implementation.module !== undefined) {
        if (bound.has(implementation.module)) problems.push(`${implementation.module} is bound twice, to ${bound.get(implementation.module)} and ${id}`);
        bound.set(implementation.module, id);
        if (!files.has(implementation.module)) problems.push(`${id}: ${implementation.module} doesn't exist`);
        if (!npmTest(run)) problems.push(`${id}: ${run}, the run for ${label}, isn't a file npm test runs`);
      } else {
        if (!extensionRuns(run)) problems.push(`${id}: ${run}, the run on ${label}, isn't a spec npm run test:extension runs`);
        if (!files.has(target)) problems.push(`${id}: ${target}, the harness for ${label}, doesn't exist`);
      }
      const source = sourceOf(run);
      if (!source) {
        problems.push(`${id}: ${run}, the run for ${label}, doesn't exist`);
        continue;
      }
      if (!reach(run).has(port.suite.module)) problems.push(`${id}: ${run} doesn't load the suite ${port.suite.module}`);
      // The run loads the implementation itself, not only through the suite
      if (!reach(run, port.suite.module).has(target)) {
        problems.push(`${id}: ${run} doesn't load ${target} other than through the suite, so it can't run the suite against it`);
      }
      const runnerCalls = callsOf(source, new Set([port.suite.runner]));
      const live = runnerCalls.filter(runsOnLoad);
      if (runnerCalls.length === 0) {
        problems.push(`${id}: ${run} never calls ${port.suite.runner}`);
      } else if (live.length === 0) {
        problems.push(`${id}: ${run} calls ${port.suite.runner} only where it never runs: under a condition, a function nothing calls, or a skipped describe`);
      } else {
        // An argument of the call is made from what the run loaded from the implementation
        /** @type {Set<string>} */
        const roots = new Set();
        for (const { specifier, names } of loadsOf(source)) {
          const loaded = resolve(files, run, specifier);
          if (loaded && loaded !== port.suite.module && reach(loaded, port.suite.module).has(target)) for (const name of names) roots.add(name);
        }
        const made = madeFrom(source, roots);
        const fed = live.some(call => call.arguments.some(argument => [...readsOf(argument)].some(name => made.has(name))));
        if (!fed) problems.push(`${id}: ${run} calls ${port.suite.runner} with nothing made from ${target}`);
      }
    }
  }

  // Every suite module is a port's suite
  const suites = new Set(Object.values(PORTS).map(port => port.suite.module));
  for (const file of files) {
    if (!file.startsWith('test/') || !isShared(file) || suites.has(file)) continue;
    const source = sourceOf(file);
    const runners = source ? [...exportsOf(source).keys()].filter(name => SUITE_EXPORT.test(name)) : [];
    if (runners.length > 0) {
      problems.push(`${file} exports the suite ${runners.join(', ')}, which no port in conformance-inventory.mjs binds to an implementation`);
    }
  }

  // Every contract in js/kernel/core/ports/ is a port's or listed without a suite
  const contracts = new Set(Object.values(PORTS).map(port => port.contract));
  for (const file of files) {
    if (file.startsWith('js/kernel/core/ports/') && !contracts.has(file) && !Object.hasOwn(WITHOUT_SUITE, file)) {
      problems.push(`${file} is a contract that's neither a port in PORTS nor listed in WITHOUT_SUITE`);
    }
  }
  for (const file of Object.keys(WITHOUT_SUITE)) if (!files.has(file)) problems.push(`the contract ${file} in WITHOUT_SUITE doesn't exist`);

  /** @param {string} file @param {string} port */
  const composes = (file, port) => COMPOSERS[file]?.port === port;
  /** @param {string} file - an implementation of a contract without a suite, which its listed test loads (below) */
  const withoutSuite = file => Object.values(WITHOUT_SUITE).some(({ implementations }) => Object.hasOwn(implementations, file));
  /** @param {string} file */
  const classified = file =>
    bound.has(file) || Object.hasOwn(HELPERS, file) || Object.hasOwn(UNSHARED, file) || Object.hasOwn(COMPOSERS, file) || withoutSuite(file);

  // Every module under js/kernel/ outside the listed areas is classified
  for (const file of files) {
    if (!file.startsWith('js/kernel/') || !MODULE.test(file)) continue;
    if (Object.keys(NOT_IMPLEMENTATIONS).some(area => file.startsWith(area))) continue;
    if (!classified(file)) {
      problems.push(`${file} is an implementation module with no conformance run: bind it to its port's suite in conformance-inventory.mjs, or list it as a helper, a composer, or unshared`);
    }
  }
  for (const file of new Set([...bound.keys(), ...Object.keys(HELPERS), ...Object.keys(UNSHARED), ...Object.keys(COMPOSERS)])) {
    const kinds = [bound.has(file) && 'an implementation', Object.hasOwn(HELPERS, file) && 'a helper', Object.hasOwn(UNSHARED, file) && 'unshared', Object.hasOwn(COMPOSERS, file) && 'a composer'].filter(Boolean);
    if (kinds.length > 1) problems.push(`${file} is listed as ${kinds.join(' and ')}; it's one`);
  }

  // What has a port's type or shape is that port's: bound, composing it, or exempt
  /** @type {Found[]} */
  const found = [];
  /** @type {Map<string, readonly string[]>} */
  const wanted = new Map();
  /** @type {Map<string, string>} */
  const portOfType = new Map();
  for (const [id, port] of Object.entries(PORTS)) {
    if (port.types.length > 0) wanted.set(port.contract, port.types);
    for (const type of port.types) portOfType.set(`${port.contract}#${type}`, id);
  }
  for (const [contract, { types }] of Object.entries(WITHOUT_SUITE)) if (types.length > 0) wanted.set(contract, types);
  for (const [file, name, type, contract] of typedImplementations(tree, wanted)) {
    const source = /** @type {ts.SourceFile} */ (sourceOf(file));
    const node = exportsOf(source).get(name) ?? source;
    const port = portOfType.get(`${contract}#${type}`);
    if (port) {
      found.push({ file, port, why: `exports ${name}, which is a ${type}`, node, source });
    } else if (!Object.hasOwn(WITHOUT_SUITE[contract]?.implementations ?? {}, file)) {
      problems.push(`${file} exports ${name}, which is a ${type}, and ${contract} has no shared suite: write one and move it to PORTS`);
    }
  }
  for (const file of files) {
    const searched = file.startsWith('js/') || ((file.startsWith('test/') || file.startsWith('e2e/')) && isShared(file));
    if (!searched || !MODULE.test(file)) continue;
    const source = sourceOf(file);
    if (!source) continue;
    if (file.startsWith('js/kernel/')) for (const node of connectables(source)) found.push({ file, port: 'messaging-transport', why: 'has an object with a connect method', node, source });
    for (const [name, node] of exportsOf(source)) {
      if (file.startsWith('js/') && TRANSPORT_EXPORT.test(name)) found.push({ file, port: 'messaging-transport', why: `exports ${name}`, node, source });
    }
    for (const node of familyCalls(files, file, source)) found.push({ file, port: 'registry-family', why: 'calls defineFamily', node, source });
    for (const node of storageAreas(source)) found.push({ file, port: 'chrome-storage-local', why: 'makes a chrome.storage area', node, source });
  }
  /** @type {Set<string>} */
  const reported = new Set();
  /** @type {Set<string>} */
  const exemptionsUsed = new Set();
  for (const { file, port, why, node, source } of found) {
    if (bound.get(file) === port || composes(file, port)) continue;
    const exemption = EXEMPT[file];
    if (exemption?.port === port && statementOf(node).getText(source).includes(exemption.within)) {
      exemptionsUsed.add(file);
      continue;
    }
    const line = `${file} ${why}, so it's a ${port} implementation, with no conformance run: bind it in conformance-inventory.mjs`;
    if (!reported.has(line)) problems.push(line);
    reported.add(line);
  }

  for (const [file, of] of Object.entries(HELPERS)) {
    if (!files.has(file)) {
      problems.push(`the helper ${file} doesn't exist`);
      continue;
    }
    if (of.length === 0) problems.push(`the helper ${file} names no implementation`);
    for (const owner of of) {
      if (!bound.has(owner)) problems.push(`the helper ${file} names ${owner}, which isn't a bound implementation`);
      else if (!reach(owner).has(file)) problems.push(`the helper ${file} names ${owner}, which doesn't load it`);
    }
  }
  for (const [file, { port, of }] of Object.entries(COMPOSERS)) {
    if (!files.has(file)) {
      problems.push(`the composer ${file} doesn't exist`);
      continue;
    }
    for (const implementation of of) {
      if (bound.get(implementation) !== port) problems.push(`the composer ${file} names ${implementation}, which isn't bound to ${port}`);
      else if (!reach(file).has(implementation)) problems.push(`the composer ${file} names ${implementation}, which it doesn't load`);
    }
  }
  for (const [file, { tests }] of Object.entries(UNSHARED)) {
    if (!files.has(file)) problems.push(`the unshared module ${file} doesn't exist`);
    else if (!npmTest(tests)) problems.push(`the unshared module ${file}: ${tests} isn't a file npm test runs`);
    else if (!reach(tests).has(file)) problems.push(`the unshared module ${file}: ${tests} doesn't load it`);
  }
  for (const [contract, { implementations }] of Object.entries(WITHOUT_SUITE)) {
    for (const [file, tests] of Object.entries(implementations)) {
      if (!npmTest(tests) || !reach(tests).has(file)) problems.push(`${file}, which implements ${contract}, isn't loaded by ${tests} in npm test`);
    }
  }
  for (const [file, { port, within, owner, reason }] of Object.entries(EXEMPT)) {
    if (!owner || !reason || !within) problems.push(`the exemption for ${file} needs what it's within, an owner, and a reason`);
    if (!exemptionsUsed.has(file)) problems.push(`${file} no longer has the ${port} implementation its exemption covers: delete the exemption`);
  }

  return problems;
}
