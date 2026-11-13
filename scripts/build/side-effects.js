'use strict';

/**
 * The side-effects list (#300, from #27's Architecture: treeshake.moduleSideEffects "is true only
 * for entry roots and the legacy global-assigning files in build/side-effects.json, which may only
 * shrink"). The bundler keeps a first-party module that nothing takes anything from only when it's
 * an entry root, which each pass's inputs give (entryRoots), or a module the list holds. Any other
 * such module drops whole, so an import made for side effects only, `import './x.js'`, has to name
 * a listed module, or the module would leave the bundle unseen.
 *   side-effects/unlisted   a first-party import for side effects only names a module the list lacks
 *   side-effects/stale      a listed module no such import names
 *   side-effects/file       the list is missing, doesn't parse, or doesn't read as its groups
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');
const { isObject, readList } = require('./json-file.js');
const { scanScript } = require('./js-scan.js');
const { htmlTags } = require('./markup.js');
const { PAGES, BACKGROUND_ENTRY, GUARD_SCRIPT } = require('./vite-config.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {{file: string, text: string}} Source */

const ROOT = path.join(__dirname, '..', '..');
const LIST_FILE = 'build/side-effects.json';
const FIELDS = Object.freeze({ list: ['about', 'groups'], group: ['owner', 'reason', 'modules'] });
/** A module's path under the sources: js/, then folders, then a script */
const MODULE_PATH = /^js\/(?:[\w.-]+\/)*[\w.-]+\.m?js$/;

/**
 * The problems with the list's shape, before it's used
 * @param {unknown} list
 * @returns {Problem[]}
 */
function fileProblems(list) {
  const fail = (/** @type {string[]} */ faults) => faults.map((fault) => problem('side-effects/file', LIST_FILE, fault));
  if (!isObject(list) || !Array.isArray(list.groups)) return fail(['has no groups: a list of each owner, its reason, and its modules']);
  /** @type {string[]} */
  const faults = [];
  if (typeof list.about !== 'string' || list.about === '') faults.push('has no about text');
  const extra = Object.keys(list).filter((key) => !FIELDS.list.includes(key));
  if (extra.length > 0) faults.push(`has ${extra.join(', ')}, which the list doesn't take`);
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [i, group] of list.groups.entries()) {
    const label = `group ${i + 1}`;
    if (!isObject(group)) {
      faults.push(`${label} isn't an object`);
      continue;
    }
    const fields = Object.keys(group).filter((key) => !FIELDS.group.includes(key));
    if (fields.length > 0) faults.push(`${label} has ${fields.join(', ')}, which a group doesn't take`);
    if (!Number.isSafeInteger(group.owner) || /** @type {number} */ (group.owner) < 1) faults.push(`${label} has no owner: the number of the issue that owns it`);
    if (typeof group.reason !== 'string' || group.reason === '') faults.push(`${label} has no reason`);
    if (!Array.isArray(group.modules) || group.modules.length === 0) {
      faults.push(`${label} has no modules`);
      continue;
    }
    for (const module of group.modules) {
      if (typeof module !== 'string' || !MODULE_PATH.test(module)) faults.push(`${label} names ${JSON.stringify(module)}, which is no module's path under js/`);
      else if (seen.has(module)) faults.push(`${label} names ${module} again`);
      else seen.add(module);
    }
  }
  return fail(faults);
}

/**
 * Read build/side-effects.json from `root`. It lists no module when it has a problem.
 * @param {string} [root]
 * @returns {{modules: Set<string>, problems: Problem[]}}
 */
function readSideEffects(root = ROOT) {
  const { value, problems } = readList(root, LIST_FILE, 'side-effects/file', fileProblems);
  if (value === undefined) return { modules: new Set(), problems };
  const { groups } = /** @type {{groups: Array<{modules: string[]}>}} */ (value);
  return { modules: new Set(groups.flatMap((group) => group.modules)), problems };
}

/**
 * Every first-party module under js/, the vendored files in js/lib/ aside, with its text
 * @param {string} [root]
 * @returns {Source[]}
 */
function firstPartySources(root = ROOT) {
  /** @type {Source[]} */
  const found = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (file !== 'js/lib') walk(file);
      } else if (/\.m?js$/.test(entry.name)) {
        found.push({ file, text: fs.readFileSync(path.join(root, file), 'utf8') });
      }
    }
  };
  walk('js');
  return found.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/**
 * A reference's target as a path under the sources, or null for one outside them
 * @param {string} from
 * @param {string} value
 * @returns {string | null}
 */
function target(from, value) {
  if (!/^\.{1,2}\//.test(value)) return null;
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(from), value.replace(/[?#].*$/, '')));
  return file.startsWith('../') ? null : file;
}

/**
 * The entry roots, from each pass's inputs: each page's module scripts, the service worker, the
 * network guard, and each module worker a first-party module starts
 * @param {string} [root]
 * @param {Source[]} [sources]
 * @returns {Set<string>}
 */
function entryRoots(root = ROOT, sources = firstPartySources(root)) {
  /** @type {Set<string>} */
  const roots = new Set([BACKGROUND_ENTRY, GUARD_SCRIPT]);
  for (const page of Object.values(PAGES)) {
    for (const tag of htmlTags(fs.readFileSync(path.join(root, page), 'utf8'))) {
      const src = tag.name === 'script' && (tag.attributes.get('type') || '').trim().toLowerCase() === 'module' ? tag.attributes.get('src') : undefined;
      if (src) roots.add(path.posix.normalize(src.replace(/[?#].*$/, '').replace(/^\//, '')));
    }
  }
  for (const { file, text } of sources) {
    for (const { kind, value } of scanScript(file, text).references) {
      const worker = kind === 'worker-url' && value !== null ? target(file, value) : null;
      if (worker) roots.add(worker);
    }
  }
  return roots;
}

/**
 * Whether a path under `root` is a file
 * @param {string} root
 * @returns {(file: string) => boolean}
 */
function fileUnder(root) {
  return (file) => fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * The problems with the first-party imports made for side effects only, against the list. One of a
 * file that isn't there is the bundler's to fail (build/bundle), so only a module that's there is
 * unlisted.
 * @param {Source[]} sources
 * @param {Set<string>} listed
 * @param {(file: string) => boolean} [exists] - whether a path under the root is a file
 * @returns {Problem[]}
 */
function sideEffectProblems(sources, listed, exists = fileUnder(ROOT)) {
  /** @type {Problem[]} */
  const problems = [];
  /** @type {Set<string>} */
  const named = new Set();
  for (const { file, text } of sources) {
    for (const { kind, value, at, bare } of scanScript(file, text).references) {
      const module = kind === 'import' && bare && value !== null ? target(file, value) : null;
      if (module === null) continue;
      named.add(module);
      if (!listed.has(module) && exists(module)) problems.push(problem('side-effects/unlisted', `${file}:${at}`, `imports ${module} for its side effects only, and ${LIST_FILE} doesn't list it, so the bundler would drop it. List it with its owner and reason, or import what it exports.`));
    }
  }
  for (const module of listed) {
    if (!named.has(module)) problems.push(problem('side-effects/stale', LIST_FILE, `lists ${module}, and no first-party import for side effects only names it, so its row goes. The list only shrinks.`));
  }
  return problems;
}

module.exports = { readSideEffects, fileProblems, firstPartySources, entryRoots, sideEffectProblems, fileUnder, LIST_FILE };
