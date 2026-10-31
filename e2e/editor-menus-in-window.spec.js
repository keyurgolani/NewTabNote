/**
 * Every editor menu opens inside the window, 8 px in from each edge, and shows where it stays
 * from its first frame: the slash, link, and template menus, a block's menu and its Turn into,
 * the Turn into for blocks selected together, and a table's menu, each opened from a block low
 * in the window, at 1440 by 900 with the sidebar open and at 360 by 640, where the sidebar is
 * closed so the note shows. #95 did the note and folder menus. In 1.4.x the slash, link, and
 * template menus were positioned in the pane but placed in window coordinates, so they opened
 * off by the pane's corner; the rest weren't kept inside the window near its edges, and a
 * table's menu and Turn into moved a frame after they showed.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const MARGIN = 8;
const WINDOWS = [
  { width: 1440, height: 900 },
  { width: 360, height: 640 },
];

const line = text => ({ type: 'text', content: text });
const lines = (from, count) => Array.from({ length: count }, (_, i) => line(`Line ${String(from + i).padStart(2, '0')}`));
const TABLE = { type: 'table', content: '', tableData: [['a', 'b'], ['1', '2']], rows: 2, cols: 2 };
// The blocks the menus open from sit mid-note, so the pane can scroll each one low
const TABLE_AT = 20;
const LINKS_AT = 21;
const EMPTY_AT = 22;
const NOTE = { name: 'Menus', blocks: [...lines(1, 20), TABLE, line('Links from here'), line(''), ...lines(21, 16)] };
// Names for the link menu to list, and a template for the template menu
const OTHERS = Array.from({ length: 10 }, (_, i) => ({ name: `Reading ${i + 1}`, blocks: [line('notes')] }));
const TEMPLATE = { name: 'Weekly plan', isTemplate: true, blocks: [line('plan')] };

const blockAt = (page, index) => page.locator('#blocks-container > .block').nth(index);

/**
 * Scroll the note so `locator`'s bottom sits 24 px above the window's, check it's low, and
 * return its box
 */
async function low(page, locator, viewport) {
  await locator.evaluate(element => {
    const pane = element.closest('.editor-pane');
    pane.scrollTop += element.getBoundingClientRect().bottom - (window.innerHeight - 24);
  });
  const box = await locator.boundingBox();
  expect(box.y + box.height, 'what the menu opens from sits low in the window').toBeGreaterThan(viewport.height - 100);
  return box;
}

/**
 * From now on, record each place `selector`'s menu shows at: its box, each time the page
 * changes while it's shown. A menu placed in the task that shows it has one place from its first
 * frame; one shown and then moved a frame later has two.
 */
function watchMenu(page, selector) {
  return page.evaluate(selector => {
    const seen = [];
    const round = value => Math.round(value * 100) / 100;
    const record = () => {
      const menu = Array.from(document.querySelectorAll(selector)).find(element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (!menu) return;
      const { left, top, right, bottom } = menu.getBoundingClientRect();
      const box = { left: round(left), top: round(top), right: round(right), bottom: round(bottom) };
      if (JSON.stringify(seen.at(-1)) !== JSON.stringify(box)) seen.push(box);
    };
    const observer = new MutationObserver(record);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
    window.__menuPlaces = { seen, stop: () => observer.disconnect() };
  }, selector);
}

/** The places the menu showed at, two frames after it opened, so one that moves a frame late has */
async function placesShown(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => {
    window.__menuPlaces.stop();
    return window.__menuPlaces.seen;
  });
}

