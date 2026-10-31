#!/usr/bin/env node
// Writes test/fixtures/storage/synthesized/<shape>.<variant>.json (#17 plan section 2): one
// fixture per support-matrix shape and degraded variant, with records shaped like each tag's
// own writes (Storage.createNote, the block serializer, createFolder, saveMedia, saveSnapshot,
// saveVector, updateNoteLinks, saveCustomTheme, the Popup's bare createNote, and the worker's
// captureToDailyNote), from a fixed seed. Run by hand; the output is committed:
//
//   node scripts/fixtures/synthesize-storage.mjs
//
// Then `node scripts/fixtures/derive-expected.mjs` rewrites expected/ from these files.
// Secrets are canaries only: {{CANARY:llm-api-key}}.

import fs from 'node:fs';
import path from 'node:path';

import { compareKeys } from '../../test/fixtures/storage/load-fixture.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'fixtures', 'storage', 'synthesized');
const SHAPES = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'storage', 'shapes.json'), 'utf8'));
const SEED = 1;
const GENERATOR = 'scripts/fixtures/synthesize-storage.mjs';

/** mulberry32: a small deterministic PRNG */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ids in Utils.generateId's format, `<ms>-<9 base-36 chars>`, from the seed */
function idMaker(seed) {
  const random = prng(seed);
  let clock = 1760000000000;
  return () => {
    clock += 1000 + Math.floor(random() * 1000);
    let tail = '';
    for (let i = 0; i < 9; i++) tail += Math.floor(random() * 36).toString(36);
    return `${clock}-${tail}`;
  };
}

const T0 = 1760000000000;
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]).toString('base64');
const blob = (mime, base64 = PNG_BASE64) => ({ $type: 'Blob', mime, base64 });
const UNDEFINED = { $type: 'undefined' };

/** A note as each tag's Storage.createNote writes it */
function note(shape, id, name, fields = {}) {
  const base = { id, name, createdAt: T0, updatedAt: T0, archived: false, archivedAt: null, titleManuallySet: false, lastAutoTitleAt: null };
  const later = shape === 'v7' || shape === 'v8' || shape === 'v9' || shape === 'v10' || shape === 'v11';
  const v8Fields = shape === 'v8' || shape === 'v9' || shape === 'v10' || shape === 'v11';
  return {
    ...base,
    // v1.1.0's createNote added insights, so every shape but v1.0.0's own notes has them (#28 slice 3's recordings)
    insights: null,
    lastInsightsExtractedAt: null,
    ...(v8Fields ? { preview: '', pinned: false, todoProgress: null } : {}),
    ...(later ? { isDaily: false, dateStr: null, isTemplate: false, folderId: null } : {}),
    viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    settings: { gridType: 'dots', backgroundColor: '#fafafa' },
    ...fields,
  };
}

/** A block as the block serializer writes it, with its note and order */
function block(id, canvasId, order, content, fields = {}) {
  return {
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
  };
}

const folder = (id, name, parentId = null) => ({ id, name, parentId, createdAt: T0, updatedAt: T0, color: null, collapsed: false });
const media = (id, canvasId) => ({ id, canvasId, blob: blob('image/png'), type: 'image/png', createdAt: T0 });

/** A database of `shape`'s stores (less `omit`, plus `extra`), with `records` per store */
function database(shape, records, { omit = [], extra = [], version } = {}) {
  const stores = SHAPES.shapes[shape].stores
    .filter(store => !omit.includes(store.name))
    .map(store => ({
      name: store.name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: store.indexes.map(({ name, keyPath, unique, multiEntry }) => ({ name, keyPath, unique, multiEntry })),
      records: [],
    }))
    .concat(extra.map(store => ({ autoIncrement: false, indexes: [], records: [], ...store })))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const store of stores) {
    const rows = records[store.name] || [];
    const keyOf = row => (store.keyPath === null ? row.key : Array.isArray(store.keyPath) ? store.keyPath.map(k => row[k]) : row[store.keyPath]);
    store.records = rows
      .map(row => (store.keyPath === null ? row : { key: keyOf(row), value: row }))
      .sort((a, b) => compareKeys(a.key, b.key));
  }
  return { name: 'CanvasTabDB', version: version ?? SHAPES.shapes[shape].idbVersion, stores };
}

