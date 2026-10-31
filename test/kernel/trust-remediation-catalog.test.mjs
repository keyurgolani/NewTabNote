// #20 slice 3's remediations (remediation/catalog.js) on #17's real adapters over
// fake-indexeddb and the storage fixtures: each passes #15's conformance suite with its id in
// REMEDIATION_IDS; safe-disable, retry, rebuild-index, and orphan recovery each do only what
// their preview said and verify it; orphan recovery takes a verified pre-repair point that
// holds every block it moves first, lands them in a new Inbox note, and deletes nothing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { createRepairPoints } from '../../js/kernel/adapters/indexeddb/repair-points.js';
import {
  listPoints,
  openRecovery,
  readPointStore,
  verifyPoint,
  DEFAULT_LIMITS,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { REMEDIATION_IDS } from '../../js/trust/core/codes.js';
import { remediation } from '../../js/trust/core/families.js';
import { REMEDIATIONS, searchEntryOf } from '../../js/trust/core/remediation/catalog.js';
import { REMEDIATION_CLASSES } from '../../js/trust/core/vocabulary.js';
import { placementOf } from '../../js/product/placement.js';
import { describeRegistryConformance } from './registry-conformance.mjs';
import { KeyRange, ROOMY, legacyEnv, profileWith, synthesized } from './migration-support.mjs';
import { memoryFiles, remediationCenter, runLocks, runOf } from './trust-remediation-support.mjs';
import { manualClock } from './trust-support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

const crypto = /** @type {any} */ (webcrypto);
const FIXTURES = synthesized();

describeRegistryConformance('remediation catalog (#20 slice 3)', {
  family: remediation,
  builtIns: /** @type {any} */ (REMEDIATIONS),
  sample: (id, rank) => /** @type {any} */ ({ ...REMEDIATIONS[0], id, rank, group: 'inspect' }),
  fixtures: {
    'remediation-steps': (contribution, implementation) => {
      const steps = /** @type {Record<string, unknown>} */ (implementation);
      for (const step of ['preview', 'apply', 'verify']) {
        assert.equal(typeof steps[step], 'function', `${contribution.ref} has no ${step}()`);
      }
      assert.ok(REMEDIATION_CLASSES.includes(/** @type {any} */ (contribution.data).class));
      assert.ok(
        REMEDIATION_IDS.includes(/** @type {string} */ (contribution.id)),
        `${contribution.ref} isn't registered`,
      );
    },
  },
});

/**
 * A profile from fixture `id`, with the real adapters and a Trust Center over them
 * @param {string} id
 * @param {{prepare?: (of: Profile) => Promise<void>, hooks?: {between?: (step: string) => void | Promise<void>}}} [options]
 */
async function profileCenter(id, { prepare, hooks } = {}) {
  const of = await profileWith(/** @type {any} */ (FIXTURES.get(id)));
  if (prepare) await prepare(of);
  const clock = manualClock();
  const locks = runLocks();
  const adapter = createIndexedDbAdapter({
    indexedDB: of.real,
    settings: of.chrome.api.storage.local,
    locks: /** @type {any} */ (locks),
  });
  await adapter.open();
  const recoveryPoints = createRepairPoints({
    indexedDB: of.real,
    keyRange: KeyRange,
    crypto,
    clock,
    locks: /** @type {any} */ (locks),
    estimate: ROOMY,
  });
  const files = memoryFiles();
  const made = await remediationCenter({
    contributions: /** @type {any} */ (REMEDIATIONS),
    ports: { adapter, recoveryPoints, files },
    locks,
    clock,
    hooks,
  });
  return { ...made, of, adapter, files };
}

/**
 * Puts `rows` into `store` of CanvasTabDB as it is on disk
 * @param {IDBFactory} factory
 * @param {string} store
 * @param {unknown[]} rows
 */
async function putRaw(factory, store, rows) {
  const db = /** @type {IDBDatabase} */ (
    await new Promise((resolve, reject) => {
      const request = factory.open('CanvasTabDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })
  );
  const tx = db.transaction(store, 'readwrite');
  for (const row of rows) tx.objectStore(store).put(row);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

/**
 * Every key of every CanvasTabDB store, by store
 * @param {IDBFactory} factory
 */
async function keysOf(factory) {
  const dump = await legacyEnv.dumpDatabase(factory);
  return Object.fromEntries(
    Object.entries(dump.stores).map(([name, store]) => [
      name,
      /** @type {any} */ (store).records.map((/** @type {any} */ r) => String(r.key)).sort(),
    ]),
  );
}

/**
 * @param {unknown} answer
 * @returns {any}
 */
const asRun = answer => {
  assert.equal(/** @type {any} */ (answer).kind, 'remediation', JSON.stringify(answer));
  return answer;
};

describe('recover-orphans: "Recover N blocks into a new Inbox note" (#20, refined AC9)', () => {
  it('previews the blocks, takes a verified pre-repair point that holds them, moves them to a new Inbox note, and deletes nothing', async () => {
    const { pipeline, of, records } = await profileCenter('v8.orphans');
    const before = await keysOf(of.real);
    const beforeBlocks = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'elements');

    const first = asRun(await pipeline.run(runOf('recover-orphans')));
    assert.equal(first.state, 'awaiting-confirmation');
    assert.equal(first.class, 'reversible');
    assert.deepEqual(first.impact.changes, [
      { target: 'canvases', creates: 1, updates: 0, deletes: 0 },
      { target: 'elements', creates: 0, updates: 1, deletes: 0 },
      { target: 'search_index', creates: 1, updates: 0, deletes: 0 },
    ]);
    assert.deepEqual(await keysOf(of.real), before, 'nothing changed before the confirmation');

    const done = asRun(
      await pipeline.run(
        runOf('recover-orphans', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    assert.equal(done.outcome, 'verified');
    assert.match(done.recoveryPointId, /^pre-repair-\d+$/);

    // Nothing deleted: every key that was there still is
    const after = await keysOf(of.real);
    for (const [store, keys] of Object.entries(before)) {
      for (const key of keys) assert.ok(after[store].includes(key), `${store}/${key} is still there`);
    }
    // The orphan now sits in a new note Inbox lists, and only its canvasId changed
    const dump = await legacyEnv.dumpDatabase(of.real);
    const notes = legacyEnv.recordsOf(dump, 'canvases');
    const blocks = legacyEnv.recordsOf(dump, 'elements');
    const orphanId = Object.keys(beforeBlocks).find(key => beforeBlocks[key].canvasId === 'note-gone');
    const moved = blocks[/** @type {string} */ (orphanId)];
    const note = notes[moved.canvasId];
    assert.ok(note, 'its new note exists');
    // The answer names it, so the view can open it (#20 slice 4a)
    assert.equal(done.noteId, moved.canvasId);
    const folders = Object.keys(legacyEnv.recordsOf(dump, 'folders'));
    assert.deepEqual(placementOf(note, folders).placement, { kind: 'inbox' });
    assert.deepEqual({ ...moved, canvasId: 'note-gone' }, beforeBlocks[/** @type {string} */ (orphanId)]);
    assert.ok(legacyEnv.recordsOf(dump, 'search_index')[moved.canvasId], 'its search entry exists');

    // The point is there, verifies, and holds the block as it was
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      const point = (await listPoints(recovery)).find(candidate => candidate.id === done.recoveryPointId);
      assert.ok(point && point.kind === 'pre-repair' && point.status === 'verified' && !point.pinned);
      const io = { keyRange: KeyRange, crypto, limits: DEFAULT_LIMITS };
      assert.deepEqual(await verifyPoint({ recovery, point, io }), { ok: true });
      const held = (await readPointStore(recovery, point, 'elements', io)).find(row => row.key === orphanId);
      assert.equal(held?.value.canvasId, 'note-gone');
    } finally {
      recovery.close();
    }
    const run = (await records.runs()).find(item => item.id === done.runId);
    assert.equal(run?.recoveryPointId, done.recoveryPointId);

    // Once recovered, there's nothing left to do
    const again = asRun(await pipeline.run(runOf('recover-orphans')));
    assert.equal(again.state, 'cancelled');
    assert.equal(again.outcome, 'nothing-to-do');
  });

  it('moves nothing when the orphans changed after the user confirmed, and says so', async () => {
    /** @type {Profile | null} */
    let profile = null;
    const { pipeline } = await profileCenter('v8.orphans', {
      prepare: async of => {
        profile = of;
      },
      hooks: {
        between: async step => {
          // Another block loses its note after the point, right before apply
          if (step === 'apply' && profile) {
            await putRaw(profile.real, 'elements', [
              { id: 'late-orphan', canvasId: 'also-gone', type: 'text', content: '' },
            ]);
          }
        },
      },
    });
    const first = asRun(await pipeline.run(runOf('recover-orphans')));
    const answer = asRun(
      await pipeline.run(
        runOf('recover-orphans', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(answer.state, 'failed');
    assert.equal(answer.step, 'apply');
    assert.equal(answer.outcome, 'preview-changed');
    const blocks = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(/** @type {any} */ (profile).real), 'elements');
    assert.deepEqual(
      Object.values(blocks)
        .filter((/** @type {any} */ b) => b.canvasId === 'note-gone' || b.canvasId === 'also-gone')
        .map((/** @type {any} */ b) => b.id)
        .sort(),
      ['1760000291458-wqalv6h1t', 'late-orphan'],
    );
  });

  it("drops a point that doesn't hold every record the run would change, and never hands it out", async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.orphans')));
    const points = createRepairPoints({
      indexedDB: of.real,
      keyRange: KeyRange,
      crypto,
      clock: manualClock(),
      locks: /** @type {any} */ (runLocks()),
      estimate: ROOMY,
    });
    // A block typed in after the copy read, which the point can't hold
    assert.deepEqual(await points.make({ holds: { elements: ['typed-after-the-copy'] } }), {
      ok: false,
      code: 'recovery-point-unverified',
    });
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      assert.deepEqual(await listPoints(recovery), []);
    } finally {
      recovery.close();
    }
    const made = await points.make({ holds: {} });
    assert.equal(made.ok, true);
    assert.equal(await points.verify(/** @type {any} */ (made).pointId), true);
    assert.equal(await points.verify('pre-repair-1000000000000'), false);
  });

  it('short of space for the point, it changes nothing and says why', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.orphans')));
    const before = await legacyEnv.dumpDatabase(of.real);
    const adapter = createIndexedDbAdapter({ indexedDB: of.real, settings: of.chrome.api.storage.local });
    await adapter.open();
    const tight = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: {
        adapter,
        recoveryPoints: createRepairPoints({
          indexedDB: of.real,
          keyRange: KeyRange,
          crypto,
          clock: manualClock(),
          locks: /** @type {any} */ (runLocks()),
          estimate: async () => ({ quota: 100, usage: 99 }),
        }),
      },
    });
    const first = asRun(await tight.pipeline.run(runOf('recover-orphans')));
    const answer = asRun(
      await tight.pipeline.run(
        runOf('recover-orphans', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'space-short');
    assert.equal(answer.step, 'protect');
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });
});

/**
 * js/workers/indexer.js as the page runs it, in a context of its own: its INDEX_NOTES answer
 * @param {unknown[]} notes
 * @param {Record<string, unknown[]>} blocks
 */
function indexerEntries(notes, blocks) {
  /** @type {any[]} */
  const posted = [];
  const self = {
    postMessage: (/** @type {any} */ message) => posted.push(message),
    onmessage: /** @type {any} */ (null),
  };
  vm.runInNewContext(fs.readFileSync(new URL('../../js/workers/indexer.js', import.meta.url), 'utf8'), { self });
  self.onmessage({ data: { type: 'INDEX_NOTES', data: { notes, blocks } } });
  // Out of the worker's realm, so its arrays compare as this one's do
  return JSON.parse(JSON.stringify(posted[0].data));
}

describe('rebuild-index (regenerable)', () => {
  it("writes each entry of the app's notes as js/workers/indexer.js builds it, after a confirmation, and removes no entry", async () => {
    const { pipeline, of } = await profileCenter('v8.orphans', {
      // A search entry whose note is gone: the last trace of its title, kept
      prepare: of =>
        putRaw(of.real, 'search_index', [{ noteId: 'note-gone', name: 'Lost note', content: '', updatedAt: 1 }]),
    });
    const first = asRun(await pipeline.run(runOf('rebuild-index')));
    assert.equal(first.state, 'awaiting-confirmation');
    assert.deepEqual(first.needs, ['confirmation']);
    // Groceries and Reading list: not the archived note, the trashed one, or the template
    assert.deepEqual(first.impact.changes, [{ target: 'search_index', creates: 0, updates: 2, deletes: 0 }]);
    const done = asRun(
      await pipeline.run(
        runOf('rebuild-index', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(done.state, 'succeeded', JSON.stringify(done));

    const dump = await legacyEnv.dumpDatabase(of.real);
    const notes = Object.values(legacyEnv.recordsOf(dump, 'canvases')).filter(
      note => !note.trashed && !note.archived && !note.isTemplate,
    );
    assert.equal(notes.length, 2);
    const allBlocks = Object.values(legacyEnv.recordsOf(dump, 'elements'));
    /** @type {Record<string, unknown[]>} */
    const byNote = {};
    for (const note of notes) {
      byNote[note.id] = allBlocks.filter(block => block.canvasId === note.id).sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    const entries = legacyEnv.recordsOf(dump, 'search_index');
    for (const expected of indexerEntries(notes, byNote)) assert.deepEqual(entries[expected.noteId], expected);
    assert.deepEqual(entries['note-gone'], { noteId: 'note-gone', name: 'Lost note', content: '', updatedAt: 1 });

    const again = asRun(await pipeline.run(runOf('rebuild-index')));
    assert.equal(again.outcome, 'nothing-to-do');
  });

  it("matches the indexer's entry for markup, tags, and an untitled note", () => {
    const note = { id: 'n', name: '', updatedAt: 5 };
    const blocks = [
      { id: 'a', canvasId: 'n', content: '<b>Plan</b> #Trip' },
      { id: 'b', canvasId: 'n', content: null },
      { id: 'c', canvasId: 'n', content: 'see #trip and #work-2' },
    ];
    assert.deepEqual(searchEntryOf(note, blocks), indexerEntries([note], { n: blocks })[0]);
  });
});

describe('safe-disable (non-destructive)', () => {
  it("turns semantic search's embeddings off and reads the setting back, and keeps the vectors", async () => {
    const { pipeline, of, records } = await profileCenter('v8.orphans', {
      prepare: async of => {
        await of.chrome.api.storage.local.set({ setting_embeddingsEnabled: true });
      },
    });
    const raised = await records.raise({
      providerId: 'local-inference',
      faultCode: 'load-failed',
      subjectId: null,
      severity: 'degraded',
      affected: ['search'],
      preserved: ['capture'],
      evidence: {},
    });
    const vectorsBefore = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'vectors');
    const done = asRun(await pipeline.run(runOf('safe-disable', { incidentId: raised.incident?.id })));
    assert.equal(done.state, 'succeeded');
    assert.equal(done.class, 'non-destructive');
    assert.deepEqual(done.needs, []);
    assert.deepEqual(done.impact.changes, [{ target: 'preferences', creates: 0, updates: 1, deletes: 0 }]);
    assert.equal(
      (await of.chrome.api.storage.local.get(['setting_embeddingsEnabled'])).setting_embeddingsEnabled,
      false,
    );
    assert.deepEqual(legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'vectors'), vectorsBefore);
    const again = asRun(await pipeline.run(runOf('safe-disable')));
    assert.equal(again.outcome, 'nothing-to-do');
  });

  it("doesn't apply to an incident of another provider", async () => {
    const { pipeline, records } = await profileCenter('v8.orphans');
    const raised = await records.raise({
      providerId: 'storage',
      faultCode: 'quota',
      subjectId: null,
      severity: 'data-risk',
      affected: [],
      preserved: [],
      evidence: {},
    });
    const answer = asRun(await pipeline.run(runOf('safe-disable', { incidentId: raised.incident?.id })));
    assert.equal(answer.outcome, 'not-applicable');
  });
});

describe('retry-open (non-destructive)', () => {
  /**
   * @param {{reopen: () => Promise<any>}} storage
   * @param {((ids: readonly string[]) => Promise<Record<string, any>>) | undefined} checks
   */
  const retry = async (storage, checks) => {
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { storage, ...(checks ? { checks } : {}) },
    });
    return asRun(await pipeline.run(runOf('retry-open')));
  };

  it('succeeds only when every provider it retried reads verified after', async () => {
    let reopened = 0;
    const storage = { reopen: async () => ((reopened += 1), { ok: true }) };
    const passed = await retry(storage, async ids => Object.fromEntries(ids.map(id => [id, 'verified'])));
    assert.equal(passed.state, 'succeeded');
    assert.equal(reopened, 1);
    const degraded = await retry(storage, async ids =>
      Object.fromEntries(ids.map(id => [id, id === 'capture' ? 'degraded' : 'verified'])),
    );
    assert.equal(degraded.state, 'failed');
    assert.equal(degraded.outcome, 'not-verified');
    const unchecked = await retry(storage, undefined);
    assert.equal(unchecked.outcome, 'not-verified', 'no provider ran, so nothing verified it');
  });

  it("answers the open's own code when storage still won't open", async () => {
    const answer = await retry({ reopen: async () => ({ ok: false, code: 'blocked-upgrade' }) }, async () => ({}));
    assert.equal(answer.state, 'failed');
    assert.equal(answer.step, 'apply');
    assert.equal(answer.outcome, 'blocked-upgrade');
  });

  it('is not applicable without a storage port, and changes nothing', async () => {
    const { pipeline } = await remediationCenter({ contributions: /** @type {any} */ (REMEDIATIONS) });
    const answer = asRun(await pipeline.run(runOf('retry-open')));
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'not-applicable');
  });
});
