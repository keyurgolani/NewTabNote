'use strict';

// #27 AC5: the closure check (scripts/build/closure.js) on the package scripts/build.js's lists
// describe, and on small packages with one thing broken.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const build = require('../scripts/build.js');
const { checkClosure, resolve, staticAssets, STATIC_ASSETS } = require('../scripts/build/closure.js');
const { sourcePackage, packageOf } = require('./helpers/source-package.js');

const NO_ASSETS = { files: new Set(), directories: [] };
const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0', chrome_url_overrides: { newtab: 'newtab.html' } });

/** The codes and subjects a check reported, sorted */
function found(problems) {
  return problems.map(({ code, subject }) => `${code} ${subject}`).sort();
}

describe('the closure check on the package the build lists describe', () => {
  it('finds every named path in it and nothing unnamed beyond build/static-assets.json', () => {
    const { problems, referenced } = checkClosure(sourcePackage());
    assert.deepEqual(problems, []);
    for (const file of ['js/workers/indexer.js', 'offscreen.html', 'js/offscreen.js', 'popup.html', 'icons/icon48.png', 'css/editor.css']) {
      assert.ok(referenced.has(file), `${file} isn't named`);
    }
  });

  it('would have caught the indexer: without it in JS_FILES, both new Worker() calls name a missing file', () => {
    const jsFiles = build.JS_FILES.filter((file) => file !== 'js/workers/indexer.js');
    assert.equal(jsFiles.length, build.JS_FILES.length - 1, 'JS_FILES ships the indexer');
    const { problems } = checkClosure(sourcePackage({ jsFiles }));
    assert.deepEqual(problems.map(({ code, subject }) => `${code} ${subject}`), [
      'closure/missing js/workers/indexer.js',
      'closure/missing js/workers/indexer.js',
    ]);
    const named = problems.map(({ message }) => message.replace(/ at \d+:\d+/, '')).sort();
    assert.deepEqual(named, [
      "new Worker() in js/app.js, but the package doesn't have it",
      "new Worker() in js/controllers/notes-manager.js, but the package doesn't have it",
    ]);
  });

  it('fails on a getURL or createDocument path built at run time, as ensureOffscreenDocument had', () => {
    const background = 'js/background.js';
    const text = fs.readFileSync(path.join(__dirname, '..', background), 'utf8');
    const edited = text.replace(
      "documentUrls: [chrome.runtime.getURL('offscreen.html')]",
      "documentUrls: [chrome.runtime.getURL(offscreenUrl)]",
    ).replace("url: 'offscreen.html',", 'url: offscreenUrl,');
    assert.notEqual(edited, text);
    const { problems } = checkClosure(sourcePackage({ edits: { [background]: edited } }));
    const nonLiteral = problems.filter(({ code }) => code === 'closure/non-literal');
    assert.equal(nonLiteral.length, 2, found(problems).join('\n'));
    assert.ok(nonLiteral.every(({ subject }) => /^js\/background\.js:\d+:\d+$/.test(subject)));
    assert.match(nonLiteral.map(({ message }) => message).join('\n'), /chrome\.runtime\.getURL gets a path built at run time[\s\S]*createDocument's url gets a path/);
    // And with the paths unknown, nothing names the offscreen document
    assert.deepEqual(found(problems.filter(({ code }) => code !== 'closure/non-literal')), [
      'closure/unreferenced js/offscreen.js',
      'closure/unreferenced offscreen.html',
    ]);
  });
});

describe('build/static-assets.json', () => {
  const listed = JSON.parse(fs.readFileSync(STATIC_ASSETS, 'utf8'));

  it('gives every row a reason, and says which change removes each row slice 1 adds for files that ship ahead', () => {
    for (const row of [...listed.files, ...listed.directories]) assert.ok(row.why && row.why.length > 10, row.path);
    for (const file of ['icons/icon16.svg', 'icons/icon48.svg', 'icons/icon128.svg']) {
      assert.match(listed.files.find((row) => row.path === file).until, /#27 slice 2/, file);
    }
    assert.deepEqual(listed.directories.map((row) => row.path), ['js/kernel/', 'js/trust/']);
    for (const row of listed.directories) assert.match(row.until, /#27 slice 2/, row.path);
  });

  it('a directory row covers only the scripts under it', () => {
    const pkg = (extra) => packageOf({ 'manifest.json': MANIFEST, 'newtab.html': '<p>new tab</p>', ...extra });
    assert.deepEqual(checkClosure(pkg({ 'js/kernel/later.js': 'export const x = 1;', 'js/trust/later.mjs': '' })).problems, []);
    assert.deepEqual(found(checkClosure(pkg({ 'js/kernel/notes.json': '{}', 'js/trust/README.md': '' })).problems), [
      'closure/unreferenced js/kernel/notes.json',
      'closure/unreferenced js/trust/README.md',
    ]);
    const assets = staticAssets();
    assert.ok(assets.files.has('build-info.json') && assets.files.has('asset-manifest.json') && assets.files.has('THIRD_PARTY_NOTICES'));
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
      ["new Worker(new URL('js/w.js', import.meta.url));", 'new URL'],
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
