'use strict';

// The sidebar's folder names render as text. Each folder's row is built from DOM nodes, with its
// name set as text, so a name shows exactly as typed, markup characters and all. The folder
// menu's Rename and Delete Folder dialogs carry the name the same way: their message is set as
// text and the default value as the field's value (js/ui/confirm-dialog.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/sidebar-utils.js', 'js/ui/confirm-dialog.js', 'js/controllers/sidebar-controller.js'];

/** A name with every markup character in it */
const MARKED = 'Q3 <b>plan</b> & "notes" <i class=\'x\'>v2</i>';

/** The legacy page with the sidebar loaded, and a sidebar holding `folders` */
function sidebarOn(doc, folders) {
  const env = createLegacyEnv({ document: doc });
  env.load(...FILES);
  const SidebarController = env.get('SidebarController');
  const sidebar = new SidebarController({ settings: {}, domRefs: {}, logger: { warn() {} } });
  // A note list with only these folders and no notes
  sidebar.noteList = { folders: () => folders, view: () => [], subscribe: () => () => {} };
  return { env, sidebar };
}

/** The names the folder rows under `container` show, in order */
const shownNames = (container) => container.querySelectorAll('.folder-name');

const pointer = { clientX: 10, clientY: 10, pageX: 10, pageY: 10, preventDefault() {}, stopPropagation() {} };

describe("the sidebar's folder names render as text", () => {
  it("shows a folder's name exactly as typed, markup characters included, nested folders too", () => {
    const doc = new FakeDocument();
    const { sidebar } = sidebarOn(doc, [
      { id: 'f1', name: MARKED, parentId: null, collapsed: false },
      { id: 'f2', name: 'Ideas <draft> & more', parentId: 'f1', collapsed: false },
      { id: 'f3', name: 'Plain', parentId: null, collapsed: true },
    ]);
    const container = doc.body.appendChild(doc.createElement('div'));
    sidebar.renderFolderTree(container, null, {});
    const names = shownNames(container);
    assert.deepEqual(names.map((name) => name.textContent), [MARKED, 'Ideas <draft> & more', 'Plain']);
    for (const name of names) assert.equal(name.children.length, 0, 'a name became elements');
    // The name follows the row's icons, which stay packaged markup
    const header = container.querySelector('.sidebar-folder-header');
    assert.ok(header.children[header.children.length - 1] === names[0], "the name is the row's last child");
  });

  it("carries the name as typed into Rename's field and Delete Folder's message", async () => {
    const doc = new FakeDocument();
    const { sidebar } = sidebarOn(doc, [{ id: 'f1', name: MARKED, parentId: null, collapsed: false }]);
    sidebar.documentClient = {
      renameFolder: async () => ({ kind: 'committed' }),
      deleteFolder: async () => ({ kind: 'committed' }),
    };

    await sidebar.showFolderContextMenu(pointer, sidebar.folders[0]);
    const item = (label) => doc.body.querySelectorAll('.context-menu-item').find((el) => el.textContent === label);
    item('Rename').click();
    const input = doc.body.querySelector('.confirm-dialog-input');
    assert.ok(input, 'the rename dialog is open');
    assert.equal(input.value, MARKED);
    doc.body.querySelector('.confirm-dialog-cancel').click();

    await sidebar.showFolderContextMenu(pointer, sidebar.folders[0]);
    item('Delete Folder').click();
    const message = doc.body.querySelector('.confirm-dialog-message');
    assert.ok(message, 'the delete dialog is open');
    assert.equal(message.textContent, `Are you sure you want to delete "${MARKED}"? Notes inside will be moved to root.`);
    assert.equal(message.children.length, 0, 'the name became elements');
    doc.body.querySelector('.confirm-dialog-cancel').click();
  });
});
