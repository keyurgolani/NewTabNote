'use strict';

/**
 * The budgets (#27 slice 4b: "Analyzer and budgets", AC3). The analyzer reads what the bundle
 * wrote, from the bundler's own report and the built pages, into dist-report/chunk-graph.json:
 * for each entry, what loads at its start, what its loader and import() calls load later
 * (lazy), and what workers it starts, each with its files, bytes by type, source modules, and
 * third-party packages. The gate holds that against build/budgets.json, which no script
 * writes: it changes only by review, and a number over a row goes back to the owner.
 *
 * An entry is a page (`page`), with the loader chunks it loads at its start counted as start
 * (`startChunks`: today's new tab loads the workspace chunk, the whole tab, at boot) and the
 * ones it loads later named as lazy (`lazyChunks`); a loader chunk (`chunk`: Moment, once #2
 * builds it); or the service worker (`background`), one self-contained module whose start is
 * the whole of it. It fails the build, which then writes no
 * dist/, on:
 *   budget/entry       a page or the service worker the build has with no row, a row for an
 *                      entry the build doesn't have that isn't `planned`, a `planned` row for
 *                      an entry the build has (its numbers have to be set first), a
 *                      `startChunks` or `lazyChunks` name the build doesn't have or the page's
 *                      start doesn't import(), or a chunk the page's start import()s that the
 *                      row names in neither, so the row can't fall back to measuring the root;
 *                      or a row it needs with no number and no issue named for it in waitsOn
 *                      (#300): a start type its build has, its modules, the service worker's
 *                      cold start, a planned entry's start rows and modules, and the zip's and
 *                      update size's, so a row that waits on another issue reads apart from a
 *                      missing one
 *   budget/bytes       an entry's start over a row: JS, CSS, HTML, or fonts, raw or gzip at
 *                      level 9, the way npm run perf:probe measures them
 *   budget/modules     an entry's start over its module row: its modules, third-party and
 *                      Vite's own among them, classic scripts, stylesheets, fonts and page, as
 *                      the build's line counts them (#300)
 *   budget/forbidden   a module, classic script, or file a forbidden category names on the
 *                      entry's start path
 *   budget/worker-only a module only the service worker runs (WORKER_ONLY_MODULES) on a page's
 *                      or a loader chunk's start, by the module and the entry
 *   budget/lazy-only   a module that loads only at its first use (LAZY_ONLY_MODULES) on a
 *                      page's or a loader chunk's start, by the module and the entry
 *   budget/dependency  a third-party package in the entry's graph (start, lazy, workers) that
 *                      its row doesn't allow, an allowed one it no longer has, or one its row
 *                      allows lazy only (lazyDependencies) on its start
 *   budget/layout      the pages pass's host and adapter chunks out of place
 *                      (scripts/build/page-chunks.js): a pages-pass page's start that loads Vite's
 *                      preload helper from another chunk than host, the new tab's or Side Panel's
 *                      start without the adapter chunk once a pages-pass start holds a module of
 *                      the adapter's list, another pages-pass start with it, or recovery.html's
 *                      start with a chunk named for either
 *   budget/file        build/budgets.json doesn't read as a budget file
 * The zip's row is npm run package's (scripts/package.js, checkZip): a zip over it fails as
 * budget/zip, and no zip is written. A null row has no approved number yet, and gates nothing.
 * Timing and heap aren't the build's: npm run perf:probe measures them against the frozen
 * 1.4.0 package with the rows here (docs/performance/budgets.md). Budgets hold for production
 * builds; a development build isn't checked.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { problem, plural } = require('./diagnostics.js');
const { htmlTags, cssUrls } = require('./markup.js');
const { sourcePath } = require('./bundle.js');
const { PAGES, OWN_PASS_PAGES, BACKGROUND_ENTRY, CLASSIC_SCRIPTS } = require('./vite-config.js');
const { ADAPTER_PAGES, PAGE_CHUNKS, PRELOAD_HELPER } = require('./page-chunks.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */
/** @typedef {import('./vite-config.js').ChunkReport} ChunkReport */

const ROOT = path.join(__dirname, '..', '..');
const BUDGETS_FILE = 'build/budgets.json';
const FONT = /\.(?:woff2?|ttf|otf)$/i;
/** The start rows an entry can have */
const START_TYPES = ['html', 'js', 'css', 'fonts'];
/** The package row's rows: the zip's bytes, and update size, which #31's release gate sets (#300) */
const PACKAGE_ROWS = ['zipBytes', 'updateBytes'];
/** The entries whose reads row may hold a number: the new tab's routes, where #27 has IndexedDB reads before interaction-ready (#300) */
const READ_ENTRIES = ['newtab', 'moment'];
/** The entries whose reads row stays null until their page has a ready mark to count to: Popup (#4) and the Side Panel (#5), as #27 has them */
const MARKLESS_READ_ENTRIES = ['popup', 'sidepanel'];
/** An issue a null row waits on, in waitsOn */
const ISSUE = /^#[1-9]\d*$/;
/**
 * Only the service worker runs these: the modules a run-time filter once kept on a page's start
 * (#35 slice 3c), and the payload schemas of every command a page sends the worker, which only the
 * worker's router checks (#35 slice 4d)
 */