function fixture({ id, purpose, shape, degraded = [], schema, databases, chromeStorageLocal = {} }) {
  return {
    format: 'ntn-storage-fixture/1',
    header: {
      id,
      purpose,
      shape,
      releases: SHAPES.shapes[shape].releases,
      provenance: 'synthesized',
      source: { generator: GENERATOR, seed: SEED },
      schema: schema || { idbVersion: databases[0] ? databases[0].version : null, structuralVersion: null, logicalVersion: null },
      degraded,
      privacy: 'synthetic',
    },
    databases,
    chromeStorageLocal,
  };
}

const nextId = idMaker(SEED);

/** The notes, blocks, and media every richer fixture starts from */
function profile(shape) {
  const later = shape === 'v7' || shape === 'v8' || shape === 'v9' || shape === 'v10' || shape === 'v11';
  const [a, b, c, d] = [nextId(), nextId(), nextId(), nextId()];
  const f1 = nextId();
  const notes = [
    note(shape, a, 'Groceries', later ? { folderId: f1 } : {}),
    note(shape, b, 'Reading list'),
    note(shape, c, 'Old plans', { archived: true, archivedAt: T0 + 5000 }),
    // trashNote has set trashed and trashedAt since v1.0.0
    note(shape, d, 'Thrown away', { trashed: true, trashedAt: T0 + 6000 }),
  ];
  if (later) notes.push(note(shape, nextId(), 'Meeting template', { isTemplate: true }));
  const elements = [
    block(nextId(), a, 0, 'Milk and eggs'),
    block(nextId(), a, 1, 'Bread', { type: 'todo', checked: true }),
    block(nextId(), b, 0, 'A long book'),
    block(nextId(), c, 0, 'Ideas from last year'),
    block(nextId(), d, 0, 'Not needed'),
  ];
  return { notes, elements, media: [media(nextId(), a)], folders: later ? [folder(f1, 'Home')] : [] };
}

/** The derived and auxiliary rows version 7 and 8 add */
function auxiliary(shape, base) {
  const [first, second] = base.notes;
  const out = {
    search_index: base.notes.map(n => ({ noteId: n.id, name: n.name, content: '', updatedAt: T0 })),
    links: [{ id: nextId(), fromNoteId: first.id, toNoteId: second.id, createdAt: T0 }],
    // The theme builder's save: name and CSS properties (every release from v1.2.0)
    themes: [{ id: nextId(), name: 'Dusk', properties: { '--bg-primary': '#101820', '--text-primary': '#f2f2f2' }, updatedAt: T0 }],
    vectors: [{ id: first.id, noteId: first.id, vector: [0.125, -0.5, 0.25, 1], updatedAt: T0 }],
  };
  if (shape === 'v8' || shape === 'v9' || shape === 'v10' || shape === 'v11') {
    out.snapshots = [{ id: nextId(), noteId: first.id, timestamp: T0 + 300000, blocks: [block('snap-b1', first.id, 0, 'Milk')], title: first.name }];
  }
  return out;
}

const fixtures = [];
const add = value => fixtures.push(value);

add(fixture({ id: 'none.basic', purpose: 'A profile with no database: a new install.', shape: 'none', databases: [] }));
add(
  fixture({
    id: 'none.empty-v1',
    purpose: 'An empty CanvasTabDB at version 1, as an aborted first open can leave, which counts as none.',
    shape: 'none',
    degraded: ['idb-version:1'],
    databases: [{ name: 'CanvasTabDB', version: 1, stores: [] }],
  }),
);

{
  const base = profile('v2-idb-settings');
  const settings = [
    { key: 'theme', value: 'dark' },
    { key: 'llmProvider', value: 'none' },
  ];
  add(
    fixture({
      id: 'v2-idb-settings.basic',
      purpose: 'v1.0.0 to v1.1.2: four stores, every setting in IndexedDB.',
      shape: 'v2-idb-settings',
      databases: [database('v2-idb-settings', { canvases: base.notes, elements: base.elements, media: base.media, settings })],
    }),
  );
  const secret = profile('v2-idb-settings');
  add(
    fixture({
      id: 'v2-idb-settings.idb-settings-secret',
      purpose: 'v1.0.0 to v1.1.2 with an AI key in the IndexedDB settings store, as a canary: no point, receipt, or log may hold it.',
      shape: 'v2-idb-settings',
      databases: [
        database('v2-idb-settings', {
          canvases: secret.notes,
          elements: secret.elements,
          media: secret.media,
          settings: [...settings, { key: 'llmProvider', value: 'openai' }, { key: 'llmApiKey', value: '{{CANARY:llm-api-key}}' }].filter(
            (row, i, rows) => rows.findLastIndex(other => other.key === row.key) === i,
          ),
        }),
      ],
    }),
  );
}

