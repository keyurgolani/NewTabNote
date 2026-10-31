'use strict';

// #14 slice 2, "one way in": every producer of blocks, each through decodeBlock. A block a
// producer builds from its own constants, or from text it parses, decodes as a known block, as
// tested here for each; one built from outside text that doesn't is written by nobody, and its
// producer's failure path and a `block.refused` event say so. A record that comes whole from
// outside (a note's JSON export, a backup) is kept as it is in every state decode reads, by the
// opaque rule. Plain text written into a block's rich content is escaped.
//
// The producers: editor insert and slash; Markdown shortcuts; Turn into; paste; Markdown and
// JSON note import; AI chat's insert and new note; a block's inline AI action; templates, in
// the editor and the kernel; the onboarding note; a block dropped on the sidebar; background
// capture. Sync inbound has no live path, in 1.4.1 or now: SyncService._applyRemoteData skips
// when Storage has no importAll (#17 PR 4b), which the last test holds.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, plain, note, block, runUntil, bootNewTab, NEW_TAB_FILES,
} = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
/** @param {string} file */
const kernelModule = file => import(pathToFileURL(path.join(ROOT, file)).href);

/** The state decode reads a record in, through the new tab's BlockProjections */
const stateOf = (env, record) => env.global.BlockProjections.decodeBlock(plain(record)).state;
const known = state => state === 'current' || state === 'upcast';

/** Seeded strings from `pieces` */
function seeded(pieces, count, seed = 0x14b2) {
  const random = n => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const out = [];
  for (let k = 0; k < count; k++) {
    let text = '';
    for (let j = 1 + random(12); j > 0; j--) text += pieces[random(pieces.length)];
    out.push(text);
  }
  return out;
}

const MARKUP = ['<b>', '</b>', '<img src=x>', '&', '&amp;', '<', '>', '"', "'", 'x', ' ', ' ', '[a](javascript:x)', '[[N]]'];

/** A page with the editor's code, its blocks, and AI response parsing, and no kernel */
function codePage() {
  const env = createLegacyEnv();
  env.load('js/utils.js', 'js/blocks.js', 'js/ai-response-utils.js', 'js/onboarding.js', 'js/editor.js');
  env.global.URL = URL;
  return env;
}

describe('blocks a producer builds decode as known blocks (#14 slice 2)', () => {
  it('editor insert, slash, and add at the end: a new block of every type', () => {
    const env = codePage();
    const editor = Object.create(env.get('BlockEditor').prototype);
    for (const type of Object.keys(env.get('BlockTypes'))) {
      const made = editor.createBlock(type);
      assert.ok(known(stateOf(env, made.serialize())), type);
    }
  });

  it("paste: every block Markdown parsing makes from pasted text, and the paste's own tables, code and bookmarks", () => {
    const env = codePage();
    const { markdownToBlocks } = env.get('AIResponseUtils');
    const pieces = ['# ', '## ', '- ', '* ', '1. ', '> ', '- [x] ', '```', '|a|b|', '$$', '![i](u)', '[t](https://a.test)', '[t](u)', '---', '\n', ...MARKUP];
    for (const text of seeded(pieces, 3000)) {
      for (const parsed of markdownToBlocks(text)) assert.ok(known(stateOf(env, parsed)), JSON.stringify([text, parsed]));
    }
    const editor = Object.create(env.get('BlockEditor').prototype);
    for (const [type, content, options] of [
      ['table', '', { tableData: [['a', 'b'], ['1', '2']], rows: 2, cols: 2 }],
      ['code', '&lt;x&gt;', {}],
      ['bookmark', '', { url: 'https://a.test/', title: 'a.test', description: '' }],
    ]) {
      assert.ok(known(stateOf(env, editor.createBlock(type, content, options).serialize())), type);
    }
  });

  it("the onboarding note's blocks", () => {
    const env = codePage();
    for (const data of env.get('Onboarding').getWelcomeNoteContent()) assert.ok(known(stateOf(env, data)), data.type);
  });

  it("background capture's blocks, for any selection and page", async () => {
    const { captureBlock } = await kernelModule('js/kernel/core/domain/note.js');
    const { decodeBlock } = await kernelModule('js/kernel/core/blocks/index.js');
    for (const text of seeded(MARKUP, 500)) {
      for (const capture of [
        { type: 'text', content: text, source: `https://a.test/?q=${text}` },
        { type: 'text', content: text },
        { type: 'bookmark', url: `https://a.test/${text}`, title: text },
      ]) {
        assert.ok(known(decodeBlock(captureBlock({ id: 'c', noteId: 'n', capture, now: 5 })).state), JSON.stringify(capture));
      }
    }
  });
});

