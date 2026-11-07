// #35 slice 4c: Side Panel's page side once its one write, the apply of a closing tab's edit, goes
// to the worker over #13's port (the 4c plan's rules 2 to 7, and the lead's Q5). Its root reads on
// #17's reader and sends each applyCloseDraft through its send chunk, loaded at its first command.
// The start's apply and the journal's apply both go that way, and what can't go stays for the next
// start. On legacy-env profiles, with the stand-in for the worker (popup-worker.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import { waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import { createNewTabAdapter, createNewTabClient } from '../../js/kernel/composition/newtab.js';
import { createSidePanelClient } from '../../js/kernel/composition/sidepanel.js';
import { MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { committed, unavailable } from '../../js/kernel/core/contracts/outcomes.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { DRAFT_PREFIX } from '../../js/kernel/core/domain/close-draft-keys.js';
import { journalEntry } from '../../js/kernel/core/domain/journal.js';
import { legacyContext, legacyEnv } from './legacy-fixture.mjs';
import { settle, testScheduler } from './messaging-support.mjs';
import { popupWorker } from './popup-worker.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('./popup-worker.mjs').Handed} Handed */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/ports/runtime.js').Timers} Timers */

/** Side Panel's root, with a host, its drafts, and the applier's, send chunk's and journal chunk's loaders */
const sidePanelClient = /** @type {(...args: unknown[]) => any} */ (createSidePanelClient);

/** When the closing tabs and the closed page wrote what they left */
const AT = Date.UTC(2026, 10, 6, 9, 0);

/** @type {(id: string, canvasId: string, order: number, content?: string) => any} */
const block = (id, canvasId, order, content) => legacyEnv.block(id, canvasId, order, content);

