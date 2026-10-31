#!/usr/bin/env node

/**
 * Build script for New Tab Note Chrome Extension (#27 slice 1: verifiers on the legacy build).
 * Minifies JS and CSS and copies the rest into a staging directory, checks what it wrote, and
 * only then renames it to dist/. A problem in any mode exits 1 and leaves no dist/: nothing
 * falls back to unminified source, a lower optimization level, or a skipped input (#27,
 * "Failure rules").
 *
 *   node scripts/build.js          production build
 *   node scripts/build.js --dev    development build: JS and CSS go through terser and
 *                                  CleanCSS as in production, so they fail the same way, and
 *                                  then ship unminified
 *   --strict                       accepted and ignored: what it refused before #27 is now the
 *                                  only behavior, and CI still passes it
 *
 * In order, each step reporting every problem it finds before the build stops:
 *   1. the toolchain: Node is the version .nvmrc pins, and SOURCE_DATE_EPOCH, if set, is a number
 *   2. the inputs: each listed file minified the way the extension loads it, or copied, and the
 *      manifest checked
 *   3. the output checks on the staged files (scripts/build/): closure, remote code, CSP,
 *      notices and source maps, vendored files, and environment reads
 *   4. the type gate (scripts/build/type-gate.js)
 *   5. asset-manifest.json and build-info.json, and the rename to dist/
 * Each problem prints as `✗ [code] subject: message` (scripts/build/diagnostics.js), and the
 * summary lists them all.
 *
 * Each JS file is minified the way the extension loads it (scripts/lib/script-graph.js):
 * as an ES module when a page's <script type="module"> or the module service worker
 * reaches it through static imports, or when it lives in a JS_DIRS directory, and as a
 * classic script otherwise. A module's top-level names are its own, so terser may rename
 * them; a classic script's are globals other scripts may read, so it keeps them.
 */

const fs = require('fs');
const path = require('path');
const { minify: minifyJS } = require('terser');
const CleanCSS = require('clean-css');
const { readScriptGraph } = require('./lib/script-graph');
const { problem, format, plural } = require('./build/diagnostics.js');
const { checkNode } = require('./build/toolchain.js');
const { runTypeGate } = require('./build/type-gate.js');
const { fromDirectory } = require('./build/package-files.js');
const { checkClosure } = require('./build/closure.js');
const { checkRemoteCode } = require('./build/remote-code.js');
const { checkCsp } = require('./build/csp.js');
const { checkNoticeFiles, checkBanners, checkSourceMaps, checkVendor } = require('./build/notices.js');
const { checkEnvironment } = require('./build/environment.js');
const { sourceInfo, buildId: computeBuildId, kernelVersions, writeBuildInfo } = require('./build/build-info.js');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SRC_DIR = ROOT_DIR;
// Where a build writes before it's checked; a sibling of dist/, so the rename stays on one disk
const STAGING_PREFIX = '.dist-staging-';

const ARGUMENTS = ['--dev', '--strict'];

// Files to process
const JS_FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/core/dom-refs.js',
  'js/core/logger.js',
  'js/utils/sanitize.js',
  'js/ui/confirm-dialog.js',
  'js/ui/formatting-toolbar.js',
  'js/ui/graph-view.js',
  'js/ui/export-notice.js',
  'js/storage.js',
  'js/theme-engine.js',
  'js/virtual-scroller.js',
  'js/block-placeholders.js',
  'js/resizable-panel.js',
  'js/sidebar-utils.js',
  'js/shortcut-utils.js',
  'js/command-palette-utils.js',
  'js/ai-prompt-templates.js',
  'js/ai-response-utils.js',
  'js/insights-summary.js',
  'js/lib/fuse.js',
  'js/lib/jszip.min.js',
  'js/search.js',
  'js/image-compression.js',
  'js/blocks.js',
  'js/editor.js',
  'js/llm.js',
  'js/lib/chart.js',
  'js/analytics.js',
  'js/lib/transformers.js',
  'js/embeddings.js',
  'js/onboarding.js',
  'js/services/sync-service.js',
  'js/services/ai-port.mjs',
  'js/stream-renderer.js',
  'js/scroll-state-machine.js',
  'js/chat-ui-components.js',
  'js/controllers/sidebar-controller.js',
  'js/controllers/tab-controller.js',
  'js/controllers/ai-chat-controller.js',
  'js/controllers/settings-controller.js',
  'js/controllers/theme-builder-controller.js',
  'js/controllers/analytics-controller.js',
  'js/controllers/notes-manager.js',
  'js/controllers/shortcuts-manager.js',
  'js/controllers/export-import-service.js',
  'js/app.js',
  'js/main.js',
  'js/popup.js',
  'js/sidepanel.js',
  'js/background.js',
  'js/offscreen.js',
  // The search indexer, which NotesManager.initIndexer and App.initIndexer start with
  // new Worker('js/workers/indexer.js'). Before #27 it shipped only in unpacked source loads.
  'js/workers/indexer.js',
];

