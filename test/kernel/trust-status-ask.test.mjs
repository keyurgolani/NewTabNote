// #20 slice 4c, PR 2: the status read's ask (js/kernel/composition/trust-status-ask.js), a chunk
// the new tab loads first in its deferred work. It asks the worker, and loads the status lines'
// chunk only when the answer could put a line in the sidebar, or when Settings opens. Its check
// takes an answer as plainly all clear only where the lines' chunk would take the answer and draw
// no sidebar line; anything else loads the chunk, which checks the answer in full.
//
// The ask is new in this PR, so it loads inside each case.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseOn, fakeKeyRange, hexIds, manualClock, openRecords, trustProfile } from './trust-support.mjs';
import { readOnlyTrustStore } from '../../js/kernel/adapters/indexeddb/trust.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { TRUST_STATUS_MESSAGE, statusFrom } from '../../js/trust/core/status-message.js';
import { HEALTH_GROUPS } from '../../js/trust/core/vocabulary.js';
import { statusOf } from '../../js/trust/ui/status.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = Date.parse('2026-11-07T18:42:00');
const CHECKED = NOW - 5 * 60 * 1000;

/**
 * A status's group
 * @param {string} group
 * @param {Record<string, unknown>} [fields]
 */
const group = (group, fields = {}) => ({ group, needsAction: 0, checkedAt: CHECKED, cause: null, ...fields });

/** @param {Record<string, unknown>} [fields] */
const status = (fields = {}) => ({
  capture: 'safe',
  route: 'trust',
  records: 'open',
  groups: [group('storage'), group('vault')],
  ...fields,
});

/**
 * An incident's cause
 * @param {string} providerId
 * @param {string} faultCode
 * @param {string} severity
 * @param {string | null} [errorCode]
 */
const incident = (providerId, faultCode, severity, errorCode = null) => ({
  from: 'incident',
  providerId,
  faultCode,
  errorCode,
  severity,
  consequenceKey: null,
});

/** A receipt's cause, at fault with nothing needing action */
const RECEIPT = Object.freeze({
  from: 'receipt',
  providerId: 'backup',
  faultCode: null,
  errorCode: null,
  severity: null,
  consequenceKey: 'backup.stale',
});

/** Lists of groups, each as the worker could answer them: all clear, at fault, needing action, at risk */
const GROUP_LISTS = /** @type {Array<[string, unknown[]]>} */ ([
  ['no groups', []],
  ['storage and vault clear', [group('storage'), group('vault')]],
  ['never checked', [group('storage', { checkedAt: null }), group('platform', { checkedAt: null })]],
  ['every group clear', HEALTH_GROUPS.map(name => group(name))],
  ['a receipt at fault, nothing needing action', [group('storage'), group('backup', { cause: RECEIPT })]],
  [
    'one group needing action',
    [
      group('storage'),
      group('vault', { needsAction: 1, cause: incident('credentials', 'legacy-secret', 'data-risk') }),
    ],
  ],
  [
    'one needing two',
    [group('vault', { needsAction: 2, cause: incident('credentials', 'legacy-secret', 'data-risk') })],
  ],
  // A problem a newer build raised, whose fault this build doesn't register: it needs action, and
  // is no cause (summary.js)
  ['a problem of a newer build', [group('storage'), group('sync', { needsAction: 1 })]],
  [
    'a wait for free space',
    [group('storage', { needsAction: 1, cause: incident('storage', 'migration-blocked', 'degraded', 'space-short') })],
  ],
  [
    'a wait for free space and another',
    [
      group('storage', { needsAction: 1, cause: incident('storage', 'migration-blocked', 'degraded', 'space-short') }),
      group('vault', { needsAction: 1, cause: incident('credentials', 'legacy-secret', 'data-risk') }),
    ],
  ],
  [
    'storage at capture risk',
    [group('storage', { needsAction: 1, cause: incident('storage', 'open-failed', 'capture-risk') })],
  ],
  [
    'the worker at capture risk',
    [
      group('storage'),
      group('platform', { needsAction: 1, cause: incident('coordinator', 'start-failed', 'capture-risk') }),
    ],
  ],
  [
    'every group needing action',
    HEALTH_GROUPS.map(name =>
      group(name, { needsAction: 1, cause: incident('index', 'indexer-start-failed', 'degraded') }),
    ),
  ],
]);

