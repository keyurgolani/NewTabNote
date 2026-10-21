// #13's in-process transport (core/messaging/in-process.js): the two ends of a connection in
// one context, which carry text as a runtime port does, so a caller can't tell them apart.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInProcessTransport, linkPair } from '../../js/kernel/core/messaging/in-process.js';

/** Waits until every message already sent has arrived */
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('the in-process transport (#13, "Topology")', () => {
  it('carries text from each end to the other in order, on a later microtask', async () => {
    const [near, far] = linkPair();
    /** @type {string[]} */
    const heard = [];
    far.onMessage(text => heard.push(`far ${text}`));
    near.onMessage(text => heard.push(`near ${text}`));
    near.send('one');
    near.send('two');
    far.send('back');
    // Nothing arrives in the task that sent it, as on a port
    assert.deepEqual(heard, []);
    await settle();
    assert.deepEqual(heard, ['far one', 'far two', 'near back']);
  });

  it('tells the other end when one closes, and refuses a send on either end after', async () => {
    const [near, far] = linkPair();
    /** @type {string[]} */
    const closes = [];
    near.onClose(reason => closes.push(`near ${reason}`));
    far.onClose(reason => closes.push(`far ${reason}`));
    near.close();
    assert.throws(() => near.send('late'), /closed/);
    assert.throws(() => far.send('late'), /closed/);
    await settle();
    // As a port's disconnect, only the other end hears it
    assert.deepEqual(closes, ['far closed']);
    near.close();
    far.close();
    await settle();
    assert.deepEqual(closes, ['far closed']);
  });

  it('drops a message still on its way to an end that closed, so nothing reaches it after its own close', async () => {
    const [near, far] = linkPair();
    /** @type {string[]} */
    const heard = [];
    far.onMessage(text => heard.push(text));
    near.send('sent before the close');
    far.close();
    await settle();
    assert.deepEqual(heard, []);
  });

  it('delivers what an end sent before it closed, then the close, as a runtime port does', async () => {
    const [near, far] = linkPair();
    /** @type {string[]} */
    const heard = [];
    far.onMessage(text => heard.push(text));
    far.onClose(reason => heard.push(`close ${reason}`));
    // As a page's last journaled command goes on pagehide, just before its port closes
    near.send('the last command');
    near.close();
    await settle();
    assert.deepEqual(heard, ['the last command', 'close closed']);
  });

  it('keeps a listener that throws from stopping the others', async () => {
    /** @type {unknown[]} */
    const reported = [];
    const [near, far] = linkPair({ report: error => reported.push(error) });
    /** @type {string[]} */
    const heard = [];
    far.onMessage(() => {
      throw new Error('a broken listener');
    });
    far.onMessage(text => heard.push(text));
    near.send('hello');
    await settle();
    assert.deepEqual(heard, ['hello']);
    assert.equal(reported.length, 1);
  });

  it('hands the router its end of each connection, with the surface the transport was made for', async () => {
    /** @type {Array<{surface: string}>} */
    const accepted = [];
    const router = {
      /** @param {{link: import('../../js/kernel/core/messaging/link.js').Link, surface: string}} connection */
      accept(connection) {
        accepted.push({ surface: connection.surface });
        connection.link.onMessage(text => connection.link.send(`echo ${text}`));
      },
    };
    const transport = createInProcessTransport({ router, surface: 'worker-internal' });
    const link = transport.connect();
    /** @type {string[]} */
    const heard = [];
    link.onMessage(text => heard.push(text));
    link.send('ping');
    await settle();
    await settle();
    assert.deepEqual(accepted, [{ surface: 'worker-internal' }]);
    assert.deepEqual(heard, ['echo ping']);
    // Each connect is a connection of its own
    transport.connect();
    assert.equal(accepted.length, 2);
  });
});