// Directories shipped without a list: every .js and .mjs file under each, sorted, after
// JS_FILES. Nothing else in them ships, so js/kernel/package.json and js/trust/package.json
// (Node's "type": "module") stay out of dist/, and so do Valibot's index.d.mts declarations
// and vendor.json. Valibot's license ships through STATIC_FILES. js/trust/ is #20's trust
// core, which the worker imports and the new tab loads with import() on its first failure.
const JS_DIRS = [
  'js/kernel/',
  'js/trust/',
  'js/lib/valibot/',
];

const CSS_FILES = [
  'css/editor.css',
  'css/premium-chat.css',
  'css/stats.css',
];

const HTML_FILES = [
  'newtab.html',
  'popup.html',
  'sidepanel.html',
  'offscreen.html',
];

const STATIC_FILES = [
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES',
  'js/lib/valibot/LICENSE.md',
];

const STATIC_DIRS = [
  'icons',
];

// What the build reads besides its lists and the files they name: the toolchain pin, the
// lockfile, the type gate's projects and baseline, the reviewed lists the checks read, and
// the build code. A copy of the tree with these and the listed files builds as this one does.
const BUILD_INPUTS = [
  '.nvmrc',
  'package.json',
  'package-lock.json',
  'jsconfig.json',
  'tsconfig.kernel.json',
  'tsconfig.strict.json',
  'ci',
  'build',
  'scripts',
];

// JS_FILES entries, and files a JS_DIRS walk finds, copied byte for byte instead of
// minified, such as vendored code terser can't parse. An entry ending in '/' covers every
// such file under it. js/lib/ keeps its license headers this way (Fuse.js's has no
// @license tag, so even a comment filter would drop it), and js/lib/valibot/index.mjs ships
// as Valibot publishes it; `npm run check:notices` fails if one changes.
const COPY_AS_IS = [
  'js/lib/',
];

// CSS_FILES entries that build at CleanCSS level 1 instead of level 2, a reviewed list and
// not a fallback: a level-2 error on any other file fails the build. CleanCSS 5.3.3's
// level-2 removeUnusedAtRules pass throws on an `animation` shorthand that uses var() in a
// sheet with @keyframes. Level 1 is what the level-2 retry always shipped for it.
const CSS_LEVEL_1 = [
  'css/premium-chat.css',
];

// The Chrome version every API the extension uses needs: chrome.sidePanel.open,
// chrome.runtime.getContexts, Document Picture-in-Picture, and a module service worker
const MINIMUM_CHROME_VERSION = 116;

// Terser options for maximum compression. terser writes into the nested objects it's
// given (module: true lands in compress and mangle), so each call gets its own copy
// from terserOptions().
const TERSER_OPTIONS = {
  compress: {
    dead_code: true,
    drop_console: false, // Keep console for debugging in production
    drop_debugger: true,
    ecma: 2020,
    passes: 2,
    pure_funcs: ['console.debug'],
    unsafe_arrows: true,
    unsafe_methods: true,
  },
  mangle: {
    properties: false, // Don't mangle properties to avoid breaking DOM access
  },
  format: {
    comments: false,
    ecma: 2020,
  },
  ecma: 2020,
};