/** Every answer the worker could give, by capture, route, records and groups */
function answers() {
  /** @type {Array<[string, unknown]>} */
  const all = [];
  for (const capture of ['safe', 'at-risk', 'unknown']) {
    for (const route of ['trust', 'recovery']) {
      for (const records of ['closed', 'open', 'fallback']) {
        for (const [why, groups] of GROUP_LISTS) {
          all.push([
            `${capture}, ${route}, ${records}, ${why}`,
            { capture, route, records, groups: structuredClone(groups) },
          ]);
        }
      }
    }
  }
  return all;
}

/** Answers the lines' chunk refuses: none, a refusal, and every way an answer can be malformed */
function malformed() {
  const clear = status();
  /** @param {(answer: any) => void} edit */
  const edited = edit => {
    const copy = structuredClone(clear);
    edit(copy);
    return copy;
  };
  return /** @type {Array<[string, unknown]>} */ ([
    ['no answer', undefined],
    ['null', null],
    ['a string', 'trust'],
    ['a number', 0],
    ['an array', [clear]],
    ['a refusal', { error: 'request-refused' }],
    ["records it couldn't read", { error: 'unavailable' }],
    ["the summary's worstCore beside it", { ...clear, worstCore: 'verified' }],
    ['no records', edited(answer => delete answer.records)],
    ['one with a prototype', Object.assign(Object.create({ inherited: true }), structuredClone(clear))],
    ['capture of another build', { ...clear, capture: 'maybe' }],
    ['a route of another build', { ...clear, route: 'moment' }],
    ['records of another build', { ...clear, records: 'gone' }],
    ['groups that are no list', { ...clear, groups: 'storage' }],
    ['a group of another build', { ...clear, groups: [group('cloud')] }],
    ['a group twice', { ...clear, groups: [group('storage'), group('storage')] }],
    ['more groups than there are', { ...clear, groups: Array.from({ length: 10 }, () => group('vault')) }],
    ['a group that is no object', { ...clear, groups: [null] }],
    ['a group as a list', { ...clear, groups: [['storage', 0, CHECKED, null]] }],
    ["a group's providers", edited(answer => (answer.groups[0].providers = 2))],
    ['a group with no cause', edited(answer => delete answer.groups[0].cause)],
    ['a count of needs below zero', edited(answer => (answer.groups[0].needsAction = -1))],
    ['a count of needs that is no whole number', edited(answer => (answer.groups[0].needsAction = 0.5))],
    ['a count of needs as text', edited(answer => (answer.groups[0].needsAction = '0'))],
    ['a count of needs that is no number', edited(answer => (answer.groups[0].needsAction = Number.NaN))],
    ['a time as text', edited(answer => (answer.groups[0].checkedAt = 'yesterday'))],
    ['a time before 1970', edited(answer => (answer.groups[0].checkedAt = -5))],
    ['a time that is no number', edited(answer => (answer.groups[0].checkedAt = Number.NaN))],
    ['a cause with nothing in it', edited(answer => (answer.groups[0].cause = {}))],
    ['a cause of another build', edited(answer => (answer.groups[0].cause = incident('quantum', 'gremlins', 'dire')))],
  ]);
}

/**
 * Whether the lines' chunk draws a sidebar line for `answer`, with 1b's space notice shown or not,
 * and whether it takes the answer at all
 * @param {unknown} answer
 */
function drawn(answer) {
  const taken = statusFrom(answer);
  const sidebar =
    taken !== null && [false, true].some(spaceNotice => statusOf(taken, { now: NOW, spaceNotice }).sidebar !== null);
  return { taken: taken !== null, sidebar };
}

/** A document the ask listens on, whose `shown()` shows the tab again */
function tabDocument() {
  /** @type {Array<() => void>} */
  const listeners = [];
  return {
    visibilityState: 'visible',
    addEventListener: (/** @type {string} */ type, /** @type {() => void} */ listener) => {
      if (type === 'visibilitychange') listeners.push(listener);
    },
    shown: async () => {
      for (const listener of listeners) listener();
      await settled();
    },
  };
}

/** Lets every promise the ask set going settle */
const settled = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
};

