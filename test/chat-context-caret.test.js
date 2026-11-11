'use strict';

// #279: the AI chat's context for a long note centers on the block that held the person's caret,
// #277's remembered block, the one the chat's insert goes after too. The note is over the context's
// 24,000 characters, so the window takes part of it, and each case reads which of its blocks the
// system prompt holds, from the messages the provider would get.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, note, block, makeEditor, startEditorClient, runUntil,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
  'js/controllers/ai-chat-controller.js',
];

/** The block numbers from `from` to `to`, as a person counts them */
const range = (/** @type {number} */ from, /** @type {number} */ to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// 60 text blocks of 500 characters each, 30,000 in all, written top to bottom, so the last ten are
// the most recent edits. Each block's text starts with its number, as [07]
const BLOCKS = range(1, 60).map((n) => block(`n${n}`, 'A', n - 1, `[${String(n).padStart(2, '0')}]${'x'.repeat(496)}`, {
  updatedAt: 1700000000000 + n * 60000,
}));

// What the window sends with no caret, the recent ten and then the note from its start, and with
// the caret in block 45, where that block and the five on each side go in place of blocks 28 to 38
const NO_CARET = [...range(1, 38), ...range(51, 60)];
const CARET_IN_45 = [...range(1, 27), ...range(40, 60)];

describe("the chat's context for a long note centers on the block that held the caret (#279)", () => {
  /**
   * A, the long note, open in its editor, as #277's cases start it, with no frozen 1.4.1 Storage
   * beside it, so the mutant review's copy of the tree, which holds no release files, runs these: an
   * element for each of its blocks in the blocks container, the chat's input and its insert preview
   * beside it, and the chat as App wires it. Focus moves as the browser moves it, and the blocks
   * container's focus and blur listeners (editor.js) hear each move, so no case sets the editor's
   * focused block itself. The load's own focus of the first block has run. `ask` sends a question
   * as the chat's Send does, with the provider's stream stood in for, so nothing leaves.
   */
  async function longNotePage() {
    const env = createLegacyEnv();
    await createDatabase(env.indexedDB, { records: { canvases: [note('A', { name: 'Long note' })], elements: BLOCKS } });
    env.load(...FILES);
    await startEditorClient(env);
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const doc = env.document;
    /** @type {Record<number, any>} */
    const text = {};
    for (const n of range(1, 60)) {
      const row = editor.container.appendChild(doc.createElement('div'));
      row.className = 'block';
      row.setAttribute('data-id', `n${n}`);
      text[n] = row.appendChild(doc.createElement('div'));
      text[n].className = 'block-content';
      text[n].setAttribute('contenteditable', 'true');
    }
    const input = doc.body.appendChild(doc.createElement('textarea'));
    input.id = 'ai-chat-input';
    const modal = doc.body.appendChild(doc.createElement('div'));
    modal.id = 'ai-insert-preview-modal';
    modal.className = 'hidden';
    const confirm = modal.appendChild(doc.createElement('button'));
    confirm.id = 'ai-insert-preview-confirm';
    /** What the blocks container's focus and blur listeners hear as focus moves from `from` to `to` */
    const hear = (/** @type {any} */ from, /** @type {any} */ to) => {
      if (from && from !== to && editor.container.contains(from)) editor.onBlockBlur({ type: 'blur', target: from });
      if (to && from !== to && editor.container.contains(to)) editor.onBlockFocus({ type: 'focus', target: to });
    };
    /** The person moves focus to `element` */
    const focus = (/** @type {any} */ element) => {
      const from = doc.activeElement;
      element.focus();
      hear(from, element);
    };
    /** `ms` pass, and the listeners hear any focus the page moved itself */
    const wait = (/** @type {number} */ ms) => {
      const from = doc.activeElement;
      env.clock.tick(ms);
      hear(from, doc.activeElement);
    };
    // The load focuses the first block 50 ms on
    wait(100);
    const AIChatController = env.get('AIChatController');
    const chat = new AIChatController({
      settings: env.settingsClient,
      eventBus: null,
      domRefs: null,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      llm: { isConfigured: () => true },
      documentClient: env.documentClient,
    });
    /** @type {Array<Array<{role: string, content: string}>>} */
    const asked = [];
    Object.assign(chat, {
      getEditor: () => editor,
      indexing: { noteChanged() {}, loadEmbeddingsModel() {} },
      onOpenNoteInNewTab: async () => {},
      // The provider's stream, stood in for: it keeps the messages it would get and answers nothing
      _streamResponse: async (/** @type {any} */ _container, /** @type {any} */ messages, /** @type {() => void} */ onDone) => {
        asked.push(messages);
        onDone();
        return null;
      },
    });
    /** The person types `question` into the chat's input, which holds the focus, and sends it */
    const ask = (/** @type {string} */ question) => {
      input.value = question;
      return chat.sendAIChatMessage();
    };
    /** The blocks of A the last question's context held, by their numbers, in the order it holds them */
    const sentBlocks = () => [...asked.at(-1)[0].content.matchAll(/\[(\d\d)\]/g)].map((match) => Number(match[1]));
    /** A's stored blocks' text, in note order, read from the database itself */
    const stored = async () =>
      Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements'))
        .filter((row) => row.canvasId === 'A')
        .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1))
        .map((row) => row.content);
    return { env, chat, text, input, confirm, focus, wait, ask, sentBlocks, stored };
  }

  it('centers on the block that held the caret once the caret has left it for the chat, so its neighbours go in place of blocks further on', async () => {
    const { text, input, focus, wait, ask, sentBlocks } = await longNotePage();
    focus(text[45]);
    wait(150);
    // The person types the question in the chat, and the blur's 100 ms pass
    focus(input);
    wait(150);
    await ask('What comes next?');
    assert.deepEqual(sentBlocks(), CARET_IN_45);
  });

  it("ranks as before when the person placed no caret: the load's own focus of the first block doesn't count", async () => {
    const { input, focus, wait, ask, sentBlocks } = await longNotePage();
    focus(input);
    wait(150);
    await ask('What comes next?');
    assert.deepEqual(sentBlocks(), NO_CARET);
  });

  it("puts the answer's insert after the block the context centered on, since both read the caret's one remembered block", async () => {
    const { env, chat, text, input, confirm, focus, wait, ask, sentBlocks, stored } = await longNotePage();
    focus(text[45]);
    wait(150);
    focus(input);
    wait(150);
    await ask('What comes next?');
    assert.deepEqual(sentBlocks(), CARET_IN_45);
    chat.openAIInsertPreview('append', 'From the chat');
    focus(confirm);
    await runUntil(env, chat.confirmAIInsertPreview());
    const texts = await stored();
    assert.equal(texts.indexOf('From the chat'), 45, 'the answer is stored right after block 45');
    assert.ok(texts[44].startsWith('[45]'));
  });
});