/** Each menu: where it shows, and how it opens from a block low in the window */
const MENUS = [
  {
    name: "a table's menu",
    selector: '.table-context-menu',
    open: async (page, viewport) => {
      await low(page, blockAt(page, TABLE_AT), viewport);
      // Its last cell, near that cell's bottom left corner: the AI button sits over its right
      // end at 360, and at 360 the menu still has to come in from the window's right edge
      const cell = blockAt(page, TABLE_AT).locator('td, th').last();
      const box = await cell.boundingBox();
      await cell.click({ button: 'right', position: { x: Math.min(8, box.width / 2), y: Math.max(1, box.height - 4) } });
    },
  },
  {
    name: "a block's menu",
    selector: '.block-action-menu',
    open: async (page, viewport) => {
      await low(page, blockAt(page, LINKS_AT), viewport);
      await blockAt(page, LINKS_AT).locator('.block-handle').click();
    },
  },
  {
    name: "Turn into, from a block's menu",
    selector: '.turn-into-menu',
    open: async (page, viewport) => {
      await low(page, blockAt(page, LINKS_AT), viewport);
      await blockAt(page, LINKS_AT).locator('.block-handle').click();
      await page.locator('.block-action-menu').getByText('Turn into...').click();
    },
  },
  {
    name: 'the link menu',
    selector: '#wiki-menu',
    open: async (page, viewport) => {
      await low(page, blockAt(page, LINKS_AT), viewport);
      await blockAt(page, LINKS_AT).locator('.block-content').click();
      await page.keyboard.press('End');
      await page.keyboard.type('[[');
    },
  },
  {
    name: 'the template menu',
    selector: '#template-menu',
    // Nothing in 1.4.x opens it (e2e/characterization/overlays.spec.js), so the editor's own call does
    open: async (page, viewport) => {
      await low(page, blockAt(page, LINKS_AT), viewport);
      await page.evaluate(async index => {
        app.editor.templates = await Storage.getTemplates();
        app.editor.showTemplateMenu(document.querySelectorAll('#blocks-container > .block')[index]);
      }, LINKS_AT);
    },
  },
  {
    name: 'the slash menu',
    selector: '#slash-menu',
    open: async (page, viewport) => {
      await low(page, blockAt(page, EMPTY_AT), viewport);
      await blockAt(page, EMPTY_AT).locator('.block-content').click();
      await page.keyboard.press('/');
    },
  },
  {
    name: 'Turn into, for blocks selected together',
    selector: '.turn-into-menu',
    open: async page => {
      for (const index of [1, 2]) await blockAt(page, index).locator('.block-content').click({ modifiers: ['ControlOrMeta'] });
      const bar = page.locator('.selection-action-bar');
      await expect(bar).toBeVisible();
      // At 360 the bar is wider than the window and this button can sit past its edge; the menu
      // opens from the button's box, wherever the click lands
      await bar.getByRole('button', { name: 'Turn into...' }).dispatchEvent('click');
    },
  },
];

for (const viewport of WINDOWS) {
  test(`at ${viewport.width} by ${viewport.height}, every editor menu opened low in the window opens inside it, 8 px in, and shows there from its first frame`, async ({ extension }) => {
    await extension.seedOnboarded();
    await driver.seedNotes(extension, [...OTHERS, TEMPLATE, NOTE]);
    const page = await driver.openNewTab(extension);
    await page.setViewportSize(viewport);
    await expect(page.locator('#page-title')).toHaveText(NOTE.name);
    if (viewport.width <= 480) {
      // An open sidebar covers the whole window there
      await page.locator('#sidebar-toggle').click();
      await expect(page.locator('#sidebar')).toHaveClass(/collapsed/);
    }
    await expect(page.locator('#blocks-container > .block')).toHaveCount(NOTE.blocks.length);

    for (const menu of MENUS) {
      await watchMenu(page, menu.selector);
      await menu.open(page, viewport);
      await expect(page.locator(menu.selector).first(), `${menu.name} opens`).toBeVisible();
      const places = await placesShown(page);
      expect(places, `${menu.name} shows in one place from its first frame`).toHaveLength(1);
      const [box] = places;
      // Inside the window with 8 px to spare, give or take half a pixel of layout rounding
      expect(box.left, `${menu.name}'s left`).toBeGreaterThanOrEqual(MARGIN - 0.5);
      expect(box.top, `${menu.name}'s top`).toBeGreaterThanOrEqual(MARGIN - 0.5);
      expect(box.right, `${menu.name}'s right`).toBeLessThanOrEqual(viewport.width - MARGIN + 0.5);
      expect(box.bottom, `${menu.name}'s bottom`).toBeLessThanOrEqual(viewport.height - MARGIN + 0.5);
      await page.keyboard.press('Escape');
      await expect(page.locator(menu.selector), `Escape closes ${menu.name}`).toBeHidden();
    }
    await expectNoUncaught(extension, page);
  });
}
