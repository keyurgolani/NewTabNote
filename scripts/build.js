#!/usr/bin/env node

/**
 * Build script for New Tab Note Chrome Extension
 * Minifies JS and CSS, copies assets to dist folder
 *
 *   --dev     copy JS and CSS without minifying
 *   --strict  exit 1 instead of falling back: a missing listed file or walked directory,
 *             a terser error, a file loaded both as a module and as a classic script,
 *             a CleanCSS error, and the CleanCSS level-2 to level-1 retry each name
 *             the file and the fallback refused. #27 (route-level builds) replaces it.
 *
 * Each JS file is minified the way the extension loads it (scripts/lib/script-graph.js):
 * as an ES module when a page's <script type="module"> or the module service worker
 * reaches it through static imports, or when it lives in a JS_DIRS directory, and as a
 * classic script otherwise. A module's top-level names are its own, so terser may rename
 * them; a classic script's are globals other scripts may read, so it keeps them.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { minify: minifyJS } = require('terser');
const CleanCSS = require('clean-css');
const { readScriptGraph } = require('./lib/script-graph');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SRC_DIR = ROOT_DIR;

const isDev = process.argv.includes('--dev');
const isStrict = process.argv.includes('--strict');

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
];

// Directories shipped without a list: every .js and .mjs file under each, sorted, after
// JS_FILES. Nothing else in them ships, so js/kernel/package.json (Node's "type": "module")
// stays out of dist/, and so do Valibot's index.d.mts declarations and vendor.json. Valibot's
// license ships through STATIC_FILES.
const JS_DIRS = [
  'js/kernel/',
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

// JS_FILES entries, and files a JS_DIRS walk finds, copied byte for byte instead of
// minified, such as vendored code terser can't parse. An entry ending in '/' covers every
// such file under it. js/lib/ keeps its license headers this way (Fuse.js's has no
// @license tag, so even a comment filter would drop it), and js/lib/valibot/index.mjs ships
// as Valibot publishes it; `npm run check:notices` fails if one changes.
const COPY_AS_IS = [
  'js/lib/',
];

// CSS_FILES entries that build at CleanCSS level 1 instead of level 2. CleanCSS 5.3.3's
// level-2 removeUnusedAtRules pass throws on an `animation` shorthand that uses var()
// in a sheet with @keyframes. Level 1 is what the level-2 retry always shipped for it.
const CSS_LEVEL_1 = [
  'css/premium-chat.css',
];

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

// Level-1 options, for CSS_LEVEL_1 files and the level-2 retry
const CLEANCSS_LEVEL_1_OPTIONS = { level: 1 };

/**
 * A fresh copy of TERSER_OPTIONS for one file, minified as an ES module or a classic script
 */
function terserOptions(module) {
  return { ...structuredClone(TERSER_OPTIONS), module };
}

// Fallbacks --strict refuses, recorded as { file, message }
const refused = [];

/**
 * Under --strict, record and print a fallback the build refuses, and return true.
 * Without --strict, return false so the caller falls back as before.
 */
function refuse(file, refusal, detail) {
  if (!isStrict) return false;
  const message = `${refusal}${detail ? `: ${detail}` : ''}`;
  refused.push({ file, message });
  console.error(`  ✗ ${file}: --strict ${message}`);
  return true;
}

/**
 * Warn about a missing listed file and skip it, or refuse the skip under --strict
 */
function skipMissing(label) {
  if (refuse(label, 'refused to skip a missing listed file')) return;
  console.warn(`  ⚠️  ${label} not found, skipping`);
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
 * Copy directory recursively
 */
function copyDir(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });

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
 * Minify JavaScript file, as an ES module when `module` is true
 */
async function minifyJSFile(file, srcPath, destPath, module) {
  const code = fs.readFileSync(srcPath, 'utf8');

  if (isDev) {
    // In dev mode, just copy without minification
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, code);
    return { original: code.length, minified: code.length };
  }

  if (isCopiedAsIs(file)) {
    copyFile(srcPath, destPath);
    return { original: code.length, minified: code.length, copiedAsIs: true };
  }

  try {
    const result = await minifyJS(code, terserOptions(module));
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, result.code);
    return { original: code.length, minified: result.code.length, module };
  } catch (error) {
    // terser's col is 0-based; print file:line:col the way editors count
    const at = Number.isInteger(error.line) && Number.isInteger(error.col) ? ` (${file}:${error.line}:${error.col + 1})` : '';
    if (refuse(file, 'refused to copy it unminified after a terser error', `${error.message}${at}`)) {
      return { refused: true };
    }
    console.error(`Error minifying ${srcPath}:`, error.message);
    // Fall back to copying original
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, code);
    return { original: code.length, minified: code.length, error: true };
  }
}

