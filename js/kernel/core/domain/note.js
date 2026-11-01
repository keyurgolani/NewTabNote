/**
 * Notes and their blocks, as IndexedDB has stored them since 1.4.0. No kernel slice changes
 * a record's shape (#12, "Data and migration"), so the field names stay: a block names its
 * note in `canvasId`. Stored records can lack fields (Popup wrote four-field notes until
 * slice 4), and every function here takes that into account.
 */

import { previewText } from '../blocks/previews.js';
import { escapeAttributeText, escapePlainText } from '../blocks/rich-text.js';

/**
 * @typedef {object} NoteFields
 * @property {string} name
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} archived
 * @property {number | null} archivedAt
 * @property {boolean} trashed
 * @property {number | null} trashedAt
 * @property {boolean} titleManuallySet
 * @property {number | null} lastAutoTitleAt
 * @property {string} lastTitleContentHash
 * @property {unknown} insights
 * @property {number | null} lastInsightsExtractedAt
 * @property {string} lastInsightsContentHash
 * @property {string} preview
 * @property {boolean} pinned
 * @property {{completed: number, total: number} | null} todoProgress - null for a note with no todos
 * @property {boolean} isDaily
 * @property {string | null} dateStr
 * @property {boolean} isTemplate
 * @property {string | null} folderId
 * @property {{scale: number, offsetX: number, offsetY: number}} viewport
 * @property {{gridType: string, backgroundColor: string}} settings
 */

/** @typedef {{id: string} & Partial<NoteFields> & Record<string, unknown>} NoteRecord */

/**
 * @typedef {object} BlockFields
 * @property {string} type
 * @property {number} order
 * @property {unknown} content
 */

/** @typedef {{id: string, canvasId: string} & Partial<BlockFields> & Record<string, unknown>} BlockRecord */

/**
 * A block as a command carries it: `canvasId` may be left out, and the kernel fills in the
 * note the command names.
 * @typedef {{id: string, canvasId?: string} & Record<string, unknown>} BlockInput
 */

/**
 * The search_index entry each note has.
 * @typedef {{noteId: string, name?: unknown, content?: unknown, updatedAt?: unknown} & Record<string, unknown>} SearchEntry
 */

/**
 * One wiki link, from the note whose text holds `[[name]]` to the note with that name, as
 * Storage.updateNoteLinks has stored them in the `links` store since 1.4.0.
 * @typedef {{id: string, fromNoteId?: unknown, toNoteId?: unknown, createdAt?: unknown} & Record<string, unknown>} LinkRecord
 */

/**
 * What a capture adds to today's Daily Note: a page, or selected text and the page it came
 * from. A tab can lack a URL or title, and the block then lacks it too, as before.
 * @typedef {{type: 'bookmark', url?: string, title?: string} | {type: 'text', content: string, source?: string}} Capture
 */

/** The fields attachInsights writes, and no others */
export const INSIGHT_FIELDS = Object.freeze(['insights', 'lastInsightsExtractedAt', 'lastInsightsContentHash']);

/**
 * The note fields derived from its content (#17's derived scope): the only ones a derived
 * write may change. Not `updatedAt`, so a derived write never reorders a list.
 */
export const DERIVED_FIELDS = Object.freeze(['preview', 'todoProgress', ...INSIGHT_FIELDS]);

/**
 * A new note, field for field the one Storage.createNote has written since 1.4.0, pinned or with
 * a title set by hand when it carries over a note the editor saved as a new one.
 * @param {object} fields
 * @param {string} fields.id
 * @param {string} fields.name
 * @param {number} fields.now
 * @param {string | null} [fields.folderId]
 * @param {boolean} [fields.pinned]
 * @param {boolean} [fields.titleManuallySet]
 * @returns {NoteRecord}
 */
export function newNoteRecord({ id, name, now, folderId = null, pinned = false, titleManuallySet = false }) {
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    archived: false,
    archivedAt: null,
    titleManuallySet,
    lastAutoTitleAt: null,
    insights: null,
    lastInsightsExtractedAt: null,
    preview: '',
    pinned,
    todoProgress: null,
    isDaily: false,
    dateStr: null,
    isTemplate: false,
    folderId,
    viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    settings: { gridType: 'dots', backgroundColor: '#fafafa' },
  };
}

/**
 * @param {{id: string, name?: unknown}} note
 * @param {number} now
 * @returns {SearchEntry}
 */
export function newSearchEntry(note, now) {
  return { noteId: note.id, name: note.name, content: '', updatedAt: now };
}

