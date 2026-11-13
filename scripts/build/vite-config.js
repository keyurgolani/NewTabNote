'use strict';

/**
 * The bundler's configuration (#27 slice 2: "Toolchain" and "Entries"). Vite runs in build
 * mode only, never as a dev server, in four passes into the same staging directory:
 *   pages       the new tab, Popup, Side Panel and offscreen pages, each an HTML entry. Their
 *               module scripts and stylesheets become content-hashed chunks and CSS under assets/,
 *               what the first three share at their start in two named chunks, host and adapter
 *               (scripts/build/page-chunks.js), and a module worker one of them starts with `new
 *               Worker(new URL('…', import.meta.url), {type: 'module'})` becomes an entry of its own.
 *   recovery    recovery.html, with the pages pass's settings, in a pass of its own
 *               (OWN_PASS_PAGES), so it splits no chunk the other pages share.
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
 * build's ID, which the loader compares with build-info.json's (#27 slice 3), and each
 * build/define-allowlist.json row at the mode's value (#300), and nothing else.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pageChunkGroups } = require('./page-chunks.js');
const { defineValues } = require('./define-allowlist.js');
const { highestVersion, readTable } = require('./chrome-features.js');

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
 * The Chrome version every feature the extension uses needs: build/chrome-features.json's highest
 * row (#300). The bundler's target comes from it, and the manifest's minimum_chrome_version has to
 * be at least it (scripts/build/chrome-features.js). A table that doesn't read gives 0, and the
 * build stops at chrome/file before it bundles.
 */
const MINIMUM_CHROME_VERSION = highestVersion(readTable().rows);
const TARGET = `chrome${MINIMUM_CHROME_VERSION}`;

/** The pages, by entry name: each one HTML entry */
const PAGES = Object.freeze({
  newtab: 'newtab.html',
  popup: 'popup.html',
  sidepanel: 'sidepanel.html',
  offscreen: 'offscreen.html',
  recovery: 'recovery.html',
});

/**
 * The pages built in a pass of their own (#115's D, ruling 5): recovery.html's start shares much
 * of the kernel with the new tab's, Popup's and Side Panel's, and in one pass the bundler splits
 * each chunk they share by which pages load each module, which cost those pages files and the
 * compression they shared. In its own pass it carries its own copy of what it imports, and the
 * pages pass builds the others as it did before it
 */
