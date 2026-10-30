// The check behind conformance-inventory.mjs (#28 slice 2): what counts as an implementation,
// a suite, and a run, read from the source with TypeScript's parser, so a name in a comment or
// a string counts for nothing.
//
// An implementation is found three ways, none of which asks its author to mark it:
//
// - by where it lives: every module under js/kernel/adapters/ and js/kernel/core/memory/,
//   where #12's layout puts each port's implementations (#17's durable repositories, ledger,
//   log, and journal land there), is an implementation, a helper, or an unshared module;
// - by what it exports or calls, wherever it lives in js/ or among the shared test doubles
//   (test/, outside *.test.* files): a `create...Transport` export is a messaging transport,
//   a `defineFamily` call a registry family (#15's go under js/registries/), and an object
//   with a `local` area and an `onChanged` event, or a `local` area with get and set, a
//   chrome.storage implementation;
// - a suite is a test/ module, outside *.test.* files, that exports `describe...` or
//   `run...Suite`.
//
// A run is a file that `npm test` (or, for a browser host, `npm run test:extension`) runs, whose
// static imports and requires reach both the suite and the implementation, and that calls the
// suite's runner.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import * as inventory from './conformance-inventory.mjs';

/** @typedef {typeof inventory} Inventory */
/** @typedef {{list: () => string[], read: (file: string) => string | undefined}} Tree */

export const ROOT = path.join(import.meta.dirname, '..', '..');

/** Where every module is an implementation, a helper, or unshared */
export const IMPLEMENTATION_DIRS = Object.freeze(['js/kernel/adapters/', 'js/kernel/core/memory/']);

const SCANNED = ['js', 'test', 'e2e'];
const SKIPPED = new Set(['node_modules', 'lib']);
const MODULE = /\.(m?js|cjs)$/;
const TEST_FILE = /\.test\.(m?js|cjs)$/;
const SUITE_EXPORT = /^(describe[A-Z]\w*|run\w*Suite)$/;
const TRANSPORT_EXPORT = /^create\w*Transport$/;

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
        // js/lib holds vendored bundles
        if (!SKIPPED.has(entry.name) || (entry.name === 'lib' && !dir.startsWith('js'))) walk(file);
      } else if (MODULE.test(entry.name)) {
        files.push(file);
      }
    }
  };
  for (const dir of SCANNED) if (fs.existsSync(path.join(root, dir))) walk(dir);
  files.push('package.json');
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

/**
 * Every node of `source`, depth first
 * @param {ts.SourceFile} source
 * @returns {ts.Node[]}
 */
function nodesOf(source) {
  /** @type {ts.Node[]} */
  const nodes = [];
  /** @param {ts.Node} node */
  const visit = node => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

/**
 * The relative specifiers a module loads: static imports and re-exports, require() calls, and
 * import() calls, each with a string literal
 * @param {ts.SourceFile} source
 * @returns {string[]}
 */
function specifiersOf(source) {
  /** @type {string[]} */
  const specifiers = [];
  for (const node of nodesOf(source)) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
      if (loads) specifiers.push(node.arguments[0].text);
    }
  }
  return specifiers.filter(specifier => specifier.startsWith('.'));
}

/**
 * The module `specifier` names from `from`, as a listed path, or undefined
 * @param {Set<string>} files
 * @param {string} from
 * @param {string} specifier
 */
