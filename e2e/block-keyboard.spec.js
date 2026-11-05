/**
 * #14 slice 4's keyboard part on the built extension, on a note of text, a divider, text, an
 * image, text, a card in place of a block this build can't show (e2e/block-safety.spec.js's
 * fixture) and text, loaded on a 1.4.x profile the extension upgrades as an update does.
 *
 * - The arrow keys land on a divider, an image and a card, with focus, and the next press in the
 *   same direction leaves it, for the next block's text: its start going down, its end going up.
 * - Backspace or Delete on a focused divider, image or card deletes its block as a selected block
 *   is deleted. Only a card asks first, with Cancel focused, and Cancel leaves it focused with no
 *   block selected. Focus goes to the block before, and one Undo brings each block back.
 * - The block's menu opens from the keyboard under #24's menu pattern: Mod+/ in a block's text,
 *   where Shift+F10 and the menu key stay the browser's, and Shift+F10 or the menu key on a
 *   divider's or an image's stop. Mod+/ in an empty block opens it too, and not the slash menu.
 *   Focus goes to its first item; the arrows, wrapping, Home, End and a letter move it; ArrowRight
 *   opens Turn into's types and ArrowLeft goes back; a choice puts focus back in the block's text;
 *   Escape and Tab close it and put focus back where it was, with its selection, before the app's
 *   own Escape hears it.
 * - Its accessibility tree is a menu named Block actions, with Turn into's types a menu named
 *   Turn into. A click on the handle opens it as before, with focus left where it was, and its
 *   roles and keys are a chunk the tab loads at a menu's first open, by click as by key.
 * - After #202's review: a click on an image leaves no focus on its stop; a question's Cancel
 *   gives focus back to a stop; a key's delete puts focus on the block before when it takes
 *   focus, and else on the block in the deleted one's place; Mod+/ and a click on the handle close
 *   the slash menu; a held Enter or Space in the menu acts once; an empty image's ring has its
 *   placeholder's corners. And what no case read before: Tab past the stops and their roles,
 *   stops first, last and two in a row, Enter and Space on Turn into, the menu key in a block's
 *   text, the shortcuts list's row, and split view's right pane, on a second note of edges.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, expectNoUncaught, resolveDist, chunkFile } = require('./harness');
const { fixtureHost } = require('./harness/fixture-host');
const { profileStore } = require('./harness/profile-store');
const driver = require('./characterization/driver');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'storage', 'synthesized', 'v8.opaque-blocks.json');
const NOTE = 'opaque-blocks-note';
const NAME = 'Stops along the way';
const CARD = 'opaque-blocks-unknown';
// A picture the image block shows, drawn in place: a data URL the page's CSP takes
const IMAGE = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='360' height='160'><rect width='360' height='160' fill='#8fa9c7'/><circle cx='280' cy='56' r='24' fill='#f2d57e'/><path d='M0 160 L110 70 L190 130 L250 95 L360 160 Z' fill='#5d7a99'/></svg>")}`;
// The note's blocks in order
const ORDER = ['stops-first', 'stops-divider', 'stops-second', 'stops-image', 'stops-third', CARD, 'stops-last'];
/** The stops' note: text, a divider, text, an image, text, the card, and text */
const STOPS = {
  name: NAME,
  order: ORDER,
  fields: {
    'stops-first': { content: 'First line' },
    'stops-divider': { type: 'divider', content: '' },
    'stops-second': { content: 'Second line' },
    'stops-image': { type: 'image', content: '', imageUrl: IMAGE },
    'stops-third': { content: 'Third line' },
    'stops-last': { content: 'Last line' },
  },
};
/**
 * The edges' note (#202's review): a divider first and an empty image after it, two stops in a
 * row; text; a table, which takes no focus; a divider; text; and an image last
 */
const EDGES = {
  name: 'Edges of the stops',
  order: ['edge-divider', 'edge-empty', 'edge-middle', 'edge-table', 'edge-rule', 'edge-after', 'edge-image'],
  fields: {
    'edge-divider': { type: 'divider', content: '' },
    'edge-empty': { type: 'image', content: '', imageUrl: '' },
    'edge-middle': { content: 'Middle line' },
    'edge-table': { type: 'table', content: '', rows: 2, cols: 2, tableData: [['A', 'B'], ['1', '2']], hasHeaderRow: true },
    'edge-rule': { type: 'divider', content: '' },
    'edge-after': { content: 'After the table' },
    'edge-image': { type: 'image', content: '', imageUrl: IMAGE },
  },
};

