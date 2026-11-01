/**
 * The records payloads and projections carry (#13, AC1): notes, blocks, folders, and #17's
 * change records. #17 validates each record it reads against these, once it has upcast it,
 * and #18 validates what it imports.
 *
 * A record keeps the fields 1.4.x stores (domain/note.js, domain/folder.js) and any field this
 * build doesn't know, so a record a newer build or #17's migrations wrote reads back whole.
 * Every field but the id is optional, since a stored record can lack later fields (Popup
 * wrote four-field notes until #12 slice 4). A block's every field can carry what the user
 * wrote, so a whole block is content.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { ENTITY_TYPES, commitSeq, content, entityId, id, revision, timestamp } from './fields.js';

/** `YYYY-MM-DD` */
const dateStr = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/));

const nullableTime = v.nullable(timestamp);

/** #1's Placement (js/product/placement.js), which #17 PR 3a writes beside a note's flags */
const placement = v.variant('kind', [
  v.looseObject({ kind: v.literal('inbox') }),
  v.looseObject({ kind: v.literal('collection'), folderId: v.nullable(entityId('folder')) }),
  v.looseObject({ kind: v.literal('daily'), dateKey: dateStr }),
]);

/** A note, as IndexedDB's `canvases` store holds it */
export const noteRecord = v.looseObject({
  id: entityId('note'),
  name: v.optional(content(v.string())),
  createdAt: v.optional(timestamp),
  updatedAt: v.optional(timestamp),
  archived: v.optional(v.boolean()),
  archivedAt: v.optional(nullableTime),
  trashed: v.optional(v.boolean()),
  trashedAt: v.optional(nullableTime),
  titleManuallySet: v.optional(v.boolean()),
  lastAutoTitleAt: v.optional(nullableTime),
  lastTitleContentHash: v.optional(v.string()),
  insights: v.optional(content(v.unknown())),
  lastInsightsExtractedAt: v.optional(nullableTime),
  lastInsightsContentHash: v.optional(v.string()),
  preview: v.optional(content(v.string())),
  pinned: v.optional(v.boolean()),
  todoProgress: v.optional(v.nullable(v.looseObject({ completed: v.number(), total: v.number() }))),
  isDaily: v.optional(v.boolean()),
  dateStr: v.optional(v.nullable(dateStr)),
  isTemplate: v.optional(v.boolean()),
  folderId: v.optional(v.nullable(entityId('folder'))),
  viewport: v.optional(v.looseObject({ scale: v.number(), offsetX: v.number(), offsetY: v.number() })),
  settings: v.optional(v.looseObject({ gridType: v.string(), backgroundColor: v.string() })),
  // #17 PR 3a's, which follow the flags (domain/placement.js)
  placement: v.optional(placement),
  kind: v.optional(v.picklist(['note', 'template'])),
  lifecycle: v.optional(v.picklist(['active', 'archived', 'trashed'])),
  // #17 PR 3b's, a Daily Note's local date beside its dateStr (domain/daily.js)
  dailyKey: v.optional(dateStr),
  dailyTimeZone: v.optional(v.nullable(v.string())),
  dailyDuplicateOf: v.optional(v.nullable(entityId('note'))),
});

/**
 * A block, as IndexedDB's `elements` store holds it. `canvasId` names its note, and `content`
 * takes whatever shape the block's type gives it.
 */
export const blockRecord = content(
  v.looseObject({
    id: entityId('block'),
    canvasId: entityId('note'),
    type: v.optional(v.string()),
    order: v.optional(v.number()),
    content: v.optional(v.unknown()),
  }),
);

/** A block as a command carries it: `canvasId` may be left out, and the kernel fills it in */
export const blockInput = content(
  v.looseObject({
    id: entityId('block'),
    canvasId: v.optional(entityId('note')),
  }),
);

/** A folder, as IndexedDB's `folders` store holds it. A root folder's `parentId` is null. */
export const folderRecord = v.looseObject({
  id: entityId('folder'),
  name: v.optional(content(v.string())),
  parentId: v.optional(v.nullable(entityId('folder'))),
  createdAt: v.optional(timestamp),
  updatedAt: v.optional(timestamp),
  color: v.optional(v.nullable(v.string())),
  collapsed: v.optional(v.boolean()),
});

/**
 * A note's search entry, as IndexedDB's `search_index` store holds it: the note's name, its
 * text, and the tags #22's indexer finds, so the whole entry is content.
 */
export const searchEntryRecord = content(
  v.looseObject({
    noteId: entityId('note'),
    name: v.optional(v.unknown()),
    content: v.optional(v.unknown()),
    updatedAt: v.optional(v.unknown()),
  }),
);

/**
 * A wiki link, as IndexedDB's `links` store holds it (domain/note.js, LinkRecord): from the note
 * whose text names another to that note, and when it was made. Ids and a time, so no content.
 */
export const linkRecord = v.looseObject({
  id,
  fromNoteId: v.optional(v.unknown()),
  toNoteId: v.optional(v.unknown()),
  createdAt: v.optional(v.unknown()),
});