const WORKER_ONLY_MODULES = Object.freeze([
  'js/kernel/adapters/indexeddb/integrity.js',
  'js/kernel/adapters/indexeddb/ledger-sweep.js',
  'js/kernel/adapters/indexeddb/worker-tasks.js',
  'js/kernel/composition/page-operations.js',
  'js/kernel/core/application/integrity-check.js',
  'js/kernel/core/application/record-catch-up.js',
]);
/**
 * These load only at their first use, through the page's loader, so no page's start holds one: the
 * block menus' roles and keys, at a menu's first open (#14 slice 4), and the new tab's status read's
 * ask, first in its deferred work, and its status lines, once an answer could put a line in the
 * sidebar or Settings opens (#20 slice 4c)
 */
const LAZY_ONLY_MODULES = Object.freeze([
  'js/kernel/composition/trust-status-ask.js',
  'js/kernel/composition/trust-status.js',
  'js/ui/menu-keys.js',
]);

/** @typedef {{raw: number, gzip: number}} Limit */
/** @typedef {{raw: number, gzip: number, files: number}} Bytes */
/** @typedef {'html' | 'js' | 'css' | 'fonts'} StartType */

/**
 * @typedef {object} BudgetEntry
 * @property {string} [page] - the HTML entry, for a page
 * @property {string} [chunk] - the loader chunk's name, for a chunk entry
 * @property {string[]} [startChunks] - loader chunks the page loads at its start, counted as start
 * @property {string[]} [lazyChunks] - loader chunks the page's start loads later, with import()
 * @property {boolean} [planned] - not built yet: the gate refuses a build that has it
 * @property {Partial<Record<StartType, Limit | null>>} [start] - null: no approved number yet
 * @property {number | null} [modules] - the most modules its start may hold; null: no approved
 *   number yet
 * @property {number | null} [reads] - the new tab's IndexedDB reads before its interaction-ready mark,
 *   which npm run perf:probe counts and the perf job holds it to (#300); null: no approved number yet
 * @property {number | null} [requests] - the requests its start makes outside the extension, which
 *   the probe counts and the perf job holds it to (#300); null: no approved number yet
 * @property {number | null} [coldStart] - the service worker's cold start, in ms, #35's to set and
 *   gate at release; the build checks only its shape
 * @property {Record<string, string>} [waitsOn] - for each row it leaves null, the issue that sets it
 * @property {string[]} [forbidden] - categories gated on the start path
 * @property {string[]} [dependencies] - third-party packages its graph may hold
 * @property {string[]} [lazyDependencies] - third-party packages its lazy chunks and workers may
 *   hold, and its start may not: Popup's valibot, in its send chunk alone (#35 slice 4b-2, Q8)
 * @property {string} reason
 */

/**
 * @typedef {object} BudgetFile
 * @property {Record<string, BudgetEntry>} entries
 * @property {Record<string, {about: string, paths: string[]}>} forbidden - categories, by name
 * @property {{zipBytes: number | null, updateBytes?: number | null, waitsOn?: Record<string, string>, reason: string}} [package] -
 *   the zip npm run package writes, at most zipBytes bytes, and update size, the bytes new or
 *   changed against the previous release, which #31's release gate sets and holds (#31 slice 3);
 *   null: no approved number yet
 */

/**
 * @typedef {object} Part
 * @property {Array<{file: string, type: string, raw: number, gzip: number}>} files
 * @property {Record<string, Bytes>} bytes
 * @property {string[]} modules - source modules and classic scripts, relative to the root
 * @property {string[]} packages
 */

/**
 * @typedef {object} EntryGraph
 * @property {string} kind - 'page', 'chunk', or 'worker'
 * @property {string} at - the page, or the chunk's file
 * @property {Part} start
 * @property {Part} lazy
 * @property {Part} workers
 * @property {Array<{chunk: string, as: 'start' | 'lazy', file: string | null, from: string | null}>} [boots] -
 *   for a page, each of its row's startChunks and lazyChunks: the chunk's file (null: the build
 *   has no such loader chunk) and the chunk on the page's own start whose import() loads it (null:
 *   nothing there does)
 * @property {string[]} [unclassified] - for a page, chunks its own start import()s that its row
 *   names in neither startChunks nor lazyChunks
 */

/**
 * Raw and gzip bytes of `data`, at gzip level 9, as npm run perf:probe measures them
 * (scripts/perf/package-bytes.js sizesOf), so a number is the same from run to run
 * @param {Buffer} data
 * @returns {{raw: number, gzip: number}}
 */
