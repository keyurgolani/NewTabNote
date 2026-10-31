'use strict';

/**
 * The bundler's configuration (#27 slice 2: "Toolchain" and "Entries"). Vite runs in build
 * mode only, never as a dev server, in three passes into the same staging directory:
 *   pages       the four pages, each an HTML entry. Their module scripts and stylesheets become
 *               content-hashed chunks and CSS under assets/, and a module worker one of them
 *               starts with `new Worker(new URL('…', import.meta.url), {type: 'module'})` becomes
 *               an entry of its own.
 *   background  js/background.js, the manifest's module service worker, as one self-contained ES
 *               module at that path: nothing splits off, so nothing loads after the worker starts.
 *   guard       js/network-guard.js, the network guard each page loads as its first script (#21
 *               slice 1b), as one self-contained classic script at that path, the destination
 *               registry inlined, so the page is guarded before its next script runs.
 * A script a page marks vite-ignore, and a vendored library the loader puts in, stays a classic
 * script the bundler leaves alone (CLASSIC_SCRIPTS), and the build copies the files no page or
 * script imports (STATIC_FILES). The pages, js/background.js, the boot guard, the loader, the
 * icons, build-info.json, and the notices keep their names.
 *
 * Production minifies JavaScript with terser, keeping license comments, and CSS with
 * lightningcss. Development leaves JavaScript as the bundler writes it and still minifies CSS,
 * so a stylesheet lightningcss refuses fails both. Neither writes a source map, reads a .env
 * file, or inlines any environment variable but NODE_ENV, which is the mode. Each inlines the
 * build's ID, which the loader compares with build-info.json's (#27 slice 3).
 */

const fs = require('node:fs');
const path = require('node:path');

