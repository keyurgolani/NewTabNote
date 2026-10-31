#!/usr/bin/env node
'use strict';

/**
 * The type gate (#27 AC1, "Type gate"). Three checks, run at once, each with the lockfile's tsc
 * from node_modules/.bin:
 *
 *   tsconfig.kernel.json  #12's kernel, strict: no diagnostic at all
 *   tsconfig.strict.json  the build code #27 adds under scripts/build/, and the page code under
 *                         js/entries/ and js/runtime/ (#27 slice 3), strict: none at all
 *   jsconfig.json         the legacy files, held to #34's shrink-only ci/baselines/typecheck.json
 *                         by scripts/typecheck-ratchet.js
 *
 * scripts/build.js runs it on every build, and `npm run typecheck:ratchet` runs it alone. A
 * missing tsc, or one that exits nonzero without diagnostics, fails it.
 *
 *   node scripts/build/type-gate.js            check
 *   node scripts/build/type-gate.js --update   check, and have the ratchet record lowered counts
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { problem, format, plural } = require('./diagnostics.js');
const { binPath } = require('./toolchain.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {{status: number | null, stdout: string, stderr: string}} Run */

const ROOT = path.join(__dirname, '..', '..');

/** The strict projects, which must report nothing */
const STRICT_PROJECTS = [
  { code: 'type/kernel', config: 'tsconfig.kernel.json' },
  { code: 'type/strict', config: 'tsconfig.strict.json' },
];

// `file(line,col): error TS1234: message`, and the same without a file
const LOCATED = /^(\S.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const GLOBAL = /^error (TS\d+): (.*)$/;

/**
 * Run a command to its end, output collected
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<Run>}
 */
function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * The non-blank lines of a run's output, stdout first
 * @param {Run} result
 * @returns {string[]}
 */
function outputLines(result) {
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/**
 * A strict project's diagnostics as problems, one per diagnostic, or one saying tsc failed
 * without any
 * @param {string} root
 * @param {string} tsc
 * @param {{code: string, config: string}} project
 * @returns {Promise<Problem[]>}
 */
async function strictProject(root, tsc, { code, config }) {
  const result = await run(process.execPath, [tsc, '-p', config, '--pretty', 'false'], root);
  const lines = outputLines(result);
  if (result.status === 0 && lines.length === 0) return [];
  /** @type {Problem[]} */
  const problems = [];
  for (const line of lines) {
    const located = LOCATED.exec(line);
    const global = located ? null : GLOBAL.exec(line);
    if (located) {
      problems.push(problem(code, `${located[1]}:${located[2]}:${located[3]}`, `${located[4]} ${located[5]}`));
    } else if (global) {
      problems.push(problem(code, config, `${global[1]} ${global[2]}`));
    } else if (/^\s/.test(line) && problems.length > 0) {
      // A diagnostic's chain continues on indented lines
      problems[problems.length - 1].message += ` ${line.trim()}`;
    }
  }
  if (problems.length === 0) {
    const exit = result.status === null ? 'stopped by a signal or never started' : `exited ${result.status}`;
    problems.push({ ...problem(code, config, `tsc ${exit} without a diagnostic it could parse`), details: lines.slice(0, 20) });
  }
  return problems;
}

/**
 * The legacy ratchet's result: its OK line, or one problem with its report
 * @param {string} root
 * @param {string} script - scripts/typecheck-ratchet.js
 * @param {boolean} update
 * @returns {Promise<{problems: Problem[], report: string}>}
 */
async function legacyRatchet(root, script, update) {
  const result = await run(process.execPath, [script, ...(update ? ['--update'] : [])], root);
  const lines = outputLines(result);
  if (result.status === 0) return { problems: [], report: lines.join('\n') };
  const [first = `scripts/typecheck-ratchet.js exited ${result.status}`, ...rest] = lines;
  return { problems: [{ ...problem('type/legacy', 'jsconfig.json', first), details: rest }], report: '' };
}

/**
 * Run the gate in `root`. `tsc` and `ratchet` are the scripts it runs, node_modules/.bin/tsc and
 * scripts/typecheck-ratchet.js unless a test passes others.
 * @param {string} root
 * @param {{update?: boolean, tsc?: string | null, ratchet?: string}} [options]
 * @returns {Promise<{problems: Problem[], summary: string}>}
 */
async function runTypeGate(root, { update = false, tsc = binPath(root, 'tsc'), ratchet = path.join(root, 'scripts', 'typecheck-ratchet.js') } = {}) {
  if (!tsc) {
    return {
      problems: [problem('toolchain/missing-tool', 'node_modules/.bin/tsc', 'TypeScript isn\'t installed. Run `npm ci --ignore-scripts`.')],
      summary: '',
    };
  }
  const [kernel, strict, legacy] = await Promise.all([
    strictProject(root, tsc, STRICT_PROJECTS[0]),
    strictProject(root, tsc, STRICT_PROJECTS[1]),
    legacyRatchet(root, ratchet, update),
  ]);
  const problems = [...kernel, ...strict, ...legacy.problems];
  const summary = `type gate: OK, ${STRICT_PROJECTS.map(({ config }) => config).join(' and ')} report no diagnostics, and ${legacy.report.replace(/^typecheck ratchet: /, 'the legacy ratchet: ')}`;
  return { problems, summary };
}

/**
 * Print a problem and its detail lines
 * @param {Problem & {details?: string[]}} found
 * @param {(line: string) => void} write
 * @param {string} [indent]
 */
function printProblem(found, write, indent = '  ') {
  write(`${indent}${format(found)}`);
  for (const line of found.details || []) write(`${indent}  ${line}`);
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
async function main(argv) {
  const unknown = argv.filter((arg) => arg !== '--update');
  if (unknown.length > 0) {
    console.error(`usage: node scripts/build/type-gate.js [--update] (unknown: ${unknown.join(' ')})`);
    return 2;
  }
  const { problems, summary } = await runTypeGate(ROOT, { update: argv.includes('--update') });
  if (problems.length > 0) {
    console.error(`type gate failed: ${plural(problems.length, 'problem')}`);
    problems.forEach((found) => printProblem(found, (line) => console.error(line)));
    return 1;
  }
  console.log(summary);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { STRICT_PROJECTS, runTypeGate, printProblem };
