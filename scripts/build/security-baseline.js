'use strict';

/**
 * The security baseline (#21 slice 1b, PR 3): what the extension may reach and ask for, held
 * to the files in security/ that say so, so none of it changes without a reviewed entry.
 *
 *   security/drift                 the compared set (below) isn't what the latest
 *                                  security/changes.json entry recorded, or that entry doesn't
 *                                  name each part that changed since the one before it, its
 *                                  issue, or why
 *   security/csp-repeated          the extension pages' CSP names a directive twice: Chromium
 *                                  enforces the first copy, and the baseline reads it the same way
 *   security/csp-characters        the extension pages' CSP holds a character outside printable
 *                                  ASCII and ASCII whitespace, or a directive name outside
 *                                  [a-z0-9-]: Chromium separates only on ASCII whitespace, and
 *                                  ignores a directive whose name it doesn't read
 *   security/permissions           the built manifest's permissions, host permissions, optional
 *                                  ones, or the offscreen document's reasons, and
 *                                  security/permissions.json differ, either way, or an entry
 *                                  there lacks its issue, warning, request point or rationale,
 *                                  or a script creates the document with reasons it can't read
 *   security/externally-connectable the manifest has externally_connectable
 *   security/unsafe-inline         style-src still allows 'unsafe-inline' though #16's counts of
 *                                  style attributes and <style> blocks are zero
 *   security/file                  a file in security/ doesn't read as its shape
 *   security/history               an entry the base branch's security/changes.json has is
 *                                  changed or gone (checkHistory; npm run
 *                                  check:security-baseline -- --base <ref>, which CI runs)
 *
 * The compared set, part by part: the manifest's CSP (each directive as Chromium reads it, its
 * sources sorted), its permissions, host permissions, optional ones, externally_connectable,
 * and every other key but the cosmetic ones (COSMETIC_KEYS); the offscreen document's reasons,
 * wherever a first-party script creates it; the destination registry and the network ledger;
 * and the sources that hold the network rules: the destination client, the rows it imports and
 * its rule module, the network guard, its installer and the module that installs it first, the
 * proxy policy, the worker's network module, and the offscreen document. An entry records each part's SHA-256 and one digest over them all. `npm
 * run check:security-baseline -- --print` prints what an entry for the tree as it is would record.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */

/** The sources whose network rules the baseline holds (Q7 of the plan) */
const SOURCES = Object.freeze([
  'js/kernel/composition/destinations.js',
  'js/kernel/composition/destination-rows.js',
  'js/kernel/composition/destination-match.js',
  'js/kernel/composition/network-guard.js',
  'js/kernel/composition/network-guard-install.js',
  'js/kernel/composition/network-guard-first.js',
  'js/kernel/composition/api-request.js',
  'js/kernel/composition/worker-network.js',
  'js/offscreen.js',
]);

/**
 * The manifest's keys that change what the store shows and nothing the extension may do,
 * which the baseline leaves out
 */
const COSMETIC_KEYS = Object.freeze(['name', 'short_name', 'description', 'version', 'version_name', 'icons', 'author', 'homepage_url']);

/** The manifest's keys the compared set holds as parts of their own */
const OWN_PARTS = Object.freeze(['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions', 'externally_connectable']);