/**
 * Whether a note has no title of its own, as Storage.isNoteUntitled decides it. A name that
 * isn't a string counts as a title, so trashing never deletes a note it can't read.
 * @param {NoteRecord} note
 * @returns {boolean}
 */
export function isUntitled(note) {
  if (!note.name) return true;
  if (typeof note.name !== 'string') return false;
  const name = note.name.toLowerCase().trim();
  return name === '' || name === 'untitled' || /^untitled\s*\d*$/.test(name);
}

/**
 * Whether a block holds nothing, as Storage.isEmptyTextBlock decides it: a text block (a
 * block with no type is one) whose content is only spaces, line breaks, and non-breaking
 * spaces. Any other block holds something, an image, a table, or a divider included, and so
 * does a text block with any other markup.
 * @param {BlockRecord} block
 * @returns {boolean}
 */
function isEmptyTextBlock(block) {
  if ((block.type || 'text') !== 'text') return false;
  return (
    String(block.content || '')
      .replace(/<br\s*\/?>|&nbsp;/gi, '')
      .trim() === ''
  );
}

/**
 * Whether blocks hold nothing, as Storage.isNoteEmpty decides it: every block is an empty
 * text block, or there are none. The export notice goes by the same rule.
 * @param {BlockRecord[]} blocks
 * @returns {boolean}
 */
export function isEmpty(blocks) {
  return blocks.every(isEmptyTextBlock);
}

// ============ Trash retention ============

/** A day, in milliseconds, as Storage.cleanupTrash counts trash retention */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many days a note stays in the trash, from the stored trashRetention preference, as
 * Storage.cleanupTrash used it: 30 with nothing stored, and null, never cleaned up, for 0 or
 * anything else that isn't above 0. Settings stores a number, and a numeric string counts
 * as Storage's arithmetic read it.
 * @param {unknown} stored
 * @returns {number | null}
 */
