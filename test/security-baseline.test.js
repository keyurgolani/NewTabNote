'use strict';

// #21 slice 1b, PR 3: the security baseline (scripts/build/security-baseline.js), which the
// build and npm run check:security-baseline run. The manifest, cosmetic keys aside, the
// offscreen document's reasons, the destination registry, the network ledger, and the
// sources that hold the network rules change only with a security/changes.json entry that
// records them, names what changed and says why, and entries only ever get appended. The CSP
// reads as Chromium reads it. security/permissions.json and the manifest agree both ways, the
// required set stays 1.4.0's, externally_connectable stays absent, and 'unsafe-inline' goes
// once #16's counts reach zero.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkSecurityBaseline, checkHistory, recordOf, cspOf, offscreenReasons, firstPartyScripts, SOURCES } = require('../scripts/build/security-baseline.js');
const cli = require('../scripts/check-security-baseline.js');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MANIFEST = JSON.parse(read('manifest.json'));
const SCRIPTS = firstPartyScripts(ROOT);

/** The checker on the tree, with `edits` (a path to its new text) and `manifest` changed */
function check({ manifest = MANIFEST, edits = {} } = {}) {
  const scripts = [...new Set([...SCRIPTS, ...Object.keys(edits).filter((file) => /^js\/.*\.m?js$/.test(file))])].sort();
  const inputs = { manifest, scripts, read: (file) => (Object.hasOwn(edits, file) ? edits[file] : read(file)) };
  return { problems: checkSecurityBaseline(inputs), inputs };
}

/** `manifest` with its extension pages' CSP set to `policy` */
function withPolicy(policy, manifest = MANIFEST) {
  const changed = structuredClone(manifest);
  changed.content_security_policy.extension_pages = policy;
  return changed;
}

const codes = (problems) => [...new Set(problems.map(({ code }) => code))].sort();

/** security/changes.json with an entry recording `inputs` appended, naming `files` */
function withEntry(inputs, { files, issue = 21, rationale = [{ change: 'a change', why: 'a reason' }] } = {}) {
  const changes = JSON.parse(read('security/changes.json'));
  const record = recordOf(inputs);
  const before = changes.entries.at(-1).parts;
  const touched = Object.keys(record.parts).filter((name) => before[name] !== record.parts[name]);
  changes.entries.push({ issue, files: files || touched, rationale, ...record });
  return JSON.stringify(changes);
}

/** That `change` fails as drift without an entry, and passes with one that records it */
function driftsThenPasses(change, expected = ['security/drift']) {
  const without = check(change);
  assert.deepEqual(codes(without.problems), expected, JSON.stringify(without.problems));
  const edits = { ...(change.edits || {}), 'security/changes.json': withEntry(without.inputs) };
  const withIt = check({ ...change, edits });
  assert.deepEqual(codes(withIt.problems), expected.filter((code) => code !== 'security/drift'), JSON.stringify(withIt.problems));
}

