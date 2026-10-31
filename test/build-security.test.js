'use strict';

// #27 AC6 and AC9: the remote-code scan, the CSP check, and the environment check
// (scripts/build/), on the package the build lists describe and on small packages, and the
// canary scan npm run verify:fixtures runs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkRemoteCode, remoteOccurrences, readAllowlist: readRemoteAllowlist, isExecutable } = require('../scripts/build/remote-code.js');
const { checkCsp, checkPolicy, checkPages, checkDynamicCode, readAllowlist: readCspAllowlist } = require('../scripts/build/csp.js');
const { ALLOWED, checkEnvironment, canaryLeaks } = require('../scripts/build/environment.js');
const { writeZip } = require('../scripts/build/zip.js');
const { sourcePackage, packageOf, ROOT } = require('./helpers/source-package.js');

const NONE = { vendored: new Set() };

/** The codes and subjects a check reported, sorted */
function found(problems) {
  return problems.map(({ code, subject }) => `${code} ${subject}`).sort();
}

describe('the remote-code scan (AC6)', () => {
  it('passes the package the build lists describe, with its one allowlisted occurrence', () => {
    assert.deepEqual(checkRemoteCode(sourcePackage()), []);
    assert.deepEqual(remoteOccurrences(sourcePackage()).map(({ file, url, context }) => [file, url, context]), [
      ['js/lib/transformers.js', 'https://cdn.jsdelivr.net/npm/@xenova/transformers@${...}/dist/', 'wasmPaths'],
    ]);
  });

  it('only shrinks: build/remote-allowlist.json holds no row but the WASM default #9 removes', () => {
    const pinned = [['js/lib/transformers.js', 'https://cdn.jsdelivr.net/npm/@xenova/transformers@${...}/dist/', 'wasmPaths', 9]];
    for (const row of readRemoteAllowlist()) {
      assert.ok(pinned.some(([file, url, context, issue]) => row.file === file && row.url === url && row.context === context && row.issue === issue),
        `build/remote-allowlist.json has a new row (${row.file} ${row.url}); the list only shrinks`);
      assert.ok(row.count === 1 && row.reason.length > 20, `${row.url} keeps its count of 1 and a reason`);
    }
  });

  it('fails on remote code given to import, importScripts, new Worker, and wasmPaths, a remote .js, .mjs, or .wasm URL, and a page loading code from a host', () => {
    const pkg = packageOf({
      'a.js': [
        "import x from 'https://esm.example.test/x';",
        "import('https://cdn.example.test/m');",
        "importScripts('https://cdn.example.test/w');",
        "new Worker('//cdn.example.test/worker.js');",
        "ort.env.wasm.wasmPaths = 'https://cdn.example.test/ort/';",
        "const options = { wasmPaths: `https://cdn.example.test/${version}/` };",
        "const runtime = 'see https://cdn.example.test/runtime.wasm';",
        "const module = 'https://cdn.example.test/lib.mjs?v=1';",
      ].join('\n'),
      'page.html': '<script src="https://cdn.example.test/a.js"></script><link rel="modulepreload" href="https://cdn.example.test/b">',
    });
    assert.deepEqual(remoteOccurrences(pkg).map(({ file, context }) => `${file} ${context}`), [
      'a.js import', 'a.js import', 'a.js importScripts', 'a.js Worker', 'a.js wasmPaths', 'a.js wasmPaths', 'a.js url', 'a.js url',
      'page.html <script src>', 'page.html <link href>',
    ]);
    assert.equal(checkRemoteCode(pkg, { allowlist: [] }).length, 10);
    assert.ok(checkRemoteCode(pkg, { allowlist: [] }).every(({ code }) => code === 'remote-code/url'));
  });

  it('leaves links, comments, and documentation URLs alone', () => {
    const pkg = packageOf({
      'a.js': [
        '// https://cdn.example.test/in-a-comment.js',
        "const docs = 'https://github.com/xenova/transformers.js/issues/new/choose';",
        "const page = 'https://example.test/page';",
        "const regex = '// not a url.js';",
      ].join('\n'),
      'page.html': '<a href="https://example.test/guide">guide</a><script src="js/local.js"></script>',
    });
    assert.deepEqual(remoteOccurrences(pkg), []);
    assert.equal(isExecutable('https://x.test/a.js#y'), true);
    assert.equal(isExecutable('https://x.test/transformers.js/issues'), false);
  });

  it('a row covers its count, and a row with more than the package holds fails as stale', () => {
    const pkg = packageOf({ 'a.js': "importScripts('https://cdn.example.test/w');" });
    const row = { file: 'a.js', url: 'https://cdn.example.test/w', context: 'importScripts', count: 1, reason: 'test', issue: 1 };
    assert.deepEqual(checkRemoteCode(pkg, { allowlist: [row] }), []);
    assert.deepEqual(found(checkRemoteCode(pkg, { allowlist: [{ ...row, count: 2 }] })), ['remote-code/stale-row a.js']);
    assert.deepEqual(found(checkRemoteCode(packageOf({ 'a.js': '' }), { allowlist: [row] })), ['remote-code/stale-row a.js']);
  });
});