/**
 * The opaque-blocks fixture with its note's blocks in place of the cards, the stops' note's
 * unless `layout` names another. Each block is the fixture's own text record with its own id,
 * type and fields, and the card is the fixture's. Answers the blocks by id.
 */
function stopsFixture(layout = STOPS) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const stores = Object.fromEntries(fixture.databases[0].stores.map(store => [store.name, store]));
  const value = id => stores.elements.records.find(record => record.key === id).value;
  const text = value('opaque-blocks-before');
  const blocks = layout.order.map((id, order) => (id === CARD ? { ...value(CARD), order } : { ...text, ...layout.fields[id], id, order }));
  stores.elements.records = [
    ...stores.elements.records.filter(record => record.value.canvasId !== NOTE),
    ...blocks.map(block => ({ key: block.id, value: block })),
  ];
  stores.canvases.records = stores.canvases.records.map(record => (record.key === NOTE ? { ...record, value: { ...record.value, name: layout.name } } : record));
  return { fixture, held: Object.fromEntries(blocks.map(block => [block.id, block])) };
}

/** A new tab on the note, the stops' unless `layout` names another, and its blocks as the fixture holds them */
async function openStops(extension, layout = STOPS) {
  const { fixture, held } = stopsFixture(layout);
  await fixtureHost(extension.worker).loadFixture(fixture);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, layout.name);
  await expect(page.locator('#blocks-container > .block')).toHaveCount(layout.order.length);
  return { page, held };
}

const blockOf = (page, id) => page.locator(`#blocks-container > .block[data-id="${id}"]`);
const textOf = (page, id) => blockOf(page, id).locator('.block-content');
const stopOf = (page, id) => blockOf(page, id).locator('.block-stop');
const cardOf = page => blockOf(page, CARD).locator('.block-safe-card');
const blockMenu = page => page.getByRole('menu', { name: 'Block actions' });
const typesMenu = page => page.getByRole('menu', { name: 'Turn into' });
const itemOf = (menu, name) => menu.getByRole('menuitem', { name, exact: true });
const shownOrder = page => page.locator('#blocks-container > .block').evaluateAll(list => list.map(el => el.dataset.id));

/** Put the caret at the end, or the start, of the text that has focus, as End and Home do but without scrolling on a Mac */
function caretAt(page, end) {
  return page.evaluate((end) => {
    const range = document.createRange();
    range.selectNodeContents(document.activeElement);
    range.collapse(!end);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, end);
}

/**
 * Where focus is, in words: a stop by its name, the card, or a block's text with where its caret
 * is, as "Second line, at its end"
 */
function where(page) {
  return page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.activeElement);
    if (el.matches('.block-stop')) return String(el.ariaLabel).toLowerCase();
    if (el.matches('.block-safe-card')) return 'card';
    if (!el.matches('.block-content')) return el === document.body ? 'nothing' : el.tagName.toLowerCase();
    const selection = getSelection();
    if (!selection.rangeCount || !selection.isCollapsed) return `${el.textContent}, with a selection`;
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(selection.focusNode, selection.focusOffset);
    const offset = before.toString().length;
    const at = offset === 0 ? 'at its start' : offset === el.textContent.length ? 'at its end' : `at ${offset}`;
    return `${el.textContent}, ${at}`;
  });
}

/**
 * The ring of the stop that has focus, against its block's row: the height of the box its outline
 * draws (its border box, out by the outline's offset and width on each side), the row's height, and
 * the stop's corners beside the corners of the image it holds, if it holds one
 */
function ringOf(page) {
  return page.evaluate(() => {
    const stop = /** @type {HTMLElement} */ (document.activeElement);
    const style = getComputedStyle(stop);
    const out = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    const corners = (/** @type {Element} */ el) => ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(at => getComputedStyle(el)[`border${at}Radius`]).join(' ');
    // An image's picture, or an empty image's placeholder
    const img = stop.querySelector('img, .image-placeholder');
    return {
      height: stop.getBoundingClientRect().height + 2 * out,
      row: stop.closest('.block').getBoundingClientRect().height,
      corners: corners(stop),
      imageCorners: img ? corners(img) : null,
    };
  });
}

