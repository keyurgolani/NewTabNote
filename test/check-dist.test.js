'use strict';

// scripts/check-dist.js on the repository's own files, which are laid out the way the build
// writes dist/, and on copies with one thing broken.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const checkDist = require('../scripts/check-dist.js');
const modulePreloads = require('../scripts/module-preloads.js');
const { readScriptGraph, preloadLinks } = require('../scripts/lib/script-graph.js');
const { excerpt, MARKERS } = require('../scripts/ci/failure-excerpt.js');

// What a build ships: the manifest, the pages, and js/ (scripts/build.js)
const PACKAGE_ENTRIES = ['manifest.json', 'newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html', 'js'];

const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-check-dist-'));
  temps.push(dir);
  return dir;
}

/**
 * A copy of the package files, edited by `edits`: file -> function from its text to the
 * text to write, or null to delete it. An edit that changes nothing throws.
 */
function packageCopy(edits = {}) {
  const dir = tempDir();
  PACKAGE_ENTRIES.forEach(entry => fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true }));
  for (const [file, edit] of Object.entries(edits)) {
    const target = path.join(dir, file);
    if (edit === null) {
      fs.rmSync(target);
      continue;
    }
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const after = edit(before);
    if (after === before) throw new Error(`The edit to ${file} changed nothing`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, after);
  }
  return dir;
}

/** check:dist on `dir`, built from the repository's sources unless `sources` names others */
function run(dir, sources = ROOT) {
  const lines = [];
  const code = checkDist.main([dir], { log: line => lines.push(line), error: line => lines.push(line), sources });
  return { code, output: lines.join('\n') };
}

function assertFails(result, ...expected) {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /^check:dist failed: /);
  for (const text of expected) assert.ok(result.output.includes(text), `"${text}" missing from:\n${result.output}`);
}

