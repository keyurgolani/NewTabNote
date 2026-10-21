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

function run(dir) {
  const lines = [];
  const code = checkDist.main([dir], { log: line => lines.push(line), error: line => lines.push(line) });
  return { code, output: lines.join('\n') };
}

function assertFails(result, ...expected) {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /^check:dist failed: /);
  for (const text of expected) assert.ok(result.output.includes(text), `"${text}" missing from:\n${result.output}`);
}

describe('scripts/check-dist.js', () => {
  it('passes on the package as it is, with the module service worker and its kernel root', () => {
    const { code, output } = run(packageCopy());
    assert.equal(code, 0, output);
    assert.match(output, /^check:dist: OK, .* resolves all \d+ references: 4 pages, \d+ ES modules, \d+ classic scripts, and a module service worker \(js\/background\.js, 4 files\)$/);
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
    assertFails(run(packageCopy({ 'js/offscreen.js': text => `import './utils.js';\n${text}` })),
      'offscreen.html loads js/offscreen.js as a classic script, but it has import or export statements');
  });

  it('follows a classic service worker through importScripts, as the 1.4.x worker loads', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'js'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ background: { service_worker: 'js/worker.js' } }));
    fs.writeFileSync(path.join(dir, 'js', 'worker.js'), "importScripts('utils.js', 'gone.js');\n");
    fs.writeFileSync(path.join(dir, 'js', 'utils.js'), 'self.Utils = {};\n');
    assertFails(run(dir), 'js/worker.js imports scripts "gone.js", but js/gone.js is missing');
    fs.writeFileSync(path.join(dir, 'js', 'gone.js'), '');
    const { code, output } = run(dir);
    assert.equal(code, 0, output);
    assert.match(output, /a classic service worker \(js\/worker\.js, 3 files\)$/);
  });

  it('fails when there is no build to check', () => {
    assertFails(run(path.join(tempDir(), 'dist')), 'no build at');
  });
});