/** The blocks the editor has selected, and the ones the page shows selected */
function selected(page) {
  return page.evaluate(() => ({
    ids: [...app.editor.selectedBlockIds],
    shown: document.querySelectorAll('#blocks-container > .block.block-selected').length,
  }));
}

/** The note's blocks as stored, by id, once the editor has written what it has pending */
async function storedBlocks(page) {
  await page.evaluate(() => app.editor.flushSave());
  const elements = await profileStore(page).getElementsByNote(NOTE);
  return Object.fromEntries(elements.map(block => [block.id, block]));
}

test('the arrows land on a divider, an image and a card with focus, and leave on the next press', async ({ extension }) => {
  const { page } = await openStops(extension);

  // Down from the first line's end, through every stop, to the last line
  await textOf(page, 'stops-first').click();
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'stops-divider'), 'the divider has focus').toBeFocused();
  // Soft, so a build that misses both rings reports both (the director's look)
  const divider = await ringOf(page);
  expect.soft(divider.height, "the divider's ring box spans its row's height, inside it").toBeCloseTo(divider.row, 1);
  await page.keyboard.press('ArrowDown');
  expect(await where(page), 'the next press leaves the divider, for the start of the line after it').toBe('Second line, at its start');
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'stops-image'), 'the image has focus').toBeFocused();
  const image = await ringOf(page);
  expect.soft(image.corners, "the image's ring has the image's corners").toBe(image.imageCorners);
  await page.keyboard.press('ArrowDown');
  expect(await where(page), 'the next press leaves the image').toBe('Third line, at its start');
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(cardOf(page), 'the card has focus').toBeFocused();
  await page.keyboard.press('ArrowDown');
  expect(await where(page), 'the next press leaves the card').toBe('Last line, at its start');

  // Back up, from the last line's start: each press lands on the block before, and from a line's
  // text the caret goes to its start first, as Home would put it
  const trail = [];
  for (let press = 0; press < 6; press++) {
    await page.keyboard.press('ArrowUp');
    const at = await where(page);
    trail.push(at);
    if (at.endsWith('at its end')) await caretAt(page, false);
  }
  expect(trail, 'back up past the divider: ArrowUp lands on the card, the image and the divider in turn, and leaves each for the end of the line above').toEqual([
    'card',
    'Third line, at its end',
    'image',
    'Second line, at its end',
    'divider',
    'First line, at its end',
  ]);
  await expectNoUncaught(extension, page);
});

