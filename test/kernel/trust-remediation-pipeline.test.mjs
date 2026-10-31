// #20 slice 3's remediation pipeline (remediation/pipeline.js; approved AC4; refined AC7 to
// AC9): plan, preview, protect, apply, verify, record, with the run's record written before
// the first mutation; each class's gate refusing without its precondition; a run cut off at
// any step leaving its record at that step and the user's data unchanged or protected; one
// run per remediation key across contexts; no run deleting a user-owned record on its own; and
// never a success for a run that didn't verify.
//
// The remediations here are test doubles over a `world` the test can read, one per class,
// under ids REMEDIATION_IDS lists. catalog.js's real ones have their own tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { result as runResult } from '../../js/trust/core/operations/recovery-run.js';
import { runSchema } from '../../js/trust/core/records.js';
import { CLASS_PROTECTIONS, checkConsent, checkProtected } from '../../js/trust/core/remediation/gates.js';
import { PENDING_MS, lockName, providerChecks } from '../../js/trust/core/remediation/pipeline.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { RUN_STEPS } from '../../js/trust/core/vocabulary.js';
import { Closed, memoryFiles, remediationCenter, runLocks, runOf } from './trust-remediation-support.mjs';

/** @typedef {import('../../js/trust/core/remediation/ports.js').RemediationPorts} RemediationPorts */
/** @typedef {import('../../js/trust/core/records.js').RemediationRun} RemediationRun */

/**
 * What the test remediations act on: notes and blocks a test reads before and after, and the
 * order things happened in
 */
function world() {
  return {
    notes: new Map([
      ['n1', { id: 'n1' }],
      ['n2', { id: 'n2' }],
    ]),
    blocks: new Map([['b1', { id: 'b1', canvasId: 'gone' }]]),
    index: new Map([['n1', { noteId: 'n1' }]]),
    flag: false,
    /** @type {string[]} */
    log: [],
    verifies: true,
    previewDeletes: 0,
    /** Bumped to make the next preview differ from the last */
    drift: 0,
  };
}

/** @typedef {ReturnType<typeof world>} World */

let rank = 0;

/**
 * A contribution in the remediation family
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
 * One test remediation of each class, over `w`
 * @param {World} w
 */
function contributions(w) {
  return [
    // non-destructive: sets a flag
    contribution('reconnect', 'non-destructive', {
      preview: async () => ({
        preview: { changes: [{ target: 'preferences', creates: 0, updates: 1, deletes: 0 }] },
        plan: 1,
      }),
      apply: async () => {
        w.log.push('mutate');
        w.flag = true;
        return true;
      },
      verify: async () => (w.verifies && w.flag ? { ok: true } : { ok: false, code: 'not-verified' }),
    }),
    // regenerable: removes derived entries
    contribution('remove-index', 'regenerable', {
      preview: async () => ({
        preview: { changes: [{ target: 'search_index', creates: 0, updates: w.drift, deletes: w.index.size }] },
        plan: [...w.index.keys()],
      }),
      apply: async (/** @type {unknown} */ _context, /** @type {string[]} */ plan) => {
        w.log.push('mutate');
        for (const key of plan) w.index.delete(key);
        return plan;
      },
      verify: async () => (w.verifies && w.index.size === 0 ? { ok: true } : { ok: false, code: 'not-verified' }),
    }),
    // reversible: moves a block, and its point must hold it
    contribution('restore-point', 'reversible', {
      preview: async () => ({
        preview: { changes: [{ target: 'elements', creates: 0, updates: w.blocks.size, deletes: w.previewDeletes }] },
        plan: [...w.blocks.keys()],
      }),
      protects: (/** @type {string[]} */ plan) => ({ elements: plan }),
      apply: async (/** @type {unknown} */ _context, /** @type {string[]} */ plan) => {
        w.log.push('mutate');
        for (const key of plan) w.blocks.set(key, { id: key, canvasId: 'n1' });
        return plan;
      },
      verify: async () => ({ ok: true }),
    }),
    // irreversible: deletes a note, after a recovery file and the typed words
    contribution('delete-restore-point', 'irreversible', {
      phrase: 'Delete restore point',
      preview: async () => ({
        preview: { changes: [{ target: 'canvases', creates: 0, updates: 0, deletes: 1 }] },
        plan: 'n2',
      }),
      // What it destroys, whose rows the recovery file must hold (#20 slice 4a)
      destroys: (/** @type {unknown} */ _context, /** @type {string} */ plan) => plan,
      apply: async (/** @type {unknown} */ _context, /** @type {string} */ plan) => {
        w.log.push('mutate');
        w.notes.delete(plan);
        return plan;
      },
      verify: async (/** @type {unknown} */ _context, /** @type {string} */ applied) =>
        w.notes.has(applied) ? { ok: false, code: 'not-verified' } : { ok: true },
    }),
  ];
}

