// #82's review round 2 (#20 slice 3): each delta probe as a test that failed on db16073.
// 1. A salvage file that holds no records while any source is unreadable fails
//    `nothing-readable`, in the answer, the run record, and the journal; one where every
//    source read and there was nothing to save is still `verified`.
// 2. The store allowlist reaches inside legacy copies.
// 3. `unreadable` stays inside the answer's schema however many there are, with a count.
// 4. The suggested name carries the time, and a failure after the pick says the chosen file
//    may be empty.
// 5. A resend of a finished run answers its `unreadable` as it finished.
// 6. rebuild-index rechecks each note at apply.
// 7. Credential names the first round missed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { result as runResult } from '../../js/trust/core/operations/recovery-run.js';
import { REMEDIATIONS } from '../../js/trust/core/remediation/catalog.js';
import { buildRestorePointFile, buildSalvage, isSecretField } from '../../js/trust/core/remediation/salvage-file.js';
import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { legacyEnv, profileWith, run, synthesized } from './migration-support.mjs';
import { memoryFiles, remediationCenter, runOf } from './trust-remediation-support.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/trust/core/remediation/salvage-file.js').SalvageRead} SalvageRead */

const FIXTURES = synthesized();

/** @param {unknown} answer @returns {any} */
const asRun = answer => {
  assert.ok(v.is(runResult, answer), `outside recovery.run's result schema: ${JSON.stringify(answer).slice(0, 300)}`);
  assert.equal(/** @type {any} */ (answer).kind, 'remediation', JSON.stringify(answer).slice(0, 300));
  return answer;
};

/** @param {SalvageRead} read */
const salvageOf = read => ({
  collect: async () => read,
  restorePoint: async () => null,
  has: async () => false,
});

/** @type {Record<string, SalvageRead>} */
const READS = {
  // The case salvage is for: the database won't open, and nothing else holds anything
  dbFailedRestEmpty: {
    database: { status: 'failed', errorCode: 'open-failed', stores: [] },
    legacyCopies: { status: 'read', copies: [] },
    recoveryPoints: { status: 'missing', points: [] },
  },
  noDbAtAll: {
    database: { status: 'missing', stores: [] },
    legacyCopies: { status: 'read', copies: [] },
    recoveryPoints: { status: 'missing', points: [] },
  },
  everythingReadNothingThere: {
    database: {
      status: 'open',
      stores: [
        { store: 'canvases', values: [] },
        { store: 'elements', values: [] },
      ],
    },
    legacyCopies: { status: 'read', copies: [] },
    recoveryPoints: { status: 'missing', points: [] },
  },
  pointsFailed: {
    database: { status: 'open', stores: [{ store: 'canvases', values: [{ id: 'n1' }] }] },
    legacyCopies: { status: 'read', copies: [] },
    recoveryPoints: { status: 'failed', errorCode: 'open-failed', points: [] },
  },
};

/**
 * A salvage run over `read`: its answer, its stored run, its journal event, and the file
 * @param {SalvageRead} read
 */
async function salvage(read) {
  const files = memoryFiles();
  const { pipeline, records, journal } = await remediationCenter({
    contributions: /** @type {any} */ (REMEDIATIONS),
    ports: { files, salvage: salvageOf(read) },
  });
  const answer = asRun(await pipeline.run(runOf('save-salvage-file')));
  await journal.flush();
  const run = (await records.runs()).find(item => item.id === answer.runId);
  const event = (await records.events()).filter(item => item.code === 'remediation.finished').pop();
  return { answer, run, event, file: files.last(), files, pipeline };
}