const OWN_PASS_PAGES = Object.freeze(['recovery']);

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
 * #14's block core, which recovery.html's own pass writes as a chunk of its own, `blocks`
 * (#115's review): what only the block registry (js/kernel/composition/blocks.js) and the
 * projections the new tab's legacy scripts read (js/kernel/composition/block-projections.js)
 * import, html-text.js's tokenizer and its named character references among them. In the pages
 * pass only the new tab reaches the core, through its workspace chunk, which keeps it: a chunk of
 * its own there cost the new tab's start about 620 bytes gzip (#27). THIRD_PARTY_NOTICES' In: line
 * names both, so their names have to hold whichever pages share them.
 */
const BLOCK_CORE = 'js/kernel/core/blocks';
const BLOCK_ROOTS = Object.freeze(['js/kernel/composition/blocks.js', 'js/kernel/composition/block-projections.js']);

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
  'icons/icon32.png',
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
 * @property {number} [bytes] - its code in UTF-8 bytes as its pass wrote it: the bundler's own
 *   chunk-size measure (scripts/build/warning-allowlist.js)
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
    // What the bundler's chunk-size warning measures, read where it reads it: each JS chunk's code
    // in UTF-8 bytes as the pass writes its output (#321's review)
    writeBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        const recorded = output.type === 'chunk' ? report.chunks.find((chunk) => chunk.pass === pass && chunk.fileName === output.fileName && chunk.bytes === undefined) : undefined;
        if (recorded && output.type === 'chunk') recorded.bytes = Buffer.byteLength(output.code);
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
 * @property {string} outDir - the staging directory every pass writes into
 * @property {Mode} mode
 * @property {string} buildId - the build's, which the loader carries (build-info.js's buildId)
 * @property {Record<string, import('./define-allowlist.js').DefineRow>} defineRows - build/define-allowlist.json's
 *   rows, read and checked (scripts/build/define-allowlist.js), which every pass inlines at the mode's value
 * @property {BundleReport} report - what the passes wrote, filled in as they run
 * @property {Logger} logger - Vite's own warnings and errors go here
 * @property {(level: LogLevel, log: RolldownLog, handler: LogHandler) => void} onLog - and the bundler's
 * @property {(id: string) => boolean} [sideEffects] - the bundler's moduleSideEffects: whether a module
 *   keeps its side effects when nothing takes anything from it (scripts/build/bundle.js's sideEffectsFor, #300)
 * @property {unknown} [guardRows] - for the guard pass: the registry's rows, validated
 *   and cut to what the guard reads (scripts/build/guard.js's guardRegistry)
 */

/**
 * What every pass shares
 * @param {PassOptions} options
 * @returns {InlineConfig}
 */
function common({ root, mode, buildId, logger, defineRows }) {
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
      // build/define-allowlist.json's rows, each __NTN_<name>__ at the mode's value. No row's name
      // is one of the three keys below, and they come after the rows all the same.
      ...defineValues(mode, defineRows),
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
 * The build options every pass shares
 * @param {PassOptions} options
 * @returns {NonNullable<InlineConfig['build']>}
 */
function buildOptions({ outDir, mode }) {
  return {
    outDir,
    // The staging directory starts empty, and each pass writes beside the ones before it
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
  };
}

/**
 * The bundler's checks. Its timing check warns when plugin callbacks take most of a build's
 * time, which says how busy the machine is, not what's wrong with the code, and any warning
 * no row allows fails the build, so that one is off: under load it failed five fixtures' builds.
 */
const CHECKS = Object.freeze({ bundlerTimings: false });

/**
 * Each pass's tree shaking: the bundler's own, with moduleSideEffects from the build when it gives
 * one, so a module nothing takes anything from keeps its side effects only as the build says (#27's
 * Architecture, #300)
 * @param {PassOptions} options
 * @returns {{treeshake?: {moduleSideEffects: (id: string) => boolean}}}
 */
function treeshakeOf({ sideEffects }) {
  return sideEffects ? { treeshake: { moduleSideEffects: sideEffects } } : {};
}

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
 * The name of the block core's chunk for a module in it, or null for one that isn't: a module of
 * the block core whose every importer is one of the block roots or a module of the core's chunk
 * itself. A block module anything else imports, as the note domain does its previews and wiki
 * links, stays in the chunks that hold what imports it, and so does each block module only it
 * imports, so the Popup and the Side Panel never load the core. Only recovery.html's pass of one
 * page writes the chunk, and there it takes these modules' dependencies too (recoveryConfig).
 * @param {string} root
 * @returns {(id: string, ctx: {getModuleInfo(id: string): {importers: readonly string[]} | null}) => string | null}
 */
function blockCoreChunk(root) {
  const roots = [root];
  try {
    roots.push(fs.realpathSync(root));
  } catch {
    // Sources that aren't there, as a test's, have no real path
  }
  const dirs = roots.map((at) => path.join(at, BLOCK_CORE) + path.sep);
  const entries = new Set(roots.flatMap((at) => BLOCK_ROOTS.map((file) => path.join(at, file))));
  /**
   * @param {string} id
   * @param {{getModuleInfo(id: string): {importers: readonly string[]} | null}} ctx
   * @param {Set<string>} visiting - the modules above this one in the walk, where a cycle
   *   inside the core counts as the core's, so only an importer outside it decides
   * @returns {boolean}
   */
  const inCore = (id, ctx, visiting) => {
    if (visiting.has(id)) return true;
    if (!dirs.some((dir) => id.startsWith(dir))) return false;
    const info = ctx.getModuleInfo(id);
    if (!info || info.importers.length === 0) return false;
    visiting.add(id);
    const only = info.importers.every((importer) => entries.has(importer) || inCore(importer, ctx, visiting));
    visiting.delete(id);
    return only;
  };
  return (id, ctx) => (inCore(id, ctx, new Set()) ? 'blocks' : null);
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
 * The files of close-drafts-applier, close-drafts-chunk, journal-chunk and Side Panel's and the
 * new tab's send chunks, which the pages import only with import()
 */
const UNPRELOADED_CHUNKS =
  /(?:^|\/)(?:close-drafts-applier|close-drafts-chunk|journal-chunk|sidepanel-send-chunk|newtab-send-chunk)-[A-Za-z0-9_-]+\.js$/;

/**
 * The files the bundler preloads beside a dynamic import, or beside a page's entry: none beside
 * close-drafts-applier, which the new tab, Popup and Side Panel import on a start that finds work
 * for it (#33, #6, composition/close-drafts.js), or beside close-drafts-chunk, which it imports,
 * or beside journal-chunk, which Side Panel imports at idle (#35 slice 3b, composition/host.js)
 * and the send chunks with them, or beside Side Panel's send chunk, which it imports at its first
 * command (#35 slice 4c), or beside the new tab's, which it imports at its first command or at
 * idle (#35 slice 4d), so no page's start carries a preload list for any of them, and every other
 * import's own (the lead's trim 2).
 * A start that loads one then loads its files one after another, which the lead takes.
 * @param {string} filename - the file imported, or the page's entry
 * @param {string[]} deps
 * @returns {string[]}
 */
function preloadsFor(filename, deps) {
  return UNPRELOADED_CHUNKS.test(filename) ? [] : deps;
}

/**
 * The pages pass: every page but OWN_PASS_PAGES', with the host and adapter chunks
 * @param {PassOptions} options
 * @returns {InlineConfig}
 */
function pagesConfig(options) {
  return pagePassConfig(options, Object.keys(PAGES).filter((page) => !OWN_PASS_PAGES.includes(page)), { pageChunks: true });
}

/**
 * recovery.html's pass (OWN_PASS_PAGES): the pages pass's settings, for that page alone
 * @param {PassOptions} options
 * @returns {InlineConfig}
 */
function recoveryConfig(options) {
  // The block core's chunk, here only. One page: the core's dependencies would stay in the page's
  // own entry chunk, which the core's chunk would import as the entry imports it, a cycle a page's
  // preloads walk back into its own entry. So the core's chunk takes them too.
  return pagePassConfig(options, ['recovery'], { blockChunk: true });
}

/**
 * A pass over `pages`, each an HTML entry, with what every page pass shares: the names, the
 * preloads, the loader's chunk, the workers' build, and the report, which records its chunks as
 * the pages'
 * @param {PassOptions} options
 * @param {readonly string[]} pages - PAGES' names
 * @param {{blockChunk?: boolean, pageChunks?: boolean}} [chunks] - `blockChunk`: whether the pass
 *   writes the block core's chunk, with its modules' dependencies; `pageChunks`: whether it writes
 *   the host and adapter chunks (scripts/build/page-chunks.js)
 * @returns {InlineConfig}
 */
function pagePassConfig(options, pages, { blockChunk = false, pageChunks = false } = {}) {
  const { root, mode, report, onLog } = options;
  const treeshake = treeshakeOf(options);
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
      // Chrome 116 has modulepreload, so the polyfill would only add code. close-drafts-applier,
      // close-drafts-chunk, journal-chunk and Side Panel's send chunk preload nothing beside them
      // (preloadsFor).
      modulePreload: { polyfill: false, resolveDependencies: preloadsFor },
      rolldownOptions: {
        input: Object.fromEntries(pages.map((name) => [name, path.join(root, /** @type {Record<string, string>} */ (PAGES)[name])])),
        output: {
          ...names,
          chunkFileNames: chunkFileName(root),
          // The loader alone in a chunk, whichever chunks import it (#27 slice 3), in the pages
          // pass the host and adapter chunks (#35 slice 4b-2), and in recovery.html's pass the
          // block core in one of its own, named for what it is (#115's review)
          codeSplitting: {
            groups: [
              { name: 'loader', test: (id) => loader.has(id) },
              ...(pageChunks ? pageChunkGroups(root) : []),
              ...(blockChunk ? [{ name: blockCoreChunk(root), debugName: 'blocks', includeDependenciesRecursively: true }] : []),
            ],
          },
        },
        checks: { ...CHECKS },
        onLog,
        ...treeshake,
      },
    },
    worker: {
      format: 'es',
      plugins: () => [reportPlugin(report, 'worker'), ...(mode === 'production' ? [workerTerserPlugin()] : [])],
      // terser minifies a worker's chunk in production (workerTerserPlugin), so the bundler
      // writes it as given: Vite leaves a worker's minify unset, and the bundler would reprint it
      rolldownOptions: { output: { ...names, minify: false }, checks: { ...CHECKS }, onLog, ...treeshake },
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
        ...treeshakeOf(options),
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
        ...treeshakeOf(options),
      },
    },
    plugins: [guardRowsPlugin(root, guardRows), reportPlugin(report, 'guard')],
  };
}

module.exports = {
  MINIMUM_CHROME_VERSION,
  OWN_PASS_PAGES,
  recoveryConfig,
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
