'use strict';

/**
 * The bundler's configuration (#27 slice 2: "Toolchain" and "Entries"). Vite runs in build
 * mode only, never as a dev server, in two passes into the same staging directory:
 *   pages       the four pages, each an HTML entry. Their module scripts and stylesheets become
 *               content-hashed chunks and CSS under assets/, and a module worker one of them
 *               starts with `new Worker(new URL('…', import.meta.url), {type: 'module'})` becomes
 *               an entry of its own.
 *   background  js/background.js, the manifest's module service worker, as one self-contained ES
 *               module at that path: nothing splits off, so nothing loads after the worker starts.
 * A script a page marks vite-ignore stays a classic script the bundler leaves alone
 * (CLASSIC_SCRIPTS), and the build copies the files no page or script imports (STATIC_FILES).
 * The pages, js/background.js, the icons, build-info.json, and the notices keep their names.
 *
 * Production minifies JavaScript with terser, keeping license comments, and CSS with
 * lightningcss. Development leaves JavaScript as the bundler writes it and still minifies CSS,
 * so a stylesheet lightningcss refuses fails both. Neither writes a source map, reads a .env
 * file, or inlines any environment variable but NODE_ENV, which is the mode.
 */

const path = require('node:path');

/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).InlineConfig} InlineConfig */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Plugin} Plugin */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Logger} Logger */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.LogOrStringHandler} LogHandler */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.RolldownLog} RolldownLog */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.LogLevel} LogLevel */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.PreRenderedAsset} PreRenderedAsset */
/** @typedef {'production' | 'development'} Mode */

/**
 * The Chrome version every API the extension uses needs: chrome.sidePanel.open,
 * chrome.runtime.getContexts, Document Picture-in-Picture, and a module service worker. The
 * manifest's minimum_chrome_version and the bundler's target both come from it.
 */
const MINIMUM_CHROME_VERSION = 116;
const TARGET = `chrome${MINIMUM_CHROME_VERSION}`;

/** The pages, by entry name: each one HTML entry */
const PAGES = Object.freeze({
  newtab: 'newtab.html',
  popup: 'popup.html',
  sidepanel: 'sidepanel.html',
  offscreen: 'offscreen.html',
});

/** The service worker's entry, which ships at the same path */
const BACKGROUND_ENTRY = 'js/background.js';

/**
 * The scripts the pages load as classic scripts, marked vite-ignore, and how each ships:
 * 'as-is', byte for byte, for the vendored libraries (their license banners included, which
 * `npm run check:notices` checks), or 'minify', with terser as a classic script, whose
 * top-level names stay the globals other scripts read. #27 slice 3 loads the libraries
 * through loadChunk instead.
 * @type {Readonly<Record<string, 'as-is' | 'minify'>>}
 */
const CLASSIC_SCRIPTS = Object.freeze({
  'js/lib/fuse.js': 'as-is',
  'js/lib/jszip.min.js': 'as-is',
  'js/lib/chart.js': 'as-is',
  'js/lib/transformers.js': 'as-is',
  'js/insights-summary.js': 'minify',
});

/**
 * Files the build copies byte for byte because no page or script imports them: the manifest,
 * the notices, Valibot's license (its code ships inside the chunks that import it), and the
 * icons the manifest and the service worker name. The icons' SVG sources stay in the repo.
 */
const STATIC_FILES = Object.freeze([
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES',
  'js/lib/valibot/LICENSE.md',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
]);

/** Where the bundler writes chunks and the assets it tracks, each content-hashed */
const ASSETS_DIR = 'assets';

/** The comments terser keeps: license headers and anything marked to keep */
const LICENSE_COMMENTS = /@preserve|@copyright|^!|license/i;

/**
 * terser's options, without `module`, which each call sets for the file it minifies. Each call
 * gets its own copy from terserOptions(), since terser writes into the objects it's given.
 */
