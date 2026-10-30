'use strict';

// #12 slice 4b2a: the auto-title and insights jobs, the editor's insights and title paths, and
// AI chat's title and insights writes, through the kernel. Each runs while the user keeps
// working, so each test holds the provider call open (a deferred promise from a stub AI port)
// and does something in the meantime. T1 to T5 are plan 4b2.3's.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, settle, waitFor, plain, note, block, makeEditor, startEditorClient,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
  'js/controllers/notes-manager.js',
  'js/controllers/ai-chat-controller.js',
];

/** A promise and the functions that settle it */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A stub AI port whose calls wait until the test answers them. `calls` records each call as
 * [method, ...args], and `answer(method, value)` settles the oldest one waiting.
 */
function heldAI() {
  const calls = [];
  const waiting = [];
  const hold = (method) => (...args) => {
    calls.push([method, ...args]);
    const call = deferred();
    waiting.push({ method, call });
    return call.promise;
  };
  return {
    calls,
    port: {
      isConfigured: () => true,
      generateTitle: hold('generateTitle'),
      extractInsights: hold('extractInsights'),
      chat: hold('chat'),
    },
    /** Wait for a call of `method` to be waiting, then answer it with `value` */
    async answer(method, value) {
      const found = await waitFor(() => waiting.find((entry) => entry.method === method), { message: `a ${method} call` });
      waiting.splice(waiting.indexOf(found), 1);
      found.call.resolve(value);
    },
    /** Wait until a call of `method` is waiting */
    waitFor: (method) => waitFor(() => waiting.some((entry) => entry.method === method), { message: `a ${method} call` }),
  };
}

const LONG_A = 'Milk, eggs, and bread for the week, and the bakery on Sunday morning';
const LONG_B = 'Quarterly review notes: revenue up, hiring paused until the spring';

async function setup({ notes = [note('A'), note('B')], elements } = {}) {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: notes,
      elements: elements || [block('a1', 'A', 0, LONG_A), block('b1', 'B', 0, LONG_B)],
    },
  });
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  await startEditorClient(env);
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
  return { env, Storage, toasts };
}

/**
 * Keep the page's frames, timers, and promises moving until `promise` settles, as a visible
 * page does: the jobs wait a second between notes, and saves wait for a frame.
 */
