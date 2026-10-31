'use strict';

/**
 * The build (#27 slice 2: the bundler swap), which scripts/build.js runs. Vite bundles the
 * pages and the service worker (scripts/build/vite-config.js) into a staging directory, the
 * build copies what no page or script imports, checks what it wrote, and only then renames it
 * to dist/. A problem in any mode exits 1 and leaves no dist/: nothing falls back to unminified
 * source, a lower optimization level, or a skipped input (#27, "Failure rules").
 *
 * In order, each step reporting every problem it finds before the build stops:
 *   1. the toolchain: Node is the version .nvmrc pins, and SOURCE_DATE_EPOCH, if set, is a number
 *   2. the inputs: each one the build lists is there, and the manifest checks
 *   3. the bundle: the pages pass and the background pass, then the classic scripts and the
 *      static files copied
 *   4. the checks on what it wrote and on the modules the bundle holds: closure, each page's
 *      preloads and classic scripts, remote code, CSP, notices and source maps, vendored files,
 *      environment reads, CommonJS, and the background's own
 *   5. the type gate (scripts/build/type-gate.js)
 *   6. asset-manifest.json, build-info.json with the bundle's chunks, dist-report/modules.json,
 *      and the rename to dist/
 * Each problem prints as `✗ [code] subject: message` (scripts/build/diagnostics.js), and the
 * summary lists them all.
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem, format, plural } = require('./diagnostics.js');
const { checkNode } = require('./toolchain.js');
const { runTypeGate } = require('./type-gate.js');
const { fromDirectory } = require('./package-files.js');
const { checkClosure, checkPreloads, checkClassicScripts } = require('./closure.js');
const { checkRemoteCode } = require('./remote-code.js');
const { checkCsp } = require('./csp.js');
const { checkNoticeFiles, checkBanners, checkSourceMaps, checkVendor, checkBundledVendor } = require('./notices.js');
const { checkEnvironment, checkSourceEnvironment } = require('./environment.js');
const { checkCommonJs } = require('./commonjs.js');
const { checkBackgroundOutput, checkBackgroundSources } = require('./background.js');
const { sourceInfo, buildId: computeBuildId, kernelVersions, writeBuildInfo } = require('./build-info.js');
const { bundle } = require('./bundle.js');
const { listedInputs } = require('./inputs.js');
const { CLASSIC_SCRIPTS, STATIC_FILES, MINIMUM_CHROME_VERSION, terserOptions } = require('./vite-config.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./bundle.js').Bundled} Bundled */
/** @typedef {import('./vite-config.js').Mode} Mode */

const ROOT_DIR = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
// Build reports, which never ship (.gitignore's dist-report/)
const REPORT_DIR = path.join(ROOT_DIR, 'dist-report');
const MODULE_MAP = path.join(REPORT_DIR, 'modules.json');
// Where a build writes before it's checked; a sibling of dist/, so the rename stays on one disk
const STAGING_PREFIX = '.dist-staging-';

const ARGUMENTS = ['--dev', '--strict'];

/**
 * Problems with manifest.json: it parses, is Manifest V3 with a name, a version, and a service
 * worker, and asks for at least MINIMUM_CHROME_VERSION
 * @param {string} text
 * @returns {Problem[]}
 */
function manifestProblems(text) {
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return [problem('build/manifest', 'manifest.json', `doesn't parse: ${error instanceof Error ? error.message : error}`)];
  }
  /** @type {Problem[]} */
  const problems = [];
  const fail = (/** @type {string} */ message) => problems.push(problem('build/manifest', 'manifest.json', message));
  if (manifest.manifest_version !== 3) fail(`manifest_version is ${JSON.stringify(manifest.manifest_version)}, not 3`);
  if (typeof manifest.name !== 'string' || manifest.name === '') fail('has no name');
  if (typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`version ${JSON.stringify(manifest.version)} isn't one to four dot-separated numbers`);
  if (!manifest.background || typeof manifest.background.service_worker !== 'string') fail('names no background.service_worker');
  const minimum = manifest.minimum_chrome_version;
  if (typeof minimum !== 'string' || !/^\d+$/.test(minimum) || Number(minimum) < MINIMUM_CHROME_VERSION) {
    fail(`minimum_chrome_version is ${JSON.stringify(minimum)}; the APIs the extension uses need "${MINIMUM_CHROME_VERSION}" or later`);
  }
  return problems;
}

/**
 * Print a problem as it's found
 * @param {Problem} found
 */
function report(found) {
  console.error(`  ✗ ${format(found)}`);
  for (const line of found.details || []) console.error(`      ${line}`);
}

/**
 * Print the summary of a failed build and set the exit code
 * @param {Problem[]} problems
 */
