// The generated storage fixtures (#28 slice 3), in `ntn-storage-fixture/1`, made at test time
// and never committed:
//
// - maximalFixture: a version-8 profile with every user-owned record type. Every CanvasTabDB
//   store of the v8 shape holds records (the IndexedDB settings store a row 1.1.2 left);
//   chrome.storage.local holds every default setting the production build writes, the AI key
//   as a canary, and an auto and a recovery backup. The notes are plain, foldered in a nested
//   folder, archived, trashed, a template, a Daily Note, pinned with insights, and one the
//   Popup made bare. Blocks are one of every BlockTypes key, serialized by production's Block
//   as the editor saves them, plus an unknown type, an invalid block, raw HTML, and an image
//   and a file as data URLs. Sizes go past #17's copy bounds (recovery-points.js): elements
//   holds more records than one batch, and the file block alone is over a batch's bytes.
// - corruptFixtures: small version-8 profiles, each with one kind of damage no release writes
//   but a profile can hold: truncated records, mistyped fields, dangling references, oversized
//   records, and duplicate Daily Notes.
//
// What each record is for is in `roles`, so a test derives its expected outcome from the
// generator's declarations, not from what production code does with them. The production
// inputs (BlockTypes keys, the Block serializer, default settings) come from the caller, which
// reads them from js/blocks.js and js/storage.js, so a block type or setting added there is
// covered here without an edit.

import { compareKeys } from './load-fixture.mjs';

export const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
export const DAILY_DATE = '2026-10-09';
/** #17's copy bounds (recovery-points.js BATCH_RECORDS and BATCH_BYTES) */
export const BATCH_RECORDS = 100;
export const BATCH_BYTES = 2 * 1024 * 1024;
export const UNKNOWN_TYPE = 'ntn-unknown-type';
export const RAW_HTML = '<b>bold</b> <i>italic</i> <a href="https://example.test/page">a link</a><img src="x" onerror="alert(1)">';
const GENERATOR = 'test/fixtures/storage/generate.mjs';

/**
 * @typedef {object} Inputs
 * @property {any} shapes - shapes.json's `shapes`
 * @property {string[]} blockTypes - production BlockTypes keys
 * @property {(options: Record<string, unknown>) => Record<string, unknown>} serializeBlock - production `new Block(options).serialize()`
 * @property {Record<string, unknown>} defaultSettings - the chrome.storage.local entries production's initializeDefaultSettings writes
 */

/**
 * `length` deterministic bytes
 * @param {number} length
 * @param {number} [salt]
 */
function bytes(length, salt = 0) {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + salt * 17) & 0xff;
  return out;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bytes(56, 1)]);
const blobOf = (/** @type {Buffer} */ data, mime = 'image/png') => ({ $type: 'Blob', mime, base64: data.toString('base64') });
const dataUrl = (/** @type {string} */ mime, /** @type {Buffer} */ data) => `data:${mime};base64,${data.toString('base64')}`;

/**
 * A note as 1.4.x's createNote writes it
 * @param {string} id
 * @param {unknown} name
 * @param {Record<string, unknown>} [fields]
 * @returns {Record<string, any>}
 */
function note(id, name, fields = {}) {
  return {
    id,
    name,
    createdAt: T0,
    updatedAt: T0,
    archived: false,
    archivedAt: null,
    titleManuallySet: false,
    lastAutoTitleAt: null,
    insights: null,
    lastInsightsExtractedAt: null,
    preview: '',
    pinned: false,
    todoProgress: null,
    isDaily: false,
    dateStr: null,
    isTemplate: false,
    folderId: null,
    viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    settings: { gridType: 'dots', backgroundColor: '#fafafa' },
    ...fields,
  };
}

/**
 * A block as 1.4.x's editor saves it, by a serializer standing in for production's
 * @param {string} id
 * @param {string} canvasId
 * @param {unknown} order
 * @param {unknown} content
 * @param {Record<string, unknown>} [fields]
 * @returns {Record<string, any>}
 */
const plainBlock = (id, canvasId, order, content, fields = {}) => ({
  id,
  type: 'text',
  content,
  indentLevel: 0,
  checked: false,
  imageUrl: null,
  calloutIcon: '\u{1F4A1}',
  createdAt: T0,
  updatedAt: T0,
  canvasId,
  order,
  ...fields,
});

