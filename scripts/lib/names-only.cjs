'use strict';

// A preload for scripts/mutants.js's names-only runs (#257): each test a file registers keeps its
// name and its options, and its body does nothing, so a run lists the file's tests by the names
// and suites a full run reports, without running them. The setup hooks and each test's cleanup do
// nothing too, since no test runs, while `after` still runs, so whatever a file opened as it
// loaded is closed. It swaps node:test's named exports, which the files the catalog names import.
// A file that calls the module's default export instead runs its tests in full, under the same
// names.

const nodeTest = require('node:test');
const { syncBuiltinESMExports } = require('node:module');

const nothing = () => {};

/**
 * `register` with the test's body swapped for one that does nothing. A test given only its body
 * takes the body's name, as node:test names it.
 * @param {(...args: unknown[]) => unknown} register
 * @returns {(...args: unknown[]) => unknown}
 */
const bodiless =
  register =>
  (...args) => {
    const named = typeof args[0] === 'function' ? [args[0].name, ...args] : args;
    return register(...named.map(arg => (typeof arg === 'function' ? nothing : arg)));
  };

// it and test are one function in node:test, and so are their skip, todo and only
const register = nodeTest.test;
const swapped = Object.assign(bodiless(register), register);
for (const variant of ['skip', 'todo', 'only', 'expectFailure']) {
  if (typeof register[variant] === 'function') swapped[variant] = bodiless(register[variant]);
}
nodeTest.it = swapped;
nodeTest.test = swapped;
for (const hook of ['before', 'beforeEach', 'afterEach']) nodeTest[hook] = nothing;
// So a file that imports them as an ES module gets these too
syncBuiltinESMExports();