// CleanCSS options
const CLEANCSS_OPTIONS = {
  level: {
    1: {
      all: true,
    },
    2: {
      all: true,
      mergeAdjacentRules: true,
      mergeIntoShorthands: true,
      mergeMedia: true,
      mergeNonAdjacentRules: true,
      mergeSemantically: true,
      removeEmpty: true,
      reduceNonAdjacentRules: true,
      removeDuplicateFontRules: true,
      removeDuplicateMediaBlocks: true,
      removeDuplicateRules: true,
      restructureRules: true,
    },
  },
};

// Level-1 options, for CSS_LEVEL_1 files
const CLEANCSS_LEVEL_1_OPTIONS = { level: 1 };

/**
 * A fresh copy of TERSER_OPTIONS for one file, minified as an ES module or a classic script
 */
function terserOptions(module) {
  return { ...structuredClone(TERSER_OPTIONS), module };
}

/**
 * Whether a JS_FILES entry is copied byte for byte (see COPY_AS_IS)
 */
function isCopiedAsIs(file, list = COPY_AS_IS) {
  return list.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

/**
 * Every .js and .mjs file under a JS_DIRS entry, sorted, or null when it's missing
 */
function walkJSDir(dir) {
  const top = path.join(SRC_DIR, dir);
  if (!fs.existsSync(top)) return null;
  const files = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.m?js$/.test(entry.name)) files.push(path.relative(SRC_DIR, full).split(path.sep).join('/'));
    }
  };
  walk(top);
  return files.sort();
}

/**
 * Whether terser treats `file` as an ES module: true when the extension loads it as one,
 * false for a classic script, or null when it's loaded both ways
 */
function loadsAsModule(file, graph) {
  const module = graph.modules.has(file) || JS_DIRS.some(dir => file.startsWith(dir));
  if (module && graph.classic.has(file)) return null;
  return module;
}

/**
 * Ensure directory exists
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Copy file
 */
function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/**
 * Copy directory recursively, in sorted order
 */
function copyDir(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

/**
 * Minify a JavaScript file, as an ES module when `module` is true. In dev mode terser still
 * runs, so a file it can't minify fails there too, and the source ships as written.
 */
async function minifyJSFile(file, srcPath, destPath, module, isDev) {
  const code = fs.readFileSync(srcPath, 'utf8');

  if (isCopiedAsIs(file)) {
    copyFile(srcPath, destPath);
    return { original: code.length, minified: code.length, copiedAsIs: true };
  }

  let result;
  try {
    result = await minifyJS(code, terserOptions(module));
  } catch (error) {
    // terser's col is 0-based; print file:line:col the way editors count
    const at = Number.isInteger(error.line) && Number.isInteger(error.col) ? ` (${file}:${error.line}:${error.col + 1})` : '';
    return { problem: problem('build/terser', file, `refused to copy it unminified after a terser error: ${error.message}${at}`) };
  }
  const output = isDev ? code : result.code;
  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, output);
  return { original: code.length, minified: output.length, module };
}

/**
 * Minify a CSS file at level 2, or at level 1 when CSS_LEVEL_1 lists it. Any CleanCSS error or
 * throw fails it, in dev mode too, where the source then ships as written.
 */
function minifyCSSFile(file, srcPath, destPath, isDev) {
  const code = fs.readFileSync(srcPath, 'utf8');
  const levelOne = CSS_LEVEL_1.includes(file);

  let result;
  try {
    result = new CleanCSS(levelOne ? CLEANCSS_LEVEL_1_OPTIONS : CLEANCSS_OPTIONS).minify(code);
  } catch (e) {
    const refusal = levelOne ? 'refused to copy it unminified after a CleanCSS level-1 error' : 'refused the level-1 retry after a CleanCSS level-2 error';
    return { problem: problem('build/css', file, `${refusal}: ${e.message}`) };
  }

  if (result.errors.length > 0) {
    return { problem: problem('build/css', file, `refused to copy it unminified after a CleanCSS error: ${result.errors.join('; ')}`) };
  }

  const output = isDev ? code : result.styles;
  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, output);
  return { original: code.length, minified: output.length };
}

