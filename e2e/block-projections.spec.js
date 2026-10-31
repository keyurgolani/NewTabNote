/**
 * #14 slice 1 (answer 5) on Chromium's DOM. The block projections read text without a DOM
 * (js/kernel/core/blocks/html-text.js); 1.4.x read it through a div's innerHTML. On the built
 * new tab:
 *
 * - every html-text fixture (test/fixtures/blocks/html-text-cases.json and
 *   character-references.json) gives, through a div of the page (or of an inert document, where
 *   a case says scripting is off), the text the Node tests expect, or, for a declared
 *   difference, the Chromium reading the case records;
 * - seeded strings (test/fixtures/blocks/html-fuzz.cjs) read the same through a div as through
 *   the page's own block projections, with scripting on (AI's text) and off (the editor's);
 * - every moved caller on the page gives, on every corpus case, what its 1.4.x copy
 *   (test/fixtures/blocks/legacy-projections.cjs) gives reading through the page's document.
 *
 * The fixtures are evaluated in the page as they are in Node, so the cases are the same ones.
 */

/** How many seeded strings the differential check reads */
const FUZZ_STRINGS = 19_000;

const fs = require('fs');
const path = require('path');
const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'blocks');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** A CommonJS fixture as an expression the page evaluates to its exports */
const moduleExpression = source => `(() => { const module = { exports: {} }; ${source}\n; return module.exports; })()`;

/**
 * In the page: each fixture case whose div text isn't what the fixture says, and each corpus
 * case where a caller and its 1.4.x copy differ, at most 10 of each
 */
function compareInPage(rules, references, corpus, legacy, fuzz, fuzzCount) {
  // A div of the page, where scripting is on, or of an inert document, where it's off
  const inert = document.implementation.createHTMLDocument('');
  const textOf = (html, scripting = true) => {
    const div = (scripting ? document : inert).createElement('div');
    div.innerHTML = html;
    return div.textContent;
  };
  const fixtures = [];
  for (const { rule, html, text, scripting, chromium } of rules) {
    const expected = chromium ?? text;
    if (textOf(html, scripting) !== expected) fixtures.push({ rule, got: textOf(html, scripting), expected });
  }
  // The differential check: Chromium against the page's projections, which read a text block's
  // content with the tokenizer, scripting on for AI and off for the editor
  const projections = globalThis.BlockProjections;
  const fuzzed = [];
  const strings = fuzz.fuzzStrings(fuzzCount);
  for (const html of strings) {
    const block = { type: 'text', content: html };
    const on = [textOf(html, true), projections.aiContextText(block)];
    const off = [textOf(html, false), projections.plainText(block)];
    if (on[0] !== on[1]) fuzzed.push({ html, scripting: 'on', chromium: on[0], tokenizer: on[1] });
    if (off[0] !== off[1]) fuzzed.push({ html, scripting: 'off', chromium: off[0], tokenizer: off[1] });
    if (fuzzed.length >= 10) break;
  }
  // html-text.js's one known difference with Chromium here: a hex reference with no digits
  // (`&#x;`) is text, as the standard says and as Chromium's full parser gives it, but Chromium
  // reads it as U+FFFD for some inputs, so either reading of those passes
  const eitherNoDigitReading = (got, text) => got === text.replace(/&#[xX];/g, '�');
  for (const [html, text] of references) {
    const got = textOf(html);
    if (got !== text && !eitherNoDigitReading(got, text)) fixtures.push({ rule: html, got, expected: text });
  }

  const outcome = (fn, block) => {
    try {
      const value = fn(block);
      return JSON.stringify({ type: typeof value, value: value === undefined ? null : value });
    } catch (error) {
      return JSON.stringify({ threw: error && error.name });
    }
  };
  const editor = window.BlockEditor.prototype;
  const chat = window.AIChatController.prototype;
  const notes = window.NotesManager.prototype;
  const settings = window.SettingsController.prototype;
  const callers = {
    // The note list's and the kernel's text, through the projection both now read
    previewText: [block => projections.previewText(block === undefined ? {} : block), legacy.sidebarExtractBlockText],
    editor: [block => editor.extractBlockTextContent.call({}, block), block => legacy.editorExtractBlockTextContent(block, document)],
    chat: [block => chat.extractBlockText.call({}, block), block => legacy.chatExtractBlockText(block, document)],
    aiJobs: [block => notes.extractBlockText.call({}, block), block => legacy.chatExtractBlockText(block, document)],
    markdown: [block => window.AIResponseUtils.blockToMarkdown(block), legacy.blockToMarkdown],
    noteExport: [block => notes.blockToMarkdown.call({}, block), legacy.blockToMarkdown],
    settingsExport: [block => settings.blockToMarkdown.call({}, block), legacy.blockToMarkdown],
  };
  const differences = {};
  for (const [name, [now, then]] of Object.entries(callers)) {
    const found = [];
    for (const [label, block] of corpus.CASES) {
      const got = outcome(now, block);
      const expected = outcome(then, block);
      if (got !== expected) found.push({ label, got, expected });
      if (found.length === 10) break;
    }
    differences[name] = found;
  }
  return { fixtures: fixtures.slice(0, 10), fuzzed, fuzzRead: strings.length, differences, cases: corpus.CASES.length };
}

test('the block projections read text as Chromium does, and every moved caller keeps its 1.4.x output', async ({ extension }) => {
  test.setTimeout(120_000);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);

  const { cases: rules } = JSON.parse(read('html-text-cases.json'));
  const references = JSON.parse(read('character-references.json'));
  const result = await page.evaluate(
    `(${compareInPage.toString()})(${JSON.stringify(rules)}, ${JSON.stringify(references)}, ${moduleExpression(read('corpus.cjs'))}, ${moduleExpression(read('legacy-projections.cjs'))}, ${moduleExpression(read('html-fuzz.cjs'))}, ${FUZZ_STRINGS})`,
  );

  expect(result.cases).toBeGreaterThan(7000);
  expect(result.fuzzRead).toBe(FUZZ_STRINGS);
  // One assertion, so a fixture difference doesn't hide a caller's
  expect({ fixtures: result.fixtures, fuzzed: result.fuzzed, differences: result.differences }).toEqual({
    fixtures: [],
    fuzzed: [],
    differences: {
      previewText: [],
      editor: [],
      chat: [],
      aiJobs: [],
      markdown: [],
      noteExport: [],
      settingsExport: [],
    },
  });
  await expectNoUncaught(extension, page);
});
