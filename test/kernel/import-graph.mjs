// The static import graph of a module, as the contract tests read it: every relative module
// it reaches through `import ... from`, `export ... from`, and side-effect imports, in either
// quote style. TypeScript's parser reads each one, so a specifier in a comment or a string
// counts for nothing, and each import() call is found the same way. reachGraph also follows
// each import() whose specifier is a literal, as the chunk a page loads (#17 PR 4a, R88).

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * What a module's text loads: the specifiers of its static imports and re-exports, and each
 * import() call, by line:col, with its specifier when that's a literal (null when computed)
 * @param {string} text
 * @returns {{imports: string[], dynamicImports: string[], dynamicLoads: Array<{at: string, specifier: string | null}>}}
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
  /** @param {ts.Node} node */
  const walk = node => {
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
  return { imports, dynamicImports, dynamicLoads };
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
 * as the chunks a page loads, `files` included; and each import() whose specifier is computed,
 * which no reading can follow, as `file:line:col`. `readFile` reads a module's text, from disk
 * unless given, so a test can plant an import.
 * @param {Iterable<string>} files
 * @param {{readFile?: (file: string) => string}} [options]
 * @returns {{modules: Set<string>, computed: string[]}}
 */
export function reachGraph(files, { readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  const modules = new Set(files);
  const pending = [...modules];
  /** @type {string[]} */
  const computed = [];
  while (pending.length > 0) {
    const file = /** @type {string} */ (pending.pop());
    const { imports, dynamicLoads } = loadsOf(readFile(file));
    for (const { at, specifier } of dynamicLoads) if (specifier === null) computed.push(`${file}:${at}`);
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
  return { modules, computed: computed.sort() };
}