/**
 * A version-8 fixture of `records` per store (rows, keyed by each store's key path)
 * @param {any} shapes
 * @param {string} id
 * @param {string} purpose
 * @param {Record<string, any[]>} records
 * @param {Record<string, unknown>} chromeStorageLocal
 */
function v8Fixture(shapes, id, purpose, records, chromeStorageLocal) {
  const stores = shapes.v8.stores.map((/** @type {any} */ store) => {
    const rows = records[store.name] || [];
    return {
      name: store.name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: store.indexes.map((/** @type {any} */ { name, keyPath, unique, multiEntry }) => ({ name, keyPath, unique, multiEntry })),
      records: rows
        .map(row => ({ key: row[store.keyPath], value: row }))
        .sort((a, b) => compareKeys(a.key, b.key)),
    };
  });
  stores.sort((/** @type {any} */ a, /** @type {any} */ b) => (a.name < b.name ? -1 : 1));
  return {
    format: 'ntn-storage-fixture/1',
    header: {
      id,
      purpose,
      shape: 'v8',
      releases: shapes.v8.releases,
      provenance: 'synthesized',
      source: { generator: GENERATOR, seed: 28 },
      schema: { idbVersion: 8, structuralVersion: null, logicalVersion: null },
      degraded: [],
      privacy: 'synthetic',
    },
    databases: [{ name: 'CanvasTabDB', version: 8, stores }],
    chromeStorageLocal: Object.fromEntries(Object.keys(chromeStorageLocal).sort().map(key => [key, chromeStorageLocal[key]])),
  };
}

/**
 * The maximal profile, and the role of each record in it
 * @param {Inputs} inputs
 */
