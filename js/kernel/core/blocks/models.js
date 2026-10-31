/**
 * The 18 built-in block models (#14, approved AC1 and AC2), DOM-free: what each type's records
 * hold, how a version 0 record (1.4.x's, with no `schemaVersion`) becomes version 1, and its
 * projections and Markdown codec. The views, which render and edit, come in slice 4.
 *
 * Every projection and codec here gives what its 1.4.x caller gave, character for character
 * (#14 scope, answer 5: each caller's output is pinned until slice 4 unifies them):
 * - `preview`: the note list's preview and the kernel's note metadata (SidebarUtils'
 *   `extractBlockText` and the kernel's `blockText`), and `search`, the same text, which #22
 *   indexes later;
 * - `plainText`: the editor's text of a block (`extractBlockTextContent`), for content checks,
 *   Turn into, and the note's text, read as #105 left it, in an inert document (scripting off);
 * - `aiContext`: what AI chat and the AI jobs send of a block (their `extractBlockText`);
 * - `codecs.markdown.encode`: every Markdown export (AIResponseUtils.blockToMarkdown).
 * They read a record's fields as 1.4.x did, quirks included (`String(null)` is "null" in a
 * preview, a table row that isn't a list throws where 1.4.x threw), so nothing reads
 * differently; slice 4 cleans them up as a declared change. Markup is read by html-text.js's
 * tokenizer, markup.js and strip-tags.js, never a DOM.
 *
 * A definition has no fetch, credentials, storage, or other notes: each function takes one
 * record and returns a value (#14, "Security and privacy").
 */

import { invalidField } from './fields.js';
import { textContent } from './html-text.js';
import { inlineMarkdown } from './markup.js';
import { PREVIEWS, previewOfContent } from './previews.js';

/** @typedef {import('./fields.js').FieldKind} FieldKind */
/** @typedef {Readonly<Record<string, unknown>>} BlockRecord */

/**
 * A block model, the static `implementation` of a `block` contribution
 * @typedef {object} BlockModel
 * @property {Readonly<Record<string, unknown>>} defaults - what a new block of the type holds
 * @property {Readonly<Record<number, (record: BlockRecord) => BlockRecord>>} upcast - version n to n + 1, each pure
 * @property {(record: BlockRecord) => string | null} validate - the first field that isn't its kind, or null
 * @property {Readonly<{preview: Projection, plainText: Projection, search: Projection, aiContext: Projection}>} project
 * @property {Readonly<{markdown: Readonly<{encode: (record: BlockRecord) => string}>}>} codecs
 * @property {Readonly<{current: BlockRecord, legacy: BlockRecord, newer: BlockRecord, invalid: BlockRecord}>} examples
 *   a version 1 record, a version 0 one as 1.4.x saved it (with a field from a newer build), one
 *   from a newer version, and one whose owned field isn't its kind
 */

/** @typedef {(record: BlockRecord) => unknown} Projection */

/** The fields 1.4.x's `serialize()` writes for every type */
const SHARED = Object.freeze({
  content: /** @type {FieldKind} */ ('richText'),
  indentLevel: /** @type {FieldKind} */ ('number'),
  checked: /** @type {FieldKind} */ ('flag'),
  imageUrl: /** @type {FieldKind} */ ('data'),
  calloutIcon: /** @type {FieldKind} */ ('plainText'),
});

/** What `Block`'s constructor gives those, as a new block holds them */
const SHARED_DEFAULTS = Object.freeze({ content: '', indentLevel: 0, checked: false, imageUrl: null, calloutIcon: '💡' });

/**
 * A field's text as AI chat and the AI jobs read markup: `textContent` after `innerHTML` on a
 * div of the page's document, where scripting is on; empty for anything falsy
 * @param {unknown} html
 */
const text = html => (html ? textContent(String(html)) : '');

/**
 * A field's text as the editor reads markup since #105: the same, on a div of an inert
 * document of its own, where scripting is off
 * @param {unknown} html
 */
const editorText = html => (html ? textContent(String(html), { scripting: false }) : '');

/**
 * The content as Markdown, which every export works out first, whatever the type
 * @param {BlockRecord} record
 */
const markdownContent = record => inlineMarkdown(/** @type {string} */ (record.content || ''));

/**
 * The Markdown 1.4.x gave a type with no case of its own
 * @param {BlockRecord} record
 */
const plainMarkdown = record => {
  const content = markdownContent(record);
  return content ? `${content}\n\n` : '\n';
};

/** @param {BlockRecord} record */
const textOfContent = record => text(record.content || '');
/** @param {BlockRecord} record */
const editorTextOfContent = record => editorText(record.content || '');
const nothing = () => '';

