#!/usr/bin/env node
'use strict';

/**
 * Builds the frozen 1.4.0 package the timing and heap runs measure against (#27 slice 4b;
 * build/budgets.json's `reference`), from the v1.4.0 tag, with v1.4.0's own lockfile and build,
 * and checks it against the pinned digest. A package that doesn't match fails loudly: a run
 * against anything else would compare against the wrong package.
 *
 *   npm run perf:reference -- <dir>     builds into <dir>/source, the package at <dir>/source/dist
 *
 * It needs the tag (git fetch origin tag v1.4.0) and the network, for v1.4.0's npm ci
 * --ignore-scripts. It prints the package's path on its last line.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { packageDigest } = require('../perf-probe');

const ROOT = path.join(__dirname, '..', '..');
const BUDGETS = path.join(ROOT, 'build', 'budgets.json');

/**
 * @param {string} dir
 * @returns {string} the package's directory
 */
function buildReference(dir) {
  const { reference } = JSON.parse(fs.readFileSync(BUDGETS, 'utf8'));
  if (!reference || !reference.tag || !reference.packageDigest) throw new Error(`${BUDGETS} names no reference tag and digest`);
  const source = path.join(path.resolve(dir), 'source');
  fs.mkdirSync(source, { recursive: true });
  const tar = path.join(path.resolve(dir), `${reference.tag}.tar`);
  execFileSync('git', ['archive', '--format=tar', '-o', tar, reference.tag], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  execFileSync('tar', ['-xf', tar, '-C', source], { stdio: 'inherit' });
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[key];
  execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: source, env, stdio: ['ignore', 'inherit', 'inherit'] });
  execFileSync('npm', ['run', 'build'], { cwd: source, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const dist = path.join(source, 'dist');
  const digest = packageDigest(dist);
  if (digest !== reference.packageDigest) {
    throw new Error(`the ${reference.tag} package built here is ${digest}, not the pinned ${reference.packageDigest} (${BUDGETS}): it isn't the reference, so no run may compare against it`);
  }
  return dist;
}

if (require.main === module) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write('usage: npm run perf:reference -- <dir>\n');
    process.exit(2);
  }
  try {
    const dist = buildReference(dir);
    process.stdout.write(`perf:reference: the ${path.basename(path.dirname(dist))} package matches the pinned digest\n${dist}\n`);
  } catch (error) {
    process.stderr.write(`perf:reference: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}

module.exports = { buildReference };