test('Backspace on a focused card asks first, and Cancel leaves it focused and unselected; Delete on a focused divider deletes it at once; one Undo brings each back', async ({ extension }) => {
  const { page, held } = await openStops(extension);
  const question = page.getByRole('dialog', { name: 'Delete this block?' });

  await cardOf(page).focus();
  await page.keyboard.press('Backspace');
  await expect(question, 'asks first').toBeVisible();
  await expect(question.locator('.confirm-dialog-cancel'), 'asks first, with Cancel focused').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(question).toHaveCount(0);
  await expect(cardOf(page), 'Cancel leaves the card focused').toBeFocused();
  expect(await selected(page), 'no block selected after Cancel').toEqual({ ids: [], shown: 0 });
  expect(await shownOrder(page)).toEqual(ORDER);

  // Delete on the divider takes it at once, and focus goes to the end of the line before it
  await stopOf(page, 'stops-divider').focus();
  await expect(stopOf(page, 'stops-divider')).toBeFocused();
  await page.keyboard.press('Delete');
  expect(await shownOrder(page), 'the divider goes at once').toEqual(ORDER.filter(id => id !== 'stops-divider'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await where(page), 'focus goes to the block before the divider').toBe('First line, at its end');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await shownOrder(page), 'one Undo brings the divider back where it was').toEqual(ORDER);
  expect((await storedBlocks(page))['stops-divider']).toMatchObject({ type: 'divider', order: 1 });

  // A yes deletes the card, focus goes to the end of the line before it, and one Undo brings the
  // card back as it was loaded
  await cardOf(page).focus();
  await page.keyboard.press('Delete');
  await expect(question.locator('.confirm-dialog-cancel')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(question.locator('.confirm-dialog-confirm')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(blockOf(page, CARD), 'a yes deletes the card').toHaveCount(0);
  expect(await where(page), 'focus goes to the block before the card').toBe('Third line, at its end');
  expect((await storedBlocks(page))[CARD]).toBeUndefined();
  await page.keyboard.press('ControlOrMeta+z');
  expect(await shownOrder(page), 'one Undo brings the card back where it was').toEqual(ORDER);
  expect((await storedBlocks(page))[CARD], 'as it was loaded').toEqual(held[CARD]);
  await expectNoUncaught(extension, page);
});

test("Mod+/ in a block's text opens its menu with focus on its first item, and the arrows, Home, End and a letter move focus in it", async ({ extension }) => {
  const { page } = await openStops(extension);
  const menu = blockMenu(page);

  await textOf(page, 'stops-second').click();
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(menu, 'the menu opens').toBeVisible();
  await expect(itemOf(menu, 'Turn into...'), 'focus is on its first item').toBeFocused();
  // A click into the text and a modified key leave the page out of keyboard modality, so the
  // item wouldn't match :focus-visible; the ring shows all the same
  await expect(itemOf(menu, 'Turn into...'), 'the first item shows the ring').toHaveCSS('outline-style', 'solid');

  const steps = [
    ['ArrowDown', 'Rewrite', 'ArrowDown moves focus to the next item'],
    ['ArrowUp', 'Turn into...', 'ArrowUp moves it back'],
    ['ArrowUp', 'Translate', 'ArrowUp from the first item goes to the last'],
    ['ArrowDown', 'Turn into...', 'ArrowDown from the last item goes to the first'],
    ['End', 'Translate', 'End goes to the last item'],
    ['Home', 'Turn into...', 'Home goes to the first item'],
    ['s', 'Summarize', 'a letter goes to the next item that starts with it'],
    ['e', 'Expand', 'another letter goes to its item, before the one focused'],
    ['t', 'Translate', 'a letter goes to the next of the items that start with it'],
    ['t', 'Turn into...', 'and on from the last of them to the first'],
  ];
  for (const [key, name, what] of steps) {
    await page.keyboard.press(key);
    await expect(itemOf(menu, name), what).toBeFocused();
  }
  await expectNoUncaught(extension, page);
});

test("ArrowRight opens Turn into's types, ArrowLeft goes back, and choosing a type turns the block and puts focus back in its text", async ({ extension }) => {
  const { page } = await openStops(extension);
  const menu = blockMenu(page);
  const types = typesMenu(page);
  const turnInto = itemOf(menu, 'Turn into...');

  await textOf(page, 'stops-second').click();
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(turnInto, 'the menu opens with focus on Turn into').toBeFocused();
  await expect(turnInto).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('ArrowRight');
  await expect(types, "ArrowRight opens Turn into's types").toBeVisible();
  await expect(itemOf(types, 'Text'), 'with focus on the first').toBeFocused();
  await expect(turnInto).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('ArrowLeft');
  await expect(turnInto, 'back on Turn into').toBeFocused();
  await expect(types, 'ArrowLeft closes the types').toHaveCount(0);
  await expect(menu, 'and keeps the menu').toBeVisible();
  await expect(turnInto).toHaveAttribute('aria-expanded', 'false');

  // Enter and Space on Turn into open its types too, and Escape in them goes back to it
  await page.keyboard.press('Enter');
  await expect(itemOf(types, 'Text'), 'Enter on Turn into opens its types').toBeFocused();
  await page.keyboard.press('Escape');
  await expect(turnInto, 'Escape in the types goes back to Turn into').toBeFocused();
  await expect(types).toHaveCount(0);
  await page.keyboard.press(' ');
  await expect(itemOf(types, 'Text'), 'Space on Turn into opens its types').toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(turnInto).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(itemOf(types, 'Text')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(itemOf(types, 'Heading 1')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(blockOf(page, 'stops-second'), 'choosing a type turns the block').toHaveAttribute('data-type', 'h1');
  await expect(menu, 'and closes the menu').toHaveCount(0);
  await expect(types).toHaveCount(0);
  await expect.poll(() => where(page), 'focus is back in its text, at its end').toBe('Second line, at its end');

  // Space chooses a type too: back to Text
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(turnInto).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(itemOf(types, 'Text')).toBeFocused();
  await page.keyboard.press(' ');
  await expect(blockOf(page, 'stops-second'), 'Space chooses a type').toHaveAttribute('data-type', 'text');
  await expect(menu).toHaveCount(0);
  await expectNoUncaught(extension, page);
});

test('Escape and Tab each close the menu and put focus back where it was, with its selection, before the app hears Escape', async ({ extension }) => {
  const { page } = await openStops(extension);
  const menu = blockMenu(page);
  const word = textOf(page, 'stops-second');
  /** Select "line" in "Second line" */
  const selectLine = () => word.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.firstChild, 7);
    range.setEnd(el.firstChild, 11);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  // The keys that reach the window, where the app's shortcuts listen
  await page.evaluate(() => {
    window.__keysHeard = [];
    window.addEventListener('keydown', (e) => window.__keysHeard.push(e.key));
  });

  await word.click();
  await selectLine();
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(itemOf(menu, 'Turn into...'), 'the menu opens').toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu, 'Escape closes the menu').toHaveCount(0);
  await expect(word, 'focus is back in the text').toBeFocused();
  expect(await page.evaluate(() => getSelection().toString()), 'with its selection').toBe('line');
  expect(await page.evaluate(() => window.__keysHeard), "the app's close-all doesn't hear the menu's Escape").not.toContain('Escape');

  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(itemOf(menu, 'Turn into...')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(menu, 'Tab closes the menu').toHaveCount(0);
  await expect(word, 'Tab puts focus back in the text').toBeFocused();
  expect(await page.evaluate(() => getSelection().toString()), 'Tab keeps its selection').toBe('line');
  await expectNoUncaught(extension, page);
});

test('the accessibility tree holds a menu named Block actions with its items, and Turn into\'s types as a menu named Turn into', async ({ extension }) => {
  const { page } = await openStops(extension);
  await textOf(page, 'stops-second').click();
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(blockMenu(page), 'the menu opens').toBeVisible();
  await expect(blockMenu(page)).toMatchAriaSnapshot(`
    - menu "Block actions":
      - menuitem "Turn into..."
      - separator
      - menuitem "Rewrite"
      - menuitem "Expand"
      - menuitem "Summarize"
      - menuitem "Translate"
  `);
  await expect(itemOf(blockMenu(page), 'Turn into...')).toHaveAttribute('aria-haspopup', 'menu');
  await page.keyboard.press('ArrowRight');
  await expect(typesMenu(page)).toMatchAriaSnapshot(`
    - menu "Turn into":
      - menuitem "Text"
      - menuitem "Heading 1"
      - menuitem "Heading 2"
      - menuitem "Heading 3"
      - menuitem "Bulleted List"
      - menuitem "Numbered List"
      - menuitem "To-do"
      - menuitem "Quote"
      - menuitem "Code"
      - menuitem "Callout"
      - menuitem "Divider"
      - menuitem "Toggle"
  `);
  // The handle is the pointer's: out of the tree and out of Tab's way
  await expect(blockOf(page, 'stops-second').locator('.block-handle')).toHaveAttribute('aria-hidden', 'true');
  await expectNoUncaught(extension, page);
});

test('Mod+/ in an empty block opens its menu and not the slash menu, which / still opens', async ({ extension }) => {
  const { page } = await openStops(extension);
  const slash = page.locator('#slash-menu');

  // A new empty block after the last line
  await textOf(page, 'stops-last').click();
  await caretAt(page, true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#blocks-container > .block')).toHaveCount(ORDER.length + 1);
  const empty = page.locator('#blocks-container > .block').last().locator('.block-content');
  await expect(empty).toBeFocused();

  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(slash, 'the slash menu stays closed').toBeHidden();
  await expect(blockMenu(page), 'its block menu opens').toBeVisible();
  await expect(itemOf(blockMenu(page), 'Turn into...')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(blockMenu(page)).toHaveCount(0);

  await empty.click();
  await page.keyboard.press('/');
  await expect(slash, 'a / still opens the slash menu').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(slash).toBeHidden();
  await expectNoUncaught(extension, page);
});

test("Shift+F10 or the menu key on a divider's or an image's stop opens its block's menu, and Escape or Tab gives focus back to the stop", async ({ extension }) => {
  const { page } = await openStops(extension);
  const menu = blockMenu(page);

  await textOf(page, 'stops-first').click();
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'stops-divider'), 'the divider has focus').toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(menu, 'Shift+F10 on the divider opens its menu').toBeVisible();
  await expect(menu).toMatchAriaSnapshot(`
    - menu "Block actions":
      - menuitem "Turn into..."
  `);
  await expect(itemOf(menu, 'Turn into...')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(stopOf(page, 'stops-divider'), 'Escape puts focus back on the divider').toBeFocused();

  await page.keyboard.press('ArrowDown');
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'stops-image'), 'the image has focus').toBeFocused();
  await page.keyboard.press('ContextMenu');
  await expect(menu, 'the menu key on the image opens its menu').toBeVisible();
  await expect(itemOf(menu, 'Turn into...')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(stopOf(page, 'stops-image'), 'Tab puts focus back on the image').toBeFocused();

  // In a block's text, Shift+F10 stays the browser's: the block's menu doesn't open
  await page.keyboard.press('ArrowDown');
  expect(await where(page)).toBe('Third line, at its start');
  await page.keyboard.press('Shift+F10');
  await expect(textOf(page, 'stops-third'), "Shift+F10 in a block's text leaves focus there").toBeFocused();
  await expect(menu, "and opens no block menu").toHaveCount(0);

  // And so does the menu key: the page keeps its default, for the browser's own menu
  await page.evaluate(() => {
    window.ntnMenuKeyKept = null;
    window.addEventListener('keydown', e => { if (e.key === 'ContextMenu') window.ntnMenuKeyKept = !e.defaultPrevented; });
  });
  await page.keyboard.press('ContextMenu');
  expect(await page.evaluate(() => window.ntnMenuKeyKept), "the menu key in a block's text keeps its default").toBe(true);
  await expect(menu, 'and opens no block menu either').toHaveCount(0);
  await expectNoUncaught(extension, page);
});

test("a click on the handle opens the menu as before, with focus left where it was, and the menus' roles and keys load at a menu's first open, by click as by key, not with the tab", async ({ extension }) => {
  const { chunks } = JSON.parse(fs.readFileSync(path.join(resolveDist(), 'build-info.json'), 'utf8'));
  expect(chunks, "the build has the menus' keys as a chunk of their own").toHaveProperty('menu-keys');
  const chunk = chunkFile(resolveDist(), 'menu-keys');
  const asked = [];
  extension.context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'chrome-extension:' && url.pathname === `/${chunk}`) asked.push(url.pathname.slice(1));
  });
  const { page } = await openStops(extension);
  expect(asked, "the tab starts without the menus' keys").toEqual([]);

  const line = blockOf(page, 'stops-third');
  await line.locator('.block-content').click();
  await line.hover();
  await line.locator('.block-handle').click();
  await expect(blockMenu(page), "a click opens the menu, with its roles").toBeVisible();
  expect(asked, "the click loads the menus' keys").toEqual([chunk]);
  // The press on the handle leaves focus where it leaves it today, and none goes into the menu
  expect(await page.evaluate(() => Boolean(document.activeElement.closest('[role="menu"]'))), 'and focus goes nowhere in the menu').toBe(false);
  await page.keyboard.press('Escape');
  await expect(blockMenu(page)).toHaveCount(0);

  await textOf(page, 'stops-second').click();
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(itemOf(blockMenu(page), 'Turn into...'), 'the menu opens by key').toBeFocused();
  expect(asked, 'once').toEqual([chunk]);
  await expectNoUncaught(extension, page);
});

