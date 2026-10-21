// The static import graph of a module, as the contract tests read it: every relative module
// it reaches through `import ... from`, `export ... from`, and side-effect imports.

import fs from 'node:fs';
import path from 'node:path';

/**
 * The relative modules `file` imports statically, as paths
 * @param {string} file
 * @returns {string[]}
 */
export function staticImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const specifiers = [...text.matchAll(/^(?:import|export)\s[^;]*?from\s+'([^']+)'|^import\s+'([^']+)'/gm)].map(
    match => match[1] ?? match[2],
  );
  return specifiers.map(specifier => path.resolve(path.dirname(file), specifier));
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