const TERSER_OPTIONS = Object.freeze({
  compress: {
    dead_code: true,
    drop_console: false, // Keep console for debugging in production
    drop_debugger: true,
    ecma: 2020,
    passes: 2,
    pure_funcs: ['console.debug'],
  },
  mangle: {
    properties: false, // Don't mangle properties to avoid breaking DOM access
  },
  format: {
    comments: LICENSE_COMMENTS,
    ecma: 2020,
  },
  ecma: 2020,
});

/**
 * A fresh copy of TERSER_OPTIONS
 * @returns {import('terser').MinifyOptions}
 */
function terserOptions() {
  return structuredClone(/** @type {import('terser').MinifyOptions} */ (TERSER_OPTIONS));
}

/**
 * lightningcss's targets for TARGET, as Vite derives them from build.cssTarget: each version
 * is major << 16
 * @returns {{chrome: number}}
 */
function lightningcssTargets() {
  return { chrome: MINIMUM_CHROME_VERSION << 16 };
}

/**
 * Where an asset goes: an icon keeps its name under icons/, so the pages, the manifest, and the
 * service worker name one file; anything else is content-hashed under assets/
 * @param {PreRenderedAsset} asset
 * @returns {string}
 */
function assetFileName(asset) {
  const sources = asset.originalFileNames || [];
  if (sources.length > 0 && sources.every((file) => file.split(path.sep).join('/').startsWith('icons/'))) return 'icons/[name][extname]';
  return `${ASSETS_DIR}/[name]-[hash][extname]`;
}

/**
 * @typedef {object} ChunkReport
 * @property {'pages' | 'worker' | 'background'} pass
 * @property {string} fileName
 * @property {string} name
 * @property {boolean} isEntry
 * @property {boolean} isDynamicEntry
 * @property {string | null} facadeModuleId
 * @property {string[]} moduleIds
 * @property {string[]} imports
 */

/**
 * @typedef {object} BundleReport
 * @property {ChunkReport[]} chunks
 * @property {Array<{pass: string, fileName: string}>} assets
 */

/**
 * A plugin that records what each pass wrote: every chunk with the modules it holds, and every
 * asset
 * @param {BundleReport} report
 * @param {ChunkReport['pass']} pass
 * @returns {Plugin}
 */
function reportPlugin(report, pass) {
  return {
    name: 'ntn:report',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          report.chunks.push({
            pass,
            fileName: output.fileName,
            name: output.name,
            isEntry: output.isEntry,
            isDynamicEntry: output.isDynamicEntry,
            facadeModuleId: output.facadeModuleId,
            moduleIds: [...output.moduleIds],
            imports: [...output.imports],
          });
        } else {
          report.assets.push({ pass, fileName: output.fileName });
        }
      }
    },
  };
}

/**
 * terser for a module worker's chunk, which Vite builds in a bundler run of its own that its
 * terser plugin doesn't reach. The same options as every other chunk.
 * @returns {Plugin}
 */
function workerTerserPlugin() {
  return {
    name: 'ntn:worker-terser',
    async renderChunk(code, _chunk, outputOptions) {
      const { minify } = require('terser');
      const result = await minify(code, { ...terserOptions(), module: outputOptions.format === 'es' });
      if (typeof result.code !== 'string') throw new Error('terser returned no code');
      return { code: result.code, map: null };
    },
  };
}

/**
 * @typedef {object} PassOptions
 * @property {string} root - the sources
 * @property {string} outDir - the staging directory both passes write into
 * @property {Mode} mode
 * @property {BundleReport} report - what the passes wrote, filled in as they run
 * @property {Logger} logger - Vite's own warnings and errors go here
 * @property {(level: LogLevel, log: RolldownLog, handler: LogHandler) => void} onLog - and the bundler's
 */

/**
 * What both passes share
 * @param {PassOptions} options
 * @returns {InlineConfig}
 */
function common({ root, mode, logger }) {
  return {
    configFile: false,
    root,
    base: '/',
    mode,
    envDir: false,
    publicDir: false,
    logLevel: 'warn',
    customLogger: logger,
    clearScreen: false,
    define: {
      // The one value the build inlines, and never the environment's own NODE_ENV
      'process.env.NODE_ENV': JSON.stringify(mode),
      // A page has no CommonJS module. The legacy files end with `if (typeof module !==
      // 'undefined' && module.exports) {...} else { window.X = X }` for the Node tests that
      // require() them, and a file that names a free `module` the bundler wraps as CommonJS
      // and hands a module object, so the page would never get its global. As undefined, the
      // file stays an ES module and takes its browser branch, as it did unbundled.
      module: 'undefined',
    },
  };
}

