#!/usr/bin/env node

/**
 * The destination registry's module (#21 slice 1b): security/destinations.json is the reviewed
 * list, and js/kernel/composition/destination-rows.js is the same rows as a module the code
 * imports, written from it. This fails when the two differ.
 *
 *   npm run check:destinations              compare the module with security/destinations.json
 *   npm run check:destinations -- --write   write the module from security/destinations.json
 *
 * A module, rather than a JSON import, since every graph reader and test loader in the repo
 * reads first-party imports as scripts.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const REGISTRY = 'security/destinations.json';
const MODULE = 'js/kernel/composition/destination-rows.js';
const WRITE_COMMAND = 'npm run check:destinations -- --write';

/**
 * The module's text for `registry`
 * @param {{destinations: unknown[]}} registry
 * @returns {string}
 */
function moduleText(registry) {
  return [
    '/**',
    ` * The destination registry's rows, written from ${REGISTRY} by \`${WRITE_COMMAND}\`.`,
    ' * Edit the registry, not this file: `npm run check:destinations` fails when they differ, and',
    ' * js/kernel/composition/destinations.js checks the rows as it loads.',
    ' */',
    '',
    '/**',
    ' * `value`, frozen with everything in it',
    ' * @template T',
    ' * @param {T} value',
    ' * @returns {T}',
    ' */',
    'function freeze(value) {',
    "  if (value !== null && typeof value === 'object') {",
    '    Object.values(value).forEach(freeze);',
    '    Object.freeze(value);',
    '  }',
    '  return value;',
    '}',
    '',
    '/** @type {readonly unknown[]} */',
    `export const DESTINATION_ROWS = freeze(${JSON.stringify(registry.destinations, null, 2)});`,
    '',
  ].join('\n');
}

/**
 * @param {string[]} argv
 * @param {{root?: string, log?: (line: string) => void, error?: (line: string) => void}} [options]
 * @returns {number} the exit code
 */
function main(argv, { root = ROOT_DIR, log = console.log, error = console.error } = {}) {
  const write = argv.includes('--write');
  if (argv.some((arg) => arg !== '--write')) {
    error('usage: node scripts/check-destinations.js [--write]');
    return 2;
  }
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(root, REGISTRY), 'utf8'));
  } catch (reason) {
    error(`check:destinations failed: ${REGISTRY} doesn't read: ${reason instanceof Error ? reason.message : reason}`);
    return 1;
  }
  if (!registry || !Array.isArray(registry.destinations)) {
    error(`check:destinations failed: ${REGISTRY} has no destinations list`);
    return 1;
  }
  const expected = moduleText(registry);
  const file = path.join(root, MODULE);
  if (write) {
    fs.writeFileSync(file, expected);
    log(`check:destinations: wrote ${MODULE} from ${REGISTRY}, ${registry.destinations.length} rows`);
    return 0;
  }
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (actual !== expected) {
    error(`check:destinations failed: ${MODULE} doesn't match ${REGISTRY}. Run \`${WRITE_COMMAND}\``);
    return 1;
  }
  log(`check:destinations: OK, ${MODULE} matches ${REGISTRY}, ${registry.destinations.length} rows`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, moduleText, REGISTRY, MODULE };
