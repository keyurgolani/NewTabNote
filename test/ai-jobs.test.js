'use strict';

// #12 slice 4b2a: the auto-title and insights jobs, the editor's insights and title paths, and
// AI chat's title and insights writes, through the kernel. Each runs while the user keeps
// working, so each test holds the provider call open (a deferred promise from a stub AI port)
// and does something in the meantime. T1 to T5 are plan 4b2.3's.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, settle, waitFor, plain, note, block, makeEditor, startEditorClient, quietNavigation,
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

/** Type into the first block of the loaded note, as onBlockInput does */
function type(editor, text) {
  editor.blocks[0].content = text;
  editor.blocks[0].markUpdated();
  editor.scheduleSave();
}

/** Type a title, as the title element's input event does */
function typeTitle(editor, name) {
  editor.titleEl.textContent = name;
  editor.onTitleChange();
}

/** Run a kernel command the way another part of the page, or another tab, does */
async function execute(env, type, fields) {
  const outcome = await env.kernel.execute({ ...fields, type, commandId: `${type}-${Math.random()}` });
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome;
}

/** Record every write the page's document client is asked for, by method */
function spyWrites(env) {
  const writes = [];
  for (const method of ['saveContent', 'deleteBlocks', 'createNote', 'deriveTitle', 'renameNote', 'attachInsights',
    'setInsightsPending', 'recordJobRun']) {
    const real = env.documentClient[method];
    env.documentClient[method] = (...args) => {
      writes.push(method);
      return real(...args);
    };
  }
  return writes;
}

