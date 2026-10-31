'use strict';

// The note menu opens at the pointer and stays inside the window (a 1.4.x defect #27 slice 1
// made common: with the indexer, sidebar items carry a preview line, so more notes sit low in
// the list). It used to clamp its top to innerHeight - 200 when it's about 314 px tall, so a low
// note's last items, Move to Trash among them, opened below the window. Now each site measures
// the menu first, opens it above the pointer when it doesn't fit below, and keeps 8 px from
// every edge. The folder menus, which opened at the pointer's page position unclamped, are
// placed the same way. Utils.menuPosition is the arithmetic, and Utils.placeMenu measures and shows.
//
// The editor's menus follow (#95's review): the slash, link, and template menus, a block's
// menu and its Turn into, the Turn into for blocks selected together, and a table's menu.
// Each opens beside what it opens from (Utils.menuBeside, and Utils.submenuBeside for a
// block's Turn into), or at the pointer for the table's,
// flips to the other side when it doesn't fit, is pulled in from an edge otherwise, and is
// placed in the task that shows it, measured hidden first, never a frame later. A window
// shorter than a menu gets one that scrolls (css/editor.css).
//
// #102's review: a menu with room on neither side of what it opens from goes on the roomier
// side, capped to that room, and scrolls there instead of covering it. The link and template
// menus, placed again each time they draw, keep the side they're on while it fits, so the list
// changing as you type doesn't move them across the caret, and keep the highlighted item in
// view as the arrow keys move it. The slash, link, and template menus are no wider than the
// window, for a narrow picture-in-picture one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

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

  it('keeps the margin at the bottom when the pointer is in it', () => {
    const position = place(200, 896, MENU, VIEWPORT);
    assert.deepEqual(position, { left: 200, top: 892 - MENU.height });
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

// ─── The editor's menus ───

describe('Utils.menuBeside', () => {
  const utils = page(menuDocument(MENU), []).get('Utils');
  const beside = (...args) => ({ ...utils.menuBeside(...args) });
  const SLASH = { width: 280, height: 320 };
  const SUBMENU = { width: 180, height: 360 };
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

  it('opens below what it opens from, left edges lined up, when it fits there', () => {
    assert.deepEqual(beside(rect(300, 200, 600, 230), SLASH, VIEWPORT), { left: 300, top: 234 });
    assert.deepEqual(beside(rect(300, 200, 600, 230), SLASH, VIEWPORT, { gap: 0 }), { left: 300, top: 230 });
  });

  it('opens above it near the bottom, and comes in from the right edge near it', () => {
    const position = beside(rect(1300, 820, 1420, 850), SLASH, VIEWPORT);
    assert.deepEqual(position, { left: VIEWPORT.width - SLASH.width - MARGIN, top: 820 - 4 - SLASH.height });
    assert.ok(inside(position, SLASH, VIEWPORT));
  });

  it('above, it opens above when it fits there and below when only that fits, and in a window too short for either keeps its top in it, capped to the room over the bar', () => {
    assert.deepEqual(beside(rect(600, 836, 690, 864), SUBMENU, VIEWPORT, { above: true, gap: 8 }), { left: 600, top: 836 - 8 - SUBMENU.height });
    assert.deepEqual(beside(rect(600, 100, 690, 128), SUBMENU, VIEWPORT, { above: true, gap: 8 }), { left: 600, top: 128 + 8 });
    const short = { width: 1440, height: 300 };
    assert.deepEqual(beside(rect(600, 236, 690, 264), SUBMENU, short, { above: true, gap: 8 }), { left: 600, top: MARGIN, maxHeight: 236 - 8 - MARGIN });
  });

  it('with room for all of it on neither side, it goes on the roomier one, capped to that room, not over what it opens from', () => {
    const narrow = { width: 360, height: 640 };
    // A block in the middle of a 360 by 640 window: 298 px under it and 268 over it for a 320 px menu
    const under = beside(rect(24, 280, 336, 330), SLASH, narrow);
    assert.deepEqual(under, { left: 24, top: 330 + 4, maxHeight: 640 - MARGIN - (330 + 4) });
    // A little lower, over it has more
    const over = beside(rect(24, 330, 336, 360), SLASH, narrow);
    assert.deepEqual(over, { left: 24, top: MARGIN, maxHeight: 330 - 4 - MARGIN });
    for (const { top, maxHeight } of [under, over]) {
      assert.ok(top >= MARGIN && top + maxHeight <= narrow.height - MARGIN, 'inside the window');
    }
    assert.ok(over.top + over.maxHeight <= 330 - 4, 'clear of the block');
  });

  it('with no room on either side, as from a block that fills the window, it is pulled in from the edge, over it', () => {
    const narrow = { width: 360, height: 640 };
    assert.deepEqual(beside(rect(24, 0, 336, 640), SLASH, narrow), { left: 24, top: 640 - SLASH.height - MARGIN });
  });
});

describe('Utils.submenuBeside', () => {
  const utils = page(menuDocument(MENU), []).get('Utils');
  const beside = (...args) => ({ ...utils.submenuBeside(...args) });
  const SUBMENU = { width: 180, height: 360 };
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

  it('opens past its item, tops lined up, flips before it near the right edge, comes in from that edge when neither side fits, and moves up near the bottom', () => {
    assert.deepEqual(beside(rect(400, 300, 560, 332), SUBMENU, VIEWPORT), { left: 564, top: 300 });
    assert.deepEqual(beside(rect(1262, 646, 1426, 678), SUBMENU, VIEWPORT), { left: 1262 - 4 - SUBMENU.width, top: VIEWPORT.height - SUBMENU.height - MARGIN });
    const narrow = { width: 360, height: 640 };
    const position = beside(rect(14, 360, 178, 392), SUBMENU, narrow);
    assert.deepEqual(position, { left: narrow.width - SUBMENU.width - MARGIN, top: narrow.height - SUBMENU.height - MARGIN });
    assert.ok(inside(position, SUBMENU, narrow));
  });
});

/**
 * Give `element` a layout: in the page and not display: none (its `hidden` class), it lays out
 * at `sizeOf(element)`, no taller than its style's max-height, where its style's left and top
 * put it, moved up by its height under translateY(-100%), as a browser would. Hidden only by
 * visibility, it still has its size.
 */
function laidOut(element, sizeOf) {
  element.getBoundingClientRect = () => {
    const shown = element.isConnected && !element.classList.contains('hidden');
    const natural = shown ? sizeOf(element) : { width: 0, height: 0 };
    const cap = parseFloat(element.style.maxHeight);
    const width = natural.width;
    const height = Number.isNaN(cap) ? natural.height : Math.min(natural.height, cap);
    const left = parseFloat(element.style.left) || 0;
    const top = (parseFloat(element.style.top) || 0) - (/translateY\(-100%\)/.test(element.style.transform || '') ? height : 0);
    return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
  };
  return element;
}

describe("Utils.placeMenu measures in the menu's own window", () => {
  it("places a menu in the picture-in-picture editor's window, not the page's", () => {
    const env = page(menuDocument(MENU), []);
    const Utils = env.get('Utils');
    // The picture-in-picture window is 500 by 600; the page behind it is VIEWPORT
    const pip = new FakeDocument();
    pip.defaultView = { innerWidth: 500, innerHeight: 600 };
    const menu = laidOut(pip.body.appendChild(pip.createElement('div')), () => MENU);
    Utils.placeMenu(menu, 450, 580);
    const position = { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) };
    assert.deepEqual(position, { left: 500 - MENU.width - MARGIN, top: 580 - MENU.height });
    assert.ok(inside(position, MENU, { width: 500, height: 600 }));
  });
});

// About what Chromium lays each editor menu out at
const EDITOR_MENUS = {
  slash: { width: 280, height: 320 },
  link: { width: 280, height: 268 },
  template: { width: 280, height: 150 },
  block: { width: 172, height: 196 },
  turnInto: { width: 180, height: 360 },
  table: { width: 180, height: 262 },
};

/** Each editor menu's size, by its class (the link and template menus are slash menus too) */
function editorMenuSize(element) {
  const is = (name) => element.classList.contains(name);
  if (is('wiki-menu') || element.id === 'wiki-menu') return EDITOR_MENUS.link;
  if (is('template-menu') || element.id === 'template-menu') return EDITOR_MENUS.template;
  if (is('slash-menu')) return EDITOR_MENUS.slash;
  if (is('block-action-menu')) return EDITOR_MENUS.block;
  if (is('turn-into-menu')) return EDITOR_MENUS.turnInto;
  if (is('table-context-menu')) return EDITOR_MENUS.table;
  return { width: 0, height: 0 };
}

/**
 * The new tab's left pane as newtab.html has it, with its slash, link, and template menus, and
 * a real editor on it, in a window of `viewport`. Every element lays out (laidOut), so the
 * menus the editor makes have their size once they're in the page, and `scrolls` lists each
 * element scrolled into view, with its options.
 */
function editorPage(viewport) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.load('js/utils.js', 'js/blocks.js', 'js/editor.js');
  env.global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  // The window, as the page's scripts read it and as the editor's document does
  for (const view of [env.global, env.window]) Object.assign(view, { innerWidth: viewport.width, innerHeight: viewport.height });
  const doc = env.document;
  const make = doc.createElement.bind(doc);
  const scrolls = [];
  doc.createElement = (tag) => Object.assign(laidOut(make(tag), editorMenuSize), {
    scrollIntoView(options) { scrolls.push({ element: this, options }); },
  });
  const add = (parent, attributes) => {
    const element = parent.appendChild(doc.createElement('div'));
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'class') element.className = value; else element.setAttribute(name, value);
    }
    return element;
  };
  const pane = add(doc.body, { id: 'editor-container', class: 'editor-pane active' });
  const column = add(pane, { class: 'editor' });
  add(column, { class: 'page-title', contenteditable: 'true' });
  add(column, { class: 'blocks-container' });
  for (const attributes of [{ id: 'slash-menu', class: 'slash-menu hidden' }, { id: 'wiki-menu', class: 'slash-menu hidden' }, { id: 'template-menu', class: 'slash-menu hidden' }]) {
    add(add(column, attributes), { class: 'slash-menu-items' });
  }
  const editor = new (env.get('BlockEditor'))({ root: pane });
  /** An element in the pane at `rect`, as what a menu opens from */
  const at = (rect, dataset = {}) => {
    const element = add(column, {});
    Object.assign(element.dataset, dataset);
    element.getBoundingClientRect = () => ({ width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, ...rect });
    return element;
  };
  return { env, doc, editor, at, scrolls };
}

