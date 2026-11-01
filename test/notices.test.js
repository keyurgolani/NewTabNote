'use strict';

// AC8 and AC9: scripts/check-notices.js (run by `npm run check:notices` after
// `npm run package`) and the repository files it checks.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const JSZip = require('../js/lib/jszip.min.js');
const {
  REQUIRED_DESTINATIONS, vendoredFiles, shippedFiles, policyPermissions, checkPolicy, checkLibReadme, checkZip, checkBundledNotices,
} = require('../scripts/check-notices.js');
const { fromMap } = require('../scripts/build/package-files.js');
const { excerpt, MARKERS } = require('../scripts/ci/failure-excerpt.js');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const policy = read('PRIVACY_POLICY.md');

/** Valibot's code as terser leaves it in a chunk: its Standard Schema object and a "~run" call */
const VALIBOT = 'function $(e){return e["~standard"]={version:1,vendor:"valibot",validate:t=>e["~run"]({value:t},S())},e}';
// A piece of the named character references as #14's entities.js packs them, which only the
// new tab's workspace chunk carries
const ENTITIES = 'const k=["ClockwiseContourIntegral:1,CounterClockwiseContourIntegral:1"].join(",");';
/**
 * The chunks the bundler folds Valibot into, the pages' shared trust chunk and the service
 * worker, and the new tab's workspace chunk, which holds #14's table
 */
const CHUNKS = { 'assets/trust-YdWbqFjr.js': `${VALIBOT}export{$ as t};`, 'js/background.js': `${VALIBOT}self.ntn=1;`, 'assets/newtab-D3k5NAfy.js': 'import"./trust-YdWbqFjr.js";', 'assets/workspace-Q7bL2xVe.js': ENTITIES };

/** A zip laid out like the package, built from the repository files and CHUNKS. */
async function packageZip({ omit = [], replace = {} } = {}) {
  const zip = new JSZip();
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES', 'manifest.json']) {
    if (!omit.includes(name)) zip.file(name, replace[name] ?? fs.readFileSync(path.join(ROOT, name)));
  }
  for (const name of shippedFiles()) {
    const entry = `js/lib/${name}`;
    if (!omit.includes(entry)) zip.file(entry, replace[entry] ?? fs.readFileSync(path.join(ROOT, entry)));
  }
  for (const [name, text] of Object.entries(CHUNKS)) {
    if (!omit.includes(name)) zip.file(name, replace[name] ?? text);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Package files from the repository's notices and `files` */
const filesOf = (files, notices = read('THIRD_PARTY_NOTICES')) => fromMap(new Map(Object.entries({ THIRD_PARTY_NOTICES: notices, ...files })
  .map(([name, text]) => [name, Buffer.from(text)])), 'the package');

describe('privacy policy (AC9)', () => {
  it('lists exactly the manifest permissions, describes the hosts, and names every network destination', () => {
    assert.deepEqual(policyPermissions(policy).names.sort(), [...manifest.permissions].sort());
    assert.deepEqual(checkPolicy(policy, manifest), []);
  });

  it('is updated and no longer claims a wildcard host permission', () => {
    assert.doesNotMatch(policy, /https:\/\/_\/_/);
    assert.match(policy, /\*\*Last Updated: October 31, 2026\*\*/);
    assert.match(policy, /leave out trash, themes, version history, AI chat history, and settings/);
  });

  it('flags a missing permission, an extra one, and a malformed bullet', () => {
    const edited = policy
      .replace(/^- \*\*sidePanel\*\*:.*$/m, '- **tabs**: Not requested')
      .replace(/^- \*\*notifications\*\*:.*$/m, '- notifications: no bold name');
    assert.deepEqual(checkPolicy(edited, manifest), [
      'PRIVACY_POLICY.md permission bullet isn\'t "- **<permission>**: <use>": - notifications: no bold name',
      'PRIVACY_POLICY.md doesn\'t list the "notifications" permission',
      'PRIVACY_POLICY.md doesn\'t list the "sidePanel" permission',
      'PRIVACY_POLICY.md lists "tabs", which manifest.json doesn\'t request',
    ]);
  });

  it("takes the destinations the policy has to name from the registry, so a row added is one more it names", () => {
    const { policyDestinations } = require('../scripts/check-notices.js');
    const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'security', 'destinations.json'), 'utf8')).destinations;
    assert.deepEqual(REQUIRED_DESTINATIONS, policyDestinations(rows));
    const added = policyDestinations([...rows, { ...rows.find((row) => row.location === 'remote' && row.reachedBy === 'fetch'), id: 'example', origin: 'https://example.test' }]);
    assert.deepEqual(added.filter((name) => !REQUIRED_DESTINATIONS.includes(name)), ['example.test']);
  });

  it('flags each missing network destination and undescribed host', () => {
    for (const destination of REQUIRED_DESTINATIONS) {
      const problems = checkPolicy(policy.split(destination).join('[removed]'), manifest);
      assert.ok(problems.includes(`PRIVACY_POLICY.md doesn't name the network destination ${destination}`), destination);
    }
    const withoutOpenAI = policy.split('api.openai.com').join('[removed]');
    assert.ok(checkPolicy(withoutOpenAI, manifest)
      .includes("PRIVACY_POLICY.md doesn't describe the host permission https://api.openai.com/*"));
  });
});

