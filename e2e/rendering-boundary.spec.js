/**
 * #14 slice 2 on the built extension: the trusted-rendering port, and plain text written into
 * rich content.
 *
 * - Seeded markup (test/fixtures/blocks/html-fuzz.cjs) shows through the page's port, and
 *   through a block's element, as it does through innerHTML, which 1.4.x assigned.
 * - Seeded plain text escapes, through the port, to what a div serializes once its
 *   textContent is that text, and reads back as the text.
 * - The link rule agrees with Chromium's URL parser: a link may point at an address with no
 *   scheme, or with http, https or mailto, and at nothing else.
 * - Plain text written into rich content shows as text (declared 1.4.x fixes); each of these
 *   tests keeps a screenshot of the block among its results.
 */

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./harness');
const driver = require('./characterization/driver');

/** How many seeded strings each check reads */
const FUZZ_STRINGS = 6000;

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'blocks');
/** A CommonJS fixture as an expression the page evaluates to its exports */
const moduleExpression = source => `(() => { const module = { exports: {} }; ${source}\n; return module.exports; })()`;

/** In the page: where the port, a block's element, the escape, or the link rule disagree with Chromium, at most 10 each */
function compareInPage(fuzz, count) {
  const port = globalThis.BlockRendering;
  const assigned = html => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.innerHTML;
  };
  const rendered = [];
  const blocks = [];
  for (const html of fuzz.fuzzStrings(count)) {
    const div = document.createElement('div');
    port.render(div, html);
    if (div.innerHTML !== assigned(html) && rendered.length < 10) rendered.push(html);
    for (const type of ['text', 'toggle']) {
      const element = new window.Block({ type, content: html, children: html }).createElement();
      const shown = [...element.querySelectorAll('.block-content, .toggle-children-content')].map(el => el.innerHTML);
      const expected = type === 'toggle' ? [assigned(html), assigned(html)] : [assigned(html)];
      if (JSON.stringify(shown) !== JSON.stringify(expected) && blocks.length < 10) blocks.push({ type, html });
    }
  }
  // Plain text, no CR: the parser reads CR as a line feed, as it would in any markup
  const pieces = ['<', '>', '&', 'amp;', '&lt', '#', ';', 'x', ' ', ' ', '\n', '"', "'", '<b>', '<!--', '<script>', '&copy', ' ', '\t'];
  let seed = 0x14c2;
  const random = n => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const escaped = [];
  for (let k = 0; k < count; k++) {
    let text = '';
    for (let j = 1 + random(10); j > 0; j--) text += pieces[random(pieces.length)];
    const div = document.createElement('div');
    div.textContent = text;
    const shown = document.createElement('div');
    port.render(shown, port.escapePlainText(text));
    if ((div.innerHTML !== port.escapePlainText(text) || shown.textContent !== text) && escaped.length < 10) escaped.push(text);
  }
  // An address is absolute when the URL parser reads it without a base
  const chromiumAllows = href => {
    try {
      return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol);
    } catch {
      return true;
    }
  };
  const hrefPieces = ['javascript', 'JavaScript', 'http', 'https', 'mailto', 'data', 'file', 'chrome-extension', 'c', ':', '//', '/', 'a', '.', '\t', '\n', ' ', '\u0000', '\u0001', '#', '?', '+', '-', '1'];
  const links = [];
  for (let k = 0; k < count; k++) {
    let href = '';
    for (let j = 1 + random(6); j > 0; j--) href += hrefPieces[random(hrefPieces.length)];
    if (port.isLinkHref(href) !== chromiumAllows(href) && links.length < 10) links.push(href);
  }
  return { rendered, blocks, escaped, links };
}

test("the rendering port shows 1.4.x's markup, escapes plain text, and links as Chromium reads the address", async ({ extension }) => {
  test.setTimeout(120_000);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const fuzz = moduleExpression(fs.readFileSync(path.join(FIXTURES, 'html-fuzz.cjs'), 'utf8'));
  const result = await page.evaluate(`(${compareInPage.toString()})(${fuzz}, ${FUZZ_STRINGS})`);
  expect(result).toEqual({ rendered: [], blocks: [], escaped: [], links: [] });
  expect(await extension.uncaught()).toEqual([]);
});

test('a captured selection shows as the text that was selected (#14 slice 2, declared)', async ({ extension }, testInfo) => {
  await extension.seedOnboarded();
  const text = 'Sale <b>today</b> & <i>tomorrow</i>';
  const source = 'https://example.test/?a=1&para=2';
  await driver.captureText(extension, { text, source });
  const page = await driver.openNewTab(extension);
  await driver.openTodaysDailyNote(page);
  const block = page.locator('#blocks-container > .block').first();
  await block.screenshot({ path: testInfo.outputPath('capture.png') });
  await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: `${text} (Source: ${source})` }]);
  await expect(block.locator('.block-content b, .block-content i')).toHaveCount(0);
});

test("a block's plain-text field shows as text once it's rich content (#14 slice 2, declared)", async ({ extension }, testInfo) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Table', blocks: [{ type: 'table', content: '', tableData: [['Plan <b>this</b>', 'a & b']], rows: 1, cols: 2, hasHeaderRow: false }] },
  ]);
  const page = await driver.openNewTab(extension);
  await expect(page.locator('#page-title')).toHaveText('Table');
  const block = page.locator('#blocks-container > .block').first();
  await block.hover();
  await block.locator('.block-handle').click();
  await page.locator('.block-action-menu').getByText('Turn into...').click();
  await page.locator('.turn-into-menu').getByText('Text', { exact: true }).click();
  await expect(block).toHaveAttribute('data-type', 'text');
  await block.screenshot({ path: testInfo.outputPath('turn-into.png') });
  await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: 'Plan <b>this</b> a & b' }]);
  await expect(block.locator('.block-content b')).toHaveCount(0);
});
