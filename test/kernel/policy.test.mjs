// The baseline policy allows exactly what each surface could do before the kernel, reading
// each catalog entry's surfaces, and rejects everything else. A page builds it on the shared
// catalog, and the service worker on its own part composed with it (contracts/worker-catalog.js),
// so each case runs on both.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { QUERIES, QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { SYSTEM_QUERIES } from '../../js/kernel/core/contracts/system.js';
import {
  WORKER_CATALOG,
  WORKER_COMMANDS,
  WORKER_COMMAND_TYPES,
  WORKER_QUERIES,
  WORKER_QUERY_TYPES,
} from '../../js/kernel/core/contracts/worker-catalog.js';
import { SURFACES, createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS } from './support.mjs';

/** @typedef {import('../../js/kernel/core/ports/policy.js').Surface} Surface */
/** @typedef {import('../../js/kernel/core/ports/policy.js').PolicyPort} PolicyPort */

/** The reads of notes, folders, and settings the new tab, Popup, and Side Panel all make */
const READS = ['listNotes', 'getNote', 'getNoteBlocks', 'listFolders', 'getPreferences', 'getWorkspaceSession'];

// Written out by hand, so a change to a catalog entry's surfaces has to change this too
/** @type {Record<Surface, {commands: readonly string[], queries: readonly string[]}>} */
const TODAY = {
  newtab: {
    // Every command of the shared catalog. The capture, the integrity check, the records' catch-up
    // and the journal drain's keep of an entry are the service worker's alone (#35, #33)
    commands: COMMAND_TYPES,
    queries: [
      ...READS,
      'getBacklinks',
      'getNoteList',
      'getNotesByIds',
      'listSearchEntries',
      'listSearchEntryIds',
      'getInsightsPending',
      'getJobRuns',
      'listSnapshots',
      'getSnapshot',
      'findDailyNote',
      'getWorkspaceData',
      'listThemes',
      'exportBackup',
      'profileHoldsContent',
      'listLinks',
      'listVectors',
      'getSyncData',
    ],
  },
  // Since 1.4.3 Popup and Side Panel also apply closing tabs' edits at their start (#33)
  popup: { commands: ['createNote', 'applyCloseDraft'], queries: [...READS, 'getPopupInsightsEnabled'] },
  sidepanel: { commands: ['applyCloseDraft'], queries: READS },
  offscreen: { commands: [], queries: [] },
  // Since #35 slice 3 its drain also replays what a page journaled, a note's creation and an
  // append, keeps an entry it can't replay, and reads which notes were deleted for good first.
  // An editor's save is the pages' to apply, as a close-time draft (slice 3b)
  'worker-internal': {
    commands: [
      'captureToDailyNote',
      'runStartupMaintenance',
      'runIntegrityCheck',
      'catchUpNoteRecords',
      'createNote',
      'insertBlocks',
      'keepJournalEntry',
    ],
    queries: ['findTombstones'],
  },
  // recovery.html reads only its theme through the kernel (#20 slice 4b); its trust rows are
  // its root's (test/kernel/recovery-surface.test.mjs)
  recovery: { commands: [], queries: ['getPreferences'] },
};

/** The page surfaces, whose roots build their policy on the shared catalog */
const PAGES = SURFACES.filter(surface => surface !== 'worker-internal');

/** Every kernel operation of both parts, the worker's own with the shared ones */
const EVERY_TYPE = [...WORKER_COMMAND_TYPES, ...WORKER_QUERY_TYPES];

/** @type {ReadonlyArray<[string, PolicyPort]>} */
const POLICIES = [
  ["the pages' policy, on the shared catalog", createBaselinePolicy()],
  ["the worker's policy, on its part composed with it", createBaselinePolicy(WORKER_CATALOG)],
];