describe('js/lib/README.md (AC9)', () => {
  it('gives each js/lib file a license and points to THIRD_PARTY_NOTICES', () => {
    const readme = read('js/lib/README.md');
    assert.deepEqual(checkLibReadme(readme, vendoredFiles()), []);
    assert.match(readme, /THIRD_PARTY_NOTICES/);
  });

  it('flags a file without a license entry', () => {
    const readme = read('js/lib/README.md').replace(/^\| `fuse\.js`.*$/m, '');
    assert.deepEqual(checkLibReadme(readme, vendoredFiles()), ['js/lib/README.md has no row for fuse.js']);
  });

  it('a directory row covers the files under it, and only those', () => {
    const readme = read('js/lib/README.md');
    assert.deepEqual(checkLibReadme(readme, ['valibot/index.mjs', 'valibot/LICENSE.md']), []);
    assert.deepEqual(checkLibReadme(readme, ['valibotx.js']), ['js/lib/README.md has no row for valibotx.js']);
    assert.deepEqual(checkLibReadme(readme.replace(/^\| `valibot\/`.*$/m, ''), vendoredFiles()), [
      'js/lib/README.md has no row for valibot/LICENSE.md',
      'js/lib/README.md has no row for valibot/index.mjs',
    ]);
  });
});

describe('vendored files that ship (AC8)', () => {
  it("are js/lib's files, with Valibot's build and license but not its declarations or vendor record", () => {
    const valibot = JSON.parse(read('js/lib/valibot/vendor.json'));
    const shipped = Object.keys(valibot.files).filter((name) => valibot.files[name].ships).map((name) => `valibot/${name}`);
    assert.deepEqual(vendoredFiles(), ['chart.js', 'fuse.js', 'jszip.min.js', 'transformers.js', ...shipped].sort());
    assert.deepEqual(shipped.sort(), ['valibot/LICENSE.md', 'valibot/index.mjs']);
  });
});