describe('scripts/check-dist.js', () => {
  it('passes on the package as it is, with the module service worker and its kernel', () => {
    const dir = packageCopy();
    const { code, output } = run(dir);
    assert.equal(code, 0, output);
    assert.match(output, /^check:dist: OK, .* resolves all \d+ references: 4 pages, \d+ ES modules, \d+ classic scripts, and a module service worker \(js\/background\.js, \d+ files\)$/);
    // The worker loads its root, and through it the kernel on the legacy adapter
    const { workerFiles } = readScriptGraph(dir, { pages: checkDist.pagesIn(dir) });
    for (const file of ['js/background.js', 'js/utils.js', 'js/storage.js', 'js/kernel/composition/background.js',
      'js/kernel/adapters/legacy/adapter.js', 'js/kernel/core/application/kernel.js']) {
      assert.ok(workerFiles.has(file), `the worker loads ${file}`);
    }
  });

  it('fails when a kernel file is missing, naming the import that needs it', () => {
    const result = run(packageCopy({ 'js/kernel/composition/background.js': null }));
    assertFails(result, 'js/background.js imports "./kernel/composition/background.js", but js/kernel/composition/background.js is missing');
    // pr-gate's build excerpt starts at the report, past the build's own output
    const log = `${Array.from({ length: 40 }, (_, i) => `  ✓ js/file-${i}.js: 1 KB → 500 B (50.0% saved)`).join('\n')}\n\n> node scripts/check-dist.js\n\n${result.output}`;
    const lines = excerpt(log, MARKERS.build).split('\n');
    assert.match(lines[0], /^check:dist failed: 1 problem in /);
    assert.match(lines[1], /kernel\/composition\/background\.js is missing/);
  });

  it("fails when a contract or messaging module, a registry kit module, or Valibot's build is missing, whether anything imports it yet or not (#13, AC7; #15)", () => {
    assert.deepEqual(checkDist.SHIPPED_DIRS, [
      'js/kernel/core/contracts/',
      'js/kernel/core/messaging/',
      'js/kernel/adapters/messaging/',
      'js/kernel/registry/',
      'js/lib/valibot/',
    ]);
    // Nothing imports these yet, so only their directories say they're missing
    const unimported = run(packageCopy({
      'js/kernel/core/contracts/operations/create-note.js': null,
      'js/kernel/core/messaging/hints.js': null,
      'js/kernel/adapters/messaging/status-region.js': null,
      'js/kernel/registry/resolve.js': null,
    }));
    assertFails(unimported,
      'check:dist failed: 4 problems in ',
      'js/kernel/core/contracts/operations/create-note.js is missing; every module under js/kernel/core/contracts/ ships, imported yet or not',
      'js/kernel/core/messaging/hints.js is missing; every module under js/kernel/core/messaging/ ships',
      'js/kernel/adapters/messaging/status-region.js is missing; every module under js/kernel/adapters/messaging/ ships',
      'js/kernel/registry/resolve.js is missing; every module under js/kernel/registry/ ships');
    // The worker's router imports these, so what imports them says so too
    const imported = run(packageCopy({ 'js/kernel/core/contracts/codec.js': null, 'js/lib/valibot/index.mjs': null }));
    assertFails(imported,
      'js/kernel/core/messaging/router.js imports "../contracts/codec.js", but js/kernel/core/contracts/codec.js is missing',
      'js/kernel/core/contracts/fields.js imports "../../../lib/valibot/index.mjs", but js/lib/valibot/index.mjs is missing',
      'js/kernel/core/contracts/codec.js is missing; every module under js/kernel/core/contracts/ ships, imported yet or not',
      'js/lib/valibot/index.mjs is missing; every module under js/lib/valibot/ ships');
    // Only modules count: the declarations and the vendor record don't ship
    assert.deepEqual(checkDist.missingModules(packageCopy({
      'js/lib/valibot/index.d.mts': null,
      'js/lib/valibot/vendor.json': null,
    })), []);
  });

  it("fails when a page's script, a page's import, or the manifest's service worker is missing", () => {
    assertFails(run(packageCopy({ 'js/popup.js': null })), 'popup.html loads <script type="module" src> "js/popup.js", but js/popup.js is missing');
    assertFails(run(packageCopy({ 'js/insights-summary.js': null })), 'sidepanel.html loads <script src> "js/insights-summary.js", but js/insights-summary.js is missing');
    assertFails(run(packageCopy({ 'js/core/logger.js': null })), 'js/main.js imports "./core/logger.js", but js/core/logger.js is missing');
    assertFails(run(packageCopy({ 'js/background.js': null })), 'manifest.json names background.service_worker "js/background.js", but js/background.js is missing');
    assertFails(run(packageCopy({ 'sidepanel.html': null })), 'manifest.json names side_panel.default_path "sidepanel.html", but sidepanel.html is missing');
  });

  it("fails on top-level await, import(), and importScripts() in the worker's graph, but not on await in a function", () => {
    const result = run(packageCopy({
      'js/kernel/composition/background.js': text => `${text}\nawait Promise.resolve();\nfor await (const x of []) {}\nexport async function later() { await import('./elsewhere.js'); }\n`,
      'js/utils.js': text => `${text}\nif (false) importScripts('storage.js');\n`,
    }));
    assertFails(result,
      'js/kernel/composition/background.js uses top-level await at',
      "Chrome won't start a module service worker whose graph has it",
      'js/kernel/composition/background.js calls import() at',
      'js/utils.js calls importScripts() at');
    assert.equal(result.output.match(/uses top-level await/g).length, 2, result.output);
    // A page may use top-level await
    assert.equal(run(packageCopy({ 'js/search.js': text => `${text}\nawait Promise.resolve();\n` })).code, 0);
  });

  it('reads a module with no import or export as a module, so await (x) and await [x] count, and catches self.importScripts()', () => {
    // As a script, await (x) parses as a call to a function named await
    const result = run(packageCopy({
      'js/kernel/composition/background.js': text => `${text}\nawait (Promise.resolve());\nawait [1];\nself.later = async () => { await (1); };\n`,
      'js/storage.js': text => `${text}\nif (false) self.importScripts('utils.js');\n`,
    }));
    assertFails(result,
      'js/kernel/composition/background.js uses top-level await at',
      'js/storage.js calls importScripts() at');
    assert.equal(result.output.match(/uses top-level await/g).length, 2, result.output);
  });

  it('fails on a bare specifier, a URL, a path outside the package, and import syntax in a classic script', () => {
    assertFails(run(packageCopy({ 'js/main.js': text => `import 'valibot';\n${text}` })),
      'js/main.js imports "valibot": a bare specifier, which nothing resolves without a bundler or an import map');
    assertFails(run(packageCopy({ 'js/main.js': text => `import 'https://cdn.example.test/x.js';\n${text}` })),
      'js/main.js imports "https://cdn.example.test/x.js", which is a URL, not a file in the package');
    assertFails(run(packageCopy({ 'js/main.js': text => `import '../../outside.js';\n${text}` })),
      'js/main.js imports "../../outside.js", which resolves outside the package');
    assertFails(run(packageCopy({ 'js/insights-summary.js': text => `import './utils.js';\n${text}` })),
      'sidepanel.html loads js/insights-summary.js as a classic script, but it has import or export statements');
  });

  it('follows a classic service worker through importScripts, as the 1.4.x worker loads', () => {
    // A build of its own sources, which have no contract modules
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'js'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ background: { service_worker: 'js/worker.js' } }));
    fs.writeFileSync(path.join(dir, 'js', 'worker.js'), "importScripts('utils.js', 'gone.js');\n");
    fs.writeFileSync(path.join(dir, 'js', 'utils.js'), 'self.Utils = {};\n');
    assertFails(run(dir, dir), 'js/worker.js imports scripts "gone.js", but js/gone.js is missing');
    fs.writeFileSync(path.join(dir, 'js', 'gone.js'), '');
    const { code, output } = run(dir, dir);
    assert.equal(code, 0, output);
    assert.match(output, /a classic service worker \(js\/worker\.js, 3 files\)$/);
  });

  it('fails when there is no build to check', () => {
    assertFails(run(path.join(tempDir(), 'dist')), 'no build at');
  });

  it("fails when a page's module preloads and its module graph differ", () => {
    const first = '<link rel="modulepreload" href="js/kernel/adapters/legacy/adapter.js">';
    assertFails(
      run(packageCopy({ 'popup.html': text => text.replace(first, '') })),
      'check:dist failed: 1 problem in ',
      "popup.html doesn't preload js/kernel/adapters/legacy/adapter.js, which its module graph reaches two or more imports deep",
    );
    assertFails(
      run(packageCopy({
        'sidepanel.html': text => text.replace('</head>', '<link rel="modulepreload" href="js/storage.js">\n</head>'),
      })),
      "sidepanel.html preloads js/storage.js, which isn't two or more imports deep in its module graph",
    );
    // A module a page reaches deeper once its graph changes is one it has to preload
    assertFails(
      run(packageCopy({ 'js/kernel/core/contracts/limits.js': text => `import './extra.js';\n${text}`, 'js/kernel/core/contracts/extra.js': () => 'export {};\n' })),
      "newtab.html doesn't preload js/kernel/core/contracts/extra.js",
      "popup.html doesn't preload js/kernel/core/contracts/extra.js",
      "sidepanel.html doesn't preload js/kernel/core/contracts/extra.js",
    );
  });
});