describe('the baseline policy', () => {
  const pages = createBaselinePolicy();
  const worker = createBaselinePolicy(WORKER_CATALOG);

  it("allows each page exactly today's commands and reads, on the shared catalog, which doesn't know the worker's own", () => {
    assert.deepEqual([...SURFACES].sort(), Object.keys(TODAY).sort());
    for (const surface of PAGES) {
      const allowed = TODAY[surface];
      for (const type of EVERY_TYPE) {
        const known = Object.hasOwn(COMMANDS, type) || Object.hasOwn(QUERIES, type);
        const expected = allowed.commands.includes(type) || allowed.queries.includes(type);
        assert.deepEqual(
          pages.authorize({ type }, CALLERS[surface]),
          expected ? { allowed: true } : { allowed: false, code: known ? 'not-on-surface' : 'unknown-operation' },
          `${surface} ${type}`,
        );
      }
    }
  });

  it("allows the service worker exactly today's commands and reads, on its part composed with the shared catalog", () => {
    const allowed = TODAY['worker-internal'];
    for (const type of EVERY_TYPE) {
      const expected = allowed.commands.includes(type) || allowed.queries.includes(type);
      assert.deepEqual(
        worker.authorize({ type }, CALLERS['worker-internal']),
        expected ? { allowed: true } : { allowed: false, code: 'not-on-surface' },
        type,
      );
    }
    // The pages' policy lets it send none of them
    for (const type of EVERY_TYPE) {
      assert.equal(pages.authorize({ type }, CALLERS['worker-internal']).allowed, false, type);
    }
  });

  it("grants a page nothing on the worker's catalog that the shared one doesn't", () => {
    for (const surface of PAGES) {
      for (const type of [...EVERY_TYPE, ...Object.keys(SYSTEM_QUERIES)]) {
        assert.equal(
          worker.authorize({ type }, CALLERS[surface]).allowed,
          pages.authorize({ type }, CALLERS[surface]).allowed,
          `${surface} ${type}`,
        );
      }
    }
  });

  it("reads the surfaces from each catalog entry, so the entry is the only place they're listed", () => {
    for (const [policy, commands, queries] of /** @type {const} */ ([
      [pages, COMMANDS, QUERIES],
      [worker, WORKER_COMMANDS, WORKER_QUERIES],
    ])) {
      for (const [type, entry] of [...Object.entries(commands), ...Object.entries(queries)]) {
        for (const surface of SURFACES) {
          assert.equal(
            policy.authorize({ type }, CALLERS[surface]).allowed,
            entry.surfaces.includes(surface),
            `${surface} ${type}`,
          );
        }
      }
    }
    const shared = WORKER_COMMAND_TYPES.filter(type =>
      /** @type {readonly string[]} */ (WORKER_QUERY_TYPES).includes(type),
    );
    assert.deepEqual(shared, [], 'a command and a query share a name, so the policy could read the wrong entry');
    assert.deepEqual(
      COMMAND_TYPES.filter(type => /** @type {readonly string[]} */ (QUERY_TYPES).includes(type)),
      [],
    );
  });

  for (const [name, policy] of POLICIES) {
    describe(name, () => {
      it("reads the coordinator's own queries from their entries too, and lets the pages ask for its health", () => {
        for (const [type, entry] of Object.entries(SYSTEM_QUERIES)) {
          for (const surface of SURFACES) {
            assert.equal(
              policy.authorize({ type }, CALLERS[surface]).allowed,
              entry.surfaces.includes(surface),
              `${surface} ${type}`,
            );
          }
        }
        for (const type of ['system.messagingHealth', 'system.coordinatorHealth']) {
          const asking = SURFACES.filter(surface => policy.authorize({ type }, CALLERS[surface]).allowed);
          assert.deepEqual(asking, ['newtab', 'popup', 'sidepanel', 'recovery'], type);
        }
      });

      it('rejects a request the catalog lacks, from every surface', () => {
        for (const caller of Object.values(CALLERS)) {
          for (const request of [
            { type: 'dropDatabase' },
            { type: 'toString' },
            { type: '__proto__' },
            {},
            { type: 7 },
          ]) {
            assert.deepEqual(
              policy.authorize(request, caller),
              { allowed: false, code: 'unknown-operation' },
              JSON.stringify(request),
            );
          }
          assert.deepEqual(policy.authorize(/** @type {any} */ (null), caller), {
            allowed: false,
            code: 'unknown-operation',
          });
        }
      });

      it('rejects a caller that is not one of the surfaces', () => {
        for (const caller of [
          undefined,
          null,
          {},
          { surface: 'newtab' },
          { surface: 'newtab', contextId: '' },
          { surface: 'worker', contextId: 'x' },
          { surface: 'options', contextId: 'x' },
        ]) {
          assert.deepEqual(
            policy.authorize({ type: 'createNote' }, /** @type {any} */ (caller)),
            { allowed: false, code: 'unknown-caller' },
            JSON.stringify(caller),
          );
        }
      });
    });
  }
});
