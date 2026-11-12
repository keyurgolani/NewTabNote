'use strict';

/**
 * Runs the bundler's four passes (scripts/build/vite-config.js) and turns what goes wrong into
 * problems (#27 "Failure rules"). An error from the bundler is `build/bundle` (an import it
 * can't resolve, a file it can't parse), `build/css` from the stylesheet pipeline, or
 * `build/terser` from the minifier. A warning Vite or the bundler prints is
 * `build/bundler-warning` unless build/warning-allowlist.json has a row for it
 * (scripts/build/warning-allowlist.js), and a stylesheet's is `build/css`, which no row allows. A
 * module the bundler wrapped as CommonJS is `build/commonjs` (scripts/build/commonjs.js), and a
 * loader that isn't alone in its chunk at its own path, or lacks the build's ID, `build/loader`.
 *
 * It reports what the passes wrote: build-info.json's chunks (each loader-addressable chunk's
 * name to its file), the module map for dist-report/modules.json (each source module to the
 * files that hold it), and the modules of each graph, which the source checks read.
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');
const { pagesConfig, recoveryConfig, backgroundConfig, guardConfig, BACKGROUND_ENTRY, LOADER } = require('./vite-config.js');
const { guardOrderProblems, guardRegistry } = require('./guard.js');
const { checkWarnings, CSS_WARNING, ALLOWLIST_FILE } = require('./warning-allowlist.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./vite-config.js').BundleReport} BundleReport */
/** @typedef {import('./vite-config.js').ChunkReport} ChunkReport */
/** @typedef {import('./vite-config.js').Mode} Mode */
/** @typedef {import('./vite-config.js').Logger} Logger */

/**
 * @typedef {object} Bundled
 * @property {Problem[]} problems
 * @property {Record<string, string>} chunks - loader name to file, for build-info.json
 * @property {Record<string, string[]>} modules - source path to the files that hold it
 * @property {{background: string[], pages: string[]}} graphs - the source paths each pass bundled,
 *   workers counted with the pages
 * @property {ChunkReport[]} report - every chunk each pass wrote, for the budgets' analyzer
 * @property {string[]} allowed - each warning build/warning-allowlist.json allowed, for the log
 */

/** ANSI color codes, which Vite's messages carry */
const COLORS = /\u001b\[[0-9;]*m/g;

/**
 * A message without color codes or trailing blank lines
 * @param {unknown} text
 * @returns {string}
 */
function plain(text) {
  return String(text).replace(COLORS, '').replace(/\s+$/, '');
}

/**
 * `root`, and its real path when that differs, as a temporary directory's does on macOS
 * (/var is /private/var), since some ids come through the real path
 * @param {string} root
 * @returns {string[]}
 */
function rootsOf(root) {
  try {
    const real = fs.realpathSync(root);
    return real === root ? [root] : [root, real];
  } catch {
    return [root];
  }
}

/**
 * A module id as a path relative to `root` with / between folders, or null for a module that
 * isn't a file of the sources: a virtual module, an id with a query, or a dependency
 * @param {string} id
 * @param {string} root
 * @returns {string | null}
 */
function sourcePath(id, root) {
  if (id.includes('\0') || id.includes('?')) return null;
  for (const base of rootsOf(root)) {
    const relative = path.relative(base, id);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const file = relative.split(path.sep).join('/');
    return file.startsWith('node_modules/') ? null : file;
  }
  return null;
}

/**
 * The bundler's moduleSideEffects (#300): a first-party module keeps its side effects only when
 * it's in `keep`, the entry roots and build/side-effects.json's modules
 * (scripts/build/side-effects.js), so any other one nothing takes anything from drops whole. Vite's
 * own modules, the pages and stylesheets, and the dependencies keep theirs as they come.
 * @param {string} root
 * @param {Set<string>} keep - source paths
 * @returns {(id: string) => boolean}
 */
function sideEffectsFor(root, keep) {
  return (id) => {
    const file = sourcePath(id, root);
    return file === null || !/\.m?js$/.test(file) || keep.has(file);
  };
}

/**
 * The problem for an error a pass threw. The bundler names the plugin that threw on the error
 * or, for one it wraps, at the start of the message: `[plugin vite:css] <file>`.
 * @param {any} error
 * @param {string} root
 * @returns {Problem}
 */
function bundlerProblem(error, root) {
  const message = plain(error && error.message ? error.message : error);
  const named = /^\[plugin ([^\]\s]+)\]\s+(\S+?)(?::undefined:NaN|:\d+:\d+)?(?:\s|$)/.exec(message);
  const plugin = error && typeof error.plugin === 'string' ? error.plugin : (named ? named[1] : '');
  const id = error && typeof error.id === 'string' ? error.id : (named && path.isAbsolute(named[2]) ? named[2] : '');
  const file = id ? (sourcePath(id.replace(/\?.*$/, ''), root) || id) : '';
  const loc = error && error.loc && Number.isInteger(error.loc.line) ? `:${error.loc.line}:${(error.loc.column || 0) + 1}` : '';
  const subject = file ? `${file}${loc}` : 'the bundle';
  if (/terser/.test(plugin)) return problem('build/terser', subject, `terser refused it: ${message}`);
  if (/css/.test(plugin) || /\.css$/.test(file) || /lightningcss|\[postcss\]/.test(message)) return problem('build/css', subject, `the stylesheet pipeline refused it: ${message}`);
  return problem('build/bundle', subject, message);
}

