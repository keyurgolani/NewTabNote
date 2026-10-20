'use strict';

// scripts/check-boundaries.js: the ledger rules with canned hits, then the real
// eslint.config.mjs on the repository and on a copy of js/ with forbidden code added.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const boundaries = require('../scripts/check-boundaries.js');
const { excerpt, MARKERS } = require('../scripts/ci/failure-excerpt.js');

const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-boundaries-'));
  temps.push(dir);
  return dir;
}

function hitMap(hits) {
  return new Map(hits.map(({ file, rule, count }) => [`${file}\0${rule}`, {
    file, rule, count, at: Array.from({ length: count }, (_, i) => `${i + 1}:1`),
  }]));
}

function row(file, rule, count, owner = 12, extra = {}) {
  return { file, rule, count, owner, removeWhen: 'the hits are gone', verify: 'npm run check:boundaries', ...extra };
}

function writeLedger(root, rows) {
  const file = path.join(root, boundaries.LEDGER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ about: 'test', rows }, null, 2)}\n`);
}

function readRows(root) {
  return JSON.parse(fs.readFileSync(path.join(root, boundaries.LEDGER), 'utf8')).rows;
}

/**
 * Run the check on `root` with canned hits; `base` maps a ref to the rows of its ledger,
 * or null for a ref without one
 */
async function run(root, argv, { hits = [], errors = [], base = {} } = {}) {
  const lines = [];
  const code = await boundaries.main(argv, {
    root,
    lint: async () => ({ hits: hitMap(hits), errors, files: 3 }),
    readBase: ref => {
      if (!Object.hasOwn(base, ref)) throw new Error(`git can't resolve ${ref} to a commit`);
      return base[ref] === null ? { missing: true } : { text: JSON.stringify({ about: 'base', rows: base[ref] }) };
    },
    log: line => lines.push(line),
    error: line => lines.push(line),
  });
  return { code, output: lines.join('\n') };
}

function assertFails(result, ...expected) {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /^check:boundaries failed: /);
  for (const text of expected) assert.ok(result.output.includes(text), `"${text}" missing from:\n${result.output}`);
}

