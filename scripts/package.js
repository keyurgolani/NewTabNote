#!/usr/bin/env node

/**
 * Package script for New Tab Note Chrome Extension: writes
 * releases/new-tab-note-v<version>.zip from dist/, ready for Chrome Web Store upload.
 *
 * The zip is deterministic (#27 AC4, scripts/build/zip.js): its entries are sorted by path,
 * each dated build-info.json's SOURCE_DATE_EPOCH in UTC, with mode 0644, deflated at level 9.
 * Before writing, it checks dist/ is one whole build: build-info.json's outputDigest is the
 * SHA-256 of asset-manifest.json, which lists every other file as it is. After, it reads the
 * zip back and runs the closure check on it (#27 AC5), so every path the package names is in
 * the zip and the zip holds nothing unnamed. A problem leaves no zip, an older one of the same
 * name included.
 */

const fs = require('fs');
const path = require('path');
const { problem, format, plural } = require('./build/diagnostics.js');
const { checkNode } = require('./build/toolchain.js');
const { fromDirectory, fromZip } = require('./build/package-files.js');
const { readBuildInfo, sha256 } = require('./build/build-info.js');
const { checkClosure } = require('./build/closure.js');
const { writeZip } = require('./build/zip.js');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT_DIR = path.join(ROOT_DIR, 'releases');

/**
 * The zip for the build in `dir` (dist/), or the problems that stop it
 */
function makePackage(dir = DIST_DIR) {
  const problems = [...checkNode(ROOT_DIR)];
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    return { problems: [...problems, problem('package/no-build', 'dist/', 'dist/manifest.json not found. Run `npm run build` first.')] };
  }
  const files = fromDirectory(dir, 'dist/');
  const build = readBuildInfo(files);
  problems.push(...build.problems.map(message => problem('package/no-build', 'dist/', `${message}. Run \`npm run build\` again.`)));
  if (problems.length > 0) return { problems };

  const zip = writeZip(files.paths.map(file => ({ path: file, data: files.read(file) })), { sourceDateEpoch: build.info.SOURCE_DATE_EPOCH });

  const packed = fromZip(zip, 'the zip');
  const differs = packed.paths.length !== files.paths.length
    || packed.paths.some((file, i) => file !== files.paths[i] || !packed.read(file).equals(files.read(file)));
  if (differs) problems.push(problem('package/write', 'the zip', "doesn't hold dist/'s files as they are"));
  problems.push(...checkClosure(packed).problems);
  return { problems, zip, files: files.paths.length };
}

/**
 * The version the zip is named for: dist/'s manifest's, or the repository's without a build
 */
function packageVersion() {
  for (const manifest of [path.join(DIST_DIR, 'manifest.json'), path.join(ROOT_DIR, 'manifest.json')]) {
    try {
      return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    } catch {
      // Missing or unreadable: the next one, and makePackage reports it
    }
  }
  return 'unknown';
}

function createPackage() {
  const version = packageVersion();
  const filename = `new-tab-note-v${version}.zip`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  // A zip left from before isn't this build's
  fs.rmSync(outputPath, { force: true });

  console.log(`\n📦 Packaging New Tab Note v${version}...\n`);
  let result;
  try {
    result = makePackage();
  } catch (error) {
    result = { problems: [problem('package/write', 'the zip', error && error.message ? error.message : String(error))] };
  }
  if (result.problems.length > 0) {
    console.error(`Packaging failed: ${plural(result.problems.length, 'problem')}. No zip was written.`);
    result.problems.forEach(found => console.error(`  ✗ ${format(found)}`));
    console.error('');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outputPath, result.zip);
  console.log(`✅ Package created: ${filename}`);
  console.log(`   Size: ${formatBytes(result.zip.length)}, ${result.files} files`);
  console.log(`   SHA-256: ${sha256(result.zip)}`);
  console.log(`   Path: ${outputPath}`);
  console.log('');
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Run packaging when invoked as a script; tests require makePackage
if (require.main === module) {
  try {
    createPackage();
  } catch (error) {
    console.error('Packaging failed:', error);
    process.exit(1);
  }
}

module.exports = { makePackage };