/**
 * Problems with manifest.json: it parses, is Manifest V3 with a name, a version, and a service
 * worker, and asks for at least MINIMUM_CHROME_VERSION
 */
function manifestProblems(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return [problem('build/manifest', 'manifest.json', `doesn't parse: ${error.message}`)];
  }
  const problems = [];
  const fail = message => problems.push(problem('build/manifest', 'manifest.json', message));
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
 */
function report(found) {
  console.error(`  ✗ ${format(found)}`);
  for (const line of found.details || []) console.error(`      ${line}`);
}

/**
 * Process the listed inputs into `outDir`. Returns the problems and the byte totals.
 */
async function processInputs(outDir, isDev) {
  const problems = [];
  const missing = label => problems.push(problem('build/missing-input', label, 'refused to skip a missing listed file'));
  let totalOriginal = 0;
  let totalMinified = 0;

  console.log('📦 Processing JavaScript files...');
  const walked = [];
  for (const dir of JS_DIRS) {
    const files = walkJSDir(dir);
    if (files === null) missing(dir);
    else walked.push(...files.filter(file => !JS_FILES.includes(file)));
  }
  // How each page and the service worker load their scripts, so each is minified that way
  const graph = readScriptGraph(SRC_DIR, { pages: HTML_FILES });

  for (const file of [...JS_FILES, ...walked]) {
    const srcPath = path.join(SRC_DIR, file);
    const destPath = path.join(outDir, file);

    if (!fs.existsSync(srcPath)) {
      missing(file);
      continue;
    }

    const module = loadsAsModule(file, graph);
    if (module === null && !isCopiedAsIs(file)) {
      problems.push(problem('build/load-mode', file, 'refused to minify a file loaded both as an ES module and as a classic script'));
      continue;
    }

    const result = await minifyJSFile(file, srcPath, destPath, module === true, isDev);
    if (result.problem) {
      problems.push(result.problem);
      continue;
    }
    totalOriginal += result.original;
    totalMinified += result.minified;

    if (result.copiedAsIs) {
      console.log(`  ✓ ${file}: ${formatBytes(result.original)} (copied as is)`);
      continue;
    }

    const savings = result.original > 0 ? ((1 - result.minified / result.original) * 100).toFixed(1) : '0.0';
    const kind = result.module ? ', module' : '';
    console.log(`  ✓ ${file}: ${formatBytes(result.original)} → ${formatBytes(result.minified)} (${savings}% saved${kind})`);
  }

  console.log('\n🎨 Processing CSS files...');
  for (const file of CSS_FILES) {
    const srcPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(srcPath)) {
      missing(file);
      continue;
    }
    const result = minifyCSSFile(file, srcPath, path.join(outDir, file), isDev);
    if (result.problem) {
      problems.push(result.problem);
      continue;
    }
    totalOriginal += result.original;
    totalMinified += result.minified;
    const savings = result.original > 0 ? ((1 - result.minified / result.original) * 100).toFixed(1) : '0.0';
    console.log(`  ✓ ${file}: ${formatBytes(result.original)} → ${formatBytes(result.minified)} (${savings}% saved)`);
  }

  // HTML files reference the same paths, so they're copied
  console.log('\n📄 Processing HTML files...');
  for (const file of HTML_FILES) {
    const srcPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(srcPath)) {
      missing(file);
      continue;
    }
    copyFile(srcPath, path.join(outDir, file));
    console.log(`  ✓ ${file}`);
  }

  console.log('\n📋 Copying static files...');
  for (const file of STATIC_FILES) {
    const srcPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(srcPath)) {
      missing(file);
      continue;
    }
    if (file === 'manifest.json') problems.push(...manifestProblems(fs.readFileSync(srcPath, 'utf8')));
    copyFile(srcPath, path.join(outDir, file));
    console.log(`  ✓ ${file}`);
  }

  console.log('\n📁 Copying static directories...');
  for (const dir of STATIC_DIRS) {
    const srcPath = path.join(SRC_DIR, dir);
    if (!fs.existsSync(srcPath)) {
      missing(`${dir}/`);
      continue;
    }
    copyDir(srcPath, path.join(outDir, dir));
    console.log(`  ✓ ${dir}/`);
  }

  problems.forEach(report);
  return { problems, totalOriginal, totalMinified };
}