/** A profile with note A and its blocks a1 and a2, which a new tab made */
async function profile() {
  const tab = legacyContext();
  const newtab = createNewTabClient(
    createNewTabAdapter({
      indexedDB: tab.env.indexedDB,
      settings: tab.env.chrome.api.storage.local,
      awaitUpgrade: () => waitForWorkerUpgrade({ runtime: tab.env.chrome.api.runtime }),
      locks: tab.env.global.navigator.locks || null,
    }),
  );
  assert.equal(await newtab.whenReady(), null);
  const blocks = [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')];
  const made = await newtab.execute({
    type: 'createNote',
    commandId: newtab.ids.next(),
    noteId: 'A',
    name: 'Alpha plan',
    blocks,
  });
  assert.equal(made.kind, 'committed');
  return tab;
}

/**
 * `runtime`, counting each port the page opens on it in `opened`
 * @param {any} runtime
 * @param {{count: number}} opened
 */
const counting = (runtime, opened) => ({
  get lastError() {
    return runtime.lastError;
  },
  connect: (/** @type {unknown} */ info) => {
    opened.count += 1;
    return runtime.connect(info);
  },
});

/**
 * Side Panel on `tab`'s profile, its writes to the stand-in. `journal` and `requestIdle`: the
 * journal chunk's loader, and the page's idle, which starts it once the first read is in.
 * `opened` counts the ports the page opens.
 * @param {LegacyContext} tab
 * @param {{status?: any, before?: (handed: Handed) => unknown, answer?: (handed: Handed) => Outcome | undefined, timers?: Timers, send?: () => Promise<unknown>, journal?: () => Promise<unknown>, requestIdle?: (callback: () => void) => void, opened?: {count: number}}} [options]
 */
function sidePanelOn(tab, { status, before, answer, timers, send, journal, requestIdle, opened } = {}) {
  const { indexedDB } = tab.env;
  const settings = tab.env.chrome.api.storage.local;
  const stand = popupWorker({ indexedDB, settings, status, before, answer, page: 'sidepanel' });
  const runtime = opened ? counting(stand.runtime, opened) : stand.runtime;
  const { extensionVersion } = stand;
  const host = { indexedDB, settings, awaitUpgrade: async () => {}, runtime, extensionVersion, timers, requestIdle };
  const drafts = { storage: tab.env.global.localStorage, locks: tab.env.global.navigator.locks };
  return { stand, client: sidePanelClient(host, drafts, undefined, send, journal) };
}

/**
 * The real journal chunk, as Side Panel loads it, on `tab`'s journal, locks and drafts
 * @param {LegacyContext} tab
 */
const journalOn = tab => async () => {
  const chunk = await import('../../js/kernel/composition/journal-chunk.js');
  const ports = {
    stores: inContextStores({ indexedDB: tab.env.indexedDB }),
    locks: tab.env.global.navigator.locks,
    storage: tab.env.global.localStorage,
    runtime: { sendMessage: async () => {} },
  };
  return {
    startPageJournal: (
      /** @type {any} */ client,
      /** @type {string} */ sessionId,
      /** @type {any} */ surface,
      /** @type {any} */ given,
    ) => chunk.startPageJournal(client, sessionId, surface, { ...given, ...ports }),
  };
};

/** The page's idle, at once */
const idleNow = (/** @type {() => void} */ callback) => void setTimeout(callback, 0);

/**
 * Whether `check` holds within 2 s of real time, looked at every few milliseconds
 * @param {() => boolean | Promise<boolean>} check
 */
async function until(check) {
  for (const end = Date.now() + 2000; Date.now() < end;) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return false;
}

/**
 * What the profile's journal holds now, on a connection of the test's own
 * @param {LegacyContext} tab
 */
async function journalOf(tab) {
  const stores = inContextStores({ indexedDB: tab.env.indexedDB });
  if (!(await stores.journalExists())) return [];
  const journal = stores.journal();
  try {
    await journal.open();
    return await journal.list();
  } finally {
    journal.close();
  }
}

/**
 * A closing tab's edit of A, a1 changed, on the base the tab saw
 * @param {{id?: string, page?: string, at?: number, content?: string}} [options]
 */
function draftOf({ id = 'draft-a', page = 'page-1', at = AT, content = 'alpha, edited as the tab closed' } = {}) {
  const digests = {
    a1: blockDigest(block('a1', 'A', 0, 'alpha'), 'A'),
    a2: blockDigest(block('a2', 'A', 1, 'alpha two'), 'A'),
  };
  return {
    v: 1,
    id,
    page,
    noteId: 'A',
    at,
    base: { revision: 0, updatedAt: null, issued: [], name: 'Alpha plan', blocks: digests, issuedSaves: [] },
    blocks: [block('a1', 'A', 0, content)],
    deletedBlockIds: [],
    preview: content.slice(0, 80),
    todoProgress: null,
    linkedNames: [],
  };
}

/**
 * The edit `options` describes, where its closing tab leaves it, and its key
 * @param {LegacyContext} tab
 * @param {Parameters<typeof draftOf>[0]} [options]
 */
function writeDraft(tab, options) {
  const draft = draftOf(options);
  tab.env.global.localStorage.setItem(`${DRAFT_PREFIX}${draft.id}`, JSON.stringify(draft));
  return `${DRAFT_PREFIX}${draft.id}`;
}

/**
 * A page's apply of `draft`, as the start's apply sends it
 * @param {ReturnType<typeof draftOf>} draft
 */
const applyOf = draft => ({ type: /** @type {const} */ ('applyCloseDraft'), commandId: `${draft.id}-apply`, draft });

/**
 * An editor save of A's a1 that a page journaled and closed before its answer
 * @param {LegacyContext} tab
 */
async function leaveSave(tab) {
  const content = 'alpha, saved as its page closed';
  const blocks = [{ id: 'a1', type: 'text', content, order: 0 }];
  const command = { type: 'saveNoteContent', commandId: 'c-save', noteId: 'A', blocks, deriveFromStored: true };
  /** @type {any} the edit the page journaled with its save */
  const draft = {
    ...draftOf({ id: 'c-save', page: 'page-gone', content }),
    blocks: blocks.map(saved => ({ ...saved, canvasId: 'A' })),
  };
  const writer = inContextStores({ indexedDB: tab.env.indexedDB }).journal();
  await writer.open();
  const ownerSessionId = 'page-gone';
  await writer.put(
    journalEntry({
      command,
      v: 1,
      noteId: 'A',
      surface: 'newtab',
      ownerSessionId,
      seq: 1,
      createdAt: AT,
      draft,
      pane: 'main',
    }),
  );
  writer.close();
}

describe("Side Panel's writes, over #13's port (#35 slice 4c)", () => {
  for (const [welcome, status] of /** @type {Array<[string, any]>} */ ([
    ['a ready', undefined],
    ['a starting', () => ({ status: 'degraded', reason: 'starting' })],
  ])) {
    it(`sends the start's apply of a closing tab's edit to the worker as sidepanel on ${welcome} welcome, and it commits there (rule 2, risk 7)`, async () => {
      const tab = await profile();
      const key = writeDraft(tab);
      const { stand, client } = sidePanelOn(tab, { status });
      try {
        assert.deepEqual((await client.applied())?.saved, ['A']);
        assert.deepEqual(
          stand.handed.map(one => [one.surface, one.type, one.commandId]),
          [['sidepanel', 'applyCloseDraft', 'draft-a-apply']],
          'the worker committed it, for Side Panel',
        );
        assert.equal(tab.env.global.localStorage.getItem(key), null, 'and the draft went');
      } finally {
        stand.close();
      }
    });
  }

  it("sends the journal's apply of an editor save a closed page left the same way, and the entry goes once it commits (rule 2)", async () => {
    const tab = await profile();
    await leaveSave(tab);
    const { stand, client } = sidePanelOn(tab, { journal: journalOn(tab), requestIdle: idleNow });
    try {
      assert.equal(await client.whenReady(), null);
      assert.equal((await client.query({ type: 'listNotes', view: 'sidePanel' })).kind, 'ready');
      assert.equal(await until(() => stand.handed.length > 0), true, "the journal's start sent it");
      assert.deepEqual(
        stand.handed.map(one => [one.surface, one.type, one.commandId]),
        [['sidepanel', 'applyCloseDraft', 'c-save-apply']],
      );
      assert.equal(await until(async () => (await journalOf(tab)).length === 0), true, 'and its entry went');
    } finally {
      stand.close();
    }
  });

  it("sends nothing for a closing tab's edit over the port's 1 MiB, which stays for the new tab (rule 6)", async () => {
    const tab = await profile();
    const key = writeDraft(tab, { content: 'x'.repeat(MAX_MESSAGE_BYTES) });
    const { stand, client } = sidePanelOn(tab);
    try {
      assert.deepEqual((await client.applied())?.kept, ['A'], "Side Panel's start applied it, and kept it");
      assert.deepEqual(
        stand.frames.filter(frame => frame.operation === 'applyCloseDraft'),
        [],
        'nothing went on the port',
      );
      assert.notEqual(tab.env.global.localStorage.getItem(key), null, 'the draft stays');
    } finally {
      stand.close();
    }
  });

  it("waits at most 2 s for the start's apply, then reads what's stored, and applied answers once it's done (rule 5)", async () => {
    const tab = await profile();
    writeDraft(tab);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise(resolve => {
      release = resolve;
    });
    const scheduler = testScheduler();
    const before = (/** @type {Handed} */ one) => (one.type === 'applyCloseDraft' ? held : undefined);
    const { stand, client } = sidePanelOn(tab, { timers: scheduler.timers, before });
    try {
      let ready = false;
      client.whenReady().then(() => {
        ready = true;
      });
      assert.ok(await until(() => stand.handed.some(one => one.type === 'applyCloseDraft')), 'the apply sent the edit');
      await scheduler.advance(1999);
      assert.equal(ready, false, 'it waits for the apply');
      await scheduler.advance(1);
      assert.equal(ready, true, 'for 2 s at most');
      release();
      assert.deepEqual((await client.applied())?.saved, ['A']);
    } finally {
      release();
      stand.close();
    }
  });

  it('loads the send chunk once, at its first command, and holds each command for it in order (rule 2)', async () => {
    const tab = await profile();
    /** @type {string[]} */
    const went = [];
    const execute = async (/** @type {{commandId: string}} */ command) => {
      went.push(command.commandId);
      return committed('close-draft-saved', ['A']);
    };
    /** @type {Array<() => void>} each load's own finish */
    const loads = [];
    const send = () => new Promise(resolve => loads.push(() => resolve({ sidePanelSender: () => ({ execute }) })));
    const { stand, client } = sidePanelOn(tab, { send });
    // Every load the root asked for finishes, the last first
    const finish = async () => {
      for (const done of [...loads].reverse()) done();
      await settle();
    };
    try {
      const [first, second, third] = ['draft-1', 'draft-2', 'draft-3'].map(id => applyOf(draftOf({ id })));
      const answers = [client.execute(first), client.execute(second)];
      await settle();
      assert.deepEqual(went, [], 'nothing goes before the chunk is in');
      await finish();
      answers.push(client.execute(third));
      await finish();
      await Promise.all(answers);
      assert.deepEqual(went, [first.commandId, second.commandId, third.commandId]);
      assert.equal(loads.length, 1, 'one load');
    } finally {
      stand.close();
    }
  });

  it("answers each command unavailable, reload-required, when the send chunk can't load, sends nothing, and keeps the draft (rule 7)", async () => {
    const tab = await profile();
    const key = writeDraft(tab);
    const send = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
    const { stand, client } = sidePanelOn(tab, { send });
    try {
      assert.deepEqual((await client.applied())?.kept, ['A']);
      assert.notEqual(tab.env.global.localStorage.getItem(key), null, 'the draft stays');
      const later = await client.execute(applyOf(draftOf({ id: 'draft-later' })));
      assert.deepEqual(later, unavailable('coordinator', 'reload-required', false));
      assert.deepEqual(stand.frames, []);
    } finally {
      stand.close();
    }
  });

  it("sends no more of a run's commands once the worker didn't take one, and answers each at once, unsent (Q5's b)", async () => {
    const tab = await profile();
    const keys = [
      writeDraft(tab, { id: 'draft-a', at: AT }),
      writeDraft(tab, { id: 'draft-b', page: 'page-2', at: AT + 1, content: 'alpha, from another tab' }),
    ];
    const { stand, client } = sidePanelOn(tab, { answer: () => unavailable('coordinator', 'unavailable', true) });
    try {
      assert.deepEqual((await client.applied())?.kept, ['A', 'A'], 'both stay for the next start');
      assert.equal(stand.handed.length, 1, 'the second never went');
      for (const key of keys) assert.notEqual(tab.env.global.localStorage.getItem(key), null);
    } finally {
      stand.close();
    }
  });

  it("starts the journal's run afresh after the start's run stopped sending, so that run's first command still goes (Q5's b)", async () => {
    const tab = await profile();
    writeDraft(tab);
    await leaveSave(tab);
    const answer = (/** @type {Handed} */ one) =>
      one.commandId === 'draft-a-apply' ? unavailable('coordinator', 'unavailable', true) : undefined;
    const { stand, client } = sidePanelOn(tab, { answer, journal: journalOn(tab), requestIdle: idleNow });
    try {
      assert.deepEqual((await client.applied())?.kept, ['A']);
      assert.equal(await client.whenReady(), null);
      assert.equal((await client.query({ type: 'listNotes', view: 'sidePanel' })).kind, 'ready');
      assert.equal(await until(() => stand.handed.length === 2), true, "the journal's run sent its own");
      assert.deepEqual(
        stand.handed.map(one => one.commandId),
        ['draft-a-apply', 'c-save-apply'],
      );
    } finally {
      stand.close();
    }
  });

  it('loads no send chunk and opens no port on a start with nothing to apply (rule 2, Q1)', async () => {
    const tab = await profile();
    let loads = 0;
    const opened = { count: 0 };
    const send = () => {
      loads += 1;
      return Promise.reject(new Error('nothing to send on this start'));
    };
    const { stand, client } = sidePanelOn(tab, { send, opened });
    try {
      assert.equal(await client.whenReady(), null);
      assert.equal((await client.query({ type: 'listNotes', view: 'sidePanel' })).kind, 'ready');
      await settle();
      assert.deepEqual([loads, opened.count, stand.frames.length], [0, 0, 0]);
    } finally {
      stand.close();
    }
  });
});