describe('scripts/check-boundaries.js with canned hits', () => {
  it('seeds a missing ledger from the hits, sorted by file then rule, with each owner from the seed table', async () => {
    const root = tempRoot();
    assertFails(await run(root, []), 'is missing. Seed it once with `npm run check:boundaries -- --write-baseline`');

    const hits = [
      { file: 'js/b.js', rule: 'Storage', count: 2 },
      { file: 'js/a.js', rule: 'scheduler-timer', count: 1 },
      { file: 'js/a.js', rule: 'LLM', count: 3 },
      { file: 'js/services/sync-service.js', rule: 'fetch', count: 4 },
      { file: 'js/a.js', rule: 'this.storage', count: 1 },
    ];
    const seeded = await run(root, ['--write-baseline'], { hits });
    assert.equal(seeded.code, 0, seeded.output);
    assert.match(seeded.output, /seeded docs\/architecture\/kernel-ledger\.json with 5 rows for 11 hits/);
    assert.deepEqual(readRows(root).map(({ file, rule, count, owner, verify }) => [file, rule, count, owner, verify]), [
      ['js/a.js', 'LLM', 3, 11, 'npm run check:boundaries'],
      ['js/a.js', 'scheduler-timer', 1, 35, 'npm run check:boundaries'],
      ['js/a.js', 'this.storage', 1, 12, 'npm run check:boundaries'],
      ['js/b.js', 'Storage', 2, 12, 'npm run check:boundaries'],
      ['js/services/sync-service.js', 'fetch', 4, 19, 'npm run check:boundaries'],
    ]);
    assert.equal(readRows(root)[1].removeWhen, '#8 deletes them');
    assert.deepEqual(Object.keys(readRows(root)[0]), ['file', 'rule', 'count', 'owner', 'removeWhen', 'verify']);

    const checked = await run(root, [], { hits });
    assert.equal(checked.code, 0, checked.output);
    assert.match(checked.output, /^check:boundaries: OK, 11 hits in 3 files match 5 rows of docs\/architecture\/kernel-ledger\.json$/);
  });

  it('fails on a hit no row covers and on more hits than a row allows, with where they are', async () => {
    const root = tempRoot();
    writeLedger(root, [row('js/a.js', 'Storage', 2)]);
    const result = await run(root, [], { hits: [{ file: 'js/a.js', rule: 'Storage', count: 3 }, { file: 'js/b.js', rule: 'window.app', count: 1 }] });
    assertFails(result,
      'js/a.js: 3 Storage hits, 2 allowed by the ledger',
      'at 1:1, 2:1, 3:1',
      'js/b.js: 1 window.app hit no ledger row covers');
    const lines = excerpt(`${'npm output\n'.repeat(30)}${result.output}`, MARKERS.kernel).split('\n');
    assert.match(lines[0], /^check:boundaries failed: 2 problems against /);
  });

  it('fails on fewer hits than a row allows, until --write-baseline lowers it or deletes the row', async () => {
    const root = tempRoot();
    writeLedger(root, [row('js/a.js', 'Storage', 2), row('js/b.js', 'fetch', 1, 11)]);
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 1 }];
    assertFails(await run(root, [], { hits }),
      "js/a.js: 1 Storage hit, below the ledger's 2: lower its count to 1 in this PR",
      "js/b.js: 0 fetch hits, below the ledger's 1: delete the row in this PR");

    const recorded = await run(root, ['--write-baseline'], { hits });
    assert.equal(recorded.code, 0, recorded.output);
    assert.deepEqual(readRows(root), [row('js/a.js', 'Storage', 1)]);
    assert.equal((await run(root, [], { hits })).code, 0);
  });

  it('--write-baseline never raises a count or adds a row once the ledger exists', async () => {
    const root = tempRoot();
    writeLedger(root, [row('js/a.js', 'Storage', 1)]);
    const before = fs.readFileSync(path.join(root, boundaries.LEDGER), 'utf8');
    const result = await run(root, ['--write-baseline'], { hits: [{ file: 'js/a.js', rule: 'Storage', count: 2 }, { file: 'js/c.js', rule: 'LLM', count: 1 }] });
    assertFails(result, 'was not written', 'js/a.js: 2 Storage hits, 1 allowed', 'js/c.js: 1 LLM hit no ledger row covers');
    assert.equal(fs.readFileSync(path.join(root, boundaries.LEDGER), 'utf8'), before);
  });

  it('fails on a row with a missing or unknown field, an unknown rule, a bad count or owner, or a repeat', async () => {
    const root = tempRoot();
    const { verify, ...noVerify } = row('js/a.js', 'Storage', 1);
    writeLedger(root, [
      noVerify,
      row('js/b.js', 'Storage', 1, 12, { note: 'extra' }),
      row('js/c.js', 'localStorage', 1),
      row('js/d.js', 'LLM', 0),
      row('js/e.js', 'LLM', 1, '#11'),
      row('js/f.js', 'fetch', 1, 11, { removeWhen: ' ' }),
      row('css/g.css', 'fetch', 1, 11),
      row('js/h.js', 'fetch', 1, 11),
      row('js/h.js', 'fetch', 2, 11),
    ]);
    assertFails(await run(root, []),
      'js/a.js Storage is missing verify',
      "js/b.js Storage has fields the ledger doesn't define: note",
      "js/c.js localStorage names a rule #12 doesn't define",
      'js/d.js LLM needs a count of 1 or more',
      'js/e.js LLM needs an owner issue number',
      'js/f.js fetch needs a removeWhen',
      'css/g.css fetch needs a file under js/',
      'js/h.js fetch appears twice');
  });

  it('never compares declared-gap rows with hits, but needs count 1 and a file that exists', async () => {
    const root = tempRoot();
    const adapter = 'js/kernel/adapters/legacy/notes.js';
    fs.mkdirSync(path.join(root, path.dirname(adapter)), { recursive: true });
    fs.writeFileSync(path.join(root, adapter), '');
    const gap = row(adapter, 'declared-gap', 1, 17, { verify: 'contract suite: legacy adapter, atomicMultiStore' });
    writeLedger(root, [gap, row('js/a.js', 'Storage', 1)]);
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 1 }];
    assert.equal((await run(root, [], { hits })).code, 0);
    assert.equal((await run(root, ['--write-baseline'], { hits })).code, 0);
    assert.deepEqual(readRows(root), [row('js/a.js', 'Storage', 1), gap]);

    writeLedger(root, [{ ...gap, count: 2 }, { ...gap, file: 'js/kernel/adapters/legacy/gone.js' }]);
    assertFails(await run(root, []),
      `${adapter} declared-gap is a declared-gap row, so its count is 1`,
      "names js/kernel/adapters/legacy/gone.js, which doesn't exist");
  });

  it('--base fails on a count that rose since the base and on a new row owned by #12', async () => {
    const root = tempRoot();
    const base = { 'origin/next': [row('js/a.js', 'Storage', 2), row('js/a.js', 'scheduler-timer', 1, 35)] };
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 3 }, { file: 'js/a.js', rule: 'scheduler-timer', count: 1 }, { file: 'js/b.js', rule: 'LLM', count: 1 }];

    writeLedger(root, [row('js/a.js', 'Storage', 3), row('js/a.js', 'scheduler-timer', 1, 35), row('js/b.js', 'LLM', 1, 12)]);
    assertFails(await run(root, ['--base', 'origin/next'], { hits, base }),
      'js/a.js Storage: count 2 at origin/next rose to 3; fix the new hits instead',
      'js/b.js LLM: a row added since origin/next names #12 as owner');
    // Without --base the ledger only has to match the hits
    assert.equal((await run(root, [], { hits })).code, 0);

    // A new row for another issue is fine, and so is a new owner on an existing row
    writeLedger(root, [row('js/a.js', 'Storage', 2), row('js/a.js', 'scheduler-timer', 1, 8), row('js/b.js', 'LLM', 1, 11)]);
    const allowed = await run(root, ['--base', 'origin/next'], { hits: [{ ...hits[0], count: 2 }, hits[1], hits[2]], base });
    assert.equal(allowed.code, 0, allowed.output);
    assert.match(allowed.output, /; no row rose or was added for #12 since origin\/next$/);
  });

  it('--base on a ref without a ledger takes every row as new, and fails on a ref git cannot resolve', async () => {
    const root = tempRoot();
    writeLedger(root, [row('js/a.js', 'Storage', 1)]);
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 1 }];
    const seeding = await run(root, ['--base', 'HEAD^1'], { hits, base: { 'HEAD^1': null } });
    assert.equal(seeding.code, 0, seeding.output);
    assert.match(seeding.output, /; HEAD\^1 has no ledger, so every row is new$/);
    assertFails(await run(root, ['--base', 'nowhere'], { hits }), "can't read the ledger at nowhere");
  });

  it("fails when ESLint reports something no ledger rule counts, such as a file it can't parse", async () => {
    const root = tempRoot();
    writeLedger(root, []);
    assertFails(await run(root, [], { errors: ["js/a.js:3:1 doesn't parse: Unexpected token"] }),
      "1 ESLint message that no ledger rule counts, so the hits can't be trusted",
      "js/a.js:3:1 doesn't parse: Unexpected token");
  });

  it('rejects unknown arguments, --base without a ref, and --base with --write-baseline', async () => {
    const root = tempRoot();
    assert.equal((await run(root, ['--fix'])).code, 2);
    assert.equal((await run(root, ['--base'])).code, 2);
    assert.equal((await run(root, ['--write-baseline', '--base', 'origin/next'])).code, 2);
  });
});

