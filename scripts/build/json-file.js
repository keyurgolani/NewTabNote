'use strict';

/**
 * What the build's lists under build/ share (#300, #321's review): the define allowlist, the warning
 * allowlist and the side-effects list each read as JSON and are checked by their own shape before
 * the build uses them, with the object test those shapes take
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the list at `file` under `root`. A list that's missing, doesn't parse, or has a shape
 * `shapeProblems` finds fault with comes back as its problems, each under `code`, and no value.
 * @param {string} root
 * @param {string} file - relative to root
 * @param {string} code - the list's file code
 * @param {(value: unknown) => Problem[]} shapeProblems
 * @returns {{value: unknown, problems: Problem[]}}
 */
function readList(root, file, code, shapeProblems) {
  const at = path.join(root, file);
  if (!fs.existsSync(at)) return { value: undefined, problems: [problem(code, file, 'is missing')] };
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(fs.readFileSync(at, 'utf8'));
  } catch (error) {
    return { value: undefined, problems: [problem(code, file, `doesn't parse: ${error instanceof Error ? error.message : error}`)] };
  }
  const problems = shapeProblems(value);
  return problems.length > 0 ? { value: undefined, problems } : { value, problems };
}

module.exports = { isObject, readList };