// ─── #202's review: the fixes, and the gaps its tests left ───

test("Tab skips a divider's and an image's stop, groups named Divider and Image, for the next block's text, and lands on the card as #183 made it", async ({ extension }) => {
  const { page } = await openStops(extension);
  await expect(page.getByRole('group', { name: 'Divider', exact: true }), "the divider's stop is a group named Divider").toHaveCount(1);
  await expect(page.getByRole('group', { name: 'Image', exact: true }), "the image's stop is a group named Image").toHaveCount(1);

  await textOf(page, 'stops-first').click();
  await page.keyboard.press('Tab');
  await expect(textOf(page, 'stops-second'), 'Tab skips the divider').toBeFocused();
  await page.keyboard.press('Tab');
  await expect(textOf(page, 'stops-third'), 'Tab skips the image').toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cardOf(page), 'Tab lands on the card').toBeFocused();
  await expectNoUncaught(extension, page);
});

test("a click on the image leaves no focus on its stop: Backspace after it deletes nothing, and a letter typed goes to the note's end, as type anywhere puts it", async ({ extension }) => {
  const { page } = await openStops(extension);
  await stopOf(page, 'stops-image').locator('img').click();
  await expect(stopOf(page, 'stops-image'), 'the click leaves the image unfocused').not.toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await shownOrder(page), 'Backspace after the click deletes nothing').toEqual(ORDER);
  await page.keyboard.press('x');
  await expect(textOf(page, 'stops-last'), "a letter typed goes to the note's end").toHaveText('Last linex');
  await expectNoUncaught(extension, page);
});