function sizesOf(data) {
  return { raw: data.length, gzip: zlib.gzipSync(data, { level: 9 }).length };
}

/**
 * Whether `file` matches `glob`: `**` any run of characters, `*` any within one folder
 * @param {string} glob
 * @param {string} file
 * @returns {boolean}
 */
function matches(glob, file) {
  const pattern = glob
    .split('**')
    .map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(file);
}

/**
 * The third-party package a source path or shipped file is, or null for first-party code:
 * node_modules/<package>, or a vendored file under js/lib/ by its record
 * @param {string} file
 * @param {Map<string, string>} vendored - js/lib path to its package
 * @returns {string | null}
 */
function packageOf(file, vendored) {
  const nodeModules = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
  if (nodeModules) return nodeModules[1];
  if (vendored.has(file)) return /** @type {string} */ (vendored.get(file));
  for (const [prefix, name] of vendored) if (prefix.endsWith('/') && file.startsWith(prefix)) return name;
  return null;
}

/**
 * Each vendored file and folder under js/lib/ to its package, from js/lib/vendor.json and the
 * nested records it names
 * @param {string} root
 * @returns {Map<string, string>}
 */
function vendoredPackages(root = ROOT) {
  /** @type {Map<string, string>} */
  const vendored = new Map();
  const record = JSON.parse(fs.readFileSync(path.join(root, 'js/lib/vendor.json'), 'utf8'));
  for (const [name, file] of Object.entries(/** @type {Record<string, {package: string}>} */ (record.files || {}))) vendored.set(`js/lib/${name}`, file.package);
  for (const dir of fs.readdirSync(path.join(root, 'js/lib'), { withFileTypes: true })) {
    const nested = path.join(root, 'js/lib', dir.name, 'vendor.json');
    if (dir.isDirectory() && fs.existsSync(nested)) vendored.set(`js/lib/${dir.name}/`, JSON.parse(fs.readFileSync(nested, 'utf8')).package);
  }
  return vendored;
}

/**
 * A path a page or stylesheet names, relative to the package, or null for one outside it
 * @param {string} from - the file that names it
 * @param {string} reference
 * @returns {string | null}
 */
function resolveIn(from, reference) {
  if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith('//')) return null;
  const clean = reference.replace(/[?#].*$/, '');
  const joined = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(from), clean);
  return path.posix.normalize(joined);
}

/**
 * What each entry loads, from the bundler's report and the built files
 * @param {{chunks: ChunkReport[], files: PackageFiles, loaderChunks: Record<string, string>, budgets: BudgetFile, root?: string}} options
 * @returns {Record<string, EntryGraph>}
 */
