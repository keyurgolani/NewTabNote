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

/**
 * #14: a paste turns the block it's in only when that block holds nothing, by the empty-note
 * rule. A line the user cleared in Chromium holds nothing, whichever way it was cleared and
 * whether its text was bold, so each kind of paste still turns it. Each cleared line's markup
 * is printed, for the case where one doesn't.
 */
test('a line cleared in Chromium, by selecting its text or by Backspace to its start, plain or bold, still turns on each kind of paste', async ({ extension }) => {
  const kinds = [
    ['fenced code', PASTES[1], ['code']],
    ['a URL', PASTES[2], ['bookmark']],
    ['CSV', PASTES[3], ['table']],
    ['Markdown', PASTES[4], ['h1', 'bullet']],
  ];
  const clears = [
    ['its text selected and Backspace', async page => {
      await page.keyboard.press('Shift+Home');
      await page.keyboard.press('Backspace');
    }],
    ['Backspace to its start', async page => {
      for (let i = 0; i < 'milk'.length; i += 1) await page.keyboard.press('Backspace');
    }],
  ];
  const styles = [['plain', false], ['bold', true]];
  const cases = [];
  for (const [how, clear] of clears) {
    for (const [style, bold] of styles) {
      for (const [kind, text, turned] of kinds) cases.push({ name: `${kind}, ${style}, ${how}`, clear, bold, text, turned });
    }
  }
  await extension.seedOnboarded();
  await driver.seedNotes(extension, cases.map(({ name }) => ({ name, blocks: [{ type: 'text', content: 'start' }] })));
  const page = await driver.openNewTab(extension);
  await extension.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const results = [];
  for (const { name, clear, bold, text, turned } of cases) {
    await driver.openNote(page, name);
    await driver.clickBlock(page, 0);
    await page.keyboard.press('Enter');
    if (bold) await page.keyboard.press('ControlOrMeta+KeyB');
    await page.keyboard.type('milk');
    await clear(page);
    const left = await page.locator('#blocks-container > .block .block-content').nth(1).innerHTML();
    await paste(page, text);
    const typesNow = async () => (await driver.blocks(page)).map(block => block.type);
    // The paste has landed once the blocks are more than the line and the one before it
    await expect.poll(typesNow).not.toEqual(['text', 'text']);
    results.push({ name, left, types: await typesNow(), turned });
  }
  console.log('#14 cleared lines:', JSON.stringify(results.map(({ name, left, types }) => ({ name, left, types }))));
  for (const { name, left, types, turned } of results) {
    expect(types, `${name}: the cleared line held ${JSON.stringify(left)}`).toEqual(['text', ...turned]);
  }
  await expectNoUncaught(extension, page);
});

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