/**
 * A recovery-point port: made points by id, and what to break
 * @param {World} w
 */
function points(w) {
  const port = {
    /** @type {Map<string, Readonly<Record<string, readonly string[]>>>} */
    made: new Map(),
    fail: /** @type {string | null} */ (null),
    unverified: false,
    /** @param {{holds?: Readonly<Record<string, readonly string[]>>}} options */
    async make({ holds = {} }) {
      w.log.push('point');
      if (port.fail) return { ok: /** @type {const} */ (false), code: port.fail };
      const pointId = `pre-repair-${1760000000000 + port.made.size}`;
      port.made.set(pointId, holds);
      return { ok: /** @type {const} */ (true), pointId, verifiedAt: 1 };
    },
    /** @param {string} pointId */
    async verify(pointId) {
      return !port.unverified && port.made.has(pointId);
    },
  };
  return port;
}

/** A salvage port over a profile holding the one note the irreversible fixture deletes */
const emptySalvage = {
  collect: async () => ({
    database: { status: /** @type {const} */ ('open'), stores: [{ store: 'canvases', values: [{ id: 'n2' }] }] },
    legacyCopies: { status: /** @type {const} */ ('read'), copies: [] },
    recoveryPoints: { status: /** @type {const} */ ('missing'), points: [] },
  }),
  restorePoint: async () => null,
  has: async () => false,
};

/**
 * A center over a fresh world, with every port the classes need
 * @param {{w?: World, ports?: RemediationPorts, hooks?: any, store?: any, locks?: any, wrapStore?: any, clock?: any}} [options]
 */
async function center({ w = world(), ports, ...rest } = {}) {
  const recoveryPoints = points(w);
  const files = memoryFiles();
  const all = { recoveryPoints, files, salvage: emptySalvage, ...ports };
  const made = await remediationCenter({ contributions: /** @type {any} */ (contributions(w)), ports: all, ...rest });
  return { ...made, w, recoveryPoints, files };
}

/**
 * The stored run `runId`
 * @param {Awaited<ReturnType<typeof center>>['records']} records
 * @param {string} runId
 * @returns {Promise<RemediationRun>}
 */
async function storedRun(records, runId) {
  const found = (await records.runs()).find(run => run.id === runId);
  assert.ok(found, `run ${runId} is stored`);
  assert.ok(v.is(runSchema, found));
  return found;
}

/**
 * `answer` as recovery.run's result schema holds it, as a run
 * @param {unknown} answer
 * @returns {import('../../js/trust/core/operations/recovery-run.js').RemediationAnswer}
 */
function asRun(answer) {
  assert.ok(v.is(runResult, answer), `outside recovery.run's result schema: ${JSON.stringify(answer)}`);
  assert.equal(/** @type {any} */ (answer).kind, 'remediation', JSON.stringify(answer));
  return /** @type {any} */ (answer);
}

/**
 * A store that logs each committed run record as `run:<state>:<step>`, and can refuse the run
 * writes `refuse` picks, as a store the disk stops taking writes does
 * @param {string[]} log
 * @param {{refuse: ((run: RemediationRun) => boolean) | null}} plan
 */
const observed = (log, plan) => (/** @type {any} */ store) => ({
  open: () => store.open(),
  close: () => store.close(),
  /** @param {any} stores @param {any} mode @param {any} unit */
  async run(stores, mode, unit) {
    /** @type {RemediationRun[]} */
    const puts = [];
    const value = await store.run(stores, mode, (/** @type {any} */ tx) =>
      unit({
        ...tx,
        /** @param {string} name @param {any} record */
        put(name, record) {
          if (name === 'runs') {
            if (plan.refuse && plan.refuse(record)) throw new UnavailableError('storage', 'quota', false);
            puts.push(record);
          }
          tx.put(name, record);
        },
      }),
    );
    for (const run of puts) log.push(`run:${run.state}:${run.step}`);
    return value;
  },
});

