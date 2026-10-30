// How the contract tests read a module's imports (import-graph.mjs): by its syntax, so every
// static import, re-export, and side-effect import counts in either quote style, an import()
// call is found wherever it is, and nothing in a comment or a string counts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadsOf } from './import-graph.mjs';

describe('import-graph.mjs', () => {
  it('reads static imports, re-exports, and side-effect imports in either quote style', () => {
    const text = [
      "import { a } from './a.js';",
      'import b from "./b.js";',
      "import './c.js';",
      'import "./d.js";',
      "export { e } from './e.js';",
      'export * from "./f.js";',
      'import {',
      '  g,',
      "} from './g.js';",
    ].join('\n');
    assert.deepEqual(loadsOf(text).imports, ['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js', './g.js']);
  });

  it('finds each import() call, and nothing in a comment or a string', () => {
    const text = [
      "// An MV3 worker can't import() a module, so import('./no.js') here is a comment",
      'const words = "import \'./no.js\'";',
      'export async function later() {',
      "  return import('./later.js');",
      '}',
      'const now = await import("./now.js");',
    ].join('\n');
    const { imports, dynamicImports } = loadsOf(text);
    assert.deepEqual(imports, []);
    assert.deepEqual(dynamicImports, ['4:10', '6:19']);
  });
});