/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).InlineConfig} InlineConfig */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Plugin} Plugin */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Logger} Logger */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.LogOrStringHandler} LogHandler */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.RolldownLog} RolldownLog */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.LogLevel} LogLevel */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.PreRenderedAsset} PreRenderedAsset */
/** @typedef {import('vite', { with: { 'resolution-mode': 'import' } }).Rolldown.PreRenderedChunk} PreRenderedChunk */
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
 * The scripts that run as classic scripts, which the pages pass leaves alone, and how each
 * ships: 'as-is', byte for byte, for the vendored libraries the loader puts in at their first
 * use (js/runtime/lazy.js, #27 slice 3), their license banners included, which
 * `npm run check:notices` checks; 'minify', with terser as a classic script, whose top-level
 * names stay the globals other scripts read, for the ones a page loads with
 * <script vite-ignore src>: the new tab's boot guard and the side panel's insights summary; or
 * 'bundle', for the network guard, a module source the guard pass bundles into a classic script
 * at its own path (#21 slice 1b), which every page loads first.
 * @type {Readonly<Record<string, 'as-is' | 'minify' | 'bundle'>>}
 */
const CLASSIC_SCRIPTS = Object.freeze({
  'js/lib/fuse.js': 'as-is',
  'js/lib/jszip.min.js': 'as-is',
  'js/lib/chart.js': 'as-is',
  'js/lib/transformers.js': 'as-is',
  'js/entries/boot-guard.js': 'minify',
  'js/insights-summary.js': 'minify',
  'js/network-guard.js': 'bundle',
});

/** The network guard each page loads first, which the guard pass bundles (#21 slice 1b) */
const GUARD_SCRIPT = 'js/network-guard.js';

/** The registry's rows as the sources import them, which the guard pass inlines cut */
const ROWS_MODULE = 'js/kernel/composition/destination-rows.js';

/**
 * The page's loader (#27 slice 3), which ships at its own path as a chunk of its own, so the
 * closure check knows the one file it lets build a path at run time (scripts/build/closure.js)
 */
const LOADER = 'js/runtime/lazy.js';

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
 * @property {'pages' | 'worker' | 'background' | 'guard'} pass
 * @property {string} fileName
 * @property {string} name
 * @property {boolean} isEntry
 * @property {boolean} isDynamicEntry
 * @property {string | null} facadeModuleId
 * @property {string[]} moduleIds
 * @property {string[]} imports
 * @property {string[]} dynamicImports - the chunks its import() calls load
 * @property {string[]} importedCss - the stylesheets Vite loads with it
 * @property {string[]} commonJs - the modules the bundler wrapped as CommonJS, by id
 */

/**
 * @typedef {object} BundleReport
 * @property {ChunkReport[]} chunks
 * @property {Array<{pass: string, fileName: string}>} assets
 */

/**
 * The call to the bundler's CommonJS wrapper in a module as the bundler rendered it, before
 * terser renames it: `var require_x = __commonJSMin((exports, module) => {...})`, the helper
 * renamed with a $n suffix when the module has a name of its own like it
 */
const COMMONJS_WRAPPER = /\b__commonJS(?:Min)?(?:\$\d+)?\(/;

/**
 * A plugin that records what each pass wrote: every chunk with the modules it holds and the ones
 * the bundler wrapped as CommonJS, and every asset
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
            dynamicImports: [...(output.dynamicImports || [])],
            // Vite's metadata on the chunk: the CSS it injects with it (#27 slice 4b's analyzer)
            importedCss: [.../** @type {{viteMetadata?: {importedCss?: Set<string>}}} */ (/** @type {unknown} */ (output)).viteMetadata?.importedCss ?? []],
            // The bundler's own runtime module defines the wrapper; a module it wraps calls it
            commonJs: Object.entries(output.modules || {})
              .filter(([id, rendered]) => !id.includes('\0') && COMMONJS_WRAPPER.test((rendered && rendered.code) || ''))
              .map(([id]) => id),
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
 * @property {string} buildId - the build's, which the loader carries (build-info.js's buildId)
 * @property {BundleReport} report - what the passes wrote, filled in as they run
 * @property {Logger} logger - Vite's own warnings and errors go here
 * @property {(level: LogLevel, log: RolldownLog, handler: LogHandler) => void} onLog - and the bundler's
 * @property {unknown} [guardRows] - for the guard pass: the registry's rows, validated
 *   and cut to what the guard reads (scripts/build/guard.js's guardRegistry)
 */

/**
 * What both passes share
 * @param {PassOptions} options
 * @returns {InlineConfig}
 */
function common({ root, mode, buildId, logger }) {
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
      // The one environment value the build inlines, and never the environment's own NODE_ENV
      'process.env.NODE_ENV': JSON.stringify(mode),
      // The build's ID, from its inputs alone: the loader tells an update under the page by a
      // build-info.json with another (js/runtime/lazy.js)
      __NTN_BUILD_ID__: JSON.stringify(buildId),
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
 * The ids the bundler may give the loader's module: its path under the sources, and under their
 * real path, as a temporary directory's comes on macOS (/var is /private/var)
 * @param {string} root
 * @returns {Set<string>}
 */
function loaderIds(root) {
  const ids = new Set([path.join(root, LOADER)]);
  try {
    ids.add(path.join(fs.realpathSync(root), LOADER));
  } catch {
    // Sources that aren't there, as a test's, have no real path
  }
  return ids;
}

/**
 * Where the pages pass writes a chunk that's no entry: the loader's at the loader's own path,
 * any other under assets/, content-hashed
 * @param {string} root
 * @returns {(chunk: PreRenderedChunk) => string}
 */
function chunkFileName(root) {
  const ids = loaderIds(root);
  return (chunk) => (chunk.moduleIds.length === 1 && ids.has(chunk.moduleIds[0]) ? LOADER : `${ASSETS_DIR}/[name]-[hash].js`);
}

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
  const loader = loaderIds(root);
  return {
    ...common(options),
    build: {
      ...buildOptions(options),
      // Chrome 116 has modulepreload, so the polyfill would only add code
      modulePreload: { polyfill: false },
      rolldownOptions: {
        input: Object.fromEntries(Object.entries(PAGES).map(([name, file]) => [name, path.join(root, file)])),
        output: {
          ...names,
          chunkFileNames: chunkFileName(root),
          // The loader alone in a chunk, whichever chunks import it (#27 slice 3)
          codeSplitting: { groups: [{ name: 'loader', test: (id) => loader.has(id) }] },
        },
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

/**
 * A plugin that hands the guard pass `rows` for the registry's rows module, so the page guard
 * carries only what it reads, and no validator: the build validated them first
 * @param {string} root
 * @param {unknown} rows
 * @returns {Plugin}
 */
function guardRowsPlugin(root, rows) {
  const ids = new Set([path.join(root, ROWS_MODULE)]);
  try {
    ids.add(path.join(fs.realpathSync(root), ROWS_MODULE));
  } catch {
    // Sources that aren't there have no real path
  }
  return {
    name: 'ntn:guard-rows',
    load(id) {
      return ids.has(id) ? `export const DESTINATION_ROWS = ${JSON.stringify(rows)};\n` : null;
    },
  };
}

/**
 * The guard pass
 * @param {PassOptions} options
 * @returns {InlineConfig}
 */
function guardConfig(options) {
  const { root, report, onLog, guardRows = null } = options;
  if (guardRows === null) throw new Error('the guard pass needs the registry rows it inlines');
  return {
    ...common(options),
    build: {
      ...buildOptions(options),
      modulePreload: false,
      rolldownOptions: {
        input: { 'network-guard': path.join(root, GUARD_SCRIPT) },
        output: {
          format: 'iife',
          entryFileNames: GUARD_SCRIPT,
          assetFileNames: assetFileName,
          // One classic script: the registry and everything the guard imports are in it
          codeSplitting: false,
        },
        checks: { ...CHECKS },
        onLog,
      },
    },
    plugins: [guardRowsPlugin(root, guardRows), reportPlugin(report, 'guard')],
  };
}

module.exports = {
  MINIMUM_CHROME_VERSION,
  TARGET,
  PAGES,
  BACKGROUND_ENTRY,
  CLASSIC_SCRIPTS,
  GUARD_SCRIPT,
  ROWS_MODULE,
  LOADER,
  STATIC_FILES,
  ASSETS_DIR,
  LICENSE_COMMENTS,
  TERSER_OPTIONS,
  terserOptions,
  lightningcssTargets,
  assetFileName,
  chunkFileName,
  pagesConfig,
  backgroundConfig,
  guardConfig,
};
