/**
 * The note menu stays inside the window, so a low note's Move to Trash can be clicked. In
 * 1.4.x the menu clamped its top to innerHeight - 200 while it's about 314 px tall, so the
 * last items of a menu opened on a note low in the sidebar fell below the window. #27 slice 1
 * made that common: with the indexer, each sidebar item has a preview line, and the list is
 * taller. The walkthrough's toast step timed out on it at 1440 by 900.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const VIEWPORT = { width: 1440, height: 900 };
const NAMES = Array.from({ length: 16 }, (_, i) => `Note ${String(i + 1).padStart(2, '0')}`);

test("a low note's menu opens inside the window, and its Move to Trash works", async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NAMES.map(name => ({ name, blocks: [{ type: 'text', content: `${name} has a line the sidebar previews` }] })));
  const page = await driver.openNewTab(extension);
  await page.setViewportSize(VIEWPORT);
  await driver.showNotes(page);
  const items = page.locator('#sidebar-notes-list .sidebar-note-item');
  await expect(items).toHaveCount(NAMES.length);
  await expect(page.locator('#sidebar-notes-list .sidebar-note-preview').first()).toBeVisible();

  // The lowest note, scrolled into view at the bottom of the list
  const lowest = items.last();
  const name = (await lowest.locator('.sidebar-note-name').textContent()).trim();
  await lowest.scrollIntoViewIfNeeded();
  const box = await lowest.boundingBox();
  const y = Math.min(box.y + box.height / 2, VIEWPORT.height - 4);
  // Low enough that the old clamp left the menu's last items below the window
  expect(y).toBeGreaterThan(VIEWPORT.height - 200);
  await page.mouse.click(box.x + 40, y, { button: 'right' });

  const menu = page.getByRole('menu', { name: 'Note actions' });
  await expect(menu).toBeVisible();
  const placed = await menu.boundingBox();
  expect(placed.y).toBeGreaterThanOrEqual(8);
  expect(placed.y + placed.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
  expect(placed.x + placed.width).toBeLessThanOrEqual(VIEWPORT.width - 8);

  await page.locator('#ctx-delete-note').click({ timeout: 5000 });
  await expect(page.locator('.toast.success').last()).toHaveText('Note moved to trash');
  await expect(items.filter({ has: page.getByText(name, { exact: true }) })).toHaveCount(0);
  await expectNoUncaught(extension, page);
});
