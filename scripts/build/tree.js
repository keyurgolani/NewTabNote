'use strict';

/**
 * Copies of the source tree for npm run verify:fixtures: the files the build reads
 * (scripts/build/inputs.js), with node_modules linked rather than copied, and a way to run the
 * build's scripts in one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildEntries } = require('./inputs.js');

/** @typedef {{status: number | null, stdout: string, stderr: string}} Run */

/**
 * Copy what the build reads from `root` to `dest`, and link node_modules
 * @param {string} root
 * @param {string} dest
 */
function copyTree(root, dest) {
  for (const entry of buildEntries()) {
    fs.cpSync(path.join(root, entry), path.join(dest, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dest, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Run a script of the tree in `cwd` with this Node, output collected
 * @param {string} cwd
 * @param {string} script - relative to cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Run>}
 */
function runScript(cwd, script, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(cwd, script), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

module.exports = { buildEntries, copyTree, runScript };
