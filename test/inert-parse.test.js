'use strict';

// Reading a note's stored HTML for its text or its Markdown parses it in a document of its own,
// never the page's: App's, the notes manager's and the AI chat's text readers, and the two
// Markdown readers the export falls back to. The editor's reader is pinned in
// test/editor-picker-text.test.js, and e2e/inert-parse.spec.js checks in Chromium that
// nothing the HTML points to is fetched while it's read.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js',
  'js/shortcut-utils.js', 'js/editor.js', 'js/controllers/settings-controller.js',
  'js/controllers/notes-manager.js', 'js/controllers/ai-chat-controller.js', 'js/app.js',
];

/** Each reader, as [class, method] */
const READERS = [
  ['App', 'stripHtml'], ['App', 'htmlToMarkdown'],
  ['NotesManager', 'stripHtml'], ['NotesManager', 'htmlToMarkdown'],
  ['AIChatController', 'stripHtml'],
];

/** The new tab's scripts on a page whose document records the elements made in it, and the documents made beside it */
function page() {
  const doc = new FakeDocument();
  /** @type {FakeDocument[]} */
  const inert = [];
  doc.implementation = {
    createHTMLDocument: () => {
      const other = new FakeDocument();
      inert.push(other);
      return other;
    },
  };
  const env = createLegacyEnv({ document: doc });
  env.global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  env.load(...FILES);
  const made = [];
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    made.push(tag);
    return create(tag);
  };
  return { env, made, inert };
}

describe("a note's stored HTML is read in a document of its own", () => {
  for (const [owner, reader] of READERS) {
    it(`${owner}.${reader} makes no element in the page's document`, () => {
      const { env, made, inert } = page();
      const target = Object.create(env.get(owner).prototype);
      // The fake document only strips tags, so the words are what's checked here
      const text = target[reader]('<b>Milk</b> and <i>eggs</i><img src="https://images.example.test/a.png">');
      assert.equal(text, 'Milk and eggs');
      assert.deepEqual(made, [], "it made an element in the page's document");
      assert.equal(inert.length, 1, 'it parsed in a document of its own');
      assert.equal(target[reader](''), '');
    });
  }
});
