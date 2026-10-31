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
 * (`startChunks`: today's new tab loads the workspace chunk, the whole tab, at boot), or a
 * loader chunk (`chunk`: Moment, once #2 builds it). It fails the build, which then writes no
 * dist/, on:
 *   budget/entry       a page or the service worker the build has with no row, a row for an
 *                      entry the build doesn't have that isn't `planned`, or a `planned` row
 *                      for an entry the build has (its numbers have to be set first)
 *   budget/bytes       an entry's start over a row: JS, CSS, HTML, or fonts, raw or gzip at
 *                      level 9, the way npm run perf:probe measures them
 *   budget/forbidden   a module, classic script, or file a forbidden category names on the
 *                      entry's start path
 *   budget/dependency  a third-party package in the entry's graph (start, lazy, workers) that
 *                      its row doesn't allow, or an allowed one it no longer has
 *   budget/file        build/budgets.json doesn't read as a budget file
 * Timing and heap aren't the build's: npm run perf:probe measures them against the frozen
 * 1.4.0 package with the rows here (docs/performance/budgets.md). Budgets hold for production
 * builds; a development build isn't checked.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { problem } = require('./diagnostics.js');
const { htmlTags, cssUrls } = require('./markup.js');
const { sourcePath } = require('./bundle.js');
const { PAGES, BACKGROUND_ENTRY, CLASSIC_SCRIPTS } = require('./vite-config.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */
/** @typedef {import('./vite-config.js').ChunkReport} ChunkReport */

const ROOT = path.join(__dirname, '..', '..');
const BUDGETS_FILE = 'build/budgets.json';
const FONT = /\.(?:woff2?|ttf|otf)$/i;

/** @typedef {{raw: number, gzip: number}} Limit */
/** @typedef {{raw: number, gzip: number, files: number}} Bytes */
/** @typedef {'html' | 'js' | 'css' | 'fonts'} StartType */

/**
 * @typedef {object} BudgetEntry
 * @property {string} [page] - the HTML entry, for a page
 * @property {string} [chunk] - the loader chunk's name, for a chunk entry
 * @property {string[]} [startChunks] - loader chunks the page loads at its start, counted as start
 * @property {boolean} [planned] - not built yet: the gate refuses a build that has it
 * @property {Partial<Record<StartType, Limit | null>>} [start] - null: no approved number yet
 * @property {string[]} [forbidden] - categories gated on the start path
 * @property {string[]} [dependencies] - third-party packages its graph may hold
 * @property {string} reason
 */

/**
 * @typedef {object} BudgetFile
 * @property {Record<string, BudgetEntry>} entries
 * @property {Record<string, {about: string, paths: string[]}>} forbidden - categories, by name
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
 * @property {Array<{chunk: string, file: string | null, from: string | null}>} [boots] - for a page,
 *   each of its row's startChunks: the chunk's file (null: the build has no such loader chunk) and
 *   the start chunk whose import() loads it (null: nothing on the page's start does)
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
  const libraries = Object.entries(CLASSIC_SCRIPTS).filter(([, how]) => how === 'as-is').map(([file]) => file);
  const workerChunks = chunks.filter((chunk) => chunk.pass === 'worker' && chunk.isEntry);

  /** Static imports from `start`, each chunk once */
  const closure = (/** @type {string[]} */ start) => {
    /** @type {Set<string>} */
    const seen = new Set();
    const pending = [...start];
    while (pending.length > 0) {
      const file = /** @type {string} */ (pending.pop());
      if (seen.has(file) || !byFile.has(file)) continue;
      seen.add(file);
      pending.push(.../** @type {ChunkReport} */ (byFile.get(file)).imports);
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
      const chunk = byFile.get(file);
      if (chunk) {
        for (const id of chunk.moduleIds) {
          const source = sourcePath(id, root);
          if (source !== null) modules.add(source);
          else if (/(?:^|\/)node_modules\//.test(id)) modules.add(id.slice(id.lastIndexOf('node_modules/')));
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
      // workspace chunk, the whole tab, at boot. Each one has to be built, and loaded by an
      // import() on the page's own start, or the row would measure only the root
      const own = closure(roots);
      for (const chunk of entry.startChunks || []) {
        const file = loaderChunks[chunk] || null;
        const from = file === null ? null : [...own].sort().find((at) => (byFile.get(at)?.dynamicImports || []).includes(file)) || null;
        boots.push({ chunk, file, from });
        if (file !== null) roots.push(file);
      }
      startChunks = closure(roots);
    } else if (entry.chunk) {
      if (!loaderChunks[entry.chunk]) continue;
      kind = 'chunk';
      at = loaderChunks[entry.chunk];
      startChunks = closure([at]);
    } else {
      continue;
    }
    for (const file of startChunks) {
      start.set(file, 'js');
      for (const css of /** @type {ChunkReport} */ (byFile.get(file)).importedCss || []) start.set(css, 'css');
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
  }
  return graphs;
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
  for (const [name, entry] of Object.entries(/** @type {Record<string, any>} */ (budgets.entries))) {
    if (Boolean(entry.page) === Boolean(entry.chunk) && name !== 'background') fail(`entry ${name} names neither a page nor a chunk, or both`);
    if (typeof entry.reason !== 'string' || entry.reason === '') fail(`entry ${name} has no reason`);
    for (const category of entry.forbidden || []) if (!categories[category]) fail(`entry ${name} forbids ${category}, which isn't a category`);
    for (const [type, limit] of Object.entries(entry.start || {})) {
      if (limit === null) continue;
      const ok = limit && Number.isSafeInteger(limit.raw) && Number.isSafeInteger(limit.gzip) && limit.raw >= 0 && limit.gzip >= 0;
      if (!ok) fail(`entry ${name}'s ${type} row isn't whole numbers of bytes, raw and gzip`);
    }
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
 * The gate: every problem the analyzed entries have against the budgets
 * @param {Record<string, EntryGraph>} graphs
 * @param {BudgetFile} budgets
 * @param {{loaderChunks: Record<string, string>, files: PackageFiles}} built
 * @returns {Problem[]}
 */
function checkBudgets(graphs, budgets, { loaderChunks, files }) {
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

  for (const [name, graph] of Object.entries(graphs)) {
    const entry = budgets.entries[name];
    if (!entry || entry.planned) continue;
    for (const boot of graph.boots || []) {
      if (boot.file === null) problems.push(problem('budget/entry', name, `its row's startChunks names ${boot.chunk}, and the build has no loader chunk by that name, so its start would leave out what the page loads at boot`));
      else if (boot.from === null) problems.push(problem('budget/entry', name, `its row's startChunks names ${boot.chunk} (${boot.file}), and nothing on the page's start loads it with import(): the row says the page boots a chunk it doesn't`));
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
    for (const category of entry.forbidden || []) {
      const { paths } = budgets.forbidden[category];
      const found = graph.start.modules.filter((file) => paths.some((glob) => matches(glob, file)));
      if (found.length > 0) {
        const item = problem('budget/forbidden', name, `its start path holds ${category} (${budgets.forbidden[category].about}): ${found.join(', ')}`);
        problems.push(item);
      }
    }
    const allowed = new Set(entry.dependencies || []);
    const held = new Set([...graph.start.packages, ...graph.lazy.packages, ...graph.workers.packages]);
    for (const name2 of [...held].sort()) {
      if (!allowed.has(name2)) problems.push(problem('budget/dependency', name, `its graph holds ${name2}, which its row doesn't allow`));
    }
    for (const name2 of [...allowed].sort()) {
      if (!held.has(name2)) problems.push(problem('budget/dependency', name, `its row allows ${name2}, which its graph no longer holds: take it out`));
    }
  }
  return problems;
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

module.exports = { analyze, checkBudgets, readBudgets, fileProblems, matches, packageOf, vendoredPackages, sizesOf, BUDGETS_FILE };
