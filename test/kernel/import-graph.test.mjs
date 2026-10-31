// How the contract tests read a module's imports (import-graph.mjs): by its syntax, so every
// static import, re-export, and side-effect import counts in either quote style, an import()
// call is found wherever it is, and nothing in a comment or a string counts. reachGraph follows
// an import() of a literal, and names a computed one (#17 PR 4a).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { loadsOf, reachGraph } from './import-graph.mjs';

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
    const { imports, dynamicImports, dynamicLoads } = loadsOf(text);
    assert.deepEqual(imports, []);
    assert.deepEqual(dynamicImports, ['4:10', '6:19']);
    assert.deepEqual(dynamicLoads, [
      { at: '4:10', specifier: './later.js' },
      { at: '6:19', specifier: './now.js' },
    ]);
  });

  it('gives an import() of a template without a substitution its specifier, and a computed one none', () => {
    const text = ['import(`./plain.js`);', 'import(`./${name}.js`);', 'import(url);'].join('\n');
    assert.deepEqual(
      loadsOf(text).dynamicLoads.map(({ specifier }) => specifier),
      ['./plain.js', null, null],
    );
  });

  it('reachGraph follows static imports and each import() of a literal, and names each computed one', () => {
    const dir = path.resolve('/planted');
    /** @type {Record<string, string>} */
    const files = {
      [path.join(dir, 'entry.js')]: "import './a.js';\nexport const later = () => import('./chunk.js');",
      [path.join(dir, 'a.js')]: 'export const a = 1;',
      [path.join(dir, 'chunk.js')]: "import './b.js';\nexport const load = url => import(url);",
      [path.join(dir, 'b.js')]: 'export const b = 2;',
    };
    const { modules, computed } = reachGraph([path.join(dir, 'entry.js')], { readFile: file => files[file] });
    assert.deepEqual([...modules].map(file => path.basename(file)).sort(), ['a.js', 'b.js', 'chunk.js', 'entry.js']);
    assert.deepEqual(computed, [`${path.join(dir, 'chunk.js')}:2:28`]);
  });
});
