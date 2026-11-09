// #35 slice 4b-2: Popup's page side once its writes go to the worker over #13's port (the 4b
// plan's rules 3, 7, 8, 9 and 10, Q9 and Q11). Popup's root reads in the page, on #17's reader, and
// sends its quick note and a closing tab's edit through its send chunk, which it loads as it
// starts. Each command waits for the chunk in order, then for the journal's owner lock, and goes,
// journaled as the catalog says, on the session the worker's router knows the page by, the one its
// journal names, so the drain on a closed port waits on that page alone. A chunk that can't load
// sends nothing. Each of Popup's two runs, the start's apply and the journal's, stops sending once
// the worker didn't take one of its commands, and the quick note never stops (#246). On legacy-env
// profiles, with a stand-in for the worker (popup-worker.mjs). The last part holds the order Popup's
// client sends in once its connection drops (NTN-254).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import { waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import { createPopupClient } from '../../js/kernel/composition/popup.js';
import { popupSender } from '../../js/kernel/composition/popup-send-chunk.js';
import { MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { committed, unavailable } from '../../js/kernel/core/contracts/outcomes.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { DRAFTS_LOCK, DRAFT_PREFIX } from '../../js/kernel/core/domain/close-draft-keys.js';
import { journalEntry, ownerLock } from '../../js/kernel/core/domain/journal.js';
import { legacyContext, legacyEnv } from './legacy-fixture.mjs';
import { settle, testScheduler } from './messaging-support.mjs';
import { popupWorker } from './popup-worker.mjs';
import { newTabTestAdapter, newTabTestClient } from '../helpers/newtab-kernel.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('./popup-worker.mjs').Handed} Handed */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/ports/runtime.js').Timers} Timers */

/**
 * Popup's root, with a host, its drafts, the applier and the send chunk's loader
 * @type {(...args: unknown[]) => ReturnType<typeof createPopupClient>}
 */
const popupClient = /** @type {any} */ (createPopupClient);

/** Q11's wait */
const APPLY_WAIT_MS = 2000;

/** How long Popup's field waits for its writes, at most, before it takes Enter all the same (#242) */
const WRITES_WAIT_MS = 5000;

/** When the closing tabs and the closed pages wrote what they left */
const AT = Date.UTC(2026, 10, 6, 9, 0);

/** @type {(id: string, canvasId: string, order: number, content?: string) => any} */
const block = (id, canvasId, order, content) => legacyEnv.block(id, canvasId, order, content);

