// The static import graph of a module, as the contract tests read it: every relative module
// it reaches through `import ... from`, `export ... from`, and side-effect imports, in either
// quote style. TypeScript's parser reads each one, so a specifier in a comment or a string
// counts for nothing, and each import() call is found the same way.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * What a module's text loads: the specifiers of its static imports and re-exports, and each
 * import() call, by line:col
 * @param {string} text
 * @returns {{imports: string[], dynamicImports: string[]}}
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
  /** @param {ts.Node} node */
  const walk = node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      dynamicImports.push(`${line + 1}:${character + 1}`);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { imports, dynamicImports };
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