describe('license notices (AC8)', () => {
  it('LICENSE is MIT with the owner\'s copyright, matching package.json', () => {
    const license = read('LICENSE');
    assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Keyur Golani\n/);
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.license, 'MIT');
    assert.match(pkg.author, /^Keyur Golani /);
  });

  it('THIRD_PARTY_NOTICES covers every vendored library and the components bundled in them', () => {
    const notices = read('THIRD_PARTY_NOTICES');
    for (const heading of [
      'Chart.js 4.4.1', '@kurkle/color 0.3.2', 'Fuse.js 7.1.0', 'JSZip 3.10.1', 'pako 1.0.11',
      '@xenova/transformers (Transformers.js) 2.17.1', '@huggingface/jinja 0.2.2', 'onnxruntime-web 1.14.0',
      'onnxruntime-common 1.14.0', 'ONNX Runtime 1.14.0 third-party notices', 'Valibot 1.5.0', 'emoji-regex-xs 1.0.0',
    ]) {
      assert.match(notices, new RegExp(`^\\d+\\. ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), heading);
    }
    for (const entry of ['onnx', 'google/flatbuffers', 'emsdk']) {
      assert.match(notices, new RegExp(`_____\\n\\n${entry.replace('/', '\\/')}\\n`), `ONNX Runtime entry ${entry}`);
    }
    assert.match(notices, /used under MIT|uses it under MIT/, 'JSZip license choice stated');
    assert.match(notices, /window\.transformers=__webpack_exports__;/, 'the transformers.js change is stated');
  });

  it('the build copies every js/lib file that ships byte for byte and ships both notice files', () => {
    const build = require('../scripts/build.js');
    const { BUNDLED } = require('../scripts/check-notices.js');
    for (const name of vendoredFiles()) {
      const file = `js/lib/${name}`;
      // STATIC_FILES are copied as they are
      if (build.STATIC_FILES.includes(file)) continue;
      // The bundler folds Valibot's build into the chunks that import it, and the build checks
      // it against its record and its notice (checkBundledVendor)
      if (BUNDLED.has(name)) continue;
      assert.equal(build.CLASSIC_SCRIPTS[file], 'as-is', `${file} isn't a classic script the build copies as is, so terser would rewrite it`);
    }
    assert.deepEqual([...BUNDLED], ['valibot/index.mjs']);
    assert.ok(build.STATIC_FILES.includes('js/lib/valibot/LICENSE.md'));
    assert.ok(build.STATIC_FILES.includes('LICENSE'));
    assert.ok(build.STATIC_FILES.includes('THIRD_PARTY_NOTICES'));
  });

  it('checkZip passes a package laid out like npm run package', async () => {
    assert.deepEqual(await checkZip(await packageZip()), []);
  });

  it("names the files Valibot ships in, bundled and minified, and emoji-regex-xs, whose regex Valibot's build holds, with its MIT notice", () => {
    // #99's review: the Valibot entry still said js/lib/valibot/index.mjs, unmodified, and no
    // entry covered emoji-regex-xs, whose regex Valibot's build holds
    const notices = read('THIRD_PARTY_NOTICES');
    assert.match(notices, /^In: {8}assets\/trust-\*\.js and js\/background\.js: dist\/index\.mjs from the valibot package, bundled and minified/m);
    // #99's delta: trust-* is the trust chunk, which the pages load for their failure events;
    // the pages' shared chunk is host-*
    assert.match(notices, /^In: .*bundled and minified into the chunks that import it: the trust chunk, which a page loads only for its failure events \(\* is its content hash\), and the service worker\./m);
    assert.doesNotMatch(notices, /shared chunk/);
    assert.match(notices, /^ {2}20\. emoji-regex-xs 1\.0\.0 \(MIT\)$/m);
    assert.match(notices, /^Copyright: Copyright \(c\) 2024 Steven Levithan$/m);
    assert.match(notices, /^MIT License\n\nCopyright \(c\) 2024 Steven Levithan\n\nPermission is hereby granted/m);
    assert.deepEqual(checkBundledNotices(filesOf(CHUNKS)), []);
  });

  it("fails a bundled package's notice that misses a script carrying its code or names one that doesn't", () => {
    const valibot = 'Valibot 1.5.0';
    const emoji = 'emoji-regex-xs 1.0.0';
    // Valibot moves from the service worker into the popup's chunk
    assert.deepEqual(checkBundledNotices(filesOf({ ...CHUNKS, 'js/background.js': 'self.ntn=1;', 'assets/popup-LWzkxAKk.js': VALIBOT })), [
      `assets/popup-LWzkxAKk.js carries ${valibot}'s code, and the In: line of its THIRD_PARTY_NOTICES entry doesn't name it`,
      `the In: line of THIRD_PARTY_NOTICES' ${valibot} entry names js/background.js, and no shipped script it matches carries its code`,
    ]);
    // A schema uses Valibot's emoji action, so its regex ships
    const regex = 'const r=/^(?:[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F})+$/u;';
    assert.deepEqual(checkBundledNotices(filesOf({ ...CHUNKS, 'assets/trust-YdWbqFjr.js': `${VALIBOT}${regex}` })), [
      `assets/trust-YdWbqFjr.js carries ${emoji}'s code, and the In: line of its THIRD_PARTY_NOTICES entry doesn't name it`,
    ]);
    // Unminified, as a development build writes it, with every export and the regex
    assert.deepEqual(checkBundledNotices(filesOf({ ...CHUNKS, 'assets/sidepanel-DgtwzUbD.js': read('js/lib/valibot/index.mjs') })), [
      `assets/sidepanel-DgtwzUbD.js carries ${valibot}'s code, and the In: line of its THIRD_PARTY_NOTICES entry doesn't name it`,
      `assets/sidepanel-DgtwzUbD.js carries ${emoji}'s code, and the In: line of its THIRD_PARTY_NOTICES entry doesn't name it`,
    ]);
    // #14's table of character references moves from the new tab's workspace chunk into the popup's
    const entities = 'HTML Standard named character references';
    assert.deepEqual(
      checkBundledNotices(filesOf({ ...CHUNKS, 'assets/workspace-Q7bL2xVe.js': 'export{};', 'assets/popup-LWzkxAKk.js': ENTITIES })),
      [
        `assets/popup-LWzkxAKk.js carries ${entities}'s code, and the In: line of its THIRD_PARTY_NOTICES entry doesn't name it`,
        `the In: line of THIRD_PARTY_NOTICES' ${entities} entry names assets/workspace-*.js, and no shipped script it matches carries its code`,
      ],
    );
    // No entry at all
    assert.deepEqual(checkBundledNotices(filesOf(CHUNKS, read('THIRD_PARTY_NOTICES').replace(/^19\. Valibot 1\.5\.0$/m, '19. Valibot'))), [
      `THIRD_PARTY_NOTICES has no "${valibot}" entry with an In: line, and assets/trust-YdWbqFjr.js and js/background.js carry its code`,
    ]);
  });

  it('checkZip flags missing notices and a modified or missing js/lib file', async () => {
    const stripped = fs.readFileSync(path.join(ROOT, 'js/lib/fuse.js'), 'utf8').replace(/^\/\*\*[\s\S]*?\*\/\n/, '');
    const problems = await checkZip(await packageZip({
      omit: ['THIRD_PARTY_NOTICES', 'js/lib/chart.js'],
      replace: { 'js/lib/fuse.js': stripped },
    }));
    assert.deepEqual(problems.sort(), [
      'js/lib/fuse.js in the package differs from js/lib/fuse.js',
      'the package has no THIRD_PARTY_NOTICES at its root',
      'the package has no js/lib/chart.js',
    ]);
  });
});