export function maximalFixture({ shapes, blockTypes, serializeBlock, defaultSettings }) {
  const roles = {
    plain: 'note-plain',
    foldered: 'note-foldered',
    archived: 'note-archived',
    trashed: 'note-trashed',
    template: 'note-template',
    daily: 'note-daily',
    pinned: 'note-pinned',
    popup: 'note-popup',
    blocks: 'note-blocks',
    rootFolder: 'folder-root',
    childFolder: 'folder-child',
  };
  const canvases = [
    note(roles.plain, 'Plain note'),
    note(roles.foldered, 'In a nested folder', { folderId: roles.childFolder }),
    note(roles.archived, 'Archived note', { archived: true, archivedAt: T0 + 1000 }),
    note(roles.trashed, 'Trashed note', { trashed: true, trashedAt: T0 + 2000 }),
    note(roles.template, 'Meeting template', { isTemplate: true }),
    note(roles.daily, 'Daily Note - Oct 9, 2026', { isDaily: true, dateStr: DAILY_DATE }),
    note(roles.pinned, 'Pinned note', {
      pinned: true,
      preview: 'First line of the pinned note',
      todoProgress: { done: 1, total: 2 },
      titleManuallySet: true,
      lastAutoTitleAt: T0 + 3000,
      insights: { todos: ['Call the plumber'], reminders: [], deadlines: [], highlights: ['A highlight'] },
      lastInsightsExtractedAt: T0 + 3000,
    }),
    // The Popup's createNote: id, name, and times only
    { id: roles.popup, name: 'Quick note from the Popup', createdAt: T0 + 4000, updatedAt: T0 + 4000 },
    note(roles.blocks, 'Every block type'),
  ];

  // One block of each type, serialized by production's Block, as the editor saves it
  const typeBlocks = blockTypes.map((type, order) => {
    /** @type {Record<string, unknown>} */
    const options = { id: `block-type-${type}`, type, content: `A ${type} block`, createdAt: T0, updatedAt: T0 };
    if (type === 'todo') options.checked = true;
    if (type === 'toggle') Object.assign(options, { collapsed: false, children: 'Hidden detail' });
    if (type === 'table') Object.assign(options, { rows: 2, cols: 2, tableData: [['a', 'b'], ['c', 'd']], hasHeaderRow: true });
    if (type === 'bookmark') Object.assign(options, { url: 'https://example.test/a', title: 'A page', description: 'About it', favicon: '' });
    if (type === 'video') options.videoUrl = 'https://example.test/video';
    if (type === 'equation') options.equation = 'e = mc^2';
    if (type === 'callout') options.calloutIcon = '\u{1F4DD}';
    // handleImageUpload and handleFileUpload keep the file inline as a data URL
    if (type === 'image') options.imageUrl = dataUrl('image/png', PNG);
    if (type === 'file') {
      // Alone over one batch's bytes
      const data = bytes(BATCH_BYTES + 64 * 1024, 2);
      Object.assign(options, { fileName: 'notes.bin', fileSize: data.length, fileData: dataUrl('application/octet-stream', data) });
    }
    return { ...serializeBlock(options), canvasId: roles.blocks, order };
  });
  const order = typeBlocks.length;
  const elements = [
    ...typeBlocks,
    plainBlock('block-unknown-type', roles.blocks, order, 'A type no build knows', { type: UNKNOWN_TYPE }),
    // Invalid: no type, content that isn't text, no order
    { id: 'block-invalid', canvasId: roles.blocks, content: 7, type: null },
    plainBlock('block-raw-html', roles.blocks, order + 1, RAW_HTML),
    plainBlock('block-trashed-note', roles.trashed, 0, 'In the trashed note'),
    plainBlock('block-archived-note', roles.archived, 0, 'In the archived note'),
    plainBlock('block-template', roles.template, 0, 'Agenda'),
    plainBlock('block-daily', roles.daily, 0, 'Captured text (Source: https://example.test/b)', { order: T0 + 11111 }),
    plainBlock('block-pinned-1', roles.pinned, 0, 'First line of the pinned note', { type: 'todo', checked: true }),
    plainBlock('block-pinned-2', roles.pinned, 1, 'Second item', { type: 'todo' }),
    plainBlock('block-foldered', roles.foldered, 0, 'Filed away'),
  ];
  // Past one batch of records
  for (let i = 0; elements.length <= BATCH_RECORDS + 10; i++) {
    elements.push(plainBlock(`block-plain-${String(i).padStart(3, '0')}`, roles.plain, i, `Line ${i} of the plain note`));
  }

  const records = {
    canvases,
    elements,
    folders: [
      { id: roles.rootFolder, name: 'Home', parentId: null, createdAt: T0, updatedAt: T0, color: null, collapsed: false },
      { id: roles.childFolder, name: 'Projects', parentId: roles.rootFolder, createdAt: T0, updatedAt: T0, color: '#3366ff', collapsed: true },
    ],
    media: [
      { id: 'media-image', canvasId: roles.blocks, blob: blobOf(PNG), type: 'image/png', createdAt: T0 },
      { id: 'media-trashed-note', canvasId: roles.trashed, blob: blobOf(bytes(32, 3), 'image/webp'), type: 'image/webp', createdAt: T0 },
    ],
    search_index: canvases.map(n => ({ noteId: n.id, name: n.name, content: '', updatedAt: n.updatedAt })),
    links: [{ id: 'link-1', fromNoteId: roles.plain, toNoteId: roles.pinned, createdAt: T0 }],
    themes: [{ id: 'theme-1', name: 'Dusk', properties: { '--bg-primary': '#101820', '--text-primary': '#f2f2f2' }, updatedAt: T0 }],
    vectors: [{ id: roles.plain, noteId: roles.plain, vector: [0.125, -0.5, 0.25, 1], updatedAt: T0 }],
    snapshots: [
      {
        id: 'snapshot-1',
        noteId: roles.pinned,
        timestamp: T0 + 5000,
        blocks: [plainBlock('block-pinned-1', roles.pinned, 0, 'First line')],
        title: 'Pinned note',
      },
    ],
    // A row 1.1.2 left before settings moved to chrome.storage.local
    settings: [{ key: 'theme', value: 'light' }],
  };

  const exported = { version: 1, exportedAt: T0 + 6000, canvases: canvases.filter(n => !('trashed' in n)), elements: elements.slice(0, 3), media: [], folders: records.folders };
  const local = {
    ...defaultSettings,
    setting_storageInitialized: true,
    setting_llmProvider: 'openai',
    setting_llmApiKey: '{{CANARY:llm-api-key}}',
    setting_theme: 'theme-1',
    setting_dailyNoteTemplate: roles.template,
    lastOpenedNoteId: roles.plain,
    [`auto_backup_${T0 + 6000}`]: { ...exported, autoBackup: true, backupCreatedAt: T0 + 6000 },
    [`recovery_backup_${T0 + 7000}`]: { recoveryBackup: true, timestamp: T0 + 7000, canvases: canvases.slice(0, 2), elements: elements.slice(0, 2) },
  };
  const fixture = v8Fixture(shapes, 'generated.maximal', 'Every user-owned record type, past the copy bounds (generated).', records, local);
  return { fixture, roles, records };
}