/**
 * A note's embedding, as IndexedDB's `vectors` store holds it (domain/note.js, VectorRecord),
 * under its note's id. The vector is made from the note's title and text, so it's content.
 */
export const vectorRecord = v.looseObject({
  id: entityId('note'),
  noteId: v.optional(v.unknown()),
  vector: v.optional(content(v.unknown())),
  updatedAt: v.optional(v.unknown()),
  sourceRevision: v.optional(v.unknown()),
});

/**
 * A snapshot of a note, as IndexedDB's `snapshots` store holds it (domain/snapshot.js): the
 * note's blocks and title at `timestamp`. Its blocks and title are content.
 */
export const snapshotRecord = v.looseObject({
  id: entityId('snapshot'),
  noteId: entityId('note'),
  timestamp,
  blocks: content(v.array(v.unknown())),
  title: content(v.string()),
});

/**
 * A custom theme, as IndexedDB's `themes` store holds it (domain/theme.js): its name, the CSS
 * custom properties it sets, and when it was last saved. Its name is content.
 */
export const themeRecord = v.looseObject({
  id,
  name: v.optional(content(v.string())),
  properties: v.optional(v.looseObject({})),
  updatedAt: v.optional(timestamp),
});

/** The fields of a record no change op names: its id, and when it was last saved */
const UNNAMED_FIELDS = new Set(['id', 'updatedAt']);

/**
 * @param {Record<string, unknown>} entries - a record schema's
 * @returns {readonly string[]}
 */
const opFieldsOf = entries =>
  Object.freeze(
    Object.keys(entries)
      .filter(field => !UNNAMED_FIELDS.has(field))
      .sort(),
  );

/**
 * The fields of a note a change op may name (#17 PR 4c): each one noteRecord names but its id
 * and `updatedAt`. A note's versions aren't schema fields, so no op names them, and a field
 * only an imported file named can't land in the log.
 */
export const NOTE_OP_FIELDS = opFieldsOf(noteRecord.entries);

/** The fields of a folder a change op may name, as NOTE_OP_FIELDS are a note's */
export const FOLDER_OP_FIELDS = opFieldsOf(folderRecord.entries);

/**
 * @param {readonly string[]} fields
 */
const changedFields = fields => v.pipe(v.array(v.picklist(fields)), v.minLength(1));

/** @param {'insertBlock' | 'updateBlock' | 'moveBlock' | 'deleteBlock'} op */
const blockOp = op => v.strictObject({ op: v.literal(op), blockId: entityId('block') });

/**
 * What a commit did to one entity, one op of its change record (#17 PR 4c, the lead's Q4): a
 * note made, changed, or deleted for good, a block of it inserted, changed, moved, or
 * deleted, or a folder made, changed, or deleted. Each holds the op's name and a block's id or
 * the names of the fields that changed, never a value. Each is strict, so nothing else can go
 * in one without a change to this schema. #19's merge adds the content its ops need.
 */
export const changeOp = v.variant('op', [
  v.strictObject({ op: v.literal('createNote') }),
  v.strictObject({ op: v.literal('updateNote'), fields: changedFields(NOTE_OP_FIELDS) }),
  v.strictObject({ op: v.literal('deleteNote') }),
  blockOp('insertBlock'),
  blockOp('updateBlock'),
  blockOp('moveBlock'),
  blockOp('deleteBlock'),
  v.strictObject({ op: v.literal('createFolder') }),
  v.strictObject({ op: v.literal('updateFolder'), fields: changedFields(FOLDER_OP_FIELDS) }),
  v.strictObject({ op: v.literal('deleteFolder') }),
]);

/**
 * One entry of #17's change log, which #13's CommitFeed reads from a cursor: an entity a commit
 * changed, at its revision, with the ops it took (#17 PR 4c). #19 fills `parentRevisionIds`
 * and `originDeviceId`.
 */
export const changeRecord = v.looseObject({
  seq: commitSeq,
  entityType: v.picklist(ENTITY_TYPES),
  entityId: id,
  revision,
  opId: id,
  ops: v.array(changeOp),
  parentRevisionIds: v.optional(v.array(v.string())),
  originDeviceId: v.optional(v.nullable(v.string())),
});

/** @typedef {v.InferOutput<typeof noteRecord>} NoteEntity */
/** @typedef {v.InferOutput<typeof blockRecord>} BlockEntity */
/** @typedef {v.InferOutput<typeof blockInput>} BlockInputEntity */
/** @typedef {v.InferOutput<typeof folderRecord>} FolderEntity */
/** @typedef {v.InferOutput<typeof snapshotRecord>} SnapshotEntity */
/** @typedef {v.InferOutput<typeof themeRecord>} ThemeEntity */
/** @typedef {v.InferOutput<typeof changeRecord>} ChangeEntity */
/** @typedef {v.InferOutput<typeof changeOp>} ChangeOp */
/** @typedef {v.InferOutput<typeof searchEntryRecord>} SearchEntryEntity */
/** @typedef {v.InferOutput<typeof linkRecord>} LinkEntity */
/** @typedef {v.InferOutput<typeof vectorRecord>} VectorEntity */
