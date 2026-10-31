'use strict';

/**
 * The environment check (#27 AC9, "Security"). The build gets no secrets, and the only
 * environment value it may ever inline is NODE_ENV (#27's scope: "inlines only buildId,
 * NODE_ENV and reviewed allowlist rows"). So shipped first-party code may read
 * process.env.NODE_ENV, behind a `process.env &&` guard or not, and nothing else from
 * process.env or import.meta.env (env/reference): no other name, no computed name, and not the
 * object itself, which could carry every variable. js/core/logger.js's Node fallback is today's
 * one NODE_ENV reader. Vendored code may read more: transformers.js's Node-only process.env
 * reads stay run-time lookups, which find no process in the extension.
 *
 * canaryLeaks backs the canary run in npm run verify:fixtures: a made-up secret set in the
 * build's environment must appear in neither its output nor its logs (env/canary).
 */

const { problem } = require('./diagnostics.js');
const { scanScript } = require('./js-scan.js');
const { readVendor } = require('./notices.js');
const { readZip } = require('./zip.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */

/** The environment variables first-party code may read, which a bundler may inline */
const ALLOWED = new Set(['NODE_ENV']);

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
    for (const { what, name, at } of scanScript(file, files.text(file)).environment) {
      if (what.startsWith('process.env') && name !== null && ALLOWED.has(name)) continue;
      problems.push(problem('env/reference', `${file}:${at}`, `${what} in shipped first-party code. The build gets no secrets and inlines nothing but NODE_ENV; pass the value in another way.`));
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

module.exports = { ALLOWED, checkEnvironment, canaryLeaks };
