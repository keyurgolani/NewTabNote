// #28 slice 4's hung-repository fault one level up (#301), in Node: a hung port
// (test/support/faults/hang-calls.js) holds each call until the case releases it, then makes it
// on the real port and passes its answer through.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/** @type {typeof import('../support/faults/index.js')} */
const { hangCalls } = createRequire(import.meta.url)('../support/faults/index.js');

/** `count` turns of the event loop */
async function turns(count = 5) {
  for (let turn = 0; turn < count; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

describe('a hung port, in Node', () => {
  it("holds each call until it's released, then makes it on the real port and passes its answer through", async () => {
    /** @type {number[]} */
    const made = [];
    const port = Object.freeze({
      name: 'repository',
      double: async (/** @type {number} */ n) => {
        made.push(n);
        return n * 2;
      },
      refuse: async () => {
        throw new Error('refused');
      },
    });
    const hung = hangCalls(port);
    const four = hung.port.double(2);
    const refused = hung.port.refuse();
    await turns();
    assert.deepEqual(made, [], 'no call reached the real port');
    assert.equal(hung.held(), 2);
    await hung.release();
    assert.equal(await four, 4);
    await assert.rejects(refused, /refused/);
    assert.deepEqual(made, [2]);
    assert.equal(await hung.port.double(3), 6, 'after the release, a call goes straight through');
    assert.equal(hung.port.name, 'repository');
  });

  it('hangs only the methods named, and lets the rest through', async () => {
    const port = { read: async () => 'read', write: async () => 'written' };
    const hung = hangCalls(port, { methods: ['write'] });
    const written = hung.port.write();
    assert.equal(await hung.port.read(), 'read');
    assert.equal(hung.held(), 1);
    await hung.release();
    assert.equal(await written, 'written');
  });
});