/**
 * Minify CSS file
 */
function minifyCSSFile(file, srcPath, destPath) {
  const code = fs.readFileSync(srcPath, 'utf8');

  if (isDev) {
    // In dev mode, just copy without minification
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, code);
    return { original: code.length, minified: code.length };
  }

  let result;
  if (CSS_LEVEL_1.includes(file)) {
    result = new CleanCSS(CLEANCSS_LEVEL_1_OPTIONS).minify(code);
  } else {
    const cleanCSS = new CleanCSS(CLEANCSS_OPTIONS);
    try {
      result = cleanCSS.minify(code);
    } catch (e) {
      if (refuse(file, 'refused the level-1 retry after a CleanCSS level-2 error', e.message)) {
        return { refused: true };
      }
      // Level-2 optimization can crash on some CSS features; fall back to level-1
      console.warn(`  ⚠️  Level-2 minification failed for ${path.basename(srcPath)}, falling back to level-1`);
      const fallbackCSS = new CleanCSS(CLEANCSS_LEVEL_1_OPTIONS);
      result = fallbackCSS.minify(code);
    }
  }

  if (result.errors.length > 0) {
    if (refuse(file, 'refused to copy it unminified after a CleanCSS error', result.errors.join('; '))) {
      return { refused: true };
    }
    console.error(`Error minifying ${srcPath}:`, result.errors);
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, code);
    return { original: code.length, minified: code.length, error: true };
  }

  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, result.styles);
  return { original: code.length, minified: result.styles.length };
}

/**
 * Process HTML file - update script/css references if needed
 */
function processHTMLFile(srcPath, destPath) {
  let html = fs.readFileSync(srcPath, 'utf8');

  // HTML files reference the same paths, so just copy
  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, html);
}

/**
 * Main build function
 */