/**
 * What a maximal fixture lacks: a store with no records, a block type, an unknown or invalid
 * block, raw HTML, an image or file data URL, a default setting, or a backup key
 * @param {any} fixture
 * @param {Inputs} inputs
 * @returns {string[]}
 */
export function maximalProblems(fixture, { shapes, blockTypes, defaultSettings }) {
  const problems = [];
  const db = fixture.databases.find((/** @type {any} */ d) => d.name === 'CanvasTabDB');
  const stores = new Map((db ? db.stores : []).map((/** @type {any} */ s) => [s.name, s.records.map((/** @type {any} */ r) => r.value)]));
  for (const store of shapes.v8.stores) {
    if (!(stores.get(store.name) || []).length) problems.push(`store ${store.name} holds nothing`);
  }
  const blocks = stores.get('elements') || [];
  const types = new Set(blocks.map((/** @type {any} */ b) => b.type));
  for (const type of blockTypes) if (!types.has(type)) problems.push(`no ${type} block`);
  if (!blocks.some((/** @type {any} */ b) => typeof b.type === 'string' && !blockTypes.includes(b.type))) problems.push('no block of an unknown type');
  if (!blocks.some((/** @type {any} */ b) => typeof b.type !== 'string')) problems.push('no invalid block');
  if (!blocks.some((/** @type {any} */ b) => typeof b.content === 'string' && /<[a-z]+[\s>]/i.test(b.content))) problems.push('no raw HTML content');
  if (!blocks.some((/** @type {any} */ b) => b.type === 'image' && String(b.imageUrl).startsWith('data:'))) problems.push('no image data URL');
  if (!blocks.some((/** @type {any} */ b) => b.type === 'file' && String(b.fileData).startsWith('data:'))) problems.push('no file data URL');
  if (blocks.length <= BATCH_RECORDS) problems.push('elements fits in one batch');
  if (!blocks.some((/** @type {any} */ b) => JSON.stringify(b).length > BATCH_BYTES)) problems.push('no record over a batch of bytes');
  const local = fixture.chromeStorageLocal || {};
  for (const key of Object.keys(defaultSettings)) if (!Object.hasOwn(local, key)) problems.push(`no ${key}`);
  for (const prefix of ['auto_backup_', 'recovery_backup_']) {
    if (!Object.keys(local).some(key => key.startsWith(prefix))) problems.push(`no ${prefix}* key`);
  }
  return problems;
}

/**
 * The corrupt profiles, by id, each with the roles of its records
 * @param {{shapes: any}} inputs
 */