/**
 * An ask whose answers are `answers`, in turn, which counts its sends, and the lines' chunks it
 * loads, each with the reads its send gave it
 * @param {unknown[]} answers
 * @param {{failLoads?: number}} [options] - how many loads come back with no chunk first
 */
function asking(answers, { failLoads = 0 } = {}) {
  const seen = { sends: 0, loads: 0, starts: 0, reads: /** @type {unknown[]} */ ([]) };
  /** @type {(() => Promise<unknown>) | null} */
  let chunkSend = null;
  const send = async () => {
    seen.sends += 1;
    return answers.shift();
  };
  const load = async () => {
    seen.loads += 1;
    if (seen.loads <= failLoads) return null;
    return {
      startTrustStatus: (/** @type {{send: () => Promise<unknown>}} */ options) => {
        const read = options.send;
        seen.starts += 1;
        chunkSend = read;
        const ready = read().then(answer => {
          seen.reads.push(answer);
          return answer;
        });
        return { read, ready };
      },
    };
  };
  /** The lines' chunk reads again, as it does when the tab is shown again */
  const chunkReads = async () => {
    const answer = await /** @type {() => Promise<unknown>} */ (chunkSend)();
    seen.reads.push(answer);
  };
  return { seen, send, load, chunkReads };
}

describe("the status read's check of an answer (#20 slice 4c, plainlyClear)", () => {
  it('loads the lines wherever they would draw a sidebar line, or refuse the answer, over every answer shape', async () => {
    const { plainlyClear } = await import('../../js/kernel/composition/trust-status-ask.js');
    let lines = 0;
    let clear = 0;
    for (const [why, answer] of [...answers(), ...malformed()]) {
      const { taken, sidebar } = drawn(answer);
      const skips = plainlyClear(answer);
      if (sidebar) {
        lines += 1;
        assert.equal(skips, false, `the lines would draw a sidebar line for ${why}, so it loads them`);
      }
      if (!taken) assert.equal(skips, false, `the lines would refuse ${why}, so it loads them`);
      if (skips) clear += 1;
    }
    assert.ok(lines > 100, `it saw ${lines} answers with a sidebar line`);
    assert.ok(clear >= 8, `it saw ${clear} answers plainly all clear`);
  });

  it('takes an answer as plainly all clear, so the lines never load, only with nothing to show and as the worker sends it', async () => {
    const { plainlyClear } = await import('../../js/kernel/composition/trust-status-ask.js');
    for (const capture of ['safe', 'unknown']) {
      for (const [why, groups] of GROUP_LISTS.slice(0, 4)) {
        const answer = { capture, route: 'trust', records: 'open', groups: structuredClone(groups) };
        assert.equal(plainlyClear(answer), true, `${capture}, ${why}`);
        assert.equal(
          plainlyClear(JSON.parse(JSON.stringify(answer))),
          true,
          `${capture}, ${why}, as the message carries it`,
        );
      }
    }
    // Clear, but not plainly: the lines load and take it
    for (const [why, answer] of /** @type {Array<[string, unknown]>} */ ([
      ['closed records', status({ records: 'closed' })],
      ['a receipt at fault', status({ groups: [group('backup', { cause: RECEIPT })] })],
      ['its fields in another order', { groups: status().groups, records: 'open', route: 'trust', capture: 'safe' }],
      ['a group with no prototype', status({ groups: [Object.assign(Object.create(null), group('storage'))] })],
    ])) {
      assert.equal(drawn(answer).sidebar, false, why);
      assert.equal(plainlyClear(answer), false, why);
    }
  });

  it("takes as plainly all clear what the worker answers with no NewTabNoteTrust yet, as in the perf probe's profiles, and with one that holds no problem", async () => {
    const { plainlyClear } = await import('../../js/kernel/composition/trust-status-ask.js');
    const { workerStatusRead } = await import('../../js/kernel/composition/trust-status-read.js');
    const EXT = 'abcdefghijklmnopabcdefghijklmnop';
    const profile = trustProfile();
    const read = workerStatusRead({
      store: () => readOnlyTrustStore({ indexedDB: profile.real, keyRange: fakeKeyRange }),
      records: store =>
        createTrustRecords({
          store,
          settings: profile.settings,
          clock: manualClock(),
          ids: hexIds('d4e5'),
          locks: profile.locks,
        }),
      clock: manualClock(),
      extensionId: () => EXT,
    });
    const sender = { id: EXT, url: `chrome-extension://${EXT}/newtab.html`, origin: `chrome-extension://${EXT}` };
    // As the message carries it: the worker's answer goes over as JSON
    const ask = async () => JSON.parse(JSON.stringify(await read({ type: 'trust.status' }, sender)));
    const none = await ask();
    assert.deepEqual([none.capture, none.route, none.records], ['unknown', 'trust', 'open']);
    assert.equal(plainlyClear(none), true, 'no NewTabNoteTrust');
    // A context that writes the records makes the database, with nothing in it to show
    const writer = databaseOn(profile);
    await openRecords(writer, profile);
    assert.equal(plainlyClear(await ask()), true, 'NewTabNoteTrust with no problem');
    writer.close();
  });
});

