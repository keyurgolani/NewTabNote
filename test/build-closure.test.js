'use strict';

// #27 AC5: the closure check (scripts/build/closure.js) on the sources the bundler reads, on a
// package laid out as the bundler writes one, and on small packages with one thing broken.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkClosure, checkPreloads, checkClassicScripts, resolve, staticAssets, STATIC_ASSETS } = require('../scripts/build/closure.js');
const { sourcePackage, packageOf } = require('./helpers/source-package.js');

const NO_ASSETS = { files: new Set(), directories: [] };
const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0', chrome_url_overrides: { newtab: 'newtab.html' } });

/** The codes and subjects a check reported, sorted */
function found(problems) {
  return problems.map(({ code, subject }) => `${code} ${subject}`).sort();
}

describe('the closure check on the sources the bundler reads', () => {
  // The sources hold modules no entry imports yet, which the bundler leaves out of dist/: those
  // read as unreferenced here, and every path the sources name has to be there
  const named = (problems) => problems.filter(({ code }) => code !== 'closure/unreferenced');

  it('finds every path they name, the indexer through its module worker URL included', () => {
    const { problems, referenced } = checkClosure(sourcePackage());
    assert.deepEqual(named(problems), []);
    for (const file of ['js/workers/indexer.js', 'js/kernel/composition/workers.js', 'offscreen.html', 'js/offscreen.js', 'popup.html',
      'css/popup.css', 'css/sidepanel.css', 'icons/icon48.png', 'css/editor.css', 'js/lib/fuse.js', 'js/insights-summary.js']) {
      assert.ok(referenced.has(file), `${file} isn't named`);
    }
  });

  it('would have caught the indexer: without it, the worker URL names a missing file', () => {
    const { problems } = checkClosure(sourcePackage({ edits: { 'js/workers/indexer.js': null } }));
    assert.deepEqual(found(named(problems)), ['closure/missing js/workers/indexer.js']);
    assert.match(problems.find(({ code }) => code === 'closure/missing').message, /new Worker\(new URL\(\)\) at \d+:\d+ in js\/kernel\/composition\/workers\.js/);
  });

  it('loads no module as a classic script, as sidepanel.html would with an import in js/insights-summary.js', () => {
    assert.deepEqual(checkClassicScripts(sourcePackage()), []);
    const file = 'js/insights-summary.js';
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const problems = checkClassicScripts(sourcePackage({ edits: { [file]: `import './utils.js';\n${text}` } }));
    assert.deepEqual(problems.map(({ code, subject, message }) => `${code} ${subject} ${message.replace(/ at \d+:\d+,/, ',')}`), [
      'build/load-mode js/insights-summary.js sidepanel.html loads it as a classic script, but it has an import or export statement or import.meta at 1:1, which only a module parses',
    ]);
  });

  it('fails on a getURL or createDocument path built at run time, as ensureOffscreenDocument had', () => {
    const background = 'js/background.js';
    const text = fs.readFileSync(path.join(__dirname, '..', background), 'utf8');
    const edited = text.replace(
      "documentUrls: [chrome.runtime.getURL('offscreen.html')]",
      'documentUrls: [chrome.runtime.getURL(offscreenUrl)]',
    ).replace("url: 'offscreen.html',", 'url: offscreenUrl,');
    assert.notEqual(edited, text);
    const { problems } = checkClosure(sourcePackage({ edits: { [background]: edited } }));
    const nonLiteral = problems.filter(({ code }) => code === 'closure/non-literal');
    assert.equal(nonLiteral.length, 2, found(problems).join('\n'));
    assert.ok(nonLiteral.every(({ subject }) => /^js\/background\.js:\d+:\d+$/.test(subject)));
    assert.match(nonLiteral.map(({ message }) => message).join('\n'), /chrome\.runtime\.getURL gets a path built at run time[\s\S]*createDocument's url gets a path/);
    // And with the paths unknown, nothing names the offscreen document
    const offscreen = found(problems.filter(({ code }) => code === 'closure/unreferenced')).filter((line) => /offscreen/.test(line));
    assert.deepEqual(offscreen, ['closure/unreferenced js/offscreen.js', 'closure/unreferenced offscreen.html']);
  });
});

describe('build/static-assets.json', () => {
  const listed = JSON.parse(fs.readFileSync(STATIC_ASSETS, 'utf8'));

  it('gives every row a reason, and holds no directory row or icon source, since the bundler ships only what an entry reaches', () => {
    for (const row of [...listed.files, ...listed.directories]) assert.ok(row.why && row.why.length > 10, row.path);
    // #27 slice 2 dropped the js/kernel/ and js/trust/ rows and the three icons/*.svg rows
    assert.deepEqual(listed.directories, []);
    assert.deepEqual(listed.files.map((row) => row.path), ['LICENSE', 'THIRD_PARTY_NOTICES', 'js/lib/valibot/LICENSE.md', 'build-info.json', 'asset-manifest.json']);
    const assets = staticAssets();
    assert.ok(assets.files.has('build-info.json') && assets.files.has('asset-manifest.json') && assets.files.has('THIRD_PARTY_NOTICES'));
  });

  it('a directory row would cover only the scripts under it', () => {
    const pkg = (extra) => packageOf({ 'manifest.json': MANIFEST, 'newtab.html': '<p>new tab</p>', ...extra });
    const assets = { files: new Set(), directories: ['js/kernel/', 'js/trust/'] };
    assert.deepEqual(checkClosure(pkg({ 'js/kernel/later.js': 'export const x = 1;', 'js/trust/later.mjs': '' }), { staticAssets: assets }).problems, []);
    assert.deepEqual(found(checkClosure(pkg({ 'js/kernel/notes.json': '{}', 'js/trust/README.md': '' }), { staticAssets: assets }).problems), [
      'closure/unreferenced js/kernel/notes.json',
      'closure/unreferenced js/trust/README.md',
    ]);
  });
});

describe('the closure check on a package laid out as the bundler writes one', () => {
  // newtab.html loads its entry chunk and preloads the chunk that imports; the entry starts a
  // module worker as Vite writes one and imports a lazy chunk; the service worker is one file
  const files = {
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0', chrome_url_overrides: { newtab: 'newtab.html' }, background: { service_worker: 'js/background.js', type: 'module' }, icons: { 48: 'icons/icon48.png' } }),
    'newtab.html': '<script type="module" crossorigin src="/assets/newtab-A1.js"></script><link rel="modulepreload" crossorigin href="/assets/host-B2.js"><link rel="stylesheet" crossorigin href="/assets/newtab-C3.css"><script src="js/lib/fuse.js"></script>',
    'assets/newtab-A1.js': 'import{h as e}from"./host-B2.js";new Worker(new URL("/assets/indexer-D4.js",""+import.meta.url),{type:"module"});const t=()=>import("./trust-E5.js");',
    'assets/host-B2.js': 'export const h=1;',
    'assets/trust-E5.js': 'import{h as e}from"./host-B2.js";export const t=e;',
    'assets/indexer-D4.js': 'self.onmessage=()=>{};',
    'assets/newtab-C3.css': '.a{background:url(/icons/icon48.png)}',
    'js/lib/fuse.js': 'var Fuse=1;',
    'js/background.js': "chrome.tabs.create({url:chrome.runtime.getURL('newtab.html')});",
    'icons/icon48.png': '',
  };
  const bundled = (edits = {}) => {
    const contents = { ...files, ...edits };
    for (const [file, text] of Object.entries(contents)) if (text === null) delete contents[file];
    return packageOf(contents);
  };
  const options = { staticAssets: NO_ASSETS, vendored: new Set(['js/lib/fuse.js']) };

  it('follows the entry, its preloads and imports, the module worker URL, the lazy chunk, and the stylesheet', () => {
    const { problems, referenced } = checkClosure(bundled(), options);
    assert.deepEqual(problems, []);
    for (const file of ['assets/newtab-A1.js', 'assets/host-B2.js', 'assets/trust-E5.js', 'assets/indexer-D4.js', 'assets/newtab-C3.css', 'icons/icon48.png']) {
      assert.ok(referenced.has(file), file);
    }
    assert.deepEqual(checkPreloads(bundled()), []);
  });

  it('reports a missing worker chunk, and a worker URL built at run time', () => {
    assert.deepEqual(found(checkClosure(bundled({ 'assets/indexer-D4.js': null }), options).problems), ['closure/missing assets/indexer-D4.js']);
    const text = 'new Worker(new URL(e,import.meta.url),{type:"module"});';
    const computed = bundled({ 'assets/indexer-D4.js': null, 'assets/newtab-A1.js': `import{h}from"./host-B2.js";const t=()=>import("./trust-E5.js");${text}` });
    const at = `import{h}from"./host-B2.js";const t=()=>import("./trust-E5.js");`.length + 'new Worker(new URL('.length + 1;
    assert.deepEqual(found(checkClosure(computed, options).problems), [`closure/non-literal assets/newtab-A1.js:1:${at}`]);
  });

  it('reads a module worker URL against the script itself, not the page', () => {
    const pkg = packageOf({
      'manifest.json': MANIFEST,
      'newtab.html': '<script type="module" src="js/deep/a.js"></script>',
      'js/deep/a.js': "new Worker(new URL('../workers/w.js', import.meta.url), { type: 'module' });",
      'js/workers/w.js': "import './helper.js';",
      'js/workers/helper.js': '',
    });
    assert.deepEqual(checkClosure(pkg, { staticAssets: NO_ASSETS, vendored: new Set() }).problems, []);
  });

  it('fails a page that doesn\'t preload a chunk its module scripts import, or preloads one they don\'t', () => {
    const page = (links) => `<script type="module" src="/assets/newtab-A1.js"></script>${links}`;
    assert.deepEqual(checkPreloads(bundled({ 'newtab.html': page('') })).map(({ code, subject, message }) => `${code} ${subject}: ${message}`), [
      'closure/preload newtab.html: doesn\'t preload assets/host-B2.js, which its module scripts import',
    ]);
    const extra = checkPreloads(bundled({ 'newtab.html': page('<link rel="modulepreload" href="/assets/host-B2.js"><link rel="modulepreload" href="/assets/trust-E5.js">') }));
    assert.deepEqual(extra.map(({ message }) => message), ['preloads assets/trust-E5.js, which its module scripts don\'t import at start']);
  });
});

describe('how the closure check follows paths', () => {
  it('follows pages, stylesheets, imports, workers, and the chrome.* paths, and reports what is missing or unnamed', () => {
    const pkg = packageOf({
      'manifest.json': JSON.stringify({
        manifest_version: 3,
        name: 'x',
        version: '1.0.0',
        chrome_url_overrides: { newtab: 'newtab.html' },
        background: { service_worker: 'js/background.js', type: 'module' },
        icons: { 16: 'icons/16.png' },
        action: { default_icon: { 48: 'icons/48.png' } },
      }),
      'newtab.html': '<link rel="stylesheet" href="css/a.css"><img srcset="img/1x.png 1x, img/2x.png 2x"><script type="module" src="js/main.js?v=1"></script><a href="https://example.test/x.js">x</a><a href="#top">top</a>',
      'css/a.css': '@import "b.css"; .x { background: url(../img/bg.png) } .y { mask: url(#m) } .z { background: url(data:image/png;base64,AA==) }',
      'css/b.css': '',
      'img/1x.png': '', 'img/2x.png': '', 'img/bg.png': '',
      'icons/16.png': '', 'icons/48.png': '',
      'js/main.js': "import './lib.js'; new Worker('js/worker.js'); chrome.tabs.create({ url: 'page.html' }); import('./lazy.js');",
      'js/lib.js': '',
      'js/lazy.js': '',
      'js/worker.js': "importScripts('helper.js');",
      'js/helper.js': '',
      'page.html': '',
      'js/background.js': "chrome.notifications.create({ iconUrl: 'icons/48.png' }); chrome.runtime.getURL('/missing.html');",
      'stray.txt': '',
    });
    const { problems, referenced } = checkClosure(pkg, { staticAssets: NO_ASSETS });
    assert.deepEqual(found(problems), ['closure/missing missing.html', 'closure/unreferenced stray.txt']);
    for (const file of ['css/b.css', 'img/bg.png', 'img/2x.png', 'js/lib.js', 'js/lazy.js', 'js/worker.js', 'js/helper.js', 'page.html', 'icons/16.png']) {
      assert.ok(referenced.has(file), file);
    }
  });

  it('fails on a path built at run time in first-party code, for every kind it follows, and leaves vendored code to its records', () => {
    // #89's review: each of these named a missing file and passed, and terser folds only some
    // of the constants into literals, so a --dev build shipped them all. Each line and the
    // text the problem points at.
    const cases = [
      ['const n = "w"; new Worker(`js/${n}.js`);', '`js/'],
      ["const u = 'js/w.js'; new Worker(u);", 'u);'],
      ["const w = 'w.js'; new Worker(new URL(w, import.meta.url));", 'w, import'],
      ["const s = 'w.js'; importScripts(s);", 's);'],
      ["const m = './gone.js'; import(m);", 'm);'],
      ["const page = 'gone.html'; chrome.tabs.create({ url: page });", 'page }'],
      ["const url = 'gone.html'; chrome.tabs.create({ url });", 'url }'],
      ["const icon = 'gone.png'; chrome.notifications.create({ iconUrl: icon });", 'icon }'],
      ["const iconUrl = 'gone.png'; chrome.notifications.create({ iconUrl });", 'iconUrl }'],
    ];
    const pkg = packageOf({
      'manifest.json': MANIFEST,
      'newtab.html': '<script src="js/a.js"></script><script src="js/lib/vendored.js"></script>',
      'js/a.js': cases.map(([line]) => line).join('\n'),
      // A vendored library's own run-time paths are its record's business, not the closure's
      'js/lib/vendored.js': "var u = base + 'w.js'; new Worker(u); import(u); importScripts(u);",
    });
    const { problems } = checkClosure(pkg, { staticAssets: NO_ASSETS, vendored: new Set(['js/lib/vendored.js']) });
    const expected = cases.map(([line, at], i) => `closure/non-literal js/a.js:${i + 1}:${line.indexOf(at) + 1}`);
    assert.deepEqual(found(problems), [...expected].sort());
    assert.ok(problems.every(({ message }) => /built at run time/.test(message)), problems.map(({ message }) => message).join('\n'));
  });

  it('fails on a tabs.create url or an iconUrl from any call but getURL, on options it can\'t read, and on a spread', () => {
    // #89's delta review: each of these passed, since both kinds skipped every call
    const cases = [
      ["chrome.tabs.create({ url: helper('x.html') });", "helper("],
      ['chrome.notifications.create({ iconUrl: icon() });', 'icon()'],
      ["const opts = { url: 'gone.html' }; chrome.tabs.create(opts);", 'opts);'],
      ["const o = { url: 'gone.html' }; chrome.tabs.create({ ...o });", '{ ...o }'],
    ];
    const pkg = packageOf({
      'manifest.json': MANIFEST,
      'newtab.html': '<script src="js/a.js"></script>',
      'js/a.js': cases.map(([line]) => line).join('\n'),
    });
    const expected = cases.map(([line, at], i) => `closure/non-literal js/a.js:${i + 1}:${line.indexOf(at) + 1}`);
    assert.deepEqual(found(checkClosure(pkg, { staticAssets: NO_ASSETS, vendored: new Set() }).problems), [...expected].sort());

    // getURL is the one call it reads through: its own reference covers the path
    const named = packageOf({
      'manifest.json': MANIFEST,
      'newtab.html': '<script src="js/a.js"></script>',
      'js/a.js': "chrome.tabs.create({ url: chrome.runtime.getURL('page.html') }); chrome.notifications.create({ iconUrl: chrome.runtime.getURL('i.png') });",
      'page.html': '',
      'i.png': '',
    });
    assert.deepEqual(checkClosure(named, { staticAssets: NO_ASSETS, vendored: new Set() }).problems, []);
  });

  it('resolves a worker from the page that runs the script, and importScripts from the worker', () => {
    // From js/a.js on a root page, 'w.js' is the root's w.js, not js/w.js
    const pkg = packageOf({
      'manifest.json': MANIFEST,
      'newtab.html': '<script src="js/a.js"></script>',
      'js/a.js': "new Worker('w.js');",
      'w.js': "importScripts('lib/x.js');",
      'lib/x.js': '',
    });
    assert.deepEqual(checkClosure(pkg, { staticAssets: NO_ASSETS }).problems, []);
  });

  it('reads chrome-extension URLs as package paths and leaves other URLs alone', () => {
    assert.equal(resolve('chrome-extension://abcdef/js/a.js?x#y', ''), 'js/a.js');
    assert.equal(resolve('https://example.test/a.js', ''), 'elsewhere');
    assert.equal(resolve('//cdn.example.test/a.js', ''), 'elsewhere');
    assert.equal(resolve('data:text/plain,hi', ''), 'elsewhere');
    assert.equal(resolve('../../a.js', 'js'), 'outside');
    assert.equal(resolve('./b%20c.css', 'css'), 'css/b c.css');
    assert.equal(resolve('/icons/a.png', 'css'), 'icons/a.png');
    assert.equal(resolve('', ''), 'elsewhere');
    assert.equal(resolve('chrome-extension://abcdef/', ''), 'elsewhere');
    assert.equal(resolve('js/', ''), 'elsewhere');
  });
});