test("Cancel on the question a Turn into from the image's menu asks gives focus back to the image's stop", async ({ extension }) => {
  const { page } = await openStops(extension);
  const menu = blockMenu(page);
  const question = page.getByRole('dialog');

  await textOf(page, 'stops-second').click();
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'stops-image')).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(itemOf(menu, 'Turn into...')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(itemOf(typesMenu(page), 'Text')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(question.locator('.confirm-dialog-cancel'), 'turning the image into text asks first, with Cancel focused').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(question).toHaveCount(0);
  await expect(stopOf(page, 'stops-image'), "Cancel gives focus back to the image's stop").toBeFocused();
  expect(await shownOrder(page)).toEqual(ORDER);
  await expectNoUncaught(extension, page);
});

test("on a note whose first and last blocks are stops, with two in a row and a table, the arrows take each stop in turn, and a key's delete puts focus on the block before when it takes focus, else on the block in its place", async ({ extension }) => {
  const { page } = await openStops(extension, EDGES);
  const title = page.locator('#page-title');

  // From the title down: the first block's stop, then the empty image's, two stops in a row
  await title.click();
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'edge-divider'), "ArrowDown from the title lands on the first block's stop").toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(title, "ArrowUp from the first block's stop goes back to the title").toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'edge-empty'), 'two stops in a row: the next press lands on the second').toBeFocused();
  const empty = await ringOf(page);
  expect.soft(empty.corners, "the empty image's ring has its placeholder's corners").toBe(empty.imageCorners);
  await page.keyboard.press('ArrowDown');
  expect(await where(page), 'and the next press leaves it, for the text after').toBe('Middle line, at its start');

  // The last block, an image: ArrowDown stays on its stop, and Delete deletes it at once
  await textOf(page, 'edge-after').click();
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'edge-image'), 'the last block, an image, takes focus').toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(stopOf(page, 'edge-image'), 'ArrowDown on the last block stays on it').toBeFocused();
  await page.keyboard.press('Delete');
  await expect(blockOf(page, 'edge-image'), "Delete on the image's stop deletes it at once").toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await where(page), 'focus goes to the end of the text before').toBe('After the table, at its end');

  // Backspace on the divider after the table deletes it at once. The table takes no focus, so the
  // block in the divider's place has it, at its start
  await caretAt(page, false);
  await page.keyboard.press('ArrowUp');
  await expect(stopOf(page, 'edge-rule'), 'ArrowUp from the text after the table lands on its divider').toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(blockOf(page, 'edge-rule'), 'Backspace on the divider deletes it at once').toHaveCount(0);
  expect.soft(await where(page), "after a table, which takes no focus, focus goes to the block in the divider's place, at its start").toBe('After the table, at its start');

  // Backspace on the empty image, after the first divider: focus goes onto that stop
  await textOf(page, 'edge-middle').click();
  await caretAt(page, false);
  await page.keyboard.press('ArrowUp');
  await expect(stopOf(page, 'edge-empty')).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(blockOf(page, 'edge-empty'), 'Backspace on the empty image deletes it at once').toHaveCount(0);
  await expect(stopOf(page, 'edge-divider'), 'focus goes onto the stop before').toBeFocused();

  // Delete on the first block: none is before it, so the block now first has focus, at its start
  await page.keyboard.press('Delete');
  await expect(blockOf(page, 'edge-divider')).toHaveCount(0);
  expect.soft(await where(page), 'for the first block, focus goes to the block now first, at its start').toBe('Middle line, at its start');
  await expectNoUncaught(extension, page);
});

