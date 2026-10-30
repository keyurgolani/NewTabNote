'use strict';

/**
 * The chrome.storage.local conformance suite (#28 slice 2). It holds the stub every legacy
 * test leans on (createChromeStub in legacy-env.js) to what Chromium does, for the calls the
 * product makes: get by key, by array, by an object of defaults, and with null; set; remove;
 * onChanged in every context; and runtime.lastError on a call that fails.
 *
 * One set of cases runs on both. test/chrome-storage-conformance.test.js runs it on the stub,
 * and e2e/chrome-storage.spec.js on Playwright's Chromium in #34's harness, in the extension's
 * service worker and one of its pages. A case's steps are functions that run inside a context,
 * with the context's own `chrome`, so each one stands alone: no closures, plain syntax, and
 * only JSON goes in or comes back, as Playwright's evaluate requires.
 *
 *   describeChromeStorageLocal(define, driver)
 *
 * `define(name, body)` registers a test that awaits body(). `driver.open({quota})` answers a
 * session: `contexts`, the writer and another context of the same extension; `refuseNextSet()`,
 * which makes a set fail and answers `{bytes}`, the size of a string value that set takes; and
 * `close()`. With `quota`, the session is one where a set can fail: the stub always can, and in
 * Chromium it's a build without unlimitedStorage, so a set over QUOTA_BYTES fails.
 *
 * Each case writes keys under its own prefix and reads back only those, so what the extension
 * itself keeps in storage never reaches an assertion.
 */

const assert = require('node:assert/strict');

/** What Chromium reports for a set over chrome.storage.local.QUOTA_BYTES */
const QUOTA_MESSAGE = 'QUOTA_BYTES quota exceeded';

/** How long a case waits for onChanged to reach a context */
const EVENT_WAIT_MS = 5000;

// ─── Steps, each run inside a context ───

/** Every key under `prefix`, from get(null), sorted */
const readAll = async ({ prefix }) => {
  const all = await chrome.storage.local.get(null);
  const mine = {};
  Object.keys(all).filter((key) => key.indexOf(prefix) === 0).sort().forEach((key) => { mine[key] = all[key]; });
  return mine;
};

/** Start recording what chrome.storage.onChanged and chrome.storage.local.onChanged report for keys under `prefix` */
const record = ({ prefix }) => {
  const recorded = globalThis.__ntnStorageEvents || (globalThis.__ntnStorageEvents = {});
  const events = [];
  recorded[prefix] = events;
  const mine = (changes) => {
    const keys = Object.keys(changes).filter((key) => key.indexOf(prefix) === 0).sort();
    const picked = {};
    keys.forEach((key) => { picked[key] = changes[key]; });
    return keys.length > 0 ? picked : null;
  };
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const picked = mine(changes);
    if (picked) events.push({ via: 'storage.onChanged', areaName, changes: picked });
  });
  chrome.storage.local.onChanged.addListener((changes) => {
    const picked = mine(changes);
    if (picked) events.push({ via: 'storage.local.onChanged', changes: picked });
  });
  return null;
};

const recorded = ({ prefix }) => (globalThis.__ntnStorageEvents && globalThis.__ntnStorageEvents[prefix]) || [];

// ─── Helpers, run here ───