describe('plain text written into rich content is escaped (#14 slice 2, declared)', () => {
  it('capture: the selected text and the page it came from show as they were', async () => {
    const { captureBlock } = await kernelModule('js/kernel/core/domain/note.js');
    const { textContent } = await kernelModule('js/kernel/core/blocks/html-text.js');
    const made = captureBlock({ id: 'c', noteId: 'n', capture: { type: 'text', content: 'a <b>bold</b> & co', source: 'https://a.test/?x=1&para=2' }, now: 5 });
    assert.equal(made.content, 'a &lt;b&gt;bold&lt;/b&gt; &amp; co (Source: https://a.test/?x=1&amp;para=2)');
    assert.equal(textContent(made.content), 'a <b>bold</b> & co (Source: https://a.test/?x=1&para=2)');
    // A page's title and URL are a bookmark's plain-text fields, shown as text, so they stay
    const page = captureBlock({ id: 'c', noteId: 'n', capture: { type: 'bookmark', url: 'https://a.test/?a&b', title: 'A <b> page' }, now: 5 });
    assert.deepEqual([page.url, page.title, page.content], ['https://a.test/?a&b', 'A <b> page', '']);
  });

  it("Markdown shortcuts: what's left of the line is the new block's text", () => {
    // checkMarkdownShortcuts is the editor's, though no event calls it, in 1.4.1 or now: it
    // escapes what it writes for whichever slice wires it
    const env = codePage();
    const BlockEditor = env.get('BlockEditor');
    const Block = env.get('Block');
    const editor = Object.create(BlockEditor.prototype);
    const changed = [];
    editor.changeBlockType = (id, type) => changed.push([id, type]);
    const target = new Block({ id: 'b', type: 'text', content: '' });
    editor.checkMarkdownShortcuts(target, { textContent: '# a <img src=x> & b c' });
    assert.equal(target.content, 'a &lt;img src=x&gt; &amp; b&nbsp;c');
    assert.deepEqual(changed, [['b', 'h1']]);
    assert.ok(known(stateOf(env, { ...target.serialize(), type: 'h1' })));
  });

  it("Turn into: a table's cells become the new type's text, escaped, and the other plain-text types still turn into empty text", () => {
    // Of the types whose fields are plain text, only a table's carry over: 1.4.x's
    // extractBlockTextContent, which the plain-text projection keeps, gives the cells, and an
    // empty string for a bookmark, an equation, a file, a video, or an image, so their fields
    // never reach the new content, before this slice or after it
    const env = codePage();
    const BlockEditor = env.get('BlockEditor');
    const Block = env.get('Block');
    for (const [fields, content] of [
      [{ type: 'table', tableData: [['<b>x</b>', 'a & b']], rows: 1, cols: 2 }, '&lt;b&gt;x&lt;/b&gt; a &amp; b'],
      [{ type: 'bookmark', url: 'https://a.test/?a&b', title: '<i>t</i>' }, ''],
      [{ type: 'equation', equation: 'a < b > c' }, ''],
      [{ type: 'file', fileName: '<x>.txt', fileData: 'data:,' }, ''],
      [{ type: 'video', videoUrl: 'https://a.test/<v>' }, ''],
      [{ type: 'image', imageUrl: 'https://a.test/<i>.png' }, ''],
    ]) {
      const target = new Block({ id: 'b', ...fields });
      const editor = Object.assign(Object.create(BlockEditor.prototype), {
        blocks: [target],
        container: { querySelector: () => null },
        pushUndo() {},
        updateNumberedLists() {},
        scheduleSave() {},
      });
      editor.changeBlockType('b', 'text');
      assert.equal(target.content, content, fields.type);
      assert.ok(known(stateOf(env, target.serialize())), fields.type);
    }
  });

  it("templates in the editor: a value is escaped into rich content, for its text and its attributes, and stays as it is in a table's cells", async () => {
    const env = codePage();
    const BlockEditor = env.get('BlockEditor');
    const Block = env.get('Block');
    const current = new Block({ id: 'b1', type: 'text', content: '/template' });
    const blockEl = { dataset: { id: 'b1' }, querySelector: () => null };
    const editor = Object.assign(Object.create(BlockEditor.prototype), {
      noteId: 'N',
      noteData: { name: 'A <b> & B "q" \'s\'' },
      blocks: [current],
      documentClient: {
        blocksOf: async () => [
          { id: 't1', type: 'text', content: 'For {{title}}' },
          { id: 't2', type: 'table', content: '', tableData: [['{{title}}']], rows: 1, cols: 1 },
          { id: 't3', type: 'text', content: '<a href="https://a.test/{{title}}" title="{{title}}" data-note-name="{{title}}">x</a> <a title=\'{{title}}\'>y</a>' },
        ],
      },
      doc: { defaultView: { getSelection: () => ({ rangeCount: 1, getRangeAt: () => ({ startContainer: { parentElement: { closest: () => blockEl } } }) }) } },
      renderBlocks() {},
      hideTemplateMenu() {},
      scheduleSave() {},
      save() {},
      focusBlock() {},
    });
    await editor.selectTemplateItem('T');
    const [, text, table, linked] = editor.blocks;
    assert.equal(text.content, 'For A &lt;b&gt; &amp; B &quot;q&quot; &#39;s&#39;');
    assert.deepEqual(plain(table.tableData), [['A <b> & B "q" \'s\'']]);
    const asAttribute = 'A &lt;b&gt; &amp; B &quot;q&quot; &#39;s&#39;';
    assert.equal(
      linked.content,
      `<a href="https://a.test/${asAttribute}" title="${asAttribute}" data-note-name="${asAttribute}">x</a> <a title='${asAttribute}'>y</a>`,
    );
    for (const made of [text, table, linked]) assert.ok(known(stateOf(env, made.serialize())), made.type);
  });

  it("templates in the kernel (a new Daily Note's template blocks): the same", async () => {
    const { blocksFromTemplate } = await kernelModule('js/kernel/core/domain/note.js');
    const [text, table, linked] = blocksFromTemplate(
      [
        { id: 't1', type: 'text', content: 'For {{title}}' },
        { id: 't2', type: 'table', content: '', tableData: [['{{title}}']] },
        { id: 't3', type: 'text', content: '<a href="https://a.test/{{title}}" title="{{title}}" data-note-name="{{title}}">x</a> <a title=\'{{title}}\'>y</a>' },
      ],
      { noteId: 'N', title: 'A <b> & B "q" \'s\'', now: 5, nextId: (() => { let n = 0; return () => `n${++n}`; })() },
    );
    assert.equal(text.content, 'For A &lt;b&gt; &amp; B &quot;q&quot; &#39;s&#39;');
    assert.deepEqual(table.tableData, [['A <b> & B "q" \'s\'']]);
    const asAttribute = 'A &lt;b&gt; &amp; B &quot;q&quot; &#39;s&#39;';
    assert.equal(
      linked.content,
      `<a href="https://a.test/${asAttribute}" title="${asAttribute}" data-note-name="${asAttribute}">x</a> <a title='${asAttribute}'>y</a>`,
    );
  });
});

