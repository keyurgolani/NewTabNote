/**
 * The fields of a note and of a folder a change op may name (#17 PR 4c), as plain lists: every
 * field noteRecord or folderRecord names but its id and `updatedAt`, sorted. A note's versions
 * aren't schema fields, so no op names them, and a field only an imported file named can't land
 * in the log. They're kept apart from the schemas because the differ (domain/changes.js), which
 * #17's adapter runs on every page, takes them, and Popup's and Side Panel's start holds no
 * schema code (build/budgets.json). entities.js builds changeOp from them, and
 * test/kernel/schemas.test.mjs holds each to its record schema.
 */

/** The fields of a note a change op may name */
export const NOTE_OP_FIELDS = Object.freeze([
  'archived',
  'archivedAt',
  'createdAt',
  'dailyDuplicateOf',
  'dailyKey',
  'dailyTimeZone',
  'dateStr',
  'folderId',
  'insights',
  'isDaily',
  'isTemplate',
  'kind',
  'lastAutoTitleAt',
  'lastInsightsContentHash',
  'lastInsightsExtractedAt',
  'lastTitleContentHash',
  'lifecycle',
  'name',
  'pinned',
  'placement',
  'preview',
  'settings',
  'titleManuallySet',
  'todoProgress',
  'trashed',
  'trashedAt',
  'viewport',
]);

/** The fields of a folder a change op may name, as NOTE_OP_FIELDS are a note's */
export const FOLDER_OP_FIELDS = Object.freeze(['collapsed', 'color', 'createdAt', 'name', 'parentId']);