/** The stored note's fields that differ from `before`, by name */
function changedFields(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

describe('T1: auto-title while the note is edited', () => {
  it('lands the derived title and keeps the typing, the pin, and the folder, and shows it without a save', async () => {
    const { env, Storage } = await setup({
      notes: [note('A', { name: 'Untitled', updatedAt: 1700000000500 }), note('B')],
    });
    const ai = heldAI();
    const editor = editorWith(env, ai.port);
    await drive(env, editor.loadNote('A'));
    const tabs = [{ noteId: 'A', name: 'Untitled' }];
    const manager = notesManager(env, Storage, { ai: ai.port, editor, tabs });
    const job = manager.runAutoTitle();
    await ai.waitFor('generateTitle');

    // While the provider works: the user types, pins the note, and files it
    type(editor, 'Milk, eggs, and bread, and now butter too');
    await drive(env, editor.flushSave());
    await execute(env, 'setPinned', { noteId: 'A', pinned: true });
    const folder = await Storage.createFolder('Errands');
    await Storage.moveNoteToFolder('A', folder.id);

    const writes = spyWrites(env);
    await ai.answer('generateTitle', 'Groceries');
    await drive(env, job);
    await drive(env, editor.flushSave());

    const stored = await Storage.getNote('A');
    assert.deepEqual(
      [stored.name, stored.titleManuallySet, stored.pinned, stored.folderId, stored.preview],
      ['Groceries', false, true, folder.id, 'Milk, eggs, and bread, and now butter too'],
    );
    assert.equal((await Storage.getElementsByNote('A'))[0].content, 'Milk, eggs, and bread, and now butter too');
    assert.equal(typeof stored.lastTitleContentHash, 'string');
    // The editor and the tab show it, and nothing saved the note again for it
    assert.deepEqual([editor.titleEl.textContent, editor.noteData.name, tabs[0].name], ['Groceries', 'Groceries', 'Groceries']);
    assert.deepEqual(writes, ['deriveTitle']);
  });
});

describe('T2: insights while the note is edited', () => {
  it('write the insight fields and nothing else: the title, its flag, the trash, the preview, and updatedAt stay', async () => {
    const { env, Storage } = await setup({ notes: [note('A', { updatedAt: 1700000000500 }), note('B')] });
    const ai = heldAI();
    const editor = editorWith(env, ai.port);
    await drive(env, editor.loadNote('A'));
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.runInsightsExtraction();
    await ai.waitFor('extractInsights');

    // While the provider works: the user names the note and edits it, and it goes to the trash
    typeTitle(editor, 'Shopping');
    type(editor, 'Milk, eggs, and bread for the week, and a cake for Sunday');
    await drive(env, editor.flushSave());
    await execute(env, 'trashNote', { noteId: 'A' });
    const before = plain(await Storage.getNote('A'));
    assert.equal(before.trashed, true);

    await ai.answer('extractInsights', { todos: ['Buy milk'] });
    // B's comes after the job's pause between notes
    await drive(env, ai.answer('extractInsights', null));
    await drive(env, job);

    const after = plain(await Storage.getNote('A'));
    assert.deepEqual(changedFields(before, after), ['insights', 'lastInsightsContentHash', 'lastInsightsExtractedAt']);
    assert.deepEqual(
      [after.name, after.titleManuallySet, after.trashed, after.preview, after.updatedAt],
      ['Shopping', true, true, before.preview, before.updatedAt],
    );
    assert.deepEqual(after.insights, { todos: ['Buy milk'] });
    // The editor shows them on its copy, and its copy keeps what the user typed
    assert.deepEqual(plain(editor.noteData.insights), { todos: ['Buy milk'] });
    assert.equal(editor.noteData.name, 'Shopping');
  });
});

describe('T3: a title set by hand stays', () => {
  it('(i) a derived title over one set by hand meanwhile is kept out: the note, the editor, the tab, and the list stay', async () => {
    const { env, Storage } = await setup({
      notes: [note('A', { name: 'Untitled', updatedAt: 1700000000500 }), note('B')],
    });
    const ai = heldAI();
    const editor = editorWith(env, ai.port);
    await drive(env, editor.loadNote('A'));
    const tabs = [{ noteId: 'A', name: 'Untitled' }];
    const manager = notesManager(env, Storage, { ai: ai.port, editor, tabs });
    const rendered = [];
    manager.onRenderTabs = () => rendered.push('tabs');
    manager.onRenderNotesList = () => rendered.push('list');
    const job = manager.runAutoTitle();
    await ai.waitFor('generateTitle');
    // Another tab names the note
    await execute(env, 'renameNote', { noteId: 'A', name: 'Mine' });

    await ai.answer('generateTitle', 'Groceries');
    await drive(env, job);

    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet], ['Mine', true]);
    assert.deepEqual([editor.titleEl.textContent, tabs[0].name, rendered], ['Untitled', 'Untitled', []]);
  });

  it('(ii) a title typed and not yet saved when the derived one commits wins: it stays on screen and lands after', async () => {
    const { env, Storage } = await setup({
      notes: [note('A', { name: 'Untitled', updatedAt: 1700000000500 }), note('B')],
    });
    const ai = heldAI();
    const editor = editorWith(env, ai.port);
    await drive(env, editor.loadNote('A'));
    const tabs = [{ noteId: 'A', name: 'Untitled' }];
    const manager = notesManager(env, Storage, { ai: ai.port, editor, tabs });
    const job = manager.runAutoTitle();
    await ai.waitFor('generateTitle');
    typeTitle(editor, 'Typed');
    tabs[0].name = 'Typed'; // as the title edit renames its tab

    // The derived title commits while the typed one waits for its debounce
    await ai.answer('generateTitle', 'Groceries');
    await waitFor(async () => (await Storage.getNote('A')).name === 'Groceries', { message: 'the derived title' });
    await settle(10);
    assert.deepEqual([editor.titleEl.textContent, editor.noteData.name, tabs[0].name], ['Typed', 'Typed', 'Typed']);

    await drive(env, job);
    await drive(env, editor.flushSave());
    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet], ['Typed', true]);
  });

  it("(iii) the editor's first-content title, when another tab named the note meanwhile, is kept out and the editor shows the name", async () => {
    const { env, Storage } = await setup({ notes: [note('A', { name: 'Untitled' }), note('B')] });
    await env.chrome.api.storage.local.set({ setting_autoTitleEnabled: true });
    const ai = heldAI();
    const editor = editorWith(env, ai.port);
    await drive(env, editor.loadNote('A'));
    editor.hasReceivedFirstContent = false;
    const check = editor.checkFirstContentAutoTitle();
    await ai.answer('generateTitle', 'Groceries');
    await check;
    // The generated title waits in the save's debounce, and another tab names the note
    assert.deepEqual([editor.titleEl.textContent, editor._unsavedTitle.origin], ['Groceries', 'generated']);
    await execute(env, 'renameNote', { noteId: 'A', name: 'From the other tab' });
    type(editor, 'Milk, eggs, and bread, and butter');
    await drive(env, editor.flushSave());
    await settle(10);

    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet], ['From the other tab', true]);
    assert.equal((await Storage.getElementsByNote('A'))[0].content, 'Milk, eggs, and bread, and butter');
    assert.deepEqual([editor.titleEl.textContent, editor.noteData.name], ['From the other tab', 'From the other tab']);
    const named = editor.navigation.calls.filter(([method]) => method === 'titleChanged').map(([, name]) => name);
    assert.equal(named[named.length - 1], 'From the other tab', 'the tab shows the stored name again');
  });

  it('(iv) a title typed while the first-content title is generated wins, in the one transaction with the blocks', async () => {
    const { env, Storage } = await setup({ notes: [note('A', { name: 'Untitled' }), note('B')] });
    await env.chrome.api.storage.local.set({ setting_autoTitleEnabled: true });
    const ai = heldAI();
    const editor = editorWith(env, ai.port);
    await drive(env, editor.loadNote('A'));
    editor.hasReceivedFirstContent = false;
    const check = editor.checkFirstContentAutoTitle();
    await ai.waitFor('generateTitle');
    typeTitle(editor, 'Typed');
    type(editor, 'Milk, eggs, and bread, and butter');
    const saves = [];
    const real = env.documentClient.saveContent;
    env.documentClient.saveContent = (save) => {
      saves.push({ name: save.name, titleOrigin: save.titleOrigin, blocks: save.blocks.length });
      return real(save);
    };
    await ai.answer('generateTitle', 'Groceries');
    await drive(env, check);
    await drive(env, editor.flushSave());

    assert.deepEqual(saves, [{ name: 'Typed', titleOrigin: 'typed', blocks: 1 }]);
    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet], ['Typed', true]);
    assert.equal(editor.titleEl.textContent, 'Typed');
  });
});