/**
 * Every output check on the staged build, which reads only the files it holds
 */
function checkOutput(outDir) {
  const files = fromDirectory(outDir, 'the build');
  const problems = [
    ...checkClosure(files).problems,
    ...checkRemoteCode(files),
    ...checkCsp(files),
    ...checkNoticeFiles(files),
    ...checkBanners(files),
    ...checkSourceMaps(files),
    ...checkVendor(files),
    ...checkEnvironment(files),
  ];
  problems.forEach(report);
  return problems;
}

/**
 * Leave no build behind: the staging directory and any dist/
 */
function removeOutput(staging) {
  if (staging) fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}

/**
 * Print the summary of a failed build and set the exit code
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
 * Main build function
 */
async function build(argv = process.argv.slice(2)) {
  const unknown = argv.filter(arg => !ARGUMENTS.includes(arg));
  if (unknown.length > 0) {
    fail([problem('build/usage', unknown.join(' '), `usage: node scripts/build.js [--dev] [--strict]`)]);
    return;
  }
  const isDev = argv.includes('--dev');
  const mode = isDev ? 'development' : 'production';
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

  const staging = fs.mkdtempSync(path.join(ROOT_DIR, STAGING_PREFIX));
  try {
    // 2. The inputs
    const inputs = await processInputs(staging, isDev);
    if (inputs.problems.length > 0) {
      removeOutput(staging);
      fail(inputs.problems);
      return;
    }

    // 3. What the build wrote
    console.log('\n🔎 Checking the output...');
    const checked = checkOutput(staging);
    if (checked.length > 0) {
      removeOutput(staging);
      fail(checked);
      return;
    }
    console.log('  ✓ closure, remote code, CSP, notices and source maps, vendored files, environment');

    // 4. The type gate
    console.log('\n🔍 Running the type gate...');
    const gate = await runTypeGate(ROOT_DIR);
    if (gate.problems.length > 0) {
      gate.problems.forEach(report);
      removeOutput(staging);
      fail(gate.problems);
      return;
    }
    console.log(`  ✓ ${gate.summary}`);

    // 5. The build's metadata, then dist/
    const versions = await kernelVersions(ROOT_DIR);
    const written = writeBuildInfo(staging, fromDirectory(staging, 'the build'), { buildId, info: source.info, mode, versions });
    fs.renameSync(staging, DIST_DIR);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const totalSavings = inputs.totalOriginal > 0 ? ((1 - inputs.totalMinified / inputs.totalOriginal) * 100).toFixed(1) : '0.0';
    console.log('\n' + '─'.repeat(50));
    console.log(`✅ Build complete in ${elapsed}s`);
    console.log(`   Total: ${formatBytes(inputs.totalOriginal)} → ${formatBytes(inputs.totalMinified)} (${totalSavings}% saved)`);
    console.log(`   buildId: ${written.buildId}`);
    console.log(`   outputDigest: ${written.outputDigest}`);
    console.log(`   Output: ${DIST_DIR}`);
    console.log('');
  } catch (error) {
    removeOutput(staging);
    throw error;
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Run build when invoked as a script; tests require the lists
if (require.main === module) {
  build().catch(error => {
    console.error(`\n✗ Build failed: ${error && error.stack ? error.stack : error}. No dist/ was written.`);
    process.exit(1);
  });
}

module.exports = {
  JS_FILES,
  JS_DIRS,
  CSS_FILES,
  HTML_FILES,
  STATIC_FILES,
  STATIC_DIRS,
  BUILD_INPUTS,
  COPY_AS_IS,
  CSS_LEVEL_1,
  CLEANCSS_OPTIONS,
  TERSER_OPTIONS,
  MINIMUM_CHROME_VERSION,
  isCopiedAsIs,
  terserOptions,
  manifestProblems,
};
