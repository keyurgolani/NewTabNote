'use strict';

// The note menu opens at the pointer and stays inside the window (a 1.4.x defect #27 slice 1
// made common: with the indexer, sidebar items carry a preview line, so more notes sit low in
// the list). It used to clamp its top to innerHeight - 200 when it's about 314 px tall, so a low
// note's last items, Move to Trash among them, opened below the window. Now each site measures
// the menu first, opens it above the pointer when it doesn't fit below, and keeps 8 px from
// every edge. The folder menus, which opened at the pointer's page position unclamped, are
// placed the same way. Utils.menuPosition is the arithmetic, and Utils.placeMenu measures and shows.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv } = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
const VIEWPORT = { width: 1440, height: 900 };
// The note menu's size on the new tab, about what Chromium lays it out at
const MENU = { width: 180, height: 314 };
const MARGIN = 8;

/** Whether a menu at `position` of `size` is inside `viewport` with MARGIN to spare */
function inside(position, size, viewport) {
  return position.left >= MARGIN && position.top >= MARGIN
    && position.left + size.width <= viewport.width - MARGIN
    && position.top + size.height <= viewport.height - MARGIN;
}

/**
 * A stand-in for the new tab's note menu and its buttons: enough of an element for
 * showNoteContextMenu, which clones the select button, toggles classes, and sets styles. The
 * menu lays out at `size` once it's shown, hidden only by visibility, and 0 by 0 while
 * display: none (its `hidden` class), as a browser would.
 */
function menuDocument(size) {
  const ids = [...fs.readFileSync(path.join(ROOT, 'newtab.html'), 'utf8').matchAll(/id="(ctx-[a-z-]+)"/g)].map((match) => match[1]);
  const element = (id) => {
    const classes = new Set();
    const node = {
      id,
      style: {},
      textContent: '',
      innerHTML: '',
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle: (name, force) => ((force === undefined ? !classes.has(name) : force) ? classes.add(name) : classes.delete(name)),
        contains: (name) => classes.has(name),
      },
      addEventListener() {},
      cloneNode: () => element(id),
      parentNode: { replaceChild: (fresh) => { elements.set(id, fresh); } },
    };
    return node;
  };
  const elements = new Map(ids.map((id) => [id, element(id)]));
  const menu = element('note-context-menu');
  menu.classList.add('hidden');
  menu.getBoundingClientRect = () => {
    if (menu.classList.contains('hidden')) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const left = parseFloat(menu.style.left) || 0;
    const top = parseFloat(menu.style.top) || 0;
    return { left, top, right: left + size.width, bottom: top + size.height, width: size.width, height: size.height };
  };
  elements.set('note-context-menu', menu);
  return { menu, getElementById: (id) => elements.get(id) || null };
}

/** The legacy page with `files` loaded, in a window of VIEWPORT, its document `doc` */
function page(doc, files) {
  const env = createLegacyEnv({ document: /** @type {any} */ (doc) });
  env.load('js/utils.js', ...files);
  env.global.innerWidth = VIEWPORT.width;
  env.global.innerHeight = VIEWPORT.height;
  return env;
}

const pointer = (clientX, clientY) => ({ clientX, clientY, preventDefault() {}, stopPropagation() {} });

describe('Utils.menuPosition', () => {
  const utils = page(menuDocument(MENU), []).get('Utils');
  // A plain object of this realm, for deepEqual
  const place = (...args) => ({ ...utils.menuPosition(...args) });

  it('opens at the pointer when the menu fits there', () => {
    assert.deepEqual(place(200, 150, MENU, VIEWPORT), { left: 200, top: 150 });
  });

  it('opens above the pointer near the bottom', () => {
    const position = place(200, 850, MENU, VIEWPORT);
    assert.deepEqual(position, { left: 200, top: 850 - MENU.height });
    assert.ok(inside(position, MENU, VIEWPORT));
  });

  it('comes in from the right edge near it', () => {
    const position = place(1430, 150, MENU, VIEWPORT);
    assert.deepEqual(position, { left: VIEWPORT.width - MENU.width - MARGIN, top: 150 });
    assert.ok(inside(position, MENU, VIEWPORT));
  });

  it('stays inside a window shorter than the space it needs below and above the pointer', () => {
    const short = { width: 1440, height: 400 };
    const position = place(200, 200, MENU, short);
    assert.ok(inside(position, MENU, short), JSON.stringify(position));
    // Taller than the window: its top stays in view, so its first items can be clicked
    const tiny = { width: 1440, height: 300 };
    assert.equal(place(200, 200, MENU, tiny).top, MARGIN);
  });

  it('keeps the margin at the top left corner', () => {
    assert.deepEqual(place(2, 3, MENU, VIEWPORT), { left: MARGIN, top: MARGIN });
  });
});

