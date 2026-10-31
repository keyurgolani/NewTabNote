'use strict';

// scripts/check-dist.js (#12, folded into the closure check by #27 slice 2) on a small build
// laid out as the bundler writes dist/, and on copies with one thing broken. The build runs the
// same checks on what it writes (scripts/build/main.js); CI runs this on the build its extension
// job tests.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const checkDist = require('../scripts/check-dist.js');
const { excerpt, MARKERS } = require('../scripts/ci/failure-excerpt.js');

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// A network guard as the build's check runs it (scripts/build/guard.js): it marks each API it
// wraps, leaves its mark, lets only this extension's own origin through, and sends the worker a
// report of what it refused. The real one is js/network-guard.js bundled, which
// test/network-guard.test.js covers.
const GUARD = '(function(){var G=Symbol.for("ntn.networkGuard");function m(f){Object.defineProperty(f,G,{value:true});return f}'
  + 'self[G]={surface:"newtab"};var f=self.fetch;self.fetch=m(function(u,i){return f.call(self,u,i)});'
  + 'var P=self.XMLHttpRequest.prototype,o=P.open,s=P.send;P.open=m(function(){return o.apply(this,arguments)});P.send=m(function(){return s.apply(this,arguments)});'
  + 'self.WebSocket=m(self.WebSocket);self.EventSource=m(self.EventSource);var b=self.navigator.sendBeacon;'
  + 'self.navigator.sendBeacon=m(function(u,d){if(String(u).indexOf("chrome-extension://")===0)return b.call(this,u,d);'
  + 'chrome.runtime.sendMessage({type:"NETWORK_REFUSED",report:{surface:"newtab",errorCode:"destination-refused",count:1}});return false})})();';

// Two pages that load the network guard first, then their entry chunks, and preload the chunk
// those import, a module worker chunk, a lazy chunk, a stylesheet, a vendored classic script,
// the self-contained service worker, and the files build/static-assets.json lists
const BUILD = {
  'manifest.json': JSON.stringify({
    manifest_version: 3,
    name: 'x',
    version: '1.0.0',
    chrome_url_overrides: { newtab: 'newtab.html' },
    side_panel: { default_path: 'sidepanel.html' },
    background: { service_worker: 'js/background.js', type: 'module' },
    icons: { 48: 'icons/icon48.png' },
  }),
  'newtab.html': '<script src="js/network-guard.js"></script><script src="js/lib/fuse.js"></script><script type="module" crossorigin src="/assets/newtab-A1.js"></script><link rel="modulepreload" crossorigin href="/assets/host-B2.js"><link rel="stylesheet" crossorigin href="/assets/newtab-C3.css">',
  'sidepanel.html': '<script src="js/network-guard.js"></script><script type="module" crossorigin src="/assets/sidepanel-F6.js"></script><link rel="modulepreload" crossorigin href="/assets/host-B2.js">',
  'assets/newtab-A1.js': 'import{h as e}from"./host-B2.js";new Worker(new URL("/assets/indexer-D4.js",""+import.meta.url),{type:"module"});const t=()=>import("./trust-E5.js");',
  'assets/sidepanel-F6.js': 'import{h as e}from"./host-B2.js";console.log(e);',
  'assets/host-B2.js': 'export const h=1;',
  'assets/trust-E5.js': 'import{h as e}from"./host-B2.js";export const t=e;',
  'assets/indexer-D4.js': 'self.onmessage=()=>{};',
  'assets/newtab-C3.css': '.a{background:url(/icons/icon48.png)}',
  'js/lib/fuse.js': 'var Fuse=1;',
  'js/network-guard.js': GUARD,
  'js/background.js': 'chrome.runtime.onInstalled.addListener(()=>{chrome.tabs.create({url:chrome.runtime.getURL("newtab.html")})});self.later=async()=>{await (1)};',
  'icons/icon48.png': '',
  LICENSE: 'MIT',
  THIRD_PARTY_NOTICES: 'notices',
  'build-info.json': '{}',
  'asset-manifest.json': '{}',
};

/**
 * BUILD in a directory of its own, with `edits`: a path to its new text, or null to leave it out
 * @param {Record<string, string | null>} [edits]
 */
function buildDir(edits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-check-dist-'));
  temps.push(dir);
  for (const [file, text] of Object.entries({ ...BUILD, ...edits })) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

/** check:dist on `dir` */
function run(dir) {
  const lines = [];
  const code = checkDist.main([dir], { log: (line) => lines.push(line), error: (line) => lines.push(line) });
  return { code, output: lines.join('\n') };
}

function assertFails(result, ...expected) {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /^check:dist failed: /);
  for (const text of expected) assert.ok(result.output.includes(text), `"${text}" missing from:\n${result.output}`);
}

