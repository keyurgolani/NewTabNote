'use strict';

/**
 * The environment check (#27 AC9, "Security"). The build gets no secrets, and the only
 * environment value it may ever inline is NODE_ENV (#27's scope: "inlines only buildId,
 * NODE_ENV and reviewed allowlist rows"). So shipped first-party code may read
 * process.env.NODE_ENV, behind a `process.env &&` guard or not, and nothing else from
 * process.env or import.meta.env (env/reference): no other name, no computed name, and not the
 * object itself, which could carry every variable, whether it's reached through the global
 * object (globalThis.process.env) or as import.meta['env']. Neither may process itself be read
 * on its own, as `const p = process; p.env.X` would. js/core/logger.js's Node fallback is today's
 * one NODE_ENV reader. Vendored code may read more: transformers.js's Node-only process.env
 * reads stay run-time lookups, which find no process in the extension.
 *
 * The define check (#300) holds the rest of that scope. A free __NTN_ name is one the build
 * writes a value in place of: the build's ID, or a build/define-allowlist.json row
 * (scripts/build/define-allowlist.js). First-party code the bundle holds may read only those, and
 * shipped first-party code none but the build's ID, which the build/loader check holds the
 * loader to, since the bundler wrote the rows' values in their place (define/unknown).
 *
 * canaryLeaks backs the canary run in npm run verify:fixtures: a made-up secret set in the
 * build's environment must appear in neither its output nor its logs (env/canary).
 */

const { problem } = require('./diagnostics.js');
const { readAllowlist, defineName } = require('./define-allowlist.js');
const { scanScript } = require('./js-scan.js');
const { readVendor } = require('./notices.js');
const { readZip } = require('./zip.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */

/** The environment variables first-party code may read, which a bundler may inline */
const ALLOWED = new Set(['NODE_ENV']);
/** The __NTN_ name that isn't a row: the build's ID, which vite-config.js's define sets */
const BUILD_ID = '__NTN_BUILD_ID__';

/**
 * @param {PackageFiles} files
 * @param {{vendored?: Set<string>}} [options]
 * @returns {Problem[]}
 */
function checkEnvironment(files, { vendored = new Set(readVendor().keys()) } = {}) {
  /** @type {Problem[]} */
  const problems = [];
  for (const file of files.paths) {
    if (!/\.m?js$/i.test(file) || vendored.has(file)) continue;
    const scan = scanScript(file, files.text(file));
    for (const { what, name, at } of scan.environment) {
      if (what.startsWith('process.env') && name !== null && ALLOWED.has(name)) continue;
      problems.push(problem('env/reference', `${file}:${at}`, `${what} in shipped first-party code. The build gets no secrets and inlines nothing but NODE_ENV; pass the value in another way.`));
    }
    for (const { name, at } of scan.defines) {
      if (name === BUILD_ID) continue;
      problems.push(problem('define/unknown', `${file}:${at}`, `${name} in shipped first-party code, which the build wrote no value in place of, so it throws there. The build inlines build/define-allowlist.json's rows in the modules it bundles alone.`));
    }
  }
  return problems;
}

/**
 * Where `canary` appears: in the logs, in a file of the build, or in the zip, its entries
 * read back
 * @param {string} canary
 * @param {{logs?: Record<string, string>, files?: PackageFiles, zip?: Buffer}} where
 * @returns {Problem[]}
 */
function canaryLeaks(canary, { logs = {}, files, zip }) {
  if (canary.length < 16) throw new Error('a canary has to be at least 16 characters, so it can\'t turn up by chance');
  const needle = Buffer.from(canary, 'utf8');
  /** @type {Problem[]} */
  const problems = [];
  for (const [name, text] of Object.entries(logs)) {
    if (text.includes(canary)) problems.push(problem('env/canary', name, 'the canary secret set in the build\'s environment is in this log'));
  }
  if (files) {
    for (const file of files.paths) {
      if (files.read(file).includes(needle)) problems.push(problem('env/canary', file, `the canary secret set in the build's environment is in this file of ${files.label}`));
    }
  }
  if (zip) {
    if (zip.includes(needle)) problems.push(problem('env/canary', 'the zip', 'the canary secret is in its raw bytes'));
    for (const entry of readZip(zip)) {
      if (entry.data.includes(needle)) problems.push(problem('env/canary', `the zip's ${entry.path}`, 'the canary secret set in the build\'s environment is in this entry'));
    }
  }
  return problems;
}

/**
 * The same rule on the first-party modules the bundle holds, read from the sources. The bundler
 * replaces process.env with {} and import.meta.env with an object of its own, so the shipped
 * chunks no longer show a read the sources make (#27 slice 2). An __NTN_ name has to be the
 * build's ID or one of `defineRows`, which the bundler writes values in place of (#300).
 * @param {Array<{file: string, text: string}>} modules
 * @param {{defineRows?: Record<string, import('./define-allowlist.js').DefineRow>}} [options]
 * @returns {Problem[]}
 */
function checkSourceEnvironment(modules, { defineRows = readAllowlist().rows } = {}) {
  const held = new Set([BUILD_ID, ...Object.keys(defineRows).map(defineName)]);
  /** @type {Problem[]} */
  const problems = [];
  for (const { file, text } of modules) {
    const scan = scanScript(file, text);
    for (const { what, name, at } of scan.environment) {
      if (what.startsWith('process.env') && name !== null && ALLOWED.has(name)) continue;
      problems.push(problem('env/reference', `${file}:${at}`, `${what} in first-party code the bundle holds. The build gets no secrets and inlines nothing but NODE_ENV; pass the value in another way.`));
    }
    for (const { name, at } of scan.defines) {
      if (held.has(name)) continue;
      problems.push(problem('define/unknown', `${file}:${at}`, `${name} in first-party code the bundle holds, which build/define-allowlist.json has no row for, so the build writes no value in its place. Add the row, with its owner and its release, dev and test values, or pass the value in another way.`));
    }
  }
  return problems;
}

module.exports = { ALLOWED, checkEnvironment, checkSourceEnvironment, canaryLeaks };
