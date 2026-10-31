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
  REQUIRED_DESTINATIONS, vendoredFiles, policyPermissions, checkPolicy, checkLibReadme, checkZip,
} = require('../scripts/check-notices.js');
const { excerpt, MARKERS } = require('../scripts/ci/failure-excerpt.js');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const policy = read('PRIVACY_POLICY.md');

/** A zip laid out like the package, built from the repository files. */
async function packageZip({ omit = [], replace = {} } = {}) {
  const zip = new JSZip();
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES', 'manifest.json']) {
    if (!omit.includes(name)) zip.file(name, replace[name] ?? fs.readFileSync(path.join(ROOT, name)));
  }
  for (const name of vendoredFiles()) {
    const entry = `js/lib/${name}`;
    if (!omit.includes(entry)) zip.file(entry, replace[entry] ?? fs.readFileSync(path.join(ROOT, entry)));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('privacy policy (AC9)', () => {
  it('lists exactly the manifest permissions, describes the hosts, and names every network destination', () => {
    assert.deepEqual(policyPermissions(policy).names.sort(), [...manifest.permissions].sort());
    assert.deepEqual(checkPolicy(policy, manifest), []);
  });

  it('is updated and no longer claims a wildcard host permission', () => {
    assert.doesNotMatch(policy, /https:\/\/_\/_/);
    assert.match(policy, /\*\*Last Updated: October 20, 2026\*\*/);
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
      'onnxruntime-common 1.14.0', 'ONNX Runtime 1.14.0 third-party notices', 'Valibot 1.5.0',
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