describe('T4: insights write the insight fields only', () => {
  let env;
  let Storage;
  let ai;
  let editor;
  let writes;
  let updates;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    ai = heldAI();
    editor = editorWith(env, ai.port);
    await drive(env, editor.loadNote('A'));
    // The sidebar pins the open note: the editor's copy still says unpinned
    await execute(env, 'setPinned', { noteId: 'A', pinned: true });
    writes = spyWrites(env);
    updates = [];
    for (const method of ['updateNote', 'saveNoteWithBlocks', 'setSetting']) {
      const real = Storage[method].bind(Storage);
      Storage[method] = (...args) => { updates.push(method); return real(...args); };
    }
  });

  /** The note as stored, and what the run asked for */
  async function result() {
    await drive(env, editor.flushSave());
    return { stored: await Storage.getNote('A'), writes, updates };
  }

  it("the editor's Refresh insights keeps a pin made in the sidebar, and writes only attachInsights", async () => {
    const refresh = editor.refreshInsights();
    await ai.answer('extractInsights', { todos: ['Call'] });
    await drive(env, refresh);
    const { stored } = await result();
    assert.deepEqual([stored.pinned, plain(stored.insights)], [true, { todos: ['Call'] }]);
    assert.deepEqual([writes, updates], [['attachInsights'], []]);
  });

  it("AI chat's Extract insights keeps a pin made in the sidebar, and writes only attachInsights", async () => {
    const chat = aiChat(env, Storage, { ai: ai.port, editor });
    chat.getNoteContent = () => LONG_A;
    const job = chat.extractInsightsFromChat();
    await ai.answer('extractInsights', { todos: ['Call'] });
    await drive(env, job);
    const { stored } = await result();
    assert.deepEqual([stored.pinned, plain(stored.insights)], [true, { todos: ['Call'] }]);
    assert.deepEqual([writes, updates], [['attachInsights'], []]);
  });

  it("NotesManager's Extract insights marks, writes, and clears through the kernel, and nothing else", async () => {
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.extractInsightsForNote('A');
    await ai.answer('extractInsights', { todos: ['Call'] });
    await drive(env, job);
    const { stored } = await result();
    assert.deepEqual([stored.pinned, plain(stored.insights)], [true, { todos: ['Call'] }]);
    assert.deepEqual([writes, updates], [['setInsightsPending', 'attachInsights', 'setInsightsPending'], []]);
    // The mark is cleared under 1.4.x's key, so the editor's poller sees it
    assert.equal(await Storage.getSetting('insightsExtracting_A', 'unset'), null);
  });

  it('the insights job writes only attachInsights per note, after its run is recorded', async () => {
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.runInsightsExtraction();
    await ai.answer('extractInsights', { todos: ['Call'] });
    await drive(env, ai.answer('extractInsights', { todos: ['Plan'] }));
    await drive(env, job);
    const { stored } = await result();
    assert.equal(stored.pinned, true);
    assert.deepEqual([writes, updates], [['recordJobRun', 'attachInsights', 'attachInsights'], []]);
    assert.equal(typeof (await Storage.getSetting('lastInsightsRun', 0)), 'number');
  });
});