describe('scripts/check-dist.js', () => {
  it('passes on a build laid out as the bundler writes one, and says what it holds', () => {
    const { code, output } = run(buildDir());
    assert.equal(code, 0, output);
    assert.match(output, /^check:dist: OK, .+\/ closes over its 17 files: 2 pages, 5 chunks, 2 classic scripts, and a self-contained module service worker \(js\/background\.js\)$/);
  });

  it('fails on a chunk the build lacks, naming what needs it, and pr-gate\'s excerpt starts at the report', () => {
    const result = run(buildDir({ 'assets/indexer-D4.js': null }));
    assertFails(result, 'check:dist failed: 1 problem in ', '[closure/missing] assets/indexer-D4.js: new Worker(new URL()) at 1:');
    assert.match(run(buildDir({ 'assets/host-B2.js': null })).output, /\[closure\/missing\] assets\/host-B2\.js: imported at 1:\d+ in assets\/newtab-A1\.js, but .+ doesn't have it/);
    // pr-gate's build excerpt starts at the report, past the build's own output
    const log = `${Array.from({ length: 40 }, (_, i) => `dist/assets/chunk-${i}.js  1.00 kB │ gzip: 0.50 kB`).join('\n')}\n\n> node scripts/check-dist.js\n\n${result.output}`;
    const lines = excerpt(log, MARKERS.build).split('\n');
    assert.match(lines[0], /^check:dist failed: 1 problem in /);
    assert.match(lines[1], /\[closure\/missing\] assets\/indexer-D4\.js/);
  });

  it('fails when a page, the service worker, or a page\'s script is missing', () => {
    assertFails(run(buildDir({ 'sidepanel.html': null })), '[closure/missing] sidepanel.html: names it as side_panel.default_path in manifest.json');
    assertFails(run(buildDir({ 'js/lib/fuse.js': null })), '[closure/missing] js/lib/fuse.js: <script src> at 1:');
    const worker = run(buildDir({ 'js/background.js': null }));
    assertFails(worker, 'check:dist failed: 2 problems in ', '[closure/missing] js/background.js: names it as background.service_worker in manifest.json',
      'has no js/background.js, the service worker the manifest names');
  });

  it("fails on a page whose first script isn't the network guard, and on a guard that doesn't wrap what it covers or lets a call go", () => {
    assertFails(run(buildDir({ 'sidepanel.html': '<script type="module" crossorigin src="/assets/sidepanel-F6.js"></script><script src="js/network-guard.js"></script><link rel="modulepreload" crossorigin href="/assets/host-B2.js">' })),
      'check:dist failed: 1 problem in ', '[guard/page-first] sidepanel.html: its first script at 1:1 is /assets/sidepanel-F6.js, not the network guard');
    assertFails(run(buildDir({ 'newtab.html': '<script defer src="js/network-guard.js"></script><script src="js/lib/fuse.js"></script><script type="module" crossorigin src="/assets/newtab-A1.js"></script><link rel="modulepreload" crossorigin href="/assets/host-B2.js"><link rel="stylesheet" crossorigin href="/assets/newtab-C3.css">' })),
      '[guard/page-first] newtab.html: it loads the network guard at 1:1 as a module, async, or deferred');
    assertFails(run(buildDir({ 'js/network-guard.js': GUARD.replace('self.WebSocket=m(self.WebSocket);', '') })), '[guard/not-installed] js/network-guard.js: it doesn\'t wrap WebSocket');
    assertFails(run(buildDir({ 'js/network-guard.js': GUARD.replace('String(u).indexOf("chrome-extension://")===0', 'true') })),
      '[guard/not-installed] js/network-guard.js: a call to an unregistered destination went');
    assertFails(run(buildDir({ 'js/network-guard.js': 'throw new Error("x");' })), '[guard/not-installed] js/network-guard.js: it threw as it ran');
    assertFails(run(buildDir({ 'js/network-guard.js': GUARD.replace('chrome.runtime.sendMessage({type:"NETWORK_REFUSED",report:{surface:"newtab",errorCode:"destination-refused",count:1}});', '') })),
      '[guard/not-installed] js/network-guard.js: it sends the service worker no report of a call it refused');
  });

  it('fails on a file nothing names, and on an import of a bare specifier or a path outside the build', () => {
    assertFails(run(buildDir({ 'assets/stale-G7.js': 'export const s=1;' })), 'check:dist failed: 1 problem in ', '[closure/unreferenced] assets/stale-G7.js: nothing in ');
    assertFails(run(buildDir({ 'assets/trust-E5.js': 'import"valibot";export const t=1;' })),
      'check:dist failed: 1 problem in ', '[closure/missing] assets/trust-E5.js:1:7: An import of "valibot": a bare specifier, which nothing resolves without a bundler or an import map');
    assertFails(run(buildDir({ 'assets/trust-E5.js': 'import"../../outside.js";export const t=1;' })),
      '[closure/missing] ../../outside.js: imported at 1:', 'in assets/trust-E5.js resolves outside the package');
  });

  it('fails on a classic script with syntax only a module parses, which none of it would run past', () => {
    for (const [edits, at] of [
      [{ 'js/lib/fuse.js': 'import"./x.js";var Fuse=1;', 'js/lib/x.js': '' }, '1:1'],
      [{ 'js/lib/fuse.js': 'var Fuse=1;export{Fuse};' }, '1:12'],
      [{ 'js/lib/fuse.js': 'var Fuse=import.meta.url;' }, '1:10'],
    ]) {
      assertFails(run(buildDir(edits)), 'check:dist failed: 1 problem in ',
        `[build/load-mode] js/lib/fuse.js: newtab.html loads it as a classic script at 1:44, but it has an import or export statement or import.meta at ${at}, which only a module parses`);
    }
    // A module script may, and so may a classic script's import()
    assert.equal(run(buildDir({ 'js/lib/fuse.js': 'var Fuse=1;self.later=()=>import("../../assets/trust-E5.js");' })).code, 0);
  });

  it("fails when a page's module preloads and the chunks its module scripts import differ (the bundler writes them, which replaced scripts/module-preloads.js)", () => {
    const newtab = BUILD['newtab.html'].replace('<link rel="modulepreload" crossorigin href="/assets/host-B2.js">', '');
    assert.notEqual(newtab, BUILD['newtab.html']);
    assertFails(run(buildDir({ 'newtab.html': newtab })), 'check:dist failed: 1 problem in ',
      "[closure/preload] newtab.html: doesn't preload assets/host-B2.js, which its module scripts import");
    assertFails(run(buildDir({ 'sidepanel.html': `${BUILD['sidepanel.html']}<link rel="modulepreload" href="/assets/trust-E5.js">` })), 'check:dist failed: 1 problem in ',
      "[closure/preload] sidepanel.html: preloads assets/trust-E5.js, which its module scripts don't import at start");
    // A chunk the page's scripts import through each other counts too
    assertFails(run(buildDir({ 'assets/host-B2.js': 'import"./dep-H8.js";export const h=1;', 'assets/dep-H8.js': '' })), 'check:dist failed: 2 problems in ',
      "[closure/preload] newtab.html: doesn't preload assets/dep-H8.js", "[closure/preload] sidepanel.html: doesn't preload assets/dep-H8.js");
  });

  it('fails on a service worker that loads anything after it starts or waits at its top level, but not on await in a function', () => {
    const result = run(buildDir({
      'js/background.js': `import"./later.js";${BUILD['js/background.js']}self.load=()=>import("./later.js");importScripts("later.js");await Promise.resolve();for await(const x of[]);`,
      'js/later.js': '',
    }));
    assertFails(result, 'check:dist failed: 5 problems in ',
      '[background/not-self-contained] js/background.js:1:1: a static import in the service worker, which can\'t load anything after it starts',
      'import() in the service worker', 'importScripts() in the service worker',
      'top-level await in the service worker, which can\'t load anything after it starts or wait at its top level');
    assert.equal(result.output.match(/\[background\/top-level-await\]/g).length, 2, result.output);
  });

  it('reads the service worker as the module it loads as, so await (x) and await [x] count with no import or export in it', () => {
    // As a script, await (x) parses as a call to a function named await
    const result = run(buildDir({ 'js/background.js': `${BUILD['js/background.js']}await (Promise.resolve());await [1];` }));
    assertFails(result, 'check:dist failed: 2 problems in ');
    assert.equal(result.output.match(/\[background\/top-level-await\]/g).length, 2, result.output);
  });

  it('fails when there is no build to check, and on arguments it doesn\'t take', () => {
    assertFails(run(path.join(buildDir(), 'dist')), 'no build at', 'Run `npm run build` first.');
    const lines = [];
    const options = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
    assert.equal(checkDist.main(['a', 'b'], options), 2);
    assert.equal(checkDist.main(['--write'], options), 2);
    assert.deepEqual(lines, ['usage: node scripts/check-dist.js [dir]', 'usage: node scripts/check-dist.js [dir]']);
  });

  it('no longer lists directories that ship whole: the bundler resolves every import, so a module a context needs is in its chunks (#13 AC7)', () => {
    // A module missing from the sources fails the build itself (build/bundle, the bundle-unresolved fixture)
    assert.deepEqual(Object.keys(checkDist), ['main']);
  });
});