describe('the CSP check (AC6)', () => {
  it('passes the package the build lists describe: today\'s policy, no inline script or handler, and only reviewed third-party dynamic code', () => {
    assert.deepEqual(checkCsp(sourcePackage()), []);
  });

  it('each build/csp-allowlist.json row is pinned to its file\'s SHA-256 and names its package and reason', () => {
    const vendor = JSON.parse(fs.readFileSync(path.join(ROOT, 'js/lib/vendor.json'), 'utf8'));
    for (const row of readCspAllowlist()) {
      const record = vendor.files[row.file.replace(/^js\/lib\//, '')];
      assert.ok(record, row.file);
      assert.equal(row.sha256, record.sha256, `${row.file}'s row is for another version`);
      assert.equal(row.package, record.package);
      assert.equal(row.version, record.version);
      assert.ok(['no-eval', 'no-new-func', 'no-implied-eval'].includes(row.rule));
      assert.ok(row.reason.length > 40, `${row.file} ${row.rule} has a reason`);
    }
  });

  it('fails on a policy that allows eval, inline code, or another host for scripts', () => {
    const manifest = (policy) => packageOf({ 'manifest.json': JSON.stringify({ content_security_policy: { extension_pages: policy } }) });
    assert.deepEqual(checkPolicy(manifest("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'")), []);
    assert.deepEqual(checkPolicy(packageOf({ 'manifest.json': '{}' })), []);
    for (const policy of ["script-src 'self' 'unsafe-eval'", "script-src 'self' 'unsafe-inline'", "script-src 'self' https://cdn.example.test", "object-src *"]) {
      assert.deepEqual(found(checkPolicy(manifest(policy))), ['csp/policy manifest.json'], policy);
    }
  });

  it('fails on inline scripts, inline handlers, and javascript: URLs, and allows data blocks', () => {
    const pkg = packageOf({
      'a.html': '<script>run()</script><script type="module">run()</script><script type="importmap">{}</script>',
      'b.html': '<button onclick="go()">Go</button><a href="javascript:go()">go</a>',
      'c.html': '<script type="application/json">{"a": 1}</script><script src="js/a.js"></script><!-- <script>old()</script> -->',
    });
    assert.deepEqual(found(checkPages(pkg)), [
      'csp/inline-handler b.html:1:1',
      'csp/inline-handler b.html:1:35',
      'csp/inline-script a.html:1:1',
      'csp/inline-script a.html:1:23',
      'csp/inline-script a.html:1:59',
    ]);
  });

  it('fails an inline script of any type but a JSON data block', () => {
    // #89's review: text/ecmascript isn't on a list of JavaScript types, and it runs
    const scripts = [
      '<script type="text/ecmascript">1</script>',
      '<script type=" TEXT/JavaScript ">2</script>',
      '<script type="text/plain">3</script>',
      '<script type="application/ld+json">{}</script>',
      '<script type="application/json">{}</script>',
      '<script type="module"></script>',
    ];
    const html = scripts.join('');
    const at = (/** @type {number} */ i) => `csp/inline-script d.html:1:${html.indexOf(scripts[i]) + 1}`;
    assert.deepEqual(found(checkPages(packageOf({ 'd.html': html }))), [at(0), at(1), at(2)].sort());
  });

  it('fails on the Function constructor reached through the global object or a function\'s constructor', () => {
    // #89's review: ESLint's no-new-func knows only the bare global
    const lines = [
      'new self.Function("x");',
      'new globalThis.Function("x");',
      'window.Function("x")();',
      '(() => {}).constructor("x")();',
      '(function () {}).constructor("x");',
      'new (async () => {}).constructor("x");',
      'thing.constructor("fine");',
    ];
    const problems = checkDynamicCode(packageOf({ 'js/b.js': lines.join('\n') }), { allowlist: [], ...NONE });
    assert.deepEqual(problems.map(({ code, subject, message }) => `${code} ${subject} ${message.split(':')[0]}`), [1, 2, 3, 4, 5, 6].map((line) => `csp/dynamic-code js/b.js:${line}:1 no-new-func`));
  });

  it('fails on first-party eval, the Function constructor, and string timers, wherever they reach the global', () => {
    const pkg = packageOf({
      'js/a.js': [
        'eval("1");',
        'window.eval("1");',
        'new Function("return 1");',
        'Function("return 1");',
        'setTimeout("tick()", 10);',
        'window.setInterval("tick()", 10);',
        'setTimeout(tick, 10);',
        'function later(setTimeout) { return setTimeout("not the global one"); }',
      ].join('\n'),
      'js/m.mjs': "export const run = () => setTimeout('tick()', 1);",
    });
    const problems = checkDynamicCode(pkg, { allowlist: [], ...NONE });
    assert.ok(problems.every(({ code }) => code === 'csp/dynamic-code'));
    assert.deepEqual(problems.map(({ subject, message }) => `${subject} ${message.split(':')[0]}`), [
      'js/a.js:1:1 no-eval',
      'js/a.js:2:8 no-eval',
      'js/a.js:3:1 no-new-func',
      'js/a.js:4:1 no-new-func',
      'js/a.js:5:1 no-implied-eval',
      'js/a.js:6:1 no-implied-eval',
      'js/m.mjs:1:26 no-implied-eval',
    ]);
  });

  it('a vendored file\'s occurrences need a row with its SHA-256 and count, and a stale row fails', () => {
    const text = 'var g = new Function("return this")();';
    const pkg = packageOf({ 'js/lib/x.js': text });
    const vendored = new Set(['js/lib/x.js']);
    const sha256 = require('node:crypto').createHash('sha256').update(text).digest('hex');
    const row = { file: 'js/lib/x.js', package: 'x', version: '1.0.0', sha256, rule: 'no-new-func', count: 1, reason: 'test' };
    assert.deepEqual(checkDynamicCode(pkg, { allowlist: [row], vendored }), []);
    assert.deepEqual(found(checkDynamicCode(pkg, { allowlist: [], vendored })), ['csp/third-party js/lib/x.js:1:9']);
    assert.deepEqual(found(checkDynamicCode(pkg, { allowlist: [{ ...row, count: 2 }], vendored })), ['csp/third-party js/lib/x.js']);
    assert.deepEqual(found(checkDynamicCode(pkg, { allowlist: [{ ...row, sha256: '0'.repeat(64) }], vendored })), ['csp/third-party js/lib/x.js']);
    assert.deepEqual(found(checkDynamicCode(pkg, { allowlist: [row, { ...row, rule: 'no-eval' }], vendored })), ['csp/third-party js/lib/x.js']);
  });
});

describe('the environment check (AC9)', () => {
  it('passes the package the build lists describe, where js/core/logger.js reads only process.env.NODE_ENV', () => {
    assert.deepEqual(checkEnvironment(sourcePackage()), []);
  });

  it('allows process.env.NODE_ENV, behind a process.env guard or not, in any first-party file, and nothing else', () => {
    assert.deepEqual([...ALLOWED], ['NODE_ENV'], 'NODE_ENV is the one allowlisted variable');
    const allowed = packageOf({
      'js/core/logger.js': "function dev() { return typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production'; }",
      'js/other.js': "export const production = process.env.NODE_ENV === 'production';",
      'js/lib/vendored.js': 'var key = process.env.HF_TOKEN;',
    });
    assert.deepEqual(checkEnvironment(allowed, { vendored: new Set(['js/lib/vendored.js']) }), []);

    const refused = packageOf({
      'js/a.js': [
        'const key = process.env.API_KEY;',
        'const named = process.env[name];',
        'send(process.env);',
        'const env = ok && process.env;',
        "const mode = import.meta.env.MODE;",
      ].join('\n'),
    });
    assert.deepEqual(checkEnvironment(refused, NONE).map(({ code, subject, message }) => `${code} ${subject} ${message.split(' in ')[0]}`), [
      'env/reference js/a.js:1:13 process.env.API_KEY',
      'env/reference js/a.js:2:15 process.env[...]',
      'env/reference js/a.js:3:6 process.env',
      'env/reference js/a.js:4:19 process.env',
      'env/reference js/a.js:5:14 import.meta.env',
    ]);
  });

  it('fails on process.env through the global object, import.meta[\'env\'], and process read on its own', () => {
    // #89's review: each of these read the environment and passed
    const refused = packageOf({
      'js/c.js': [
        'const a = globalThis.process.env.X;',
        "const b = import.meta['env'];",
        'const p = process; const c = p.env.X;',
        'const d = self.process.env.NODE_ENV;',
        "const e = typeof process !== 'undefined';",
      ].join('\n'),
    });
    assert.deepEqual(checkEnvironment(refused, NONE).map(({ code, subject, message }) => `${code} ${subject} ${message.split(' in ')[0]}`), [
      'env/reference js/c.js:1:11 process.env.X',
      'env/reference js/c.js:2:11 import.meta.env',
      'env/reference js/c.js:3:11 process',
    ]);
  });
});

describe('the canary scan (AC9)', () => {
  const canary = 'ntn-canary-0123456789abcdef';

  it('finds the canary in a log, a build file, and a zip entry, deflated or not', () => {
    const files = packageOf({ 'js/a.js': `const leaked = "${canary}";`, 'js/b.js': 'clean' });
    const zip = writeZip([{ path: 'js/a.js', data: Buffer.from(`x${canary}y`.repeat(20)) }], { sourceDateEpoch: 1_700_000_000 });
    // Deflated, the canary isn't in the zip's raw bytes; read back, it is
    assert.equal(zip.includes(Buffer.from(canary)), false);
    assert.deepEqual(found(canaryLeaks(canary, { logs: { 'the build log': `ok\n${canary}\n`, 'the package log': 'ok' }, files, zip })), [
      'env/canary js/a.js',
      'env/canary the build log',
      "env/canary the zip's js/a.js",
    ]);
  });

  it('passes clean output, and refuses a canary short enough to turn up by chance', () => {
    const zip = writeZip([{ path: 'a.js', data: Buffer.from('clean') }], { sourceDateEpoch: 1_700_000_000 });
    assert.deepEqual(canaryLeaks(canary, { logs: { log: 'nothing here' }, files: packageOf({ 'a.js': '' }), zip }), []);
    assert.throws(() => canaryLeaks('short', {}), /at least 16 characters/);
  });
});