describe('the security baseline (scripts/build/security-baseline.js)', () => {
  it('passes on the tree as it is: the latest entry records it', () => {
    assert.deepEqual(check().problems, []);
  });

  it('fails on a CSP change with no entry, and passes with one', () => {
    const manifest = structuredClone(MANIFEST);
    manifest.content_security_policy.extension_pages += ' https://example.test';
    driftsThenPasses({ manifest });
  });

  it('fails on a permission or a host added with no entry, and on its own when security/permissions.json lacks it', () => {
    const permission = structuredClone(MANIFEST);
    permission.permissions.push('tabs');
    driftsThenPasses({ manifest: permission }, ['security/drift', 'security/permissions']);
    const host = structuredClone(MANIFEST);
    host.host_permissions.push('https://example.test/*');
    driftsThenPasses({ manifest: host }, ['security/drift', 'security/permissions']);
  });

  it('fails on externally_connectable, entry or not', () => {
    const manifest = structuredClone(MANIFEST);
    manifest.externally_connectable = { matches: ['https://example.test/*'] };
    driftsThenPasses({ manifest }, ['security/drift', 'security/externally-connectable']);
  });

  it('fails on a destination row or a ledger row added with no entry, and passes with one', () => {
    const registry = JSON.parse(read('security/destinations.json'));
    registry.destinations.push({ ...registry.destinations[0], id: 'example', origin: 'https://example.test' });
    driftsThenPasses({ edits: { 'security/destinations.json': JSON.stringify(registry) } });
    const ledger = JSON.parse(read('security/network-ledger.json'));
    const [listName] = Object.keys(ledger).filter((key) => Array.isArray(ledger[key]));
    ledger[listName].push({ ...ledger[listName][0], line: 9999 });
    driftsThenPasses({ edits: { 'security/network-ledger.json': JSON.stringify(ledger) } });
  });

  it('fails on an edit to each source that holds the network rules with no entry, and passes with one', () => {
    assert.deepEqual(SOURCES, [
      'js/kernel/composition/destinations.js',
      'js/kernel/composition/destination-rows.js',
      'js/kernel/composition/destination-match.js',
      'js/kernel/composition/network-guard.js',
      'js/kernel/composition/network-guard-install.js',
      'js/kernel/composition/network-guard-first.js',
      'js/kernel/composition/api-request.js',
      'js/kernel/composition/worker-network.js',
      'js/offscreen.js',
    ]);
    for (const file of SOURCES) driftsThenPasses({ edits: { [file]: `${read(file)}\n// an edit\n` } });
  });

  it("takes an edit to js/background.js, which installs the worker's network in one call, with no entry", () => {
    assert.deepEqual(check({ edits: { 'js/background.js': `${read('js/background.js')}\n// an edit\n` } }).problems, []);
  });

  it('fails on an offscreen reason added with no entry, and when security/permissions.json lacks it', () => {
    const file = 'js/kernel/composition/worker-network.js';
    const source = read(file).replace("reasons: ['DOM_SCRAPING']", "reasons: ['DOM_SCRAPING', 'BLOBS']");
    assert.deepEqual(offscreenReasons(source).reasons, ['BLOBS', 'DOM_SCRAPING']);
    driftsThenPasses({ edits: { [file]: source } }, ['security/drift', 'security/permissions']);
  });

  it('reads the offscreen reasons wherever a script creates the document, and refuses reasons it can\'t read', () => {
    const elsewhere = `${read('js/popup.js')}\nchrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'x' });\n`;
    driftsThenPasses({ edits: { 'js/popup.js': elsewhere } }, ['security/drift', 'security/permissions']);
    const unread = `${read('js/popup.js')}\nconst reasons = ['CLIPBOARD'];\nchrome.offscreen.createDocument({ url: 'offscreen.html', reasons, justification: 'x' });\n`;
    assert.deepEqual(offscreenReasons(unread), { reasons: [], unread: 1 });
    assert.ok(check({ edits: { 'js/popup.js': unread } }).problems.some((found) => found.code === 'security/permissions' && /reasons/.test(found.message)));
  });

  it('fails on any other manifest key changed with no entry, and takes a cosmetic one', () => {
    const changes = [
      (manifest) => { manifest.content_scripts = [{ matches: ['<all_urls>'], js: ['js/x.js'] }]; },
      (manifest) => { manifest.web_accessible_resources = [{ resources: ['newtab.html'], matches: ['<all_urls>'] }]; },
      (manifest) => { manifest.background.service_worker = 'js/other.js'; },
      (manifest) => { manifest.sandbox = { pages: ['sandbox.html'] }; manifest.content_security_policy.sandbox = "sandbox allow-scripts; script-src 'self'"; },
    ];
    for (const change of changes) {
      const manifest = structuredClone(MANIFEST);
      change(manifest);
      driftsThenPasses({ manifest });
    }
    const cosmetic = structuredClone(MANIFEST);
    Object.assign(cosmetic, { name: 'Another name', short_name: 'x', description: 'Another description', version: '9.9.9', version_name: '9.9.9 beta' });
    cosmetic.icons = { 16: 'icons/other.png' };
    assert.deepEqual(check({ manifest: cosmetic }).problems, []);
  });

  it('reads the CSP as Chromium does: a repeated directive fails, entry or not, and only its first copy counts', () => {
    const policy = MANIFEST.content_security_policy.extension_pages;
    for (const first of ['connect-src *', "script-src 'self' 'unsafe-eval'"]) {
      const manifest = withPolicy(`${first}; ${policy}`);
      const [name] = first.split(' ');
      assert.deepEqual(cspOf(manifest)[name], first.split(' ').slice(1).sort());
      driftsThenPasses({ manifest }, ['security/csp-repeated', 'security/drift']);
    }
    // A later copy, in any case, changes nothing Chromium enforces, and still fails
    const later = withPolicy(`${policy}; CONNECT-SRC *`);
    assert.deepEqual(cspOf(later), cspOf(MANIFEST));
    assert.deepEqual(codes(check({ manifest: later }).problems), ['security/csp-repeated']);
  });

  it("reads the policy's characters as Chromium does: only ASCII whitespace separates, and anything else unprintable fails", () => {
    const policy = MANIFEST.content_security_policy.extension_pages;
    for (const space of ['\u00a0', '\u2003', '\u3000', '\ufeff']) {
      const manifest = withPolicy(policy.replace("form-action 'none'", `form-action${space}'none'`));
      assert.equal(cspOf(manifest)['form-action'], undefined, JSON.stringify(space));
      driftsThenPasses({ manifest }, ['security/csp-characters', 'security/drift']);
    }
    // A control character, and a directive name Chromium doesn't read as one
    for (const changed of [policy.replace("base-uri 'none'", "base-uri\u0000'none'"), policy.replace("base-uri 'none'", "base_uri 'none'")]) {
      const manifest = withPolicy(changed);
      assert.equal(cspOf(manifest)['base-uri'], undefined, JSON.stringify(changed.slice(0, 40)));
      driftsThenPasses({ manifest }, ['security/csp-characters', 'security/drift']);
    }
    // Tabs, line feeds, form feeds and carriage returns are ASCII whitespace, and read as spaces
    const spaced = withPolicy(policy.replace("form-action 'none'", "form-action\t'none'").replace("base-uri 'none'", "\r\nbase-uri\f'none'"));
    assert.deepEqual(cspOf(spaced), cspOf(MANIFEST));
    assert.deepEqual(check({ manifest: spaced }).problems, []);
  });

  it('compares hash and nonce sources with their case, and keywords, schemes and hosts without', () => {
    assert.deepEqual(cspOf(withPolicy("SCRIPT-SRC 'SELF' 'SHA256-AbC=' 'nonce-XyZ' HTTPS: HTTPS://Example.TEST/Path Example.TEST/Other *.Example.test")), {
      'script-src': ["'nonce-XyZ'", "'self'", "'sha256-AbC='", '*.example.test', 'example.test/Other', 'https:', 'https://example.test/Path'],
    });
    const policy = MANIFEST.content_security_policy.extension_pages.replace("script-src 'self'", "script-src 'self' 'sha256-AbC='");
    const { inputs } = check({ manifest: withPolicy(policy) });
    const recorded = withEntry(inputs);
    assert.deepEqual(check({ manifest: withPolicy(policy), edits: { 'security/changes.json': recorded } }).problems, []);
    const recased = withPolicy(policy.replace("'sha256-AbC='", "'sha256-abc='"));
    assert.deepEqual(codes(check({ manifest: recased, edits: { 'security/changes.json': recorded } }).problems), ['security/drift']);
    const keyword = withPolicy(policy.replace("script-src 'self'", "script-src 'SELF'"));
    assert.deepEqual(check({ manifest: keyword, edits: { 'security/changes.json': recorded } }).problems, []);
  });

  it("fails on an entry that doesn't name a part it changes, its issue, or why", () => {
    const manifest = structuredClone(MANIFEST);
    manifest.content_security_policy.extension_pages += ' https://example.test';
    const { inputs } = check({ manifest });
    for (const entry of [{ files: [] }, { issue: 0 }, { rationale: [] }, { rationale: [{ change: 'x' }] }]) {
      const problems = check({ manifest, edits: { 'security/changes.json': withEntry(inputs, entry) } }).problems;
      assert.deepEqual(codes(problems), ['security/drift'], JSON.stringify(entry));
    }
  });

  it("fails on a file in security/ that doesn't read as its shape", () => {
    assert.deepEqual(codes(check({ edits: { 'security/changes.json': 'not json' } }).problems), ['security/file']);
    assert.deepEqual(codes(check({ edits: { 'security/changes.json': '{"entries": []}' } }).problems), ['security/file']);
    assert.deepEqual(codes(check({ edits: { 'security/permissions.json': '{}' } }).problems), ['security/file']);
  });

  it("fails once #16's counts of style attributes and <style> blocks reach zero while style-src allows 'unsafe-inline'", () => {
    const design = JSON.parse(read('test/fixtures/design-token-baseline.json'));
    assert.ok(Object.values(design.files).some((counts) => counts['style-attribute'] > 0), 'today some are left');
    for (const counts of Object.values(design.files)) {
      delete counts['style-attribute'];
      delete counts['inline-style-block'];
    }
    const edits = { 'test/fixtures/design-token-baseline.json': JSON.stringify(design) };
    assert.deepEqual(codes(check({ edits }).problems), ['security/unsafe-inline']);
    const manifest = structuredClone(MANIFEST);
    manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(" 'unsafe-inline'", '');
    assert.deepEqual(codes(check({ manifest, edits }).problems), ['security/drift'], 'taken out, the CSP change needs its entry, and nothing else fails');
  });
});