/** An empty line after the last one, with the slash menu open in it */
async function slashMenuIn(page) {
  await textOf(page, 'stops-last').click();
  await caretAt(page, true);
  await page.keyboard.press('Enter');
  await page.keyboard.press('/');
  await expect(page.locator('#slash-menu'), 'the slash menu opens in the empty line').toBeVisible();
  return page.locator('#blocks-container > .block').last();
}

test('Mod+/ with the slash menu open closes it, so the block menu shows alone', async ({ extension }) => {
  const { page } = await openStops(extension);
  await slashMenuIn(page);
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(itemOf(blockMenu(page), 'Turn into...'), 'the block menu opens').toBeFocused();
  await expect(page.locator('#slash-menu'), 'Mod+/ closes the slash menu').toBeHidden();
  await expectNoUncaught(extension, page);
});

test('a click on the handle with the slash menu open closes it, so the block menu shows alone', async ({ extension }) => {
  const { page } = await openStops(extension);
  const line = await slashMenuIn(page);
  await line.hover();
  await line.locator('.block-handle').click();
  await expect(blockMenu(page), 'the block menu opens').toBeVisible();
  await expect(page.locator('#slash-menu'), 'a click on the handle closes the slash menu').toBeHidden();
  await expectNoUncaught(extension, page);
});