{
  const base = profile('v2-local-settings');
  add(
    fixture({
      id: 'v2-local-settings.basic',
      purpose: 'v1.1.3 to v1.1.5: settings in chrome.storage.local (the AI key as a canary), and a row v1.1.2 left in the settings store.',
      shape: 'v2-local-settings',
      databases: [
        database('v2-local-settings', {
          canvases: base.notes,
          elements: base.elements,
          media: base.media,
          settings: [{ key: 'theme', value: 'light' }],
        }),
      ],
      chromeStorageLocal: {
        setting_theme: 'dark',
        setting_llmProvider: 'openai',
        setting_llmApiKey: '{{CANARY:llm-api-key}}',
        setting_storageInitialized: true,
      },
    }),
  );
}

{
  const base = profile('v7');
  add(
    fixture({
      id: 'v7.basic',
      purpose: 'v1.2.0: nine stores, before snapshots.',
      shape: 'v7',
      databases: [
        database('v7', { canvases: base.notes, elements: base.elements, media: base.media, folders: base.folders, ...auxiliary('v7', base) }),
      ],
      chromeStorageLocal: { setting_theme: 'system', setting_storageInitialized: true },
    }),
  );
}

/** A version-8 profile, with `change` applied to its records */
function v8(id, purpose, change = records => records, options = {}) {
  const base = profile('v8');
  const records = change({ canvases: base.notes, elements: base.elements, media: base.media, folders: base.folders, ...auxiliary('v8', base), settings: [] }, base);
  add(
    fixture({
      id,
      purpose,
      shape: 'v8',
      degraded: options.degraded || [],
      databases: [database('v8', records, options)],
      chromeStorageLocal: { setting_theme: 'system', setting_storageInitialized: true },
    }),
  );
}