/**
 * The problem for a warning Vite or the bundler logged that no build/warning-allowlist.json row
 * allows. A stylesheet's is the stylesheet's, as a CleanCSS warning was (#89's review), and any
 * other the bundle's.
 * @param {string} warning
 * @returns {Problem}
 */
function warningProblem(warning) {
  const [first, ...rest] = warning.split('\n');
  const found = CSS_WARNING.test(first)
    ? problem('build/css', 'the stylesheets', `${first}. A CSS warning fails the build as an error does.`)
    : problem('build/bundler-warning', 'the bundle', `${first}. ${ALLOWLIST_FILE} has no row for it.`);
  if (rest.length > 0) found.details = rest.slice(0, 12);
  return found;
}

/**
 * Each JS chunk a pass wrote, with the pass and the bytes its report recorded as the pass wrote it:
 * the bundler's own chunk-size measure, the chunk's code in UTF-8 (scripts/build/vite-config.js's
 * reportPlugin). The warning names no chunk (scripts/build/warning-allowlist.js). A module worker's
 * chunk is an asset to its page's bundle, which the bundler doesn't measure, so it isn't here. A
 * chunk a pass made and never wrote has no measure, so it's a problem, never a silent skip.
 * @param {BundleReport} report
 * @param {(index: number) => string} passAt - the pass that wrote report.chunks[index]
 * @returns {{chunks: Array<{pass: string, name: string, bytes: number}>, problems: Problem[]}}
 */
function measuredChunks(report, passAt) {
  /** @type {Array<{pass: string, name: string, bytes: number}>} */
  const chunks = [];
  /** @type {Problem[]} */
  const problems = [];
  for (const [i, chunk] of report.chunks.entries()) {
    if (chunk.pass === 'worker') continue;
    if (chunk.bytes === undefined) problems.push(problem('build/bundle', chunk.fileName, `the ${passAt(i)} pass made this chunk and never wrote it, so the bundler's chunk-size measure has nothing to read`));
    else chunks.push({ pass: passAt(i), name: chunk.name, bytes: chunk.bytes });
  }
  return { chunks, problems };
}

/**
 * Where each pass's chunks and warnings start in the build's report and warnings, so each one is
 * the pass's that made it (#321's review). The report labels recovery.html's chunks as the pages
 * pass's, so only this tells them apart. begin(pass) marks a pass's start before it runs, and
 * read(complete) gives each warning's pass and, once every pass ran, each JS chunk in the
 * bundler's own measure with its pass.
 * @param {BundleReport} report
 * @param {string[]} warnings
 */
function passTies(report, warnings) {
  /** @type {Array<{pass: string, chunks: number, warnings: number}>} */
  const starts = [];
  const passAt = (/** @type {'chunks' | 'warnings'} */ key, /** @type {number} */ index) => starts.filter((start) => start[key] <= index).at(-1)?.pass ?? 'pages';
  return {
    /** @param {string} pass */
    begin(pass) {
      starts.push({ pass, chunks: report.chunks.length, warnings: warnings.length });
    },
    /** @param {boolean} complete */
    read(complete) {
      return {
        measured: complete ? measuredChunks(report, (i) => passAt('chunks', i)) : { chunks: [], problems: [] },
        passes: warnings.map((_, i) => passAt('warnings', i)),
      };
    },
  };
}

