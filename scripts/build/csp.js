'use strict';

/**
 * The CSP check (#27 AC6, "Security"): what ships has to run under today's extension CSP.
 *   csp/policy          manifest.json's extension_pages policy lets scripts or objects come
 *                       from anywhere but the package, or allows eval ('wasm-unsafe-eval',
 *                       for WebAssembly, is the one exception it has today)
 *   csp/inline-script   a page has a script element with a body
 *   csp/inline-handler  a page has an on* attribute, or a javascript: URL
 *   csp/dynamic-code    first-party code calls eval, the Function constructor, or setTimeout or
 *                       setInterval with a string: ESLint's no-eval, no-new-func, and
 *                       no-implied-eval, run on every shipped script
 *   csp/third-party     a vendored file's occurrence no build/csp-allowlist.json row covers, or
 *                       a row whose file SHA-256 or count no longer matches, so a row changes
 *                       only with its dependency
 * Vendored files are the ones js/lib/vendor.json records; every other script is first-party.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Linter } = require('eslint');
const { problem } = require('./diagnostics.js');
const { htmlTags, rawTextElements } = require('./markup.js');
const { readVendor } = require('./notices.js');
const { scanScript } = require('./js-scan.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */
/** @typedef {{file: string, package: string, version: string, sha256: string, rule: string, count: number, reason: string}} AllowlistRow */

const ALLOWLIST = path.join(__dirname, '..', '..', 'build', 'csp-allowlist.json');

/** The sources each directive may allow */
const POLICY = {
  'script-src': new Set(["'self'", "'wasm-unsafe-eval'"]),
  'object-src': new Set(["'self'", "'none'"]),
};

const RULES = /** @type {const} */ ({ 'no-eval': 'error', 'no-new-func': 'error', 'no-implied-eval': 'error' });
// The globals the rules look for eval, Function, and the timers through
const GLOBALS = {
  window: 'readonly',
  self: 'readonly',
  global: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  execScript: 'readonly',
};
// The only inline <script> bodies a page may carry: JSON data blocks, which never run. Any
// other type, JavaScript under some name a list would miss (text/ecmascript) included, fails.
const DATA_TYPES = new Set(['application/json', 'application/ld+json']);

const linter = new Linter({ configType: 'flat' });

/**
 * @param {string} [file]
 * @returns {AllowlistRow[]}
 */
function readAllowlist(file = ALLOWLIST) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).rows;
}

/**
 * The dynamic code ESLint finds in a script, parsed as a module and, if that fails, as a
 * classic script
 * @param {string} file
 * @param {string} text
 * @returns {{hits: Array<{rule: string, at: string}>, fatal: string | null}}
 */
function dynamicCode(file, text) {
  let fatal = null;
  for (const sourceType of /** @type {const} */ (['module', 'script'])) {
    const messages = linter.verify(text, [{ languageOptions: { ecmaVersion: 'latest', sourceType, globals: GLOBALS }, rules: RULES }], { filename: file });
    const parseError = messages.find((message) => message.fatal);
    if (parseError) {
      fatal = `${parseError.message} (${parseError.line}:${parseError.column})`;
      continue;
    }
    const hits = messages.map((message) => ({ rule: String(message.ruleId), at: `${message.line}:${message.column}` }));
    // The Function constructor reached in ways no-new-func doesn't see, counted under its rule
    const seen = new Set(hits.map((hit) => `${hit.rule}@${hit.at}`));
    for (const where of scanScript(file, text).functionConstructors) {
      if (!seen.has(`no-new-func@${where}`)) hits.push({ rule: 'no-new-func', at: where });
    }
    return { hits, fatal: null };
  }
  return { hits: [], fatal };
}

/**
 * manifest.json's extension_pages policy, against POLICY
 * @param {PackageFiles} files
 * @returns {Problem[]}
 */
function checkPolicy(files) {
  if (!files.has('manifest.json')) return [];
  let manifest;
  try {
    manifest = JSON.parse(files.text('manifest.json'));
  } catch {
    // The closure check reports a manifest that doesn't parse
    return [];
  }
  const csp = manifest.content_security_policy;
  const policy = csp && typeof csp === 'object' ? csp.extension_pages : csp;
  if (policy === undefined) return [];
  if (typeof policy !== 'string') return [problem('csp/policy', 'manifest.json', 'content_security_policy.extension_pages isn\'t a string')];
  /** @type {Problem[]} */
  const problems = [];
  for (const directive of policy.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    const allowed = POLICY[/** @type {keyof typeof POLICY} */ (String(name).toLowerCase())];
    if (!allowed) continue;
    const extra = sources.filter((source) => !allowed.has(source.toLowerCase()));
    if (extra.length > 0) {
      problems.push(problem('csp/policy', 'manifest.json', `${name} allows ${extra.join(' ')}; shipped code runs only under ${[...allowed].join(' ')}`));
    }
  }
  return problems;
}