/** Version 0 to 1: the record says its version, and nothing else changes */
const toVersion1 = (/** @type {BlockRecord} */ record) => Object.freeze({ ...record, schemaVersion: 1 });

/**
 * A model from its parts, with the shared fields, defaults, and version 0 upcaster
 * @param {string} type
 * @param {{
 *   fields?: Readonly<Record<string, FieldKind>>,
 *   defaults?: Readonly<Record<string, unknown>>,
 *   preview?: Projection,
 *   plainText?: Projection,
 *   aiContext?: Projection,
 *   markdown?: (record: BlockRecord) => string,
 *   example?: Readonly<Record<string, unknown>>,
 *   invalid?: Readonly<Record<string, unknown>>,
 * }} parts
 * @returns {{fields: Readonly<Record<string, FieldKind>>, model: BlockModel}}
 */
function defineModel(type, parts) {
  const fields = Object.freeze({ ...SHARED, ...parts.fields });
  const preview = parts.preview || previewOfContent;
  const legacy = Object.freeze({
    id: '1730000000000-a1b2c3d4e',
    type,
    ...SHARED_DEFAULTS,
    content: 'Some <b>text</b>',
    ...parts.defaults,
    ...parts.example,
    createdAt: 1730000000000,
    updatedAt: 1730000000500,
    canvasId: '1730000000000-n0te',
    order: 0,
    // A field this build doesn't know, which the opaque rule carries through
    futureField: 'kept',
  });
  /** @type {BlockModel} */
  const model = {
    defaults: Object.freeze({ ...SHARED_DEFAULTS, ...parts.defaults }),
    upcast: Object.freeze({ 0: toVersion1 }),
    validate: record => invalidField(fields, record),
    project: Object.freeze({
      preview,
      plainText: parts.plainText || nothing,
      search: preview,
      aiContext: parts.aiContext || nothing,
    }),
    codecs: Object.freeze({ markdown: Object.freeze({ encode: parts.markdown || plainMarkdown }) }),
    examples: Object.freeze({
      current: Object.freeze({ ...legacy, schemaVersion: 1 }),
      legacy,
      newer: Object.freeze({ ...legacy, schemaVersion: 2, newerField: { shape: 'unknown' } }),
      invalid: Object.freeze({ ...legacy, ...(parts.invalid || { content: { not: 'text' } }) }),
    }),
  };
  return { fields, model: Object.freeze(model) };
}

/**
 * A text-like type: its content is the block's text, and its Markdown is `prefix` + content
 * @param {string} type
 * @param {(record: BlockRecord, content: string) => string} markdown
 */
const textType = (type, markdown) =>
  defineModel(type, {
    plainText: editorTextOfContent,
    aiContext: textOfContent,
    markdown: record => markdown(record, markdownContent(record)),
  });

