/**
 * NTN-223 on the built extension: a highlight's text against the highlight. The highlight's rules
 * set only its background, so its text took the browser's own colour for <mark>, black in both
 * themes. That's 18.70:1 on the light theme's yellow, and 2.02:1 on the dark theme's olive. Now the
 * dark rule has `color: inherit`, so there a highlight's text takes its line's own colour. Light
 * keeps the browser's black.
 *
 * - In a text block, a highlight's text reads at WCAG's 4.5:1 or more, in light and in dark.
 * - In a quote, it reads at least as high a ratio as on `next`, in both themes.
 * - In light, a highlight inside a link's text stays at its ratio on `next`.
 * The ratios are WCAG's, from the highlight's computed colour and background.
 * Each test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

// A highlight's background in each theme (css/editor.css's .block-content mark)
const MARK = { light: 'rgb(255, 243, 176)', dark: 'rgb(74, 64, 0)' };
// Each theme's ratio on `next` at 66975f8c, the browser's black on that background, rounded down
const ON_NEXT = { light: 18.69, dark: 2.02 };
const NOTE = {
  name: 'Highlight contrast',
  blocks: [
    { type: 'text', content: 'A <mark>marked</mark> word' },
    // A quote: the seed holds only types 1.4.x's editor saved, so it's turned into one from its block menu
    { type: 'text', content: 'A <mark>quoted</mark> word' },
    { type: 'text', content: 'A <a href="https://example.com/"><mark>linked</mark></a> word' },
  ],
};

/**
 * Turn NOTE's second block into a quote from its block menu, as someone does, so its highlight sits
 * in a quote. The menu's keys come with a chunk at its first open, so each key waits for the menu
 * to take it
 */
async function turnIntoQuote(page) {
  const block = page.locator('#editor-container .blocks-container > .block').nth(1);
  await block.locator('.block-content').click();
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(page.getByRole('menu', { name: 'Block actions' }).getByRole('menuitem', { name: 'Turn into...', exact: true }), 'its block menu opens on Turn into').toBeFocused();
  await page.keyboard.press('ArrowRight');
  const quote = page.getByRole('menu', { name: 'Turn into' }).getByRole('menuitem', { name: 'Quote', exact: true });
  await expect(quote, "Quote is among Turn into's types").toBeVisible();
  await quote.click();
  await expect(block, 'the second block is a quote').toHaveAttribute('data-type', 'quote');
  await expect(block.locator('.block-content mark'), 'and keeps its highlight').toHaveText('quoted');
}

/** A new tab at 1440 by 900 on NOTE, its second block a quote, in `theme` */
async function openNote(extension, theme) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [NOTE]);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#editor-container .page-title')).toHaveText(NOTE.name);
  await turnIntoQuote(page);
  if (theme === 'dark') {
    await driver.setTheme(page, 'dark');
    await driver.closeSettings(page);
    await expect.poll(() => driver.theme(page)).toBe('dark');
  }
  await expect.poll(() => page.locator('#editor-container .block-content mark').first().evaluate(el => getComputedStyle(el).backgroundColor), `the ${theme} theme's highlight`).toBe(MARK[theme]);
  return page;
}

/** WCAG's contrast of a highlight's text on its background, in `root`, for each place it sits */
const ratios = (root) => {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb) => {
    const [r, g, b] = rgb.match(/[\d.]+/g).map(Number);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (selector) => {
    const style = getComputedStyle(root.querySelector(selector));
    const [hi, lo] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };
  return {
    text: ratio('.block[data-type="text"] .block-content > mark'),
    quote: ratio('.block[data-type="quote"] .block-content mark'),
    link: ratio('.block-content a > mark'),
  };
};

test('light: a highlight reads at 4.5:1 or more in a text block, and as high as on next in a quote and inside a link', async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openNote(extension, 'light');
  const light = await page.locator('#editor-container').evaluate(ratios);
  expect.soft(light.text, "light: a highlight's text in a text block, at 4.5:1 or more").toBeGreaterThanOrEqual(4.5);
  expect.soft(light.quote, "light: a highlight's text in a quote, as high as on next").toBeGreaterThanOrEqual(ON_NEXT.light);
  expect.soft(light.link, "light: a highlight's text inside a link, as high as on next").toBeGreaterThanOrEqual(ON_NEXT.light);
  await expectNoUncaught(extension, page);
});

test('dark: a highlight reads at 4.5:1 or more in a text block, and at least as high as on next in a quote', async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openNote(extension, 'dark');
  const dark = await page.locator('#editor-container').evaluate(ratios);
  expect.soft(dark.text, "dark: a highlight's text in a text block, at 4.5:1 or more").toBeGreaterThanOrEqual(4.5);
  expect.soft(dark.quote, "dark: a highlight's text in a quote, as high as on next").toBeGreaterThanOrEqual(ON_NEXT.dark);
  await expectNoUncaught(extension, page);
});