const placed = (menu) => ({ left: parseFloat(menu.style.left), top: menu.getBoundingClientRect().top });

/**
 * The anchors each menu opens from: low and to the right in a 1440 by 900 window, and low in a
 * 360 by 640 one, and where each menu goes from them
 */
const WINDOWS = [
  {
    viewport: { width: 1440, height: 900 },
    block: { left: 1300, top: 820, right: 1420, bottom: 850 },
    caret: { left: 1400, top: 828, right: 1400, bottom: 848 },
    handle: { left: 1290, top: 840, right: 1314, bottom: 864 },
    turnIntoItem: { left: 1262, top: 646, right: 1426, bottom: 678 },
    button: { left: 1300, top: 836, right: 1390, bottom: 864 },
    pointer: [1430, 890],
    expected: {
      slash: { left: 1152, top: 820 - 4 - 320 },
      link: { left: 1152, top: 828 - 268 },
      template: { left: 1152, top: 820 - 150 },
      block: { left: 1440 - 172 - 8, top: 840 - 4 - 196 },
      turnInto: { left: 1262 - 4 - 180, top: 900 - 360 - 8 },
      selection: { left: 1440 - 180 - 8, top: 836 - 8 - 360 },
      table: { left: 1440 - 180 - 8, top: 890 - 262 },
    },
  },
  {
    viewport: { width: 360, height: 640 },
    block: { left: 24, top: 560, right: 336, bottom: 590 },
    caret: { left: 300, top: 566, right: 300, bottom: 586 },
    handle: { left: -4, top: 563, right: 20, bottom: 587 },
    turnIntoItem: { left: 14, top: 360, right: 178, bottom: 392 },
    button: { left: 300, top: 584, right: 390, bottom: 612 },
    pointer: [350, 630],
    expected: {
      slash: { left: 24, top: 560 - 4 - 320 },
      link: { left: 360 - 280 - 8, top: 566 - 268 },
      template: { left: 24, top: 560 - 150 },
      block: { left: 8, top: 563 - 4 - 196 },
      turnInto: { left: 360 - 180 - 8, top: 640 - 360 - 8 },
      selection: { left: 360 - 180 - 8, top: 584 - 8 - 360 },
      table: { left: 360 - 180 - 8, top: 630 - 262 },
    },
  },
];