describe('#82 round 2, 1: an empty file with an unreadable source never succeeds', () => {
  for (const name of ['dbFailedRestEmpty', 'noDbAtAll']) {
    it(`${name}: failed nothing-readable, in the answer, the record, and the journal`, async () => {
      const { answer, run, event, file } = await salvage(READS[name]);
      assert.deepEqual([answer.state, answer.outcome, answer.severity], ['failed', 'nothing-readable', 'error']);
      assert.deepEqual([run?.state, run?.outcome], ['failed', 'nothing-readable']);
      assert.equal(event?.fields.outcome, 'nothing-readable');
      // The file was written, and says why it holds nothing
      assert.equal(file.unreadable[0].origin, 'CanvasTabDB');
      assert.equal(answer.fileMayBeEmpty, true);
    });
  }

  it('everything read and nothing there: verified', async () => {
    const { answer } = await salvage(READS.everythingReadNothingThere);
    assert.deepEqual([answer.state, answer.outcome, answer.severity], ['succeeded', 'verified', 'success']);
    assert.equal(answer.fileMayBeEmpty, false);
  });

  it('some records saved and a source unreadable: saved-partial', async () => {
    const { answer } = await salvage(READS.pointsFailed);
    assert.deepEqual([answer.state, answer.outcome, answer.severity], ['succeeded', 'saved-partial', 'warning']);
  });
});

describe('#82 round 2, 2: the store allowlist reaches inside legacy copies', () => {
  const copy = {
    recoveryBackup: true,
    reason: 'missing-stores',
    timestamp: 1793413294676,
    missingStores: ['links'],
    canvases: [{ id: 'c', name: 'Kept' }],
    elements: [],
    themes: [{ id: 't', name: 'Dusk' }],
    vault: [{ id: 'v1', blob: 'canary-vault-in-copy' }],
    data: { settings: [{ key: 'llmApiKey', value: 'canary-copy-nested-settings' }] },
  };

  it("the salvage file keeps a copy's known stores and fields, and lists the rest", () => {
    const file = buildSalvage(
      {
        database: { status: 'open', stores: [] },
        legacyCopies: { status: 'read', copies: [{ key: 'recovery_backup_1793413294676', value: copy }] },
        recoveryPoints: { status: 'missing', points: [] },
      },
      { now: NOW },
    );
    const text = JSON.stringify(file);
    assert.equal(text.includes('canary-vault-in-copy'), false);
    assert.equal(text.includes('canary-copy-nested-settings'), false);
    const kept = file.legacyCopies.recovery_backup_1793413294676;
    assert.deepEqual(Object.keys(kept).sort(), [
      'canvases',
      'elements',
      'missingStores',
      'reason',
      'recoveryBackup',
      'themes',
      'timestamp',
    ]);
    const at = file.omissions.map((/** @type {any} */ o) => `${o.at}:${o.reason}`);
    assert.ok(at.includes('legacyCopies.recovery_backup_1793413294676.vault:unknown-store'), at.join(', '));
    assert.ok(at.includes('legacyCopies.recovery_backup_1793413294676.data:unknown-field'), at.join(', '));
  });

  it('Save as file of the same copy too', () => {
    const file = buildRestorePointFile(
      { kind: 'legacy-copy', key: 'recovery_backup_1793413294676', value: copy },
      { now: NOW },
    );
    const text = JSON.stringify(file);
    assert.equal(text.includes('canary-vault-in-copy'), false);
    assert.equal(text.includes('canary-copy-nested-settings'), false);
    assert.deepEqual(file.stores, { themes: [{ id: 't', name: 'Dusk' }] });
    const at = file.omissions.map((/** @type {any} */ o) => `${o.at}:${o.reason}`);
    assert.ok(at.includes('recovery_backup_1793413294676.vault:unknown-store'), at.join(', '));
  });
});

describe('#82 round 2, 3: unreadable stays inside the schema however many there are', () => {
  it('70 unreadable stores: 64 in the answer, and the count of all of them', async () => {
    const stores = [
      'canvases',
      'elements',
      'media',
      'folders',
      'search_index',
      'links',
      'themes',
      'vectors',
      'snapshots',
      'meta',
    ];
    const points = Array.from({ length: 7 }, (_, p) => ({
      id: `pre-repair-17934132940${p}0`,
      kind: 'pre-repair',
      status: 'verified',
      verified: true,
      createdAt: 1,
      verifiedAt: 2,
      stores: stores.map(store => ({ store, values: [], errorCode: 'unreadable' })),
    }));
    const { answer, file, run } = await salvage({
      database: { status: 'open', stores: [{ store: 'canvases', values: [{ id: 'n' }] }] },
      legacyCopies: { status: 'read', copies: [] },
      recoveryPoints: { status: 'read', points },
    });
    assert.equal(answer.outcome, 'saved-partial');
    assert.equal(answer.unreadable.length, 64);
    assert.equal(answer.unreadableCount, 70);
    assert.equal(file.unreadable.length, 70, 'the file names every one');
    assert.equal(run?.unreadableCount, 70);
  });
});

