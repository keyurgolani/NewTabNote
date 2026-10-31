'use strict';

/**
 * What the build and its checks report (#27, "Failure rules"). Every problem carries a code,
 * `<area>/<rule>`, so a log line, a fixture under test/build-fixtures/, and a reviewer name the
 * same rule. A build with any problem exits 1 and leaves no dist/.
 */

/**
 * @typedef {object} Problem
 * @property {string} code - a key of CODES
 * @property {string} subject - the file, entry, or setting the problem is about
 * @property {string} message
 * @property {string[]} [details] - lines that go under it, such as a checker's own report
 */

/** Every code, and the rule it stands for */
const CODES = Object.freeze({
  'build/usage': 'scripts/build.js was given an argument it doesn\'t take',
  'toolchain/node-version': 'Node isn\'t the exact version .nvmrc pins',
  'toolchain/missing-tool': 'a build tool isn\'t installed in node_modules',
  'build/missing-input': 'a listed input file or directory is missing',
  'build/terser': 'terser failed on a JavaScript file',
  'build/css': 'CleanCSS reported an error or a warning, or threw, at any optimization level',
  'build/load-mode': 'a file is loaded both as an ES module and as a classic script',
  'build/manifest': 'manifest.json doesn\'t parse or lacks a required field',
  'build/source-date': 'SOURCE_DATE_EPOCH isn\'t a whole number of seconds',
  'type/kernel': 'tsc -p tsconfig.kernel.json reported a diagnostic, or didn\'t run',
  'type/strict': 'tsc -p tsconfig.strict.json reported a diagnostic, or didn\'t run',
  'type/legacy': 'the jsconfig.json diagnostics differ from ci/baselines/typecheck.json',
  'closure/missing': 'a path the package names isn\'t in it',
  'closure/unreferenced': 'the package holds a file nothing names that isn\'t a listed static asset',
  'closure/non-literal': 'first-party code builds a path the closure check follows at run time',
  'remote-code/url': 'shipped code names a remote executable URL no allowlist row covers',
  'remote-code/stale-row': 'a build/remote-allowlist.json row matches nothing',
  'csp/policy': 'manifest.json\'s extension_pages CSP allows more scripts than the reviewed policy',
  'csp/inline-script': 'an HTML page has an inline script that isn\'t a JSON data block, which the CSP blocks',
  'csp/inline-handler': 'an HTML page has an inline event handler or a javascript: URL, which the CSP blocks',
  'csp/dynamic-code': 'first-party code calls eval, the Function constructor, or a timer with a string',
  'csp/third-party': 'third-party dynamic code no build/csp-allowlist.json row covers, or a row that no longer matches',
  'notices/missing-file': 'the package lacks LICENSE or THIRD_PARTY_NOTICES',
  'notices/banner': 'a vendored file shipped without its license banner',
  'notices/no-entry': 'a vendored package has no THIRD_PARTY_NOTICES entry',
  'source-map/file': 'the package holds a source map',
  'source-map/comment': 'a shipped file has a sourceMappingURL comment',
  'env/reference': 'first-party code reads process.env, process itself, or import.meta.env',
  'env/canary': 'a canary secret set in the build\'s environment reached its logs, dist/, or the zip',
  'vendor/mismatch': 'a vendored file differs from its js/lib/vendor.json record',
  'vendor/unlisted': 'a vendored file has no js/lib/vendor.json record',
  'package/no-build': 'npm run package found no complete build in dist/',
  'package/write': 'the zip couldn\'t be written or read back',
});

/**
 * A problem with a known code. Throws on an unknown code, so a typo can't make a rule nobody
 * documents.
 * @param {string} code
 * @param {string} subject
 * @param {string} message
 * @returns {Problem}
 */
function problem(code, subject, message) {
  if (!Object.hasOwn(CODES, code)) throw new Error(`unknown diagnostic code ${code}`);
  return { code, subject, message };
}

/**
 * One line for a problem: `[code] subject: message`
 * @param {Problem} found
 * @returns {string}
 */
function format(found) {
  return `[${found.code}] ${found.subject}: ${found.message}`;
}

/**
 * @param {number} count
 * @param {string} word
 * @returns {string}
 */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

module.exports = { CODES, problem, format, plural };
