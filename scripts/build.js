#!/usr/bin/env node

/**
 * Build script for New Tab Note Chrome Extension
 * Minifies JS and CSS, copies assets to dist folder
 */

const fs = require('fs');
const path = require('path');
const { minify: minifyJS } = require('terser');
const CleanCSS = require('clean-css');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SRC_DIR = ROOT_DIR;

const isDev = process.argv.includes('--dev');

// Files to process
const JS_FILES = [
  'js/utils.js',
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
  'js/app.js',
  'js/popup.js',
  'js/background.js',
  'js/offscreen.js',
];

const CSS_FILES = [
  'css/editor.css',
  'css/stats.css',
];

const HTML_FILES = [
  'newtab.html',
  'popup.html',
  'offscreen.html',
];

const STATIC_FILES = [
  'manifest.json',
];

const STATIC_DIRS = [
  'icons',
];

// Terser options for maximum compression
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
 * Minify JavaScript file
 */
async function minifyJSFile(srcPath, destPath) {
  const code = fs.readFileSync(srcPath, 'utf8');

  if (isDev) {
    // In dev mode, just copy without minification
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, code);
    return { original: code.length, minified: code.length };
  }

  try {
    const result = await minifyJS(code, TERSER_OPTIONS);
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, result.code);
    return { original: code.length, minified: result.code.length };
  } catch (error) {
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
function minifyCSSFile(srcPath, destPath) {
  const code = fs.readFileSync(srcPath, 'utf8');

  if (isDev) {
    // In dev mode, just copy without minification
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, code);
    return { original: code.length, minified: code.length };
  }

  const cleanCSS = new CleanCSS(CLEANCSS_OPTIONS);
  const result = cleanCSS.minify(code);

  if (result.errors.length > 0) {
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
  console.log(`\n🔨 Building New Tab Note Extension${isDev ? ' (dev mode)' : ''}...\n`);

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

  for (const file of JS_FILES) {
    const srcPath = path.join(SRC_DIR, file);
    const destPath = path.join(DIST_DIR, file);

    if (!fs.existsSync(srcPath)) {
      console.warn(`  ⚠️  ${file} not found, skipping`);
      continue;
    }

    const result = await minifyJSFile(srcPath, destPath);
    totalOriginal += result.original;
    totalMinified += result.minified;

    const savings = ((1 - result.minified / result.original) * 100).toFixed(1);
    const status = result.error ? '⚠️' : '✓';
    console.log(`  ${status} ${file}: ${formatBytes(result.original)} → ${formatBytes(result.minified)} (${savings}% saved)`);
  }

  // Process CSS files
  console.log('\n🎨 Processing CSS files...');
  ensureDir(path.join(DIST_DIR, 'css'));

  for (const file of CSS_FILES) {
    const srcPath = path.join(SRC_DIR, file);
    const destPath = path.join(DIST_DIR, file);

    if (!fs.existsSync(srcPath)) {
      console.warn(`  ⚠️  ${file} not found, skipping`);
      continue;
    }

    const result = minifyCSSFile(srcPath, destPath);
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
      console.warn(`  ⚠️  ${file} not found, skipping`);
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
      console.warn(`  ⚠️  ${file} not found, skipping`);
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
      console.warn(`  ⚠️  ${dir}/ not found, skipping`);
      continue;
    }

    copyDir(srcPath, destPath);
    console.log(`  ✓ ${dir}/`);
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

// Run build
build().catch(error => {
  console.error('Build failed:', error);
  process.exit(1);
});