/** A text block and a table block, as the editor holds them */
const TEXT_BLOCK = { id: 'B', type: 'text', content: 'eggs' };
const TABLE_BLOCK = { id: 'T', type: 'table', content: '', tableData: [['a', 'b'], ['1', '2']], rows: 2, cols: 2 };

/** Each editor menu: how it opens from its anchor in `place` (an entry of WINDOWS), and the menu it shows */
const EDITOR_SITES = [
  {
    menu: 'the slash menu',
    key: 'slash',
    open: ({ editor, at }, place) => {
      editor.showSlashMenu(at(place.block));
      return editor.slashMenu;
    },
  },
  {
    menu: 'the link menu',
    key: 'link',
    open: ({ env, editor, at }, place) => {
      const caret = { ...place.caret, width: 0, height: place.caret.bottom - place.caret.top };
      env.window.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ getBoundingClientRect: () => caret }) });
      editor.noteNames = ['Alpha', 'Beta', 'Gamma'];
      editor.showWikiMenu(at(place.block));
      return editor.wikiMenu;
    },
  },
  {
    menu: 'the template menu',
    key: 'template',
    open: ({ editor, at }, place) => {
      editor.templates = [{ id: 'W', name: 'Weekly plan' }];
      editor.showTemplateMenu(at(place.block));
      return editor.templateMenu;
    },
  },
  {
    menu: "a block's menu",
    key: 'block',
    open: ({ doc, editor, at }, place) => {
      editor.blocks = [TEXT_BLOCK];
      editor.showBlockActionMenu('B', at(place.handle));
      return doc.querySelector('.block-action-menu');
    },
  },
  {
    menu: "Turn into, from a block's menu",
    key: 'turnInto',
    open: ({ doc, editor, at }, place) => {
      editor.blocks = [TEXT_BLOCK];
      editor.showTurnIntoSubmenu('B', at(place.turnIntoItem));
      return doc.querySelector('.turn-into-menu');
    },
  },
  {
    menu: 'Turn into, for blocks selected together',
    key: 'selection',
    open: ({ doc, editor, at }, place) => {
      editor.selectedBlockIds = new Set(['B', 'C']);
      editor.showSelectionTurnIntoMenu(at(place.button));
      return doc.querySelector('.turn-into-menu');
    },
  },
  {
    menu: "a table's menu",
    key: 'table',
    open: ({ doc, editor, at }, place) => {
      editor.showTableContextMenu(TABLE_BLOCK, at(place.block, { row: '1', col: '1' }), ...place.pointer);
      return doc.querySelector('.table-context-menu');
    },
  },
];

