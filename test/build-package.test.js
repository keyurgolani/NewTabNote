'use strict';

// #27 AC4 and "Outputs": the deterministic zip (scripts/build/zip.js), build-info.json and
// asset-manifest.json (scripts/build/build-info.js), and npm run package's checks
// (scripts/package.js), on small builds written here.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ZIP_EPOCH, FILE_MODE, dosDateTime, writeZip, readZip } = require('../scripts/build/zip.js');
const { fromDirectory } = require('../scripts/build/package-files.js');
const { sourceInfo, buildId, kernelVersions, assetManifest, writeBuildInfo, readBuildInfo, sha256 } = require('../scripts/build/build-info.js');
const { makePackage } = require('../scripts/package.js');
const { ROOT } = require('./helpers/source-package.js');

// 2026-10-20T22:53:21Z, an odd second
const EPOCH = Date.UTC(2026, 9, 20, 22, 53, 21) / 1000;
const FILES = [
  { path: 'manifest.json', data: Buffer.from('{}') },
  { path: 'js/b.js', data: Buffer.from('b'.repeat(1000)) },
  { path: 'js/a.js', data: Buffer.from('a') },
  { path: 'empty.txt', data: Buffer.alloc(0) },
];

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-build-package-'));
  temps.push(dir);
  return dir;
}

/** A small, closed build in a new directory, with its build-info.json and asset-manifest.json */
async function smallBuild(extra = {}) {
  const dir = tempDir();
  const files = {
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'x', version: '1.2.3', chrome_url_overrides: { newtab: 'newtab.html' } }),
    'newtab.html': '<script src="js/a.js"></script>',
    'js/a.js': 'window.a = 1;\n',
    LICENSE: 'MIT\n',
    ...extra,
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const info = { commit: null, tree: null, dirty: true, sourceDateEpoch: EPOCH };
  const written = writeBuildInfo(dir, fromDirectory(dir), { buildId: 'test-build', info, mode: 'production', versions: await kernelVersions(ROOT) });
  return { dir, written };
}

describe('the deterministic zip (AC4)', () => {
  it('is the same bytes for the same files in any order, entries sorted, every one dated SOURCE_DATE_EPOCH with mode 0644 and deflated', () => {
    const zip = writeZip(FILES, { sourceDateEpoch: EPOCH });
    assert.ok(zip.equals(writeZip([...FILES].reverse(), { sourceDateEpoch: EPOCH })));
    const entries = readZip(zip);
    assert.deepEqual(entries.map((entry) => entry.path), ['empty.txt', 'js/a.js', 'js/b.js', 'manifest.json']);
    const { date, time } = dosDateTime(EPOCH);
    for (const entry of entries) {
      assert.equal(entry.mode, FILE_MODE, entry.path);
      assert.equal(entry.date, date, entry.path);
      assert.equal(entry.time, time, entry.path);
      assert.ok(entry.data.equals(FILES.find((file) => file.path === entry.path).data), entry.path);
    }
    // Every local header: deflate, UTF-8 names, no extra field, no data descriptor
    for (let at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])); at !== -1; at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at + 4)) {
      assert.equal(zip.readUInt16LE(at + 6), 0x0800);
      assert.equal(zip.readUInt16LE(at + 8), 8);
      assert.equal(zip.readUInt16LE(at + 28), 0);
    }
    assert.notDeepEqual(writeZip(FILES, { sourceDateEpoch: EPOCH + 2 }), zip, 'the date is in the zip');
  });

  it('is the same bytes in any time zone', () => {
    const script = `const { writeZip } = require(${JSON.stringify(path.join(ROOT, 'scripts/build/zip.js'))});
      const zip = writeZip([{ path: 'a.txt', data: Buffer.from('a') }], { sourceDateEpoch: ${EPOCH} });
      process.stdout.write(require('node:crypto').createHash('sha256').update(zip).digest('hex'));`;
    const digests = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'].map((TZ) => execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }));
    assert.equal(new Set(digests).size, 1, digests.join(' '));
  });

  it('dates in UTC at two-second steps, from 1980, which is the earliest a zip holds', () => {
    // 22:53:21 is stored as 22:53:20
    assert.deepEqual(dosDateTime(EPOCH), { date: ((2026 - 1980) << 9) | (10 << 5) | 20, time: (22 << 11) | (53 << 5) | 10 });
    assert.deepEqual(dosDateTime(0), dosDateTime(ZIP_EPOCH));
    assert.deepEqual(dosDateTime(ZIP_EPOCH), { date: (1 << 5) | 1, time: 0 });
    assert.throws(() => dosDateTime(4_400_000_000), /after 2107/);
    assert.throws(() => dosDateTime(1.5), /whole number/);
  });

  it('refuses paths that leave the package or repeat, and reads back only what checks out', () => {
    assert.throws(() => writeZip([{ path: '../x', data: Buffer.alloc(0) }], { sourceDateEpoch: EPOCH }), /relative path/);
    assert.throws(() => writeZip([{ path: 'a', data: Buffer.alloc(0) }, { path: 'a', data: Buffer.alloc(1) }], { sourceDateEpoch: EPOCH }), /twice/);
    const zip = writeZip([{ path: 'a.txt', data: Buffer.from('hello') }], { sourceDateEpoch: EPOCH });
    const corrupt = Buffer.from(zip);
    corrupt.writeUInt32LE(zip.readUInt32LE(14) ^ 1, 14);
    // The CRC in the central directory is what's checked
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupt.writeUInt32LE(zip.readUInt32LE(central + 16) ^ 1, central + 16);
    assert.throws(() => readZip(corrupt), /size or CRC/);
    assert.throws(() => readZip(Buffer.from('not a zip')), /end of central directory/);
  });
});

