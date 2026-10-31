// #82's review round (#20 slice 3): each reviewer probe as a test that failed on 59600f5.
// 1. A salvage file that read nothing, or only part, never answers full success, and the
//    irreversible gate takes only a file that read CanvasTabDB.
// 2. reconcile() re-reads a run under its lock, so a run that finished meanwhile stays finished.
// 3. A confirmation names the preview the user saw, by its digest.
// 4. Only a remediation that declares a subject takes one, so a subject can't split the lock.
// 5. The picker opens before anything slow, inside the click's activation.
// 6. No part of a written file holds more than one record.
// 7. Only known stores go in a salvage file, credential names match in any case and spelling,
//    and a key/value row naming a credential is dropped.
// 8. Without Web Locks, nothing runs.
// 9. A regenerable or non-destructive run never changes a user-owned store.
// 11. rebuild-index indexes the app's set of notes, and verifies only the notes it planned.
// And the pipeline resolves no incident: re-verification does (#80's contract).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as v from '../../js/lib/valibot/index.mjs';
import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { createSalvageReader } from '../../js/kernel/adapters/indexeddb/salvage-reader.js';
import { result as runResult } from '../../js/trust/core/operations/recovery-run.js';
import { REMEDIATIONS } from '../../js/trust/core/remediation/catalog.js';
import { buildSalvage } from '../../js/trust/core/remediation/salvage-file.js';
import { serialize } from '../../js/trust/core/remediation/saved-file.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { KeyRange, legacyEnv, profileWith, synthesized } from './migration-support.mjs';
import { memoryFiles, remediationCenter, runLocks, runOf } from './trust-remediation-support.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/trust/core/remediation/salvage-file.js').SalvageRead} SalvageRead */

const crypto = /** @type {any} */ (webcrypto);
const FIXTURES = synthesized();

/** @param {unknown} answer @returns {any} */
const asRun = answer => {
  assert.ok(v.is(runResult, answer), `outside recovery.run's result schema: ${JSON.stringify(answer)}`);
  assert.equal(/** @type {any} */ (answer).kind, 'remediation', JSON.stringify(answer));
  return answer;
};

let rank = 0;

/**
 * A test contribution
 * @param {string} id
 * @param {string} remediationClass
 * @param {Record<string, unknown>} implementation
 */
const contribution = (id, remediationClass, implementation) => ({
  id,
  version: 1,
  apiVersion: 1,
  group: 'repair',
  rank: (rank += 10),
  hosts: ['workspace'],
  label: id,
  owner: 20,
  class: remediationClass,
  appliesTo: ['storage', 'index'],
  fixtures: ['remediation-steps'],
  implementation,
});

/**
 * A salvage port answering `read`, which logs each call
 * @param {SalvageRead} read
 * @param {string[]} [log]
 */
const salvageOf = (read, log = []) => ({
  collect: async () => {
    log.push('collect');
    return read;
  },
  restorePoint: async () => {
    log.push('restorePoint');
    return { kind: /** @type {const} */ ('legacy-copy'), key: 'auto_backup_1793413294673', value: { canvases: [] } };
  },
  has: async () => {
    log.push('has');
    return true;
  },
});

/** A read where every source answers */
const readable = () =>
  /** @type {SalvageRead} */ ({
    database: { status: 'open', stores: [{ store: 'canvases', values: [{ id: 'a', name: 'A' }] }] },
    legacyCopies: { status: 'read', copies: [] },
    recoveryPoints: { status: 'missing', points: [] },
  });