describe('the remediation pipeline (#20 slice 3)', () => {
  it('writes the run record before the first mutation, and names each step before it starts', async () => {
    const w = world();
    const { pipeline } = await center({ w, wrapStore: observed(w.log, { refuse: null }) });
    const answer = asRun(await pipeline.run(runOf('reconnect')));
    assert.equal(answer.state, 'succeeded');
    assert.equal(answer.outcome, 'verified');
    assert.equal(answer.step, 'record');
    assert.deepEqual(w.log, [
      'run:planned:plan',
      'run:running:preview',
      'run:running:protect',
      'run:running:apply',
      'mutate',
      'run:running:verify',
      'run:succeeded:record',
    ]);
  });

  it("changes nothing when the run's record won't write, at any step before apply", async () => {
    for (const step of ['plan', 'preview', 'protect', 'apply']) {
      const w = world();
      const plan = { refuse: (/** @type {RemediationRun} */ run) => run.step === step };
      const { pipeline } = await center({ w, wrapStore: observed(w.log, plan) });
      const answer = await pipeline.run(runOf('reconnect'));
      assert.deepEqual(answer, {
        kind: 'unavailable',
        cause: 'storage',
        code: 'not-recorded',
        retryable: true,
        messageKey: 'unavailable.not-recorded',
        severity: 'error',
      });
      assert.equal(w.flag, false, `${step}: nothing applied`);
      assert.ok(!w.log.includes('mutate'), step);
    }
  });

  it('never answers a run that applied but did not verify as succeeded, and keeps its record honest', async () => {
    const w = world();
    w.verifies = false;
    const { pipeline, records } = await center({ w });
    const answer = asRun(await pipeline.run(runOf('reconnect')));
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'not-verified');
    assert.equal(answer.step, 'verify');
    assert.equal(answer.severity, 'error');
    const run = await storedRun(records, answer.runId);
    assert.equal(run.state, 'failed');
    assert.equal(run.step, 'verify');
    assert.equal(run.outcome, 'not-verified');
  });

  it('records a step that threw as failed at that step, with a registered code and never a message', async () => {
    const w = world();
    const steps = contributions(w);
    const leaky = {
      ...steps[0],
      implementation: {
        ...steps[0].implementation,
        apply: async () => {
          throw new Error('secret text from the note: canary-apply-message');
        },
      },
    };
    const { pipeline, records, journal } = await remediationCenter({ contributions: /** @type {any} */ ([leaky]) });
    const answer = asRun(await pipeline.run(runOf('reconnect')));
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'apply-failed');
    assert.equal(answer.step, 'apply');
    await journal.flush();
    const everything = JSON.stringify({ answer, runs: await records.runs(), events: await records.events() });
    assert.equal(everything.includes('canary-apply-message'), false);
    assert.ok((await records.events()).some(event => event.code === 'remediation.finished'));
  });

  it('ends a run with nothing to do as cancelled, not succeeded', async () => {
    const w = world();
    const steps = contributions(w);
    const idle = {
      ...steps[0],
      implementation: {
        ...steps[0].implementation,
        preview: async () => ({
          preview: { changes: [] },
          plan: null,
          nothingToDo: true,
        }),
      },
    };
    const { pipeline } = await remediationCenter({ contributions: /** @type {any} */ ([idle]) });
    const answer = asRun(await pipeline.run(runOf('reconnect')));
    assert.equal(answer.state, 'cancelled');
    assert.equal(answer.outcome, 'nothing-to-do');
  });

  it('refuses a payload without userInitiated, and a remediation nobody registered', async () => {
    const { pipeline } = await center();
    const refused = await pipeline.run({ type: 'recovery.run', commandId: 'x', remediationId: 'reconnect' });
    assert.equal(/** @type {any} */ (refused).code, 'invalid-payload');
    const missing = await pipeline.run(runOf('reset'));
    assert.equal(/** @type {any} */ (missing).code, 'remediation-not-registered');
  });
});

