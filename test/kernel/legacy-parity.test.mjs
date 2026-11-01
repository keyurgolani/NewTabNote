// The rules the kernel copies from production code (#12, "Data and migration"), each run
// both ways from the same records: 1.4.x's Storage, the frozen v1.4.1's since #17 PR 4a took
// js/storage.js's copies of its writers out, which matched it line for line, background.js, or
// the controller that applies the rule, in one profile, and the kernel in another, on #17's
// adapter since #17 PR 4a deleted the legacy adapter, opened as the new tab's root opens a
// database the worker's run didn't reach: as it is, at 8. Each pair has to leave the same records. Two rules the kernel changes on
// purpose are left out, as #12 has them: attachInsights writes only insight fields, and
// applyDerivedTitle drops its title once the user set one. Two more since #17 PR 3a, each
// checked as the difference it is: the kernel writes placement, kind, and lifecycle beside the
// flags on a note it makes (domain/placement.js), which the comparisons take off and check
// apart, and it lists a note without an updatedAt the index holds (KD-011), which Storage lists
// once #17's transform has filled the field. And #17's adapter puts a note's versions on its
// record (#17 PR 2a, versions.js), at 8 too, which the comparisons take off and createNote's
// case checks.

import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { filledByLogical2 } from '../../js/kernel/adapters/indexeddb/transforms.js';
import { VERSION_FIELDS } from '../../js/kernel/adapters/indexeddb/versions.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createNoteList } from '../../js/kernel/core/application/note-list.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { createDocumentClient } from '../../js/kernel/composition/document.js';
import { createSettingsClient } from '../../js/kernel/composition/settings.js';
import { createsCycle } from '../../js/kernel/core/domain/folder.js';
import { isEmpty, isUntitled } from '../../js/kernel/core/domain/note.js';
import { PLACEMENT_FIELDS, withoutPlacement } from '../../js/kernel/core/domain/placement.js';
import { closeAll, legacyContext, legacyEnv, releaseContext } from './legacy-fixture.mjs';
import { CALLERS, testIds } from './support.mjs';

// #34's worker harness is CommonJS, and starts background.js as the module worker it is,
// which takes vm.SourceTextModule: npm test starts node with --experimental-vm-modules
/** @type {any} */
const workerHarness = createRequire(import.meta.url)('../helpers/load-background.js');
const RUNS_MODULES = typeof (/** @type {any} */ (vm).SourceTextModule) === 'function';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('./legacy-fixture.mjs').PageContext} PageContext */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../../js/kernel/core/domain/note.js').NoteView} NoteView */

/** The time legacyEnv.note and legacyEnv.block give the records they make */
const SEEDED_AT = 1700000000000;

/** The fields a write stamps with the time it ran */
const TIME_FIELDS = new Set(['createdAt', 'updatedAt', 'archivedAt', 'trashedAt', 'lastAutoTitleAt']);

/** What the editor loads before it can open a note, past what every legacy context loads */
const EDITOR_FILES = ['js/core/storage-error.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js'];

/** @type {PageContext[]} */
const opened = [];
after(() => closeAll(opened));

/** @type {{IDBKeyRange: typeof IDBKeyRange}} */
const { IDBKeyRange: KeyRange } = createRequire(import.meta.url)('fake-indexeddb');

/** @type {Array<{close: () => void}>} */
const adapters = [];
after(() => adapters.forEach(adapter => adapter.close()));

/**
 * The kernel on #17's adapter over `context`'s profile, opened as the new tab's root opens a
 * database the worker's run didn't reach: as it is, with the backup tasks (composition/newtab.js),
 * and the real clock, as Storage's is, unless a case gives one
 * @param {PageContext} context
 * @param {import('../../js/kernel/core/ports/runtime.js').Clock} [clock]
 * @returns {Promise<Kernel>}
 */
async function kernelOver(context, clock = { now: () => Date.now() }) {
  const adapter = createIndexedDbAdapter({
    indexedDB: context.env.indexedDB,
    settings: context.env.chrome.api.storage.local,
    keyRange: KeyRange,
    mode: 'existing',
    backups: true,
  });
  adapters.push(adapter);
  await adapter.open();
  return createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: CALLERS.newtab,
    ids: testIds('k'),
    clock,
  });
}

/**
 * Midday UTC on a day of 2026, which is the same day locally in any zone within 12 hours of UTC.
 * The frozen 1.4.1 names today's Daily Note by the local day and keys it by the UTC one, and the
 * parity kernel's clock has no zone, so it names and keys by the UTC day (#103's dailyNoteName
 * takes the clock's zone). From local midnight to UTC midnight the two days differ, so the cases
 * that make today's Daily Note run at this moment on both sides.
 */
const MIDDAY_UTC = Date.UTC(2026, 5, 15, 12);

/**
 * Has the 1.4.1 code in each of `contexts` read `at` as now, as a page at that moment would:
 * Date with no arguments, and Date.now()
 * @param {number} at
 * @param {PageContext[]} contexts
 */
function nowIn(at, contexts) {
  for (const { env } of contexts) {
    env.get(`(() => {
      const Real = Date;
      globalThis.Date = class extends Real {
        constructor(...args) {
          if (args.length === 0) super(${at});
          else super(...args);
        }
        static now() {
          return ${at};
        }
      };
    })()`);
  }
}

/**
 * `value` with each time a write stamped, any after the seeded ones, read as 'written', so
 * Storage's Date.now() and the kernel's clock compare equal
 * @param {unknown} value
 * @returns {any}
 */
function stamped(value) {
  if (Array.isArray(value)) return value.map(stamped);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      TIME_FIELDS.has(key) && typeof field === 'number' && field > SEEDED_AT ? 'written' : stamped(field),
    ]),
  );
}

/**
 * Two profiles that start from the same records: `viaStorage` for 1.4.x's code, the frozen
 * v1.4.1 Storage since #17 PR 4a took js/storage.js's own copies of its writers out
 * (releaseContext), and `viaKernel` for the kernel, whose clock is the real one, as Storage's is,
 * or, with `at`, one that reads `at`, as 1.4.1's Date does then on both sides. The kernel's
 * profile has a 1.4.1 Storage open too, which a case reads it through.
 * @param {Record<string, unknown[]>} [records] - rows per IndexedDB store
 * @param {{at?: number}} [options]
 * @returns {Promise<{viaStorage: PageContext, viaKernel: PageContext, kernel: Kernel}>}
 */
async function twin(records = {}, { at } = {}) {
  const viaStorage = releaseContext();
  const viaKernel = releaseContext();
  opened.push(viaStorage, viaKernel);
  if (at !== undefined) nowIn(at, [viaStorage, viaKernel]);
  for (const { env } of [viaStorage, viaKernel]) await legacyEnv.createDatabase(env.indexedDB, { records });
  await viaStorage.storage.open();
  await viaKernel.storage.open();
  return {
    viaStorage,
    viaKernel,
    kernel: await kernelOver(viaKernel, at === undefined ? undefined : { now: () => at }),
  };
}

/**
 * `note` without the versions #17's adapter puts on a note's record (#17 PR 2a)
 * @param {Record<string, unknown>} note
 */
const withoutVersions = note =>
  Object.fromEntries(Object.entries(note).filter(([field]) => !VERSION_FIELDS.includes(field)));

/**
 * A profile's records in the IndexedDB stores `names`, by key, with written times as 'written',
 * and each note without the group the kernel writes beside its flags (groupsIn reads that) or
 * its versions
 * @param {PageContext} context
 * @param {string[]} names
 * @returns {Promise<any>}
 */
async function recordsIn(context, names) {
  const dump = await legacyEnv.dumpDatabase(context.env.indexedDB);
  return stamped(
    Object.fromEntries(
      names.map(name => {
        const records = legacyEnv.recordsOf(dump, name);
        if (name !== 'canvases') return [name, records];
        return [
          name,
          Object.fromEntries(
            Object.entries(records).map(([key, note]) => [key, withoutVersions(withoutPlacement(note))]),
          ),
        ];
      }),
    ),
  );
}

/**
 * Each note's placement, kind, and lifecycle, by id, for the notes that have them (#17 PR 3a)
 * @param {PageContext} context
 * @returns {Promise<Record<string, Record<string, unknown>>>}
 */
async function groupsIn(context) {
  const dump = await legacyEnv.dumpDatabase(context.env.indexedDB);
  /** @type {Record<string, Record<string, unknown>>} */
  const groups = {};
  for (const [key, note] of Object.entries(legacyEnv.recordsOf(dump, 'canvases'))) {
    const group = Object.fromEntries(
      PLACEMENT_FIELDS.filter(field => field in note).map(field => [field, note[field]]),
    );
    if (Object.keys(group).length > 0) groups[key] = group;
  }
  return groups;
}

/**
 * What #17's transform writes on a profile's notes (logical 2, transforms.js), put straight into
 * its database, since a profile at version 8 has no `meta` for a run to read. The run starts
 * now, as the parity kernels' clocks read, which a trashed note's time in the trash takes.
 * @param {PageContext} context
 */
