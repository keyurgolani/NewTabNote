// #13's commit hints (core/messaging/hints.js) on the hint channel (adapters/messaging/
// hint-channel.js), over the Chrome fake's BroadcastChannel: coalesced per entity by the
// coordinator, content-free, and dropped by a page when duplicate or out of order (#13, AC2
// and AC4).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openHintChannel } from '../../js/kernel/adapters/messaging/hint-channel.js';
import { encode } from '../../js/kernel/core/contracts/codec.js';
import { HINT_CHANNEL } from '../../js/kernel/core/contracts/hint-channel.js';
import { MAX_HINT_ENTITIES, createHintPublisher, createHintSubscriber } from '../../js/kernel/core/messaging/hints.js';
import { createChromeFake } from './chrome-fake.mjs';
import { settle } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/hints.js').Hint} Hint */

/**
 * The worker and two new tabs, each with the hint channel open, and every hint each tab heard
 */
function opened() {
  const fake = createChromeFake();
  fake.worker.install(() => {});
  fake.worker.start();
  const worker = /** @type {NonNullable<typeof fake.worker.context>} */ (fake.worker.context);
  const channelOf = (/** @type {{BroadcastChannel: any}} */ context) =>
    openHintChannel({ origin: fake.origin, BroadcastChannel: context.BroadcastChannel });
  const publisher = createHintPublisher({ channel: channelOf(worker) });
  const pages = [fake.page('newtab'), fake.page('newtab')].map(page => {
    /** @type {Hint[]} */
    const heard = [];
    const subscriber = createHintSubscriber({ channel: channelOf(page) });
    subscriber.subscribe(hint => heard.push(hint));
    return { page, heard, subscriber };
  });
  return { fake, worker, publisher, pages };
}

/**
 * @param {string} entityId
 * @param {number} commitSeq
 * @returns {Hint}
 */
const note = (entityId, commitSeq) => ({ entityType: 'note', entityId, revision: commitSeq, commitSeq });

describe('commit hints (#13, "Desired behavior")', () => {
  it("posts the coordinator's hints to every page, the latest per entity in a turn", async () => {
    const { publisher, pages } = opened();
    publisher.publish(note('n1', 1));
    publisher.publish(note('n1', 2));
    publisher.publish(note('n2', 3));
    // An older hint for the same entity in the same turn changes nothing
    publisher.publish(note('n1', 1));
    await settle();
    for (const { heard } of pages) assert.deepEqual(heard, [note('n1', 2), note('n2', 3)]);
  });

  it('drops a hint that is a duplicate or out of order for its entity, and keeps entities apart', async () => {
    const { fake, pages } = opened();
    const other = new (fake.page('popup').BroadcastChannel)(HINT_CHANNEL);
    for (const hint of [note('n1', 5), note('n1', 5), note('n1', 3), note('n2', 4), note('n1', 6)]) {
      other.postMessage(encode({ frame: 'hint', ...hint }));
    }
    await settle();
    assert.deepEqual(pages[0].heard, [note('n1', 5), note('n2', 4), note('n1', 6)]);
  });

  it('remembers the last MAX_HINT_ENTITIES entities it heard, dropping the one heard longest ago', async () => {
    const { fake, pages } = opened();
    const other = new (fake.page('popup').BroadcastChannel)(HINT_CHANNEL);
    const post = (/** @type {Hint} */ hint) => other.postMessage(encode({ frame: 'hint', ...hint }));
    for (let i = 0; i < MAX_HINT_ENTITIES; i += 1) post(note(`n${i}`, i + 1));
    // Hearing n0 again makes it the latest, so n1 is the one the next entity pushes out
    post(note('n0', MAX_HINT_ENTITIES + 1));
    post(note('new', MAX_HINT_ENTITIES + 2));
    await settle();
    const before = pages[0].heard.length;
    assert.equal(before, MAX_HINT_ENTITIES + 2);
    // A forgotten entity lets a duplicate through, which catching up from the cursor absorbs
    post(note('n0', MAX_HINT_ENTITIES + 1));
    post(note('n2', 3));
    post(note('n1', 2));
    await settle();
    assert.deepEqual(pages[0].heard.slice(before), [note('n1', 2)]);
  });

  it('carries ids and numbers only: a hint holding anything else is refused on both sides', async () => {
    const { fake, publisher, pages } = opened();
    /** @type {string[]} */
    const refused = [];
    const strict = createHintPublisher({
      channel: openHintChannel({ origin: fake.origin, BroadcastChannel: fake.page('newtab').BroadcastChannel }),
      logger: { warn: event => refused.push(event) },
    });
    strict.publish(/** @type {any} */ ({ ...note('n1', 1), title: 'Plan for the week' }));
    publisher.publish(/** @type {any} */ ({ ...note('n1', 1), entityType: 'setting' }));
    const forged = new (fake.page('popup').BroadcastChannel)(HINT_CHANNEL);
    forged.postMessage(encode({ frame: 'hint', ...note('n1', 1), title: 'Plan for the week' }));
    forged.postMessage({ frame: 'hint', ...note('n1', 2) });
    await settle();
    assert.deepEqual(refused, ['hint-refused']);
    assert.deepEqual(pages[0].heard, []);
  });

  it("hears nothing a page of another origin posts, and passes on only text from this extension's own", async () => {
    const { fake, pages } = opened();
    // A web page's BroadcastChannel never reaches this extension's
    new (fake.contentScript('https://example.test/').BroadcastChannel)(HINT_CHANNEL).postMessage(
      encode({ frame: 'hint', ...note('n1', 1) }),
    );
    // And the adapter checks the origin each event carries
    /** @type {Array<(event: {data: unknown, origin: string}) => void>} */
    const listeners = [];
    const stub = class {
      postMessage() {}
      close() {}
      /** @param {string} type @param {(event: {data: unknown, origin: string}) => void} listener */
      addEventListener(type, listener) {
        listeners.push(listener);
      }
    };
    /** @type {string[]} */
    const heard = [];
    openHintChannel({ origin: fake.origin, BroadcastChannel: stub }).onMessage(text => heard.push(text));
    for (const listener of listeners) {
      listener({ data: 'from another origin', origin: 'https://example.test' });
      listener({ data: { not: 'text' }, origin: fake.origin });
      listener({ data: 'from this one', origin: fake.origin });
    }
    await settle();
    assert.deepEqual([pages[0].heard, heard], [[], ['from this one']]);
  });

  it('keeps a subscriber that throws from stopping the others, and one that unsubscribed hears nothing', async () => {
    const { publisher, pages } = opened();
    /** @type {string[]} */
    const reported = [];
    const subscriber = createHintSubscriber({
      channel: openHintChannel({
        origin: pages[0].page.sender.origin ?? '',
        BroadcastChannel: pages[0].page.BroadcastChannel,
      }),
      logger: { warn: event => reported.push(event) },
    });
    subscriber.subscribe(() => {
      throw new Error('a broken subscriber');
    });
    /** @type {Hint[]} */
    const heard = [];
    const stop = subscriber.subscribe(hint => heard.push(hint));
    publisher.publish(note('n1', 1));
    await settle();
    stop();
    publisher.publish(note('n1', 2));
    await settle();
    assert.deepEqual([heard, reported], [[note('n1', 1)], ['hint-listener-failed', 'hint-listener-failed']]);
  });
});
