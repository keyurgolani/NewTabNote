'use strict';

/**
 * The security baseline (#21 slice 1b, PR 3): what the extension may reach and ask for, held
 * to the files in security/ that say so, so none of it changes without a reviewed entry.
 *
 *   security/drift                 the compared set (below) isn't what the latest
 *                                  security/changes.json entry recorded, or that entry doesn't
 *                                  name each part that changed since the one before it, its
 *                                  issue, or why
 *   security/permissions           the built manifest's permissions, host permissions, optional
 *                                  ones, or the offscreen document's reasons, and
 *                                  security/permissions.json differ, either way, or an entry
 *                                  there lacks its issue, warning, request point or rationale
 *   security/externally-connectable the manifest has externally_connectable
 *   security/unsafe-inline         style-src still allows 'unsafe-inline' though #16's counts of
 *                                  style attributes and <style> blocks are zero
 *   security/file                  a file in security/ doesn't read as its shape
 *
 * The compared set, part by part: the manifest's CSP (each directive, its sources sorted), its
 * permissions, host permissions, optional ones, and externally_connectable; the offscreen
 * document's reasons, as js/background.js creates it; the destination registry and the
 * network ledger; and the sources that hold the network rules: the destination client and its
 * rule module, the network guard and its installer, the proxy policy, and the two proxies.
 * An entry records each part's SHA-256 and one digest over them all. `npm run
 * check:security-baseline -- --print` prints what an entry for the tree as it is would record.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */

/** The sources whose network rules the baseline holds (Q7 of the plan) */
const SOURCES = Object.freeze([
  'js/kernel/composition/destinations.js',
  'js/kernel/composition/destination-match.js',
  'js/kernel/composition/network-guard.js',
  'js/kernel/composition/network-guard-install.js',
  'js/kernel/composition/api-request.js',
  'js/background.js',
  'js/offscreen.js',
]);

const PERMISSIONS_FILE = 'security/permissions.json';
const CHANGES_FILE = 'security/changes.json';
const DESTINATIONS_FILE = 'security/destinations.json';
const LEDGER_FILE = 'security/network-ledger.json';
/** #16's counts (scripts/design-token-scan.js) */
const DESIGN_BASELINE = 'test/fixtures/design-token-baseline.json';
/** The patterns of #16 the CSP's 'unsafe-inline' in style-src lets through */
const INLINE_STYLE_PATTERNS = Object.freeze(['style-attribute', 'inline-style-block']);

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * A value as JSON with its object keys sorted, so the same value reads the same however it was written
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(/** @type {Record<string, unknown>} */ (value)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * A CSP's directives, each to its sources sorted, lowercased
 * @param {unknown} policy
 * @returns {Record<string, string[]>}
 */
function directives(policy) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (typeof policy !== 'string') return out;
  for (const directive of policy.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    out[name.toLowerCase()] = sources.map((source) => source.toLowerCase()).sort();
  }
  return out;
}

/**
 * The extension pages' CSP in `manifest`
 * @param {any} manifest
 * @returns {Record<string, string[]>}
 */
function cspOf(manifest) {
  const csp = manifest && manifest.content_security_policy;
  return directives(csp && typeof csp === 'object' ? csp.extension_pages : csp);
}

/**
 * The reasons js/background.js creates the offscreen document with
 * @param {string} source
 * @returns {string[]}
 */
