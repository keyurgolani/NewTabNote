// The static import graph of a module, as the contract tests read it: every relative module
// it reaches through `import ... from`, `export ... from`, and side-effect imports, in either
// quote style. TypeScript's parser reads each one, so a specifier in a comment or a string
// counts for nothing, and each import() call is found the same way. reachGraph also follows
// each import() whose specifier is a literal, as the chunk a page loads (#17 PR 4a, R88), and
// names each module worker a module starts with `new Worker(new URL(literal, import.meta.url))`,
// the one form the bundler builds as an entry of its own, without following it: a worker runs
// in a realm of its own, so a caller reads it as a root of its own (#35 slice 4a, #204).

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Whether `node` is `import.meta.url`
 * @param {ts.Node | undefined} node
 * @returns {boolean}
 */
const isImportMetaUrl = node =>
  !!node &&
  ts.isPropertyAccessExpression(node) &&
  node.name.text === 'url' &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

/**
 * Whether `node` is `new <name>(...)`
 * @param {ts.Node | undefined} node
 * @param {string} name
 * @returns {node is ts.NewExpression}
 */
const isNew = (node, name) =>
  !!node && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

/**
 * The specifier of the module worker `node` starts, when it's
 * `new Worker(new URL(literal, import.meta.url), ...)`, and null otherwise
 * @param {ts.Node} node
 * @returns {string | null}
 */
const workerOf = node => {
  if (!isNew(node, 'Worker')) return null;
  const [url] = node.arguments ?? [];
  if (!isNew(url, 'URL')) return null;
  const [specifier, base] = url.arguments ?? [];
  const literal = !!specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier));
  return literal && isImportMetaUrl(base) ? specifier.text : null;
};

/**
 * What a module's text loads: the specifiers of its static imports and re-exports, each
 * import() call, by line:col, with its specifier when that's a literal (null when computed), and
 * the specifier of each module worker it starts (workerOf)
 * @param {string} text
 * @returns {{imports: string[], dynamicImports: string[], dynamicLoads: Array<{at: string, specifier: string | null}>, workers: string[]}}
 */
export function loadsOf(text) {
  const source = ts.createSourceFile('module.mjs', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  /** @type {string[]} */
  const imports = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
  }
  /** @type {string[]} */
  const dynamicImports = [];
  /** @type {Array<{at: string, specifier: string | null}>} */
  const dynamicLoads = [];
  /** @type {string[]} */
  const workers = [];
  /** @param {ts.Node} node */
  const walk = node => {
    const worker = workerOf(node);
    if (worker !== null) workers.push(worker);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const at = `${line + 1}:${character + 1}`;
      const [argument] = node.arguments;
      const literal =
        argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument));
      dynamicImports.push(at);
      dynamicLoads.push({ at, specifier: literal ? argument.text : null });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { imports, dynamicImports, dynamicLoads, workers };
}

/**
 * The relative modules `file` imports statically, as paths
 * @param {string} file
 * @returns {string[]}
 */
export function staticImports(file) {
  return loadsOf(fs.readFileSync(file, 'utf8'))
    .imports.filter(specifier => specifier.startsWith('.'))
    .map(specifier => path.resolve(path.dirname(file), specifier));
}

/**
 * Every import() call in `files`, as `file:line:col`
 * @param {Iterable<string>} files
 * @returns {string[]}
 */
export function dynamicImportsIn(files) {
  return [...files].flatMap(file => loadsOf(fs.readFileSync(file, 'utf8')).dynamicImports.map(at => `${file}:${at}`));
}

/**
 * Every module `file` reaches through static imports, `file` included
 * @param {string} file
 * @returns {Set<string>}
 */
export function importGraph(file) {
  const seen = new Set([file]);
  const pending = [file];
  while (pending.length > 0) {
    for (const next of staticImports(/** @type {string} */ (pending.pop()))) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return seen;
}

/**
 * Every module `files` reach through static imports and each import() of a literal specifier,
 * as the chunks a page loads, `files` included; each import() whose specifier is computed,
 * which no reading can follow, as `file:line:col`; and each module worker those modules start,
 * as a path, which it doesn't follow (loadsOf). `readFile` reads a module's text, from disk
 * unless given, so a test can plant an import.
 * @param {Iterable<string>} files
 * @param {{readFile?: (file: string) => string}} [options]
 * @returns {{modules: Set<string>, computed: string[], workers: string[]}}
 */
export function reachGraph(files, { readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  const modules = new Set(files);
  const pending = [...modules];
  /** @type {string[]} */
  const computed = [];
  /** @type {Set<string>} */
  const workers = new Set();
  while (pending.length > 0) {
    const file = /** @type {string} */ (pending.pop());
    const { imports, dynamicLoads, workers: started } = loadsOf(readFile(file));
    for (const { at, specifier } of dynamicLoads) if (specifier === null) computed.push(`${file}:${at}`);
    for (const specifier of started) workers.add(path.resolve(path.dirname(file), specifier));
    const specifiers = [
      ...imports,
      ...dynamicLoads.flatMap(({ specifier }) => (specifier === null ? [] : [specifier])),
    ];
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const reached = path.resolve(path.dirname(file), specifier);
      if (!modules.has(reached)) {
        modules.add(reached);
        pending.push(reached);
      }
    }
  }
  return { modules, computed: computed.sort(), workers: [...workers].sort() };
}
