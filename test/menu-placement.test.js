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

  it('above, it opens above when it fits there and below when only that fits, and keeps its top in a window too short for either', () => {
    assert.deepEqual(beside(rect(600, 836, 690, 864), SUBMENU, VIEWPORT, { above: true, gap: 8 }), { left: 600, top: 836 - 8 - SUBMENU.height });
    assert.deepEqual(beside(rect(600, 100, 690, 128), SUBMENU, VIEWPORT, { above: true, gap: 8 }), { left: 600, top: 128 + 8 });
    const short = { width: 1440, height: 300 };
    assert.equal(beside(rect(600, 236, 690, 264), SUBMENU, short, { above: true, gap: 8 }).top, MARGIN);
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
 * at `sizeOf(element)` where its style's left and top put it, moved up by its height under
 * translateY(-100%), as a browser would. Hidden only by visibility, it still has its size.
 */
function laidOut(element, sizeOf) {
  element.getBoundingClientRect = () => {
    const shown = element.isConnected && !element.classList.contains('hidden');
    const { width, height } = shown ? sizeOf(element) : { width: 0, height: 0 };
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
 * menus the editor makes have their size once they're in the page.
 */
function editorPage(viewport) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.load('js/utils.js', 'js/blocks.js', 'js/editor.js');
  env.global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  // The window, as the page's scripts read it and as the editor's document does
  for (const view of [env.global, env.window]) Object.assign(view, { innerWidth: viewport.width, innerHeight: viewport.height });
  const doc = env.document;
  const make = doc.createElement.bind(doc);
  doc.createElement = (tag) => Object.assign(laidOut(make(tag), editorMenuSize), { scrollIntoView() {} });
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
  return { env, doc, editor, at };
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

  it("Turn into for blocks selected together keeps its top in a window too short for it, above or below the bar", () => {
    const viewport = { width: 1440, height: 300 };
    const editorDom = editorPage(viewport);
    const menu = EDITOR_SITES.find((site) => site.key === 'selection').open(editorDom, { button: { left: 600, top: 236, right: 690, bottom: 264 } });
    assert.deepEqual(placed(menu), { left: 600, top: MARGIN });
  });

  it('the link menu opens under its block when the caret has no box of its own', () => {
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

describe('every menu fits a window shorter than it', () => {
  const rules = cssRules();
  const rule = (selector) => rules.filter(([s]) => s === selector).map(([, body]) => body).join(';');

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
