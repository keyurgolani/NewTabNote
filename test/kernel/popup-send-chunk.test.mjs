// #35 slice 4b-2: Popup's send chunk (js/kernel/composition/popup-send-chunk.js), on the Chrome
// fake. Its client sends the worker Popup's two commands as `popup` over the runtime port, and
// refuses any other operation before it goes. It keeps #13's caps, so a close-time draft over
// 1 MiB never goes (rule 10). Its popupWrites starts Popup's journal on the client's session, the
// one the worker's router knows the page by (rule 7). Popup's root sends through it once its writes
// move.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installRuntimePort } from '../../js/kernel/adapters/messaging/runtime-port.js';
import { hostTimers } from '../../js/kernel/composition/messaging.js';
import { POPUP_SENDS, popupSender, popupWrites } from '../../js/kernel/composition/popup-send-chunk.js';
import { MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { committed, rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { ownerLock } from '../../js/kernel/core/domain/journal.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { systemClock } from '../../js/kernel/core/ports/runtime.js';
import { createChromeFake } from './chrome-fake.mjs';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { VERSION } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/router.js').Handler} Handler */

const NOTE = { type: 'createNote', commandId: 'c1', ...COMMAND_SAMPLES.createNote };
const DRAFT = { type: 'applyCloseDraft', commandId: 'draft-1-apply', ...COMMAND_SAMPLES.applyCloseDraft };

/**
 * A worker whose router serves Popup's two commands and keeps each one it was handed, by its
 * caller's surface, and Popup's client to it
 */
function popupAndWorker() {
  const fake = createChromeFake();
  /** @type {Array<{surface: string, type: unknown}>} */
  const handed = [];
  fake.worker.install(chrome => {
    /** @type {(code: string) => Handler} */
    const serve = code => (payload, context) => {
      handed.push({ surface: context.caller.surface, type: /** @type {{type?: unknown}} */ (payload).type });
      return context.begin() ? committed(code, ['n1']) : rejected('validation', 'cancelled');
    };
    const router = createRouter({
      lookup: POPUP_SENDS,
      handlers: { createNote: serve('note-created'), applyCloseDraft: serve('close-draft-saved') },
      policy: createBaselinePolicy(),
      clock: systemClock,
      timers: hostTimers,
      coordinatorId: 'coordinator-1',
      extensionVersion: VERSION,
    });
    installRuntimePort({ runtime: chrome.runtime, router });
  });
  const page = fake.page('popup');
  return { handed, client: popupSender({ runtime: page.chrome.runtime, extensionVersion: VERSION }) };
}

describe("Popup's send chunk (composition/popup-send-chunk.js)", () => {
  it("sends the worker the quick note's createNote and a close-time draft's applyCloseDraft, as popup", async () => {
    const { handed, client } = popupAndWorker();
    assert.deepEqual(await client.execute(NOTE), committed('note-created', ['n1']));
    assert.deepEqual(await client.execute(DRAFT), committed('close-draft-saved', ['n1']));
    assert.deepEqual(handed, [
      { surface: 'popup', type: 'createNote' },
      { surface: 'popup', type: 'applyCloseDraft' },
    ]);
    client.close();
  });

  it('refuses every other operation before it goes', async () => {
    const { handed, client } = popupAndWorker();
    const renamed = await client.execute({ type: 'renameNote', commandId: 'c2', noteId: 'n1', name: 'Renamed' });
    assert.deepEqual(renamed, rejected('validation', 'unknown-operation'));
    const listed = await client.query({ type: 'listNotes', view: 'popup' });
    assert.deepEqual([listed.kind, listed.kind === 'failed' && listed.code], ['failed', 'unknown-operation']);
    assert.deepEqual(handed, []);
    client.close();
  });

  it('refuses a close-time draft over 1 MiB as payload-too-large before it goes, so it stays for a page that applies it in-process (rule 10)', async () => {
    const { handed, client } = popupAndWorker();
    const [block] = COMMAND_SAMPLES.applyCloseDraft.draft.blocks;
    const big = { ...DRAFT, draft: { ...DRAFT.draft, blocks: [{ ...block, content: 'x'.repeat(MAX_MESSAGE_BYTES) }] } };
    assert.deepEqual(await client.execute(big), rejected('validation', 'payload-too-large'));
    assert.deepEqual(handed, []);
    client.close();
  });

  it("starts Popup's journal on its client's session, so the owner lock it holds names the session the client's hello says (popupWrites)", async () => {
    /** @type {string[]} */
    const requested = [];
    const locks = {
      request: (/** @type {string} */ name, /** @type {any} */ options, /** @type {() => Promise<any>} */ held) => {
        requested.push(name);
        return held();
      },
    };
    const writes = popupWrites({
      reads: /** @type {any} */ ({ execute: async () => committed('note-created', ['n1']) }),
      runtime: createChromeFake().page('popup').chrome.runtime,
      extensionVersion: VERSION,
      // A profile with no journal, so its start opens nothing
      indexedDB: /** @type {any} */ ({ databases: async () => [] }),
      locks: /** @type {any} */ (locks),
    });
    assert.equal(await writes.ready, true);
    assert.deepEqual(requested, [ownerLock(writes.client.sessionId)]);
    writes.client.close();
  });
});