async function drive(env, promise) {
  let finished = false;
  const tracked = Promise.resolve(promise).finally(() => { finished = true; });
  for (let i = 0; i < 600 && !finished; i++) {
    env.frames();
    env.clock.tick(500);
    await settle(2);
  }
  return tracked;
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * NotesManager as App wires it, with the editor as the one getEditor answers, and the open
 * tabs as `tabs`
 */
function notesManager(env, Storage, { ai, editor, tabs = [] }) {
  const NotesManager = env.get('NotesManager');
  const manager = new NotesManager({
    storage: Storage,
    eventBus: null,
    domRefs: null,
    logger: quietLogger,
    llm: ai,
    documentClient: env.documentClient,
  });
  Object.assign(manager, {
    getEditor: () => editor,
    getOpenTabs: () => tabs,
    onRenderTabs: () => {},
    onSaveTabs: async () => {},
    onRenderNotesList: () => {},
  });
  return manager;
}

/** AIChatController as App wires it, with its chat log reduced to a list */
function aiChat(env, Storage, { ai, editor, tabs = [] }) {
  const AIChatController = env.get('AIChatController');
  const chat = new AIChatController({
    storage: Storage,
    eventBus: null,
    domRefs: null,
    logger: quietLogger,
    llm: ai,
    documentClient: env.documentClient,
  });
  chat.messages = [];
  Object.assign(chat, {
    getEditor: () => editor,
    onGetOpenTabs: () => tabs,
    onRenderTabs: () => {},
    onSaveTabs: async () => {},
    onRenderNotesList: async () => {},
    addChatMessage: (content, type) => chat.messages.push({ content, type }),
  });
  return chat;
}

/** An editor with the stub AI port, as App's editorPorts give it */
function editorWith(env, ai) {
  const editor = makeEditor(env);
  editor.ai = ai;
  return editor;
}

/** What the editor shows and holds for its note */
function editorView(editor) {
  return {
    noteId: editor.noteId,
    recordId: editor.noteData && editor.noteData.id,
    name: editor.noteData && editor.noteData.name,
    insights: editor.noteData ? plain(editor.noteData.insights ?? null) : undefined,
    title: editor.titleEl.textContent,
  };
}

describe('T5: switching notes while the provider answers (found by reading 1.4.x)', () => {
  let env;
  let Storage;
  let ai;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup({ notes: [note('A', { name: 'Untitled' }), note('B')] }));
    ai = heldAI();
    editor = editorWith(env, ai.port);
    await drive(env, editor.loadNote('A'));
  });

  /** Switch the editor to B while the provider call runs, then answer it */
  async function switchThenAnswer(method, value) {
    await ai.waitFor(method);
    await drive(env, editor.loadNote('B'));
    await ai.answer(method, value);
  }

  /** B as the editor showed it after the switch, and as stored */
  async function assertBUntouched() {
    await drive(env, editor.flushSave());
    assert.deepEqual(editorView(editor), {
      noteId: 'B', recordId: 'B', name: 'Note B', insights: null, title: 'Note B',
    });
    const stored = await Storage.getNote('B');
    assert.deepEqual([stored.name, stored.insights ?? null, stored.titleManuallySet], ['Note B', null, false]);
  }

  it("NotesManager's Generate title puts the title on the note it was asked for", async () => {
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.generateTitleForNote('A');
    await switchThenAnswer('generateTitle', 'Groceries');
    await drive(env, job);
    await assertBUntouched();
    assert.equal((await Storage.getNote('A')).name, 'Groceries');
  });

  it("NotesManager's Extract insights puts them on the note it was asked for", async () => {
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.extractInsightsForNote('A');
    await switchThenAnswer('extractInsights', { todos: ['Buy milk'] });
    await drive(env, job);
    await assertBUntouched();
    assert.deepEqual(plain((await Storage.getNote('A')).insights), { todos: ['Buy milk'] });
  });

  it('the auto-title job puts the title on the note it read', async () => {
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.runAutoTitle();
    await switchThenAnswer('generateTitle', 'Groceries');
    await drive(env, job);
    await assertBUntouched();
    assert.equal((await Storage.getNote('A')).name, 'Groceries');
  });

  it("the editor's Refresh insights puts them on the note it was showing", async () => {
    const refresh = editor.refreshInsights();
    await switchThenAnswer('extractInsights', { todos: ['Buy milk'] });
    await drive(env, refresh);
    await assertBUntouched();
    assert.deepEqual(plain((await Storage.getNote('A')).insights), { todos: ['Buy milk'] });
  });

  it("the editor's first-content title goes to the note that got the content", async () => {
    await env.chrome.api.storage.local.set({ setting_autoTitleEnabled: true });
    // A note that was empty gets its first words
    editor.hasReceivedFirstContent = false;
    const check = editor.checkFirstContentAutoTitle();
    await switchThenAnswer('generateTitle', 'Groceries');
    await drive(env, check);
    await assertBUntouched();
    assert.equal((await Storage.getNote('A')).name, 'Groceries');
  });

  it("AI chat's Extract insights puts them on the note the chat read", async () => {
    const chat = aiChat(env, Storage, { ai: ai.port, editor });
    chat.getNoteContent = () => LONG_A;
    const job = chat.extractInsightsFromChat();
    await switchThenAnswer('extractInsights', { todos: ['Buy milk'] });
    await drive(env, job);
    await assertBUntouched();
    assert.deepEqual(plain((await Storage.getNote('A')).insights), { todos: ['Buy milk'] });
  });

  it("AI chat's generated title goes to the note the chat was about, after its confirm", async () => {
    const chat = aiChat(env, Storage, { ai: ai.port, editor });
    const confirm = deferred();
    env.global.confirmDialog = () => confirm.promise;
    // The chat answered about A; the user switches to B before confirming
    const job = chat.handleGeneratedTitle('Groceries', 'A');
    await drive(env, editor.loadNote('B'));
    confirm.resolve(true);
    await drive(env, job);
    // 1.4.x applied it without waiting
    await drive(env, settle(40));
    await assertBUntouched();
    await waitFor(async () => (await Storage.getNote('A')).name === 'Groceries', { message: 'the title on A' });
  });
});