/** @type {Readonly<Record<string, {fields: Readonly<Record<string, FieldKind>>, model: BlockModel}>>} */
export const MODELS = Object.freeze({
  text: defineModel('text', { plainText: editorTextOfContent, aiContext: textOfContent }),
  h1: textType('h1', (_r, content) => `# ${content}\n\n`),
  h2: textType('h2', (_r, content) => `## ${content}\n\n`),
  h3: textType('h3', (_r, content) => `### ${content}\n\n`),
  bullet: textType('bullet', (_r, content) => `- ${content}\n`),
  numbered: textType('numbered', (_r, content) => `1. ${content}\n`),
  todo: defineModel('todo', {
    plainText: editorTextOfContent,
    aiContext: textOfContent,
    markdown: record => {
      const content = markdownContent(record);
      return `- [${record.checked ? 'x' : ' '}] ${content}\n`;
    },
    example: { checked: true },
  }),
  toggle: defineModel('toggle', {
    fields: { collapsed: 'flag', children: 'richText' },
    defaults: { collapsed: true, children: '' },
    preview: PREVIEWS.toggle,
    plainText: record => editorText(record.content || '') + ' ' + editorText(record.children || ''),
    aiContext: record => [text(record.content || ''), text(record.children || '')].filter(t => t).join('\n'),
    markdown: record => {
      const content = markdownContent(record);
      return `<details>\n<summary>${content}</summary>\n${inlineMarkdown(/** @type {string} */ (record.children || ''))}\n</details>\n\n`;
    },
    example: { children: 'Inside <i>it</i>' },
    invalid: { children: ['not', 'text'] },
  }),
  quote: textType('quote', (_r, content) => `> ${content}\n\n`),
  code: defineModel('code', {
    plainText: editorTextOfContent,
    // AI reads code as it's stored, markup and all
    aiContext: record => record.content || '',
    markdown: record => {
      // Unused, but 1.4.x worked the content out first for every type, so content it can't
      // read throws here as it did then
      markdownContent(record);
      return `\`\`\`\n${record.content || ''}\n\`\`\`\n\n`;
    },
    example: { content: 'const a = 1 < 2;' },
  }),
  divider: defineModel('divider', {
    markdown: record => {
      // Unused, but 1.4.x worked the content out first for every type, so content it can't
      // read throws here as it did then
      markdownContent(record);
      return `---\n\n`;
    },
    example: { content: '' },
  }),
  callout: textType('callout', (record, content) => `> ${record.calloutIcon || '💡'} ${content}\n\n`),
  image: defineModel('image', {
    markdown: record => {
      const content = markdownContent(record);
      return record.imageUrl || record.src
        ? `![${record.caption || content}](${record.imageUrl || record.src})\n\n`
        : '';
    },
    example: { content: '', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    invalid: { imageUrl: { url: 'x' } },
  }),
  table: defineModel('table', {
    fields: { rows: 'number', cols: 'number', tableData: 'grid', hasHeaderRow: 'flag' },
    defaults: { rows: 2, cols: 2, tableData: null, hasHeaderRow: true },
    preview: PREVIEWS.table,
    plainText: record => {
      const rows = /** @type {any} */ (record.tableData);
      return rows && Array.isArray(rows) ? rows.map(row => row.join(' ')).join(' ') : '';
    },
    aiContext: record => {
      const rows = /** @type {any} */ (record.tableData);
      return rows && Array.isArray(rows) ? rows.map(row => row.join(' ')).join('\n') : '';
    },
    markdown: record => {
      // Unused, but 1.4.x worked the content out first for every type, so content it can't
      // read throws here as it did then
      markdownContent(record);
      const rows = /** @type {any} */ (record.tableData);
      if (rows && rows.length > 0) {
        let md = '';
        rows.forEach((/** @type {any} */ row, /** @type {number} */ i) => {
          md += '| ' + row.join(' | ') + ' |\n';
          if (i === 0) {
            md += '| ' + row.map(() => '---').join(' | ') + ' |\n';
          }
        });
        return md + '\n';
      }
      return '';
    },
    example: { content: '', tableData: [['Name', 'Age'], ['Ada', '36']] },
    invalid: { tableData: 'Name,Age' },
  }),
  bookmark: defineModel('bookmark', {
    fields: { url: 'url', title: 'plainText', description: 'plainText', favicon: 'url' },
    defaults: { url: '', title: '', description: '', favicon: '' },
    preview: PREVIEWS.bookmark,
    aiContext: record => record.title || record.url || '',
    markdown: record => {
      // Unused, but 1.4.x worked the content out first for every type, so content it can't
      // read throws here as it did then
      markdownContent(record);
      return record.url ? `[${record.title || record.url}](${record.url})\n\n` : '';
    },
    example: { content: '', url: 'https://example.test/page', title: 'Example page', description: 'A page' },
    invalid: { url: ['https://example.test'] },
  }),
  video: defineModel('video', {
    fields: { videoUrl: 'url' },
    defaults: { videoUrl: '' },
    preview: PREVIEWS.video,
    example: { content: '', videoUrl: 'https://www.youtube.com/watch?v=abc' },
    invalid: { videoUrl: 42 },
  }),
  file: defineModel('file', {
    fields: { fileName: 'plainText', fileSize: 'number', fileData: 'data' },
    defaults: { fileName: '', fileSize: 0, fileData: null },
    preview: PREVIEWS.file,
    example: { content: '', fileName: 'notes.txt', fileSize: 5, fileData: 'data:text/plain;base64,aGVsbG8=' },
    invalid: { fileSize: '5 bytes' },
  }),
  equation: defineModel('equation', {
    fields: { equation: 'plainText' },
    defaults: { equation: '' },
    preview: PREVIEWS.equation,
    aiContext: record => record.equation || '',
    markdown: record => {
      // Unused, but 1.4.x worked the content out first for every type, so content it can't
      // read throws here as it did then
      markdownContent(record);
      return `$$\n${record.equation || ''}\n$$\n\n`;
    },
    example: { content: '', equation: 'E = mc^2' },
    invalid: { equation: { tex: 'E' } },
  }),
});

/**
 * What a projection gives a record of a type no enabled definition owns (an unknown type, a
 * record with none, or a disabled one), as each 1.4.x caller's fallthrough gave it: the note
 * list reads its content, the editor and AI read nothing, and Markdown exports its content
 * @type {Readonly<{preview: Projection, plainText: Projection, search: Projection, aiContext: Projection, markdown: (record: BlockRecord) => string}>}
 */
export const OPAQUE_PROJECTIONS = Object.freeze({
  preview: previewOfContent,
  plainText: nothing,
  search: previewOfContent,
  aiContext: nothing,
  markdown: plainMarkdown,
});