describe("each editor menu's site places it inside the window, in the task that shows it", () => {
  for (const site of EDITOR_SITES) {
    for (const place of WINDOWS) {
      const { viewport } = place;
      it(`${site.menu}, opened low in a ${viewport.width} by ${viewport.height} window, opens there, inside it`, () => {
        const editorDom = editorPage(viewport);
        const menu = site.open(editorDom, place);
        assert.ok(menu, 'the menu is in the page');
        assert.equal(menu.classList.contains('hidden'), false, 'the menu is shown');
        assert.notEqual(menu.style.visibility, 'hidden', 'the menu is visible');
        const size = editorMenuSize(menu);
        const position = placed(menu);
        assert.deepEqual(position, place.expected[site.key]);
        assert.ok(inside(position, size, viewport), JSON.stringify(position));
        // Placed as it showed, so no frame after moves it
        editorDom.env.frames();
        assert.deepEqual(placed(menu), position, 'no frame moves it');
      });
    }
  }

  it('Turn into for blocks selected together keeps its top in a window too short for it, capped to the room over the bar', () => {
    const viewport = { width: 1440, height: 300 };
    const editorDom = editorPage(viewport);
    const menu = EDITOR_SITES.find((site) => site.key === 'selection').open(editorDom, { button: { left: 600, top: 236, right: 690, bottom: 264 } });
    assert.deepEqual(placed(menu), { left: 600, top: MARGIN });
    assert.equal(menu.style.maxHeight, `${236 - 8 - MARGIN}px`);
  });

  it('the slash menu from a block in the middle of a 360 by 640 window opens under it, capped to the room there, not over the block', () => {
    const editorDom = editorPage({ width: 360, height: 640 });
    const block = { left: 24, top: 280, right: 336, bottom: 330 };
    const menu = EDITOR_SITES.find((site) => site.key === 'slash').open(editorDom, { block });
    assert.deepEqual(placed(menu), { left: 24, top: block.bottom + 4 });
    assert.equal(menu.style.maxHeight, `${640 - MARGIN - (block.bottom + 4)}px`);
    assert.equal(menu.getBoundingClientRect().bottom, 640 - MARGIN);
  });

  it('a menu capped once opens at its full height where it has the room', () => {
    const editorDom = editorPage({ width: 360, height: 640 });
    const slash = EDITOR_SITES.find((site) => site.key === 'slash');
    const menu = slash.open(editorDom, { block: { left: 24, top: 280, right: 336, bottom: 330 } });
    editorDom.editor.hideSlashMenu();
    slash.open(editorDom, { block: { left: 24, top: 40, right: 336, bottom: 70 } });
    assert.deepEqual(placed(menu), { left: 24, top: 74 });
    assert.equal(menu.style.maxHeight, '');
    assert.equal(menu.getBoundingClientRect().height, EDITOR_MENUS.slash.height);
  });

  it('the link menu opens from its block when the caret has no box of its own', () => {
    const place = WINDOWS[0];
    const editorDom = editorPage(place.viewport);
    const empty = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    editorDom.env.window.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ getBoundingClientRect: () => empty }) });
    editorDom.editor.noteNames = ['Alpha'];
    editorDom.editor.showWikiMenu(editorDom.at(place.block));
    assert.deepEqual(placed(editorDom.editor.wikiMenu), { left: 1152, top: place.block.top - EDITOR_MENUS.link.height });
  });

  it('the link menu is placed again each time it draws, so a shorter list keeps its bottom at the caret', () => {
    const place = WINDOWS[0];
    const editorDom = editorPage(place.viewport);
    EDITOR_SITES.find((site) => site.key === 'link').open(editorDom, place);
    const { wikiMenu } = editorDom.editor;
    const bottom = placed(wikiMenu).top + EDITOR_MENUS.link.height;
    // Typing narrows the list to one name
    const shorter = { width: 280, height: 74 };
    laidOut(wikiMenu, () => shorter);
    editorDom.editor.wikiFilter = 'Al';
    editorDom.editor.renderWikiMenu();
    assert.equal(placed(wikiMenu).top + shorter.height, bottom);
  });

  /** A link or template menu's size by what it lists: its header, then 56 px a row, up to its 320 px cap */
  const listSize = (menu) => ({ width: 280, height: Math.min(320, 35 + 56 * menu.querySelectorAll('.slash-menu-item').length) });
  const READINGS = Array.from({ length: 10 }, (_, i) => `Reading ${i + 1}`);
  const WEEKLIES = Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, name: `Weekly ${i + 1}` }));

  it('the link menu keeps the side it opened on while typing changes its list, so it does not jump across the caret', () => {
    const editorDom = editorPage(VIEWPORT);
    const { env, editor } = editorDom;
    // The caret at 600-620 in a 1440 by 900 window: ten names (320 px) don't fit under it, so
    // the menu opens over it
    const caret = { left: 600, top: 600, right: 600, bottom: 620, width: 0, height: 20 };
    env.window.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ getBoundingClientRect: () => caret }) });
    laidOut(editor.wikiMenu, listSize);
    editor.noteNames = READINGS;
    editor.showWikiMenu(editorDom.at({ left: 560, top: 596, right: 1260, bottom: 624 }));
    const tops = [placed(editor.wikiMenu).top];
    // "Reading 1" leaves two names (147 px), which would fit under the caret too
    for (const filter of ['Reading 1', 'Reading']) {
      editor.wikiFilter = filter;
      editor.renderWikiMenu();
      tops.push(placed(editor.wikiMenu).top);
    }
    assert.deepEqual(tops, [280, 453, 280]);
  });

  it('the template menu keeps the side it opened on while its list changes', () => {
    const editorDom = editorPage(VIEWPORT);
    const { editor } = editorDom;
    laidOut(editor.templateMenu, listSize);
    editor.templates = WEEKLIES;
    editor.showTemplateMenu(editorDom.at({ left: 560, top: 600, right: 1260, bottom: 620 }));
    const tops = [placed(editor.templateMenu).top];
    editor.templateFilter = 'Weekly 1';
    editor.renderTemplateMenu();
    tops.push(placed(editor.templateMenu).top);
    assert.deepEqual(tops, [600 - 320, 600 - 147]);
  });

  it('the arrow keys keep the highlighted name or template in view as they move it', () => {
    for (const { menu, open, items } of [
      { menu: 'the link menu', open: (editor, block) => { editor.noteNames = READINGS; editor.showWikiMenu(block); }, items: (editor) => editor.wikiMenuItems },
      { menu: 'the template menu', open: (editor, block) => { editor.templates = WEEKLIES; editor.showTemplateMenu(block); }, items: (editor) => editor.templateMenuItems },
    ]) {
      const editorDom = editorPage(VIEWPORT);
      const { env, editor, scrolls } = editorDom;
      const caret = { left: 600, top: 300, right: 600, bottom: 320, width: 0, height: 20 };
      env.window.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ getBoundingClientRect: () => caret }) });
      editor.blocks = [TEXT_BLOCK];
      const block = editorDom.at({ left: 560, top: 296, right: 1260, bottom: 324 }, { id: TEXT_BLOCK.id });
      block.classList.add('block');
      open(editor, block);
      // Ten entries make about 600 px in a 320 px menu: the arrow keys reach the tenth
      for (let step = 1; step < 10; step += 1) {
        editor.onBlockKeyDown({ key: 'ArrowDown', target: block, preventDefault() {} });
        const active = items(editor).querySelector('.slash-menu-item.active');
        assert.equal(items(editor).children.indexOf(active), step, `${menu}, ArrowDown ${step}`);
        const scrolled = scrolls.at(-1);
        assert.equal(scrolled.element, active, `${menu}: the highlighted entry is scrolled into view`);
        assert.deepEqual({ ...scrolled.options }, { block: 'nearest' });
      }
    }
  });

  it('no editor menu reads the window size or adds the page scroll itself: each measures through Utils, in its own window', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js/editor.js'), 'utf8');
    assert.equal(/\binner(Height|Width)\b/.test(source), false, 'no innerWidth or innerHeight');
    assert.equal(/\bscroll[XY]\b/.test(source), false, 'no scrollX or scrollY');
  });
});