/**
 * A Vite logger that keeps each warning instead of printing it, and drops the rest
 * @param {Logger} base
 * @param {string[]} warnings
 * @returns {Logger}
 */
function keepingLogger(base, warnings) {
  /** @type {Set<string>} */
  const once = new Set();
  return {
    ...base,
    hasWarned: false,
    info() {},
    warn(message) {
      warnings.push(plain(message));
    },
    warnOnce(message) {
      if (once.has(message)) return;
      once.add(message);
      warnings.push(plain(message));
    },
    error() {
      // A pass that logs an error also throws it, and the throw is the problem
    },
  };
}

/**
 * build-info.json's chunks: each loader-addressable chunk's name to its file. That's each page's
 * entry, each chunk a dynamic import starts, each module worker, and the background.
 * @param {BundleReport} report
 * @returns {{chunks: Record<string, string>, problems: Problem[]}}
 */
function chunkNames(report) {
  /** @type {Record<string, string>} */
  const chunks = {};
  /** @type {Problem[]} */
  const problems = [];
  const named = report.chunks
    // The network guard is no chunk the loader loads: each page's first script is
    .filter((chunk) => (chunk.isEntry || chunk.isDynamicEntry) && chunk.pass !== 'guard')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.fileName < b.fileName ? -1 : 1));
  for (const chunk of named) {
    const existing = chunks[chunk.name];
    if (existing !== undefined && existing !== chunk.fileName) {
      problems.push(problem('build/bundle', chunk.name, `two chunks are named ${chunk.name}, ${existing} and ${chunk.fileName}; build-info.json's chunks needs one file per name. Rename one of their modules.`));
      continue;
    }
    chunks[chunk.name] = chunk.fileName;
  }
  return { chunks, problems };
}

/**
 * A problem for each module the bundler wrapped as CommonJS, whatever made it wrap: a free
 * exports or require, or a pass without the define that makes module undefined
 * (scripts/build/commonjs.js has the rule, #99's review)
 * @param {BundleReport} report
 * @param {string} root
 * @returns {Problem[]}
 */
function commonJsProblems(report, root) {
  return report.chunks.flatMap((chunk) => (chunk.commonJs || []).map((id) => problem('build/commonjs', sourcePath(id, root) || id,
    `the bundler wrapped it as CommonJS in ${chunk.fileName}, so it gets a module object and takes its Node branch, and a page would never get its global. It names exports or require, or the pass lacks the define that makes module undefined.`)));
}

/**
 * The loader's chunk (#27 slice 3): the loader alone, at its own path, carrying the build's ID,
 * which it compares with build-info.json's. Held with other modules, the closure check's one
 * exemption would cover them too; without the ID, an update under an open page would read as
 * a missing chunk.
 * @param {BundleReport} report
 * @param {string} root
 * @param {string} outDir
 * @param {string} buildId
 * @returns {Problem[]}
 */
function loaderProblems(report, root, outDir, buildId) {
  /** @type {Problem[]} */
  const problems = [];
  const fail = (/** @type {string} */ message) => problems.push(problem('build/loader', LOADER, message));
  const holders = report.chunks.filter((chunk) => chunk.moduleIds.some((id) => sourcePath(id, root) === LOADER));
  if (holders.length !== 1 || holders[0].fileName !== LOADER) {
    fail(`the bundle writes it into ${holders.map((chunk) => chunk.fileName).join(', ') || 'no chunk'}, not into a chunk of its own at its path`);
    return problems;
  }
  const others = holders[0].moduleIds.filter((id) => !id.includes('\0') && sourcePath(id, root) !== LOADER);
  if (others.length > 0) fail(`its chunk holds ${others.map((id) => sourcePath(id, root) || id).join(', ')} too`);
  if (!fs.readFileSync(path.join(outDir, LOADER), 'utf8').includes(buildId)) {
    fail(`it doesn't carry the build's ID, ${buildId}, so it would read an update under an open page as a missing chunk`);
  }
  return problems;
}

/**
 * Each source module to the files that hold it, and the modules each pass bundled
 * @param {BundleReport} report
 * @param {string} root
 * @returns {{modules: Record<string, string[]>, graphs: Bundled['graphs']}}
 */