describe('npm run check:notices (AC8, AC9)', () => {
  const run = (zip) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-notices.js'), zip], { encoding: 'utf8' });

  it('passes a good package, and a failure is where pr-gate\'s build excerpt starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-notices-'));
    try {
      const good = path.join(dir, 'good.zip');
      const bad = path.join(dir, 'bad.zip');
      fs.writeFileSync(good, await packageZip());
      fs.writeFileSync(bad, await packageZip({ omit: ['THIRD_PARTY_NOTICES'] }));

      const passed = run(good);
      assert.equal(passed.status, 0, passed.stderr);
      assert.match(passed.stdout, /^check:notices passed: /);
      assert.match(passed.stdout, /Valibot 1\.5\.0 in assets\/trust-YdWbqFjr\.js and js\/background\.js/);

      const failed = run(bad);
      assert.equal(failed.status, 1);
      const log = `> new-tab-note@1.4.1 check:notices\n> node scripts/check-notices.js\n\n${failed.stdout}${failed.stderr}`;
      assert.deepEqual(excerpt(log, MARKERS.build).split('\n'), [
        'check:notices failed with 1 problem(s):',
        '  - the package has no THIRD_PARTY_NOTICES at its root',
      ]);

      const missing = run(path.join(dir, 'missing.zip'));
      assert.equal(missing.status, 1);
      assert.match(excerpt(missing.stderr, MARKERS.build), /^check:notices failed: no package at /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