describe('the editor shows committed titles and insights without saving', () => {
  it("shows a committed title only for the note it holds, and holds a typed title that hasn't saved", async () => {
    const { env } = await setup();
    const editor = editorWith(env, heldAI().port);
    await drive(env, editor.loadNote('A'));
    const writes = spyWrites(env);
    assert.equal(editor.showCommittedTitle('B', 'Elsewhere'), 'not-open');
    assert.equal(editor.showCommittedTitle('A', 'Derived'), 'shown');
    assert.deepEqual([editor.titleEl.textContent, editor.noteData.name], ['Derived', 'Derived']);
    typeTitle(editor, 'Typed');
    assert.equal(editor.showCommittedTitle('A', 'Later'), 'typed-title-pending');
    assert.equal(editor.titleEl.textContent, 'Typed');
    // Only the typed title asked for a save
    await drive(env, editor.flushSave());
    assert.deepEqual(writes, ['saveContent']);
  });

  it('takes only the insight fields onto its copy of the note it holds', async () => {
    const { env } = await setup();
    const editor = editorWith(env, heldAI().port);
    await drive(env, editor.loadNote('A'));
    const record = { id: 'A', name: 'Stale name', pinned: true, insights: { todos: ['x'] }, lastInsightsExtractedAt: 5 };
    assert.equal(editor.showCommittedInsights('B', record), false);
    assert.equal(editor.showCommittedInsights('A', record), true);
    assert.deepEqual(
      [editor.noteData.name, editor.noteData.pinned, plain(editor.noteData.insights), editor.noteData.lastInsightsExtractedAt],
      ['Note A', false, { todos: ['x'] }, 5],
    );
  });
});

describe("the sidebar lists a committed title (review F1, as 4b1's save showed it)", () => {
  /** App's note arrays and the sidebar's, wired to the editor as App.editorNavigation wires them */
  async function appWithSidebar() {
    const { env, Storage } = await setup({
      notes: [note('A', { name: 'Untitled', updatedAt: 1700000000500 }), note('B')],
    });
    env.load('js/core/event-bus.js', 'js/core/dom-refs.js', 'js/core/logger.js', 'js/search.js', 'js/app.js');
    const App = env.get('App');
    const listed = async () => plain(await Storage.getAllNotes());
    const sidebar = { notes: await listed(), archivedNotes: [], renders: 0, renderNotesList() { sidebar.renders += 1; } };
    const page = { notes: await listed(), archivedNotes: [], sidebarController: sidebar, renderNotesList: () => sidebar.renderNotesList() };
    const ai = heldAI();
    const editor = makeEditor(env, env.document, {
      navigation: {
        ...quietNavigation(),
        noteSaved: (saved) => App.prototype.updateSidebarNotePreview.call(page, saved),
      },
    });
    editor.ai = ai.port;
    await drive(env, editor.loadNote('A'));
    return { env, Storage, ai, editor, page, sidebar };
  }

  /** What the sidebar's array says of A, and whether A sorts first by updatedAt */
  function sidebarView(sidebar) {
    const a = sidebar.notes.find((n) => n.id === 'A');
    const newest = [...sidebar.notes].sort((x, y) => y.updatedAt - x.updatedAt)[0];
    return { name: a.name, first: newest.id };
  }

  it('after the auto-title job names the open note', async () => {
    const { env, Storage, ai, editor, page, sidebar } = await appWithSidebar();
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.runAutoTitle();
    await ai.answer('generateTitle', 'Groceries');
    await drive(env, job);
    assert.deepEqual(sidebarView(sidebar), { name: 'Groceries', first: 'A' });
    assert.equal(page.notes.find((n) => n.id === 'A').name, 'Groceries');
    assert.ok(sidebar.renders > 0);
  });

  it("after Generate title and AI chat's confirmed title", async () => {
    const { env, Storage, ai, editor, sidebar } = await appWithSidebar();
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.generateTitleForNote('A');
    await ai.answer('generateTitle', 'Groceries');
    await drive(env, job);
    assert.deepEqual(sidebarView(sidebar), { name: 'Groceries', first: 'A' });

    const chat = aiChat(env, Storage, { ai: ai.port, editor });
    await drive(env, chat.applyGeneratedTitle('Weekly shop', 'A'));
    assert.deepEqual(sidebarView(sidebar), { name: 'Weekly shop', first: 'A' });
  });

  it('not after a title kept out by a hand-set one, which changed nothing', async () => {
    const { env, Storage, ai, editor, sidebar } = await appWithSidebar();
    const manager = notesManager(env, Storage, { ai: ai.port, editor });
    const job = manager.runAutoTitle();
    await ai.waitFor('generateTitle');
    await execute(env, 'renameNote', { noteId: 'A', name: 'Mine' });
    await ai.answer('generateTitle', 'Groceries');
    await drive(env, job);
    assert.equal(sidebar.notes.find((n) => n.id === 'A').name, 'Untitled');
    assert.equal(sidebar.renders, 0);
  });
});