describe("each class's gate refuses without its precondition (#20, approved AC4)", () => {
  it('lists what each class needs', () => {
    assert.deepEqual(CLASS_PROTECTIONS, {
      'non-destructive': [],
      regenerable: ['confirmation'],
      reversible: ['confirmation', 'recovery-point'],
      irreversible: ['confirmation', 'recovery-file', 'typed-phrase'],
      'secret-removal': ['confirmation'],
    });
    assert.deepEqual(checkConsent('regenerable', {}, undefined), { ok: false, code: 'not-confirmed' });
    assert.deepEqual(checkConsent('irreversible', { decision: 'confirm' }, 'Delete it'), {
      ok: false,
      code: 'phrase-mismatch',
    });
    assert.deepEqual(checkConsent('irreversible', { decision: 'confirm', typedPhrase: 'x' }, undefined), {
      ok: false,
      code: 'phrase-mismatch',
    });
    assert.deepEqual(checkConsent('irreversible', { decision: 'confirm', typedPhrase: ' delete  IT ' }, 'Delete it'), {
      ok: true,
    });
    assert.deepEqual(checkProtected('reversible', {}), { ok: false, code: 'no-recovery-point' });
    assert.deepEqual(checkProtected('irreversible', {}), { ok: false, code: 'file-not-saved' });
  });

  it('regenerable: previews and waits, and applies only once confirmed against the same preview', async () => {
    const { pipeline, w, records } = await center();
    const first = asRun(await pipeline.run(runOf('remove-index')));
    assert.equal(first.state, 'awaiting-confirmation');
    assert.deepEqual(first.needs, ['confirmation']);
    assert.deepEqual(first.impact, { changes: [{ target: 'search_index', creates: 0, updates: 0, deletes: 1 }] });
    assert.equal(w.index.size, 1, 'nothing removed before the confirmation');
    assert.equal((await storedRun(records, first.runId)).state, 'awaiting-confirmation');

    // Sent back without the decision: still waiting, still nothing changed
    const unconfirmed = asRun(await pipeline.run(runOf('remove-index', { runId: first.runId })));
    assert.equal(unconfirmed.state, 'awaiting-confirmation');
    assert.equal(unconfirmed.outcome, 'not-confirmed');
    assert.equal(w.index.size, 1);

    // The data moved since the user saw the preview: it goes back to them
    w.drift = 1;
    const moved = asRun(
      await pipeline.run(
        runOf('remove-index', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(moved.state, 'awaiting-confirmation');
    assert.equal(moved.outcome, 'preview-changed');
    assert.equal(w.index.size, 1);

    const done = asRun(
      await pipeline.run(
        runOf('remove-index', { runId: first.runId, decision: 'confirm', previewDigest: moved.previewDigest }),
      ),
    );
    assert.equal(done.state, 'succeeded');
    assert.equal(w.index.size, 0);
  });

  it('a cancel ends a run awaiting confirmation, and changes nothing', async () => {
    const { pipeline, w } = await center();
    const first = asRun(await pipeline.run(runOf('remove-index')));
    const cancelled = asRun(await pipeline.run(runOf('remove-index', { runId: first.runId, decision: 'cancel' })));
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.outcome, 'cancelled-by-user');
    assert.equal(w.index.size, 1);
    // and a confirm after it answers the cancelled run as it stands
    const late = asRun(
      await pipeline.run(
        runOf('remove-index', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(late.state, 'cancelled');
    assert.equal(w.index.size, 1);
  });

  it('reversible: no recovery point, or one that does not verify, and nothing is applied', async () => {
    for (const broken of ['missing-port', 'make-fails', 'unverified']) {
      const w = world();
      const ports = broken === 'missing-port' ? { recoveryPoints: undefined } : {};
      const made = await center({ w, ports });
      if (broken === 'make-fails') made.recoveryPoints.fail = 'space-short';
      if (broken === 'unverified') made.recoveryPoints.unverified = true;
      const first = asRun(await made.pipeline.run(runOf('restore-point')));
      assert.deepEqual(first.needs, ['confirmation', 'recovery-point']);
      const answer = asRun(
        await made.pipeline.run(
          runOf('restore-point', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
        ),
      );
      assert.equal(answer.state, 'failed', broken);
      assert.equal(answer.step, 'protect', broken);
      assert.equal(
        answer.outcome,
        { 'missing-port': 'no-recovery-point', 'make-fails': 'space-short', unverified: 'recovery-point-unverified' }[
          broken
        ],
      );
      assert.equal(w.blocks.get('b1')?.canvasId, 'gone', `${broken}: the block wasn't touched`);
      assert.ok(!w.log.includes('mutate'), broken);
    }
  });

  it('reversible: applies after a verified point that holds what it changes, and the run names the point', async () => {
    const { pipeline, w, recoveryPoints, records } = await center();
    const first = asRun(await pipeline.run(runOf('restore-point')));
    const answer = asRun(
      await pipeline.run(
        runOf('restore-point', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(answer.state, 'succeeded');
    assert.deepEqual(w.log, ['point', 'mutate']);
    assert.equal(answer.recoveryPointId, 'pre-repair-1760000000000');
    assert.deepEqual(recoveryPoints.made.get('pre-repair-1760000000000'), { elements: ['b1'] });
    assert.equal((await storedRun(records, answer.runId)).recoveryPointId, 'pre-repair-1760000000000');
  });

  it('irreversible: no typed words, the wrong ones, or no saved recovery file, and nothing is deleted', async () => {
    const { pipeline, w, files } = await center();
    const first = asRun(await pipeline.run(runOf('delete-restore-point')));
    assert.equal(first.state, 'awaiting-confirmation');
    assert.deepEqual(first.needs, ['confirmation', 'recovery-file', 'typed-phrase']);
    const confirm = (/** @type {Record<string, unknown>} */ more) =>
      pipeline.run(
        runOf('delete-restore-point', {
          runId: first.runId,
          decision: 'confirm',
          previewDigest: first.previewDigest,
          ...more,
        }),
      );

    assert.equal(asRun(await confirm({})).outcome, 'phrase-mismatch');
    assert.equal(asRun(await confirm({ typedPhrase: 'delete' })).outcome, 'phrase-mismatch');
    assert.equal(files.picks, 0, 'no picker before the words are right');

    // The picker cancelled: back to the preview
    files.cancel = true;
    const cancelled = asRun(await confirm({ typedPhrase: 'delete restore point' }));
    assert.equal(cancelled.state, 'awaiting-confirmation');
    assert.equal(cancelled.outcome, 'file-not-saved');

    // A file that reads back different from what was written is not saved
    files.alter = text => text.replace('"trashedCanvases":[]', '"trashedCanvases":[{"id":"x"}]');
    const altered = asRun(await confirm({ typedPhrase: 'delete restore point' }));
    assert.equal(altered.state, 'failed');
    assert.equal(altered.outcome, 'file-mismatch');
    assert.ok(w.notes.has('n2'), 'nothing deleted without a verified recovery file');
    assert.ok(!w.log.includes('mutate'));
  });

  it('irreversible: deletes only after its recovery file read back verified in this run', async () => {
    const { pipeline, w, files, records } = await center();
    const first = asRun(await pipeline.run(runOf('delete-restore-point')));
    const answer = asRun(
      await pipeline.run(
        runOf('delete-restore-point', {
          runId: first.runId,
          decision: 'confirm',
          previewDigest: first.previewDigest,
          typedPhrase: 'Delete restore point',
        }),
      ),
    );
    assert.equal(answer.state, 'succeeded');
    assert.equal(w.notes.has('n2'), false);
    assert.equal(files.last().salvage, true);
    assert.match(String(files.lastName), /^newtabnote-salvage-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.json$/);
    const run = await storedRun(records, answer.runId);
    assert.equal(typeof run.fileSavedAt, 'number');
    // The typed words are never stored
    assert.equal(
      JSON.stringify(await records.runs())
        .toLowerCase()
        .includes('delete restore point'),
      false,
    );
  });

  it('irreversible: no picker on the page, and the action stays unavailable', async () => {
    const { pipeline, w, files } = await center();
    files.unavailable = true;
    const first = asRun(await pipeline.run(runOf('delete-restore-point')));
    const answer = asRun(
      await pipeline.run(
        runOf('delete-restore-point', {
          runId: first.runId,
          decision: 'confirm',
          previewDigest: first.previewDigest,
          typedPhrase: 'delete restore point',
        }),
      ),
    );
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'picker-unavailable');
    assert.ok(w.notes.has('n2'));
  });
});

describe('no remediation deletes a user-owned record on its own (#20, refined AC9)', () => {
  it('refuses a preview that deletes notes or blocks for every class but irreversible', async () => {
    const w = world();
    w.previewDeletes = 1;
    const { pipeline } = await center({ w });
    const answer = asRun(await pipeline.run(runOf('restore-point')));
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'deletes-user-records');
    assert.equal(answer.step, 'preview');
    assert.equal(w.blocks.get('b1')?.canvasId, 'gone');
  });

  it('lets a regenerable run remove derived records, which are not user-owned', async () => {
    const { pipeline } = await center();
    const first = asRun(await pipeline.run(runOf('remove-index')));
    assert.equal(first.state, 'awaiting-confirmation');
  });
});

describe('a run cut off at any step (#20, refined AC8)', () => {
  for (const step of RUN_STEPS.filter(name => name !== 'record')) {
    it(`cut off at ${step}: the next start finds it interrupted there, and the data unchanged or protected`, async () => {
      const w = world();
      const store = createMemoryTrustStore();
      const locks = runLocks();
      let armed = true;
      const hooks = {
        between: (/** @type {string} */ at) => {
          if (armed && at === step) throw new Closed();
        },
      };
      const first = await center({ w, store, locks, hooks });
      // A reversible run reaches every step: preview, confirm, then on
      let runId;
      if (step === 'plan' || step === 'preview') {
        const answer = await first.pipeline.run(runOf('restore-point'));
        assert.equal(answer.kind, 'unavailable', step);
        runId = (await first.records.runs())[0].id;
      } else {
        armed = false;
        const held = asRun(await first.pipeline.run(runOf('restore-point')));
        armed = true;
        runId = held.runId;
        const answer = await first.pipeline.run(
          runOf('restore-point', { runId, decision: 'confirm', previewDigest: held.previewDigest }),
        );
        assert.equal(answer.kind, 'unavailable', step);
      }
      const cut = await storedRun(first.records, runId);
      assert.equal(cut.step, step, 'the record says where it stopped');

      // The next start: another context over the same store, with the lock free
      const next = await center({ w, store, locks });
      assert.equal(await next.pipeline.reconcile(), 1);
      const after = await storedRun(next.records, runId);
      assert.equal(after.state, 'interrupted');
      assert.equal(after.outcome, 'interrupted');
      assert.equal(after.step, step);
      if (step === 'verify') {
        // Applied, after its verified point
        assert.equal(w.blocks.get('b1')?.canvasId, 'n1');
        assert.ok(first.recoveryPoints.made.has(/** @type {string} */ (after.recoveryPointId)));
      } else {
        assert.equal(w.blocks.get('b1')?.canvasId, 'gone', `${step}: unchanged`);
        assert.ok(!w.log.includes('mutate'));
      }
      if (step === 'apply') assert.ok(after.recoveryPointId, 'cut off at apply, its point is named');
    });
  }

  it('leaves a run another context still holds alone, and cancels a confirmation nobody holds past its window', async () => {
    const store = createMemoryTrustStore();
    const locks = runLocks();
    const w = world();
    const first = await center({ w, store, locks });
    const waiting = asRun(await first.pipeline.run(runOf('remove-index')));
    // A running run whose lock is held elsewhere
    /** @type {RemediationRun} */
    const running = {
      id: '0badf00d-0000-4000-8000-000000000000',
      commandId: 'reconnect',
      incidentId: null,
      subjectId: null,
      state: 'running',
      step: 'apply',
      outcome: null,
      startedAt: first.clock.now(),
      updatedAt: first.clock.now(),
    };
    await first.records.putRun(running);
    locks.held.add(lockName('reconnect', null));
    const next = await center({ w, store, locks, clock: first.clock });
    assert.equal(await next.pipeline.reconcile(), 0);
    assert.equal((await storedRun(next.records, running.id)).state, 'running');
    first.clock.advance(PENDING_MS + 1);
    assert.equal(await next.pipeline.reconcile(), 1);
    assert.equal((await storedRun(next.records, waiting.runId)).state, 'cancelled');
    assert.equal((await storedRun(next.records, waiting.runId)).outcome, 'run-expired');
  });
});

describe('each remediation key runs once across tabs and the worker (#20, refined AC8)', () => {
  it('answers a second run of the key, from any context, that one is already running', async () => {
    const store = createMemoryTrustStore();
    const locks = runLocks();
    const w = world();
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const hooks = { between: async (/** @type {string} */ at) => (at === 'apply' ? gate : undefined) };
    const tab = await center({ w, store, locks, hooks });
    const worker = await center({ w, store, locks });
    const running = tab.pipeline.run(runOf('reconnect'));
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await worker.pipeline.run(runOf('reconnect'));
    assert.deepEqual(second, {
      kind: 'unavailable',
      cause: 'coordinator',
      code: 'remediation-running',
      retryable: true,
      messageKey: 'unavailable.remediation-running',
      severity: 'error',
    });
    // The same tab, too
    assert.equal(/** @type {any} */ (await tab.pipeline.run(runOf('reconnect'))).code, 'remediation-running');
    // Another key isn't held
    assert.equal(asRun(await worker.pipeline.run(runOf('remove-index'))).state, 'awaiting-confirmation');
    release();
    assert.equal(asRun(await running).state, 'succeeded');
    assert.equal(w.log.filter(entry => entry === 'mutate').length, 1);
    // Free again once it ended
    assert.equal(asRun(await worker.pipeline.run(runOf('reconnect'))).state, 'succeeded');
  });

  it('answers a commandId sent again with its first answer, and runs nothing again', async () => {
    const { pipeline, w } = await center();
    const payload = runOf('reconnect', {}, 'same-command');
    const [a, b] = await Promise.all([pipeline.run(payload), pipeline.run(payload)]);
    assert.deepEqual(a, b);
    assert.deepEqual(await pipeline.run(payload), a);
    assert.equal(w.log.filter(entry => entry === 'mutate').length, 1);
  });

  it('a confirmation for another remediation, or a run that is not there, is refused', async () => {
    const { pipeline } = await center();
    const first = asRun(await pipeline.run(runOf('remove-index')));
    const wrong = await pipeline.run(
      runOf('restore-point', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
    );
    assert.equal(/** @type {any} */ (wrong).code, 'run-not-found');
    const none = await pipeline.run(
      runOf('remove-index', {
        runId: '99999999-0000-4000-8000-000000000000',
        decision: 'confirm',
        previewDigest: '0000000000000000',
      }),
    );
    assert.equal(/** @type {any} */ (none).code, 'run-not-found');
  });

  it("a confirmation from a context that didn't hold the preview has expired, and changes nothing", async () => {
    const store = createMemoryTrustStore();
    const w = world();
    const tab = await center({ w, store });
    const first = asRun(await tab.pipeline.run(runOf('remove-index')));
    const other = await center({ w, store });
    const late = asRun(
      await other.pipeline.run(
        runOf('remove-index', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      ),
    );
    assert.equal(late.state, 'cancelled');
    assert.equal(late.outcome, 'run-expired');
    assert.equal(w.index.size, 1);
  });
});

describe('an incident a run answers', () => {
  it('must be open and from a provider the remediation applies to', async () => {
    const { pipeline, records } = await center();
    const raised = await records.raise({
      providerId: 'permissions',
      faultCode: 'grant-missing',
      subjectId: null,
      severity: 'degraded',
      affected: [],
      preserved: [],
      evidence: {},
    });
    assert.ok(raised.incident);
    const answer = asRun(await pipeline.run(runOf('reconnect', { incidentId: raised.incident.id })));
    assert.equal(answer.state, 'failed');
    assert.equal(answer.outcome, 'not-applicable');
    assert.equal(answer.step, 'plan');
  });
});

describe('providerChecks', () => {
  it('reads a status only from a receipt made since it asked, so an older verified receipt never passes a retry', async () => {
    const { records, clock } = await center();
    await records.record({
      providerId: 'storage',
      status: 'verified',
      verifiedAt: clock.now(),
      durationMs: 1,
      freshnessMs: 60_000,
      operation: 'storage.probe-readwrite',
      evidence: {},
      consequenceKey: null,
      preserved: [],
      nextAction: null,
    });
    clock.advance(10);
    const checks = providerChecks({ verify: async () => ({}), records, clock, ids: { next: () => 'c' } });
    assert.deepEqual(await checks(['storage']), { storage: 'unverified' });
  });
});