/** A call that creates the offscreen document */
const CREATE_DOCUMENT = /\bcreateDocument\s*\(/g;

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

/** What separates a CSP's tokens: ASCII whitespace, and nothing else (the CSP spec) */
const ASCII_WHITESPACE = /[\t\n\f\r ]+/;
/** The characters a policy may hold: printable ASCII and ASCII whitespace */
const POLICY_CHARACTERS = /^[\t\n\f\r\x20-\x7e]*$/;
/** A directive name Chromium reads */
const DIRECTIVE_NAME = /^[a-z0-9-]+$/;

/**
 * A CSP source as Chromium compares it: a keyword, a scheme and a host without case, and a
 * hash's or nonce's value, and a path, with it, a source with no scheme included
 * @param {string} source
 * @returns {string}
 */
function normalSource(source) {
  const value = /^'(sha256-|sha384-|sha512-|nonce-)(.*)'$/i.exec(source);
  if (value) return `'${value[1].toLowerCase()}${value[2]}'`;
  if (source.startsWith("'")) return source.toLowerCase();
  const host = /^((?:[a-z][a-z0-9+.-]*:\/\/)?[^/]*)(.*)$/i.exec(source);
  return host ? `${host[1].toLowerCase()}${host[2]}` : source.toLowerCase();
}

/**
 * A CSP read as Chromium reads it: split on ASCII whitespace only, each directive's first copy,
 * its sources sorted; the names of the directives it repeats, which Chromium ignores; and what
 * Chromium wouldn't read as a directive: a character outside printable ASCII and ASCII
 * whitespace, or a name outside [a-z0-9-]
 * @param {unknown} policy
 * @returns {{directives: Record<string, string[]>, repeated: string[], unreadable: string[]}}
 */
function parsePolicy(policy) {
  /** @type {Record<string, string[]>} */
  const directives = {};
  /** @type {string[]} */
  const repeated = [];
  /** @type {string[]} */
  const unreadable = [];
  if (typeof policy !== 'string') return { directives, repeated, unreadable };
  if (!POLICY_CHARACTERS.test(policy)) unreadable.push('a character outside printable ASCII and ASCII whitespace');
  for (const directive of policy.split(';')) {
    const [rawName, ...sources] = directive.split(ASCII_WHITESPACE).filter(Boolean);
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (!DIRECTIVE_NAME.test(name)) {
      unreadable.push(`the directive name ${JSON.stringify(rawName)}`);
      continue;
    }
    if (Object.hasOwn(directives, name)) {
      if (!repeated.includes(name)) repeated.push(name);
      continue;
    }
    directives[name] = sources.map(normalSource).sort();
  }
  return { directives, repeated, unreadable };
}

/**
 * The extension pages' CSP in `manifest`
 * @param {any} manifest
 * @returns {string | undefined}
 */
function pagesPolicy(manifest) {
  const csp = manifest && manifest.content_security_policy;
  return csp && typeof csp === 'object' ? csp.extension_pages : csp;
}

/**
 * The extension pages' CSP in `manifest`, directive by directive, as Chromium reads it
 * @param {any} manifest
 * @returns {Record<string, string[]>}
 */
function cspOf(manifest) {
  return parsePolicy(pagesPolicy(manifest)).directives;
}

/**
 * The reasons a script creates the offscreen document with, and how many of its createDocument
 * calls give reasons that aren't a list of string literals
 * @param {string} source
 * @returns {{reasons: string[], unread: number}}
 */
function offscreenReasons(source) {
  /** @type {Set<string>} */
  const reasons = new Set();
  let unread = 0;
  for (const call of source.matchAll(CREATE_DOCUMENT)) {
    const rest = source.slice(/** @type {number} */ (call.index) + call[0].length);
    // Its options object, after a type cast's comment and parenthesis if it has them
    const found = /^\s*(?:\/\*\*?[^*]*\*+\/\s*\(\s*)?\{[^{}]*?\breasons\s*:\s*\[([^\]]*)\]/.exec(rest);
    const listed = found ? found[1].split(',').map((item) => item.trim()).filter(Boolean) : [];
    const literal = listed.length > 0 && listed.every((item) => /^(['"])[A-Z_]+\1$/.test(item));
    if (!literal) {
      unread += 1;
      continue;
    }
    for (const item of listed) reasons.add(item.slice(1, -1));
  }
  return { reasons: [...reasons].sort(), unread };
}

/**
 * The offscreen document's reasons in each of `scripts` that creates it
 * @param {Inputs} inputs
 * @returns {{byFile: Record<string, string[]>, reasons: string[], unread: string[]}}
 */
function offscreenUse({ read, scripts = SOURCES }) {
  /** @type {Record<string, string[]>} */
  const byFile = {};
  /** @type {Set<string>} */
  const all = new Set();
  /** @type {string[]} */
  const unread = [];
  for (const file of [...scripts].sort()) {
    const text = read(file);
    if (!/\bcreateDocument\s*\(/.test(text)) continue;
    const found = offscreenReasons(text);
    byFile[file] = found.reasons;
    found.reasons.forEach((reason) => all.add(reason));
    if (found.unread > 0) unread.push(file);
  }
  return { byFile, reasons: [...all].sort(), unread };
}

/**
 * The first-party scripts under `root`'s js/, which the offscreen reasons are read from: every
 * .js and .mjs file but the vendored ones in js/lib/
 * @param {string} root
 * @returns {string[]}
 */
function firstPartyScripts(root) {
  /** @type {string[]} */
  const found = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (file !== 'js/lib') walk(file);
      } else if (/\.m?js$/.test(entry.name)) {
        found.push(file);
      }
    }
  };
  if (fs.existsSync(path.join(root, 'js'))) walk('js');
  return found.sort();
}

/**
 * The manifest without its cosmetic keys and the ones held as parts of their own: the extension
 * pages' CSP comes out of content_security_policy, and the rest of it, a sandbox CSP, stays
 * @param {any} manifest
 * @returns {Record<string, unknown>}
 */
function otherKeys(manifest) {
  /** @type {Record<string, unknown>} */
  const rest = {};
  if (!manifest || typeof manifest !== 'object') return rest;
  for (const [key, value] of Object.entries(manifest)) {
    if (COSMETIC_KEYS.includes(key) || OWN_PARTS.includes(key)) continue;
    if (key === 'content_security_policy' && value && typeof value === 'object') {
      const { extension_pages: _, ...others } = /** @type {Record<string, unknown>} */ (value);
      if (Object.keys(others).length > 0) rest[key] = others;
      continue;
    }
    if (key === 'content_security_policy') continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * @typedef {object} Inputs
 * @property {any} manifest - the built manifest
 * @property {(file: string) => string} read - a file of the sources, by its path from the root
 * @property {readonly string[]} [scripts] - the first-party scripts the offscreen reasons are read from
 *   (firstPartyScripts), SOURCES when it's left out
 */

/**
 * The compared set, part by part, each as the text its SHA-256 is of
 * @param {Inputs} inputs
 * @returns {Record<string, string>}
 */
function compared(inputs) {
  const { manifest, read } = inputs;
  const sorted = (/** @type {unknown} */ list) => (Array.isArray(list) ? [...list].map(String).sort() : []);
  /** @type {Record<string, string>} */
  const parts = {
    'manifest.json#content_security_policy': canonical(cspOf(manifest)),
    'manifest.json#permissions': canonical(sorted(manifest.permissions)),
    'manifest.json#host_permissions': canonical(sorted(manifest.host_permissions)),
    'manifest.json#optional_permissions': canonical([...sorted(manifest.optional_permissions), ...sorted(manifest.optional_host_permissions)]),
    'manifest.json#externally_connectable': canonical(manifest.externally_connectable === undefined ? null : manifest.externally_connectable),
    'manifest.json#other-keys': canonical(otherKeys(manifest)),
    'offscreen-reasons': canonical(offscreenUse(inputs).byFile),
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
 * @param {{reasons: string[], unread: string[]}} offscreen - the reasons the scripts create the
 *   offscreen document with (offscreenUse)
 * @returns {Problem[]}
 */
function permissionProblems(manifest, declared, offscreen) {
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
  both('the offscreen reason', offscreen.reasons, declared.offscreenReasons.map((/** @type {any} */ entry) => String(entry && entry.reason)));
  for (const file of offscreen.unread) fail(`${file} creates the offscreen document with reasons that aren't a list of string literals, so they can't be checked`);
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

  const { repeated, unreadable } = parsePolicy(pagesPolicy(manifest));
  if (unreadable.length > 0) {
    problems.push(problem('security/csp-characters', 'manifest.json', `the extension pages' CSP holds ${unreadable.join(', ')}; Chromium separates a policy's tokens only on ASCII whitespace and ignores a directive whose name it can't read, so write it in printable ASCII`));
  }
  if (repeated.length > 0) {
    problems.push(problem('security/csp-repeated', 'manifest.json', `the extension pages' CSP names ${repeated.join(', ')} more than once; Chromium enforces only the first copy, so name each directive once`));
  }

  const declared = readJson(read, PERMISSIONS_FILE);
  if (!declared.ok) problems.push(declared.problem);
  else {
    let offscreen;
    try {
      offscreen = offscreenUse(inputs);
    } catch (error) {
      offscreen = null;
      problems.push(problem('security/file', 'js/', `the scripts couldn't be read for the offscreen reasons: ${error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error}`));
    }
    if (offscreen) problems.push(...permissionProblems(manifest, declared.value, offscreen));
  }

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
 * security/changes.json against the base branch's copy: each entry the base has is still there,
 * in its place and unchanged, so entries are only ever appended. A base with no file (null)
 * has nothing to keep.
 * @param {{current: string, base: string | null}} texts
 * @returns {Problem[]}
 */
function checkHistory({ current, base }) {
  if (base === null) return [];
  const fail = (/** @type {string} */ message) => [problem('security/history', CHANGES_FILE, message)];
  const entriesOf = (/** @type {string} */ text) => {
    try {
      const value = JSON.parse(text);
      return value && Array.isArray(value.entries) ? value.entries : null;
    } catch {
      return null;
    }
  };
  const before = entriesOf(base);
  if (!before) return [];
  const now = entriesOf(current);
  if (!now) return fail("doesn't read as a list of entries, so the base branch's entries can't be found in it");
  if (now.length < before.length) return fail(`has ${now.length} ${now.length === 1 ? 'entry' : 'entries'}, and the base branch's copy has ${before.length}: entries are only appended, never taken out`);
  const changed = before.map((/** @type {unknown} */ entry, /** @type {number} */ i) => (canonical(entry) === canonical(now[i]) ? null : i + 1)).filter((/** @type {number | null} */ at) => at !== null);
  if (changed.length > 0) return fail(`changes the base branch's entr${changed.length === 1 ? 'y' : 'ies'} ${changed.join(', ')}: an entry stays as it was reviewed, and a change goes in a new one`);
  return [];
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
    scripts: firstPartyScripts(root),
  };
}

module.exports = { checkSecurityBaseline, checkHistory, recordOf, compared, cspOf, parsePolicy, offscreenReasons, firstPartyScripts, inputsFrom, SOURCES, COSMETIC_KEYS, CHANGES_FILE, PERMISSIONS_FILE };