// The sidebar's sites are the menus' only ones: App's copies, used only without a sidebar
// controller, went with the rest of its unreachable code in #12 slice 7a
describe("the note menu's site places it after measuring it", () => {
  for (const { site, files, open } of [
    {
      site: 'SidebarController.showNoteContextMenu',
      files: ['js/controllers/sidebar-controller.js'],
      open: (env, event) => {
        const SidebarController = env.get('SidebarController');
        const sidebar = new SidebarController({ settings: {}, domRefs: {}, logger: { warn() {} } });
        sidebar._noteList = { view: () => [{ id: 'N', pinned: false }] };
        sidebar.showNoteContextMenu(event, 'N', 'notes');
      },
    },
  ]) {
    it(`${site}: a low note's menu opens above the pointer, all of it in the window`, () => {
      const doc = menuDocument(MENU);
      const env = page(doc, files);
      open(env, pointer(240, 860));
      const { menu } = doc;
      assert.equal(menu.classList.contains('hidden'), false, 'the menu is shown');
      assert.notEqual(menu.style.visibility, 'hidden', 'the menu is visible');
      const position = { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) };
      assert.ok(inside(position, MENU, VIEWPORT), JSON.stringify(position));
      assert.equal(position.top, 860 - MENU.height);
    });

    it(`${site}: near the right edge, it comes in from it`, () => {
      const doc = menuDocument(MENU);
      const env = page(doc, files);
      open(env, pointer(1435, 120));
      const position = { left: parseFloat(doc.menu.style.left), top: parseFloat(doc.menu.style.top) };
      assert.ok(inside(position, MENU, VIEWPORT), JSON.stringify(position));
    });
  }

  it('no menu guesses its size with innerHeight or innerWidth minus a constant', () => {
    for (const file of ['js/app.js', 'js/controllers/sidebar-controller.js']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.equal(/inner(Height|Width)\s*-\s*\d/.test(source), false, file);
    }
  });
});

// The folder menu's size, four items
const FOLDER_MENU = { width: 160, height: 150 };

/**
 * A document for the folder menu, which each site builds and appends to the body: the menu
 * lays out at `size` where its style puts it, once it's in the body
 */
function folderDocument(size) {
  const element = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      style: {},
      className: '',
      innerHTML: '',
      children: [],
      classList: { add() {}, remove() {}, contains: () => false },
      appendChild(child) { node.children.push(child); return child; },
      addEventListener() {},
      contains: (other) => other === node,
      getBoundingClientRect() {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        return { left, top, right: left + size.width, bottom: top + size.height, width: size.width, height: size.height };
      },
    };
    return node;
  };
  const appended = [];
  return {
    appended,
    createElement: element,
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    body: {
      appendChild: (child) => { appended.push(child); return child; },
      removeChild: (child) => { appended.splice(appended.indexOf(child), 1); },
      contains: (child) => appended.includes(child),
    },
  };
}

describe("the folder menu's site places it after measuring it", () => {
  for (const { site, files, open } of [
    {
      site: 'SidebarController.showFolderContextMenu',
      files: ['js/controllers/sidebar-controller.js'],
      open: (env, event) => {
        const SidebarController = env.get('SidebarController');
        const sidebar = new SidebarController({ settings: {}, domRefs: {}, logger: { warn() {} } });
        return sidebar.showFolderContextMenu(event, { id: 'F', name: 'Folder' });
      },
    },
  ]) {
    it(`${site}: a low folder's menu opens above the pointer, and one near the right edge comes in from it`, async () => {
      for (const [x, y] of [[240, 860], [1435, 120]]) {
        const doc = folderDocument(FOLDER_MENU);
        const env = page(doc, files);
        // pageX and pageY as on a page scrolled by 400 px, which a fixed menu mustn't follow
        await open(env, { ...pointer(x, y), pageX: x, pageY: y + 400 });
        const [menu] = doc.appended;
        assert.ok(menu, 'the menu is in the page');
        assert.notEqual(menu.style.visibility, 'hidden', 'the menu is visible');
        const position = { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) };
        assert.ok(inside(position, FOLDER_MENU, VIEWPORT), `${x}, ${y}: ${JSON.stringify(position)}`);
        if (y === 860) assert.equal(position.top, 860 - FOLDER_MENU.height);
      }
    });
  }
});