v8('v8.basic', 'v1.3.0 to v1.4.1: all ten stores, with folders, archived, trashed, and template notes, media, links, themes, vectors, and a snapshot.');
v8('v8.missing-themes', "A version-8 database without themes, as v1.2.0's repair rebuilt it (#33's missing-stores case).", r => r, {
  omit: ['themes'],
  degraded: ['missing-store:themes'],
});
v8('v8.missing-core', 'A version-8 database without elements, which no step can supply.', r => r, {
  omit: ['elements'],
  degraded: ['missing-store:elements'],
});
v8(
  'v8.extra-store',
  'A version-8 database with a store no release made, outside the matrix.',
  r => ({ ...r, mystery: [{ id: 'm1', note: 'left by a development build' }] }),
  { extra: [{ name: 'mystery', keyPath: 'id' }], degraded: ['extra-store:mystery'] },
);
v8('v8.popup-bare-notes', "Notes the Popup's createNote wrote: id, name, and times only.", r => ({
  ...r,
  canvases: [...r.canvases, { id: nextId(), name: 'Quick note', createdAt: T0 + 7000, updatedAt: T0 + 7000 }, { id: nextId(), name: 'Another', createdAt: T0 + 8000, updatedAt: T0 + 8000 }],
}));
v8('v8.capture-order-datenow', "A Daily Note the worker's capture appended to, blocks ordered by Date.now(), one a bookmark with no url or title.", r => {
  const daily = note('v8', nextId(), 'Daily Note - Oct 9, 2025', { isDaily: true, dateStr: '2025-10-09' });
  return {
    ...r,
    canvases: [...r.canvases, daily],
    elements: [
      ...r.elements,
      { id: nextId(), type: 'text', content: 'Selected text (Source: https://example.test/a)', canvasId: daily.id, order: T0 + 11111 },
      { id: nextId(), type: 'bookmark', content: '', url: UNDEFINED, title: UNDEFINED, canvasId: daily.id, order: T0 + 22222 },
    ],
  };
});
v8('v8.daily-duplicates', 'Two Daily Notes for the same day, as two tabs could make them.', r => ({
  ...r,
  canvases: [
    ...r.canvases,
    note('v8', nextId(), 'Daily Note - Oct 9, 2025', { isDaily: true, dateStr: '2025-10-09', createdAt: T0 + 100 }),
    note('v8', nextId(), 'Daily Note - Oct 9, 2025', { isDaily: true, dateStr: '2025-10-09', createdAt: T0 + 200 }),
  ],
}));
v8('v8.stale-folder-id', 'A note filed in a folder that no longer exists.', r => ({
  ...r,
  canvases: [...r.canvases, note('v8', nextId(), 'Filed', { folderId: 'folder-gone' })],
}));
v8('v8.orphans', 'A block and a media row whose note is gone.', r => ({
  ...r,
  elements: [...r.elements, block(nextId(), 'note-gone', 0, 'Left behind')],
  media: [...r.media, media(nextId(), 'note-gone')],
}));
v8('v8.data-urls', 'Images and files inline as data URLs in blocks, as 1.4.x stores them.', r => {
  const [first] = r.canvases;
  return {
    ...r,
    elements: [
      ...r.elements,
      block(nextId(), first.id, 5, '', { type: 'image', imageUrl: `data:image/png;base64,${PNG_BASE64}` }),
      block(nextId(), first.id, 6, '', { type: 'file', fileName: 'notes.txt', fileType: 'text/plain', fileData: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}` }),
    ],
  };
});

{
  const base = profile('v9');
  const receipt = {
    id: 'structural-9',
    from: 8,
    to: 9,
    status: 'completed',
    startedAt: T0,
    completedAt: T0,
    recoveryPointId: null,
    failure: null,
  };
  const records = {
    canvases: base.notes,
    elements: base.elements,
    media: base.media,
    folders: base.folders,
    ...auxiliary('v9', base),
    meta: [{ key: 'schema', structuralVersion: 9, logicalVersion: 1 }],
    migrations: [receipt],
  };
  add(
    fixture({
      id: 'v9.basic',
      purpose: "At structural version 9 with its receipt, as #17 PR 1b's builds left a dev profile: a run makes a point and runs steps 10 and 11.",
      shape: 'v9',
      schema: { idbVersion: 9, structuralVersion: 9, logicalVersion: 1 },
      databases: [database('v9', records)],
    }),
  );
  const newer = profile('v9');
  add(
    fixture({
      id: 'v9.newer',
      purpose: 'A database a later build upgraded to 12, as a rollback leaves it: copied to a point and left alone.',
      shape: 'v9',
      degraded: ['idb-version:12', 'extra-store:future_store', 'meta-structural:12'],
      schema: { idbVersion: 12, structuralVersion: 12, logicalVersion: 4 },
      databases: [
        database(
          'v9',
          {
            canvases: newer.notes,
            elements: newer.elements,
            meta: [{ key: 'schema', structuralVersion: 12, logicalVersion: 4 }],
            future_store: [{ id: 'f1', kind: 'something new' }],
          },
          { version: 12, extra: [{ name: 'future_store', keyPath: 'id' }] },
        ),
      ],
    }),
  );
}

// After every other fixture, so the ids the seed gives them stay the same
{
  const base = profile('v10');
  const [groceries, reading] = base.notes;
  // What #17 PR 2a's adapter keeps beside the notes: versions on two of them (the rest read as
  // 0), a ledger row per commit and one for a conflict, the change log, the conflict's record
  // with the save that lost, and a deleted note's content-free tombstone
  const notes = base.notes.map(note => {
    if (note.id === groceries.id) return { ...note, revision: 3, placementVersion: 1, sourceRevision: 2 };
    if (note.id === reading.id) return { ...note, revision: 1, placementVersion: 0, sourceRevision: 0 };
    return note;
  });
  const [created, saved, lost] = [nextId(), nextId(), nextId()];
  const deleted = nextId();
  /**
   * A committed outcome as the adapter keeps it
   * @param {string} code
   * @param {string} noteId
   * @param {number} revision
   * @param {number} commitSeq
   */
  const committedRow = (code, noteId, revision, commitSeq) => ({
    kind: 'committed',
    code,
    changedIds: [noteId],
    revision,
    commitSeq,
    messageKey: `committed.${code}`,
    severity: 'success',
  });
  const receipt = (id, from, to) => ({
    id,
    from,
    to,
    status: 'completed',
    startedAt: T0,
    completedAt: T0,
    recoveryPointId: null,
    failure: null,
  });
  const records = {
    canvases: notes,
    elements: base.elements,
    media: base.media,
    folders: base.folders,
    ...auxiliary('v10', base),
    meta: [
      { key: 'changes', head: 3, floor: 0 },
      { key: 'schema', structuralVersion: 10, logicalVersion: 1 },
    ],
    migrations: [receipt('structural-10', 9, 10), receipt('structural-9', 8, 9)],
    // The digest is the SHA-256 of the command's canonical JSON; these stand in for real ones
    operations: [
      { opId: created, digest: 'a1'.repeat(32), outcome: committedRow('note-created', reading.id, 1, 1), at: T0 + 1000 },
      { opId: saved, digest: 'b2'.repeat(32), outcome: committedRow('content-saved', groceries.id, 3, 3), at: T0 + 3000 },
      {
        opId: lost,
        digest: 'c3'.repeat(32),
        outcome: {
          kind: 'conflict',
          code: 'revision-conflict',
          currentRevision: 3,
          messageKey: 'conflict.revision-conflict',
          severity: 'warning',
        },
        at: T0 + 4000,
      },
    ],
    changes: [
      { seq: 1, entityType: 'note', entityId: reading.id, revision: 1, opId: created, ops: [] },
      { seq: 2, entityType: 'note', entityId: groceries.id, revision: 2, opId: nextId(), ops: [] },
      { seq: 3, entityType: 'note', entityId: groceries.id, revision: 3, opId: saved, ops: [] },
    ],
    conflicts: [
      {
        id: lost,
        noteId: groceries.id,
        scope: 'content',
        expected: 2,
        current: 3,
        at: T0 + 4000,
        command: {
          type: 'saveNoteContent',
          commandId: lost,
          noteId: groceries.id,
          blocks: [block('stale-b1', groceries.id, 0, 'A stale draft')],
          expectedRevision: 2,
        },
      },
    ],
    tombstones: [
      { entityType: 'note', id: deleted, deletedAt: T0 + 2000, lastRevision: 2, seq: null, reason: 'deleted' },
    ],
  };
  add(
    fixture({
      id: 'v10.basic',
      purpose:
        "At structural version 10 with its receipts, as #17 PR 2a's to 3a's builds left a dev profile, holding a ledger, a change log, a conflict, and a tombstone: a run makes a point and runs step 11.",
      shape: 'v10',
      schema: { idbVersion: 10, structuralVersion: 10, logicalVersion: 1 },
      databases: [database('v10', records)],
    }),
  );
}

// After every other fixture, so the ids the seed gives them stay the same
{
  const base = profile('v11');
  const [groceries] = base.notes;
  // #17 PR 3b's daily index, and a Daily Note each key names, as logical 3 leaves them
  const daily = note('v11', nextId(), 'Daily Note - Oct 9, 2025', {
    isDaily: true,
    dateStr: '2025-10-09',
    dailyKey: '2025-10-09',
    dailyTimeZone: null,
    dailyDuplicateOf: null,
  });
  const receipt = (id, from, to) => ({
    id,
    from,
    to,
    status: 'completed',
    startedAt: T0,
    completedAt: T0,
    recoveryPointId: null,
    failure: null,
  });
  const records = {
    canvases: [...base.notes.map(n => (n.id === groceries.id ? { ...n, revision: 2, placementVersion: 0, sourceRevision: 0 } : n)), daily],
    elements: [...base.elements, block(nextId(), daily.id, 0, 'Morning pages')],
    media: base.media,
    folders: base.folders,
    ...auxiliary('v11', base),
    meta: [
      { key: 'changes', head: 0, floor: 0 },
      { key: 'schema', structuralVersion: 11, logicalVersion: 3 },
    ],
    migrations: [
      receipt('logical-2', 1, 2),
      receipt('logical-3', 2, 3),
      receipt('structural-10', 9, 10),
      receipt('structural-11', 10, 11),
      receipt('structural-9', 8, 9),
    ],
    daily_index: [{ dailyKey: '2025-10-09', noteId: daily.id }],
  };
  add(
    fixture({
      id: 'v11.basic',
      purpose:
        'Already at structural version 11 and logical 3 with their receipts, holding a keyed Daily Note and its daily index entry: a run finds nothing to do and writes nothing.',
      shape: 'v11',
      schema: { idbVersion: 11, structuralVersion: 11, logicalVersion: 3 },
      databases: [database('v11', records)],
    }),
  );
}

fs.mkdirSync(OUT, { recursive: true });
for (const value of fixtures) {
  fs.writeFileSync(path.join(OUT, `${value.header.id}.json`), `${JSON.stringify(value, null, 2)}\n`);
}
console.log(`wrote ${fixtures.length} fixtures to ${path.relative(ROOT, OUT)}`);