describe('#82 review 1: a salvage file that read nothing never says it saved everything', () => {
  it('none read: failed, nothing-readable, every source named, and the file still says why', async () => {
    const files = memoryFiles();
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: {
        files,
        salvage: salvageOf({
          database: { status: 'failed', errorCode: 'open-failed', stores: [] },
          legacyCopies: { status: 'failed', errorCode: 'settings-read-failed', copies: [] },
          recoveryPoints: { status: 'failed', errorCode: 'open-failed', points: [] },
        }),
      },
    });
    const answer = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'nothing-readable');
    assert.equal(answer.severity, 'error');
    assert.deepEqual(answer.unreadable, [
      { origin: 'CanvasTabDB', part: null, pointId: null, code: 'open-failed' },
      { origin: 'legacyCopies', part: null, pointId: null, code: 'settings-read-failed' },
      { origin: 'recoveryPoints', part: null, pointId: null, code: 'open-failed' },
    ]);
    assert.deepEqual(files.last().unreadable, answer.unreadable);
  });

  it('some read: saved-partial, a warning, and each unreadable store named', async () => {
    const files = memoryFiles();
    const read = readable();
    read.database.stores.push({ store: 'vectors', values: [], errorCode: 'unreadable' });
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { files, salvage: salvageOf(read) },
    });
    const answer = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(answer.state, 'succeeded');
    assert.equal(answer.outcome, 'saved-partial');
    assert.equal(answer.severity, 'warning');
    assert.deepEqual(answer.unreadable, [
      { origin: 'CanvasTabDB', part: 'vectors', pointId: null, code: 'unreadable' },
    ]);
  });

  it('everything read: verified, a success, and nothing unreadable', async () => {
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { files: memoryFiles(), salvage: salvageOf(readable()) },
    });
    const answer = asRun(await pipeline.run(runOf('save-salvage-file')));
    assert.equal(answer.outcome, 'verified');
    assert.equal(answer.severity, 'success');
    assert.deepEqual(answer.unreadable, []);
  });

  it('the irreversible gate takes only a recovery file that read CanvasTabDB', async () => {
    const log = /** @type {string[]} */ ([]);
    const read = readable();
    read.database = { status: 'failed', errorCode: 'open-failed', stores: [] };
    // A copy that holds a note, so the file saved something and only the gate's CanvasTabDB rule refuses it
    read.legacyCopies = {
      status: 'read',
      copies: [{ key: 'auto_backup_1793413294673', value: { version: 1, canvases: [{ id: 'n', name: 'Kept' }] } }],
    };
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ ([
        contribution('delete-restore-point', 'irreversible', {
          phrase: 'delete it',
          preview: async () => ({
            preview: { changes: [{ target: 'canvases', creates: 0, updates: 0, deletes: 1 }] },
            plan: 1,
          }),
          destroys: () => 'auto_backup_1793413294673',
          apply: async () => {
            log.push('mutate');
          },
          verify: async () => ({ ok: true }),
        }),
      ]),
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
    assert.equal(answer.state, 'failed');
    assert.equal(answer.step, 'protect');
    assert.equal(answer.outcome, 'salvage-incomplete');
    assert.deepEqual(log, []);
  });
});

describe('#82 review 2: reconcile() re-reads a run under its lock', () => {
  it('leaves a run that finished between the list and the lock as it finished', async () => {
    const store = createMemoryTrustStore();
    const locks = runLocks();
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const steps = {
      preview: async () => ({
        preview: { changes: [{ target: 'preferences', creates: 0, updates: 1, deletes: 0 }] },
        plan: 1,
      }),
      apply: async () => gate,
      verify: async () => ({ ok: true }),
    };
    const tab = await remediationCenter({
      contributions: /** @type {any} */ ([contribution('reconnect', 'non-destructive', steps)]),
      store,
      locks,
    });
    const running = tab.pipeline.run(runOf('reconnect'));
    await new Promise(resolve => setTimeout(resolve, 5));
    // The next start's locks: by the time it asks for the run's lock, the run has finished
    const late = {
      held: locks.held,
      /** @param {string} name @param {any} options @param {any} callback */
      request: async (name, options, callback) => {
        release();
        await running;
        return locks.request(name, options, callback);
      },
    };
    const next = await remediationCenter({
      contributions: /** @type {any} */ ([contribution('reconnect', 'non-destructive', steps)]),
      store,
      locks: /** @type {any} */ (late),
    });
    assert.equal(await next.pipeline.reconcile(), 0);
    const [run] = await next.records.runs();
    assert.equal(run.state, 'succeeded');
    assert.equal(run.outcome, 'verified');
  });
});