describe("the status read's ask (#20 slice 4c, startStatusAsk)", () => {
  it('asks once at its start, and loads nothing for an answer plainly all clear', async () => {
    const { startStatusAsk } = await import('../../js/kernel/composition/trust-status-ask.js');
    const { seen, send, load } = asking([status()]);
    await startStatusAsk({ document: /** @type {any} */ (tabDocument()), send, load }).asked;
    assert.deepEqual([seen.sends, seen.loads], [1, 0]);
  });

  it("loads the lines' chunk once for any other answer, whose first read takes that answer, and reads for itself after", async () => {
    const { startStatusAsk } = await import('../../js/kernel/composition/trust-status-ask.js');
    const attention = status({
      groups: [group('vault', { needsAction: 1, cause: incident('credentials', 'legacy-secret', 'data-risk') })],
    });
    for (const [why, answer] of /** @type {Array<[string, unknown]>} */ ([
      ['a group needing action', attention],
      ['no answer', undefined],
      ['a refusal', { error: 'request-refused' }],
      ['a malformed answer', { ...status(), worstCore: 'verified' }],
    ])) {
      const { seen, send, load, chunkReads } = asking([answer, status()]);
      await startStatusAsk({ document: /** @type {any} */ (tabDocument()), send, load }).asked;
      assert.deepEqual([seen.sends, seen.loads, seen.starts, seen.reads], [1, 1, 1, [answer]], why);
      await chunkReads();
      assert.deepEqual([seen.sends, seen.reads], [2, [answer, status()]], `${why}: its next read sends`);
    }
  });

  it('asks again when the tab is shown again until the lines have loaded, and never after', async () => {
    const { startStatusAsk } = await import('../../js/kernel/composition/trust-status-ask.js');
    const attention = status({ capture: 'at-risk', route: 'recovery' });
    const doc = tabDocument();
    const { seen, send, load } = asking([status(), attention, status()]);
    await startStatusAsk({ document: /** @type {any} */ (doc), send, load }).asked;
    assert.deepEqual([seen.sends, seen.loads], [1, 0]);
    await doc.shown();
    assert.deepEqual(
      [seen.sends, seen.loads, seen.reads],
      [2, 1, [attention]],
      'shown again: at risk, so the lines load',
    );
    await doc.shown();
    assert.deepEqual([seen.sends, seen.loads], [2, 1], 'the lines read for themselves from then on');
    doc.visibilityState = 'hidden';
    await doc.shown();
    assert.equal(seen.sends, 2);
  });

  it("loads the lines' chunk when Settings opens, once, which reads for itself, and tries a load that failed again at the next one", async () => {
    const { startStatusAsk } = await import('../../js/kernel/composition/trust-status-ask.js');
    const { seen, send, load } = asking([status(), status(), status()], { failLoads: 1 });
    const ask = startStatusAsk({ document: /** @type {any} */ (tabDocument()), send, load });
    await ask.asked;
    await ask.settingsOpened();
    assert.deepEqual([seen.sends, seen.loads, seen.starts], [1, 1, 0], 'its chunk did not load');
    await ask.settingsOpened();
    assert.deepEqual(
      [seen.sends, seen.loads, seen.starts, seen.reads],
      [2, 2, 1, [status()]],
      'loaded at the next, reading for itself',
    );
    await ask.settingsOpened();
    assert.deepEqual([seen.loads, seen.starts], [2, 1], 'once');
  });

  it("loads the lines' chunk through the page loader, by its name and its literal import(), and nothing on a failed load", async () => {
    const { startStatusAsk } = await import('../../js/kernel/composition/trust-status-ask.js');
    /** @type {string[]} */
    const names = [];
    let starts = 0;
    const loader = (/** @type {any} */ result) => ({
      loadChunk: async (/** @type {string} */ name) => {
        names.push(name);
        return result;
      },
    });
    const chunk = {
      startTrustStatus: () => {
        starts += 1;
        return { ready: Promise.resolve(null) };
      },
    };
    const attention = { error: 'unavailable' };
    await startStatusAsk({
      loader: loader({ status: 'loaded', module: chunk }),
      document: /** @type {any} */ (tabDocument()),
      send: async () => attention,
    }).asked;
    await startStatusAsk({
      loader: loader({ status: 'failed', reason: 'chunk-missing' }),
      document: /** @type {any} */ (tabDocument()),
      send: async () => attention,
    }).asked;
    assert.deepEqual([names, starts], [['trust-status', 'trust-status'], 1]);
    const source = fs.readFileSync(path.join(ROOT, 'js', 'kernel', 'composition', 'trust-status-ask.js'), 'utf8');
    assert.match(source, /\.loadChunk\('trust-status', \(\) => import\('\.\/trust-status\.js'\)\)/);
  });
});

