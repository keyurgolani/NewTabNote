'use strict';

// The side-effects list (#300, from #27's Architecture: treeshake.moduleSideEffects "is true only
// for entry roots and the legacy global-assigning files in build/side-effects.json, which may only
// shrink"). Every other first-party module whose imports go unused drops whole, so an import made
// for side effects only has to name a listed module (side-effects/unlisted), each row has to be
// named by one (side-effects/stale), and a list that doesn't read fails as side-effects/file. The
// fixtures side-effects-unlisted, side-effects-stale, side-effects-file and treeshake-unused-export
// (test/build-fixtures/) show the rules in a build.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../scripts/build/vite-config.js');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'build', 'side-effects.json');

/** scripts/build/side-effects.js, required in each case that uses it */
const sideEffects = () => require('../scripts/build/side-effects.js');

const GROUP = Object.freeze({ owner: 3, reason: 'why these run for their side effects', modules: ['js/a.js'] });
const list = (/** @type {object[]} */ groups) => ({ about: 'what the groups are', groups });

/** Each pass's configuration, with `sideEffects` as the bundler's moduleSideEffects */
function passes(sideEffectsOf) {
  const options = { root: '/repo', outDir: '/repo/.dist-staging-x', mode: 'production', buildId: 'build-x', defineRows: {}, report: { chunks: [], assets: [] }, logger: /** @type {any} */ ({}), onLog: () => {}, sideEffects: sideEffectsOf };
  return [config.pagesConfig(options), config.recoveryConfig(options), config.backgroundConfig(options), config.guardConfig({ ...options, guardRows: [] })];
}

describe('build/side-effects.json (#300)', () => {
  it("holds js/main.js's imports for side effects, #3's, and the guard's installer, #21's, and nothing else, so the list only shrinks", () => {
    const text = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.deepEqual(text.groups.map(({ owner, modules }) => [owner, modules.length]), [[3, 45], [21, 1]], 'build/side-effects.json has a new row; the list only shrinks');
    const main = [...fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8').matchAll(/^import '\.\/(.+)';$/gm)].map((match) => `js/${match[1]}`);
    assert.deepEqual(text.groups[0].modules, main);
    assert.match(text.groups[0].reason, /#14's ports/);
    assert.deepEqual(text.groups[1].modules, ['js/kernel/composition/network-guard-first.js']);
    assert.match(text.groups[1].reason, /before any other import/);
    const read = sideEffects().readSideEffects();
    assert.deepEqual(read.problems, []);
    assert.deepEqual([...read.modules], [...main, 'js/kernel/composition/network-guard-first.js']);
  });

  it("takes each pass's inputs as its entry roots: each page's module script, the service worker, the network guard and the indexer's module worker", () => {
    assert.deepEqual([...sideEffects().entryRoots()].sort(), [
      'js/background.js', 'js/entries/newtab.js', 'js/network-guard.js', 'js/offscreen.js', 'js/popup.js', 'js/recovery.js', 'js/sidepanel.js', 'js/workers/indexer.js',
    ]);
  });

  it("keeps a first-party module's side effects only for a root or a listed module, and every other id's, Vite's own and the dependencies', as they come", () => {
    const { sideEffectsFor } = require('../scripts/build/bundle.js');
    const keep = sideEffectsFor('/repo', new Set(['js/a.js', 'js/entry.js']));
    assert.deepEqual(['/repo/js/a.js', '/repo/js/entry.js', '/repo/js/b.js', '/repo/js/kernel/c.mjs'].map(keep), [true, true, false, false]);
    for (const id of ['/repo/newtab.html', '\0vite/preload-helper.js', '/repo/js/b.js?worker_file&type=module', '/repo/node_modules/valibot/dist/index.js', '/repo/css/a.css']) {
      assert.equal(keep(id), true, id);
    }
  });

  it("sets the bundler's moduleSideEffects in every pass and the workers' build", () => {
    const keep = () => true;
    const [pages, recovery, background, guard] = passes(keep);
    for (const options of [pages.build.rolldownOptions, pages.worker.rolldownOptions, recovery.build.rolldownOptions, background.build.rolldownOptions, guard.build.rolldownOptions]) {
      assert.equal(options.treeshake.moduleSideEffects, keep);
    }
  });

  it('fails an import for side effects only of a module the list lacks as side-effects/unlisted, and a listed module no such import names as side-effects/stale', () => {
    const { sideEffectProblems } = sideEffects();
    // An import with bindings, and a re-export, run the module for what they take from it
    const sources = [
      { file: 'js/main.js', text: "import './a.js';\nimport './b.js';\nimport { c } from './c.js';\nexport * from './d.js';" },
      { file: 'js/x/e.js', text: "import '../a.js';" },
    ];
    const found = sideEffectProblems(sources, new Set(['js/a.js', 'js/c.js']));
    assert.deepEqual(found.map(({ code, subject }) => `${code} ${subject}`), ['side-effects/unlisted js/main.js:2:8', 'side-effects/stale build/side-effects.json']);
    assert.match(found[0].message, /js\/b\.js/);
    assert.match(found[1].message, /js\/c\.js/);
    assert.deepEqual(sideEffectProblems(sources, new Set(['js/a.js', 'js/b.js'])), []);
  });

  it("fails a list that is missing, doesn't parse, or has a group with no owner, no reason or no modules, a module twice, or a field it doesn't take, each as side-effects/file", () => {
    const { fileProblems, readSideEffects } = sideEffects();
    assert.deepEqual(fileProblems(list([GROUP])), []);
    const broken = {
      'no owner': list([{ ...GROUP, owner: undefined }]),
      'an owner that is no issue number': list([{ ...GROUP, owner: '#3' }]),
      'no reason': list([{ ...GROUP, reason: '' }]),
      'no modules': list([{ ...GROUP, modules: [] }]),
      'a module that is no source path': list([{ ...GROUP, modules: ['./a.js'] }]),
      'a module in two groups': list([GROUP, { ...GROUP, owner: 21 }]),
      'a field a group does not take': list([{ ...GROUP, count: 1 }]),
      'no about text': { groups: [GROUP] },
      'a field the list does not take': { ...list([GROUP]), rows: [] },
    };
    for (const [label, shape] of Object.entries(broken)) assert.deepEqual(fileProblems(shape).map(({ code }) => code), ['side-effects/file'], label);
    for (const shape of [null, [], { about: 'no groups' }, { about: 'groups as an object', groups: {} }]) {
      assert.deepEqual(fileProblems(shape).map(({ code }) => code), ['side-effects/file'], JSON.stringify(shape));
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-side-effects-'));
    try {
      const missing = readSideEffects(dir);
      assert.deepEqual([[...missing.modules], missing.problems.map(({ code, subject, message }) => `${code} ${subject} ${message}`)], [[], ['side-effects/file build/side-effects.json is missing']]);
      fs.mkdirSync(path.join(dir, 'build'));
      fs.writeFileSync(path.join(dir, 'build', 'side-effects.json'), '{"groups": ');
      const unparsed = readSideEffects(dir);
      assert.deepEqual([[...unparsed.modules], unparsed.problems.map(({ code }) => code)], [[], ['side-effects/file']]);
      assert.match(unparsed.problems[0].message, /^doesn't parse/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