function analyze({ chunks, files, loaderChunks, budgets, root = ROOT }) {
  const vendored = vendoredPackages(root);
  /** @type {Map<string, ChunkReport>} */
  const byFile = new Map(chunks.filter((chunk) => chunk.pass !== 'background').map((chunk) => [chunk.fileName, chunk]));
  /** @type {Map<string, ChunkReport>} the service worker's own pass, kept apart from the pages' */
  const backgroundByFile = new Map(chunks.filter((chunk) => chunk.pass === 'background').map((chunk) => [chunk.fileName, chunk]));
  const chunkOf = (/** @type {string} */ file) => byFile.get(file) || backgroundByFile.get(file);
  const libraries = Object.entries(CLASSIC_SCRIPTS).filter(([, how]) => how === 'as-is').map(([file]) => file);
  const workerChunks = chunks.filter((chunk) => chunk.pass === 'worker' && chunk.isEntry);

  /** Static imports from `start`, each chunk once, within one pass's chunks */
  const closure = (/** @type {string[]} */ start, within = byFile) => {
    /** @type {Set<string>} */
    const seen = new Set();
    const pending = [...start];
    while (pending.length > 0) {
      const file = /** @type {string} */ (pending.pop());
      if (seen.has(file) || !within.has(file)) continue;
      seen.add(file);
      pending.push(.../** @type {ChunkReport} */ (within.get(file)).imports);
    }
    return seen;
  };

  /**
   * A part's files, bytes, modules, and packages
   * @param {Map<string, string>} typed - file to type
   */
  const partOf = (typed) => {
    /** @type {Record<string, Bytes>} */
    const bytes = {};
    /** @type {Part['files']} */
    const listed = [];
    /** @type {Set<string>} */
    const modules = new Set();
    for (const [file, type] of [...typed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!files.has(file)) continue;
      const { raw, gzip } = sizesOf(files.read(file));
      listed.push({ file, type, raw, gzip });
      const bucket = bytes[type] || (bytes[type] = { raw: 0, gzip: 0, files: 0 });
      bucket.raw += raw;
      bucket.gzip += gzip;
      bucket.files += 1;
      const chunk = chunkOf(file);
      if (chunk) {
        for (const id of chunk.moduleIds) {
          const source = sourcePath(id, root);
          if (source !== null) modules.add(source);
          else if (/(?:^|\/)node_modules\//.test(id)) modules.add(id.slice(id.lastIndexOf('node_modules/')));
          // Vite's own modules by name, so the graph shows which start holds its preload helper
          // (#35 slice 4b-2's layout)
          else if (id.startsWith('\0vite/')) modules.add(id.slice(1));
        }
      } else {
        // A classic script, a stylesheet, or a font: it ships at its own path
        modules.add(file);
      }
    }
    const packages = [...new Set([...modules].map((file) => packageOf(file, vendored)).filter((name) => name !== null))].sort();
    return { files: listed, bytes, modules: [...modules].sort(), packages: /** @type {string[]} */ (packages) };
  };

  /** Fonts the stylesheets in `typed` name, added as fonts */
  const addFonts = (/** @type {Map<string, string>} */ typed) => {
    for (const [file, type] of [...typed]) {
      if (type !== 'css' || !files.has(file)) continue;
      for (const { value } of cssUrls(files.text(file))) {
        const target = resolveIn(file, value);
        if (target && FONT.test(target) && files.has(target) && !typed.has(target)) typed.set(target, 'fonts');
      }
    }
  };

  /**
   * The lazy chunks (import() targets, with their static imports) and workers reachable from
   * the chunks in `start`, outside it
   * @param {Set<string>} start
   */
  const beyond = (start) => {
    /** @type {Set<string>} */
    const lazy = new Set();
    const pending = [...start];
    while (pending.length > 0) {
      const file = /** @type {string} */ (pending.pop());
      const chunk = byFile.get(file);
      if (!chunk) continue;
      for (const next of closure(chunk.dynamicImports || [])) {
        if (start.has(next) || lazy.has(next)) continue;
        lazy.add(next);
        pending.push(next);
      }
    }
    /** @type {Set<string>} */
    const workers = new Set();
    for (const worker of workerChunks) {
      const named = [...start, ...lazy].some((file) => files.has(file) && files.text(file).includes(path.posix.basename(worker.fileName)));
      if (named) for (const file of closure([worker.fileName])) workers.add(file);
    }
    return { lazy, workers };
  };

  /** @type {Record<string, EntryGraph>} */
  const graphs = {};
  for (const [name, entry] of Object.entries(budgets.entries)) {
    /** @type {Map<string, string>} */
    const start = new Map();
    /** @type {Set<string>} */
    let startChunks = new Set();
    let kind = 'page';
    let at = '';
    /** @type {NonNullable<EntryGraph['boots']>} */
    const boots = [];
    /** @type {string[]} */
    let unclassified = [];
    if (entry.page) {
      if (!files.has(entry.page)) continue;
      at = entry.page;
      start.set(entry.page, 'html');
      /** @type {string[]} */
      const roots = [];
      for (const tag of htmlTags(files.text(entry.page))) {
        const src = tag.name === 'script' ? tag.attributes.get('src') : undefined;
        const rel = tag.name === 'link' ? (tag.attributes.get('rel') || '').toLowerCase().split(/\s+/) : [];
        const href = tag.name === 'link' ? tag.attributes.get('href') : undefined;
        if (src !== undefined) {
          const file = resolveIn(entry.page, src);
          if (file === null) continue;
          if ((tag.attributes.get('type') || '').toLowerCase() === 'module') roots.push(file);
          else start.set(file, 'js');
        } else if (href !== undefined && rel.includes('modulepreload')) {
          const file = resolveIn(entry.page, href);
          if (file !== null) roots.push(file);
        } else if (href !== undefined && rel.includes('stylesheet')) {
          const file = resolveIn(entry.page, href);
          if (file !== null) start.set(file, 'css');
        }
      }
      // What the page loads at once through its loader counts as start: today's root loads the
      // workspace chunk, the whole tab, at boot. Every chunk the page's own start import()s has
      // to be named, as start or as lazy, and each one named has to be built and import()ed
      // there, or the row would measure only the root
      const own = closure(roots);
      const ownImports = [...new Set([...own].flatMap((file) => byFile.get(file)?.dynamicImports || []))].filter((file) => byFile.has(file)).sort();
      /** @type {Set<string>} */
      const named = new Set();
      for (const [as, list] of /** @type {const} */ ([['start', entry.startChunks], ['lazy', entry.lazyChunks]])) {
        for (const chunk of list || []) {
          const file = loaderChunks[chunk] || null;
          const from = file === null ? null : [...own].sort().find((source) => (byFile.get(source)?.dynamicImports || []).includes(file)) || null;
          boots.push({ chunk, as, file, from });
          if (file === null) continue;
          named.add(file);
          if (as === 'start') roots.push(file);
        }
      }
      unclassified = ownImports.filter((file) => !named.has(file));
      startChunks = closure(roots);
    } else if (entry.chunk) {
      if (!loaderChunks[entry.chunk]) continue;
      kind = 'chunk';
      at = loaderChunks[entry.chunk];
      startChunks = closure([at]);
    } else if (name === 'background') {
      // The service worker: one self-contained module (#27 slice 2), its own pass
      if (!files.has(BACKGROUND_ENTRY)) continue;
      kind = 'worker';
      at = BACKGROUND_ENTRY;
      startChunks = closure([BACKGROUND_ENTRY], backgroundByFile);
    } else {
      continue;
    }
    for (const file of startChunks) {
      start.set(file, 'js');
      for (const css of /** @type {ChunkReport} */ (chunkOf(file)).importedCss || []) start.set(css, 'css');
    }
    addFonts(start);
    const { lazy, workers } = beyond(startChunks);
    /** @type {Map<string, string>} */
    const lazyTyped = new Map();
    for (const file of lazy) {
      lazyTyped.set(file, 'js');
      for (const css of /** @type {ChunkReport} */ (byFile.get(file)).importedCss || []) if (!start.has(css)) lazyTyped.set(css, 'css');
    }
    // The vendored libraries the loader puts in on a page whose loader ships with it
    if (kind === 'page' && [...startChunks].some((file) => file === 'js/runtime/lazy.js')) {
      for (const file of libraries) if (!start.has(file)) lazyTyped.set(file, 'js');
    }
    addFonts(lazyTyped);
    graphs[name] = { kind, at, start: partOf(start), lazy: partOf(lazyTyped), workers: partOf(new Map([...workers].map((file) => [file, 'js']))) };
    if (boots.length > 0) graphs[name].boots = boots;
    if (unclassified.length > 0) graphs[name].unclassified = unclassified;
  }
  return graphs;
}

/**
 * The loader chunks a page's row counts as start, the ones the build has: what the build's line
 * says loads at boot
 * @param {EntryGraph} graph
 * @returns {string[]}
 */
function startChunksOf(graph) {
  return (graph.boots || []).filter((boot) => boot.as === 'start' && boot.file !== null).map((boot) => boot.chunk);
}

/**
 * The problems with budgets.json's shape, before it's used
 * @param {any} budgets
 * @returns {Problem[]}
 */
function fileProblems(budgets) {
  /** @type {Problem[]} */
  const problems = [];
  const fail = (/** @type {string} */ message) => problems.push(problem('budget/file', BUDGETS_FILE, message));
  if (!budgets || typeof budgets !== 'object' || !budgets.entries || typeof budgets.entries !== 'object') {
    fail('has no entries');
    return problems;
  }
  const categories = budgets.forbidden && typeof budgets.forbidden === 'object' ? budgets.forbidden : {};
  for (const [name, category] of Object.entries(/** @type {Record<string, any>} */ (categories))) {
    if (!category || !Array.isArray(category.paths) || !category.paths.every((/** @type {unknown} */ glob) => typeof glob === 'string')) fail(`forbidden category ${name}'s paths isn't a list of paths`);
  }
  for (const [name, entry] of Object.entries(/** @type {Record<string, any>} */ (budgets.entries))) {
    for (const key of ['startChunks', 'lazyChunks', 'forbidden', 'dependencies', 'lazyDependencies']) {
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || !entry[key].every((/** @type {unknown} */ item) => typeof item === 'string'))) fail(`entry ${name}'s ${key} isn't a list of names`);
    }
    if (Boolean(entry.page) === Boolean(entry.chunk) && name !== 'background') fail(`entry ${name} names neither a page nor a chunk, or both`);
    if (typeof entry.reason !== 'string' || entry.reason === '') fail(`entry ${name} has no reason`);
    for (const category of Array.isArray(entry.forbidden) ? entry.forbidden : []) if (!categories[category]) fail(`entry ${name} forbids ${category}, which isn't a category`);
    for (const name2 of Array.isArray(entry.lazyDependencies) ? entry.lazyDependencies : []) {
      if (Array.isArray(entry.dependencies) && entry.dependencies.includes(name2)) fail(`entry ${name} allows ${name2} both anywhere and lazy only`);
    }
    for (const [type, limit] of Object.entries(entry.start || {})) {
      if (!START_TYPES.includes(type)) {
        fail(`entry ${name}'s start has a ${type} row, which isn't one of ${START_TYPES.join(', ')}`);
        continue;
      }
      if (limit === null) continue;
      const ok = limit && Number.isSafeInteger(limit.raw) && Number.isSafeInteger(limit.gzip) && limit.raw >= 0 && limit.gzip >= 0;
      if (!ok) fail(`entry ${name}'s ${type} row isn't whole numbers of bytes, raw and gzip`);
    }
    if (entry.modules !== undefined && entry.modules !== null && !wholeNumber(entry.modules)) fail(`entry ${name}'s modules row isn't a whole number of modules`);
    for (const key of ['reads', 'requests']) {
      if (entry[key] !== undefined && entry[key] !== null && !wholeNumber(entry[key])) fail(`entry ${name}'s ${key} row isn't a whole number`);
    }
    if (entry.reads !== undefined && MARKLESS_READ_ENTRIES.includes(name)) {
      if (entry.reads !== null) fail(`entry ${name}'s reads row stays null until its page has a ready mark to count reads to`);
    } else if (entry.reads !== undefined && !READ_ENTRIES.includes(name)) fail(`entry ${name} has a reads row, which only the new tab, Moment, Popup and the Side Panel have`);
    if (entry.coldStart !== undefined) {
      if (name !== 'background') fail(`entry ${name} has a coldStart row, which only the service worker has`);
      else if (entry.coldStart !== null && !wholeNumber(entry.coldStart)) fail(`entry ${name}'s coldStart row isn't a whole number of milliseconds`);
    }
    waitsOnProblems(entry.waitsOn, rowsOf(name), (row) => (START_TYPES.includes(row) ? (entry.start || {})[row] : entry[row]), `entry ${name}`).forEach(fail);
  }
  if (budgets.package !== undefined) {
    const row = budgets.package;
    if (!row || typeof row !== 'object') fail("the package row isn't a row");
    else {
      if (row.zipBytes !== null && !wholeNumber(row.zipBytes)) fail("the package's zipBytes row isn't a whole number of bytes");
      if (row.updateBytes !== undefined && row.updateBytes !== null && !wholeNumber(row.updateBytes)) fail("the package's updateBytes row isn't a whole number of bytes");
      if (typeof row.reason !== 'string' || row.reason === '') fail('the package row has no reason');
      waitsOnProblems(row.waitsOn, PACKAGE_ROWS, (name) => row[name], 'the package').forEach(fail);
    }
  }
  return problems;
}

