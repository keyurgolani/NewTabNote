/**
 * Where a file of the sources is in a build (#27 slice 2). The bundler folds the modules into
 * chunks, so a self-test that edits a module edits each chunk that holds it, which the build's
 * dist-report/modules.json lists beside its dist/. A file the build has at its own path, such as
 * js/background.js, a page, or the manifest, is that file. build-info.json names the chunks a
 * loader starts, such as the indexer's.
 */

const fs = require('fs');
const path = require('path');

/**
 * dist-report/modules.json for the build in `dist`: each source module to the files that hold
 * it. It has to be that build's, since another build's names chunks this one doesn't have.
 * @param {string} dist
 * @returns {Record<string, string[]>}
 */
function moduleMap(dist) {
  const file = path.join(path.dirname(dist), 'dist-report', 'modules.json');
  if (!fs.existsSync(file)) {
    throw new Error(`No ${file}, which the build writes beside ${dist}. Run \`npm run build\`, or put the build's dist-report/ beside NTN_DIST.`);
  }
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { buildId } = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'));
  if (map.buildId !== buildId) {
    throw new Error(`${file} is build ${map.buildId}'s, and ${dist} is build ${buildId}'s. Rebuild, or put this build's dist-report/ beside it.`);
  }
  return map.modules;
}

/**
 * The files of the build in `dist` that hold `file`, a path in the sources: the file itself when
 * the build has it, else the chunks the module map lists, else none
 * @param {string} dist
 * @param {string} file
 * @returns {string[]}
 */
function builtFiles(dist, file) {
  if (fs.existsSync(path.join(dist, file))) return [file];
  return moduleMap(dist)[file] || [];
}

/**
 * The file of the chunk build-info.json's chunks names `name`
 * @param {string} dist
 * @param {string} name
 * @returns {string}
 */
function chunkFile(dist, name) {
  const { chunks } = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'));
  if (!chunks || typeof chunks[name] !== 'string') throw new Error(`${dist}/build-info.json's chunks names no ${name}`);
  return chunks[name];
}

/**
 * Why a self-test whose edit replaces `pattern` in `file` doesn't run on the build in `dist`, or
 * null when it runs. The pattern is that code as this checkout builds it, so a build from
 * elsewhere (`external`, as NTN_DIST names one), such as a release tag's own build, may not have
 * it in the file or any chunk that holds it, and the self-test skips there. On this checkout's
 * own build it always runs, so an edit that stops matching fails, and a change to the code it
 * edits can't retire it without a word.
 * @param {{dist: string, file: string, pattern: RegExp, external: boolean}} options
 * @returns {string | null}
 */
function editSkipReason({ dist, file, pattern, external }) {
  if (!external) return null;
  if (builtFiles(dist, file).some((built) => pattern.test(fs.readFileSync(path.join(dist, built), 'utf8')))) return null;
  return `the build under test has no ${pattern} in ${file}, the code this self-test edits as this checkout builds it`;
}

module.exports = { moduleMap, builtFiles, chunkFile, editSkipReason };