/**
 * The build options both passes share
 * @param {PassOptions} options
 * @returns {NonNullable<InlineConfig['build']>}
 */
function buildOptions({ outDir, mode }) {
  return {
    outDir,
    // The staging directory starts empty, and the second pass writes beside the first
    emptyOutDir: false,
    assetsDir: ASSETS_DIR,
    target: TARGET,
    cssTarget: TARGET,
    minify: mode === 'production' ? 'terser' : false,
    terserOptions: terserOptions(),
    cssMinify: 'lightningcss',
    // Every asset stays a file the closure check can follow, nothing a data: URL
    assetsInlineLimit: 0,
    sourcemap: false,
    manifest: false,
    copyPublicDir: false,
    reportCompressedSize: false,
    // #27 slice 4's budgets gate sizes. Until then the bundler's own 500 kB warning would fail
    // every build on the new tab's chunk, so it's set past any chunk's size.
    chunkSizeWarningLimit: 1024 * 1024,
  };
}

/**
 * The bundler's checks. Its timing check warns when plugin callbacks take most of a build's
 * time, which says how busy the machine is, not what's wrong with the code, and any warning
 * fails the build, so that one is off: under load it failed five fixtures' builds.
 */
const CHECKS = Object.freeze({ bundlerTimings: false });

/**
 * The pages pass
 * @param {PassOptions} options
 * @returns {InlineConfig}
 */
function pagesConfig(options) {
  const { root, mode, report, onLog } = options;
  const names = {
    entryFileNames: `${ASSETS_DIR}/[name]-[hash].js`,
    chunkFileNames: `${ASSETS_DIR}/[name]-[hash].js`,
    assetFileNames: assetFileName,
  };
  return {
    ...common(options),
    build: {
      ...buildOptions(options),
      // Chrome 116 has modulepreload, so the polyfill would only add code
      modulePreload: { polyfill: false },
      rolldownOptions: {
        input: Object.fromEntries(Object.entries(PAGES).map(([name, file]) => [name, path.join(root, file)])),
        output: names,
        checks: { ...CHECKS },
        onLog,
      },
    },
    worker: {
      format: 'es',
      plugins: () => [reportPlugin(report, 'worker'), ...(mode === 'production' ? [workerTerserPlugin()] : [])],
      // terser minifies a worker's chunk in production (workerTerserPlugin), so the bundler
      // writes it as given: Vite leaves a worker's minify unset, and the bundler would reprint it
      rolldownOptions: { output: { ...names, minify: false }, checks: { ...CHECKS }, onLog },
    },
    plugins: [reportPlugin(report, 'pages')],
  };
}

/**
 * The background pass
 * @param {PassOptions} options
 * @returns {InlineConfig}
 */
function backgroundConfig(options) {
  const { root, report, onLog } = options;
  return {
    ...common(options),
    build: {
      ...buildOptions(options),
      modulePreload: false,
      rolldownOptions: {
        input: { background: path.join(root, BACKGROUND_ENTRY) },
        output: {
          format: 'es',
          entryFileNames: BACKGROUND_ENTRY,
          assetFileNames: assetFileName,
          // One file: whatever the graph imports, dynamically or not, is in it
          codeSplitting: false,
        },
        checks: { ...CHECKS },
        onLog,
      },
    },
    plugins: [reportPlugin(report, 'background')],
  };
}

module.exports = {
  MINIMUM_CHROME_VERSION,
  TARGET,
  PAGES,
  BACKGROUND_ENTRY,
  CLASSIC_SCRIPTS,
  STATIC_FILES,
  ASSETS_DIR,
  LICENSE_COMMENTS,
  TERSER_OPTIONS,
  terserOptions,
  lightningcssTargets,
  assetFileName,
  pagesConfig,
  backgroundConfig,
};