/**
 * The rows an entry can have: its start rows, its modules, its reads on the new tab's routes and
 * on Popup and the Side Panel, its requests, and the service worker's cold start
 * @param {string} name
 * @returns {string[]}
 */
function rowsOf(name) {
  return [...START_TYPES, 'modules', ...([...READ_ENTRIES, ...MARKLESS_READ_ENTRIES].includes(name) ? ['reads'] : []), 'requests', ...(name === 'background' ? ['coldStart'] : [])];
}

/**
 * What's wrong with a waitsOn: it maps each row its holder leaves null to the issue that sets it,
 * as #31, so it names only rows the holder can have, and never one that has a number (#300)
 * @param {unknown} waitsOn
 * @param {readonly string[]} rows - the rows the holder can have
 * @param {(row: string) => unknown} valueOf - a row's value
 * @param {string} who - the holder, as a message names it
 * @returns {string[]}
 */
function waitsOnProblems(waitsOn, rows, valueOf, who) {
  if (waitsOn === undefined) return [];
  if (!waitsOn || typeof waitsOn !== 'object' || Array.isArray(waitsOn)) return [`${who}'s waitsOn isn't a map of rows to issues`];
  return Object.entries(waitsOn).flatMap(([row, issue]) => {
    if (!rows.includes(row)) return [`${who}'s waitsOn names ${row}, which isn't one of its rows`];
    if (typeof issue !== 'string' || !ISSUE.test(issue)) return [`${who}'s waitsOn gives ${row} ${issue}, which isn't an issue like #31`];
    const value = valueOf(row);
    return value === undefined || value === null ? [] : [`${who}'s ${row} row has a number, and waitsOn still names ${issue} for it`];
  });
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function wholeNumber(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/**
 * Each row a build needs that has no number and no issue named for it in waitsOn (#300): the start
 * types an entry's build has, its modules, and the service worker's cold start; a planned entry's
 * start rows and modules, which wait on the issue that builds it; and the package's rows. A row
 * that waits on another issue names it, so it reads apart from one nobody set.
 * @param {Record<string, EntryGraph>} graphs
 * @param {BudgetFile} budgets
 * @returns {Problem[]}
 */
function unsetProblems(graphs, budgets) {
  /** @type {Problem[]} */
  const problems = [];
  const unset = (/** @type {string} */ subject, /** @type {string} */ row) => problem('budget/entry', subject, `its ${row} row has no number and no issue named for it in waitsOn: set its number by review, from CI's figure, or name the issue it waits on`);
  for (const [name, entry] of Object.entries(budgets.entries)) {
    const graph = graphs[name];
    if (!entry.planned && !graph) continue;
    const needs = entry.planned
      ? [...START_TYPES, 'modules']
      : [...START_TYPES.filter((type) => graph.start.bytes[type]), 'modules', ...(graph.kind === 'worker' ? ['coldStart'] : [])];
    for (const row of needs) {
      const value = START_TYPES.includes(row) ? (entry.start || {})[/** @type {StartType} */ (row)] : /** @type {any} */ (entry)[row];
      if ((value === undefined || value === null) && !(entry.waitsOn && entry.waitsOn[row])) problems.push(unset(name, START_TYPES.includes(row) ? `start ${row.toUpperCase()}` : row));
    }
  }
  const row = /** @type {Record<string, any>} */ (budgets.package || {});
  for (const name of PACKAGE_ROWS) {
    if ((row[name] === undefined || row[name] === null) && !(row.waitsOn && row.waitsOn[name])) problems.push(unset('package', name));
  }
  return problems;
}

/**
 * KiB with one decimal
 * @param {number} bytes
 */
function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * Where the pages pass's host and adapter chunks load (budget/layout, scripts/build/page-chunks.js):
 * each pages-pass start that holds Vite's preload helper loads it from host (P1), and no pages-pass
 * start loads the adapter chunk, since the new tab, Popup and Side Panel read through #17's reader
 * (P2, #35 slices 4b-2, 4c and 4d). recovery.html's start loads no chunk named for either, which
 * only the pages pass's groups write (P5).
 * @param {Record<string, EntryGraph>} graphs
 * @param {ChunkReport[]} chunks
 * @returns {Problem[]}
 */
function layoutProblems(graphs, chunks) {
  /** @type {Problem[]} */
  const problems = [];
  const byFile = new Map(chunks.filter((chunk) => chunk.pass !== 'background').map((chunk) => [chunk.fileName, chunk]));
  const pages = Object.entries(graphs).filter(([, graph]) => graph.kind === 'page');
  /** The chunks a page's start loads */
  const started = (/** @type {EntryGraph} */ graph) => graph.start.files.flatMap(({ file }) => byFile.get(file) || []);
  const onAdapter = ADAPTER_PAGES.length > 0 ? `only the starts of ${ADAPTER_PAGES.join(' and ')} load` : "no page's start loads, since each reads through #17's reader";
  for (const [name, graph] of pages) {
    if (OWN_PASS_PAGES.includes(name)) {
      for (const chunk of started(graph)) {
        if (PAGE_CHUNKS.includes(chunk.name)) problems.push(problem('budget/layout', name, `its start loads ${chunk.name} (${chunk.fileName}), a chunk only the first page pass's groups name, so ${name}'s own pass took them`));
      }
      continue;
    }
    for (const chunk of started(graph)) {
      if (chunk.moduleIds.includes(PRELOAD_HELPER) && chunk.name !== 'host') problems.push(problem('budget/layout', name, `its start loads Vite's preload helper from ${chunk.fileName}, not from the host chunk every page's start shares`));
    }
    if (!ADAPTER_PAGES.includes(name)) {
      for (const chunk of started(graph)) {
        if (chunk.name === 'adapter') problems.push(problem('budget/layout', name, `its start loads the adapter chunk (${chunk.fileName}), which ${onAdapter}`));
      }
    }
  }
  return problems;
}

/**
 * The gate: every problem the analyzed entries have against the budgets
 * @param {Record<string, EntryGraph>} graphs
 * @param {BudgetFile} budgets
 * @param {{loaderChunks: Record<string, string>, files: PackageFiles, chunks: ChunkReport[]}} built -
 *   `chunks`: every chunk the passes wrote (the bundler's report), for where the pages' chunks load
 * @returns {Problem[]}
 */
function checkBudgets(graphs, budgets, { loaderChunks, files, chunks }) {
  const problems = fileProblems(budgets);
  if (problems.length > 0) return problems;
  // What the build has: its pages and service worker, and any chunk a row names
  /** @type {Set<string>} */
  const built = new Set();
  for (const [name, page] of Object.entries(PAGES)) if (files.has(page)) built.add(name);
  if (files.has(BACKGROUND_ENTRY)) built.add('background');
  for (const [name, entry] of Object.entries(budgets.entries)) if (entry.chunk && loaderChunks[entry.chunk]) built.add(name);

  for (const name of built) {
    const entry = budgets.entries[name];
    if (!entry) problems.push(problem('budget/entry', name, `the build has it, and ${BUDGETS_FILE} has no row for it`));
    else if (entry.planned) problems.push(problem('budget/entry', name, `the build has it, and its row is still planned: set its numbers, and planned to false, by review`));
  }
  for (const [name, entry] of Object.entries(budgets.entries)) {
    if (!built.has(name) && !entry.planned) problems.push(problem('budget/entry', name, `${BUDGETS_FILE} has a row for it, and the build doesn't have it`));
  }
  problems.push(...unsetProblems(graphs, budgets));

  for (const [name, graph] of Object.entries(graphs)) {
    const entry = budgets.entries[name];
    if (!entry || entry.planned) continue;
    const chunkNames = new Map(Object.entries(loaderChunks).map(([chunk, file]) => [file, chunk]));
    for (const boot of graph.boots || []) {
      const key = boot.as === 'start' ? 'startChunks' : 'lazyChunks';
      if (boot.file === null) problems.push(problem('budget/entry', name, `its row's ${key} names ${boot.chunk}, and the build has no loader chunk by that name, so its graph would leave out what the page loads`));
      else if (boot.from === null) problems.push(problem('budget/entry', name, `its row's ${key} names ${boot.chunk} (${boot.file}), and nothing on the page's start loads it with import(): the row says the page loads a chunk it doesn't`));
    }
    for (const file of graph.unclassified || []) {
      const chunk = chunkNames.get(file);
      problems.push(problem('budget/entry', name, `its page's start loads ${chunk ? `${chunk} (${file})` : file} with import(), and its row names it in neither startChunks nor lazyChunks: say whether it loads at start or later, or the row measures less than the page loads`));
    }
    for (const [type, limit] of Object.entries(entry.start || {})) {
      if (!limit) continue;
      const measured = graph.start.bytes[type] || { raw: 0, gzip: 0, files: 0 };
      for (const how of /** @type {const} */ (['raw', 'gzip'])) {
        if (measured[how] > limit[how]) {
          problems.push(problem('budget/bytes', name, `its start ${type.toUpperCase()} is ${measured[how]} bytes ${how} (${kib(measured[how])}), over its ${limit[how]} (${kib(limit[how])}); a number over a row goes to the owner, not into the row`));
        }
      }
    }
    if (wholeNumber(entry.modules) && graph.start.modules.length > entry.modules) {
      problems.push(problem('budget/modules', name, `its start has ${plural(graph.start.modules.length, 'module')}, over its ${entry.modules}; a number over a row goes to the owner, not into the row`));
    }
    for (const category of entry.forbidden || []) {
      const { paths } = budgets.forbidden[category];
      const found = graph.start.modules.filter((file) => paths.some((glob) => matches(glob, file)));
      if (found.length > 0) {
        const item = problem('budget/forbidden', name, `its start path holds ${category} (${budgets.forbidden[category].about}): ${found.join(', ')}`);
        problems.push(item);
      }
    }
    if (graph.kind !== 'worker') {
      for (const file of graph.start.modules.filter((source) => WORKER_ONLY_MODULES.includes(source))) {
        problems.push(problem('budget/worker-only', name, `its start holds ${file}, which only the service worker runs`));
      }
      for (const file of graph.start.modules.filter((source) => LAZY_ONLY_MODULES.includes(source))) {
        problems.push(problem('budget/lazy-only', name, `its start holds ${file}, which loads only at its first use, through the page's loader`));
      }
    }
    const allowed = new Set(entry.dependencies || []);
    // Allowed in its lazy chunks and workers alone: on its start, it fails
    const lazyOnly = new Set(entry.lazyDependencies || []);
    const held = new Set([...graph.start.packages, ...graph.lazy.packages, ...graph.workers.packages]);
    for (const name2 of [...held].sort()) {
      if (lazyOnly.has(name2) && graph.start.packages.includes(name2)) problems.push(problem('budget/dependency', name, `its start holds ${name2}, which its row allows lazy only`));
      else if (!allowed.has(name2) && !lazyOnly.has(name2)) problems.push(problem('budget/dependency', name, `its graph holds ${name2}, which its row doesn't allow`));
    }
    for (const name2 of [...allowed, ...lazyOnly].sort()) {
      if (!held.has(name2)) problems.push(problem('budget/dependency', name, `its row allows ${name2}${lazyOnly.has(name2) ? ' lazy only' : ''}, which its graph no longer holds: take it out`));
    }
  }
  problems.push(...layoutProblems(graphs, chunks));
  return problems;
}

/**
 * The zip's problems against the package row: one over it fails (#300). A null row gates nothing.
 * @param {number} bytes - the zip's size
 * @param {BudgetFile} budgets
 * @returns {Problem[]}
 */
function checkZip(bytes, budgets) {
  const limit = budgets.package ? budgets.package.zipBytes : null;
  if (!wholeNumber(limit) || bytes <= limit) return [];
  return [problem('budget/zip', 'the zip', `it is ${bytes} bytes (${kib(bytes)}), over its ${limit} (${kib(limit)}); a number over a row goes to the owner, not into the row`)];
}

/**
 * Read build/budgets.json from `root`
 * @param {string} [root]
 * @returns {{budgets: BudgetFile | null, problems: Problem[]}}
 */
function readBudgets(root = ROOT) {
  const file = path.join(root, BUDGETS_FILE);
  if (!fs.existsSync(file)) return { budgets: null, problems: [problem('budget/file', BUDGETS_FILE, 'is missing')] };
  try {
    const budgets = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problems = fileProblems(budgets);
    return { budgets: problems.length > 0 ? null : budgets, problems };
  } catch (error) {
    return { budgets: null, problems: [problem('budget/file', BUDGETS_FILE, `doesn't parse: ${error instanceof Error ? error.message : error}`)] };
  }
}

module.exports = { analyze, checkBudgets, checkZip, readBudgets, fileProblems, matches, packageOf, vendoredPackages, sizesOf, startChunksOf, BUDGETS_FILE, WORKER_ONLY_MODULES, LAZY_ONLY_MODULES };
