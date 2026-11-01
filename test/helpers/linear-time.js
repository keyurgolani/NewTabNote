'use strict';

/**
 * #14's linear-time check, shared by every file that reads text in linear time: whether `fn`
 * grows linearly on inputs `make` builds. Four times the input takes well under the sixteen
 * times a quadratic read would, so the large call has to stay under eight times the small one.
 *
 * - The two sizes take turns, five calls each, and each keeps its best, so a busy machine slows
 *   both alike.
 * - The measure runs up to three times, so one stalled attempt doesn't decide it; a quadratic
 *   read misses every attempt.
 * - A large call under FLOOR_MS passes whatever the ratio, since times that small are mostly
 *   noise. Measured on 2026-11-01, every check's clean large call took 0 to 19 ms, with a ratio
 *   of at most 5.1. A floor of 50 ms decided all of them, and let through a quadratic over a
 *   unit that comes once per 100 characters.
 * - A check that fails throws, with each attempt's two best times and the input's size, so a
 *   CI failure carries its own numbers.
 */

const assert = require('node:assert/strict');

const SMALL = 20_000;
const LARGE = 80_000;
const RATIO = 8;
const FLOOR_MS = 10;
const CALLS = 5;
const ATTEMPTS = 3;

/**
 * The time of one call, in ms
 * @param {(value: string) => unknown} fn
 * @param {string} value
 */
const timeOnce = (fn, value) => {
  const start = performance.now();
  fn(value);
  return performance.now() - start;
};

/**
 * True when `fn` reads `make`'s inputs in linear time; otherwise it throws an assertion error
 * with the times
 * @param {(value: any) => unknown} fn
 * @param {(n: number) => string} make
 * @returns {true}
 */
function linear(fn, make) {
  const small = make(SMALL);
  const large = make(LARGE);
  /** @type {string[]} */
  const tries = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let bestSmall = Number.POSITIVE_INFINITY;
    let bestLarge = Number.POSITIVE_INFINITY;
    for (let k = 0; k < CALLS; k++) {
      bestSmall = Math.min(bestSmall, timeOnce(fn, small));
      bestLarge = Math.min(bestLarge, timeOnce(fn, large));
    }
    if (bestLarge < Math.max(bestSmall * RATIO, FLOOR_MS)) return true;
    tries.push(`${bestSmall.toFixed(2)} ms and ${bestLarge.toFixed(2)} ms`);
  }
  const start = JSON.stringify(String(small).slice(0, 24));
  throw new assert.AssertionError({
    message: `${fn.name || 'the function'} isn't linear on the input starting ${start}: at ${small.length} and ${large.length} characters, the best of ${CALLS} calls took ${tries.join(', then ')}, each over max(${RATIO} x the small one, ${FLOOR_MS} ms)`,
  });
}

module.exports = { linear, SMALL, LARGE, RATIO, FLOOR_MS, CALLS, ATTEMPTS };