describe('the producers that take outside text, in a new tab (#14 slice 2)', () => {
  /** A new tab with note A open, the sidebar and NotesManager wired as App wires them */
  async function openPage() {
    const env = createLegacyEnv();
    await createDatabase(env.indexedDB, {
      records: { canvases: [note('A', { name: 'Alpha' })], elements: [block('a1', 'A', 0, 'Alpha body')] },
    });
    const page = await bootNewTab(env, { files: [...NEW_TAB_FILES, 'js/ai-response-utils.js', 'js/controllers/ai-chat-controller.js'] });
    env.global.URL = URL;
    await page.tabs.openNoteInNewTab('A');
    env.document.stub(['sidebar-tab-notes', 'sidebar-notes-list']);
    const events = [];
    const logger = { debug() {}, info() {}, warn() {}, error() {}, event: (code, fields) => events.push([code, fields]) };
    const deps = { domRefs: null, logger };
    const sidebar = page.wire(new (env.get('SidebarController'))({ ...deps, settings: env.settingsClient, storageState: env.storageState }));
    const notes = page.wire(new (env.get('NotesManager'))({ ...deps, storage: page.Storage, llm: null }));
    const chat = new (env.get('AIChatController'))({ ...deps, settings: env.settingsClient, llm: { isConfigured: () => false }, documentClient: env.documentClient });
    Object.assign(chat, { getEditor: () => page.tabs.editor, onOpenNoteInNewTab: async () => {} });
    const toasts = [];
    env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
    env.get('Utils').readFileAsText = async file => file.text;
    env.global.console = { ...console, error() {} };
    await sidebar.renderNotesList();
    return { env, page, sidebar, notes, chat, toasts, events };
  }

  const storedBlocks = async env => Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements'));
  const storedNotes = async env => Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases'));

  it('Markdown import: its blocks decode, a link with a refused scheme stays text, and a bookmark needs an absolute http or https URL', async () => {
    const { env, notes, toasts } = await openPage();
    const text = '# Trip\n\nSee [docs](https://a.test) and [x](javascript:alert(1))\n\n[site](https://a.test/page)\n\n[local](page.html)\n';
    await runUntil(env, notes.importNote({ name: 'trip.md', text }));
    const made = (await storedNotes(env)).find(n => n.name === 'Trip');
    const blocks = (await storedBlocks(env)).filter(b => b.canvasId === made.id).sort((a, b) => a.order - b.order);
    assert.deepEqual(plain(blocks.map(({ type, content, url }) => ({ type, content, url }))), [
      { type: 'text', content: 'See <a href="https://a.test">docs</a> and [x](javascript:alert(1))', url: undefined },
      { type: 'bookmark', content: '', url: 'https://a.test/page' },
      { type: 'text', content: '<a href="page.html">local</a>', url: undefined },
    ]);
    for (const made of blocks) assert.ok(known(stateOf(env, made)), made.type);
    assert.deepEqual(plain(toasts), [{ message: 'Note imported', kind: 'success' }]);
  });

  it("Markdown import: a block that wouldn't decode is written by nobody, and the import says it failed", async () => {
    const { env, notes, toasts, events } = await openPage();
    const before = (await storedNotes(env)).length;
    env.get('AIResponseUtils').markdownToBlocks = () => [{ type: 'text', content: 'ok' }, { type: 'gadget', content: 'x' }];
    await runUntil(env, notes.importNote({ name: 'odd.md', text: 'anything' }));
    assert.equal((await storedNotes(env)).length, before);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].kind, 'error');
    assert.match(toasts[0].message, /^Import failed: /);
    assert.deepEqual(plain(events), [['block.refused', { errorCode: 'block-unknown-type' }]]);
  });

  it("JSON note import: every record is kept as the export holds it, in each state decode reads, under the new note's ids", async () => {
    const { env, notes } = await openPage();
    const records = [
      { id: 'x1', canvasId: 'old', type: 'text', content: '<b>kept</b>', order: 0 },
      { id: 'x2', canvasId: 'old', type: 'text', content: 'v1', schemaVersion: 1, order: 1 },
      { id: 'x3', canvasId: 'old', type: 'gadget', content: 'unknown', order: 2 },
      { id: 'x4', canvasId: 'old', type: 'text', content: 'newer', schemaVersion: 7, order: 3 },
      { id: 'x5', canvasId: 'old', type: 'text', content: { not: 'text' }, order: 4 },
      { id: 'x6', canvasId: 'old', type: 'todo', content: 'x', checked: true, extra: { kept: 1 }, order: 5 },
    ];
    assert.deepEqual(records.map(r => stateOf(env, r)), ['upcast', 'current', 'unknown', 'newer', 'invalid', 'upcast']);
    await runUntil(env, notes.importNote({ name: 'plan.json', text: JSON.stringify({ exportType: 'single-note', note: { name: 'Plan' }, blocks: records }) }));
    const made = (await storedNotes(env)).find(n => n.name === 'Plan');
    const blocks = (await storedBlocks(env)).filter(b => b.canvasId === made.id).sort((a, b) => a.order - b.order);
    const strip = ({ id, canvasId, createdAt, updatedAt, ...rest }) => rest;
    assert.deepEqual(plain(blocks.map(strip)), records.map(strip));
  });

  it("AI chat's insert and new note: blocks that don't decode are refused before anything is written", async () => {
    const { env, page, chat, toasts, events } = await openPage();
    page.tabs.editor.activeBlock = 'a1';
    const before = { notes: (await storedNotes(env)).length, blocks: (await storedBlocks(env)).length };
    const reply = [{ type: 'text', content: 'fine' }, { type: 'todo', content: { not: 'text' } }];
    await runUntil(env, chat.appendAIResponseToNote(reply));
    await runUntil(env, chat.createNoteFromAIResponse(reply, 'raw'));
    assert.deepEqual({ notes: (await storedNotes(env)).length, blocks: (await storedBlocks(env)).length }, before);
    assert.deepEqual(plain(toasts), [
      { message: 'Failed to add content', kind: 'error' },
      { message: 'Failed to create note', kind: 'error' },
    ]);
    assert.deepEqual(plain(events), [
      ['block.refused', { errorCode: 'block-invalid-field' }],
      ['block.refused', { errorCode: 'block-invalid-field' }],
    ]);
  });

  it('AI chat: blocks parsed from a reply decode and are written', async () => {
    const { env, page, chat, events } = await openPage();
    page.tabs.editor.activeBlock = 'a1';
    const parsed = env.get('AIResponseUtils').parseAIResponseToBlocks('# T\n\n- [ ] do <b>it</b>\n\n| a | b |\n\n[x](javascript:y)');
    for (const made of parsed) assert.ok(known(stateOf(env, made)), made.type);
    await runUntil(env, chat.appendAIResponseToNote(parsed));
    assert.equal((await storedBlocks(env)).filter(b => b.canvasId === 'A').length, 1 + parsed.length);
    assert.deepEqual(events, []);
  });

  it("a block dropped on the sidebar: its markup goes in through the port, its text alone is escaped, and a type that doesn't decode makes nothing", async () => {
    const { env, sidebar, toasts, events } = await openPage();
    await runUntil(env, sidebar._createNoteFromBlock('Words <i>here</i>', 'text', ''));
    await runUntil(env, sidebar._createNoteFromBlock('Marked', 'text', '<b>Marked</b>'));
    await runUntil(env, sidebar._appendBlockToNote('A', 'text', '', 'a < b'));
    const blocks = await storedBlocks(env);
    const contentOf = name => blocks.find(b => b.canvasId === name)?.content;
    const named = await storedNotes(env);
    assert.equal(contentOf(named.find(n => n.name === 'Words <i>here</i>').id), 'Words &lt;i&gt;here&lt;/i&gt;');
    assert.equal(contentOf(named.find(n => n.name === 'Marked').id), '<b>Marked</b>');
    assert.ok(blocks.some(b => b.canvasId === 'A' && b.content === 'a &lt; b'));
    const count = { notes: named.length, blocks: blocks.length };
    await runUntil(env, sidebar._createNoteFromBlock('Odd', '<script>', '<b>x</b>'));
    await runUntil(env, sidebar._appendBlockToNote('A', 'gadget', '<b>x</b>'));
    assert.deepEqual({ notes: (await storedNotes(env)).length, blocks: (await storedBlocks(env)).length }, count);
    assert.deepEqual(plain(toasts.slice(-2)), [
      { message: 'Failed to create note', kind: 'error' },
      { message: 'Failed to append block', kind: 'error' },
    ]);
    assert.deepEqual(plain(events), [
      ['block.refused', { errorCode: 'block-unknown-type' }],
      ['block.refused', { errorCode: 'block-unknown-type' }],
    ]);
  });

  it("a block dropped on the sidebar keeps its markup only when this page's editor started the drag, and any other drag's markup is stored as text", async () => {
    const { env, page, sidebar } = await openPage();
    const editor = page.tabs.editor;
    editor.getBlockById('a1').content = '<b>Kept</b>';
    /** A drag's data, as a DataTransfer holds it */
    const transfer = (entries = {}) => {
      const data = new Map(Object.entries(entries));
      return { setData: (type, value) => data.set(type, value), getData: type => data.get(type) ?? '', get types() { return [...data.keys()]; } };
    };
    const drop = dataTransfer => runUntil(env, sidebar._onSidebarDrop({ dataTransfer, preventDefault() {}, stopPropagation() {}, target: { closest: () => null } }));
    const contentsOf = async name => {
      const ids = (await storedNotes(env)).filter(n => n.name === name).map(n => n.id);
      return (await storedBlocks(env)).filter(b => ids.includes(b.canvasId)).map(b => b.content);
    };

    // A drag the page's editor started, dropped while it lasts
    const own = transfer();
    const blockEl = { dataset: { id: 'a1' }, classList: { add() {}, remove() {} } };
    editor.onDragStart({ target: { closest: () => blockEl }, dataTransfer: own });
    await drop(own);
    assert.deepEqual(await contentsOf('Kept'), ['<b>Kept</b>']);
    // The same data once that drag has ended
    editor.onDragEnd({});
    await drop(own);
    assert.deepEqual((await contentsOf('Kept')).sort(), ['&lt;b&gt;Kept&lt;/b&gt;', '<b>Kept</b>']);

    // Drags from anywhere else, with or without a token of their own
    const foreign = { 'application/x-block-content': 'Foreign', 'application/x-block-type': 'text', 'application/x-block-html': '<i>Foreign</i> <u>x</u>' };
    await drop(transfer(foreign));
    await drop(transfer({ ...foreign, 'application/x-block-drag-token': 'forged' }));
    assert.deepEqual(await contentsOf('Foreign'), [
      '&lt;i&gt;Foreign&lt;/i&gt; &lt;u&gt;x&lt;/u&gt;',
      '&lt;i&gt;Foreign&lt;/i&gt; &lt;u&gt;x&lt;/u&gt;',
    ]);
    // A drag with text alone is its text, escaped, from anywhere
    await drop(transfer({ 'application/x-block-content': 'a < b', 'application/x-block-type': 'text' }));
    assert.deepEqual(await contentsOf('a < b'), ['a &lt; b']);
  });

  it("an inline AI action: the reply goes into the block as its text, and a block that wouldn't decode keeps its content", async () => {
    const { env, page, events } = await openPage();
    const editor = page.tabs.editor;
    editor.logger = { event: (code, fields) => events.push([code, fields]) };
    const toasts = [];
    env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
    editor.ai = { isConfigured: () => true, chat: async () => '  A <b>bold</b> & <i>new</i> line  ' };
    await runUntil(env, editor.handleInlineAIAction('a1', 'rewrite'));
    const made = editor.getBlockById('a1');
    assert.equal(made.content, 'A &lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;new&lt;/i&gt; line');
    assert.equal(env.get('BlockProjections').plainText(made), 'A <b>bold</b> & <i>new</i> line');
    assert.ok(known(stateOf(env, made.serialize())));

    const kept = made.content;
    made.indentLevel = 'deep';
    await runUntil(env, editor.handleInlineAIAction('a1', 'rewrite'));
    assert.equal(editor.getBlockById('a1').content, kept);
    assert.deepEqual(plain(events), [['block.refused', { errorCode: 'block-invalid-field' }]]);
    assert.deepEqual(plain(toasts), [
      { message: 'Block rewrited', kind: 'success' },
      { message: 'AI rewrite failed', kind: 'error' },
    ]);
  });

  it("paste: Markdown whose blocks wouldn't decode pastes nothing, and says so in an event and a toast", async () => {
    const { env, page, events } = await openPage();
    const editor = page.tabs.editor;
    const toasts = [];
    env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
    editor.logger = { event: (code, fields) => events.push([code, fields]) };
    env.get('AIResponseUtils').markdownToBlocks = () => [{ type: 'gadget', content: 'x' }];
    const before = editor.blocks.length;
    const target = { closest: selector => (selector === '.block' ? { dataset: { id: 'a1' } } : selector === '.block-content' ? {} : null), tagName: 'DIV' };
    const event = {
      target,
      preventDefault() { event.prevented = true; },
      clipboardData: { items: [], getData: () => '# Heading\n\n- item' },
    };
    Object.assign(editor, { _ownsDocumentEvent: () => true, _inTextField: () => false, _inOwnPane: () => true, _overlayOpen: () => false });
    editor.onPaste(event);
    assert.equal(event.prevented, true);
    assert.equal(editor.blocks.length, before);
    assert.deepEqual(plain(events), [['block.refused', { errorCode: 'block-unknown-type' }]]);
    assert.deepEqual(toasts, [{ message: 'Failed to paste content', kind: 'error' }]);
  });
});