describe('#82 round 2, 4: the picked file is named for the time, and a failure after the pick says so', () => {
  it('suggests a name with the time, so a second save the same day never offers to replace the first', async () => {
    const { files } = await salvage(READS.everythingReadNothingThere);
    assert.match(String(files.lastName), /^newtabnote-salvage-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.json$/);
  });

  it('a build that fails after the pick answers that the chosen file may be empty', async () => {
    const files = memoryFiles();
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: {
        files,
        salvage: {
          collect: async () => {
            throw new Error('boom');
          },
          restorePoint: async () => null,
          has: async () => false,
        },
      },
    });
    const answer = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.deepEqual([answer.state, answer.outcome], ['failed', 'build-failed']);
    assert.equal(files.picks, 1);
    assert.equal(answer.fileMayBeEmpty, true);
  });

  it('a cancel or a missing picker touched no file', async () => {
    const files = memoryFiles();
    files.cancel = true;
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { files, salvage: salvageOf(READS.pointsFailed) },
    });
    const cancelled = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(cancelled.fileMayBeEmpty, false);
  });
});

describe('#82 round 2, 5: a resend of a finished run answers as it finished', () => {
  it('keeps unreadable in the stored run', async () => {
    const { answer, pipeline } = await salvage(READS.pointsFailed);
    assert.equal(answer.unreadable.length, 1);
    // Confirming a finished run (as a resend after a reload would) reads the stored run back
    const again = asRun(
      await pipeline.run(
        runOf('save-salvage-file', { runId: answer.runId, decision: 'confirm', previewDigest: answer.previewDigest }),
      ),
    );
    assert.equal(again.outcome, 'saved-partial');
    assert.deepEqual(again.unreadable, answer.unreadable);
  });
});

describe('#82 round 2, 6: rebuild-index rechecks each note at apply', () => {
  it('writes no entry for a note trashed between the preview and the apply', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.orphans')));
    // #17 PR 1b: only the migration runner upgrades a database, after its point, so it's at this
    // build's version before #17's adapter opens it versioned
    assert.equal((await run(of)).status, 'migrated');
    const adapter = createIndexedDbAdapter({ indexedDB: of.real, settings: of.chrome.api.storage.local });
    await adapter.open();
    const notes = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'canvases');
    const groceries = /** @type {any} */ (Object.values(notes).find((/** @type {any} */ n) => n.name === 'Groceries'));
    const before = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'search_index')[groceries.id];
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { adapter },
      hooks: {
        between: async step => {
          if (step !== 'apply') return;
          await adapter.commit({
            commandId: 'trash-it',
            command: /** @type {any} */ ({ type: 'trashNote', commandId: 'trash-it' }),
            effect: {
              kind: 'units',
              units: [
                {
                  stores: ['notes'],
                  async run(tx) {
                    const note = await tx.get('notes', groceries.id);
                    tx.put('notes', { .../** @type {any} */ (note), trashed: true, trashedAt: 9 });
                  },
                },
              ],
            },
            done: () =>
              /** @type {any} */ ({
                kind: 'committed',
                code: 'note-trashed',
                changedIds: [],
                messageKey: 'committed.note-trashed',
                severity: 'success',
              }),
          });
        },
      },
    });
    const first = asRun(await pipeline.run(runOf('rebuild-index')));
    const done = asRun(
      await pipeline.run(
        runOf('rebuild-index', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    const after = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'search_index')[groceries.id];
    assert.deepEqual(after, before);
  });
});

describe('#82 round 2, 7: credential names', () => {
  it('matches the names the first round missed', () => {
    for (const name of [
      'openaiKey',
      'authToken',
      'webdavPass',
      'pwd',
      'syncToken',
      'sessionToken',
      'accessKey',
      'bearer',
    ]) {
      assert.equal(isSecretField(name), true, name);
    }
    for (const name of ['name', 'content', 'tokens', 'maxTokens', 'keyword', 'compass', 'passage']) {
      assert.equal(isSecretField(name), false, name);
    }
  });
});
