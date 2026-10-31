'use strict';

// Names render as text in the editor's pickers, and stored HTML is never parsed in the page's
// document. The wiki-link picker, the template picker, and the slash menu build each item from
// DOM nodes, with the name set as text, so a name shows exactly as typed. Reading stored HTML
// for its text parsed it in a document of its own (#105); since #14 slice 1 it reads through
// the block projections' tokenizer, with no document at all.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/shortcut-utils.js', 'js/editor.js'];

/** A name with every markup character in it */
const MARKED = 'Q3 <b>plan</b> & "notes" <i class=\'x\'>v2</i>';

/** The legacy page with the editor loaded, and an editor on `doc` with nothing else wired */
function editorOn(doc) {
  const env = createLegacyEnv({ document: doc });
  env.load(...FILES);
  const BlockEditor = env.get('BlockEditor');
  const editor = Object.create(BlockEditor.prototype);
  editor.doc = doc;
  return { env, editor };
}

/** The title elements of the items in `list` */
const titles = (list) => list.querySelectorAll('.slash-menu-item-title');

describe("names render as text in the editor's pickers", () => {
  it('the wiki-link picker shows a note name with markup characters exactly as typed', () => {
    const doc = new FakeDocument();
    const { editor } = editorOn(doc);
    editor.wikiMenuItems = doc.body.appendChild(doc.createElement('div'));
    editor.noteNames = [MARKED, 'Plain'];
    editor.wikiFilter = '';
    editor.wikiMenuIndex = 0;
    editor.renderWikiMenu();
    assert.deepEqual(titles(editor.wikiMenuItems).map((title) => title.textContent), [MARKED, 'Plain']);
    for (const title of titles(editor.wikiMenuItems)) assert.equal(title.children.length, 0, 'a name became elements');
  });

  it('the template picker shows a template name with markup characters exactly as typed', () => {
    const doc = new FakeDocument();
    const { editor } = editorOn(doc);
    editor.templateMenuItems = doc.body.appendChild(doc.createElement('div'));
    editor.templates = [{ id: 't1', name: MARKED }, { id: 't2', name: 'Weekly' }];
    editor.templateFilter = '';
    editor.templateMenuIndex = 0;
    editor.renderTemplateMenu();
    assert.deepEqual(titles(editor.templateMenuItems).map((title) => title.textContent), [MARKED, 'Weekly']);
    for (const title of titles(editor.templateMenuItems)) assert.equal(title.children.length, 0, 'a name became elements');
  });

  it('the slash menu builds its items the same way, with each block type named as text', () => {
    const doc = new FakeDocument();
    const { env, editor } = editorOn(doc);
    editor.slashMenuItems = doc.body.appendChild(doc.createElement('div'));
    editor.buildSlashMenu();
    const BlockTypes = env.get('BlockTypes');
    const shown = titles(editor.slashMenuItems).map((title) => title.textContent);
    assert.equal(shown.length, 18);
    assert.equal(shown[0], BlockTypes.text.name);
    const descriptions = editor.slashMenuItems.querySelectorAll('.slash-menu-item-desc').map((desc) => desc.textContent);
    assert.equal(descriptions[0], BlockTypes.text.description);
  });
});

describe('stored HTML is never parsed in the page', () => {
  it("reading stored HTML for its text makes no element in the page's document, nor a document of its own", () => {
    const doc = new FakeDocument();
    const made = [];
    const create = doc.createElement.bind(doc);
    doc.createElement = (tag) => {
      made.push(tag);
      return create(tag);
    };
    /** @type {FakeDocument[]} */
    const inert = [];
    doc.implementation = {
      createHTMLDocument: () => {
        const other = new FakeDocument();
        inert.push(other);
        return other;
      },
    };
    const { editor } = editorOn(doc);
    made.length = 0;
    assert.equal(editor.extractBlockTextContent({ type: 'text', content: '<b>Milk</b> and <i>eggs</i>' }), 'Milk and eggs');
    assert.deepEqual(made, [], "it made an element in the page's document");
    assert.equal(inert.length, 0, 'it made a document: the block projections read markup with a tokenizer (#14)');
    assert.equal(editor.extractBlockTextContent({ type: 'text', content: '' }), '');
  });
});