describe("the status read's ask, as the new tab's start can hold it (#20 slice 4c)", () => {
  it('imports nothing, and repeats the message type and the groups of the modules it may not load', async () => {
    const ask = await import('../../js/kernel/composition/trust-status-ask.js');
    assert.equal(ask.TRUST_STATUS_MESSAGE, TRUST_STATUS_MESSAGE);
    assert.deepEqual([...ask.STATUS_GROUPS], [...HEALTH_GROUPS]);
    const source = fs.readFileSync(path.join(ROOT, 'js', 'kernel', 'composition', 'trust-status-ask.js'), 'utf8');
    assert.doesNotMatch(source, /^import\s/m);
    assert.deepEqual(
      [...source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map(match => match[1]),
      ['./trust-status.js'],
    );
  });

  it('sends the worker the status read alone, and answers what it answered, its wait cleared', async () => {
    const { STATUS_WAIT_MS, statusSender } = await import('../../js/kernel/composition/trust-status-ask.js');
    assert.equal(STATUS_WAIT_MS, 5000);
    /** @type {unknown[]} */
    const messages = [];
    const timers = manualTimers();
    const send = statusSender(
      { sendMessage: async (/** @type {unknown} */ message) => (messages.push(message), status()) },
      { timers },
    );
    assert.deepEqual(await send(), status());
    assert.deepEqual(messages, [{ type: 'trust.status' }]);
    assert.equal(timers.pending.size, 0, 'its wait is cleared');
  });

  it('answers nothing once its wait runs out, when the send fails, or when it throws', { timeout: 2000 }, async () => {
    const { statusSender } = await import('../../js/kernel/composition/trust-status-ask.js');
    const timers = manualTimers();
    const waiting = statusSender({ sendMessage: () => new Promise(() => {}) }, { timers })();
    timers.fire();
    assert.equal(await waiting, undefined, 'its wait ran out');
    const rejected = statusSender(
      {
        sendMessage: async () => {
          throw new Error('Could not establish connection.');
        },
      },
      { timers: manualTimers() },
    );
    assert.equal(await rejected(), undefined, 'the send failed');
    const thrown = statusSender(
      {
        sendMessage: () => {
          throw new Error('Extension context invalidated.');
        },
      },
      { timers: manualTimers() },
    );
    assert.equal(await thrown(), undefined, 'the send threw');
  });
});

/** Timers a test runs by hand */
function manualTimers() {
  /** @type {Map<number, () => void>} */
  const pending = new Map();
  let next = 0;
  return {
    pending,
    setTimeout: (/** @type {() => void} */ callback, /** @type {number} */ ms) => {
      next += 1;
      pending.set(next, callback);
      assert.equal(ms, 5000, 'it waits STATUS_WAIT_MS');
      return next;
    },
    clearTimeout: (/** @type {number} */ handle) => pending.delete(handle),
    fire: () => [...pending.values()].forEach(callback => callback()),
  };
}