function fail(problems) {
  console.error(`\n✗ Build failed: ${plural(problems.length, 'problem')}. No dist/ was written.`);
  for (const found of problems) {
    console.error(`   ${format(found)}`);
    for (const line of found.details || []) console.error(`      ${line}`);
  }
  console.error('');
  process.exitCode = 1;
}

/**
 * Leave no build behind: the staging directory, any dist/, and the module map of the last build
 * @param {string | null} staging
 */
function removeOutput(staging) {
  if (staging) fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.rmSync(MODULE_MAP, { force: true });
}

/**
 * Each input the build lists has to be there, and the manifest has to check
 * @param {string} root
 * @returns {Problem[]}
 */
function inputProblems(root) {
  /** @type {Problem[]} */
  const problems = [];
  for (const file of listedInputs()) {
    if (!fs.existsSync(path.join(root, file))) problems.push(problem('build/missing-input', file, 'refused to skip a missing listed file'));
  }
  const manifest = path.join(root, 'manifest.json');
  if (fs.existsSync(manifest)) problems.push(...manifestProblems(fs.readFileSync(manifest, 'utf8')));
  return problems;
}

/**
 * Copy the classic scripts and the static files into `outDir`: a vendored library and a static
 * file byte for byte, and a first-party classic script minified by terser as a classic
 * script, whose top-level names stay globals. In development terser still runs, so a script it
 * can't minify fails there too, and the source ships as written.
 * @param {string} root
 * @param {string} outDir
 * @param {Mode} mode
 * @returns {Promise<Problem[]>}
 */
async function copyUnbundled(root, outDir, mode) {
  const { minify } = require('terser');
  /** @type {Problem[]} */
  const problems = [];
  const copy = (/** @type {string} */ file, /** @type {string | Buffer} */ data) => {
    const target = path.join(outDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };
  for (const [file, how] of Object.entries(CLASSIC_SCRIPTS)) {
    const source = fs.readFileSync(path.join(root, file));
    if (how === 'as-is') {
      copy(file, source);
      continue;
    }
    try {
      const result = await minify(source.toString('utf8'), { ...terserOptions(), module: false });
      if (typeof result.code !== 'string') throw new Error('terser returned no code');
      copy(file, mode === 'production' ? result.code : source);
    } catch (error) {
      /** @type {any} */
      const failed = error;
      // terser's col is 0-based; print file:line:col the way editors count
      const at = Number.isInteger(failed && failed.line) && Number.isInteger(failed && failed.col) ? ` (${file}:${failed.line}:${failed.col + 1})` : '';
      problems.push(problem('build/terser', file, `refused to copy it unminified after a terser error: ${failed && failed.message ? failed.message : failed}${at}`));
    }
  }
  for (const file of STATIC_FILES) copy(file, fs.readFileSync(path.join(root, file)));
  return problems;
}

/**
 * The source modules a graph bundled, read from `root`
 * @param {string[]} files
 * @param {string} root
 * @returns {Array<{file: string, text: string}>}
 */
function sourcesOf(files, root) {
  return files.map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));
}

/**
 * The first-party ones of `sources` (js/lib/ is vendored)
 * @param {Array<{file: string, text: string}>} sources
 * @returns {Array<{file: string, text: string}>}
 */
function firstParty(sources) {
  return sources.filter(({ file }) => !file.startsWith('js/lib/'));
}

/**
 * Every check on what the build wrote and on the modules the bundle holds
 * @param {string} outDir
 * @param {Bundled} bundled
 * @param {string} root
 * @returns {Problem[]}
 */
function checkOutput(outDir, bundled, root) {
  const files = fromDirectory(outDir, 'the build');
  // A script a page loads as a classic script and the bundle also holds as a module would run twice
  const loadMode = Object.keys(CLASSIC_SCRIPTS).filter((file) => bundled.modules[file])
    .map((file) => problem('build/load-mode', file, `a page loads it as a classic script, and the bundle holds it as a module too, in ${bundled.modules[file].join(', ')}`));
  const modules = [...new Set([...bundled.graphs.pages, ...bundled.graphs.background])].sort();
  const sources = sourcesOf(modules, root);
  const background = new Set(bundled.graphs.background);
  return [
    ...loadMode,
    // build-info.json comes after the checks, so the chunks the loader's retry reads in it come from the bundle
    ...checkClosure(files, { chunks: bundled.chunks }).problems,
    ...checkPreloads(files),
    ...checkClassicScripts(files),
    ...checkRemoteCode(files),
    ...checkCsp(files),
    ...checkNoticeFiles(files),
    ...checkBanners(files),
    ...checkSourceMaps(files),
    ...checkVendor(files),
    ...checkBundledVendor(modules, files, root),
    ...checkEnvironment(files),
    ...checkSourceEnvironment(firstParty(sources)),
    // Vendored modules too: the bundler wraps one as readily, and swaps its require (#99's delta)
    ...checkCommonJs(sources),
    ...checkBackgroundOutput(files),
    ...checkBackgroundSources(firstParty(sources).filter(({ file }) => background.has(file))),
  ];
}

