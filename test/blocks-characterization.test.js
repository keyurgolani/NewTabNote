'use strict';

// #14 slice 1 (answer 5): the five plain-text extractors and three Markdown exporters that
// moved onto the block projections and codec give what they gave on `next` (1c9bff7), byte for
// byte, where they disagree with each other too. Each production caller runs on every corpus
// case (test/fixtures/blocks/corpus.cjs) beside its 1.4.x copy
// (test/fixtures/blocks/legacy-projections.cjs), and the two give the same value, or throw the
// same class of error.
//
// The copies that read text through a div's innerHTML run here on a document whose divs read
// text with html-text.js, so this pins each caller's own rules (which types, which fields, how
// they join, which document they parse in); e2e/block-projections.spec.js runs them on
// Chromium's DOM, which pins the text.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLegacyEnv } = require('./helpers/legacy-env');
const { CASES } = require('./fixtures/blocks/corpus.cjs');
const legacy = require('./fixtures/blocks/legacy-projections.cjs');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
  'js/ai-response-utils.js',
  'js/controllers/notes-manager.js',
  'js/controllers/settings-controller.js',
  'js/controllers/ai-chat-controller.js',
];

/** What a call gave: its value, or the name of the error class it threw */
function outcome(fn, block) {
  try {
    return { value: fn(block) };
  } catch (error) {
    return { threw: error && error.name };
  }
}

/** Each case where `now` and `then` give different outcomes, at most 10 */
function differences(now, then) {
  const found = [];
  for (const [name, block] of CASES) {
    const got = outcome(now, block);
    const expected = outcome(then, block);
    try {
      assert.deepStrictEqual(got, expected);
    } catch {
      found.push({ name, got, expected });
      if (found.length === 10) break;
    }
  }
  return found;
}

/**
 * A document whose divs read their innerHTML's text with html-text.js: the page's, where
 * scripting is on, and the inert ones it makes, where it's off
 */
function tokenizerDocument(textContent, scripting = true) {
  return {
    createElement() {
      let html = '';
      return {
        set innerHTML(value) { html = value; },
        get textContent() { return textContent(html, { scripting }); },
      };
    },
    implementation: { createHTMLDocument: () => tokenizerDocument(textContent, false) },
  };
}

let env;
let kernel;
let blocks;
let previews;
let registries;
let doc;

before(async () => {
  env = createLegacyEnv();
  env.load(...FILES);
  kernel = await import(pathToFileURL(path.join(ROOT, 'js/kernel/core/domain/note.js')).href);
  blocks = await import(pathToFileURL(path.join(ROOT, 'js/kernel/core/blocks/index.js')).href);
  previews = await import(pathToFileURL(path.join(ROOT, 'js/kernel/core/blocks/previews.js')).href);
  registries = await import(pathToFileURL(path.join(ROOT, 'js/kernel/composition/blocks.js')).href);
  const { textContent } = await import(pathToFileURL(path.join(ROOT, 'js/kernel/core/blocks/html-text.js')).href);
  doc = tokenizerDocument(textContent);
});

