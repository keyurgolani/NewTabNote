'use strict';

// A block's AI action (rewrite, expand, summarize, translate) puts the model's reply into the
// block as text: the reply is plain text, escaped into the block's rich content, so it shows as
// the model wrote it. A reply with no markup characters is stored as before, trimmed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, makeEditor } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/shortcut-utils.js', 'js/editor.js'];

/** Run `action` on a text block, with a model that replies `reply`; returns the block and what the model was sent */
async function runAction(action, reply) {
  const env = createLegacyEnv();
  env.load(...FILES);
  await env.get('Storage').init();
  const editor = makeEditor(env);
  const Block = env.get('Block');
  editor.noteId = 'n1';
  editor.noteData = { id: 'n1', name: 'Draft' };
  editor.blocks = [new Block({ id: 'b1', type: 'text', content: 'Some <b>rough</b> words', canvasId: 'n1', order: 0 })];
  editor.scheduleSave = () => {};
  const sent = [];
  editor.getLLM = () => ({
    isConfigured: () => true,
    chat: async (messages) => {
      sent.push(messages);
      return reply;
    },
  });
  await editor.handleInlineAIAction('b1', action);
  return { block: editor.blocks[0], sent, editor };
}

describe("a block's AI action puts the reply in as text", () => {
  it("a reply with markup characters shows as the model wrote it", async () => {
    const { block } = await runAction('rewrite', 'Clearer <b>words</b> & "more"\n');
    assert.equal(block.content, 'Clearer &lt;b&gt;words&lt;/b&gt; &amp; "more"');
  });

  it('a plain-text reply is stored as before, trimmed', async () => {
    for (const action of ['rewrite', 'expand', 'summarize', 'translate']) {
      const { block, sent } = await runAction(action, '  A clearer sentence.\n');
      assert.equal(block.content, 'A clearer sentence.', action);
      assert.equal(sent.length, 1, action);
    }
  });

  it('undo goes back to the block as it was', async () => {
    const { editor } = await runAction('rewrite', 'Clearer <b>words</b>');
    const entry = editor.undoStack[editor.undoStack.length - 1];
    assert.equal(entry.before.content, 'Some <b>rough</b> words');
    assert.equal(entry.after.content, 'Clearer &lt;b&gt;words&lt;/b&gt;');
  });
});
