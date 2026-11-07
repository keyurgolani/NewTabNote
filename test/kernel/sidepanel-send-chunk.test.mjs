// #35 slice 4c: Side Panel's send chunk (js/kernel/composition/sidepanel-send-chunk.js), on the
// Chrome fake. Its client sends the worker Side Panel's one command, applyCloseDraft, as
// `sidepanel` over the runtime port, and refuses any other operation before it goes. It keeps #13's
// caps, so a close-time draft over 1 MiB never goes (rule 6). Side Panel's root sends through it
// once its writes move.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installRuntimePort } from '../../js/kernel/adapters/messaging/runtime-port.js';
import { hostTimers } from '../../js/kernel/composition/messaging.js';
import { SIDEPANEL_SENDS, sidePanelSender } from '../../js/kernel/composition/sidepanel-send-chunk.js';
import { MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { committed, rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { systemClock } from '../../js/kernel/core/ports/runtime.js';
import { createChromeFake } from './chrome-fake.mjs';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { VERSION } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/router.js').Handler} Handler */

const DRAFT = { type: 'applyCloseDraft', commandId: 'draft-1-apply', ...COMMAND_SAMPLES.applyCloseDraft };

/**
 * A worker whose router serves Side Panel's command and keeps each one it was handed, by its
 * caller's surface, and Side Panel's client to it from a sidepanel.html page
 */
function sidePanelAndWorker() {
  const fake = createChromeFake();
  /** @type {Array<{surface: string, type: unknown}>} */
  const handed = [];
  fake.worker.install(chrome => {
    /** @type {Handler} */
    const serve = (payload, context) => {
      handed.push({ surface: context.caller.surface, type: /** @type {{type?: unknown}} */ (payload).type });
      return context.begin() ? committed('close-draft-saved', ['n1']) : rejected('validation', 'cancelled');
    };
    const router = createRouter({
      lookup: SIDEPANEL_SENDS,
      handlers: { applyCloseDraft: serve },
      policy: createBaselinePolicy(),
      clock: systemClock,
      timers: hostTimers,
      coordinatorId: 'coordinator-1',
      extensionVersion: VERSION,
    });
    installRuntimePort({ runtime: chrome.runtime, router });
  });
  const page = fake.page('sidepanel');
  return { handed, client: sidePanelSender({ runtime: page.chrome.runtime, extensionVersion: VERSION }) };
}

describe("Side Panel's send chunk (composition/sidepanel-send-chunk.js)", () => {
  it("sends the worker a close-time draft's applyCloseDraft, as sidepanel", async () => {
    const { handed, client } = sidePanelAndWorker();
    assert.deepEqual(await client.execute(DRAFT), committed('close-draft-saved', ['n1']));
    assert.deepEqual(handed, [{ surface: 'sidepanel', type: 'applyCloseDraft' }]);
    client.close();
  });

  it("refuses every other operation before it goes, Popup's quick note among them", async () => {
    const { handed, client } = sidePanelAndWorker();
    const made = await client.execute({ type: 'createNote', commandId: 'c1', ...COMMAND_SAMPLES.createNote });
    assert.deepEqual(made, rejected('validation', 'unknown-operation'));
    const listed = await client.query({ type: 'listNotes', view: 'sidePanel' });
    assert.deepEqual([listed.kind, listed.kind === 'failed' && listed.code], ['failed', 'unknown-operation']);
    assert.deepEqual(handed, []);
    client.close();
  });

  it('refuses a close-time draft over 1 MiB as payload-too-large before it goes, so it stays for the new tab (rule 6)', async () => {
    const { handed, client } = sidePanelAndWorker();
    const [block] = COMMAND_SAMPLES.applyCloseDraft.draft.blocks;
    const big = { ...DRAFT, draft: { ...DRAFT.draft, blocks: [{ ...block, content: 'x'.repeat(MAX_MESSAGE_BYTES) }] } };
    assert.deepEqual(await client.execute(big), rejected('validation', 'payload-too-large'));
    assert.deepEqual(handed, []);
    client.close();
  });
});
