'use strict';

// The note list shows a folder's name as text: the name is set as text, beside the packaged
// icons, so it shows exactly as typed. The sidebar controller draws the list, and App keeps a
// copy of the same tree for a page without the controller.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv } = require('./helpers/legacy-env');

/** Every element under `el`, depth first */
const descendants = el => el.children.flatMap(child => [child, ...descendants(child)]);

test("a folder's name shows as text in the note list", () => {
  const env = createLegacyEnv();
  env.load('js/utils.js', 'js/sidebar-utils.js', 'js/controllers/sidebar-controller.js');
  const sidebar = Object.create(env.get('SidebarController').prototype);
  const name = 'Plans <i>Q3</i> & "more"';
  sidebar.folders = [{ id: 'f1', name, parentId: null, collapsed: false }];
  const list = env.document.createElement('div');
  sidebar.renderFolderTree(list, null, {});
  const names = descendants(list).filter(el => el.classList.contains('folder-name'));
  assert.equal(names.length, 1);
  assert.equal(names[0].textContent, name);
  assert.ok(descendants(list).every(el => !String(el._html || '').includes(name)), 'the name is in no markup');
});

test("App's copy of the folder tree shows a folder's name as text", () => {
  const env = createLegacyEnv();
  env.global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  env.load(
    'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js',
    'js/shortcut-utils.js', 'js/editor.js', 'js/controllers/settings-controller.js', 'js/app.js',
  );
  const app = Object.create(env.get('App').prototype);
  const name = 'Plans <i>Q3</i> & "more"';
  app.folders = [{ id: 'f1', name, parentId: null, collapsed: false }];
  const list = env.document.createElement('div');
  app.renderFolderTree(list, null, {});
  const names = descendants(list).filter(el => el.classList.contains('folder-name'));
  assert.equal(names.length, 1);
  assert.equal(names[0].textContent, name);
  assert.ok(descendants(list).every(el => !String(el._html || '').includes(name)), 'the name is in no markup');
});