/** A profile with note A and its blocks a1 and a2, which a new tab made */
async function profile() {
  const tab = legacyContext();
  const newtab = newTabTestClient(
    newTabTestAdapter({
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
 * Popup on `tab`'s profile, its writes to a stand-in for the worker
 * @param {LegacyContext} tab
 * @param {{status?: any, before?: (handed: Handed) => unknown, answer?: (handed: Handed) => Outcome | undefined, timers?: Timers, locks?: unknown, send?: () => Promise<unknown>}} [options]
 */
function popupOn(tab, { status, before, answer, timers, locks, send } = {}) {
  const stand = popupWorker({
    indexedDB: tab.env.indexedDB,
    settings: tab.env.chrome.api.storage.local,
    status,
    before,
    answer,
  });
  const host = {
    indexedDB: tab.env.indexedDB,
    settings: tab.env.chrome.api.storage.local,
    awaitUpgrade: async () => {},
    runtime: stand.runtime,
    extensionVersion: stand.extensionVersion,
    locks: locks || tab.env.global.navigator.locks,
    ...(timers ? { timers } : {}),
  };
  const drafts = { storage: tab.env.global.localStorage, locks: tab.env.global.navigator.locks };
  return { stand, client: popupClient(host, drafts, undefined, send) };
}

/**
 * The quick note, under ids of its own
 * @param {{ids: {next(): string}}} client
 */
const quickNote = (client, name = 'Quick note') => ({
  type: /** @type {const} */ ('createNote'),
  commandId: client.ids.next(),
  noteId: client.ids.next(),
  name,
});

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
  return {
    v: 1,
    id,
    page,
    noteId: 'A',
    at,
    base: {
      revision: 0,
      updatedAt: null,
      issued: [],
      name: 'Alpha plan',
      blocks: {
        a1: blockDigest(block('a1', 'A', 0, 'alpha'), 'A'),
        a2: blockDigest(block('a2', 'A', 1, 'alpha two'), 'A'),
      },
      issuedSaves: [],
    },
    blocks: [block('a1', 'A', 0, content)],
    deletedBlockIds: [],
    preview: content.slice(0, 80),
    todoProgress: null,
    linkedNames: [],
  };
}

/**
 * A closing tab's edit of A, a1 changed, on the base the tab saw, with `content` for a1, where its
 * closing tab leaves it, and its key
 * @param {LegacyContext} tab
 * @param {string} [content]
 * @param {{id?: string, page?: string, at?: number}} [options]
 */
function writeDraft(tab, content = 'alpha, edited as the tab closed', options = {}) {
  const draft = draftOf({ ...options, content });
  tab.env.global.localStorage.setItem(`${DRAFT_PREFIX}${draft.id}`, JSON.stringify(draft));
  return `${DRAFT_PREFIX}${draft.id}`;
}

/**
 * An editor save of A's a1 that a page journaled and closed before its answer, under `id`, by the
 * page `session`, at `at`
 * @param {LegacyContext} tab
 * @param {{id?: string, session?: string, at?: number}} [options]
 */
async function leaveSave(tab, { id = 'c-save', session = 'page-gone', at = AT } = {}) {
  const content = 'alpha, saved as its page closed';
  const blocks = [{ id: 'a1', type: 'text', content, order: 0 }];
  const command = { type: 'saveNoteContent', commandId: id, noteId: 'A', blocks, deriveFromStored: true };
  /** @type {any} the edit the page journaled with its save */
  const draft = {
    ...draftOf({ id, page: session, at, content }),
    blocks: blocks.map(saved => ({ ...saved, canvasId: 'A' })),
  };
  const writer = inContextStores({ indexedDB: tab.env.indexedDB }).journal();
  await writer.open();
  await writer.put(
    journalEntry({
      command,
      v: 1,
      noteId: 'A',
      surface: 'newtab',
      ownerSessionId: session,
      seq: 1,
      createdAt: at,
      draft,
      pane: 'main',
    }),
  );
  writer.close();
}

/**
 * Whether the drafts' lock is held now, as a run holds it while it applies
 * @param {LegacyContext} tab
 */
const holdsDraftsLock = async tab =>
  ((await tab.env.global.navigator.locks.query()).held || []).some(
    (/** @type {{name?: string}} */ lock) => lock.name === DRAFTS_LOCK,
  );

describe("Popup's writes, over #13's port (#35 slice 4b-2)", () => {
  it('sends the quick note to the worker as popup, journaled until its answer, and it commits there (rule 3)', async () => {
    const tab = await profile();
    let journaled = false;
    const { stand, client } = popupOn(tab, {
      before: async one => {
        journaled = await until(async () => (await journalOf(tab)).some(entry => entry.opId === one.commandId));
      },
    });
    const note = quickNote(client);
    const outcome = await client.execute(note);
    assert.deepEqual(outcome.kind === 'committed' && [outcome.code, outcome.changedIds], [
      'note-created',
      [note.noteId],
    ]);
    assert.deepEqual(
      stand.handed.map(one => [one.surface, one.type, one.commandId]),
      [['popup', 'createNote', note.commandId]],
    );
    assert.equal(journaled, true, 'its entry was in the journal while the worker held it');
    assert.deepEqual(
      (await journalOf(tab)).map(entry => entry.opId),
      [],
      'and went with its answer',
    );
    stand.close();
  });

  it('lists the quick note right after the reply, read in the page (rule 8, #74)', async () => {
    const tab = await profile();
    const { stand, client } = popupOn(tab);
    assert.equal((await client.execute(quickNote(client, 'Read right after'))).kind, 'committed');
    assert.deepEqual(
      stand.handed.map(one => one.type),
      ['createNote'],
      'the worker committed it',
    );
    const listed = await client.query({ type: 'listNotes', view: 'popup' });
    assert.ok(
      listed.kind === 'ready' && listed.data.some(row => row.name === 'Read right after'),
      JSON.stringify(listed),
    );
    stand.close();
  });

  it('sends the quick note on a starting welcome too, which it never reads as a failure (rule 9)', async () => {
    const tab = await profile();
    const { stand, client } = popupOn(tab, { status: () => ({ status: 'degraded', reason: 'starting' }) });
    try {
      const sent = client.execute(quickNote(client));
      assert.equal(
        await until(() => stand.handed.length === 1),
        true,
        'the worker got it while the welcome said starting',
      );
      assert.equal((await sent).kind, 'committed');
      assert.deepEqual(
        stand.handed.map(one => one.type),
        ['createNote'],
      );
    } finally {
      stand.close();
    }
  });

  it("sends a closing tab's edit of 2 MiB to the worker, under the ceiling, and it commits there (#259)", async () => {
    const tab = await profile();
    const key = writeDraft(tab, 'x'.repeat(2 * MAX_MESSAGE_BYTES));
    const { stand, client } = popupOn(tab);
    assert.equal(await client.whenReady(), null);
    assert.deepEqual((await client.applied())?.saved, ['A'], "Popup's start applied it over the port");
    assert.equal(stand.frames.filter(frame => frame.operation === 'applyCloseDraft').length, 1, 'it went on the port');
    assert.equal(tab.env.global.localStorage.getItem(key), null, 'and the draft went');
    stand.close();
  });

  it("waits at most 2 s for the start's apply, then reads what's stored, and applied answers once it's done (Q11)", async () => {
    const tab = await profile();
    writeDraft(tab);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise(resolve => {
      release = resolve;
    });
    const scheduler = testScheduler();
    const { stand, client } = popupOn(tab, {
      timers: scheduler.timers,
      before: one => (one.type === 'applyCloseDraft' ? held : undefined),
    });
    let ready = false;
    client.whenReady().then(() => {
      ready = true;
    });
    assert.ok(await until(() => stand.handed.some(one => one.type === 'applyCloseDraft')), 'the apply sent the edit');
    await scheduler.advance(APPLY_WAIT_MS - 1);
    assert.equal(ready, false, 'it waits for the apply');
    await scheduler.advance(1);
    assert.equal(ready, true, 'for 2 s at most');
    release();
    const applied = await client.applied();
    assert.deepEqual(applied?.saved, ['A']);
    stand.close();
  });

  it("names the journal's owner lock and each entry for the session its hello says, which the worker's drain on a closed port waits on (rule 7)", async () => {
    const tab = await profile();
    const real = tab.env.global.navigator.locks;
    /** @type {string[]} */
    const requested = [];
    const locks = {
      request: (/** @type {string} */ name, /** @type {any} */ options, /** @type {any} */ callback) => {
        requested.push(name);
        return real.request(name, options, callback);
      },
      query: () => real.query(),
    };
    /** @type {unknown[]} */
    let owners = [];
    const { stand, client } = popupOn(tab, {
      locks,
      before: async one => {
        await until(async () => (await journalOf(tab)).some(entry => entry.opId === one.commandId));
        owners = (await journalOf(tab)).map(entry => entry.ownerSessionId);
      },
    });
    assert.equal((await client.execute(quickNote(client))).kind, 'committed');
    const [sent] = stand.handed;
    assert.ok(sent, 'the worker got it');
    assert.ok(requested.includes(ownerLock(sent.sessionId)), requested.join(', '));
    assert.deepEqual(owners, [sent.sessionId]);
    stand.close();
  });

  it('holds each command, in order, until the send chunk is in and its journal holds the owner lock (rule 3)', async () => {
    const tab = await profile();
    /** @type {(value?: unknown) => void} */
    let chunkIn = () => {};
    /** @type {(value: boolean) => void} */
    let lockHeld = () => {};
    const loaded = new Promise(resolve => {
      chunkIn = resolve;
    });
    /** @type {Promise<boolean>} */
    const ready = new Promise(resolve => {
      lockHeld = resolve;
    });
    /** @type {string[]} */
    const went = [];
    const chunk = {
      popupWrites: () => ({
        ready,
        execute: async (/** @type {{commandId: string, noteId: string}} */ command) => {
          went.push(command.commandId);
          return committed('note-created', [command.noteId]);
        },
      }),
    };
    const { stand, client } = popupOn(tab, { send: () => loaded.then(() => chunk) });
    const first = quickNote(client, 'First');
    const second = quickNote(client, 'Second');
    const answers = [client.execute(first), client.execute(second)];
    await settle();
    chunkIn();
    await settle();
    assert.deepEqual(went, [], 'nothing goes before the owner lock');
    const third = quickNote(client, 'Third');
    answers.push(client.execute(third));
    lockHeld(true);
    await Promise.all(answers);
    assert.deepEqual(went, [first.commandId, second.commandId, third.commandId]);
    stand.close();
  });

  it("answers each command unavailable, reload-required, when the send chunk can't load, and sends nothing", async () => {
    const tab = await profile();
    const { stand, client } = popupOn(tab, {
      send: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
    });
    assert.deepEqual(await client.execute(quickNote(client)), unavailable('coordinator', 'reload-required', false));
    assert.deepEqual(stand.frames, []);
    stand.close();
  });
});

describe("When Popup's field takes Enter (#242)", () => {
  it('answers writesReady once the send chunk is in and its journal holds the owner lock, and not before', async () => {
    const tab = await profile();
    /** @type {(value?: unknown) => void} */
    let chunkIn = () => {};
    /** @type {(value: boolean) => void} */
    let lockHeld = () => {};
    const loaded = new Promise(resolve => {
      chunkIn = resolve;
    });
    /** @type {Promise<boolean>} */
    const ready = new Promise(resolve => {
      lockHeld = resolve;
    });
    const chunk = { popupWrites: () => ({ ready, execute: async () => committed('note-created', []) }) };
    // The test's timers, never moved on, so only the writes can answer it
    const scheduler = testScheduler();
    const { stand, client } = popupOn(tab, { timers: scheduler.timers, send: () => loaded.then(() => chunk) });
    const writes = /** @type {any} */ (client);
    let answered = false;
    writes.writesReady().then(() => {
      answered = true;
    });
    await settle();
    assert.equal(answered, false, 'not before the send chunk is in');
    chunkIn();
    await settle();
    assert.equal(answered, false, 'not before its journal holds the owner lock');
    lockHeld(true);
    assert.equal(await until(() => answered), true, 'once both are in');
    stand.close();
  });

  it("answers writesReady after 5 s when the journal's owner lock never comes, and not before, so the field can't stay dead", async () => {
    const tab = await profile();
    const chunk = {
      popupWrites: () => ({ ready: new Promise(() => {}), execute: async () => committed('note-created', []) }),
    };
    const scheduler = testScheduler();
    const { stand, client } = popupOn(tab, { timers: scheduler.timers, send: async () => chunk });
    const writes = /** @type {any} */ (client);
    let answered = false;
    writes.writesReady().then(() => {
      answered = true;
    });
    await settle();
    await scheduler.advance(WRITES_WAIT_MS - 1);
    assert.equal(answered, false, 'it waits for the lock');
    await scheduler.advance(1);
    assert.equal(answered, true, 'for 5 s at most');
    stand.close();
  });
});

describe("Popup's runs stop sending once the worker didn't take one of their commands (#246, Q5's b)", () => {
  /** The worker's answer when it can't take a command */
  const notTaken = () => unavailable('coordinator', 'unavailable', true);

  it("sends no more of the start's run once the worker didn't take one, and answers the rest at once, unsent", async () => {
    const tab = await profile();
    const keys = [
      writeDraft(tab, 'alpha, from a first tab', { id: 'draft-a', page: 'page-1', at: AT }),
      writeDraft(tab, 'alpha, from a second tab', { id: 'draft-b', page: 'page-2', at: AT + 1 }),
      writeDraft(tab, 'alpha, from a third tab', { id: 'draft-c', page: 'page-3', at: AT + 2 }),
    ];
    const { stand, client } = popupOn(tab, { answer: notTaken });
    try {
      assert.deepEqual((await client.applied())?.kept, ['A', 'A', 'A'], 'all three stay for the next start');
      assert.deepEqual(
        stand.handed.map(one => one.commandId),
        ['draft-a-apply'],
        'the other two never went',
      );
      for (const key of keys) assert.notEqual(tab.env.global.localStorage.getItem(key), null);
    } finally {
      stand.close();
    }
  });

  it("sends no more of the journal's run once the worker didn't take one of its saves, and both saves stay", async () => {
    const tab = await profile();
    await leaveSave(tab, { id: 'c-save', session: 'page-gone', at: AT });
    await leaveSave(tab, { id: 'd-save', session: 'page-gone-2', at: AT + 1 });
    const { stand } = popupOn(tab, { answer: notTaken });
    try {
      assert.equal(await until(() => stand.handed.length > 0), true, "the journal's run sent its first save");
      // The run holds the drafts' lock until it's done, so the case's own request waits for its end
      await tab.env.global.navigator.locks.request(DRAFTS_LOCK, { mode: 'exclusive' }, async () => {});
      assert.deepEqual(
        stand.handed.map(one => one.commandId),
        ['c-save-apply'],
        'the second never went',
      );
      assert.deepEqual(
        (await journalOf(tab)).map(entry => entry.opId).sort(),
        ['c-save', 'd-save'],
        'both stay for the next start',
      );
    } finally {
      stand.close();
    }
  });

  it("still sends the quick note once the start's run stopped, since a page's own command never fails fast", async () => {
    const tab = await profile();
    writeDraft(tab);
    const { stand, client } = popupOn(tab, {
      answer: one => (one.type === 'applyCloseDraft' ? notTaken() : undefined),
    });
    try {
      assert.deepEqual((await client.applied())?.kept, ['A'], "the start's run stopped at its edit");
      const note = quickNote(client);
      assert.equal((await client.execute(note)).kind, 'committed', 'the quick note went, and committed');
      assert.deepEqual(
        stand.handed.map(one => [one.type, one.commandId]),
        [
          ['applyCloseDraft', 'draft-a-apply'],
          ['createNote', note.commandId],
        ],
      );
    } finally {
      stand.close();
    }
  });

  it("starts the journal's run afresh after the start's run stopped, so its first save still goes", async () => {
    const tab = await profile();
    writeDraft(tab);
    await leaveSave(tab);
    /** @type {(value?: unknown) => void} */
    let chunkIn = () => {};
    const loaded = new Promise(resolve => {
      chunkIn = resolve;
    });
    const { stand, client } = popupOn(tab, {
      answer: one => (one.commandId === 'draft-a-apply' ? notTaken() : undefined),
      send: () => loaded.then(() => import('../../js/kernel/composition/popup-send-chunk.js')),
    });
    try {
      const applied = client.applied();
      // The start's run takes the drafts' lock before the send chunk is in, so it goes first
      assert.equal(await until(() => holdsDraftsLock(tab)), true, "the start's run holds the drafts' lock");
      chunkIn();
      assert.deepEqual((await applied)?.kept, ['A']);
      assert.equal(await until(() => stand.handed.length === 2), true, "the journal's run sent its own");
      assert.deepEqual(
        stand.handed.map(one => one.commandId),
        ['draft-a-apply', 'c-save-apply'],
      );
    } finally {
      stand.close();
    }
  });
});

/**
 * `runtime`, with each port it opens in the case's hand: drop() ends the last one as a worker that
 * restarts does, so the worker's router and the page's client both hear it go
 * @param {any} runtime - the page's chrome.runtime
 */
function droppable(runtime) {
  /** @type {Array<() => void>} */
  const drops = [];
  return {
    // Only what the page's transport reads of chrome.runtime
    runtime: /** @type {any} */ ({
      get lastError() {
        return runtime.lastError;
      },
      connect(/** @type {unknown} */ info) {
        const port = runtime.connect(info);
        /** @type {Array<(port: unknown) => void>} */
        const gone = [];
        const end = {
          name: port.name,
          onMessage: port.onMessage,
          onDisconnect: { addListener: (/** @type {(port: unknown) => void} */ listener) => gone.push(listener) },
          postMessage: (/** @type {unknown} */ message) => port.postMessage(message),
          disconnect: () => port.disconnect(),
        };
        port.onDisconnect.addListener(() => {
          for (const listener of gone) listener(end);
        });
        drops.push(() => {
          // The page's own disconnect tells only the worker's end, so the page's listeners hear it here
          port.disconnect();
          for (const listener of gone) listener(end);
        });
        return end;
      },
    }),
    /** Ends the port opened last, on both its ends */
    drop: () => drops.at(-1)?.(),
  };
}

/**
 * A save of A that puts `content` in a1, as a closing tab's edit
 * @param {string} commandId
 * @param {string} content
 */
const saveOfA = (commandId, content) => ({
  type: /** @type {const} */ ('applyCloseDraft'),
  commandId,
  draft: {
    v: 1,
    id: `${commandId}-draft`,
    noteId: 'A',
    at: Date.UTC(2026, 10, 7, 14, 0),
    base: { revision: 0 },
    blocks: [block('a1', 'A', 0, content)],
    deletedBlockIds: [],
  },
});

describe("Popup's client once its connection drops (#35 slice 4d's P-0, NTN-254)", () => {
  it("sends a save whose reply was lost again before a later save, so the note keeps the later save's text", async () => {
    const tab = await profile();
    const firstText = 'alpha, as the first save had it';
    const secondText = 'alpha, as the second save has it';
    const older = saveOfA('save-1', firstText);
    const newer = saveOfA('save-2', secondText);
    const texts = new Map([
      [older.commandId, firstText],
      [newer.commandId, secondText],
    ]);
    /** @type {unknown[]} */
    const commits = [];
    let stored = 'alpha';
    let taken = false;
    const stand = popupWorker({
      indexedDB: tab.env.indexedDB,
      settings: tab.env.chrome.api.storage.local,
      // The worker that took the first save never begins it: the connection drops while it holds it
      before: one => {
        if (one.commandId !== older.commandId || taken) return undefined;
        taken = true;
        return new Promise(() => {});
      },
      // Each save lands as an editor's live save does, with no expectedRevision (editor.js), so the
      // last one to commit is what the note holds
      answer: one => {
        stored = /** @type {string} */ (texts.get(/** @type {string} */ (one.commandId)));
        commits.push(one.commandId);
        return committed('close-draft-applied', ['A']);
      },
    });
    const link = droppable(stand.runtime);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise(resolve => {
      release = resolve;
    });
    let reads = 0;
    // The ledger has no record of the first save, and answers only once the case lets it
    const ledger = /** @type {any} */ ({
      read: async () => {
        reads += 1;
        await held;
        return { status: 'absent' };
      },
      status: async () => ({ status: 'absent' }),
    });
    const client = popupSender({ runtime: link.runtime, extensionVersion: stand.extensionVersion, ledger });
    try {
      const first = client.execute(older);
      assert.ok(
        await until(() => stand.handed.some(one => one.commandId === older.commandId)),
        'the worker took the first save',
      );
      link.drop();
      assert.ok(await until(() => reads === 1), 'its reply was lost, and the client reads the ledger for it');
      const second = client.execute(newer);
      assert.ok(await until(() => client.state() === 'connected'), 'the client connected again for the second save');
      await settle();
      await settle();
      release();
      assert.deepEqual([(await first).kind, (await second).kind], ['committed', 'committed']);
      assert.equal(
        stored,
        secondText,
        "the note holds the second save's text, which the first save's resend didn't write over",
      );
      assert.deepEqual(commits, [older.commandId, newer.commandId], 'the first save committed before the second');
    } finally {
      client.close();
      stand.close();
    }
  });
});