export function corruptFixtures({ shapes }) {
  /** @returns {Record<string, Array<Record<string, any>>>} */
  const base = () => ({
    canvases: [note('note-a', 'Alpha'), note('note-b', 'Beta')],
    elements: [plainBlock('block-a1', 'note-a', 0, 'Alpha one'), plainBlock('block-b1', 'note-b', 0, 'Beta one')],
    folders: [],
    media: [],
    search_index: [],
    links: [],
    themes: [],
    vectors: [],
    snapshots: [],
    settings: [],
  });
  const local = { setting_storageInitialized: true, setting_theme: 'system' };
  /** @type {Map<string, {fixture: any, purpose: string, roles: Record<string, any>}>} */
  const out = new Map();
  const add = (/** @type {string} */ id, /** @type {string} */ purpose, /** @type {any} */ records, roles = {}) => {
    out.set(id, { fixture: v8Fixture(shapes, `generated.corrupt.${id}`, `${purpose} (generated).`, records, local), purpose, roles });
  };

  {
    const r = base();
    r.canvases.push({ id: 'note-truncated' });
    r.elements.push({ id: 'block-truncated', canvasId: 'note-a' });
    add('truncated', 'A note and a block cut short: an ID and nothing else, and a block with only its note', r, {
      notes: ['note-a', 'note-b', 'note-truncated'],
      truncatedNote: 'note-truncated',
      truncatedBlock: 'block-truncated',
    });
  }
  {
    const r = base();
    r.canvases.push(note('note-mistyped', 42, { updatedAt: 'yesterday', archived: 'no', folderId: 7, viewport: 'wide' }));
    r.elements.push({ ...plainBlock('block-mistyped', 'note-a', '1', { html: 'not text' }), type: 5, checked: 'yes' });
    add('mistyped', 'A note whose name is a number and whose flags and times are strings, and a block whose content is an object', r, {
      mistypedNote: 'note-mistyped',
      mistypedBlock: 'block-mistyped',
    });
  }
  {
    const r = base();
    r.canvases.push(note('note-filed-nowhere', 'Filed nowhere', { folderId: 'folder-gone' }));
    r.elements.push(plainBlock('block-orphan', 'note-gone', 0, 'Its note is gone'));
    r.media.push({ id: 'media-orphan', canvasId: 'note-gone', blob: blobOf(PNG), type: 'image/png', createdAt: T0 });
    r.folders.push({ id: 'folder-orphan', name: 'Parent gone', parentId: 'folder-gone', createdAt: T0, updatedAt: T0, color: null, collapsed: false });
    r.links.push({ id: 'link-dangling', fromNoteId: 'note-a', toNoteId: 'note-gone', createdAt: T0 });
    r.snapshots.push({ id: 'snapshot-orphan', noteId: 'note-gone', timestamp: T0, blocks: [], title: 'Gone' });
    r.vectors.push({ id: 'note-gone', noteId: 'note-gone', vector: [1, 0], updatedAt: T0 });
    r.search_index.push({ noteId: 'note-gone', name: 'Gone', content: '', updatedAt: T0 });
    add('dangling', 'Records whose note or folder is gone: a block, media, a folder, a link, a snapshot, a vector, and a search entry', r, {
      orphanBlock: 'block-orphan',
      orphanMedia: 'media-orphan',
      filedNowhere: 'note-filed-nowhere',
      orphanFolder: 'folder-orphan',
    });
  }
  {
    const r = base();
    const big = 'x'.repeat(BATCH_BYTES + 512 * 1024);
    r.canvases.push(note('note-oversized', 'N'.repeat(64 * 1024)));
    r.elements.push(plainBlock('block-oversized', 'note-oversized', 0, big));
    r.media.push({ id: 'media-oversized', canvasId: 'note-oversized', blob: blobOf(bytes(BATCH_BYTES + 256 * 1024, 4)), type: 'image/png', createdAt: T0 });
    add('oversized', 'A 64 KiB title, and a block and an image each over a batch of bytes', r, {
      oversizedNote: 'note-oversized',
      oversizedBlock: 'block-oversized',
      oversizedMedia: 'media-oversized',
    });
  }
  {
    const r = base();
    const name = 'Daily Note - Oct 9, 2026';
    r.canvases.push(
      note('note-daily-1', name, { isDaily: true, dateStr: DAILY_DATE, createdAt: T0 + 100, updatedAt: T0 + 100 }),
      note('note-daily-2', name, { isDaily: true, dateStr: DAILY_DATE, createdAt: T0 + 200, updatedAt: T0 + 200 }),
      note('note-daily-3', name, { isDaily: true, dateStr: DAILY_DATE, createdAt: T0 + 300, updatedAt: T0 + 300, trashed: true, trashedAt: T0 + 400 }),
    );
    r.elements.push(plainBlock('block-daily-1', 'note-daily-1', 0, 'Morning'), plainBlock('block-daily-2', 'note-daily-2', 0, 'Evening'));
    add('daily-duplicates', 'Three Daily Notes for one day, as two tabs and a capture can make them, one of them in trash', r, {
      dailies: ['note-daily-1', 'note-daily-2', 'note-daily-3'],
      trashedDaily: 'note-daily-3',
    });
  }
  return out;
}