export function trashRetentionDays(stored) {
  if (stored === undefined) return 30;
  const days = typeof stored === 'string' && stored.trim() !== '' ? Number(stored) : stored;
  return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * The trashed notes trash retention deletes at `now`: in the trash since before `days` days
 * ago, as Storage.cleanupTrash picks them from getTrashedNotes, latest trashed first
 * @param {NoteRecord[]} notes - every stored note
 * @param {number} now
 * @param {number} days
 * @returns {NoteRecord[]}
 */
export function expiredInTrash(notes, now, days) {
  const cutoff = now - days * DAY_MS;
  return notesInView(notes, 'trashed').filter(
    note => typeof note.trashedAt === 'number' && note.trashedAt !== 0 && note.trashedAt < cutoff,
  );
}

// ============ Lists ============

/**
 * The lists the sidebar, archive, trash, and template views show:
 * - `active`: not trashed, archived, or a template (Storage.getAllNotes())
 * - `withArchived`: not trashed or a template (Storage.getAllNotes(true))
 * - `archived`: archived and not trashed, latest archived first
 * - `trashed`: latest trashed first
 * - `templates`: templates not trashed, latest updated first
 *
 * And what Popup and Side Panel have read since 1.4.0, which #4 and #5 replace when they
 * rebuild them:
 * - `popup`: no `archivedAt` or `trashedAt`, templates included, latest updated first
 * - `sidePanel`: every note, latest updated first
 * @typedef {'active' | 'withArchived' | 'archived' | 'trashed' | 'templates' | 'popup' | 'sidePanel'} NoteView
 */

/** @type {readonly NoteView[]} */
export const NOTE_VIEWS = Object.freeze([
  'active',
  'withArchived',
  'archived',
  'trashed',
  'templates',
  'popup',
  'sidePanel',
]);

/**
 * The order of two IndexedDB keys of the kinds `updatedAt` holds: numbers, then Dates,
 * then strings.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function compareKeys(a, b) {
  const rank = /** @param {unknown} key */ key => (typeof key === 'number' ? 0 : key instanceof Date ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const left = a instanceof Date ? a.getTime() : /** @type {number | string} */ (a);
  const right = b instanceof Date ? b.getTime() : /** @type {number | string} */ (b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {unknown} value
 * @returns {boolean} whether an IndexedDB index on the field lists the record
 */
export function isIndexKey(value) {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') return true;
  return (
    Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(/** @type {Date} */ (value).getTime())
  );
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function timeOf(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
}

/**
 * One view's notes, in the order Storage lists them. Storage reads through the `updatedAt`
 * index, which leaves out a record without a usable `updatedAt`, so this does too.
 * @param {NoteRecord[]} notes
 * @param {NoteView} view
 * @returns {NoteRecord[]}
 */
export function notesInView(notes, view) {
  const indexed = notes
    .filter(note => isIndexKey(note.updatedAt))
    .sort((a, b) => compareKeys(a.updatedAt, b.updatedAt) || compareKeys(a.id, b.id));
  switch (view) {
    case 'active':
      return indexed.reverse().filter(note => !note.trashed && !note.isTemplate && !note.archived);
    case 'withArchived':
      return indexed.reverse().filter(note => !note.trashed && !note.isTemplate);
    case 'archived':
      return indexed
        .filter(note => note.archived && !note.trashed)
        .sort((a, b) => timeOf(b.archivedAt) - timeOf(a.archivedAt));
    case 'trashed':
      return indexed.filter(note => note.trashed).sort((a, b) => timeOf(b.trashedAt) - timeOf(a.trashedAt));
    case 'templates':
      return indexed
        .filter(note => note.isTemplate && !note.trashed)
        .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt));
    case 'popup':
      return indexed.reverse().filter(note => !note.archivedAt && !note.trashedAt);
    case 'sidePanel':
      return indexed.reverse();
  }
}

/**
 * The notes a note's wiki links point at, as Storage.updateNoteLinks finds them: for each name,
 * the first note in the `withArchived` list with that name, whatever its case, unless that's
 * the linking note itself. Each note once, in the order the names first reach it.
 * @param {NoteRecord[]} notes
 * @param {readonly string[]} names
 * @param {string} fromNoteId
 * @returns {string[]}
 */
export function linkTargets(notes, names, fromNoteId) {
  const named = notesInView(notes, 'withArchived').filter(note => typeof note.name === 'string' && note.name !== '');
  /** @type {string[]} */
  const targets = [];
  for (const name of names) {
    const wanted = name.toLowerCase();
    const target = named.find(note => /** @type {string} */ (note.name).toLowerCase() === wanted);
    if (target && target.id !== fromNoteId && !targets.includes(target.id)) targets.push(target.id);
  }
  return targets;
}

/**
 * Blocks in note order: by `order`, then by id.
 * @param {BlockRecord[]} blocks
 * @returns {BlockRecord[]}
 */
export function inBlockOrder(blocks) {
  return [...blocks].sort((a, b) => timeOf(a.order) - timeOf(b.order) || compareKeys(a.id, b.id));
}

// ============ What a note's blocks give it ============

/** How long a note's preview is, as SidebarUtils keeps it */
const PREVIEW_LENGTH = 120;

/**
 * A note's preview and todo progress from its blocks in note order, as
 * SidebarUtils.buildNoteSaveMetadata makes them: the first text any block shows, cut to 120
 * characters with an ellipsis, and how many of its todos are checked, or null for none
 * @param {BlockRecord[]} blocks
 * @returns {{preview: string, todoProgress: {completed: number, total: number} | null}}
 */
export function noteSaveMetadata(blocks) {
  let preview = '';
  let completed = 0;
  let total = 0;
  for (const block of blocks) {
    const text = previewText(block);
    if (!preview && text) preview = text;
    if (block.type === 'todo') {
      total += 1;
      if (block.checked) completed += 1;
    }
  }
  if (preview.length > PREVIEW_LENGTH) preview = `${preview.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
  return { preview, todoProgress: total > 0 ? { completed, total } : null };
}

// The note names `[[wiki links]]` in a text hold, trimmed, each once, which the editor's save
// reads too: the model layer's, in linear time
export { wikiLinkNames } from '../blocks/wiki-links.js';

/**
 * The text an AI insert reads a note's wiki links from: each block's content, or its title or
 * caption when it has no content, one block a line, as AIChatController's insert read them
 * @param {BlockRecord[]} blocks
 * @returns {string}
 */
export function insertLinkText(blocks) {
  return blocks
    .map(block => block.content || block.title || block.caption || '')
    .filter(Boolean)
    .join('\n');
}

// ============ Daily Notes ============

/**
 * The `dateStr` of the Daily Note for `now`. It's the UTC date, as background.js has always
 * computed it, while the note's name uses the local date.
 * @param {number} now
 * @returns {string}
 */
export function dailyDateStr(now) {
  return new Date(now).toISOString().split('T')[0];
}

/**
 * @param {number} now
 * @returns {string}
 */
export function dailyNoteName(now) {
  const date = new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `Daily Note - ${date}`;
}

/**
 * Whether `value` is a `dateStr` as a Daily Note holds one: `YYYY-MM-DD`, a day the calendar
 * can name
 * @param {unknown} value
 * @returns {value is string}
 */
export function isDateStr(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
  );
}

/**
 * The name of the Daily Note for the calendar day `dateStr`, as Storage.ensureDailyNoteForDate
 * names it: the day's local midnight, in dailyNoteName's format.
 * @param {string} dateStr
 * @returns {string}
 */
export function dailyNoteNameFor(dateStr) {
  return dailyNoteName(new Date(`${dateStr}T00:00:00`).getTime());
}

/**
 * The Daily Note for `dateStr` among `notes`, as Storage.ensureDailyNoteForDate finds it: the
 * first in the `withArchived` list with that `dateStr`.
 * @param {NoteRecord[]} notes
 * @param {string} dateStr
 * @returns {NoteRecord | undefined}
 */
export function findDailyNoteFor(notes, dateStr) {
  return notesInView(notes, 'withArchived').find(note => note.isDaily && note.dateStr === dateStr);
}

/**
 * Today's Daily Note among `notes`, as Storage.getTodayNote finds it: the first in the
 * `withArchived` list whose `dateStr` is today's.
 * @param {NoteRecord[]} notes
 * @param {number} now
 * @returns {NoteRecord | undefined}
 */
export function findDailyNote(notes, now) {
  return findDailyNoteFor(notes, dailyDateStr(now));
}

/**
 * A new Daily Note: the record Storage.createNote writes, with the `isDaily` and `dateStr` that
 * 1.4.x's ensureDailyNote wrote over it in a second write, here in the first.
 * @param {{id: string, name: string, dateStr: string, now: number}} fields
 * @returns {NoteRecord}
 */
export function newDailyNoteRecord({ id, name, dateStr, now }) {
  return { ...newNoteRecord({ id, name, now }), isDaily: true, dateStr };
}

/**
 * Copies of a template's blocks for a new note, with {{date}}, {{time}}, {{title}}, and
 * {{datetime}} filled in, as Storage.applyTemplateToNote makes them. The values are plain text:
 * escaped into rich `content`, for its text and its attributes alike (#14 slice 2), and as they
 * are in a table's plain-text cells.
 * @param {BlockRecord[]} templateBlocks
 * @param {{noteId: string, title: unknown, now: number, nextId: () => string}} target
 * @returns {BlockRecord[]}
 */
export function blocksFromTemplate(templateBlocks, { noteId, title, now, nextId }) {
  const date = new Date(now);
  /** @type {Array<[string, string]>} */
  const variables = [
    ['{{date}}', date.toLocaleDateString()],
    ['{{time}}', date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })],
    ['{{title}}', typeof title === 'string' && title ? title : 'Untitled'],
    ['{{datetime}}', date.toLocaleString()],
  ];
  /**
   * @param {unknown} text
   * @param {(value: string) => string} as - how a value is written into the field
   */
  const fill = (text, as) =>
    typeof text === 'string' ? variables.reduce((result, [key, value]) => result.split(key).join(as(value)), text) : text;
  /** @param {string} value */
  const asText = value => value;
  return templateBlocks.map(block => {
    /** @type {BlockRecord} */
    const copy = { ...block, id: nextId(), canvasId: noteId, createdAt: now, updatedAt: now };
    if (copy.content) copy.content = fill(copy.content, escapeAttributeText);
    if (Array.isArray(copy.tableData)) {
      copy.tableData = copy.tableData.map(row => (Array.isArray(row) ? row.map(cell => fill(cell, asText)) : row));
    }
    return copy;
  });
}

/**
 * The block a capture adds, as background.js has built it, with the time it was captured as its
 * createdAt and updatedAt too (#17 PR 2a). 1.4.x's capture had neither, and its id began with
 * that time. A UUID doesn't, and the readers that list a note's blocks in the order they were
 * made go by createdAt then (Utils.inCreationOrder). A page's URL and title go into a
 * bookmark's plain-text fields. Selected text and the page it came from are plain text in a
 * text block's rich content, so they're escaped into it (#14 slice 2): the block shows them as
 * they were selected.
 * @param {{id: string, noteId: string, capture: Capture, now: number}} fields
 * @returns {BlockRecord}
 */
export function captureBlock({ id, noteId, capture, now }) {
  const times = { order: now, createdAt: now, updatedAt: now };
  if (capture.type === 'bookmark') {
    return { id, type: 'bookmark', content: '', url: capture.url, title: capture.title, canvasId: noteId, ...times };
  }
  const source = capture.source ? ` (Source: ${escapePlainText(capture.source)})` : '';
  return { id, type: 'text', content: escapePlainText(capture.content) + source, canvasId: noteId, ...times };
}
