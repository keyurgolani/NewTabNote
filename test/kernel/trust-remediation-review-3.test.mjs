// #82's review round 3 (#20 slice 3): each delta probe as a test that failed on 7d02634.
// 1. A file holds what the user made only through canvases, elements, media, folders, themes,
//    and snapshots, in CanvasTabDB, a legacy copy (by its rows), or a point, so an empty copy or
//    a readable `meta` row never makes an unreadable profile's file a success.
// 2. The irreversible gate refuses a recovery file the save itself would refuse, and one that
//    doesn't hold the subject the action destroys.
// 3. An irreversible run whose recovery file couldn't read everything answers saved-partial.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { result as runResult } from '../../js/trust/core/operations/recovery-run.js';
import { REMEDIATIONS } from '../../js/trust/core/remediation/catalog.js';
import { memoryFiles, remediationCenter, runOf } from './trust-remediation-support.mjs';

/** @typedef {import('../../js/trust/core/remediation/salvage-file.js').SalvageRead} SalvageRead */

/** @param {unknown} answer @returns {any} */
const asRun = answer => {
  assert.ok(v.is(runResult, answer), `outside recovery.run's result schema: ${JSON.stringify(answer).slice(0, 300)}`);
  assert.equal(/** @type {any} */ (answer).kind, 'remediation', JSON.stringify(answer).slice(0, 300));
  return answer;
};

/** @param {SalvageRead} read */
const salvageOf = read => ({ collect: async () => read, restorePoint: async () => null, has: async () => false });

/** @type {SalvageRead['legacyCopies']} */
const noCopies = { status: 'read', copies: [] };
/** @type {SalvageRead['recoveryPoints']} */
const noPoints = { status: 'missing', points: [] };
/** @type {SalvageRead['database']} */
const dbFailed = { status: 'failed', errorCode: 'open-failed', stores: [] };

/** @type {Record<string, SalvageRead>} */
const READS = {
  dbFailedEmptyCopy: {
    database: dbFailed,
    legacyCopies: {
      status: 'read',
      copies: [
        {
          key: 'auto_backup_1793413294678',
          value: { version: 1, autoBackup: true, canvases: [], elements: [], media: [], folders: [] },
        },
      ],
    },
    recoveryPoints: noPoints,
  },
  notesUnreadableMetaRead: {
    database: {
      status: 'open',
      stores: [
        { store: 'canvases', values: [], errorCode: 'unreadable' },
        { store: 'elements', values: [], errorCode: 'unreadable' },
        { store: 'meta', values: [{ key: 'schema', structuralVersion: 9 }] },
        { store: 'search_index', values: [{ noteId: 'n' }] },
      ],
    },
    legacyCopies: noCopies,
    recoveryPoints: noPoints,
  },
  dbFailedCopyWithANote: {
    database: dbFailed,
    legacyCopies: {
      status: 'read',
      copies: [
        {
          key: 'auto_backup_1793413294678',
          value: { version: 1, canvases: [{ id: 'n', name: 'Kept' }], elements: [] },
        },
      ],
    },
    recoveryPoints: noPoints,
  },
  emptyDbCopiesFailed: {
    database: {
      status: 'open',
      stores: [
        { store: 'canvases', values: [] },
        { store: 'elements', values: [] },
      ],
    },
    legacyCopies: { status: 'failed', errorCode: 'settings-read-failed', copies: [] },
    recoveryPoints: noPoints,
  },
  dbReadPointsFailed: {
    database: { status: 'open', stores: [{ store: 'canvases', values: [{ id: 'n1', name: 'One' }] }] },
    legacyCopies: {
      status: 'read',
      copies: [{ key: 'auto_backup_1793413294678', value: { version: 1, canvases: [], elements: [] } }],
    },
    recoveryPoints: { status: 'failed', errorCode: 'open-failed', points: [] },
  },
};

/** @param {SalvageRead} read */
async function salvage(read) {
  const files = memoryFiles();
  const { pipeline } = await remediationCenter({
    contributions: /** @type {any} */ (REMEDIATIONS),
    ports: { files, salvage: salvageOf(read) },
  });
  return { answer: asRun(await pipeline.run(runOf('save-salvage-file'))), file: files.last() };
}