describe('#82 review 3: a confirmation names the preview the user saw', () => {
  it('refuses a confirm without the digest, and one for a preview that changed, however often it is sent', async () => {
    const w = { size: 3, log: /** @type {string[]} */ ([]) };
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ ([
        contribution('remove-index', 'regenerable', {
          preview: async () => ({
            preview: { changes: [{ target: 'search_index', creates: 0, updates: 0, deletes: w.size }] },
            plan: 1,
          }),
          apply: async () => {
            w.log.push(`removed ${w.size}`);
          },
          verify: async () => ({ ok: true }),
        }),
      ]),
    });
    const first = asRun(await pipeline.run(runOf('remove-index')));
    assert.match(first.previewDigest, /^[0-9a-f]{16}$/);
    const without = await pipeline.run(runOf('remove-index', { runId: first.runId, decision: 'confirm' }));
    assert.deepEqual(
      [/** @type {any} */ (without).kind, /** @type {any} */ (without).code],
      ['rejected', 'invalid-payload'],
    );

    w.size = 500;
    const confirm = () =>
      pipeline.run(
        runOf('remove-index', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      );
    const moved = asRun(await confirm());
    assert.equal(moved.outcome, 'preview-changed');
    assert.notEqual(moved.previewDigest, first.previewDigest);
    // Sent again under a new commandId, the user still saw 3, not 500
    assert.equal(asRun(await confirm()).outcome, 'preview-changed');
    assert.deepEqual(w.log, []);
    const done = asRun(
      await pipeline.run(
        runOf('remove-index', { runId: first.runId, decision: 'confirm', previewDigest: moved.previewDigest }),
      ),
    );
    assert.equal(done.state, 'succeeded');
    assert.deepEqual(w.log, ['removed 500']);
  });
});

describe('#82 review 4: a subject keys the lock only where the remediation declares one', () => {
  it('refuses a subject for a remediation without one, so it never runs beside the first run', async () => {
    const log = /** @type {string[]} */ ([]);
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ ([
        contribution('reconnect', 'non-destructive', {
          preview: async () => ({
            preview: { changes: [{ target: 'preferences', creates: 0, updates: 1, deletes: 0 }] },
            plan: 1,
          }),
          apply: async () => {
            log.push('apply');
            await gate;
          },
          verify: async () => ({ ok: true }),
        }),
      ]),
    });
    const first = pipeline.run(runOf('reconnect'));
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await pipeline.run(runOf('reconnect', { subjectId: 'canvases' }));
    assert.deepEqual(
      [/** @type {any} */ (second).kind, /** @type {any} */ (second).code],
      ['rejected', 'subject-not-allowed'],
    );
    release();
    await first;
    assert.deepEqual(log, ['apply']);
  });
});

describe('#82 review 5: the picker opens before anything slow', () => {
  /**
   * Files and salvage ports that log their calls in one order
   * @param {string[]} log
   */
  const logged = log => {
    const files = memoryFiles();
    const pick = files.pick;
    files.pick = async options => {
      log.push('pick');
      return pick(options);
    };
    return files;
  };

  it('Save a salvage file and Save as file pick the file before they read anything', async () => {
    for (const remediationId of ['save-salvage-file', 'save-recovery-file']) {
      const log = /** @type {string[]} */ ([]);
      const { pipeline } = await remediationCenter({
        contributions: /** @type {any} */ (REMEDIATIONS),
        ports: { files: logged(log), salvage: salvageOf(readable(), log) },
      });
      const more = remediationId === 'save-recovery-file' ? { subjectId: 'auto_backup_1793413294673' } : {};
      const answer = asRun(await pipeline.run(runOf(remediationId, more)));
      assert.equal(answer.state, 'succeeded', remediationId);
      const heavy = log.findIndex(entry => entry === 'collect' || entry === 'restorePoint');
      assert.ok(log.indexOf('pick') !== -1 && log.indexOf('pick') < heavy, `${remediationId}: ${log.join(', ')}`);
    }
  });

  it("an irreversible run's recovery file picks first too", async () => {
    const log = /** @type {string[]} */ ([]);
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ ([
        contribution('delete-restore-point', 'irreversible', {
          phrase: 'delete it',
          preview: async () => ({
            preview: { changes: [{ target: 'canvases', creates: 0, updates: 0, deletes: 1 }] },
            plan: 1,
          }),
          destroys: () => 'a',
          apply: async () => {
            log.push('mutate');
          },
          verify: async () => ({ ok: true }),
        }),
      ]),
      ports: { files: logged(log), salvage: salvageOf(readable(), log) },
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
    assert.equal(answer.state, 'succeeded');
    assert.deepEqual(log, ['pick', 'collect', 'mutate']);
  });
});

