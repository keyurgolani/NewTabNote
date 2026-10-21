/**
 * The service worker registers its context menus and the Alt+P and Alt+S commands after an
 * install and after an update (#12 slice 1). It's a module worker, so a module in its
 * import graph that throws or awaits at the top level stops it before any listener
 * registers, and both disappear with no visible error.
 */

const { test, expect } = require('./harness');

const MENUS = ['capture-page', 'capture-selection'];
// chrome.commands names a key the platform's way: Alt+P on Linux and Windows, ⌥P on macOS
const SHORTCUTS = { 'capture-page': /^(Alt\+P|⌥P)$/, 'capture-selection': /^(Alt\+S|⌥S)$/ };

/**
 * The worker's context menu items that exist. contextMenus has no getter, but update()
 * fails on an id it doesn't have.
 */
function existingMenus(worker) {
  return worker.evaluate(ids => Promise.all(ids.map(id => new Promise(resolve => {
    chrome.contextMenus.update(id, {}, () => resolve(chrome.runtime.lastError ? null : id));
  }))).then(found => found.filter(Boolean)), MENUS);
}

async function expectRegistered(worker) {
  await expect.poll(() => existingMenus(worker), { message: 'the context menus' }).toEqual(MENUS);
  const commands = await worker.evaluate(async () => (await chrome.commands.getAll()).map(({ name, shortcut }) => ({ name, shortcut })));
  for (const [name, key] of Object.entries(SHORTCUTS)) {
    const command = commands.find(entry => entry.name === name);
    expect(command, `the ${name} command`).toBeTruthy();
    expect(command.shortcut, `the ${name} shortcut`).toMatch(key);
  }
}

test('the worker registers its context menus and Alt+P and Alt+S after an install and after an update', async ({ extension }) => {
  await expectRegistered(extension.worker);

  // Clear the menus, so only the updated worker's onInstalled can bring them back
  await extension.worker.evaluate(() => new Promise(resolve => chrome.contextMenus.removeAll(resolve)));
  expect(await existingMenus(extension.worker)).toEqual([]);

  await extension.update({ version: '9.9.9' });
  expect(await extension.worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('9.9.9');
  await expectRegistered(extension.worker);
  expect(await extension.uncaught()).toEqual([]);
});