function moduleMap(report, root) {
  /** @type {Map<string, Set<string>>} */
  const holders = new Map();
  /** @type {{background: Set<string>, pages: Set<string>}} */
  const graphs = { background: new Set(), pages: new Set() };
  for (const chunk of report.chunks) {
    for (const id of chunk.moduleIds) {
      const file = sourcePath(id, root);
      if (file === null || !/\.m?js$/.test(file)) continue;
      if (!holders.has(file)) holders.set(file, new Set());
      /** @type {Set<string>} */ (holders.get(file)).add(chunk.fileName);
      graphs[chunk.pass === 'background' ? 'background' : 'pages'].add(file);
    }
  }
  /** @type {Record<string, string[]>} */
  const modules = {};
  for (const file of [...holders.keys()].sort()) modules[file] = [.../** @type {Set<string>} */ (holders.get(file))].sort();
  return { modules, graphs: { background: [...graphs.background].sort(), pages: [...graphs.pages].sort() } };
}

/**
 * Bundle the pages and the background into `outDir`, with the build's ID and the define
 * allowlist's rows inlined, and each warning the passes print checked against the warning allowlist
 * @param {{root: string, outDir: string, mode: Mode, buildId: string, defineRows: import('./vite-config.js').PassOptions['defineRows'], allowlist: import('./warning-allowlist.js').WarningAllowlist, keep: Set<string>}} options
 * @returns {Promise<Bundled>}
 */
async function bundle({ root, outDir, mode, buildId, defineRows, allowlist, keep }) {
  const vite = await import('vite');
  /** @type {string[]} */
  const warnings = [];
  /** @type {BundleReport} */
  const report = { chunks: [], assets: [] };
  const logger = keepingLogger(vite.createLogger('silent'), warnings);
  /** @type {import('./vite-config.js').PassOptions['onLog']} */
  const onLog = (level, log, handler) => {
    if (level === 'warn') {
      warnings.push(plain(`${log.code ? `${log.code}: ` : ''}${log.message}`));
      return;
    }
    if (level === 'info' || level === 'debug') return;
    handler(level, log);
  };
  const options = { root, outDir, mode, buildId, defineRows, report, logger, onLog, sideEffects: sideEffectsFor(root, keep) };

  /** @type {Problem[]} */
  const problems = [];
  // Whether every pass ran: until then, a row's warning may be one a pass that didn't run prints
  let complete = false;
  const ties = passTies(report, warnings);
  const run = async (/** @type {string} */ pass, /** @type {import('./vite-config.js').InlineConfig} */ config) => {
    ties.begin(pass);
    await vite.build(config);
  };
  try {
    await run('pages', pagesConfig(options));
    // recovery.html in a pass of its own, so it splits no chunk the other pages share
    await run('recovery', recoveryConfig(options));
    await run('background', backgroundConfig(options));
    // The page guard inlines the registry's rows cut, once they're validated
    const registry = await guardRegistry(root);
    if ('problem' in registry) problems.push(registry.problem);
    else {
      await run('guard', guardConfig({ ...options, guardRows: registry.rows }));
      complete = true;
    }
  } catch (error) {
    problems.push(bundlerProblem(error, root));
  }
  const { measured, passes } = ties.read(complete);
  const checked = checkWarnings(warnings, allowlist, { mode, complete, chunks: measured.chunks, passes });
  problems.push(...measured.problems, ...checked.unlisted.map(warningProblem), ...checked.problems);
  if (problems.length > 0) return { problems, chunks: {}, modules: {}, graphs: { background: [], pages: [] }, report: [], allowed: [] };

  const named = chunkNames(report);
  const { modules, graphs } = moduleMap(report, root);
  if (!named.chunks.background || named.chunks.background !== BACKGROUND_ENTRY) {
    named.problems.push(problem('build/bundle', BACKGROUND_ENTRY, `the background pass wrote ${named.chunks.background || 'nothing'} instead`));
  }
  return {
    problems: [...named.problems, ...commonJsProblems(report, root), ...loaderProblems(report, root, outDir, buildId), ...guardOrderProblems(report, root, sourcePath)],
    chunks: named.chunks,
    modules,
    graphs,
    report: report.chunks,
    allowed: checked.allowed,
  };
}

module.exports = { bundle, bundlerProblem, warningProblem, measuredChunks, passTies, sideEffectsFor, chunkNames, moduleMap, commonJsProblems, loaderProblems, sourcePath, keepingLogger };