function resolve(files, from, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`].find(candidate => files.has(candidate));
}

/**
 * Every module `file` reaches through what it loads, `file` included
 * @param {Tree} tree
 * @param {string} file
 * @returns {Set<string>}
 */
function reach(tree, file) {
  const files = new Set(tree.list());
  const seen = new Set([file]);
  const pending = [file];
  while (pending.length > 0) {
    const next = /** @type {string} */ (pending.pop());
    const text = tree.read(next);
    if (text === undefined) continue;
    for (const specifier of specifiersOf(parse(text))) {
      const target = resolve(files, next, specifier);
      if (target && !seen.has(target)) {
        seen.add(target);
        pending.push(target);
      }
    }
  }
  return seen;
}

/**
 * The names a module exports, as an ES module or through module.exports
 * @param {ts.SourceFile} source
 * @returns {Set<string>}
 */
function exportsOf(source) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {ts.Node} node */
  const exported = node => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && exported(statement)) names.add(statement.name.text);
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
  }
  for (const node of nodesOf(source)) {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const target = node.left.getText(source);
    if (target === 'module.exports' && ts.isObjectLiteralExpression(node.right)) {
      for (const property of node.right.properties) {
        if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) names.add(property.name.text);
      }
    } else if (/^(module\.)?exports\.\w+$/.test(target)) {
      names.add(target.slice(target.lastIndexOf('.') + 1));
    }
  }
  return names;
}

/**
 * Whether `source` calls `name`, as a function or a method
 * @param {ts.SourceFile} source
 * @param {string} name
 */
function calls(source, name) {
  return nodesOf(source).some(node => {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    return (ts.isIdentifier(callee) && callee.text === name) || (ts.isPropertyAccessExpression(callee) && callee.name.text === name);
  });
}

/**
 * The names an object literal's own properties have
 * @param {ts.ObjectLiteralExpression} literal
 */
function propertyNames(literal) {
  return new Set(literal.properties.flatMap(property => (property.name && ts.isIdentifier(property.name) ? [property.name.text] : [])));
}

/**
 * Whether `source` makes a chrome.storage area: an object with `local` and `onChanged`, or whose
 * `local` is an object with get and set
 * @param {ts.SourceFile} source
 */
function makesStorageArea(source) {
  return nodesOf(source).some(node => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    const names = propertyNames(node);
    if (!names.has('local')) return false;
    if (names.has('onChanged')) return true;
    return node.properties.some(property => {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'local') return false;
      if (!ts.isObjectLiteralExpression(property.initializer)) return false;
      const area = propertyNames(property.initializer);
      return area.has('get') && area.has('set');
    });
  });
}

/** What makes a module an implementation of a port, wherever it lives */
const SHAPES = Object.freeze([
  {
    port: 'messaging-transport',
    what: 'exports a create...Transport',
    /** @param {ts.SourceFile} source */
    has: source => [...exportsOf(source)].some(name => TRANSPORT_EXPORT.test(name)),
  },
  { port: 'registry-family', what: 'calls defineFamily', /** @param {ts.SourceFile} source */ has: source => calls(source, 'defineFamily') },
  { port: 'chrome-storage-local', what: 'makes a chrome.storage area', has: makesStorageArea },
]);

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

/**
 * Whether `file` is a shared module, one that isn't itself a test file
 * @param {string} file
 */
const isShared = file => !TEST_FILE.test(file) && !file.endsWith('.spec.js');

/**
 * What's wrong with the repository's conformance coverage, one line each, or nothing
 * @param {Tree} tree
 * @param {Inventory} [given]
 * @returns {string[]}
 */
export function coverageProblems(tree, given = inventory) {
  const { PORTS, HELPERS, UNSHARED, EXEMPT } = given;
  /** @type {string[]} */
  const problems = [];
  const files = new Set(tree.list());
  /** @param {string} file */
  const sourceOf = file => {
    const text = tree.read(file);
    return text === undefined ? undefined : parse(text);
  };
  const pkg = JSON.parse(tree.read('package.json') ?? '{}');
  const npmTest = scriptRuns(pkg.scripts?.test ?? '');
  /** @param {string} file */
  const extensionRuns = file => Boolean(pkg.scripts?.['test:extension']) && file.startsWith('e2e/') && file.endsWith('.spec.js');

  /** @type {Map<string, string>} each implementation module, by the port it's bound to */
  const bound = new Map();
  for (const [id, port] of Object.entries(PORTS)) {
    if (port.contract.endsWith('.js') && !files.has(port.contract)) problems.push(`${id}: its contract ${port.contract} doesn't exist`);
    const suite = sourceOf(port.suite.module);
    if (!suite) problems.push(`${id}: its suite ${port.suite.module} doesn't exist`);
    else if (!exportsOf(suite).has(port.suite.runner)) problems.push(`${id}: ${port.suite.module} doesn't export ${port.suite.runner}`);
    if (port.implementations.length === 0) problems.push(`${id}: the suite ${port.suite.module} has no implementation bound`);
    // A fake of a browser API is only as good as its agreement with the browser
    if (!port.contract.endsWith('.js') && !port.implementations.some(implementation => implementation.host !== undefined)) {
      problems.push(`${id}: ${port.contract} is a browser API, so its suite needs a run in the browser too`);
    }

    for (const implementation of port.implementations) {
      const { run } = implementation;
      const label = implementation.module ?? implementation.host;
      if (implementation.module !== undefined) {
        if (bound.has(implementation.module)) problems.push(`${implementation.module} is bound twice, to ${bound.get(implementation.module)} and ${id}`);
        bound.set(implementation.module, id);
        if (!files.has(implementation.module)) problems.push(`${id}: ${implementation.module} doesn't exist`);
        if (!npmTest(run)) problems.push(`${id}: ${run}, the run for ${label}, isn't a file npm test runs`);
      } else if (!extensionRuns(run)) {
        problems.push(`${id}: ${run}, the run on ${label}, isn't a spec npm run test:extension runs`);
      }
      const source = sourceOf(run);
      if (!source) {
        problems.push(`${id}: ${run}, the run for ${label}, doesn't exist`);
        continue;
      }
      const reached = reach(tree, run);
      if (!reached.has(port.suite.module)) problems.push(`${id}: ${run} doesn't load the suite ${port.suite.module}`);
      if (implementation.module !== undefined && !reached.has(implementation.module)) {
        problems.push(`${id}: ${run} doesn't load ${implementation.module}, so it can't run the suite against it`);
      }
      if (!calls(source, port.suite.runner)) problems.push(`${id}: ${run} never calls ${port.suite.runner}`);
    }
  }

  // Every suite module is a port's suite
  const suites = new Set(Object.values(PORTS).map(port => port.suite.module));
  for (const file of files) {
    if (!file.startsWith('test/') || !isShared(file)) continue;
    const source = sourceOf(file);
    const runners = source ? [...exportsOf(source)].filter(name => SUITE_EXPORT.test(name)) : [];
    if (runners.length > 0 && !suites.has(file)) {
      problems.push(`${file} exports the suite ${runners.join(', ')}, which no port in conformance-inventory.mjs binds to an implementation`);
    }
  }

  // Every module in the implementation directories is classified
  for (const file of files) {
    if (!IMPLEMENTATION_DIRS.some(dir => file.startsWith(dir))) continue;
    const kinds = [bound.has(file) && 'an implementation', Object.hasOwn(HELPERS, file) && 'a helper', Object.hasOwn(UNSHARED, file) && 'unshared'].filter(Boolean);
    if (kinds.length === 0) {
      problems.push(`${file} is an implementation module with no conformance run: bind it to its port's suite in conformance-inventory.mjs, or list it as a helper or unshared`);
    } else if (kinds.length > 1) {
      problems.push(`${file} is listed as ${kinds.join(' and ')}; it's one`);
    }
  }

  // Every module with a port's shape is bound to that port, or exempt from it
  for (const file of files) {
    if (!(file.startsWith('js/') || (file.startsWith('test/') && isShared(file)))) continue;
    const source = sourceOf(file);
    if (!source) continue;
    for (const shape of SHAPES) {
      if (!shape.has(source)) continue;
      if (bound.get(file) === shape.port) continue;
      if (EXEMPT[file]?.port === shape.port && (PORTS[shape.port]?.exempt ?? []).includes(file)) continue;
      problems.push(`${file} ${shape.what}, so it's a ${shape.port} implementation, with no conformance run: bind it in conformance-inventory.mjs`);
    }
  }

  for (const [file, of] of Object.entries(HELPERS)) {
    if (!files.has(file)) {
      problems.push(`the helper ${file} doesn't exist`);
      continue;
    }
    if (of.length === 0) problems.push(`the helper ${file} names no implementation`);
    for (const owner of of) {
      if (!bound.has(owner)) problems.push(`the helper ${file} names ${owner}, which isn't a bound implementation`);
      else if (!reach(tree, owner).has(file)) problems.push(`the helper ${file} names ${owner}, which doesn't load it`);
    }
  }

  for (const [file, { tests }] of Object.entries(UNSHARED)) {
    if (!files.has(file)) problems.push(`the unshared module ${file} doesn't exist`);
    else if (!npmTest(tests)) problems.push(`the unshared module ${file}: ${tests} isn't a file npm test runs`);
    else if (!reach(tree, tests).has(file)) problems.push(`the unshared module ${file}: ${tests} doesn't load it`);
  }

  for (const [file, { port, owner, reason }] of Object.entries(EXEMPT)) {
    const shape = SHAPES.find(candidate => candidate.port === port);
    const source = sourceOf(file);
    if (!owner || !reason) problems.push(`the exemption for ${file} needs an owner and a reason`);
    if (!(PORTS[port]?.exempt ?? []).includes(file)) problems.push(`the exemption for ${file} isn't in ${port}'s exempt list`);
    if (!source || !shape || !shape.has(source)) problems.push(`${file} is no longer a ${port} implementation: delete its exemption`);
  }
  for (const [id, port] of Object.entries(PORTS)) {
    for (const file of port.exempt ?? []) {
      if (EXEMPT[file]?.port !== id) problems.push(`${id} exempts ${file}, which has no entry in EXEMPT`);
    }
  }

  return problems;
}
