'use strict';

// #27 "Toolchain" and the type gate (AC1, AC12): the pinned Node, npm, and devDependencies,
// LF line endings, tools run from node_modules/.bin and never npx, and
// scripts/build/type-gate.js, here with stand-ins for tsc and the ratchet.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pinnedNode, checkNode, binPath } = require('../scripts/build/toolchain.js');
const { runTypeGate } = require('../scripts/build/type-gate.js');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('the pinned toolchain', () => {
  it('pins one exact Node in .nvmrc, engines, and the lockfile, and npm test runs on it', () => {
    const pin = pinnedNode(ROOT);
    assert.match(pin, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.engines.node, pin);
    assert.equal(lock.packages[''].engines.node, pin);
    assert.equal(process.version, `v${pin}`, 'npm test runs on the pinned Node');
  });

  it('pins npm to the version Node bundles', () => {
    assert.equal(pkg.packageManager, 'npm@11.16.0');
  });

  it('pins every devDependency to the version the lockfile installs', () => {
    for (const [name, spec] of Object.entries(pkg.devDependencies)) {
      assert.match(spec, /^\d+\.\d+\.\d+$/, `${name} is ${spec}, not an exact version`);
      assert.equal(lock.packages[`node_modules/${name}`].version, spec, `${name} in the lockfile`);
      assert.equal(lock.packages[''].devDependencies[name], spec, `${name} in the lockfile's root`);
    }
    assert.deepEqual(Object.keys(lock.packages[''].devDependencies).sort(), Object.keys(pkg.devDependencies).sort());
  });

  it('the build refuses any other Node', () => {
    assert.deepEqual(checkNode(ROOT, `v${pinnedNode(ROOT)}`), []);
    assert.deepEqual(checkNode(ROOT, 'v24.0.0').map(({ code }) => code), ['toolchain/node-version']);
    assert.deepEqual(checkNode(ROOT, 'v22.20.0').map(({ code }) => code), ['toolchain/node-version']);
  });

  it('runs tools from node_modules/.bin, never npx, which can fetch', () => {
    for (const [name, script] of Object.entries(pkg.scripts)) assert.doesNotMatch(script, /\bnpx\b/, name);
    const workflows = fs.readdirSync(path.join(ROOT, '.github/workflows')).map((name) => `.github/workflows/${name}`);
    for (const file of ['scripts/build.js', 'scripts/package.js', 'scripts/check-notices.js', ...fs.readdirSync(path.join(ROOT, 'scripts/build')).map((name) => `scripts/build/${name}`), ...workflows]) {
      assert.doesNotMatch(read(file), /\bnpx\s/, file);
    }
    assert.equal(binPath(ROOT, 'tsc'), path.join(ROOT, 'node_modules', '.bin', 'tsc'));
    assert.equal(pkg.scripts.typecheck, 'tsc --project jsconfig.json');
    assert.equal(pkg.scripts['typecheck:ratchet'], 'node scripts/build/type-gate.js', 'typecheck:ratchet runs the type gate');
  });

  it('installs from the lockfile with no install script, in every workflow and in the setup the docs give', () => {
    // #99's review: README.md and CONTRIBUTING.md still said npm install
    const workflows = fs.readdirSync(path.join(ROOT, '.github/workflows')).map((name) => `.github/workflows/${name}`);
    for (const file of ['README.md', 'CONTRIBUTING.md', ...workflows]) {
      const installs = read(file).split('\n').filter((line) => /\bnpm (?:ci|install|i)\b/.test(line));
      assert.ok(installs.every((line) => /\bnpm ci --ignore-scripts\b/.test(line)), `${file}: ${installs.join(' | ')}`);
    }
    for (const doc of ['README.md', 'CONTRIBUTING.md']) assert.match(read(doc), /`npm ci --ignore-scripts`/, doc);
  });

  it('keeps LF line endings, with the notices exempt so their license texts stay as written', () => {
    assert.match(read('.gitattributes'), /^\* text=auto eol=lf$/m);
    assert.match(read('.gitattributes'), /^THIRD_PARTY_NOTICES -text$/m);
    const lines = execFileSync('git', ['-C', ROOT, 'ls-files', '--eol'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
    const crlf = lines.filter((line) => /^i\/(crlf|mixed)/.test(line)).map((line) => line.split('\t').pop());
    assert.deepEqual(crlf, ['THIRD_PARTY_NOTICES']);
  });
});

describe('the type gate', () => {
  // A stand-in for tsc: NTN_FAKE_TSC maps each project to the exit status and output to give
  const FAKE_TSC = `const config = process.argv[process.argv.indexOf('-p') + 1];
const plan = JSON.parse(process.env.NTN_FAKE_TSC || '{}')[config] || { status: 0, stdout: '' };
process.stdout.write(plan.stdout);
process.exitCode = plan.status;`;
  const FAKE_RATCHET = `const fail = process.env.NTN_FAKE_RATCHET === 'fail';
if (fail) { console.error('typecheck ratchet failed: 1 new key'); console.error('  js/a.js TS2304 "Cannot find name"'); process.exitCode = 1; }
else console.log('typecheck ratchet: OK, 3 diagnostics under 2 keys match ci/baselines/typecheck.json' + (process.argv.includes('--update') ? ', nothing to record' : ''));`;

  function fakes() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-type-gate-'));
    temps.push(dir);
    fs.writeFileSync(path.join(dir, 'tsc.js'), FAKE_TSC);
    fs.writeFileSync(path.join(dir, 'ratchet.js'), FAKE_RATCHET);
    return { tsc: path.join(dir, 'tsc.js'), ratchet: path.join(dir, 'ratchet.js') };
  }

  async function gate(env, options = {}) {
    const saved = { NTN_FAKE_TSC: process.env.NTN_FAKE_TSC, NTN_FAKE_RATCHET: process.env.NTN_FAKE_RATCHET };
    Object.assign(process.env, env);
    try {
      return await runTypeGate(ROOT, { ...fakes(), ...options });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('passes when both strict projects report nothing and the ratchet matches its baseline', async () => {
    const { problems, summary } = await gate({});
    assert.deepEqual(problems, []);
    assert.match(summary, /tsconfig\.kernel\.json and tsconfig\.strict\.json report no diagnostics, and the legacy ratchet: OK, 3 diagnostics/);
  });

  it('fails on any diagnostic in a strict project, with its file and position', async () => {
    const stdout = "scripts/build/a.js(3,7): error TS7006: Parameter 'x' implicitly has an 'any' type.\n  It continues here.\n";
    const { problems } = await gate({ NTN_FAKE_TSC: JSON.stringify({ 'tsconfig.strict.json': { status: 2, stdout } }) });
    assert.deepEqual(problems.map(({ code, subject, message }) => [code, subject, message]), [
      ['type/strict', 'scripts/build/a.js:3:7', "TS7006 Parameter 'x' implicitly has an 'any' type. It continues here."],
    ]);
  });

  it('fails when tsc exits nonzero without a diagnostic, or is missing', async () => {
    const { problems } = await gate({ NTN_FAKE_TSC: JSON.stringify({ 'tsconfig.kernel.json': { status: 1, stdout: 'Segmentation fault\n' } }) });
    assert.deepEqual(problems.map(({ code, message }) => [code, message]), [['type/kernel', 'tsc exited 1 without a diagnostic it could parse']]);
    assert.deepEqual(problems[0].details, ['Segmentation fault']);
    const missing = await gate({}, { tsc: null });
    assert.deepEqual(missing.problems.map(({ code }) => code), ['toolchain/missing-tool']);
  });

  it('fails with the ratchet\'s report when the legacy diagnostics move off the baseline, and passes --update on', async () => {
    const { problems } = await gate({ NTN_FAKE_RATCHET: 'fail' });
    assert.deepEqual(problems.map(({ code, subject, message }) => [code, subject, message]), [['type/legacy', 'jsconfig.json', 'typecheck ratchet failed: 1 new key']]);
    assert.deepEqual(problems[0].details, ['  js/a.js TS2304 "Cannot find name"']);
    const updated = await gate({}, { update: true });
    assert.match(updated.summary, /nothing to record$/);
  });
});
