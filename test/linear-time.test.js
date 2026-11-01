'use strict';

// #14's shared linear-time check (test/helpers/linear-time.js): it passes a linear read, fails one
// that grows faster even when its large call stays under the old 50 ms floor, and a failure
// carries its own times.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { linear, FLOOR_MS, RATIO, SMALL, LARGE, CALLS, ATTEMPTS } = require('./helpers/linear-time.js');

/** Busy for `ms`, so a call's time doesn't depend on what it computes */
const busy = ms => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

describe("the linear-time check (#14)", () => {
  it('compares 20,000 and 80,000 characters, best of 5 a size, up to 3 tries, under 8 times or 10 ms', () => {
    assert.deepEqual([SMALL, LARGE, CALLS, ATTEMPTS, RATIO, FLOOR_MS], [20_000, 80_000, 5, 3, 8, 10]);
  });

  it('passes a linear read', () => {
    assert.equal(linear(text => text.split('a').length, n => 'ab'.repeat(n / 2)), true);
  });

  it('fails a read that grows faster, under the old 50 ms floor, with both best times in each try', () => {
    // 30 ms at 80,000 characters and about 0.5 ms at 20,000: 64 times for 4 times the input
    const cubic = function cubic(text) {
      busy(30 * (text.length / LARGE) ** 3);
    };
    assert.throws(
      () => linear(cubic, n => 'x'.repeat(n)),
      error => {
        assert.ok(error instanceof assert.AssertionError);
        assert.match(error.message, /^cubic isn't linear on the input starting "x{24}": at 20000 and 80000 characters, the best of 5 calls took /);
        // Each of the three tries gives its two times
        assert.equal(error.message.match(/\d+\.\d\d ms and \d+\.\d\d ms/g).length, 3);
        assert.match(error.message, /each over max\(8 x the small one, 10 ms\)$/);
        return true;
      },
    );
  });
});