function offscreenReasons(source) {
  const found = /createDocument\(\{[\s\S]*?reasons:\s*\[([^\]]*)\]/.exec(source);
  return found ? [...found[1].matchAll(/['"]([A-Z_]+)['"]/g)].map(([, reason]) => reason).sort() : [];
}

/**
 * @typedef {object} Inputs
 * @property {any} manifest - the built manifest
 * @property {(file: string) => string} read - a file of the sources, by its path from the root
 */

/**
 * The compared set, part by part, each as the text its SHA-256 is of
 * @param {Inputs} inputs
 * @returns {Record<string, string>}
 */
function compared({ manifest, read }) {
  const sorted = (/** @type {unknown} */ list) => (Array.isArray(list) ? [...list].map(String).sort() : []);
  /** @type {Record<string, string>} */
  const parts = {
    'manifest.json#content_security_policy': canonical(cspOf(manifest)),
    'manifest.json#permissions': canonical(sorted(manifest.permissions)),
    'manifest.json#host_permissions': canonical(sorted(manifest.host_permissions)),
    'manifest.json#optional_permissions': canonical([...sorted(manifest.optional_permissions), ...sorted(manifest.optional_host_permissions)]),
    'manifest.json#externally_connectable': canonical(manifest.externally_connectable === undefined ? null : manifest.externally_connectable),
    'js/background.js#offscreen-reasons': canonical(offscreenReasons(read('js/background.js'))),
    [DESTINATIONS_FILE]: canonical(JSON.parse(read(DESTINATIONS_FILE))),
    [LEDGER_FILE]: canonical(JSON.parse(read(LEDGER_FILE))),
  };
  for (const file of SOURCES) parts[file] = read(file);
  return parts;
}

/**
 * What a changes.json entry for these inputs records: each part's SHA-256, and the digest over them
 * @param {Inputs} inputs
 * @returns {{digest: string, parts: Record<string, string>}}
 */
function recordOf(inputs) {
  const texts = compared(inputs);
  /** @type {Record<string, string>} */
  const parts = {};
  for (const name of Object.keys(texts).sort()) parts[name] = sha256(texts[name]);
  return { digest: sha256(canonical(parts)), parts };
}

/**
 * A file of the sources as JSON, or a security/file problem
 * @param {(file: string) => string} read
 * @param {string} file
 * @returns {{ok: true, value: any} | {ok: false, problem: Problem}}
 */
function readJson(read, file) {
  try {
    return { ok: true, value: JSON.parse(read(file)) };
  } catch (error) {
    return { ok: false, problem: problem('security/file', file, `doesn't read as JSON: ${error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error}`) };
  }
}

/**
 * The manifest's permissions against security/permissions.json, both ways
 * @param {any} manifest
 * @param {any} declared
 * @param {string} background - js/background.js's source
 * @returns {Problem[]}
 */
function permissionProblems(manifest, declared, background) {
  /** @type {Problem[]} */
  const problems = [];
  const fail = (/** @type {string} */ message) => problems.push(problem('security/permissions', PERMISSIONS_FILE, message));
  if (!declared || !Array.isArray(declared.permissions) || !Array.isArray(declared.hosts) || !Array.isArray(declared.offscreenReasons)) {
    return [problem('security/file', PERMISSIONS_FILE, 'has no permissions, hosts or offscreenReasons list')];
  }
  const entryProblems = (/** @type {any} */ entry, /** @type {string} */ key) => {
    const name = entry && entry[key];
    if (typeof name !== 'string' || name === '') return fail(`an entry with no ${key}`);
    if (!Number.isSafeInteger(entry.issue) || entry.issue <= 0) fail(`${name} names no owning issue`);
    if (typeof entry.rationale !== 'string' || entry.rationale.trim() === '') fail(`${name} gives no rationale`);
    if (key !== 'reason') {
      if (typeof entry.required !== 'boolean') fail(`${name} doesn't say whether it's required`);
      if (entry.installWarning !== null && typeof entry.installWarning !== 'string') fail(`${name}'s install warning is neither text nor null`);
      if (typeof entry.requestedAt !== 'string' || entry.requestedAt === '') fail(`${name} names no request point`);
      if (entry.required === true && entry.requestedAt !== 'install') fail(`${name} is required, so it's asked for at install`);
    }
  };
  declared.permissions.forEach((/** @type {any} */ entry) => entryProblems(entry, 'name'));
  declared.hosts.forEach((/** @type {any} */ entry) => entryProblems(entry, 'pattern'));
  declared.offscreenReasons.forEach((/** @type {any} */ entry) => entryProblems(entry, 'reason'));
  /**
   * @param {string} what
   * @param {unknown} asked - the manifest's list
   * @param {string[]} listed - the file's
   */
  const both = (what, asked, listed) => {
    const manifestSet = new Set(Array.isArray(asked) ? asked.map(String) : []);
    const listedSet = new Set(listed);
    for (const name of manifestSet) if (!listedSet.has(name)) fail(`the manifest asks for ${what} ${name}, which ${PERMISSIONS_FILE} doesn't list`);
    for (const name of listedSet) if (!manifestSet.has(name)) fail(`${PERMISSIONS_FILE} lists ${what} ${name}, which the manifest doesn't ask for`);
  };
  const named = (/** @type {any[]} */ list, /** @type {string} */ key, /** @type {boolean} */ required) => list.filter((entry) => entry && entry.required === required).map((entry) => String(entry[key]));
  both('the permission', manifest.permissions, named(declared.permissions, 'name', true));
  both('the optional permission', manifest.optional_permissions, named(declared.permissions, 'name', false));
  both('the host permission', manifest.host_permissions, named(declared.hosts, 'pattern', true));
  both('the optional host permission', manifest.optional_host_permissions, named(declared.hosts, 'pattern', false));
  both('the offscreen reason', offscreenReasons(background), declared.offscreenReasons.map((/** @type {any} */ entry) => String(entry && entry.reason)));
  if (declared.externallyConnectable !== false) fail('externallyConnectable is false: no web page or other extension may connect');
  return problems;
}

/**
 * The checks on what the build wrote and the sources
 * @param {Inputs} inputs
 * @returns {Problem[]}
 */
function checkSecurityBaseline(inputs) {
  const { manifest, read } = inputs;
  /** @type {Problem[]} */
  const problems = [];
  if (manifest && Object.hasOwn(manifest, 'externally_connectable')) {
    problems.push(problem('security/externally-connectable', 'manifest.json', 'externally_connectable lets a web page or another extension open a channel to this one; it stays absent'));
  }

  const declared = readJson(read, PERMISSIONS_FILE);
  if (!declared.ok) problems.push(declared.problem);
  else problems.push(...permissionProblems(manifest, declared.value, read('js/background.js')));

  // 'unsafe-inline' goes once nothing needs it: #16's counts of what it lets through
  const design = readJson(read, DESIGN_BASELINE);
  if (design.ok && (cspOf(manifest)['style-src'] || []).includes("'unsafe-inline'")) {
    const files = design.value && typeof design.value.files === 'object' && design.value.files ? design.value.files : {};
    const left = Object.values(files).reduce((sum, counts) => sum + INLINE_STYLE_PATTERNS.reduce((inner, pattern) => inner + (Number(counts && counts[pattern]) || 0), 0), 0);
    if (left === 0) problems.push(problem('security/unsafe-inline', 'manifest.json', `style-src allows 'unsafe-inline', and #16's counts of style attributes and <style> blocks (${DESIGN_BASELINE}) are zero: take it out`));
  }

  const changes = readJson(read, CHANGES_FILE);
  if (!changes.ok) return [...problems, changes.problem];
  const entries = changes.value && Array.isArray(changes.value.entries) ? changes.value.entries : null;
  if (!entries || entries.length === 0) return [...problems, problem('security/file', CHANGES_FILE, 'has no entries')];
  /** @type {Record<string, string>} */
  let parts;
  /** @type {string} */
  let digest;
  try {
    ({ parts, digest } = recordOf(inputs));
  } catch (error) {
    return [...problems, problem('security/file', 'security/', `the compared set couldn't be read: ${error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error}`)];
  }
  const latest = entries[entries.length - 1];
  const previous = entries.length > 1 ? entries[entries.length - 2] : null;
  const drift = (/** @type {string} */ message) => problems.push(problem('security/drift', CHANGES_FILE, message));
  const recorded = latest && latest.parts && typeof latest.parts === 'object' ? latest.parts : {};
  const changed = Object.keys(parts).filter((name) => recorded[name] !== parts[name]);
  if (latest.digest !== digest || changed.length > 0) {
    drift(`the latest entry doesn't record the tree as it is: ${changed.length > 0 ? changed.join(', ') : 'its digest'} changed. Add an entry with its issue, the files it changes, and why (npm run check:security-baseline -- --print).`);
  }
  if (!Number.isSafeInteger(latest.issue) || latest.issue <= 0) drift('the latest entry names no issue');
  if (!Array.isArray(latest.rationale) || latest.rationale.length === 0 || !latest.rationale.every((/** @type {any} */ item) => item && typeof item.change === 'string' && item.change !== '' && typeof item.why === 'string' && item.why !== '')) {
    drift('the latest entry gives no rationale: each change it makes, and why');
  }
  const before = previous && previous.parts && typeof previous.parts === 'object' ? previous.parts : {};
  const touched = Object.keys(recorded).filter((name) => before[name] !== recorded[name]);
  const files = Array.isArray(latest.files) ? latest.files : [];
  const unnamed = touched.filter((name) => !files.includes(name));
  if (unnamed.length > 0) drift(`the latest entry changes ${unnamed.join(', ')} without naming it in its files`);
  return problems;
}

/**
 * Inputs from a build's directory and the sources at `root`
 * @param {string} buildDir
 * @param {string} root
 * @returns {Inputs}
 */
function inputsFrom(buildDir, root) {
  return {
    manifest: JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8')),
    read: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
  };
}

module.exports = { checkSecurityBaseline, recordOf, compared, cspOf, offscreenReasons, inputsFrom, SOURCES, CHANGES_FILE, PERMISSIONS_FILE };