async function build() {
  const modes = [isDev && 'dev mode', isStrict && 'strict'].filter(Boolean).join(', ');
  console.log(`\n🔨 Building New Tab Note Extension${modes ? ` (${modes})` : ''}...\n`);

  const startTime = Date.now();
  let totalOriginal = 0;
  let totalMinified = 0;

  // Clean dist directory
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true });
  }
  ensureDir(DIST_DIR);

  // Process JavaScript files
  console.log('📦 Processing JavaScript files...');
  ensureDir(path.join(DIST_DIR, 'js'));

  const walked = [];
  for (const dir of JS_DIRS) {
    const files = walkJSDir(dir);
    if (files === null) skipMissing(dir);
    else walked.push(...files.filter(file => !JS_FILES.includes(file)));
  }
  // How each page and the service worker load their scripts, so each is minified that way
  const graph = readScriptGraph(SRC_DIR, { pages: HTML_FILES });

  for (const file of [...JS_FILES, ...walked]) {
    const srcPath = path.join(SRC_DIR, file);
    const destPath = path.join(DIST_DIR, file);

    if (!fs.existsSync(srcPath)) {
      skipMissing(file);
      continue;
    }

    let module = loadsAsModule(file, graph);
    if (module === null && !isCopiedAsIs(file)) {
      if (refuse(file, 'refused to minify a file loaded both as an ES module and as a classic script')) continue;
      // A classic minify keeps top-level names, which is safe both ways
      console.warn(`  ⚠️  ${file} is loaded both as an ES module and as a classic script, minifying it as a classic script`);
    }
    module = module === true;

    const result = await minifyJSFile(file, srcPath, destPath, module);
    if (result.refused) continue;
    totalOriginal += result.original;
    totalMinified += result.minified;

    if (result.copiedAsIs) {
      console.log(`  ✓ ${file}: ${formatBytes(result.original)} (copied as is)`);
      continue;
    }

    const savings = result.original > 0 ? ((1 - result.minified / result.original) * 100).toFixed(1) : '0.0';
    const status = result.error ? '⚠️' : '✓';
    const kind = result.module ? ', module' : '';
    console.log(`  ${status} ${file}: ${formatBytes(result.original)} → ${formatBytes(result.minified)} (${savings}% saved${kind})`);
  }

  // Process CSS files
  console.log('\n🎨 Processing CSS files...');
  ensureDir(path.join(DIST_DIR, 'css'));

  for (const file of CSS_FILES) {
    const srcPath = path.join(SRC_DIR, file);
    const destPath = path.join(DIST_DIR, file);

    if (!fs.existsSync(srcPath)) {
      skipMissing(file);
      continue;
    }

    const result = minifyCSSFile(file, srcPath, destPath);
    if (result.refused) continue;
    totalOriginal += result.original;
    totalMinified += result.minified;

    const savings = ((1 - result.minified / result.original) * 100).toFixed(1);
    const status = result.error ? '⚠️' : '✓';
    console.log(`  ${status} ${file}: ${formatBytes(result.original)} → ${formatBytes(result.minified)} (${savings}% saved)`);
  }

  // Process HTML files
  console.log('\n📄 Processing HTML files...');

  for (const file of HTML_FILES) {
    const srcPath = path.join(SRC_DIR, file);
    const destPath = path.join(DIST_DIR, file);

    if (!fs.existsSync(srcPath)) {
      skipMissing(file);
      continue;
    }

    processHTMLFile(srcPath, destPath);
    console.log(`  ✓ ${file}`);
  }

  // Copy static files
  console.log('\n📋 Copying static files...');

  for (const file of STATIC_FILES) {
    const srcPath = path.join(SRC_DIR, file);
    const destPath = path.join(DIST_DIR, file);

    if (!fs.existsSync(srcPath)) {
      skipMissing(file);
      continue;
    }

    copyFile(srcPath, destPath);
    console.log(`  ✓ ${file}`);
  }

  // Copy static directories
  console.log('\n📁 Copying static directories...');

  for (const dir of STATIC_DIRS) {
    const srcPath = path.join(SRC_DIR, dir);
    const destPath = path.join(DIST_DIR, dir);

    if (!fs.existsSync(srcPath)) {
      skipMissing(`${dir}/`);
      continue;
    }

    copyDir(srcPath, destPath);
    console.log(`  ✓ ${dir}/`);
  }

  if (refused.length > 0) {
    console.error(`\n✗ Strict build failed: refused ${refused.length} fallback${refused.length === 1 ? '' : 's'}`);
    refused.forEach(({ file, message }) => console.error(`   ${file}: ${message}`));
    console.error('');
    process.exitCode = 1;
    return;
  }

  // Run JSDoc type checking (warning-only, does not block build)
  console.log('\n🔍 Running JSDoc type check...');
  try {
    execSync('npx tsc --project jsconfig.json', { cwd: ROOT_DIR, stdio: 'pipe' });
    console.log('  ✓ No type errors found');
  } catch (error) {
    const output = (error.stdout || '').toString().trim();
    const lines = output ? output.split('\n') : [];
    const errorCount = lines.filter(l => /error TS\d+/.test(l)).length;
    console.warn(`  ⚠️  ${errorCount} type warning(s) found (non-blocking)`);
    if (lines.length > 0) {
      // Show first few warnings
      lines.slice(0, 10).forEach(line => console.warn(`     ${line}`));
      if (lines.length > 10) {
        console.warn(`     ... and ${lines.length - 10} more`);
      }
    }
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const totalSavings = ((1 - totalMinified / totalOriginal) * 100).toFixed(1);

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Build complete in ${elapsed}s`);
  console.log(`   Total: ${formatBytes(totalOriginal)} → ${formatBytes(totalMinified)} (${totalSavings}% saved)`);
  console.log(`   Output: ${DIST_DIR}`);
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

// Run build when invoked as a script; tests require the lists
if (require.main === module) {
  build().catch(error => {
    console.error('Build failed:', error);
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
  COPY_AS_IS,
  CSS_LEVEL_1,
  CLEANCSS_OPTIONS,
  TERSER_OPTIONS,
  isCopiedAsIs,
  terserOptions,
};
