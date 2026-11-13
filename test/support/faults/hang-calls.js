'use strict';

/**
 * A hung port, #28 slice 4's hung-repository fault one level up (#301): a port whose calls wait,
 * unanswered, until the case releases them, as a repository behind a held store does, so a case
 * can watch what a page does while its calls hang. Nothing under test/support/ ships.
 *
 *   const hung = hangCalls(repository);
 *   const read = hung.port.getNote('n1');  // waits: the real getNote isn't called yet
 *   hung.held();                           // 1
 *   await hung.release();                  // calls each held one on the real port, in order
 *   await read;                            // the real answer, or its rejection
 *
 * The hung port has each of the port's methods, its own and its prototypes', and reads every other
 * property through to the port, which it leaves as it was, so a frozen port hangs too. A held call
 * runs on the real port only at the release, so nothing it would do has happened before then.
 * Calls after the release go straight through.
 */

/**
 * Every method `port` has, its own and its prototypes', but Object's
 * @param {object} port
 * @returns {string[]}
 */
function methodsOf(port) {
  const names = new Set();
  for (let level = port; level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name !== 'constructor' && typeof (/** @type {any} */ (port)[name]) === 'function') names.add(name);
    }
  }
  return [...names];
}

/**
 * `port` with its calls held until release()
 * @template {object} P
 * @param {P} port
 * @param {{methods?: string[]}} [options] - `methods`: hang only these, and let the rest through
 * @returns {{port: P, held: () => number, release: () => Promise<void>}}
 */
function hangCalls(port, { methods = methodsOf(port) } = {}) {
  /** @type {Array<() => void>} */
  const waiting = [];
  let released = false;
  const hung = Object.create(port);
  for (const name of methods) {
    const real = /** @type {any} */ (port)[name];
    if (typeof real !== 'function') throw new TypeError(`hangCalls: the port has no method ${name}`);
    Object.defineProperty(hung, name, {
      value: (/** @type {unknown[]} */ ...args) => {
        if (released) return real.apply(port, args);
        return new Promise((resolve, reject) => {
          waiting.push(() => {
            try {
              resolve(real.apply(port, args));
            } catch (error) {
              reject(error);
            }
          });
        });
      },
    });
  }
  return {
    port: /** @type {P} */ (hung),
    held: () => waiting.length,
    async release() {
      released = true;
      for (const call of waiting.splice(0)) call();
    },
  };
}

module.exports = { hangCalls };