describe('security/changes.json only grows (checkHistory)', () => {
  const current = read('security/changes.json');
  const parsed = JSON.parse(current);
  const appended = () => {
    const changes = structuredClone(parsed);
    changes.entries.push({ ...changes.entries[0], summary: 'a later entry' });
    return JSON.stringify(changes);
  };

  it('takes the file as the base has it, the same with entries appended, and a base with no file', () => {
    assert.deepEqual(checkHistory({ current, base: current }), []);
    assert.deepEqual(checkHistory({ current: appended(), base: current }), []);
    assert.deepEqual(checkHistory({ current, base: null }), []);
  });

  it('fails on an earlier entry rewritten or taken out', () => {
    const rewritten = structuredClone(parsed);
    rewritten.entries[0].digest = '0'.repeat(64);
    assert.deepEqual(codes(checkHistory({ current: JSON.stringify(rewritten), base: current })), ['security/history']);
    const removed = { ...parsed, entries: [] };
    assert.deepEqual(codes(checkHistory({ current: JSON.stringify(removed), base: current })), ['security/history']);
    assert.deepEqual(codes(checkHistory({ current, base: appended() })), ['security/history']);
  });

  it("compares with a git ref's copy: in CI it fails when it can't read the ref, and locally it says so", () => {
    const lines = [];
    const io = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
    // HEAD's copy reads; whether this tree keeps its entries is checkHistory's, above
    cli.main(['--history-only', '--base', 'HEAD'], { ...io, env: {} });
    assert.doesNotMatch(lines.join('\n'), /can't read/);
    assert.equal(typeof cli.baseCopy('HEAD', ROOT).text, 'string');
    lines.length = 0;
    assert.equal(cli.main(['--history-only', '--base', 'refs/heads/ntn-no-such-ref'], { ...io, env: { CI: 'true' } }), 1, lines.join('\n'));
    assert.match(lines.join('\n'), /can't read/);
    lines.length = 0;
    assert.equal(cli.main(['--history-only', '--base', 'refs/heads/ntn-no-such-ref'], { ...io, env: {} }), 0, lines.join('\n'));
    assert.match(lines.join('\n'), /can't read/);
    lines.length = 0;
    assert.equal(cli.main(['--history-only'], { ...io, env: { CI: 'true' } }), 1, lines.join('\n'));
  });
});

describe('npm run check:security-baseline -- --base, on a git repository', () => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');

  /** A repository holding this tree's security/changes.json at HEAD, and a build dir with the manifest */
  function repository() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-history-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=ntn', '-c', 'user.email=ntn@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    fs.mkdirSync(path.join(dir, 'security'));
    fs.writeFileSync(path.join(dir, 'security', 'changes.json'), read('security/changes.json'));
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    return dir;
  }
  const run = (argv, root, env = { CI: 'true' }) => {
    const lines = [];
    const code = cli.main(argv, { log: (line) => lines.push(line), error: (line) => lines.push(line), env, root });
    return { code, text: lines.join('\n') };
  };

  it('fails on a committed entry rewritten, and passes once it is restored', () => {
    const dir = repository();
    try {
      const file = path.join(dir, 'security', 'changes.json');
      const kept = fs.readFileSync(file, 'utf8');
      assert.equal(run(['--history-only', '--base', 'HEAD'], dir).code, 0);
      const rewritten = JSON.parse(kept);
      rewritten.entries[0].summary = 'rewritten';
      fs.writeFileSync(file, JSON.stringify(rewritten));
      const failed = run(['--history-only', '--base', 'HEAD'], dir);
      assert.equal(failed.code, 1, failed.text);
      assert.match(failed.text, /security\/history/);
      fs.writeFileSync(file, kept);
      assert.equal(run(['--history-only', '--base', 'HEAD'], dir).code, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with --print, still fails on the history', () => {
    const dir = repository();
    try {
      const file = path.join(dir, 'security', 'changes.json');
      const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
      rewritten.entries[0].summary = 'rewritten';
      fs.writeFileSync(file, JSON.stringify(rewritten));
      fs.mkdirSync(path.join(dir, 'dist'));
      fs.writeFileSync(path.join(dir, 'dist', 'manifest.json'), JSON.stringify(MANIFEST));
      for (const file of [...SOURCES, 'security/destinations.json', 'security/network-ledger.json']) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
      }
      const printed = run([path.join(dir, 'dist'), '--print', '--base', 'HEAD'], dir);
      assert.equal(printed.code, 1, printed.text);
      assert.match(printed.text, /"digest"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells a base with no file from one git can't read, and in CI fails on the second", () => {
    const answers = (lsTree) => (args) => {
      if (args[0] === 'rev-parse') return 'abc\n';
      if (args[0] === 'ls-tree') return lsTree();
      if (args[0] === 'show') return '{"entries": []}';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    assert.deepEqual(cli.baseCopy('HEAD', ROOT, answers(() => '')), { text: null });
    assert.deepEqual(cli.baseCopy('HEAD', ROOT, answers(() => 'security/changes.json\n')), { text: '{"entries": []}' });
    assert.ok('unreadable' in cli.baseCopy('HEAD', ROOT, answers(() => { throw new Error('fatal: bad object'); })));
  });
});

describe('security/permissions.json', () => {
  const declared = JSON.parse(read('security/permissions.json'));

  it('lists each permission, host and offscreen reason with its issue, warning, request point and rationale, and the manifest asks for exactly those', () => {
    assert.deepEqual(declared.permissions.map((entry) => entry.name).sort(), [...MANIFEST.permissions].sort());
    assert.deepEqual(declared.hosts.map((entry) => entry.pattern).sort(), [...MANIFEST.host_permissions].sort());
    assert.deepEqual(declared.offscreenReasons.map((entry) => entry.reason), offscreenReasons(read('js/kernel/composition/worker-network.js')).reasons);
    for (const entry of [...declared.permissions, ...declared.hosts]) {
      assert.ok(Number.isSafeInteger(entry.issue) && entry.rationale.length > 10 && entry.requestedAt === 'install' && entry.required === true, JSON.stringify(entry));
    }
    // A field missing from an entry fails
    const broken = structuredClone(declared);
    delete broken.permissions[0].rationale;
    assert.deepEqual(codes(check({ edits: { 'security/permissions.json': JSON.stringify(broken) } }).problems), ['security/permissions']);
    // And so does an entry the manifest doesn't ask for
    const extra = structuredClone(declared);
    extra.permissions.push({ ...declared.permissions[0], name: 'tabs' });
    assert.deepEqual(codes(check({ edits: { 'security/permissions.json': JSON.stringify(extra) } }).problems), ['security/permissions']);
  });

  it("keeps the required set 1.4.0's, so no install warning is new, and externally_connectable absent", () => {
    const release = JSON.parse(read('test/fixtures/security/manifest-1.4.0-permissions.json'));
    assert.equal(release.version, '1.4.0');
    assert.deepEqual(declared.permissions.filter((entry) => entry.required).map((entry) => entry.name).sort(), [...release.permissions].sort());
    assert.deepEqual(declared.hosts.filter((entry) => entry.required).map((entry) => entry.pattern).sort(), [...release.host_permissions].sort());
    assert.deepEqual([...(MANIFEST.optional_permissions || []), ...(MANIFEST.optional_host_permissions || [])], []);
    assert.equal(declared.externallyConnectable, false);
    assert.equal(Object.hasOwn(MANIFEST, 'externally_connectable'), false);
  });
});

describe("the extension pages' CSP (manifest.json)", () => {
  const csp = cspOf(MANIFEST);

  it('writes out what default-src would block, and allows no more than the pages use', () => {
    assert.deepEqual(csp['default-src'], ["'self'"]);
    assert.deepEqual(csp['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
    assert.deepEqual(csp['object-src'], ["'none'"]);
    assert.deepEqual(csp['base-uri'], ["'none'"]);
    assert.deepEqual(csp['form-action'], ["'none'"]);
    assert.deepEqual(csp['frame-src'], ['https://player.vimeo.com', 'https://www.youtube.com']);
    assert.deepEqual(csp['img-src'], ["'self'", 'blob:', 'data:', 'http:', 'https:']);
    assert.deepEqual(csp['style-src'], ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(csp['font-src'], ["'self'", 'data:']);
    assert.deepEqual(csp['media-src'], ["'self'", 'blob:', 'data:']);
  });

  it("reaches the registry's fetch origins and loopback in connect-src, and nothing wider: no remote WebDAV server", () => {
    const registry = JSON.parse(read('security/destinations.json')).destinations;
    const remote = [...new Set(registry.filter((row) => row.reachedBy === 'fetch' && row.location === 'remote').map((row) => row.origin))];
    const sources = csp['connect-src'];
    assert.deepEqual(sources.filter((source) => source.startsWith('https:')).sort(), [...remote].sort());
    assert.ok(sources.includes('http://localhost:*') && sources.includes('http://127.0.0.1:*'));
    assert.ok(!sources.some((source) => ['https:', 'https://*', '*', 'http:'].includes(source)), sources.join(' '));
  });
});

describe("the rows the built page guard inlines (scripts/build/guard.js's checkGuardRows)", () => {
  const { checkGuardRows } = require('../scripts/build/guard.js');
  const { fromMap } = require('../scripts/build/package-files.js');
  /** @type {any} */
  let match;
  /** @type {any} */
  let client;
  before(async () => {
    match = await import('../js/kernel/composition/destination-match.js');
    client = await import('../js/kernel/composition/destinations.js');
  });
  const guardWith = (literal) => fromMap(new Map([['js/network-guard.js', `(function(){var R=${literal};self.x=R})();`]]), 'the build');
  const minified = (json) => json.replace(/"([A-Za-z]+)":/g, '$1:');

  it("takes the validated registry's rows, as the bundler writes them, quoted or not", async () => {
    const json = JSON.stringify(match.compactRows(match.guardRows(client.DESTINATIONS)));
    assert.deepEqual(await checkGuardRows(guardWith(json), ROOT), []);
    assert.deepEqual(await checkGuardRows(guardWith(minified(json)), ROOT), []);
  });

  it("fails on a row added, changed or taken out, and on rows it can't find once", async () => {
    const rows = match.guardRows(client.DESTINATIONS);
    const variants = [
      [...rows, { ...rows[0], origin: 'https://example.test' }],
      rows.map((row, i) => (i === 0 ? { ...row, methods: [...row.methods, 'PUT'] } : row)),
      rows.slice(1),
    ];
    for (const variant of variants) {
      assert.deepEqual(codes(await checkGuardRows(guardWith(minified(JSON.stringify(match.compactRows(variant)))), ROOT)), ['guard/rows']);
    }
    const json = minified(JSON.stringify(match.compactRows(rows)));
    assert.deepEqual(codes(await checkGuardRows(guardWith('null'), ROOT)), ['guard/rows']);
    assert.deepEqual(codes(await checkGuardRows(guardWith(`[${json},${json}]`), ROOT)), ['guard/rows']);
  });
});