describe('#82 review 6: no part of a written file holds more than one record', () => {
  it('writes each store row, each legacy copy row, and each point row as its own part', () => {
    const rows = (/** @type {string} */ tag, /** @type {number} */ n) =>
      Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}`, mark: `<${tag}-${i}>` }));
    const file = buildSalvage(
      {
        database: {
          status: 'open',
          stores: [
            { store: 'canvases', values: rows('note', 3) },
            { store: 'vectors', values: rows('vector', 3) },
            { store: 'snapshots', values: rows('snapshot', 3) },
          ],
        },
        legacyCopies: {
          status: 'read',
          copies: [{ key: 'auto_backup_1793413294673', value: { canvases: rows('copy', 3) } }],
        },
        recoveryPoints: {
          status: 'read',
          points: [
            {
              id: 'pre-migration-1760000000000',
              kind: 'pre-migration',
              status: 'verified',
              verified: true,
              createdAt: 1,
              verifiedAt: 2,
              stores: [{ store: 'elements', values: rows('point', 3) }],
            },
          ],
        },
      },
      { now: NOW },
    );
    const parts = [...serialize(file)];
    assert.equal(parts.join(''), JSON.stringify(file));
    for (const part of parts) {
      const marks = part.match(/<[a-z]+-\d+>/g) || [];
      assert.ok(marks.length <= 1, `a part holds ${marks.length} records: ${part.slice(0, 120)}`);
    }
  });
});

describe('#82 review 7: only known stores, and credentials in any spelling, stay out', () => {
  it('drops an unknown store, a key/value row naming a credential, and credential fields in any case', () => {
    const file = buildSalvage(
      {
        database: {
          status: 'open',
          stores: [
            {
              store: 'canvases',
              values: [{ id: 'a', name: 'A', llmAPIKey: 'canary-mixed-case', pass: 'canary-pass' }],
            },
            {
              store: 'themes',
              values: [
                { id: 't', name: 'Dusk' },
                { key: 'llmApiKey', value: 'canary-kv-row' },
              ],
            },
            { store: 'vault', values: [{ id: 'v', sealed: 'canary-vault' }] },
          ],
        },
        legacyCopies: {
          status: 'read',
          copies: [
            {
              key: 'recovery_backup_1793413294676',
              value: { canvases: [], nested: { settings: [{ key: 'llmApiKey', value: 'canary-nested-kv' }] } },
            },
          ],
        },
        recoveryPoints: { status: 'missing', points: [] },
      },
      { now: NOW },
    );
    const text = JSON.stringify(file);
    for (const canary of ['canary-mixed-case', 'canary-pass', 'canary-kv-row', 'canary-vault', 'canary-nested-kv']) {
      assert.equal(text.includes(canary), false, canary);
    }
    assert.equal('vault' in file.stores, false);
    assert.ok(
      file.omissions.some((/** @type {any} */ o) => o.at === 'CanvasTabDB.vault' && o.reason === 'unknown-store'),
    );
    // The note and the theme themselves stay
    assert.equal(file.canvases[0].name, 'A');
    assert.deepEqual(file.stores.themes, [{ id: 't', name: 'Dusk' }]);
  });

  it('the reader reads no store outside the known schema', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.extra-store')));
    const read = await createSalvageReader({
      indexedDB: of.real,
      keyRange: KeyRange,
      crypto,
      settings: of.chrome.api.storage.local,
    }).collect();
    const dump = await legacyEnv.dumpDatabase(of.real);
    const extra = Object.keys(dump.stores).filter(
      name =>
        ![
          'canvases',
          'elements',
          'settings',
          'media',
          'search_index',
          'folders',
          'links',
          'themes',
          'vectors',
          'snapshots',
          'meta',
          'migrations',
        ].includes(name),
    );
    assert.ok(extra.length > 0, 'the fixture has a store outside the schema');
    for (const name of extra) {
      const found = read.database.stores.find(store => store.store === name);
      assert.ok(!found || found.values.length === 0, `${name} was read`);
    }
  });
});

describe('#82 review 8: without Web Locks nothing runs', () => {
  it('refuses rather than run with no exclusion across contexts', async () => {
    const log = /** @type {string[]} */ ([]);
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ ([
        contribution('reconnect', 'non-destructive', {
          preview: async () => ({
            preview: { changes: [{ target: 'preferences', creates: 0, updates: 1, deletes: 0 }] },
            plan: 1,
          }),
          apply: async () => {
            log.push('apply');
          },
          verify: async () => ({ ok: true }),
        }),
      ]),
      locks: null,
    });
    const answer = await pipeline.run(runOf('reconnect'));
    assert.deepEqual(
      [/** @type {any} */ (answer).kind, /** @type {any} */ (answer).cause, /** @type {any} */ (answer).code],
      ['unavailable', 'coordinator', 'no-locks'],
    );
    assert.deepEqual(log, []);
  });
});

describe('#82 review 9: a regenerable run changes only derived stores', () => {
  it('refuses a regenerable preview that updates notes or blocks', async () => {
    const log = /** @type {string[]} */ ([]);
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ ([
        contribution('remove-index', 'regenerable', {
          preview: async () => ({
            preview: { changes: [{ target: 'elements', creates: 0, updates: 4, deletes: 0 }] },
            plan: 1,
          }),
          apply: async () => {
            log.push('apply');
          },
          verify: async () => ({ ok: true }),
        }),
      ]),
    });
    const answer = asRun(await pipeline.run(runOf('remove-index')));
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'changes-user-records');
    assert.deepEqual(log, []);
  });
});

describe('#82 review 11: rebuild-index indexes what the app indexes, and verifies what it planned', () => {
  it('leaves trashed and archived notes and templates out, and passes beside a note made mid-run', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.orphans')));
    const adapter = createIndexedDbAdapter({ indexedDB: of.real, settings: of.chrome.api.storage.local });
    await adapter.open();
    const before = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'search_index');
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { adapter },
      hooks: {
        // A note created while the rebuild runs, with createNote's entry, which has no tags
        between: async step => {
          if (step !== 'verify') return;
          await adapter.commit({
            commandId: 'mid-run',
            command: /** @type {any} */ ({ type: 'createNote', commandId: 'mid-run' }),
            effect: {
              kind: 'units',
              units: [
                {
                  stores: ['notes', 'searchIndex'],
                  async run(tx) {
                    tx.put('notes', { id: 'mid-run-note', name: 'New', updatedAt: 9 });
                    tx.put('searchIndex', { noteId: 'mid-run-note', name: 'New', content: '', updatedAt: 9 });
                  },
                },
              ],
            },
            done: () =>
              /** @type {any} */ ({
                kind: 'committed',
                code: 'note-created',
                changedIds: [],
                messageKey: 'committed.note-created',
                severity: 'success',
              }),
          });
        },
      },
    });
    const first = asRun(await pipeline.run(runOf('rebuild-index')));
    assert.deepEqual(first.impact.changes, [{ target: 'search_index', creates: 0, updates: 2, deletes: 0 }]);
    const done = asRun(
      await pipeline.run(
        runOf('rebuild-index', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    const after = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'search_index');
    const notes = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'canvases');
    for (const [noteId, note] of Object.entries(notes)) {
      if (note.trashed || note.archived || note.isTemplate)
        assert.deepEqual(after[noteId], before[noteId], `${note.name} untouched`);
    }
  });
});

describe("#80's contract: the pipeline resolves no incident", () => {
  it("leaves every incident open, the records' own included, however the run ends", async () => {
    const { pipeline, records } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { files: memoryFiles(), salvage: salvageOf(readable()) },
    });
    const raised = await records.raise({
      providerId: 'storage',
      faultCode: 'write-failed',
      subjectId: 'NewTabNoteTrust',
      severity: 'data-risk',
      affected: [],
      preserved: [],
      evidence: {},
    });
    asRun(await pipeline.run(runOf('save-salvage-file', { incidentId: raised.incident?.id })));
    const incidents = await records.incidents();
    assert.ok(incidents.every(incident => incident.state === 'open'));
  });
});