async function filledAsTheTransformFills(context) {
  /** @type {IDBDatabase} */
  const db = await new Promise((resolve, reject) => {
    const request = context.env.indexedDB.open('CanvasTabDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['canvases', 'folders'], 'readwrite');
      const notes = tx.objectStore('canvases').getAll();
      const folders = tx.objectStore('folders').getAllKeys();
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
      folders.onsuccess = () => {
        const liveFolderIds = new Set(/** @type {string[]} */ (folders.result));
        for (const note of notes.result) {
          const next = filledByLogical2(note, { liveFolderIds, blocks: [], runStart: Date.now() });
          if (next) tx.objectStore('canvases').put(next);
        }
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Each search entry's name. Storage.updateNote stamps the entry again on every note write,
 * and the kernel only on a rename, which #12 has as the one command that updates the search
 * index, so a command that isn't a rename leaves the entry's time out of the comparison.
 * @param {PageContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function searchNames(context) {
  const { search_index: entries } = await recordsIn(context, ['search_index']);
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.name]));
}

/**
 * A Daily Note as a profile holds it: its record, its search entry, and its blocks in order,
 * with the ids each side gives the template's copies left out
 * @param {PageContext} context
 * @param {string} noteId
 */
async function dailyNoteMade(context, noteId) {
  const found = await recordsIn(context, ['canvases', 'search_index', 'elements']);
  const blocks = Object.values(found.elements)
    .filter(block => block.canvasId === noteId)
    .sort((a, b) => a.order - b.order)
    .map(({ id, ...copy }) => copy);
  const dailies = Object.values(found.canvases).filter(note => note.isDaily);
  return { note: found.canvases[noteId], search: found.search_index[noteId], blocks, dailies: dailies.length };
}

/** @param {Outcome | BulkOutcome} outcome */
function assertCommitted(outcome) {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
}

/**
 * A folder record as Storage.createFolder writes one
 * @param {string} id
 * @param {string | null} parentId
 */
const folder = (id, parentId) => ({
  id,
  name: id,
  parentId,
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT,
  color: null,
  collapsed: false,
});

describe("the kernel's copies of production rules, run both ways", () => {
  it('createNote writes the note and the search entry Storage.createNote writes, and on this version-8 database no group (#17 PR 3a, review R88)', async () => {
    const { viaStorage, viaKernel, kernel } = await twin();
    const made = legacyEnv.plain(await viaStorage.storage.createNote('Plan'));
    assertCommitted(await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: made.id, name: 'Plan' }));
    const stores = ['canvases', 'search_index'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
    // #17's adapter gives the note its versions, which 1.4.x keeps as fields it doesn't read
    /** @param {PageContext} context */
    const versionsIn = async context => {
      const note = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(context.env.indexedDB), 'canvases')[made.id];
      return VERSION_FIELDS.map(field => note[field]);
    };
    assert.deepEqual(await versionsIn(viaKernel), [1, 0, 0]);
    assert.deepEqual(await versionsIn(viaStorage), [undefined, undefined, undefined]);
    // 1.4.1 still opens version 8, so the group waits for the run and the transform; the contract
    // suite checks the one the kernel writes at 10
    assert.deepEqual(await groupsIn(viaKernel), {});
    assert.deepEqual(await groupsIn(viaStorage), {});
  });

  it('createNote with a pin, a folder, and a hand-set title, then a save, leave what Storage did for a note saved as a new one', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({ folders: [folder('f1', null)] });
    // "Save as a new note": Storage.createNote made the record, the editor set the deleted
    // note's pin, folder, and title flag on it, and its save wrote the record with the blocks
    const made = await viaStorage.storage.createNote('Plan');
    Object.assign(made, { titleManuallySet: true, folderId: 'f1', pinned: true, preview: 'Milk', todoProgress: null });
    const blocks = [legacyEnv.block('b1', made.id, 0, 'Milk')];
    await viaStorage.storage.saveNoteWithBlocks(made, blocks);
    await viaStorage.storage.updateNoteNameInSearchIndex(made.id, 'Plan');
    const noteId = made.id;
    assertCommitted(
      await kernel.execute({
        type: 'createNote',
        commandId: 'c1',
        noteId,
        name: 'Plan',
        folderId: 'f1',
        pinned: true,
        titleManuallySet: true,
      }),
    );
    assertCommitted(
      await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c2',
        noteId,
        blocks,
        preview: 'Milk',
        todoProgress: null,
      }),
    );
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
    assert.deepEqual(await searchNames(viaKernel), await searchNames(viaStorage));
    // No group at version 8 (review R88)
    assert.deepEqual(await groupsIn(viaKernel), {});
  });

  it('createFolder writes the folder Storage.createFolder writes', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({ folders: [folder('f0', null)] });
    const made = legacyEnv.plain(await viaStorage.storage.createFolder('Work', 'f0'));
    assertCommitted(
      await kernel.execute({ type: 'createFolder', commandId: 'c1', folderId: made.id, name: 'Work', parentId: 'f0' }),
    );
    assert.deepEqual(await recordsIn(viaKernel, ['folders']), await recordsIn(viaStorage, ['folders']));
  });

  it("a capture's new Daily Note is the note, search entry, and template blocks Storage.ensureDailyNote makes", async () => {
    // At midday UTC on both sides, whose day is the local one too (MIDDAY_UTC)
    const { viaStorage, viaKernel, kernel } = await twin(
      {
        canvases: [legacyEnv.note('t1', { name: 'Daily template', isTemplate: true })],
        elements: [
          legacyEnv.block('t1-a', 't1', 0, '<p>{{title}}: plan</p>'),
          legacyEnv.block('t1-b', 't1', 1, '', {
            type: 'table',
            tableData: [
              ['{{title}}', 'Done'],
              ['', 'x'],
            ],
          }),
        ],
      },
      { at: MIDDAY_UTC },
    );
    for (const { storage } of [viaStorage, viaKernel]) await storage.setSetting('dailyNoteTemplate', 't1');
    const daily = legacyEnv.plain(await viaStorage.storage.ensureDailyNote());
    assertCommitted(
      await kernel.execute({
        type: 'captureToDailyNote',
        commandId: 'c1',
        noteId: daily.id,
        blockId: 'k-capture',
        capture: { type: 'text', content: 'Quote' },
      }),
    );
    // Template copies line up by order, since each side gives them its own ids, and the
    // capture's own block is left out: Storage.ensureDailyNote makes the note without one
    /** @param {PageContext} context */
    const made = async context => {
      const found = await recordsIn(context, ['canvases', 'search_index', 'elements']);
      const copies = Object.values(found.elements)
        .filter(block => block.canvasId === daily.id && block.id !== 'k-capture')
        .sort((a, b) => a.order - b.order)
        .map(({ id, ...copy }) => copy);
      return { notes: found.canvases, search: found.search_index, copies };
    };
    assert.deepEqual(await made(viaKernel), await made(viaStorage));
    // At version 8 the new Daily Note waits for the transform for its group too (review R88)
    assert.deepEqual(await groupsIn(viaKernel), {});
  });

  it(
    'a capture adds the block background.js adds, for a page and for selected text',
    { skip: !RUNS_MODULES && 'background.js runs as a module worker, which npm test can start' },
    async () => {
      const worker = await workerHarness.loadBackground();
      const { tab } = worker;
      await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page', pageUrl: tab.url }, tab);
      // The listener doesn't wait for its capture, and two at once can each make a Daily Note,
      // so the first lands before the second starts
      await workerHarness.readTodaysDailyNote(worker);
      await worker.dispatch(
        'contextMenus.onClicked',
        { menuItemId: 'capture-selection', selectionText: 'Quoted words' },
        tab,
      );
      const day = await workerHarness.readTodaysDailyNote(worker);

      const { viaKernel, kernel } = await twin();
      /** @type {import('../../js/kernel/core/domain/note.js').Capture[]} */
      const captures = [
        { type: 'bookmark', url: tab.url, title: tab.title },
        { type: 'text', content: 'Quoted words', source: tab.url },
      ];
      for (const [index, capture] of captures.entries()) {
        assertCommitted(
          await kernel.execute({
            type: 'captureToDailyNote',
            commandId: `c${index}`,
            noteId: 'd1',
            blockId: `k${index}`,
            capture,
          }),
        );
      }
      // Each side gives its blocks its own ids and orders them by the time they landed, which
      // two captures in one millisecond share, so they line up by type. Since #17 PR 2a that
      // time is each block's createdAt and updatedAt too, read as 'written' on both sides.
      /** @param {any[]} list */
      const blocks = list =>
        list
          .map(({ id, canvasId, order, ...block }) => ({ ...block, ordered: typeof order === 'number' }))
          .sort((a, b) => (a.type < b.type ? -1 : 1));
      const { elements } = await recordsIn(viaKernel, ['elements']);
      assert.equal(day && day.blocks.length, 2);
      assert.deepEqual(blocks(Object.values(elements)), blocks(stamped(legacyEnv.plain(day.blocks))));
    },
  );

  it('archiveNote, unarchiveNote, trashNote, and restoreNote leave the note Storage leaves', async () => {
    /** @type {Array<{type: string, fields: Record<string, unknown>, viaStorage: (storage: any) => Promise<unknown>}>} */
    const cases = [
      { type: 'archiveNote', fields: {}, viaStorage: storage => storage.archiveNote('n1') },
      {
        type: 'unarchiveNote',
        fields: { archived: true, archivedAt: SEEDED_AT },
        viaStorage: storage => storage.unarchiveNote('n1'),
      },
      {
        type: 'trashNote',
        fields: { archived: true, archivedAt: SEEDED_AT },
        viaStorage: storage => storage.trashNote('n1'),
      },
      {
        type: 'restoreNote',
        fields: { trashed: true, trashedAt: SEEDED_AT },
        viaStorage: storage => storage.restoreNote('n1'),
      },
    ];
    for (const { type, fields, viaStorage: run } of cases) {
      const { viaStorage, viaKernel, kernel } = await twin({
        canvases: [legacyEnv.note('n1', { name: 'Plan', ...fields })],
        elements: [legacyEnv.block('b1', 'n1', 0, '<p>Milk</p>')],
        search_index: [{ noteId: 'n1', name: 'Plan', content: 'Milk', updatedAt: SEEDED_AT }],
      });
      await run(viaStorage.storage);
      assertCommitted(await kernel.execute(/** @type {any} */ ({ type, commandId: 'c1', noteId: 'n1' })));
      const stores = ['canvases', 'elements'];
      assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores), type);
      assert.deepEqual(await searchNames(viaKernel), await searchNames(viaStorage), type);
      // A 1.4.x note stays without its group, which the transform fills from the flags then
      assert.deepEqual(await groupsIn(viaKernel), {}, type);
    }
  });

  it('trashNote deletes an untitled empty note with what Storage.trashNote deletes and its search entry, and trashes the others', async () => {
    const notes = ['u-empty', 'u-markup', 'u-divider', 'kept'].map(id =>
      legacyEnv.note(id, { name: id === 'kept' ? 'Kept' : 'Untitled' }),
    );
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: notes,
      elements: [
        legacyEnv.block('e1', 'u-empty', 0, ''),
        legacyEnv.block('e2', 'u-empty', 1, ' <br>&nbsp;'),
        legacyEnv.block('m1', 'u-markup', 0, '<p> </p>'),
        legacyEnv.block('d1', 'u-divider', 0, '', { type: 'divider' }),
        legacyEnv.block('k1', 'kept', 0, 'Kept text'),
      ],
      media: [
        { id: 'media-empty', canvasId: 'u-empty' },
        { id: 'media-kept', canvasId: 'kept' },
      ],
      vectors: [{ id: 'u-empty' }, { id: 'kept' }],
      snapshots: [
        { id: 's-empty', noteId: 'u-empty', timestamp: SEEDED_AT },
        { id: 's-kept', noteId: 'kept', timestamp: SEEDED_AT },
      ],
      search_index: notes.map(note => ({ noteId: note.id, name: note.name, content: '', updatedAt: SEEDED_AT })),
    });
    for (const noteId of ['u-empty', 'u-markup', 'u-divider']) {
      await viaStorage.storage.trashNote(noteId);
      assertCommitted(await kernel.execute({ type: 'trashNote', commandId: `c-${noteId}`, noteId }));
    }
    const stores = ['canvases', 'elements', 'media', 'vectors', 'snapshots'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
    // Since #17 PR 2b the kernel's deletion takes the note's search entry too, which Storage left
    const { 'u-empty': leftByStorage, ...kept } = await searchNames(viaStorage);
    assert.equal(leftByStorage, 'Untitled');
    assert.deepEqual(await searchNames(viaKernel), kept);
  });

  it("SidebarController's pin toggle, through setPinned, leaves the note 1.4.x's toggle left", async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [legacyEnv.note('n1', { name: 'Plan' })],
      search_index: [{ noteId: 'n1', name: 'Plan', content: '', updatedAt: SEEDED_AT }],
    });
    // 1.4.x's SidebarController.toggleNotePin: the stored note, its pin flipped, written whole
    const stored = await viaStorage.storage.getNote('n1');
    stored.pinned = !stored.pinned;
    await viaStorage.storage.updateNote(stored);
    // Today's, on the note list it shows, writing through the kernel
    viaKernel.env.load('js/controllers/sidebar-controller.js');
    viaKernel.env.get('Utils').showToast = () => {};
    const noteList = createNoteList({ query: kernel.query, subscribe: kernel.subscribe, whenReady: kernel.whenReady });
    await noteList.settled();
    const sidebar = Object.assign(Object.create(viaKernel.env.get('SidebarController').prototype), {
      documentClient: {
        setPinned: (/** @type {string} */ noteId, /** @type {boolean} */ pinned) =>
          kernel.execute({ type: 'setPinned', commandId: 'c1', noteId, pinned }),
      },
      _noteList: noteList,
    });
    await sidebar.toggleNotePin('n1');
    assert.deepEqual(await recordsIn(viaKernel, ['canvases']), await recordsIn(viaStorage, ['canvases']));
    assert.equal(noteList.note('n1')?.pinned, true);
  });

  it('ensureDailyNote makes the note, search entry, and template blocks Storage.ensureDailyNote makes, and finds it after', async () => {
    // At midday UTC on both sides, whose day is the local one too (MIDDAY_UTC)
    const { viaStorage, viaKernel, kernel } = await twin(
      {
        canvases: [legacyEnv.note('t1', { name: 'Daily template', isTemplate: true })],
        elements: [
          legacyEnv.block('t1-a', 't1', 0, '<p>{{title}}: plan</p>'),
          legacyEnv.block('t1-b', 't1', 1, '', {
            type: 'table',
            tableData: [
              ['{{title}}', 'Done'],
              ['', 'x'],
            ],
          }),
        ],
      },
      { at: MIDDAY_UTC },
    );
    for (const { storage } of [viaStorage, viaKernel]) await storage.setSetting('dailyNoteTemplate', 't1');
    const daily = legacyEnv.plain(await viaStorage.storage.ensureDailyNote());
    const made = await kernel.execute({ type: 'ensureDailyNote', commandId: 'c1', noteId: daily.id });
    assertCommitted(made);
    assert.deepEqual(made.kind === 'committed' && made.changedIds, [daily.id]);
    // Asked again, each finds the one it made
    assert.equal(legacyEnv.plain(await viaStorage.storage.ensureDailyNote()).id, daily.id);
    const found = await kernel.execute({ type: 'ensureDailyNote', commandId: 'c2', noteId: 'k-other' });
    assert.deepEqual(found.kind === 'committed' && [found.code, found.changedIds], ['daily-note-exists', []]);
    const read = await kernel.query({ type: 'findDailyNote', dateStr: daily.dateStr });
    assert.equal(
      read.kind === 'ready' && read.data.note.id,
      daily.id,
      'findDailyNote reads the one Storage would find',
    );
    assert.deepEqual(await dailyNoteMade(viaKernel, daily.id), await dailyNoteMade(viaStorage, daily.id));
    // No group at version 8 (review R88)
    assert.equal((await groupsIn(viaKernel))[daily.id], undefined);
  });

  it('ensureDailyNote for a calendar day makes what Storage.ensureDailyNoteForDate makes: its name, dateStr, and template', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [legacyEnv.note('t1', { name: 'Daily template', isTemplate: true })],
      elements: [legacyEnv.block('t1-a', 't1', 0, '<p>{{title}}</p>')],
    });
    for (const { storage } of [viaStorage, viaKernel]) await storage.setSetting('dailyNoteTemplate', 't1');
    // A day early in a month and one late in a year, as the calendar names them
    for (const [index, dateStr] of ['2026-03-01', '2025-12-31'].entries()) {
      const daily = legacyEnv.plain(await viaStorage.storage.ensureDailyNoteForDate(dateStr));
      assertCommitted(
        await kernel.execute({ type: 'ensureDailyNote', commandId: `c${index}`, noteId: daily.id, dateStr }),
      );
      assert.equal(daily.dateStr, dateStr);
      assert.deepEqual(await dailyNoteMade(viaKernel, daily.id), await dailyNoteMade(viaStorage, daily.id), dateStr);
      assert.equal((await groupsIn(viaKernel))[daily.id], undefined, dateStr);
    }
  });

  it("renameNote leaves the title the editor's title edit leaves, and a generated one what NotesManager's leaves", async () => {
    const records = () => ({
      canvases: [legacyEnv.note('n1', { name: 'Plan' })],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk, eggs, and bread for the week')],
      search_index: [{ noteId: 'n1', name: 'Plan', content: '', updatedAt: SEEDED_AT }],
    });
    /**
     * The fields a rename decides: the title, whether the user set it, when a model did, and
     * the search entry. The editor's save writes the rest of the note too.
     * @param {PageContext} context
     */
    const title = async context => {
      const found = await recordsIn(context, ['canvases', 'search_index']);
      const { name, titleManuallySet, lastAutoTitleAt } = found.canvases.n1;
      return { name, titleManuallySet, lastAutoTitleAt, search: found.search_index.n1 };
    };

    const typed = await twin(records());
    // 1.4.x's title edit: onTitleChange set the name and titleManuallySet on the editor's copy,
    // and its save wrote the copy with the blocks, then the search entry's name
    const { storage } = typed.viaStorage;
    const editorCopy = { ...(await storage.getNote('n1')), name: 'Groceries', titleManuallySet: true };
    await storage.saveNoteWithBlocks(editorCopy, await storage.getElementsByNote('n1'));
    await storage.updateNoteNameInSearchIndex('n1', 'Groceries');
    assertCommitted(
      await typed.kernel.execute({ type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'Groceries' }),
    );
    assert.deepEqual(await title(typed.viaKernel), await title(typed.viaStorage));

    const generated = await twin(records());
    // 1.4.x's NotesManager.generateTitleForNote: the stored note with the title and its time,
    // written whole with updateNote, which renames the search entry. NotesManager runs
    // renameNote now (#12 slice 4b2a), so this is its 1.4.x write, step for step.
    const stored = await generated.viaStorage.storage.getNote('n1');
    stored.name = 'Groceries';
    stored.lastAutoTitleAt = Date.now();
    await generated.viaStorage.storage.updateNote(stored);
    assertCommitted(
      await generated.kernel.execute({
        type: 'renameNote',
        commandId: 'c1',
        noteId: 'n1',
        name: 'Groceries',
        origin: 'generated',
      }),
    );
    const stores = ['canvases', 'search_index'];
    assert.deepEqual(await recordsIn(generated.viaKernel, stores), await recordsIn(generated.viaStorage, stores));
  });

  it('saveNoteContent leaves what Storage.saveNoteWithBlocks leaves, keeps the trash, and writes nothing to a deleted note', async () => {
    const stored = legacyEnv.note('n1', { name: 'Plan', trashed: true, trashedAt: SEEDED_AT });
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [stored],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
    });
    const blocks = [legacyEnv.block('b1', 'n1', 0, 'Milk and eggs'), legacyEnv.block('b2', 'n1', 1, 'Bread')];
    const todoProgress = { completed: 1, total: 2 };
    // The editor's copy of the note is from before the trash, and the stored trash state wins
    const editorCopy = { ...stored, trashed: false, trashedAt: null, preview: 'Milk and eggs', todoProgress };
    await viaStorage.storage.saveNoteWithBlocks(editorCopy, blocks);
    assertCommitted(
      await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c1',
        noteId: 'n1',
        blocks,
        preview: 'Milk and eggs',
        todoProgress,
      }),
    );
    // Deleted after the editor loaded it: neither side writes it back, its blocks included
    const lost = legacyEnv.block('g1', 'gone', 0, 'Lost');
    assert.equal(await viaStorage.storage.saveNoteWithBlocks(legacyEnv.note('gone'), [lost]), null);
    const refused = await kernel.execute({ type: 'saveNoteContent', commandId: 'c2', noteId: 'gone', blocks: [lost] });
    assert.equal(refused.kind, 'rejected');
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it('saveNoteContent with a typed title leaves the note, blocks, and search entry the editor saved it with', async () => {
    const stored = legacyEnv.note('n1', { name: 'Draft' });
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [stored],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
      search_index: [{ noteId: 'n1', name: 'Draft', content: 'Milk', updatedAt: SEEDED_AT }],
    });
    const blocks = [legacyEnv.block('b1', 'n1', 0, 'Milk and eggs')];
    // The title edit set the name and titleManuallySet on the editor's copy, its save wrote the
    // copy with the blocks, and then the search entry's name
    const editorCopy = { ...stored, name: 'Groceries', titleManuallySet: true, preview: 'Milk and eggs' };
    await viaStorage.storage.saveNoteWithBlocks(editorCopy, blocks);
    await viaStorage.storage.updateNoteNameInSearchIndex('n1', 'Groceries');
    assertCommitted(
      await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c1',
        noteId: 'n1',
        blocks,
        preview: 'Milk and eggs',
        name: 'Groceries',
      }),
    );
    const stores = ['canvases', 'elements', 'search_index'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it('saveNoteContent with a generated title leaves what the editor saved after setTitleProgrammatically', async () => {
    const stored = legacyEnv.note('n1', { name: 'Untitled', lastAutoTitleAt: null });
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [stored],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
      search_index: [{ noteId: 'n1', name: 'Untitled', content: 'Milk', updatedAt: SEEDED_AT }],
    });
    const blocks = [legacyEnv.block('b1', 'n1', 0, 'Milk and eggs')];
    // setTitleProgrammatically set the name and lastAutoTitleAt on the editor's copy, leaving
    // titleManuallySet, and the save wrote the copy with the blocks, then the search entry's name
    const editorCopy = { ...stored, name: 'Groceries', lastAutoTitleAt: Date.now(), preview: 'Milk and eggs' };
    await viaStorage.storage.saveNoteWithBlocks(editorCopy, blocks);
    await viaStorage.storage.updateNoteNameInSearchIndex('n1', 'Groceries');
    assertCommitted(
      await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c1',
        noteId: 'n1',
        blocks,
        preview: 'Milk and eggs',
        name: 'Groceries',
        titleOrigin: 'generated',
      }),
    );
    const stores = ['canvases', 'elements', 'search_index'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it("saveNoteContent's wiki links are the ones Storage.updateNoteLinks writes after the save", async () => {
    const at = (/** @type {number} */ offset) => SEEDED_AT + offset;
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [
        legacyEnv.note('n1', { name: 'Plan', updatedAt: at(1) }),
        legacyEnv.note('old', { name: 'groceries', updatedAt: at(2) }),
        legacyEnv.note('new', { name: 'Groceries', updatedAt: at(3) }),
        legacyEnv.note('archived', { name: 'Archive me', archived: true, archivedAt: at(4) }),
        legacyEnv.note('trashed', { name: 'Trash me', trashed: true, trashedAt: at(5) }),
        legacyEnv.note('template', { name: 'Template', isTemplate: true }),
        legacyEnv.note('n2', { name: 'Linker' }),
      ],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
      links: [
        { id: 'l-old', fromNoteId: 'n1', toNoteId: 'old', createdAt: SEEDED_AT },
        { id: 'l-in', fromNoteId: 'n2', toNoteId: 'n1', createdAt: SEEDED_AT },
      ],
    });
    const linkedNames = ['GROCERIES', 'Archive me', 'Trash me', 'Template', 'Plan', 'Nowhere', 'groceries'];
    const blocks = [legacyEnv.block('b1', 'n1', 0, '[[Groceries]] and the rest')];
    const stored = legacyEnv.plain(await viaStorage.storage.getNote('n1'));
    await viaStorage.storage.saveNoteWithBlocks(stored, blocks);
    await viaStorage.storage.updateNoteLinks('n1', linkedNames);
    assertCommitted(
      await kernel.execute({ type: 'saveNoteContent', commandId: 'c1', noteId: 'n1', blocks, linkedNames }),
    );
    // Each side gives its links ids of its own, so they compare by what they link
    /** @param {PageContext} context */
    const links = async context =>
      Object.values((await recordsIn(context, ['links'])).links)
        .map(({ id, ...link }) => link)
        .sort((a, b) => `${a.fromNoteId}>${a.toNoteId}`.localeCompare(`${b.fromNoteId}>${b.toNoteId}`));
    assert.deepEqual(await links(viaKernel), await links(viaStorage));
    assert.deepEqual(
      (await links(viaKernel)).map(link => [link.fromNoteId, link.toNoteId]),
      [
        ['n1', 'archived'],
        ['n1', 'new'],
        ['n2', 'n1'],
      ],
    );

    // A save with no links clears them, as Storage.clearLinksFromNote does
    await viaStorage.storage.updateNoteLinks('n1', []);
    assertCommitted(
      await kernel.execute({ type: 'saveNoteContent', commandId: 'c2', noteId: 'n1', blocks, linkedNames: [] }),
    );
    assert.deepEqual(await links(viaKernel), await links(viaStorage));
  });

  it('deleteBlocks leaves the blocks Storage.deleteElement leaves, one call per block', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [legacyEnv.note('n1'), legacyEnv.note('n2')],
      elements: [
        legacyEnv.block('a', 'n1', 0, 'Kept'),
        legacyEnv.block('b', 'n1', 1, 'Deleted'),
        legacyEnv.block('c', 'n1', 2, 'Deleted too'),
        legacyEnv.block('d', 'n2', 0, 'Another note'),
      ],
    });
    const blockIds = ['b', 'c', 'never-saved'];
    for (const id of blockIds) await viaStorage.storage.deleteElement(id);
    assertCommitted(await kernel.execute({ type: 'deleteBlocks', commandId: 'c1', noteId: 'n1', blockIds }));
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it('getBacklinks lists the notes Storage.getBacklinks lists, in its order', async () => {
    const { viaStorage, kernel } = await twin({
      canvases: [
        legacyEnv.note('target', { name: 'Target' }),
        legacyEnv.note('plain', { name: 'Plain' }),
        legacyEnv.note('archived', { name: 'Archived', archived: true, archivedAt: SEEDED_AT }),
        legacyEnv.note('trashed', { name: 'Trashed', trashed: true, trashedAt: SEEDED_AT }),
        legacyEnv.note('template', { name: 'Template', isTemplate: true }),
      ],
      links: [
        { id: 'l3', fromNoteId: 'trashed', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l1', fromNoteId: 'plain', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l4', fromNoteId: 'template', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l2', fromNoteId: 'archived', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l5', fromNoteId: 'gone', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l6', fromNoteId: 'target', toNoteId: 'plain', createdAt: SEEDED_AT },
      ],
    });
    for (const noteId of ['target', 'plain', 'nothing']) {
      const state = await kernel.query({ type: 'getBacklinks', noteId });
      assert.deepEqual(
        state.kind === 'ready' ? legacyEnv.plain(state.data) : [],
        legacyEnv.plain(await viaStorage.storage.getBacklinks(noteId)),
        noteId,
      );
    }
  });

  it("moveFolder refuses the moves SidebarController.isChildFolder refuses, and writes what the sidebar's move writes", async () => {
    const folders = [
      folder('f1', null),
      folder('f2', 'f1'),
      folder('f3', 'f2'),
      folder('f4', null),
      folder('f5', 'f4'),
    ];
    const { viaStorage, viaKernel, kernel } = await twin({ folders });
    viaStorage.env.load('js/controllers/sidebar-controller.js');
    // The sidebar lists the folders its note list lists
    const noteList = { folders: () => folders, subscribe: () => () => {} };
    const sidebar = Object.assign(Object.create(viaStorage.env.get('SidebarController').prototype), { noteList });
    for (const dragged of folders) {
      for (const target of folders) {
        assert.equal(
          createsCycle(folders, dragged.id, target.id),
          sidebar.isChildFolder(dragged.id, target.id),
          `${dragged.id} into ${target.id}`,
        );
      }
    }
    // A drop the sidebar takes sets the dragged folder's parentId and writes it with updateFolder
    await viaStorage.storage.updateFolder({ ...folder('f4', null), parentId: 'f3' });
    assertCommitted(await kernel.execute({ type: 'moveFolder', commandId: 'c1', folderId: 'f4', parentId: 'f3' }));
    assert.deepEqual(await recordsIn(viaKernel, ['folders']), await recordsIn(viaStorage, ['folders']));
  });

  it("renameFolder and setFolderCollapsed write what the sidebar's rename and collapse wrote with updateFolder", async () => {
    const { viaStorage, viaKernel, kernel } = await twin({ folders: [folder('f1', null), folder('f2', 'f1')] });
    // The sidebar wrote a copy of the listed folder with the one field changed
    await viaStorage.storage.updateFolder({ ...folder('f1', null), name: 'Work' });
    await viaStorage.storage.updateFolder({ ...folder('f2', 'f1'), collapsed: true });
    assertCommitted(await kernel.execute({ type: 'renameFolder', commandId: 'c1', folderId: 'f1', name: 'Work' }));
    assertCommitted(
      await kernel.execute({ type: 'setFolderCollapsed', commandId: 'c2', folderId: 'f2', collapsed: true }),
    );
    assert.deepEqual(await recordsIn(viaKernel, ['folders']), await recordsIn(viaStorage, ['folders']));
  });

  it('deleteFolder deletes what Storage.deleteFolder deletes and files its notes at the root, and its trashed notes and templates too', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      folders: [folder('a', null), folder('b', 'a'), folder('c', 'b'), folder('other', null), folder('loop', 'loop')],
      canvases: [
        legacyEnv.note('inA', { folderId: 'a' }),
        legacyEnv.note('inC', { folderId: 'c' }),
        legacyEnv.note('archived', { folderId: 'b', archived: true, archivedAt: SEEDED_AT }),
        legacyEnv.note('trashed', { folderId: 'c', trashed: true, trashedAt: SEEDED_AT }),
        legacyEnv.note('template', { folderId: 'b', isTemplate: true }),
        legacyEnv.note('elsewhere', { folderId: 'other' }),
      ],
    });
    await viaStorage.storage.deleteFolder('a');
    assertCommitted(await kernel.execute({ type: 'deleteFolder', commandId: 'c1', folderId: 'a' }));
    await viaStorage.storage.deleteFolder('loop');
    assertCommitted(await kernel.execute({ type: 'deleteFolder', commandId: 'c2', folderId: 'loop' }));
    const stores = ['folders', 'canvases'];
    const expected = await recordsIn(viaStorage, stores);
    // The one rule #12 slice 5 changes on purpose: Storage left a trashed note and a template on
    // the deleted folder, so once restored no list showed it. The kernel files them at the root too.
    for (const noteId of ['trashed', 'template']) {
      assert.equal(expected.canvases[noteId].folderId === null, false, `Storage kept ${noteId}'s folder`);
      expected.canvases[noteId] = { ...expected.canvases[noteId], folderId: null, updatedAt: 'written' };
    }
    assert.deepEqual(await recordsIn(viaKernel, stores), expected);
  });

  it('moveNoteToFolder writes what Storage.moveNoteToFolder writes, into a folder and back to the root', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      folders: [folder('f1', null)],
      canvases: [legacyEnv.note('n1', { name: 'Plan' }), legacyEnv.note('n2', { name: 'Filed', folderId: 'f1' })],
      search_index: [
        { noteId: 'n1', name: 'Plan', content: '', updatedAt: SEEDED_AT },
        { noteId: 'n2', name: 'Filed', content: '', updatedAt: SEEDED_AT },
      ],
    });
    await viaStorage.storage.moveNoteToFolder('n1', 'f1');
    await viaStorage.storage.moveNoteToFolder('n2', null);
    assertCommitted(await kernel.execute({ type: 'moveNoteToFolder', commandId: 'c1', noteId: 'n1', folderId: 'f1' }));
    assertCommitted(await kernel.execute({ type: 'moveNoteToFolder', commandId: 'c2', noteId: 'n2', folderId: null }));
    assert.deepEqual(await recordsIn(viaKernel, ['canvases']), await recordsIn(viaStorage, ['canvases']));
    assert.deepEqual(await searchNames(viaKernel), await searchNames(viaStorage));
  });

  it("convertNoteToTemplate and convertTemplateToNote write what NotesManager's conversions wrote with updateNote", async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      folders: [folder('f1', null)],
      canvases: [legacyEnv.note('n1', { name: 'Plan', folderId: 'f1' }), legacyEnv.note('t1', { isTemplate: true })],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
    });
    // NotesManager read the note, set isTemplate (and, into a template, folderId null), and wrote it
    const note = await viaStorage.storage.getNote('n1');
    await viaStorage.storage.updateNote({ ...note, isTemplate: true, folderId: null });
    const template = await viaStorage.storage.getNote('t1');
    await viaStorage.storage.updateNote({ ...template, isTemplate: false });
    assertCommitted(await kernel.execute({ type: 'convertNoteToTemplate', commandId: 'c1', noteId: 'n1' }));
    assertCommitted(await kernel.execute({ type: 'convertTemplateToNote', commandId: 'c2', noteId: 't1' }));
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it("deleteNotePermanently, emptyTrash, and runTrashCleanup delete what Storage deletes and the notes' search entries and links too, and keep the same notes; a trashed note without an indexed updatedAt goes with Empty trash, and retention waits for the transform's time in the trash (#17 PR 3a, KD-011)", async () => {
    const day = 24 * 60 * 60 * 1000;
    const recently = Date.now() - 2 * day;
    const lastWeek = Date.now() - 8 * day;
    const profile = () => ({
      canvases: [
        legacyEnv.note('old', { trashed: true, trashedAt: SEEDED_AT }),
        legacyEnv.note('week', { trashed: true, trashedAt: lastWeek }),
        legacyEnv.note('recent', { trashed: true, trashedAt: recently }),
        legacyEnv.note('no-time', { trashed: true, trashedAt: null }),
        legacyEnv.note('unindexed', { trashed: true, trashedAt: SEEDED_AT, updatedAt: undefined }),
        legacyEnv.note('active', { name: 'Active' }),
      ],
      elements: ['old', 'week', 'recent', 'no-time', 'unindexed', 'active'].map(id =>
        legacyEnv.block(`${id}-b`, id, 0, id),
      ),
      media: [
        { id: 'm-old', canvasId: 'old' },
        { id: 'm-active', canvasId: 'active' },
      ],
      vectors: [{ id: 'old' }, { id: 'recent' }, { id: 'active' }],
      snapshots: [
        { id: 's-old', noteId: 'old', timestamp: SEEDED_AT },
        { id: 's-recent', noteId: 'recent', timestamp: SEEDED_AT },
      ],
      links: [{ id: 'l1', fromNoteId: 'old', toNoteId: 'active', createdAt: SEEDED_AT }],
      search_index: [{ noteId: 'old', name: 'old', content: '', updatedAt: SEEDED_AT }],
    });
    const stores = ['canvases', 'elements', 'media', 'vectors', 'snapshots', 'links', 'search_index'];
    /**
     * @param {(storage: any) => Promise<unknown>} viaStorageRun
     * @param {(kernel: Kernel) => Promise<Outcome | BulkOutcome>} viaKernelRun
     * @param {string} name
     * @param {boolean} filled - whether both profiles hold what #17's transform fills, first
     * @returns {Promise<string[]>} the ids the kernel named
     */
    const both = async (viaStorageRun, viaKernelRun, name, filled) => {
      const { viaStorage, viaKernel, kernel } = await twin(profile());
      if (filled) for (const context of [viaStorage, viaKernel]) await filledAsTheTransformFills(context);
      await viaStorageRun(viaStorage.storage);
      const outcome = await viaKernelRun(kernel);
      assertCommitted(outcome);
      const deleted = new Set(outcome.kind === 'committed' ? outcome.changedIds : []);
      // Since #17 PR 3a the kernel lists a trashed note without an updatedAt the index holds
      // (KD-011), so Empty trash takes that one too, which Storage's index reaches once the
      // transform has filled the field. Retention doesn't take it until then: the transform
      // starts its time in the trash, now, so it's in Trash for a whole window first.
      const onlyKernel = new Set(filled ? [] : ['unindexed'].filter(id => deleted.has(id)));
      // Since #17 PR 2b the kernel's deletion also takes each note's search entry and its links
      // both ways, which Storage left
      const left = await recordsIn(viaStorage, stores);
      const expected = {
        ...left,
        canvases: Object.fromEntries(Object.entries(left.canvases).filter(([key]) => !onlyKernel.has(key))),
        elements: Object.fromEntries(
          Object.entries(left.elements).filter(([, /** @type {any} */ block]) => !onlyKernel.has(block.canvasId)),
        ),
        search_index: Object.fromEntries(Object.entries(left.search_index).filter(([key]) => !deleted.has(key))),
        links: Object.fromEntries(
          Object.entries(left.links).filter(
            ([, /** @type {any} */ link]) => !deleted.has(link.fromNoteId) && !deleted.has(link.toNoteId),
          ),
        ),
      };
      assert.deepEqual(await recordsIn(viaKernel, stores), expected, `${name}${filled ? ', filled' : ''}`);
      return [...deleted].sort();
    };
    for (const filled of [false, true]) {
      assert.deepEqual(
        await both(
          storage => storage.permanentlyDeleteNote('old'),
          kernel => kernel.execute({ type: 'deleteNotePermanently', commandId: 'c1', noteId: 'old' }),
          'deleteNotePermanently',
          filled,
        ),
        ['old'],
      );
      assert.deepEqual(
        await both(
          storage => storage.emptyTrash(),
          kernel => kernel.execute({ type: 'emptyTrash', commandId: 'c1' }),
          'emptyTrash',
          filled,
        ),
        ['no-time', 'old', 'recent', 'unindexed', 'week'],
      );
      // SidebarController.runTrashCleanup read trashRetention, 30 unless set, and passed it on
      assert.deepEqual(
        await both(
          storage => storage.cleanupTrash(30),
          kernel => kernel.execute({ type: 'runTrashCleanup', commandId: 'c1' }),
          'runTrashCleanup, 30 days',
          filled,
        ),
        ['old'],
      );
      assert.deepEqual(
        await both(
          storage => storage.cleanupTrash(7),
          async kernel => {
            assertCommitted(
              await kernel.execute({ type: 'setPreferences', commandId: 'p1', values: { trashRetention: 7 } }),
            );
            return kernel.execute({ type: 'runTrashCleanup', commandId: 'c1' });
          },
          'runTrashCleanup, 7 days',
          filled,
        ),
        ['old', 'week'],
      );
    }
  });

  it("listNotes lists each view in the order Storage lists it, and a note without an indexed updatedAt where Storage lists it once the transform's fill is in (#17 PR 3a, KD-011)", async () => {
    const at = (/** @type {number} */ offset) => SEEDED_AT + offset;
    const { viaStorage, kernel } = await twin({
      canvases: [
        legacyEnv.note('a', { updatedAt: at(5) }),
        legacyEnv.note('b', { updatedAt: at(5) }),
        legacyEnv.note('c', { updatedAt: at(9), pinned: true }),
        legacyEnv.note('archived-1', { updatedAt: at(1), archived: true, archivedAt: at(30) }),
        legacyEnv.note('archived-2', { updatedAt: at(7), archived: true, archivedAt: at(20) }),
        legacyEnv.note('archived-3', { updatedAt: at(2), archived: true, archivedAt: null }),
        legacyEnv.note('trashed-1', { updatedAt: at(3), trashed: true, trashedAt: at(10) }),
        legacyEnv.note('trashed-2', { updatedAt: at(4), trashed: true, trashedAt: at(40), archived: true }),
        legacyEnv.note('template-1', { updatedAt: at(6), isTemplate: true }),
        legacyEnv.note('template-2', { updatedAt: at(8), isTemplate: true }),
        legacyEnv.note('template-trashed', { updatedAt: at(11), isTemplate: true, trashed: true, trashedAt: at(1) }),
        legacyEnv.note('no-time', { updatedAt: undefined }),
      ],
    });
    const { storage } = viaStorage;
    /** @type {Array<[NoteView, () => Promise<Array<{id: string}>>]>} */
    const views = [
      ['active', () => storage.getAllNotes()],
      ['withArchived', () => storage.getAllNotes(true)],
      ['archived', () => storage.getArchivedNotes()],
      ['trashed', () => storage.getTrashedNotes()],
      ['templates', () => storage.getTemplates()],
    ];
    /** @param {boolean} filled */
    const sameAsStorage = async filled => {
      for (const [view, read] of views) {
        const state = await kernel.query({ type: 'listNotes', view });
        const ids = state.kind === 'ready' ? state.data.map(note => note.id) : [];
        const storageIds = legacyEnv.plain(await read()).map((/** @type {{id: string}} */ note) => note.id);
        // The kernel lists the note without an indexed updatedAt last, by its createdAt, the
        // oldest time here (KD-011), and Storage once the transform has filled the field
        const expected = !filled && ['active', 'withArchived'].includes(view) ? [...storageIds, 'no-time'] : storageIds;
        assert.deepEqual(ids, expected, `${view}${filled ? ', filled' : ''}`);
      }
    };
    await sameAsStorage(false);
    await filledAsTheTransformFills(viaStorage);
    await sameAsStorage(true);
  });

  it("the note list's views list what Storage lists, in its order, at load and after each commit, and the note without an indexed updatedAt last (#17 PR 3a, KD-011)", async () => {
    const at = (/** @type {number} */ offset) => SEEDED_AT + offset;
    const context = releaseContext();
    opened.push(context);
    await legacyEnv.createDatabase(context.env.indexedDB, {
      records: {
        canvases: [
          legacyEnv.note('a', { updatedAt: at(5) }),
          legacyEnv.note('b', { updatedAt: at(5) }),
          legacyEnv.note('c', { updatedAt: at(9), pinned: true }),
          legacyEnv.note('archived-1', { updatedAt: at(1), archived: true, archivedAt: at(30) }),
          legacyEnv.note('archived-2', { updatedAt: at(2), archived: true, archivedAt: null }),
          legacyEnv.note('trashed-1', { updatedAt: at(3), trashed: true, trashedAt: at(10) }),
          legacyEnv.note('trashed-2', { updatedAt: at(4), trashed: true, trashedAt: at(40), archived: true }),
          legacyEnv.note('template-1', { updatedAt: at(6), isTemplate: true }),
          legacyEnv.note('template-2', { updatedAt: at(8), isTemplate: true }),
          legacyEnv.note('template-trashed', { updatedAt: at(11), isTemplate: true, trashed: true, trashedAt: at(1) }),
          legacyEnv.note('no-time', { updatedAt: undefined }),
        ],
        folders: [folder('f2', null), folder('f1', 'f2')],
        search_index: [
          { noteId: 'a', name: 'a', content: 'alpha', updatedAt: at(5) },
          { noteId: 'c', name: 'c', content: 'gamma', updatedAt: at(9) },
        ],
      },
    });
    const kernel = await kernelOver(context);
    const list = createNoteList({ query: kernel.query, subscribe: kernel.subscribe, whenReady: kernel.whenReady });
    const { storage } = context;
    await storage.open();
    /** @type {Array<[NoteView, () => Promise<Array<{id: string}>>]>} */
    const views = [
      ['active', () => storage.getAllNotes()],
      ['withArchived', () => storage.getAllNotes(true)],
      ['archived', () => storage.getArchivedNotes()],
      ['trashed', () => storage.getTrashedNotes()],
      ['templates', () => storage.getTemplates()],
    ];
    const sameAsStorage = async (/** @type {string} */ when) => {
      await list.settled();
      for (const [view, read] of views) {
        const listed = legacyEnv.plain(list.view(view));
        // Storage's index leaves out the note without an updatedAt, which the kernel lists by its
        // createdAt, older than every other note here (KD-011)
        if (view === 'active' || view === 'withArchived') {
          assert.equal(listed.at(-1)?.id, 'no-time', `${view} ${when}`);
          listed.pop();
        }
        assert.deepEqual(listed, legacyEnv.plain(await read()), `${view} ${when}`);
      }
      assert.deepEqual(
        legacyEnv.plain(list.folders()),
        legacyEnv.plain(await storage.getAllFolders()),
        `folders ${when}`,
      );
      const byNote = (/** @type {Array<{noteId: string}>} */ entries) =>
        [...entries].sort((x, y) => x.noteId.localeCompare(y.noteId));
      assert.deepEqual(
        byNote(legacyEnv.plain(list.searchEntries())),
        byNote(legacyEnv.plain(await storage.getSearchIndex())),
        `search entries ${when}`,
      );
    };
    await sameAsStorage('at load');
    let count = 0;
    /** @param {Record<string, unknown> & {type: string}} command */
    const run = async command => {
      // Apart in time, so each commit's updatedAt orders the lists
      await new Promise(resolve => setTimeout(resolve, 2));
      assertCommitted(await kernel.execute(/** @type {any} */ ({ ...command, commandId: `c${++count}` })));
      await sameAsStorage(`after ${command.type}`);
    };
    await run({ type: 'renameNote', noteId: 'b', name: 'Renamed' });
    await run({ type: 'saveNoteContent', noteId: 'a', blocks: [legacyEnv.block('a1', 'a', 0, 'saved')] });
    await run({ type: 'setPinned', noteId: 'b', pinned: true });
    await run({ type: 'archiveNote', noteId: 'c' });
    await run({ type: 'unarchiveNote', noteId: 'archived-2' });
    await run({ type: 'trashNote', noteId: 'a' });
    await run({ type: 'restoreNote', noteId: 'trashed-1' });
    await run({ type: 'createNote', noteId: 'new', name: 'New', folderId: 'f1' });
    await run({ type: 'createFolder', folderId: 'f3', name: 'f3', parentId: null });
    await run({ type: 'moveFolder', folderId: 'f3', parentId: 'f1' });
  });

  it('getNoteBlocks lists blocks in the order the editor loads them', async () => {
    const { viaStorage, kernel } = await twin({
      canvases: [legacyEnv.note('n1')],
      elements: [
        legacyEnv.block('z', 'n1', 1, 'one'),
        legacyEnv.block('y', 'n1', 0, 'zero'),
        legacyEnv.block('x', 'n1', 1, 'one again'),
        legacyEnv.block('w', 'n1', 2, 'two'),
        legacyEnv.block('v', 'n1', undefined, 'no order'),
      ],
    });
    viaStorage.env.load(...EDITOR_FILES);
    // The editor on 1.4.x's reads, Storage.getNote and getElementsByNote, which loadNote sorts
    const { storage } = viaStorage;
    const editor = legacyEnv.makeEditor(viaStorage.env, viaStorage.env.document, {
      documentClient: {
        openNote: async (/** @type {string} */ id) => ({
          note: await storage.getNote(id),
          blocks: await storage.getElementsByNote(id),
        }),
      },
    });
    await legacyEnv.runUntil(viaStorage.env, editor.loadNote('n1'));
    const state = await kernel.query({ type: 'getNoteBlocks', noteId: 'n1' });
    assert.deepEqual(
      state.kind === 'ready' ? state.data.map(block => block.id) : [],
      editor.blocks.map((/** @type {{id: string}} */ block) => block.id),
    );
  });

  it("the document client's blocksAsStored lists a note's blocks as Storage.getElementsByNote does: by id, never by order", async () => {
    // Ids that sort against the blocks' order, blocks that share an order, an upper-case id,
    // which sorts before every lower-case one, and another note's block
    const { viaStorage, kernel } = await twin({
      canvases: [legacyEnv.note('n1'), legacyEnv.note('n2')],
      elements: [
        legacyEnv.block('z', 'n1', 0, 'zero'),
        legacyEnv.block('m', 'n1', 1, 'one'),
        legacyEnv.block('a', 'n1', 2, 'two'),
        legacyEnv.block('q', 'n1', 1, 'one again'),
        legacyEnv.block('c', 'n1', 1, 'one more'),
        legacyEnv.block('B', 'n1', 3, 'three'),
        legacyEnv.block('k', 'n2', 0, 'elsewhere'),
      ],
    });
    const asStored = legacyEnv.plain(await viaStorage.storage.getElementsByNote('n1'));
    assert.deepEqual(
      asStored.map((/** @type {{id: string}} */ block) => block.id),
      ['B', 'a', 'c', 'm', 'q', 'z'],
    );
    const documentClient = createDocumentClient(/** @type {any} */ ({ ...kernel, ids: testIds('d') }));
    assert.deepEqual(legacyEnv.plain(await documentClient.blocksAsStored('n1')), asStored);
  });

  it("the jobs' bookkeeping reads back through Storage's settings, both ways, under 1.4.x's keys", async () => {
    const { viaKernel, kernel } = await twin();
    const { storage } = viaKernel;

    // The kernel writes, and Storage reads them where NotesManager and the editor read them
    const before = Date.now();
    assertCommitted(await kernel.execute({ type: 'setInsightsPending', commandId: 'c1', noteId: 'n1', pending: true }));
    assertCommitted(await kernel.execute({ type: 'recordJobRun', commandId: 'c2', job: 'autoTitle' }));
    assertCommitted(await kernel.execute({ type: 'recordJobRun', commandId: 'c3', job: 'insights' }));
    const [since, lastAutoTitleRun, lastInsightsRun] = legacyEnv.plain([
      await storage.getSetting('insightsExtracting_n1', null),
      await storage.getSetting('lastAutoTitleRun', 0),
      await storage.getSetting('lastInsightsRun', 0),
    ]);
    for (const time of [since, lastAutoTitleRun, lastInsightsRun]) assert.ok(time >= before && time <= Date.now());
    // Cleared with null, as NotesManager cleared it with setSetting(key, null)
    assertCommitted(
      await kernel.execute({ type: 'setInsightsPending', commandId: 'c4', noteId: 'n1', pending: false }),
    );
    const stored = legacyEnv.plain(
      await new Promise(resolve => viaKernel.env.chrome.api.storage.local.get(null, resolve)),
    );
    assert.equal(stored.setting_insightsExtracting_n1, null);
    assert.ok(Object.hasOwn(stored, 'setting_insightsExtracting_n1'));

    // Storage writes, as 1.4.x's NotesManager did, and the kernel reads
    await storage.setSetting('insightsExtracting_n2', 1700000000500);
    await storage.setSetting('lastAutoTitleRun', 1700000000600);
    await storage.setSetting('lastInsightsRun', 1700000000700);
    const pending = await kernel.query({ type: 'getInsightsPending', noteId: 'n2' });
    const runs = await kernel.query({ type: 'getJobRuns' });
    assert.deepEqual(legacyEnv.plain([pending.kind === 'ready' && pending.data, runs.kind === 'ready' && runs.data]), [
      { since: 1700000000500 },
      { lastAutoTitleRun: 1700000000600, lastInsightsRun: 1700000000700 },
    ]);
  });

  it("preferences and the workspace session read back through Storage's settings and TabController, both ways", async () => {
    const { viaKernel, kernel } = await twin();
    const { env, storage } = viaKernel;
    env.load('js/controllers/tab-controller.js');
    const TabController = env.get('TabController');

    // The kernel writes, and Storage and TabController read them the way the new tab does
    assertCommitted(
      await kernel.execute({ type: 'setPreferences', commandId: 'c1', values: { sidebarWidth: 300, theme: 'dark' } }),
    );
    const session = {
      openTabs: [{ noteId: 'n1', name: 'Plan' }],
      activeTabIndex: 0,
      splitViewEnabled: true,
      secondaryNoteId: 'n2',
      lastOpenedNoteId: 'n1',
    };
    assertCommitted(await kernel.execute({ type: 'saveWorkspaceSession', commandId: 'c2', session }));
    assert.deepEqual(
      legacyEnv.plain([
        await storage.getSetting('sidebarWidth'),
        await storage.getSetting('theme'),
        await storage.getSetting('openTabs', null),
        await storage.getSetting('activeTabIndex', 0),
        await storage.getSetting('splitViewEnabled', false),
        await storage.getSetting('secondaryNoteId', null),
        // Under its own name, as 1.4.x's TabController.cacheLastOpenedNoteId wrote it
        env.chrome.local.lastOpenedNoteId,
      ]),
      [300, 'dark', session.openTabs, 0, true, 'n2', 'n1'],
    );

    // Storage writes, and TabController saves through the settings port (slice 6), in one
    // chrome.storage.local set under 1.4.x's keys, and the kernel reads
    await storage.setSetting('font', 'serif');
    const tabs = new TabController({
      settings: createSettingsClient({ ...kernel, ids: testIds('s') }),
      domRefs: null,
      logger: null,
    });
    tabs.openTabs = [
      { noteId: 'n3', name: 'Three' },
      { noteId: 'n4', name: 'Four' },
    ];
    tabs.activeTabIndex = 1;
    tabs.splitViewEnabled = false;
    tabs.secondaryEditor = { noteId: 'n4' };
    const writesBefore = env.chrome.writes().length;
    await tabs.saveTabs({ lastOpenedNoteId: 'n4' });
    assert.equal(env.chrome.writes().length - writesBefore, 1, 'the tabs and the last-opened note are one write');
    await legacyEnv.settle();
    assert.deepEqual(
      legacyEnv.plain([
        env.chrome.local.setting_openTabs,
        env.chrome.local.setting_activeTabIndex,
        env.chrome.local.setting_splitViewEnabled,
        env.chrome.local.setting_secondaryNoteId,
        env.chrome.local.lastOpenedNoteId,
      ]),
      [tabs.openTabs, 1, false, 'n4', 'n4'],
    );
    const preferences = await kernel.query({ type: 'getPreferences', keys: ['font'] });
    const saved = await kernel.query({ type: 'getWorkspaceSession' });
    assert.deepEqual(
      legacyEnv.plain([preferences.kind === 'ready' && preferences.data, saved.kind === 'ready' && saved.data]),
      [
        { font: 'serif' },
        {
          openTabs: tabs.openTabs,
          activeTabIndex: 1,
          splitViewEnabled: false,
          secondaryNoteId: 'n4',
          lastOpenedNoteId: 'n4',
        },
      ],
    );
  });
  // ============ Chat history, themes, onboarding, and backups (#12 slice 6) ============

  /**
   * Everything chrome.storage.local holds for `context`, with a time a write stamped read as
   * 'written'
   * @param {PageContext} context
   * @returns {Promise<Record<string, any>>}
   */
  const localOf = async context => {
    const stored = legacyEnv.plain(
      await new Promise(resolve => context.env.chrome.api.storage.local.get(null, resolve)),
    );
    const now = Date.now();
    return JSON.parse(
      JSON.stringify(stored, (key, value) =>
        typeof value === 'number' && value > SEEDED_AT && value <= now ? 'written' : value,
      ),
    );
  };

  it("chat history, prompt templates, onboarding, and the backup records land where 1.4.x's setSetting calls put them", async () => {
    const { viaStorage, viaKernel, kernel } = await twin();
    const history = [{ role: 'user', content: 'Plan the week' }];
    const messages = [{ type: 'user', content: 'Plan the week', timestamp: 1 }];
    const templates = [{ id: 't1', label: 'Sum', prompt: 'Summarize', scope: 'note' }];

    // What AIChatController, OnboardingManager, SettingsController, and ExportNotice wrote in 1.4.x
    const storage = viaStorage.storage;
    await storage.setSetting('aiChatHistory', history);
    await storage.setSetting('noteChatMessages', messages);
    await storage.setSetting('globalChatHistory', []);
    await storage.setSetting('globalChatMessages', []);
    await storage.setSetting('aiPromptTemplates', templates);
    await storage.setSetting('embeddingsEnabled', true);
    await storage.setSetting('autoTitleEnabled', true);
    await storage.setSetting('insightsEnabled', true);
    await storage.setSetting('hasCompletedOnboarding', true);
    await storage.setSetting('lastFullExportAt', Date.now());
    await storage.setSetting('lastBackupAt', Date.now());
    await storage.setSetting('preMigrationNotice', { version: 1, outcome: 'exported', at: Date.now() });

    // The same through the kernel
    let n = 0;
    const send = async (/** @type {any} */ fields) =>
      assertCommitted(await kernel.execute({ ...fields, commandId: `w${(n += 1)}` }));
    await send({ type: 'saveChatHistory', chat: 'note', history, messages });
    await send({ type: 'saveChatHistory', chat: 'global', history: [], messages: [] });
    await send({ type: 'savePromptTemplates', templates });
    await send({
      type: 'setPreferences',
      values: { embeddingsEnabled: true, autoTitleEnabled: true, insightsEnabled: true },
    });
    await send({ type: 'completeOnboarding' });
    await send({ type: 'recordBackup', fullExport: true, backup: true });
    await send({ type: 'recordExportNotice', version: 1, outcome: 'exported' });

    assert.deepEqual(await localOf(viaKernel), await localOf(viaStorage));
  });

  it('saveTheme stores the record Storage.saveCustomTheme stores for the Theme Builder', async () => {
    const { viaStorage, viaKernel, kernel } = await twin();
    const properties = { '--bg-primary': '#101010', '--text-primary': '#fafafa' };
    const saved = await viaStorage.storage.saveCustomTheme({ name: 'Dusk', properties });
    assertCommitted(
      await kernel.execute({ type: 'saveTheme', commandId: 'c1', themeId: saved.id, name: 'Dusk', properties }),
    );
    const themes = async (/** @type {PageContext} */ context) =>
      legacyEnv.plain(await context.storage.getCustomThemes()).map((/** @type {any} */ theme) => ({
        ...theme,
        updatedAt: theme.updatedAt > SEEDED_AT ? 'written' : theme.updatedAt,
      }));
    assert.deepEqual(await themes(viaKernel), await themes(viaStorage));
  });

  it('getWorkspaceData reads what Storage.readSetting reads under each 1.4.x key, and leaves out what has none', async () => {
    const { viaKernel, kernel } = await twin();
    const storage = viaKernel.storage;
    // What 1.4.x's AI chat, onboarding, Settings, and the export notice wrote
    await storage.setSetting('aiChatHistory', [{ role: 'user', content: 'Plan the week' }]);
    await storage.setSetting('globalChatMessages', []);
    await storage.setSetting('aiPromptTemplates', [{ id: 't1', label: 'Sum', prompt: 'Summarize', scope: 'note' }]);
    await storage.setSetting('hasCompletedOnboarding', true);
    await storage.setSetting('lastBackupAt', SEEDED_AT);
    await storage.setSetting('preMigrationNotice', { version: 1, outcome: 'dismissed', at: SEEDED_AT });
    const keys = /** @type {const} */ ([
      'aiChatHistory',
      'noteChatMessages',
      'globalChatHistory',
      'globalChatMessages',
      'aiPromptTemplates',
      'hasCompletedOnboarding',
      'lastFullExportAt',
      'lastBackupAt',
      'preMigrationNotice',
    ]);
    /** @type {Record<string, unknown>} */
    const read = {};
    for (const key of keys) {
      const value = await storage.readSetting(key);
      if (value !== undefined) read[key] = value;
    }
    assert.deepEqual(Object.keys(read), [
      'aiChatHistory',
      'globalChatMessages',
      'aiPromptTemplates',
      'hasCompletedOnboarding',
      'lastBackupAt',
      'preMigrationNotice',
    ]);
    const state = await kernel.query({ type: 'getWorkspaceData', keys: [...keys] });
    assert.deepEqual(state.kind === 'ready' && legacyEnv.plain(state.data), legacyEnv.plain(read));
  });

  it('listThemes lists what Storage.getCustomThemes lists, in its order', async () => {
    const { viaKernel, kernel } = await twin({
      themes: [
        { id: 'old', name: 'Old', properties: {}, updatedAt: SEEDED_AT },
        // The updatedAt index leaves out a theme with no time, so Storage never listed it
        { id: 'untimed', name: 'No time', properties: {} },
      ],
    });
    // The Theme Builder's saves, by 1.4.1's Storage on the kernel's profile, since js/storage.js's
    // copy of saveCustomTheme went with #17 PR 4a
    const { storage } = viaKernel;
    await storage.saveCustomTheme({ name: 'Dusk', properties: { '--bg-primary': '#101010' } });
    await new Promise(resolve => setTimeout(resolve, 2));
    await storage.saveCustomTheme({ name: 'Dawn', properties: { '--bg-primary': '#fafafa' } });
    const listed = legacyEnv.plain(await storage.getCustomThemes());
    assert.deepEqual(
      listed.map((/** @type {{name: string}} */ theme) => theme.name),
      ['Dawn', 'Dusk', 'Old'],
    );
    const state = await kernel.query({ type: 'listThemes' });
    assert.deepEqual(state.kind === 'ready' && legacyEnv.plain(state.data), listed);
  });

  it('exportBackup makes the file Storage.exportAllAsBlob makes for Export JSON and for Create Backup', async () => {
    const { viaKernel, kernel } = await twin({
      canvases: [
        legacyEnv.note('n1', { name: 'Plan', folderId: 'f1' }),
        legacyEnv.note('a1', { name: 'Kept', archived: true }),
        legacyEnv.note('t1', { name: 'Weekly', isTemplate: true }),
        legacyEnv.note('x1', { name: 'Gone', trashed: true, trashedAt: SEEDED_AT }),
      ],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Line'), legacyEnv.block('bx', 'x1', 0, 'Trashed line')],
      folders: [folder('f1', null)],
    });
    const storage = viaKernel.storage;
    /**
     * The file's fields in order, with the times it was made at taken out
     * @param {Blob} file
     */
    const fileOf = async file => {
      const parsed = JSON.parse(await file.text());
      delete parsed.exportedAt;
      if (parsed.backupCreatedAt) parsed.backupCreatedAt = 'made';
      return { keys: Object.keys(parsed), parsed };
    };
    const exported = await kernel.query({ type: 'exportBackup', backup: false });
    assert.equal(exported.kind, 'ready', JSON.stringify(exported));
    assert.deepEqual(
      await fileOf(/** @type {Blob} */ (exported.kind === 'ready' && exported.data)),
      await fileOf(await storage.exportAllAsBlob()),
    );
    // SettingsController.createBackup's fields, in its order
    const backup = await kernel.query({ type: 'exportBackup', backup: true });
    const expected = await storage.exportAllAsBlob({
      backupType: 'full-backup',
      backupCreatedAt: new Date().toISOString(),
      backupVersion: 1,
    });
    assert.deepEqual(
      await fileOf(/** @type {Blob} */ (backup.kind === 'ready' && backup.data)),
      await fileOf(expected),
    );
  });

  it("profileHoldsContent decides what the export notice decided with Storage's isNoteUntitled and isNoteEmpty", async () => {
    for (const records of /** @type {Array<Record<string, unknown[]>>} */ ([
      {},
      {
        canvases: [legacyEnv.note('u1', { name: 'Untitled' })],
        elements: [legacyEnv.block('b1', 'u1', 0, '<br>&nbsp;')],
      },
      { canvases: [legacyEnv.note('u1', { name: 'Untitled 3' })], elements: [legacyEnv.block('b1', 'u1', 0, 'Words')] },
      { canvases: [legacyEnv.note('x1', { name: 'Plan', trashed: true, trashedAt: SEEDED_AT })] },
      { canvases: [legacyEnv.note('a1', { name: 'Kept', archived: true })] },
      { canvases: [legacyEnv.note('t1', { name: 'Weekly', isTemplate: true })] },
    ])) {
      const { viaKernel, kernel } = await twin(records);
      const storage = viaKernel.storage;
      // ExportNotice._holdsSomething as 1.4.1 ran it: every note outside trash, templates last
      let expected = false;
      for (const note of [...(await storage.getAllNotes(true)), ...(await storage.getTemplates())]) {
        if (!storage.isNoteUntitled(note) || !(await storage.isNoteEmpty(note.id))) {
          expected = true;
          break;
        }
      }
      const state = await kernel.query({ type: 'profileHoldsContent' });
      assert.equal(state.kind === 'ready' && state.data, expected, JSON.stringify(records));
    }
  });

  it('createAutoBackup keeps the newest three backups and the time, under the keys Storage.createAutoBackup uses', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [legacyEnv.note('n1', { name: 'Plan' })],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Line')],
    });
    for (let run = 0; run < 4; run += 1) {
      await viaStorage.storage.createAutoBackup();
      assertCommitted(await kernel.execute({ type: 'createAutoBackup', commandId: `a${run}` }));
      // Each backup is keyed by its time, so the next one gets a key of its own
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    /** @param {PageContext} context */
    const backups = async context => {
      const stored = await localOf(context);
      const keys = Object.keys(stored).filter(key => key.startsWith('auto_backup_'));
      return {
        count: keys.length,
        lastBackupAt: stored.setting_lastBackupAt,
        notes: keys.map(key => stored[key].canvases.map((/** @type {any} */ note) => note.id)),
      };
    };
    assert.deepEqual(await backups(viaKernel), await backups(viaStorage));
    assert.equal((await backups(viaKernel)).count, 3);
  });

  it('importBackup leaves the records Storage.importData leaves, Replace all and its recovery copy included', async () => {
    const records = {
      canvases: [legacyEnv.note('L1', { name: 'Local' })],
      elements: [legacyEnv.block('l1', 'L1', 0, 'local line')],
    };
    const backup = {
      version: 1,
      exportedAt: 1,
      canvases: [legacyEnv.note('P1', { name: 'From the file', folderId: 'PF' })],
      elements: [legacyEnv.block('p1', 'P1', 0, 'file line')],
      folders: [{ id: 'PF', name: 'Filed', parentId: null, createdAt: 1, updatedAt: 1, color: null, collapsed: false }],
    };
    const { viaStorage, viaKernel, kernel } = await twin(records);
    const result = legacyEnv.plain(await viaStorage.storage.importData(structuredClone(backup), 'replace'));
    const outcome = /** @type {import('../../js/kernel/core/contracts/outcomes.js').Committed} */ (
      await kernel.execute({ type: 'importBackup', commandId: 'c1', mode: 'replace', backup: structuredClone(backup) })
    );
    assertCommitted(outcome);
    // The note it added, then the folder it added, then the note it trashed, as Storage's result
    // names them. 1.4.1's names no folders it added, and every folder in the file is new here.
    assert.equal(outcome.changedIds.length, 3);
    const addedFolderIds = backup.folders.map(added => added.id);
    assert.deepEqual(outcome.changedIds.slice(1), [...addedFolderIds, ...result.trashedIds]);

    /** Each context's records, with the import's new ids as the order they were made in */
    const shaped = async (/** @type {PageContext} */ context, /** @type {string} */ importedId) => {
      const {
        canvases: notes,
        elements: blocks,
        folders,
      } = await recordsIn(context, ['canvases', 'elements', 'folders']);
      const rename = (/** @type {any} */ value) => JSON.parse(JSON.stringify(value).replaceAll(importedId, 'IMPORTED'));
      return rename({
        notes,
        blocks: Object.values(blocks).map((/** @type {any} */ b) => ({ ...b, id: 'block' })),
        folders,
      });
    };
    assert.deepEqual(await shaped(viaKernel, outcome.changedIds[0]), await shaped(viaStorage, result.importedIds[0]));
    const copies = async (/** @type {PageContext} */ context) =>
      Object.keys(await localOf(context)).filter(key => key.startsWith('recovery_backup_')).length;
    assert.deepEqual([await copies(viaKernel), await copies(viaStorage)], [1, 1]);
  });

  // ============ Version history and AI chat inserts (#12 slice 4b2b) ============

  /**
   * A profile's snapshots by key, with each written time read as 'written'
   * @param {PageContext} context
   */
  const snapshotsIn = async context => {
    const { snapshots } = await recordsIn(context, ['snapshots']);
    return Object.fromEntries(
      Object.entries(snapshots).map(([key, snapshot]) => [
        key,
        { ...snapshot, timestamp: snapshot.timestamp > SEEDED_AT ? 'written' : snapshot.timestamp },
      ]),
    );
  };

  /**
   * `count` snapshots of `noteId`, oldest last, as 1.4.x's interval left them
   * @param {string} noteId
   * @param {number} count
   */
  const oldSnapshots = (noteId, count) =>
    Array.from({ length: count }, (_, index) => ({
      id: `old-${String(index).padStart(2, '0')}`,
      noteId,
      timestamp: SEEDED_AT - 1000 * (index + 1),
      blocks: [{ id: `b${index}`, type: 'text', content: `${index}` }],
      title: `Then ${index}`,
    }));

  it('saveSnapshot stores the record Storage.saveSnapshot stores, and keeps the 50 Storage.pruneSnapshots keeps', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [legacyEnv.note('n1', { name: 'Plan' }), legacyEnv.note('n2')],
      snapshots: [...oldSnapshots('n1', 50), ...oldSnapshots('n2', 1).map(s => ({ ...s, id: 'other', noteId: 'n2' }))],
    });
    const blocks = [legacyEnv.block('a', 'n1', 0, 'Milk'), legacyEnv.block('b', 'n1', 1, 'Eggs')].map(
      ({ canvasId, order, ...serialized }) => serialized,
    );
    const made = legacyEnv.plain(await viaStorage.storage.saveSnapshot('n1', blocks, 'Plan'));
    assertCommitted(
      await kernel.execute({
        type: 'saveSnapshot',
        commandId: 'c1',
        noteId: 'n1',
        snapshotId: made.id,
        blocks,
        title: 'Plan',
      }),
    );
    const kept = await snapshotsIn(viaKernel);
    assert.deepEqual(kept, await snapshotsIn(viaStorage));
    assert.equal(Object.values(kept).filter(snapshot => snapshot.noteId === 'n1').length, 50);
    assert.equal(kept['old-49'], undefined, 'the oldest goes');
    assert.deepEqual(Object.keys(kept[made.id]).sort(), ['blocks', 'id', 'noteId', 'timestamp', 'title']);
  });

  it("restoreSnapshot leaves what 1.4.x's revert left: the snapshot first, the blocks, and the name", async () => {
    const records = {
      canvases: [legacyEnv.note('n1', { name: 'Now', pinned: true, folderId: 'f1', titleManuallySet: true })],
      elements: [legacyEnv.block('a', 'n1', 0, 'Oat milk'), legacyEnv.block('b', 'n1', 1, 'Eggs')],
      snapshots: [
        {
          id: 'then',
          noteId: 'n1',
          timestamp: SEEDED_AT - 1,
          blocks: [legacyEnv.block('a', 'n1', 0, 'Milk')].map(({ canvasId, order, ...serialized }) => serialized),
          title: 'Then',
        },
      ],
    };
    const { viaStorage, viaKernel, kernel } = await twin(records);
    const { storage } = viaStorage;
    // 1.4.x's _revertToSnapshot, with the editor's blocks as its last save stored them
    const snap = legacyEnv.plain((await storage.getSnapshots('n1'))[0]);
    const current = legacyEnv
      .plain(await storage.getElementsByNote('n1'))
      .map((/** @type {any} */ { canvasId, order, ...serialized }) => serialized);
    const pre = legacyEnv.plain(await storage.saveSnapshot('n1', current, 'Now'));
    await storage.deleteElements(['a', 'b']);
    for (let i = 0; i < snap.blocks.length; i++)
      await storage.saveElement({ ...snap.blocks[i], canvasId: 'n1', order: i });
    const stored = legacyEnv.plain(await storage.getNote('n1'));
    await storage.updateNote({ ...stored, name: snap.title });

    assertCommitted(
      await kernel.execute({
        type: 'restoreSnapshot',
        commandId: 'c1',
        noteId: 'n1',
        snapshotId: 'then',
        preSnapshotId: pre.id,
        blocks: snap.blocks,
        name: snap.title,
      }),
    );
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
    assert.deepEqual(await snapshotsIn(viaKernel), await snapshotsIn(viaStorage));
    assert.deepEqual(await searchNames(viaKernel), await searchNames(viaStorage));
  });

  it("insertBlocks leaves what AI chat's insert at the cursor left, preview, todo progress, and links included", async () => {
    const records = {
      canvases: [legacyEnv.note('n1', { name: 'Plan' }), legacyEnv.note('w', { name: 'Work' })],
      elements: [
        legacyEnv.block('a', 'n1', 0, 'Milk'),
        legacyEnv.block('b', 'n1', 1, 'Eggs'),
        legacyEnv.block('c', 'n1', 2, 'Bread'),
      ],
    };
    const { viaStorage, viaKernel, kernel } = await twin(records);
    viaStorage.env.load('js/sidebar-utils.js');
    const { storage } = viaStorage;
    const SidebarUtils = viaStorage.env.get('SidebarUtils');
    const Utils = viaStorage.env.get('Utils');
    const reply = [
      { id: 'ai-1', type: 'text', content: 'See [[work]]' },
      { id: 'ai-2', type: 'todo', content: 'Call the bakery', checked: true },
    ];
    // 1.4.x's appendAIResponseToNote with the cursor on the first block, then
    // refreshNoteMetadataAfterInsert
    const startOrder = 1;
    for (const element of legacyEnv.plain(await storage.getElementsByNote('n1'))) {
      if ((element.order || 0) >= startOrder)
        await storage.saveElement({ ...element, order: element.order + reply.length });
    }
    const now = Date.now();
    await storage.saveElements(
      reply.map((block, index) => ({
        ...block,
        canvasId: 'n1',
        order: startOrder + index,
        createdAt: now,
        updatedAt: now,
      })),
    );
    const note = legacyEnv.plain(await storage.getNote('n1'));
    const blocks = legacyEnv
      .plain(await storage.getElementsByNote('n1'))
      .sort((/** @type {any} */ left, /** @type {any} */ right) => (left.order || 0) - (right.order || 0));
    Object.assign(note, SidebarUtils.buildNoteSaveMetadata(blocks));
    await storage.updateNote(note);
    const text = blocks
      .map((/** @type {any} */ block) => block.content || block.title || block.caption || '')
      .filter(Boolean)
      .join('\n');
    await storage.updateNoteLinks('n1', Utils.extractWikiLinks(text));

    assertCommitted(
      await kernel.execute({ type: 'insertBlocks', commandId: 'c1', noteId: 'n1', blocks: reply, atOrder: 1 }),
    );
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
    /** @param {PageContext} context */
    const links = async context =>
      Object.values((await recordsIn(context, ['links'])).links).map(({ id, ...link }) => link);
    assert.deepEqual(await links(viaKernel), await links(viaStorage));
    assert.equal((await links(viaKernel)).length, 1);
  });

  it('decides untitled and empty the way Storage.isNoteUntitled and Storage.isNoteEmpty do', async () => {
    const page = releaseContext();
    opened.push(page);
    /** @type {Array<Record<string, unknown>[]>} */
    const blockSets = [
      [],
      [{ content: '<p> </p>' }],
      [{ content: '<p>x</p>' }],
      [{ imageUrl: 'data:,' }],
      [{ tableData: [['Header 1', ' ']] }],
      [{ tableData: [['Header 1'], ['cell']] }],
      [{ url: 'https://example.test', title: 'Example' }],
      [{ url: 'https://example.test' }],
      [{ children: '<p>child</p>' }],
      [{ equation: ' ' }],
      [{ equation: 'x' }],
      // Only text blocks of spaces, line breaks, and non-breaking spaces are empty
      [{ content: ' <br>&nbsp;<BR/>\n&NBSP;<br />' }, { content: null }],
      [{ type: undefined, content: ' ' }],
      [{ content: '<b></b>' }],
      [{ content: '<img src="data:,">' }],
      [{ content: 5 }],
      [{ type: 'divider' }],
      [{ type: 'image', imageUrl: 'data:,' }],
      [{ type: 'table', tableData: [['Header 1', ' ']] }],
      [{ type: 'bookmark', url: 'https://example.test', title: 'Example' }],
      [{ content: '' }, { type: 'divider' }],
    ];
    await legacyEnv.createDatabase(page.env.indexedDB, {
      records: {
        elements: blockSets.flatMap((blocks, set) =>
          blocks.map((fields, index) =>
            legacyEnv.block(`b${set}-${index}`, `set${set}`, index, '', { content: '', ...fields }),
          ),
        ),
      },
    });
    await page.storage.open();
    for (const [set, blocks] of blockSets.entries()) {
      const stored = legacyEnv.plain(await page.storage.getElementsByNote(`set${set}`));
      assert.equal(isEmpty(stored), await page.storage.isNoteEmpty(`set${set}`), JSON.stringify(blocks));
    }
    for (const name of ['', '  ', 'Untitled', 'untitled 4', 'Untitled draft', 'Plan', undefined]) {
      const note = { id: 'n', name };
      assert.equal(isUntitled(note), Boolean(page.storage.isNoteUntitled(note)), JSON.stringify(name));
    }
  });

  it("the kernel's preview, todo progress, and wiki-link names are SidebarUtils' and Utils'", async () => {
    const page = legacyContext();
    opened.push(page);
    page.env.load('js/sidebar-utils.js');
    const SidebarUtils = page.env.get('SidebarUtils');
    const Utils = page.env.get('Utils');
    const { noteSaveMetadata, wikiLinkNames } = await import('../../js/kernel/core/domain/note.js');
    const long = `${'word '.repeat(40)}end`;
    /** @type {Array<Array<Record<string, unknown>>>} */
    const cases = [
      [],
      [
        { type: 'text', content: '' },
        { type: 'text', content: '<p>Hello&nbsp;<b>there</b><br>friend</p>' },
      ],
      [{ type: 'toggle', content: '<i>Open</i>', children: 'inside' }],
      [{ type: 'bookmark', title: 'A page', description: 'About it', url: 'https://example.test/' }],
      [{ type: 'equation', equation: 'E = mc^2' }],
      [
        {
          type: 'table',
          tableData: [
            ['<b>a</b>', ''],
            ['c', 'd'],
          ],
        },
      ],
      [
        { type: 'file', fileName: 'notes.pdf' },
        { type: 'video', videoUrl: 'https://example.test/v' },
      ],
      [
        { type: 'todo', content: 'one', checked: true },
        { type: 'todo', content: 'two' },
        { type: 'todo', checked: true },
      ],
      [{ type: 'text', content: long }],
      [{ type: 'divider' }, { type: 'image', imageUrl: 'data:' }],
    ];
    for (const blocks of cases) {
      const records = blocks.map((block, index) => ({ id: `b${index}`, canvasId: 'n1', ...block }));
      assert.deepEqual(noteSaveMetadata(records), legacyEnv.plain(SidebarUtils.buildNoteSaveMetadata(records)));
    }
    for (const text of ['', 'none', '[[A]] and [[ B ]] and [[A]]', '[[]] [[x]y]] [[Nested [[Inner]]]]', '[[a\nb]]']) {
      assert.deepEqual(wikiLinkNames(text), legacyEnv.plain(Utils.extractWikiLinks(text)), text);
    }
  });
});