describe('build-info.json and asset-manifest.json', () => {
  it('lists every other file with its size and SHA-256, and outputDigest hashes that list', async () => {
    const { dir, written } = await smallBuild();
    const files = fromDirectory(dir);
    const manifest = JSON.parse(files.text('asset-manifest.json'));
    assert.deepEqual(manifest.files.map((entry) => entry.path), ['LICENSE', 'js/a.js', 'manifest.json', 'newtab.html']);
    for (const entry of manifest.files) {
      assert.equal(entry.size, files.read(entry.path).length);
      assert.equal(entry.sha256, sha256(files.read(entry.path)));
    }
    const info = JSON.parse(files.text('build-info.json'));
    assert.deepEqual(Object.keys(info), ['buildId', 'outputDigest', 'chunks', 'version', 'commit', 'SOURCE_DATE_EPOCH', 'mode', 'protocolVersion', 'schemaVersion']);
    assert.equal(info.outputDigest, sha256(files.read('asset-manifest.json')));
    assert.equal(info.outputDigest, written.outputDigest);
    assert.deepEqual(info.chunks, { 'js/a.js': 'js/a.js' });
    assert.equal(info.version, '1.2.3');
    assert.equal(info.SOURCE_DATE_EPOCH, EPOCH);
    assert.deepEqual(info.protocolVersion, { major: 1, minor: 0 });
    assert.equal(info.schemaVersion, 8);
    assert.deepEqual(readBuildInfo(files).problems, []);
    assert.equal(assetManifest(files), files.text('asset-manifest.json'));
  });

  it('readBuildInfo catches a file that changed after the build, and a build without the two files', async () => {
    const { dir } = await smallBuild();
    fs.appendFileSync(path.join(dir, 'js/a.js'), '// later\n');
    assert.match(readBuildInfo(fromDirectory(dir)).problems.join('\n'), /asset-manifest\.json doesn't list the files/);
    fs.rmSync(path.join(dir, 'build-info.json'));
    assert.match(readBuildInfo(fromDirectory(dir)).problems.join('\n'), /has no build-info\.json/);
  });

  it('buildId comes from the tree, the lockfile, the toolchain, and the mode, and says when the tree is dirty', () => {
    const clean = { commit: 'c', tree: 'a'.repeat(40), dirty: false, sourceDateEpoch: EPOCH };
    const id = buildId(ROOT, clean, 'production');
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(buildId(ROOT, { ...clean, commit: 'other', sourceDateEpoch: 0 }, 'production'), id, 'the commit and date are not inputs');
    assert.notEqual(buildId(ROOT, clean, 'development'), id);
    assert.notEqual(buildId(ROOT, { ...clean, tree: 'b'.repeat(40) }, 'production'), id);
    assert.equal(buildId(ROOT, { ...clean, dirty: true }, 'production'), `${id}-dirty`);
  });

  it('outside a checkout there is no commit, the tree counts as dirty, and SOURCE_DATE_EPOCH is 1980 unless the environment sets it', () => {
    const dir = tempDir();
    assert.deepEqual(sourceInfo(dir, {}), { info: { commit: null, tree: null, dirty: true, sourceDateEpoch: ZIP_EPOCH }, problems: [] });
    assert.equal(sourceInfo(dir, { SOURCE_DATE_EPOCH: '1700000000' }).info.sourceDateEpoch, 1_700_000_000);
    const bad = sourceInfo(dir, { SOURCE_DATE_EPOCH: 'yesterday' });
    assert.deepEqual(bad.problems.map(({ code }) => code), ['build/source-date']);
  });

  it('in this checkout, the commit and SOURCE_DATE_EPOCH are HEAD\'s', () => {
    const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
    const { info, problems } = sourceInfo(ROOT, {});
    assert.deepEqual(problems, []);
    assert.equal(info.commit, git('rev-parse', 'HEAD'));
    assert.equal(info.tree, git('rev-parse', 'HEAD^{tree}'));
    assert.equal(info.sourceDateEpoch, Number(git('log', '-1', '--format=%ct', 'HEAD')));
  });
});

describe('npm run package (AC4, AC5)', () => {
  it('zips a whole build as it is, and the zip passes the closure check', async () => {
    const { dir } = await smallBuild();
    const result = makePackage(dir);
    assert.deepEqual(result.problems, []);
    const entries = readZip(result.zip);
    assert.deepEqual(entries.map((entry) => entry.path), fromDirectory(dir).paths);
    assert.equal(crypto.createHash('sha256').update(result.zip).digest('hex'), crypto.createHash('sha256').update(makePackage(dir).zip).digest('hex'));
  });

  it('refuses a build whose files changed since it was built, or that has no build-info.json', async () => {
    const changed = await smallBuild();
    fs.appendFileSync(path.join(changed.dir, 'newtab.html'), '<p>later</p>');
    assert.deepEqual(makePackage(changed.dir).problems.map(({ code }) => code), ['package/no-build']);
    const missing = await smallBuild();
    fs.rmSync(path.join(missing.dir, 'build-info.json'));
    assert.deepEqual(makePackage(missing.dir).problems.map(({ code }) => code), ['package/no-build']);
    assert.deepEqual(makePackage(tempDir()).problems.map(({ code }) => code), ['package/no-build']);
  });

  it('refuses a build whose zip would hold a file nothing names', async () => {
    const { dir } = await smallBuild({ 'stray.txt': 'unnamed' });
    assert.deepEqual(makePackage(dir).problems.map(({ code, subject }) => `${code} ${subject}`), ['closure/unreferenced stray.txt']);
  });
});