describe('the editor draws insights, with its real render and poller (review F2)', () => {
  const MINUTE = 60 * 1000;
  const INSIGHTS = { todos: ['Call the bakery'], reminders: [], deadlines: [], highlights: [], tags: ['errands'] };

  /** An editor that renders insights with BlockEditor's own methods, not makeEditor's stubs */
  async function realInsightsEditor({ mark, stored = null } = {}) {
    const { env, Storage } = await setup({ notes: [note('A', { insights: stored }), note('B')] });
    if (mark !== undefined) await env.chrome.api.storage.local.set({ setting_insightsExtracting_A: mark });
    const BlockEditor = env.get('BlockEditor');
    const editor = editorWith(env, heldAI().port);
    editor.renderInsights = BlockEditor.prototype.renderInsights;
    editor.startInsightsPollingIfNeeded = BlockEditor.prototype.startInsightsPollingIfNeeded;
    editor.loading = 0;
    editor.showInsightsLoadingInEditor = () => { editor.loading += 1; };
    await drive(env, editor.loadNote('A'));
    return { env, Storage, editor };
  }

  /** The insights section the editor drew, as text, or null */
  const drawn = (editor) => {
    const section = editor.root.querySelector('.note-insights');
    return section ? section.textContent : null;
  };

  it("draws a note's stored insights when it loads", async () => {
    const { editor } = await realInsightsEditor({ stored: INSIGHTS });
    assert.match(drawn(editor), /Call the bakery/);
    assert.match(drawn(editor), /errands/);
    assert.equal(editor.loading, 0);
  });

  it('clears a mark older than 5 minutes and draws the insights; a fresh one shows "Extracting..." and stays', async () => {
    const stale = await realInsightsEditor({ mark: Date.now() - 6 * MINUTE, stored: INSIGHTS });
    assert.equal(await stale.Storage.getSetting('insightsExtracting_A', 'unset'), null, 'cleared under its 1.4.x key');
    assert.match(drawn(stale.editor), /Call the bakery/);
    assert.equal(stale.editor.loading, 0);

    const fresh = await realInsightsEditor({ mark: Date.now() - MINUTE, stored: INSIGHTS });
    assert.equal(fresh.editor.loading, 1);
    assert.equal(drawn(fresh.editor), null);
    assert.equal(typeof (await fresh.Storage.getSetting('insightsExtracting_A', null)), 'number', 'still set');
    assert.ok(fresh.editor.insightsPollingId, 'and it polls');
  });

  it('polls until another tab clears the mark, then draws only the insight fields of what that tab stored', async () => {
    const { env, Storage, editor } = await realInsightsEditor({ mark: Date.now() });
    // Another tab, 1.4.x's or this build's, stores insights and a new name, then clears the mark
    await execute(env, 'attachInsights', { noteId: 'A', insights: INSIGHTS });
    await execute(env, 'renameNote', { noteId: 'A', name: 'Renamed elsewhere' });
    await Storage.setSetting('insightsExtracting_A', null);
    env.clock.tick(2000);
    await waitFor(() => drawn(editor), { message: 'the insights drawn' });
    assert.match(drawn(editor), /Call the bakery/);
    assert.deepEqual([editor.noteData.name, editor.insightsPollingId], ['Note A', null]);
  });

  it('a note switch stops the poller, and the next note gets nothing of the first', async () => {
    const { env, editor } = await realInsightsEditor({ mark: Date.now() });
    assert.ok(editor.insightsPollingId);
    await drive(env, editor.loadNote('B'));
    await execute(env, 'attachInsights', { noteId: 'A', insights: INSIGHTS });
    await env.chrome.api.storage.local.set({ setting_insightsExtracting_A: null });
    env.clock.tick(4000);
    await settle(20);
    assert.deepEqual([editor.noteId, editor.noteData.insights ?? null, drawn(editor)], ['B', null, null]);
  });
});
