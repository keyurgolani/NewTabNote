#!/usr/bin/env node
'use strict';

/**
 * npm run check:security-baseline (#21 slice 1b, PR 3): a built extension's manifest, and the
 * sources that hold its network rules, against security/ (scripts/build/security-baseline.js).
 * The build runs the same check on what it writes.
 *
 *   npm run check:security-baseline                  check dist/
 *   npm run check:security-baseline -- <dir>         check another build
 *   npm run check:security-baseline -- --print       what an entry for the tree as it is records,
 *                                                    to copy into security/changes.json with its
 *                                                    issue, files and rationale
 */

const path = require('node:path');
const fs = require('node:fs');
const { checkSecurityBaseline, recordOf, inputsFrom } = require('./build/security-baseline.js');
const { format, plural } = require('./build/diagnostics.js');

const ROOT = path.join(__dirname, '..');

/**
 * @param {string[]} [argv]
 * @param {{log?: (line: string) => void, error?: (line: string) => void}} [io]
 * @returns {number}
 */
function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const print = argv.includes('--print');
  const [dirArg] = argv.filter((arg) => arg !== '--print');
  const dir = path.resolve(dirArg || path.join(ROOT, 'dist'));
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    error(`check:security-baseline failed: no build at ${path.relative(process.cwd(), dir) || '.'}. Run \`npm run build\` first.`);
    return 1;
  }
  const inputs = inputsFrom(dir, ROOT);
  if (print) {
    log(JSON.stringify(recordOf(inputs), null, 2));
    return 0;
  }
  const problems = checkSecurityBaseline(inputs);
  if (problems.length > 0) {
    error(`check:security-baseline failed: ${plural(problems.length, 'problem')}`);
    problems.forEach((found) => error(`  - ${format(found)}`));
    return 1;
  }
  log('check:security-baseline: OK, the manifest, the CSP, the permissions, the destinations, the ledger and the network sources match security/');
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