describe('#82 round 3, 1: only what the user made counts as held', () => {
  for (const name of ['dbFailedEmptyCopy', 'notesUnreadableMetaRead']) {
    it(`${name}: failed nothing-readable`, async () => {
      const { answer } = await salvage(READS[name]);
      assert.deepEqual([answer.state, answer.outcome, answer.severity], ['failed', 'nothing-readable', 'error']);
      assert.equal(answer.fileMayBeEmpty, true);
    });
  }

  it('a copy holding a note is a saved record: saved-partial', async () => {
    const { answer } = await salvage(READS.dbFailedCopyWithANote);
    assert.deepEqual([answer.state, answer.outcome], ['succeeded', 'saved-partial']);
  });
});

/**
 * An irreversible test remediation that destroys `subject`
 * @param {{applied: boolean}} state
 * @param {string | null} subject
 */
const destroying = (state, subject) => ({
  id: 'delete-restore-point',
  version: 1,
  apiVersion: 1,
  group: 'repair',
  rank: 10,
  hosts: ['workspace'],
  label: 'delete',
  owner: 20,
  class: 'irreversible',
  appliesTo: ['storage'],
  fixtures: ['remediation-steps'],
  implementation: {
    phrase: 'delete it',
    preview: async () => ({
      preview: { changes: [{ target: 'canvases', creates: 0, updates: 0, deletes: 1 }] },
      plan: null,
    }),
    destroys: () => subject,
    apply: async () => {
      state.applied = true;
    },
    verify: async () => ({ ok: true }),
  },
});

/**
 * An irreversible run over `read`, confirmed
 * @param {SalvageRead} read
 * @param {string | null} [subject]
 */
async function irreversible(read, subject = null) {
  const state = { applied: false };
  const { pipeline } = await remediationCenter({
    contributions: /** @type {any} */ ([destroying(state, subject)]),
    ports: { files: memoryFiles(), salvage: salvageOf(read) },
  });
  const first = asRun(await pipeline.run(runOf('delete-restore-point')));
  const answer = asRun(
    await pipeline.run(
      runOf('delete-restore-point', {
        runId: first.runId,
        decision: 'confirm',
        typedPhrase: 'delete it',
        previewDigest: first.previewDigest,
      }),
    ),
  );
  return { answer, applied: state.applied };
}

describe("#82 round 3, 2: the irreversible gate uses the save's own rule", () => {
  it('refuses a recovery file with no user records while a source is unreadable', async () => {
    const { answer, applied } = await irreversible(READS.emptyDbCopiesFailed);
    assert.deepEqual([answer.state, answer.step, answer.outcome], ['failed', 'protect', 'nothing-readable']);
    assert.equal(applied, false);
  });

  it("refuses a recovery file that doesn't hold what the action destroys, and takes one that does", async () => {
    const missing = await irreversible(READS.dbReadPointsFailed, 'auto_backup_1000000000000');
    assert.deepEqual([missing.answer.state, missing.answer.outcome], ['failed', 'salvage-incomplete']);
    assert.equal(missing.applied, false);
    const held = await irreversible(READS.dbReadPointsFailed, 'auto_backup_1793413294678');
    assert.equal(held.answer.state, 'succeeded');
    assert.equal(held.applied, true);
    const note = await irreversible(READS.dbReadPointsFailed, 'n1');
    assert.equal(note.answer.state, 'succeeded');
  });
});

describe('#82 round 3, 3: an irreversible run with an incomplete recovery file says so', () => {
  it('answers saved-partial, a warning, naming what its file missed', async () => {
    const { answer, applied } = await irreversible(READS.dbReadPointsFailed);
    assert.equal(applied, true);
    assert.deepEqual([answer.state, answer.outcome, answer.severity], ['succeeded', 'saved-partial', 'warning']);
    assert.equal(answer.unreadable[0].origin, 'recoveryPoints');
  });
});