describe('scripts/module-preloads.js', () => {
  it("lists each page's kernel graph, the modules two or more imports deep, and each page is up to date", () => {
    const graph = readScriptGraph(ROOT, { pages: ['newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html'] });
    for (const page of ['newtab.html', 'popup.html', 'sidepanel.html']) {
      const expected = modulePreloads.expectedPreloads(graph, page);
      // The kernel graph, and on the new tab the AI port its root builds (js/services/ai-port.mjs)
      const ownGraph = href => href.startsWith('js/kernel/') || (page === 'newtab.html' && href === 'js/services/ai-port.mjs');
      assert.ok(expected.length > 0 && expected.every(ownGraph), `${page}: ${expected}`);
      // The composition root is one import deep, so the page finds it as soon as its own script loads
      const roots = ['newtab', 'popup', 'sidepanel', 'background'].map(name => `js/kernel/composition/${name}.js`);
      assert.ok(!expected.some(href => roots.includes(href)), page);
      assert.deepEqual(preloadLinks(fs.readFileSync(path.join(ROOT, page), 'utf8')), expected, page);
    }
    assert.deepEqual(modulePreloads.expectedPreloads(graph, 'offscreen.html'), []);
    const lines = [];
    assert.equal(modulePreloads.main([], { log: line => lines.push(line), error: line => lines.push(line) }), 0, lines.join('\n'));
  });

  it('--write puts the hints before </head>, replaces the ones a page had, and changes nothing the second time', () => {
    const dir = packageCopy({
      'popup.html': text => {
        const begin = text.indexOf(modulePreloads.BEGIN);
        const end = text.indexOf(modulePreloads.END) + modulePreloads.END.length;
        return `${text.slice(0, begin)}<link rel="modulepreload" href="js/stale.js">${text.slice(end)}`;
      },
    });
    const before = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
    const lines = [];
    const options = { log: line => lines.push(line), error: line => lines.push(line), root: dir };
    assert.equal(modulePreloads.main([], options), 1);
    assert.ok(lines.some(line => line.includes(modulePreloads.WRITE_COMMAND)), lines.join('\n'));
    assert.deepEqual(modulePreloads.writePreloads(dir, ['popup.html', 'newtab.html']), ['popup.html']);
    assert.equal(fs.readFileSync(path.join(dir, 'popup.html'), 'utf8'), before);
    assert.deepEqual(modulePreloads.writePreloads(dir, ['popup.html', 'newtab.html']), []);
    assert.equal(modulePreloads.main([], options), 0);
  });
});