describe("each moved caller keeps its 1.4.x output (#14 slice 1, answer 5)", () => {
  it('has a corpus that covers every built-in type, an unknown one, and values that are not blocks', () => {
    assert.ok(CASES.length > 7000, `${CASES.length} cases`);
    const types = new Set(CASES.map(([, block]) => block && typeof block === 'object' ? block.type : typeof block));
    for (const type of ['text', 'toggle', 'table', 'bookmark', 'equation', 'file', 'video', 'image', 'code', 'unknown-type']) {
      assert.ok(types.has(type), type);
    }
    assert.ok(types.has('undefined') && types.has('function'));
  });

  it("the note list's text: SidebarUtils' extractBlockText, through the preview buildNoteSaveMetadata makes", () => {
    const SidebarUtils = env.get('SidebarUtils');
    // The rest of buildNoteSaveMetadata didn't change: it reads `block.type` after the text,
    // so a block that's null or undefined throws there, then and now
    const then = block => {
      const text = legacy.sidebarExtractBlockText(block);
      void block.type;
      return SidebarUtils.truncateText(text);
    };
    assert.deepEqual(differences(block => SidebarUtils.buildNoteSaveMetadata([block]).preview, then), []);
    // extractBlockText itself, which defaults a missing block to {}
    assert.deepEqual(differences(block => blocks.previewText(block === undefined ? {} : block), legacy.sidebarExtractBlockText), []);
  });

  it("the kernel's note text, and the preview noteSaveMetadata makes from it", () => {
    // 1.4.x read `block.type` first, so a block that's null or undefined threw; the note's
    // metadata still does, where it reads `type`
    const then = block => {
      const text = legacy.kernelBlockText(block);
      return text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text;
    };
    assert.deepEqual(differences(block => kernel.noteSaveMetadata([block]).preview, then), []);
    const objects = CASES.filter(([, block]) => block !== null && block !== undefined);
    for (const [name, block] of objects) assert.equal(blocks.previewText(block), legacy.kernelBlockText(block), name);
  });

  it("the editor's text: BlockEditor.extractBlockTextContent", () => {
    const editor = env.get('BlockEditor').prototype;
    assert.deepEqual(differences(block => editor.extractBlockTextContent.call({}, block), block => legacy.editorExtractBlockTextContent(block, doc)), []);
  });

  it("AI chat's text: AIChatController.extractBlockText", () => {
    const chat = env.get('AIChatController').prototype;
    assert.deepEqual(differences(block => chat.extractBlockText.call({}, block), block => legacy.chatExtractBlockText(block, doc)), []);
  });

  it("the AI jobs' text: NotesManager.extractBlockText, which was AI chat's", () => {
    const notes = env.get('NotesManager').prototype;
    assert.deepEqual(differences(block => notes.extractBlockText.call({}, block), block => legacy.chatExtractBlockText(block, doc)), []);
  });

  // NotesManager's and SettingsController's own exporters ran only without AIResponseUtils,
  // which the new tab always loads first, so all three wrote AIResponseUtils.blockToMarkdown's
  for (const [label, read] of [
    ['AIResponseUtils.blockToMarkdown', () => env.get('AIResponseUtils').blockToMarkdown],
    ["NotesManager.blockToMarkdown (a note's export)", () => {
      const notes = env.get('NotesManager').prototype;
      return block => notes.blockToMarkdown.call({}, block);
    }],
    ["SettingsController.blockToMarkdown (the Markdown export)", () => {
      const settings = env.get('SettingsController').prototype;
      return block => settings.blockToMarkdown.call({}, block);
    }],
  ]) {
    it(`Markdown: ${label}`, () => {
      assert.deepEqual(differences(read(), legacy.blockToMarkdown), []);
    });
  }

  it('the callers read through the page\'s BlockProjections, the same projections the kernel runs', () => {
    const projections = env.get('BlockProjections');
    assert.equal(projections.PROJECTION_VERSION, blocks.PROJECTION_VERSION);
    for (const name of ['previewText', 'searchText', 'plainText', 'aiContextText']) {
      assert.deepEqual(differences(block => projections[name](block), block => blocks[name](block)), [], name);
    }
    assert.deepEqual(differences(block => projections.markdownOf(block), block => blocks.markdownOf(block)), []);
  });

  it("a root's block registry on #15's kit projects as the built-ins' catalog the new tab reads", () => {
    const { projections } = registries.createBlockRegistry({ host: 'workspace' });
    for (const name of ['previewText', 'searchText', 'plainText', 'aiContextText', 'markdownOf']) {
      assert.deepEqual(differences(block => projections[name](block), block => blocks[name](block)), [], name);
    }
  });

  it("previews.js, which the note domain reads, previews as the catalog does", () => {
    assert.deepEqual(differences(previews.previewText, blocks.previewText), []);
    assert.deepEqual(differences(previews.previewText, blocks.searchText), []);
  });
});