/** css/editor.css's rules, each selector of a rule to its declarations */
function cssRules() {
  const css = fs.readFileSync(path.join(ROOT, 'css/editor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of match[1].split(',')) rules.push([selector.trim(), match[2]]);
  }
  return rules;
}

describe('every menu fits a window smaller than it', () => {
  const rules = cssRules();
  const rule = (selector) => rules.filter(([s]) => s === selector).map(([, body]) => body).join(';');

  it('the slash, link, and template menus are no wider than the window, 8 px in, as in a narrow picture-in-picture window', () => {
    assert.match(rule('.slash-menu'), /max-width:\s*calc\(100vw - 16px\)/);
  });

  it('the note and folder menus scroll in a window shorter than they are', () => {
    assert.match(rule('.context-menu'), /max-height:\s*calc\(100vh - 16px\)/);
    assert.match(rule('.context-menu'), /overflow-y:\s*auto/);
  });

  it("the editor's menus are no taller than the window, 8 px in, and scroll", () => {
    for (const selector of ['.slash-menu', '.block-action-menu', '.turn-into-menu', '.table-context-menu']) {
      assert.match(rule(selector), /max-height:\s*(min\(\d+px,\s*calc\(100vh - 16px\)\)|calc\(100vh - 16px\))/, selector);
      assert.match(rule(selector), /overflow-y:\s*auto/, selector);
    }
  });

  it('the slash, link, and template menus are fixed to the window, in either pane', () => {
    assert.match(rule('.slash-menu'), /position:\s*fixed/);
    for (const [selector, body] of rules) {
      if (selector.includes('.slash-menu')) assert.doesNotMatch(body, /position:\s*(absolute|relative)/, selector);
    }
  });
});