describe("the formatting toolbar's link (#14 slice 2, declared)", () => {
  /** The links the toolbar makes for what's typed into its link field */
  const linksFor = urls => {
    const env = createLegacyEnv();
    env.load('js/ui/formatting-toolbar.js');
    const FormattingToolbar = env.get('FormattingToolbar');
    const made = [];
    const toolbar = Object.assign(Object.create(FormattingToolbar.prototype), {
      doc: { execCommand: (command, _, value) => made.push([command, value]) },
      _hideLinkInput() {},
      _restoreRange() {},
      _updateActiveStates() {},
    });
    for (const url of urls) {
      toolbar._linkField = { value: url };
      toolbar._applyLink();
    }
    return made;
  };

  it('links to http, https and mailto, and to a reference with no scheme, as 1.4.x did', () => {
    const urls = ['https://a.test', 'http://a.test', 'mailto:me@a.test', 'example.com', '/page', ' https://a.test '];
    assert.deepEqual(linksFor(urls), urls.map(url => ['createLink', url.trim()]));
  });

  it('makes no link for any other scheme', () => {
    assert.deepEqual(linksFor(['javascript:alert(1)', ' JavaScript:x', 'data:text/html,x', 'java\tscript:x', 'file:///x']), []);
  });
});

describe('sync inbound (#14 slice 2)', () => {
  it('has no live path: the page\'s Storage has no importAll, so applying remote data skips', () => {
    const env = createLegacyEnv();
    env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js');
    assert.equal(typeof env.get('Storage').importAll, 'undefined');
  });
});
