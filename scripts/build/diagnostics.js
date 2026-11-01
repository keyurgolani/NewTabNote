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
  'build/bundle': 'the bundler refused the sources: an import it can\'t resolve, a file it can\'t parse, or two chunks with one name',
  'build/bundler-warning': 'Vite or the bundler printed a warning, none of which is reviewed as allowed',
  'build/terser': 'terser failed on a JavaScript file',
  'build/css': 'the stylesheet pipeline reported an error or a warning: lightningcss, or Vite\'s CSS processing',
  'build/load-mode': 'a page loads a script as a classic script that is a module: the bundle holds it, or it has module syntax',
  'build/commonjs': 'the bundler wrapped a module as CommonJS, or a module the bundle holds names exports or require, checks typeof require, or reads module outside a typeof check',
  'build/loader': 'the loader (js/runtime/lazy.js) isn\'t alone in a chunk at its own path, or doesn\'t carry the build\'s ID',
  'build/manifest': 'manifest.json doesn\'t parse or lacks a required field',
  'build/source-date': 'SOURCE_DATE_EPOCH isn\'t a whole number of seconds',
  'type/kernel': 'tsc -p tsconfig.kernel.json reported a diagnostic, or didn\'t run',
  'type/strict': 'tsc -p tsconfig.strict.json reported a diagnostic, or didn\'t run',
  'type/legacy': 'the jsconfig.json diagnostics differ from ci/baselines/typecheck.json',
  'closure/missing': 'a path the package names isn\'t in it',
  'closure/unreferenced': 'the package holds a file nothing names that isn\'t a listed static asset',
  'closure/non-literal': 'first-party code builds a path the closure check follows at run time',
  'closure/preload': 'a page doesn\'t preload exactly the chunks its module scripts import',
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
  'background/not-self-contained': 'the service worker, or a first-party module of its graph, imports, calls import(), or calls importScripts()',
  'background/top-level-await': 'the service worker, or a first-party module of its graph, awaits at its top level',
  'background/dom': 'a first-party module of the service worker\'s graph reads document or window outside a typeof check',
  'guard/page-first': 'a page\'s first script isn\'t the network guard (js/network-guard.js) as a classic script, or the build wrote no guard',
  'guard/worker-first': 'the service worker\'s or a module worker\'s first module in execution order isn\'t the network guard\'s',
  'guard/not-installed': 'the built network guard doesn\'t wrap every network API it covers, throws, or lets a call to an unregistered destination go',
  'security/drift': 'the manifest, the CSP, the permissions, the offscreen reasons, the destinations, the ledger or a network source changed with no security/changes.json entry that records it, names what it changes, and says why',
  'security/csp-repeated': 'the extension pages\' CSP names a directive more than once, and Chromium enforces only the first copy',
  'security/permissions': 'the manifest\'s permissions, host permissions or offscreen reasons and security/permissions.json differ, either way, an entry there lacks its issue, warning, request point or rationale, or a script creates the offscreen document with reasons that can\'t be read',
  'security/externally-connectable': 'the manifest has externally_connectable, which lets a web page or another extension open a channel to this one',
  'security/unsafe-inline': 'style-src allows \'unsafe-inline\' though #16\'s counts of style attributes and <style> blocks are zero',
  'security/file': 'a file in security/ doesn\'t read as its shape',
  'security/history': 'security/changes.json changes or drops an entry the base branch has, where entries are only appended',
  'guard/rows': 'the rows the built page guard inlines aren\'t the validated destination registry\'s',
  'guard/registry-unreadable': 'the destination registry has a problem, so the page guard would refuse every destination: the build won\'t inline it, or the built guard can\'t read its rows',
  'env/canary': 'a canary secret set in the build\'s environment reached its logs, dist/, or the zip',
  'budget/entry': 'a page or the service worker the build has with no build/budgets.json row, a row for an entry it doesn\'t have that isn\'t planned, or a planned row for one it has',
  'budget/bytes': 'an entry\'s start JS, CSS, HTML, or fonts is over its build/budgets.json row, raw or gzip',
  'budget/forbidden': 'a module or file a forbidden category names is on an entry\'s start path',
  'budget/dependency': 'an entry\'s graph holds a third-party package its row doesn\'t allow, or its row allows one the graph no longer holds',
  'budget/file': 'build/budgets.json is missing, doesn\'t parse, or doesn\'t read as a budget file',
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