test('a held Enter or Space in the menu acts once: a repeat chooses nothing', async ({ extension }) => {
  const { page } = await openStops(extension);
  const turnInto = itemOf(blockMenu(page), 'Turn into...');
  const repeat = key => page.evaluate(key => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true })), key);

  await textOf(page, 'stops-second').click();
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(turnInto).toBeFocused();
  await repeat('Enter');
  await expect.soft(typesMenu(page), 'a repeated Enter on Turn into opens nothing').toHaveCount(0);
  await repeat(' ');
  await expect.soft(typesMenu(page), 'nor does a repeated Space').toHaveCount(0);
  await expect(turnInto, 'focus stays on Turn into').toBeFocused();
  await expectNoUncaught(extension, page);
});

test("the shortcuts list names Mod+/ for the block's menu", async ({ extension }) => {
  const { page } = await openStops(extension);
  await page.locator('#shortcuts-btn').click();
  const row = page.locator('#shortcuts-modal .shortcut-item', { hasText: 'Open Block Menu' });
  await expect(row, "the list has the block menu's row").toHaveCount(1);
  await expect(row.locator('.shortcut-key'), 'its key is Mod+/, with Mod as the platform names it').toHaveText(/^(⌘|Ctrl) \+ \/$/);
  await expectNoUncaught(extension, page);
});

test("in split view's right pane, the arrows land on its divider and leave it, as in the main pane", async ({ extension }) => {
  const { page } = await openStops(extension);
  // With another note in the main pane, split view's right pane opens the stops' note, the other
  // open tab, as it opens one: a second load of it there could draw it again under the keys
  await driver.openNote(page, 'Groceries');
  await driver.openSplitView(page);
  await expect.poll(() => page.evaluate(() => app.secondaryEditor.noteId), "the right pane opens the stops' note").toBe(NOTE);
  const right = page.locator('#secondary-editor-container');
  const rightBlock = id => right.locator(`.blocks-container > .block[data-id="${id}"]`);
  await expect(right.locator('.blocks-container > .block'), "the right pane shows the stops' note").toHaveCount(ORDER.length);

  await rightBlock('stops-first').locator('.block-content').click();
  await caretAt(page, true);
  await page.keyboard.press('ArrowDown');
  await expect(rightBlock('stops-divider').locator('.block-stop'), "the right pane's divider has focus").toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rightBlock('stops-second').locator('.block-content'), 'and the next press leaves it for the text after').toBeFocused();
  await expectNoUncaught(extension, page);
});
