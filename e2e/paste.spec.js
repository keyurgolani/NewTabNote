/**
 * A paste follows the rules keys do (e2e/characterization/type-anywhere.spec.js): while a
 * modal is open, a paste with focus outside the note leaves the note alone, and a paste in
 * the note works as before. The pastes are real ones, from the clipboard. With text
 * selected in a block, a paste's target is that block wherever focus went. Each test ends
 * with the uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** Plain text, then each kind the editor turns into blocks: fenced code, a URL, CSV, Markdown */
const PASTES = [' and bread', '```\nconst a = 1;\n```', 'https://example.test/page', 'a,b\n1,2', '# Heading\n- item'];

/** Put `text` on the clipboard and paste it where focus is */
async function paste(page, text) {
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.keyboard.press('ControlOrMeta+KeyV');
}

for (const [left, leave] of [
  ['the caret left in the note', page => driver.clickBlock(page, 1)],
  ['text selected in the note', async page => {
    await driver.clickBlock(page, 1);
    await page.keyboard.press('Shift+Home');
  }],
]) {
  test(`with Settings open from the header and ${left}, pastes leave the note and what is stored alone`, async ({ extension }) => {
    await extension.seedOnboarded();
    await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }] }]);
    const page = await driver.openNewTab(extension);
    await extension.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await leave(page);
    const note = [{ type: 'text', text: 'eggs' }, { type: 'text', text: 'milk' }];

    // Focus stays on the header's button
    await page.locator('#header').getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    for (const text of PASTES) await paste(page, text);

    expect(await driver.blocks(page)).toEqual(note);
    expect(await driver.savedBlocks(page)).toEqual(note.map(block => block.text));

    // With Settings closed, a paste in the note lands there
    await driver.closeSettings(page);
    await driver.clickBlock(page, 1);
    await paste(page, PASTES[0]);
    await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: 'eggs' }, { type: 'text', text: 'milk and bread' }]);
    expect(await driver.savedBlocks(page)).toEqual(['eggs', 'milk and bread']);
    await expectNoUncaught(extension, page);
  });
}
