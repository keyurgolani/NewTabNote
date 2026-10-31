'use strict';

/**
 * build-info.json and asset-manifest.json (#27, "Outputs"), and what goes into them.
 *
 * asset-manifest.json lists every other file of the build with its size and SHA-256, and
 * outputDigest is the SHA-256 of that file. buildId, worked out before anything is built, is
 * the SHA-256 of the commit's tree, package-lock.json, the toolchain's versions, and the mode,
 * plus -dirty when the tree has tracked changes or untracked files git doesn't ignore, or isn't
 * a git checkout. SOURCE_DATE_EPOCH, which dates every zip entry, is the environment's when
 * it's set, the commit's otherwise, and the earliest date a zip holds outside a checkout.
 * chunks maps each loader name to its file; until the bundler names chunks (#27 slice 2), each
 * script is its own chunk, under its path.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { problem } = require('./diagnostics.js');
const { toolVersions } = require('./toolchain.js');
const { ZIP_EPOCH } = require('./zip.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */
/** @typedef {'production' | 'development'} Mode */

const BUILD_INFO = 'build-info.json';
const ASSET_MANIFEST = 'asset-manifest.json';

/**
 * @typedef {object} SourceInfo
 * @property {string | null} commit
 * @property {string | null} tree
 * @property {boolean} dirty
 * @property {number} sourceDateEpoch
 */

/**
 * git's output for `args` in `root`, trimmed, or null when it fails
 * @param {string} root
 * @param {string[]} args
 * @returns {string | null}
 */
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * @param {string} file
 * @returns {string}
 */
function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * The commit, tree, cleanliness, and SOURCE_DATE_EPOCH of the sources in `root`. Only a
 * checkout whose top level is `root` counts, never a repository around it.
 * @param {string} root
 * @param {Record<string, string | undefined>} [env]
 * @returns {{info: SourceInfo, problems: Problem[]}}
 */
function sourceInfo(root, env = process.env) {
  /** @type {Problem[]} */
  const problems = [];
  const top = git(root, ['rev-parse', '--show-toplevel']);
  const checkout = top !== null && realPath(top) === realPath(root);
  const commit = checkout ? git(root, ['rev-parse', 'HEAD']) : null;
  const tree = commit ? git(root, ['rev-parse', 'HEAD^{tree}']) : null;
  const status = commit ? git(root, ['status', '--porcelain', '--untracked-files=normal']) : null;
  const committed = commit ? git(root, ['log', '-1', '--format=%ct', 'HEAD']) : null;

  let sourceDateEpoch = committed !== null && /^\d+$/.test(committed) ? Number(committed) : ZIP_EPOCH;
  const fromEnvironment = env.SOURCE_DATE_EPOCH;
  if (fromEnvironment !== undefined) {
    if (/^\d+$/.test(fromEnvironment) && Number.isSafeInteger(Number(fromEnvironment))) {
      sourceDateEpoch = Number(fromEnvironment);
    } else {
      problems.push(problem('build/source-date', 'SOURCE_DATE_EPOCH', `${JSON.stringify(fromEnvironment)} isn't a whole number of seconds since 1970`));
    }
  }
  return { info: { commit, tree, dirty: status === null || status !== '', sourceDateEpoch }, problems };
}

/**
 * @param {Buffer | string} data
 * @returns {string}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * The build's identity, from its inputs only
 * @param {string} root
 * @param {SourceInfo} info
 * @param {Mode} mode
 * @returns {string}
 */
function buildId(root, info, mode) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const inputs = {
    tree: info.tree,
    lock: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
    toolchain: { ...toolVersions(root), packageManager: pkg.packageManager || null },
    mode,
  };
  return `${sha256(JSON.stringify(inputs))}${info.dirty ? '-dirty' : ''}`;
}

/**
 * #13's protocol version and #17's database schema version, from their modules
 * @param {string} root
 * @returns {Promise<{protocolVersion: unknown, schemaVersion: unknown}>}
 */
async function kernelVersions(root) {
  const limits = await import(pathToFileURL(path.join(root, 'js/kernel/core/contracts/limits.js')).href);
  const schema = await import(pathToFileURL(path.join(root, 'js/kernel/adapters/indexeddb/schema.js')).href);
  return { protocolVersion: limits.PROTOCOL_VERSION, schemaVersion: schema.DB_VERSION };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * asset-manifest.json's text for a build's files, leaving out itself and build-info.json
 * @param {PackageFiles} files
 * @returns {string}
 */
function assetManifest(files) {
  const entries = files.paths
    .filter((file) => file !== ASSET_MANIFEST && file !== BUILD_INFO)
    .map((file) => {
      const data = files.read(file);
      return { path: file, size: data.length, sha256: sha256(data) };
    });
  return json({ files: entries });
}

/**
 * Write asset-manifest.json and then build-info.json into the build directory `dir`
 * @param {string} dir
 * @param {PackageFiles} files - dir's files, without either of the two
 * @param {{buildId: string, info: SourceInfo, mode: Mode, versions: {protocolVersion: unknown, schemaVersion: unknown}}} build
 * @returns {{buildId: string, outputDigest: string}}
 */
function writeBuildInfo(dir, files, { buildId: id, info, mode, versions }) {
  const manifest = assetManifest(files);
  fs.writeFileSync(path.join(dir, ASSET_MANIFEST), manifest);
  const outputDigest = sha256(manifest);
  /** @type {Record<string, string>} */
  const chunks = {};
  for (const file of files.paths) if (/\.m?js$/.test(file)) chunks[file] = file;
  const version = JSON.parse(files.text('manifest.json')).version;
  fs.writeFileSync(path.join(dir, BUILD_INFO), json({
    buildId: id,
    outputDigest,
    chunks,
    version,
    commit: info.commit,
    SOURCE_DATE_EPOCH: info.sourceDateEpoch,
    mode,
    protocolVersion: versions.protocolVersion,
    schemaVersion: versions.schemaVersion,
  }));
  return { buildId: id, outputDigest };
}

/**
 * build-info.json from a build, checked against the files beside it: its outputDigest has to
 * be asset-manifest.json's SHA-256, and the manifest has to list every other file as it is
 * @param {PackageFiles} files
 * @returns {{info: Record<string, any> | null, problems: string[]}}
 */
function readBuildInfo(files) {
  if (!files.has(BUILD_INFO) || !files.has(ASSET_MANIFEST)) {
    return { info: null, problems: [`${files.label} has no ${files.has(BUILD_INFO) ? ASSET_MANIFEST : BUILD_INFO}; it wasn't made by this build`] };
  }
  /** @type {string[]} */
  const problems = [];
  const info = JSON.parse(files.text(BUILD_INFO));
  const manifest = files.text(ASSET_MANIFEST);
  if (sha256(manifest) !== info.outputDigest) problems.push(`${BUILD_INFO}'s outputDigest isn't the SHA-256 of ${ASSET_MANIFEST}`);
  if (manifest !== assetManifest(files)) problems.push(`${ASSET_MANIFEST} doesn't list the files of ${files.label} as they are`);
  return { info, problems };
}

module.exports = { BUILD_INFO, ASSET_MANIFEST, sourceInfo, buildId, kernelVersions, assetManifest, writeBuildInfo, readBuildInfo, sha256 };
