'use strict';

// A sidebar folder's header is its toggle (a 1.4.x fix, #155, ported). It's a button that takes
// focus and says whether the folder is expanded, and Enter or Space toggles it as a click does.
// The toggle shows the folder's new state at once and writes that one field, and when the write
// doesn't commit, the folder shows as stored again. A commit draws the list again, so a folder
// header that had focus has it again in the new list. e2e/sidebar-folders.spec.js checks the same
// on the built extension, with the stylesheet that hides a collapsed folder's notes.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/sidebar-utils.js', 'js/ui/confirm-dialog.js', 'js/controllers/sidebar-controller.js'];

const FOLDERS = [
  { id: 'f1', name: 'Projects', parentId: null, collapsed: false },
  { id: 'f2', name: 'Archive old', parentId: null, collapsed: true },
];

/**
 * The legacy page with the sidebar loaded and its notes list in the page, a sidebar holding
 * `folders` and no notes, and the writes its folder toggles make, each answered `outcome`
 */
function sidebarOn(folders, outcome = { kind: 'committed' }) {
  const doc = new FakeDocument();
  const env = createLegacyEnv({ document: doc });
  env.load(...FILES);
  const SidebarController = env.get('SidebarController');
  const sidebar = new SidebarController({ settings: {}, domRefs: {}, logger: { warn() {} } });
  sidebar.noteList = { folders: () => folders, view: () => [], subscribe: () => () => {}, settled: async () => {} };
  /** @type {Array<[string, boolean]>} */
  const writes = [];
  sidebar.documentClient = {
    setFolderCollapsed: async (id, collapsed) => {
      writes.push([id, collapsed]);
      return outcome;
    },
  };
  const list = doc.body.appendChild(doc.createElement('div'));
  list.id = 'sidebar-notes-list';
  return { doc, sidebar, list, writes };
}

/** The folder `id`'s element and header in `list` */
function folderIn(list, id) {
  const folder = list.querySelectorAll('.sidebar-folder').find((el) => el.dataset.id === id);
  return { folder, header: folder.children.find((el) => el.classList.contains('sidebar-folder-header')) };
}

/** A key pressed at `element`; answers whether something prevented its default */
function press(element, key) {
  const event = { type: 'keydown', key };
  element.dispatchEvent(event);
  return Boolean(event.defaultPrevented);
}

/** Let the toggle's write and settling answer */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("a sidebar folder's header is its toggle", () => {
  it('is a button that takes focus and says whether its folder is expanded', async () => {
    const { sidebar, list } = sidebarOn(FOLDERS);
    await sidebar.renderNotesList();
    for (const [id, expanded] of [['f1', 'true'], ['f2', 'false']]) {
      const { header } = folderIn(list, id);
      assert.equal(header.getAttribute('role'), 'button', id);
      assert.equal(header.tabIndex, 0, id);
      assert.equal(header.getAttribute('aria-expanded'), expanded, id);
    }
  });

  it('Enter and Space toggle it as a click does, and other keys leave it', async () => {
    const { sidebar, list, writes } = sidebarOn(FOLDERS);
    await sidebar.renderNotesList();
    const { header } = folderIn(list, 'f1');
    assert.equal(press(header, 'a'), false);
    assert.equal(press(header, 'Tab'), false);
    assert.deepEqual(writes, []);
    assert.equal(press(header, 'Enter'), true, "Enter is the toggle's, not the page's");
    assert.equal(press(header, ' '), true, 'so is Space, which would scroll the list');
    header.click();
    await settle();
    // Collapsed, expanded, then collapsed again
    assert.deepEqual(writes, [['f1', true], ['f1', false], ['f1', true]]);
  });

  it("shows the new state at once, and the stored one again when the write doesn't commit", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const { sidebar, list, writes } = sidebarOn(FOLDERS, { kind: 'rejected', code: 'test' });
      await sidebar.renderNotesList();
      const { folder, header } = folderIn(list, 'f1');
      press(header, 'Enter');
      assert.deepEqual([folder.classList.contains('collapsed'), header.getAttribute('aria-expanded')], [true, 'false']);
      await settle();
      assert.deepEqual(writes, [['f1', true]]);
      assert.deepEqual([folder.classList.contains('collapsed'), header.getAttribute('aria-expanded')], [false, 'true']);
    } finally {
      console.error = original;
    }
  });

  it('a header with focus has it again once the list is drawn again, and focus elsewhere stays', async () => {
    const { doc, sidebar, list } = sidebarOn(FOLDERS);
    await sidebar.renderNotesList();
    const before = folderIn(list, 'f2').header;
    before.focus();
    await sidebar.renderNotesList();
    const after = folderIn(list, 'f2').header;
    assert.ok(after !== before, 'the list was drawn again');
    assert.ok(doc.activeElement === after, "the folder's new header has focus");

    doc.body.focus();
    await sidebar.renderNotesList();
    assert.ok(doc.activeElement === doc.body, 'focus outside the folders stays where it is');
  });
});