describe('eslint.config.mjs boundary rules', () => {
  it('every message names a ledger rule the check defines', async () => {
    const config = (await import(pathToFileURL(path.join(ROOT, 'eslint.config.mjs')).href)).default;
    const messages = [];
    for (const { rules = {} } of config) {
      for (const [name, [, ...options]] of Object.entries(rules)) {
        if (name === 'no-restricted-globals') {
          const globals = options[0] && options[0].globals ? options[0].globals : options;
          messages.push(...globals.map(entry => [name, entry.message]));
        } else if (name === 'no-restricted-syntax') {
          messages.push(...options.map(entry => [name, entry.message]));
        } else if (name === 'kernel/imports') {
          messages.push([name, `[${options[0].rule}] ${options[0].message}`]);
        } else {
          assert.equal(name, 'no-undef', `${name} has no ledger rule; give its messages one or drop it`);
        }
      }
    }
    assert.ok(messages.length >= 10, `found only ${messages.length} messages`);
    for (const [ruleId, message] of messages) {
      const rule = boundaries.ruleOf({ ruleId, message: `Unexpected use of 'x'. ${message}` });
      assert.ok(rule, `${ruleId} message names no ledger rule: ${message}`);
      assert.ok(message.startsWith(`[${rule}] `), `${ruleId} message should start with [${rule}]: ${message}`);
    }
    assert.equal(boundaries.ruleOf({ ruleId: 'no-undef', message: "'chrome' is not defined." }), 'core-global');
  });

  it("matches today's hits in js/ to docs/architecture/kernel-ledger.json", async () => {
    const lines = [];
    const code = await boundaries.main([], { log: line => lines.push(line), error: line => lines.push(line) });
    assert.equal(code, 0, lines.join('\n'));
  });

  it("counts each forbidden use in a copy of js/, and inline comments can't switch a rule off", async () => {
    const root = tempRoot();
    fs.cpSync(path.join(ROOT, 'js'), path.join(root, 'js'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'eslint.config.mjs'), path.join(root, 'eslint.config.mjs'));
    fs.cpSync(path.join(ROOT, 'docs', 'architecture'), path.join(root, 'docs', 'architecture'), { recursive: true });
    const append = (file, text) => fs.appendFileSync(path.join(root, file), `\n${text}\n`);
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };

    append('js/sidebar-utils.js', "export function probe() { return indexedDB.open('probe'); }");
    append('js/editor.js', "Storage.updateNote({ id: 'probe' });");
    append('js/search.js', [
      '/* eslint-disable */',
      '// eslint-disable-next-line no-restricted-globals',
      'const probeApp = window.app;',
      'const probeFetch = globalThis.fetch;',
      "const probeLocal = self['Storage'];",
      'export { probeApp, probeFetch, probeLocal };',
    ].join('\n'));
    append('js/shortcut-utils.js', "import './kernel/adapters/legacy/notes.js';");
    // Chrome resolves a leading / from the extension root, and a chrome-extension:// URL by
    // its path, so both reach the adapters too
    append('js/block-placeholders.js', "import '/js/kernel/adapters/legacy/notes.js';");
    append('js/command-palette-utils.js', "import 'chrome-extension://emildbpnneonfcanpfnafkphiflbddig/js/kernel/adapters/legacy/notes.js';");
    append('js/resizable-panel.js', 'export const later = () => import(`./kernel/adapters/legacy/notes.js`);');
    // An import() whose specifier isn't a fixed string can't be checked, so it counts
    append('js/virtual-scroller.js', 'export const named = name => import(`./kernel/${name}.js`);');
    write('js/kernel/core/probe.js', [
      "import '../../storage.js';",
      // Allowed: core itself and the vendored Valibot, however the specifier is written
      "import { sibling } from './domain/sibling.js';",
      "import * as v from '../../lib/valibot/index.mjs';",
      "import '/js/kernel/core/domain/sibling.js';",
      'export const lazy = () => import(`./domain/sibling.js`);',
      'export const id = chrome.runtime.id;',
      'export const kind = typeof window;',
      'export const ok = [sibling, v, new Map(), Promise.resolve()];',
    ].join('\n'));
    write('js/kernel/core/domain/sibling.js', 'export const sibling = 1;\n');
    // Allowed: the kernel outside core may use legacy objects and its own adapters, and
    // storage.js is the legacy store itself
    write('js/kernel/composition/probe.js', "import '../adapters/legacy/notes.js';\nexport const db = indexedDB;\n");
    write('js/kernel/adapters/legacy/notes.js', 'export const store = self.Storage;\n');
    append('js/storage.js', "indexedDB.open('probe');");

    const lines = [];
    const code = await boundaries.main([], { root, log: line => lines.push(line), error: line => lines.push(line) });
    const output = lines.join('\n');
    assert.equal(code, 1, output);
    for (const expected of [
      'js/sidebar-utils.js: 1 indexedDB hit no ledger row covers',
      'js/editor.js: 27 Storage hits, 26 allowed by the ledger',
      'js/search.js: 1 window.app hit no ledger row covers',
      'js/search.js: 1 fetch hit no ledger row covers',
      'js/search.js: 1 Storage hit no ledger row covers',
      'js/shortcut-utils.js: 1 adapter-import hit no ledger row covers',
      'js/block-placeholders.js: 1 adapter-import hit no ledger row covers',
      'js/command-palette-utils.js: 1 adapter-import hit no ledger row covers',
      'js/resizable-panel.js: 1 adapter-import hit no ledger row covers',
      'js/virtual-scroller.js: 1 adapter-import hit no ledger row covers',
      'js/kernel/core/probe.js: 1 core-import hit no ledger row covers',
      'js/kernel/core/probe.js: 2 core-global hits no ledger row covers',
    ]) {
      assert.ok(output.includes(expected), `"${expected}" missing from:\n${output}`);
    }
    assert.doesNotMatch(output, /js\/kernel\/(composition|adapters)\/|js\/storage\.js/);
    assert.equal(output.split('\n').filter(line => line.startsWith('  - ')).length, 12, output);
  });
});