/**
 * Inline scripts, inline event handlers, and javascript: URLs in the pages
 * @param {PackageFiles} files
 * @returns {Problem[]}
 */
function checkPages(files) {
  /** @type {Problem[]} */
  const problems = [];
  for (const file of files.paths.filter((name) => /\.html?$/i.test(name))) {
    const html = files.text(file);
    for (const element of rawTextElements(html)) {
      const type = (element.attributes.get('type') || '').trim().toLowerCase();
      if (element.name === 'script' && !DATA_TYPES.has(type) && element.body.trim() !== '') {
        problems.push(problem('csp/inline-script', `${file}:${element.at}`, 'an inline script, which the extension CSP blocks. Move it to a file in js/.'));
      }
    }
    for (const tag of htmlTags(html)) {
      for (const [name, value] of tag.attributes) {
        if (/^on[a-z]+$/.test(name)) {
          problems.push(problem('csp/inline-handler', `${file}:${tag.at}`, `<${tag.name} ${name}>, an inline handler the extension CSP blocks. Add the listener in a script.`));
        } else if (/^\s*javascript:/i.test(value)) {
          problems.push(problem('csp/inline-handler', `${file}:${tag.at}`, `<${tag.name} ${name}> is a javascript: URL, which the extension CSP blocks`));
        }
      }
    }
  }
  return problems;
}

/**
 * Dynamic code in the shipped scripts: none in first-party code, and only what a row covers
 * in vendored code
 * @param {PackageFiles} files
 * @param {{allowlist?: AllowlistRow[], vendored?: Set<string>}} [options]
 * @returns {Problem[]}
 */
function checkDynamicCode(files, { allowlist = readAllowlist(), vendored = new Set(readVendor().keys()) } = {}) {
  /** @type {Problem[]} */
  const problems = [];
  /** @type {Map<string, {count: number, at: string[]}>} */
  const thirdParty = new Map();
  const key = (/** @type {string} */ file, /** @type {string} */ rule) => `${file}\0${rule}`;

  for (const file of files.paths.filter((name) => /\.m?js$/i.test(name))) {
    const { hits, fatal } = dynamicCode(file, files.text(file));
    if (fatal) {
      const code = vendored.has(file) ? 'csp/third-party' : 'csp/dynamic-code';
      problems.push(problem(code, file, `ESLint can't parse it, so its dynamic code can't be checked: ${fatal}`));
      continue;
    }
    for (const hit of hits) {
      if (vendored.has(file)) {
        const entry = thirdParty.get(key(file, hit.rule)) || { count: 0, at: [] };
        entry.count += 1;
        entry.at.push(hit.at);
        thirdParty.set(key(file, hit.rule), entry);
      } else {
        problems.push(problem('csp/dynamic-code', `${file}:${hit.at}`, `${hit.rule}: the extension CSP refuses code built from a string at run time`));
      }
    }
  }

  const rows = new Map(allowlist.map((row) => [key(row.file, row.rule), row]));
  for (const [entryKey, { count, at }] of thirdParty) {
    const [file, rule] = entryKey.split('\0');
    const row = rows.get(entryKey);
    if (!row) {
      problems.push(problem('csp/third-party', `${file}:${at[0]}`, `${count} ${rule} occurrence${count === 1 ? '' : 's'} (at ${at.join(', ')}) no build/csp-allowlist.json row covers. Review it and add a row with the file's SHA-256.`));
    } else if (row.count !== count) {
      problems.push(problem('csp/third-party', file, `build/csp-allowlist.json allows ${row.count} ${rule} occurrence${row.count === 1 ? '' : 's'}, and it has ${count} (at ${at.join(', ')})`));
    }
  }
  for (const row of allowlist) {
    if (!files.has(row.file)) {
      problems.push(problem('csp/third-party', row.file, `build/csp-allowlist.json has a ${row.rule} row for it, and the package doesn't ship it`));
      continue;
    }
    const digest = crypto.createHash('sha256').update(files.read(row.file)).digest('hex');
    if (digest !== row.sha256) {
      problems.push(problem('csp/third-party', row.file, `its ${row.rule} row was reviewed for SHA-256 ${row.sha256}, and the shipped file is ${digest}. Review the new version's occurrences and update the row with it.`));
    } else if (!thirdParty.has(key(row.file, row.rule))) {
      problems.push(problem('csp/third-party', row.file, `build/csp-allowlist.json allows ${row.count} ${row.rule} occurrence${row.count === 1 ? '' : 's'}, and it has none. Remove the row.`));
    }
  }
  return problems;
}

/**
 * Every CSP check
 * @param {PackageFiles} files
 * @param {{allowlist?: AllowlistRow[], vendored?: Set<string>}} [options]
 * @returns {Problem[]}
 */
function checkCsp(files, options) {
  return [...checkPolicy(files), ...checkPages(files), ...checkDynamicCode(files, options)];
}

module.exports = { checkCsp, checkPolicy, checkPages, checkDynamicCode, dynamicCode, readAllowlist, ALLOWLIST, POLICY };