/**
 * Format bytes to human readable
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Build the extension
 * @param {string[]} [argv]
 * @returns {Promise<void>}
 */
async function build(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => !ARGUMENTS.includes(arg));
  if (unknown.length > 0) {
    fail([problem('build/usage', unknown.join(' '), 'usage: node scripts/build.js [--dev] [--strict]')]);
    return;
  }
  /** @type {Mode} */
  const mode = argv.includes('--dev') ? 'development' : 'production';
  console.log(`\n🔨 Building New Tab Note Extension (${mode})...\n`);
  const startTime = Date.now();

  // No build stays behind from before, half-made or not
  removeOutput(null);
  for (const entry of fs.readdirSync(ROOT_DIR)) {
    if (entry.startsWith(STAGING_PREFIX)) fs.rmSync(path.join(ROOT_DIR, entry), { recursive: true, force: true });
  }

  // 1. The toolchain, and the build's identity before anything is built
  const source = sourceInfo(ROOT_DIR);
  const early = [...checkNode(ROOT_DIR), ...source.problems];
  if (early.length > 0) {
    early.forEach(report);
    fail(early);
    return;
  }
  const buildId = computeBuildId(ROOT_DIR, source.info, mode);

  // 2. The inputs
  const missing = inputProblems(ROOT_DIR);
  if (missing.length > 0) {
    missing.forEach(report);
    fail(missing);
    return;
  }

  const staging = fs.mkdtempSync(path.join(ROOT_DIR, STAGING_PREFIX));
  try {
    // 3. The bundle, then what no page or script imports
    console.log('📦 Bundling the pages, their workers, and the service worker...');
    const bundled = await bundle({ root: ROOT_DIR, outDir: staging, mode, buildId });
    const copied = bundled.problems.length > 0 ? [] : await copyUnbundled(ROOT_DIR, staging, mode);
    const built = [...bundled.problems, ...copied];
    if (built.length > 0) {
      built.forEach(report);
      removeOutput(staging);
      fail(built);
      return;
    }
    for (const [name, file] of Object.entries(bundled.chunks)) console.log(`  ✓ ${name}: ${file}`);
    console.log(`  ✓ ${plural(Object.keys(CLASSIC_SCRIPTS).length, 'classic script')} and ${plural(STATIC_FILES.length, 'static file')} copied`);

    // 4. What the build wrote
    console.log('\n🔎 Checking the output...');
    const checked = checkOutput(staging, bundled, ROOT_DIR);
    if (checked.length > 0) {
      checked.forEach(report);
      removeOutput(staging);
      fail(checked);
      return;
    }
    console.log('  ✓ closure and preloads, remote code, CSP, notices and source maps, vendored files, environment, CommonJS, the background');

    // 5. The type gate
    console.log('\n🔍 Running the type gate...');
    const gate = await runTypeGate(ROOT_DIR);
    if (gate.problems.length > 0) {
      gate.problems.forEach(report);
      removeOutput(staging);
      fail(gate.problems);
      return;
    }
    console.log(`  ✓ ${gate.summary}`);

    // 6. The build's metadata and the module map, then dist/
    const versions = await kernelVersions(ROOT_DIR);
    const files = fromDirectory(staging, 'the build');
    const written = writeBuildInfo(staging, files, { buildId, info: source.info, mode, versions, chunks: bundled.chunks });
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(MODULE_MAP, `${JSON.stringify({ buildId: written.buildId, modules: bundled.modules }, null, 2)}\n`);
    const total = files.paths.reduce((sum, file) => sum + files.read(file).length, 0);
    fs.renameSync(staging, DIST_DIR);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`✅ Build complete in ${elapsed}s`);
    console.log(`   ${plural(files.paths.length + 2, 'file')}, ${formatBytes(total)} before build-info.json and asset-manifest.json`);
    console.log(`   buildId: ${written.buildId}`);
    console.log(`   outputDigest: ${written.outputDigest}`);
    console.log(`   Output: ${DIST_DIR}`);
    console.log('');
  } catch (error) {
    removeOutput(staging);
    throw error;
  }
}

module.exports = { build, manifestProblems, inputProblems, copyUnbundled, ARGUMENTS, DIST_DIR, MODULE_MAP };