/** The events `context` recorded under `prefix` once it has `count`, or fail after EVENT_WAIT_MS */
async function eventsOnce(context, prefix, count) {
  const deadline = Date.now() + EVENT_WAIT_MS;
  for (;;) {
    const events = await context.evaluate(recorded, { prefix });
    if (events.length >= count) return events;
    if (Date.now() > deadline) {
      assert.fail(`${context.name} heard ${events.length} of ${count} onChanged events: ${JSON.stringify(events)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Each change as both onChanged events report it */
function bothEvents(changesList) {
  return changesList.flatMap((changes) => [
    { via: 'storage.onChanged', areaName: 'local', changes },
    { via: 'storage.local.onChanged', changes },
  ]);
}

/** Events in the order each event reported them, so the two listeners' interleaving doesn't count */
function byVia(events) {
  return [...events].sort((a, b) => (a.via < b.via ? -1 : a.via > b.via ? 1 : 0));
}

// ─── Cases ───

/** @type {Array<[string, (session: any, prefix: string) => Promise<void>, {quota?: boolean}?]>} */
const CASES = [
  ['get answers the keys asked for, by string, by array, and by an object of defaults, in any context', async ({ contexts }, p) => {
    const [writer, other] = contexts;
    await writer.evaluate(({ p }) => chrome.storage.local.set({ [`${p}a`]: 1, [`${p}b`]: { list: ['x', true, null] }, [`${p}c`]: 'three' }), { p });
    for (const context of [writer, other]) {
      const answers = await context.evaluate(async ({ p }) => ({
        one: await chrome.storage.local.get(`${p}a`),
        absent: await chrome.storage.local.get(`${p}missing`),
        some: await chrome.storage.local.get([`${p}a`, `${p}c`, `${p}missing`]),
        none: await chrome.storage.local.get([]),
        defaults: await chrome.storage.local.get({ [`${p}a`]: 'unused', [`${p}missing`]: 'fallback' }),
        noDefaults: await chrome.storage.local.get({}),
      }), { p });
      assert.deepEqual(answers, {
        one: { [`${p}a`]: 1 },
        absent: {},
        some: { [`${p}a`]: 1, [`${p}c`]: 'three' },
        none: {},
        defaults: { [`${p}a`]: 1, [`${p}missing`]: 'fallback' },
        noDefaults: {},
      }, context.name);
    }
  }],

  ['get with null, or with no keys, answers everything stored', async ({ contexts }, p) => {
    const [writer, other] = contexts;
    await writer.evaluate(({ p }) => chrome.storage.local.set({ [`${p}a`]: 1, [`${p}b`]: [2] }), { p });
    for (const context of [writer, other]) {
      assert.deepEqual(await context.evaluate(readAll, { prefix: p }), { [`${p}a`]: 1, [`${p}b`]: [2] }, context.name);
      const withoutKeys = await context.evaluate(async ({ p }) => {
        const all = await chrome.storage.local.get();
        return [all[`${p}a`], all[`${p}b`]];
      }, { p });
      assert.deepEqual(withoutKeys, [1, [2]], context.name);
    }
  }],

  ['the callback form calls back once, with the same answer and lastError unset, and returns undefined', async ({ contexts }, p) => {
    const [writer] = contexts;
    const seen = await writer.evaluate(({ p }) => new Promise((resolve) => {
      const calls = [];
      const returned = { set: 'not called', get: 'not called', remove: 'not called' };
      returned.set = chrome.storage.local.set({ [`${p}a`]: 'value' }, (...args) => {
        calls.push({ call: 'set', args: args.length, lastError: chrome.runtime.lastError === undefined ? 'unset' : 'set' });
        returned.get = chrome.storage.local.get([`${p}a`], (...answer) => {
          calls.push({ call: 'get', answer, lastError: chrome.runtime.lastError === undefined ? 'unset' : 'set' });
          returned.remove = chrome.storage.local.remove(`${p}a`, (...args2) => {
            calls.push({ call: 'remove', args: args2.length, lastError: chrome.runtime.lastError === undefined ? 'unset' : 'set' });
            resolve({ calls, returned: { set: typeof returned.set, get: typeof returned.get, remove: typeof returned.remove } });
          });
        });
      });
    }), { p });
    assert.deepEqual(seen, {
      calls: [
        { call: 'set', args: 0, lastError: 'unset' },
        { call: 'get', answer: [{ [`${p}a`]: 'value' }], lastError: 'unset' },
        { call: 'remove', args: 0, lastError: 'unset' },
      ],
      returned: { set: 'undefined', get: 'undefined', remove: 'undefined' },
    });
    assert.deepEqual(await writer.evaluate(readAll, { prefix: p }), {});
  }],

  ['set stores a copy of each value, as JSON would, and answers copies', async ({ contexts }, p) => {
    const [writer, other] = contexts;
    const seen = await writer.evaluate(async ({ p }) => {
      const value = { text: 'ünïcödé 日本語', number: 1.5, flag: false, nothing: null, list: [1, 'two', { three: 3 }, undefined], nested: { deep: { deeper: true }, gone: undefined } };
      await chrome.storage.local.set({ [`${p}value`]: value });
      value.text = 'changed after set';
      value.list.push('pushed after set');
      const first = await chrome.storage.local.get(`${p}value`);
      first[`${p}value`].nested.deep.deeper = 'changed after get';
      const second = await chrome.storage.local.get(`${p}value`);
      return { stored: second[`${p}value`], nestedKeys: Object.keys(second[`${p}value`].nested) };
    }, { p });
    const expected = { text: 'ünïcödé 日本語', number: 1.5, flag: false, nothing: null, list: [1, 'two', { three: 3 }, null], nested: { deep: { deeper: true } } };
    assert.deepEqual(seen, { stored: expected, nestedKeys: ['deep'] });
    assert.deepEqual(await other.evaluate(readAll, { prefix: p }), { [`${p}value`]: expected });
  }],

  ['set leaves a key whose value is undefined as it was', async ({ contexts }, p) => {
    const [writer] = contexts;
    const seen = await writer.evaluate(async ({ p }) => {
      await chrome.storage.local.set({ [`${p}kept`]: 'before' });
      await chrome.storage.local.set({ [`${p}kept`]: undefined, [`${p}never`]: undefined, [`${p}other`]: 1 });
      const answer = await chrome.storage.local.get([`${p}kept`, `${p}never`, `${p}other`]);
      return { answer, keys: Object.keys(answer).sort() };
    }, { p });
    assert.deepEqual(seen, {
      answer: { [`${p}kept`]: 'before', [`${p}other`]: 1 },
      keys: [`${p}kept`, `${p}other`],
    });
  }],

  ['remove deletes the keys given, by string or by array, and leaves the rest', async ({ contexts }, p) => {
    const [writer, other] = contexts;
    await writer.evaluate(async ({ p }) => {
      await chrome.storage.local.set({ [`${p}a`]: 1, [`${p}b`]: 2, [`${p}c`]: 3 });
      await chrome.storage.local.remove(`${p}a`);
      await chrome.storage.local.remove([`${p}b`, `${p}missing`]);
    }, { p });
    for (const context of [writer, other]) {
      assert.deepEqual(await context.evaluate(readAll, { prefix: p }), { [`${p}c`]: 3 }, context.name);
    }
  }],

  ['onChanged tells every context, the writer included, what each set and remove changed', async ({ contexts }, p) => {
    const [writer, other] = contexts;
    for (const context of contexts) await context.evaluate(record, { prefix: p });
    await writer.evaluate(({ p }) => chrome.storage.local.set({ [`${p}a`]: 1 }), { p });
    await writer.evaluate(({ p }) => chrome.storage.local.set({ [`${p}a`]: { n: 2 }, [`${p}b`]: 'x' }), { p });
    await other.evaluate(({ p }) => chrome.storage.local.remove([`${p}a`, `${p}missing`]), { p });
    const changes = [
      { [`${p}a`]: { newValue: 1 } },
      { [`${p}a`]: { oldValue: 1, newValue: { n: 2 } }, [`${p}b`]: { newValue: 'x' } },
      { [`${p}a`]: { oldValue: { n: 2 } } },
    ];
    for (const context of contexts) {
      const events = await eventsOnce(context, p, 6);
      // Each listener hears the three in the order they were made
      assert.deepEqual(byVia(events), byVia(bothEvents(changes)), context.name);
    }
  }],

  ['a write that changes nothing fires no onChanged', async ({ contexts }, p) => {
    const [writer] = contexts;
    for (const context of contexts) await context.evaluate(record, { prefix: p });
    await writer.evaluate(async ({ p }) => {
      await chrome.storage.local.set({ [`${p}a`]: { x: 1, y: [1, 2] } });
      await chrome.storage.local.set({ [`${p}a`]: { y: [1, 2], x: 1 } });
      await chrome.storage.local.set({});
      await chrome.storage.local.remove(`${p}missing`);
      await chrome.storage.local.remove([]);
      // The last write, so once it's heard nothing before it is still on its way
      await chrome.storage.local.set({ [`${p}last`]: true });
    }, { p });
    const changes = [{ [`${p}a`]: { newValue: { x: 1, y: [1, 2] } } }, { [`${p}last`]: { newValue: true } }];
    for (const context of contexts) {
      const events = await eventsOnce(context, p, 4);
      assert.deepEqual(byVia(events), byVia(bothEvents(changes)), context.name);
    }
  }],

  ['a set that fails sets lastError in its callback only, rejects its promise, and stores and announces nothing', async (session, p) => {
    const [writer, other] = session.contexts;
    for (const context of session.contexts) await context.evaluate(record, { prefix: p });
    await writer.evaluate(({ p }) => chrome.storage.local.set({ [`${p}kept`]: 'before' }), { p });

    const { bytes } = await session.refuseNextSet();
    const viaCallback = await writer.evaluate(({ p, bytes }) => new Promise((resolve) => {
      const returned = chrome.storage.local.set({ [`${p}kept`]: 'x'.repeat(bytes) }, (...args) => {
        const error = chrome.runtime.lastError;
        const during = error ? { message: error.message } : null;
        queueMicrotask(() => resolve({ args: args.length, during, after: chrome.runtime.lastError === undefined ? 'unset' : 'set', returned: typeof returned }));
      });
    }), { p, bytes });
    assert.deepEqual(viaCallback, { args: 0, during: { message: QUOTA_MESSAGE }, after: 'unset', returned: 'undefined' });

    const { bytes: again } = await session.refuseNextSet();
    const viaPromise = await writer.evaluate(async ({ p, bytes }) => {
      try {
        await chrome.storage.local.set({ [`${p}big`]: 'x'.repeat(bytes) });
        return 'resolved';
      } catch (error) {
        // The brand, not instanceof, since the stub's errors come from Node's realm, not the vm context's
        return { isError: Object.prototype.toString.call(error) === '[object Error]', message: error.message, lastError: chrome.runtime.lastError === undefined ? 'unset' : 'set' };
      }
    }, { p, bytes: again });
    assert.deepEqual(viaPromise, { isError: true, message: QUOTA_MESSAGE, lastError: 'unset' });

    // The next set goes through, and is the only change after the first
    await writer.evaluate(({ p }) => chrome.storage.local.set({ [`${p}after`]: 1 }), { p });
    for (const context of [writer, other]) {
      assert.deepEqual(await context.evaluate(readAll, { prefix: p }), { [`${p}after`]: 1, [`${p}kept`]: 'before' }, context.name);
      const events = await eventsOnce(context, p, 4);
      assert.deepEqual(byVia(events), byVia(bothEvents([{ [`${p}kept`]: { newValue: 'before' } }, { [`${p}after`]: { newValue: 1 } }])), context.name);
    }
  }, { quota: true }],
];

/**
 * Register every case with `define`, each on a session from `driver`
 * @param {(name: string, body: () => Promise<void>) => void} define
 * @param {{open: (options: {quota: boolean}) => Promise<{contexts: any[], refuseNextSet: () => Promise<{bytes: number}>, close: () => Promise<void>}>}} driver
 */
function describeChromeStorageLocal(define, driver) {
  CASES.forEach(([name, body, options], index) => {
    define(name, async () => {
      const session = await driver.open({ quota: Boolean(options && options.quota) });
      try {
        await body(session, `ntn-conformance-${index}-`);
      } finally {
        await session.close();
      }
    });
  });
}

module.exports = { describeChromeStorageLocal, QUOTA_MESSAGE, CASE_NAMES: CASES.map(([name]) => name) };
