// #20 slice 4a: the contracts the Trust and Recovery Center views need, before any view ships
// (R1, no visible change). A dismissal that holds until the problem changes, with its two
// commands; a check after a repair, and the table of the repairs the views offer; Remove
// saved keys as a confirmed removal; the irreversible gate holding the rows of what it
// destroys; saved counts, the recovered note's id and a checked diagnostics save in a run's
// answer; a time and a cause per group in trust.summary; one next-action picker; one
// `preserved` list; and repair recovery points in the copies list.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { unavailable } from '../../js/kernel/core/contracts/outcomes.js';
import { checkResult } from '../../js/kernel/core/contracts/validate.js';
import { createLegacySecretRemover } from '../../js/kernel/adapters/indexeddb/legacy-secrets.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { TRUST_COMMANDS, TRUST_QUERIES } from '../../js/trust/core/contracts.js';
import { health, remediation } from '../../js/trust/core/families.js';
import { applyRaise } from '../../js/trust/core/incidents.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { nextActionOf, nextActionSchema, repairFor } from '../../js/trust/core/next-action.js';
import { summarySchema } from '../../js/trust/core/operations/trust-summary.js';
import { result as runResult } from '../../js/trust/core/operations/recovery-run.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { credentials } from '../../js/trust/core/providers/legacy.js';
import { capture, storage } from '../../js/trust/core/providers/probe.js';
import { REMEDIATIONS } from '../../js/trust/core/remediation/catalog.js';
import { REPAIRS } from '../../js/trust/core/remediation/repairs.js';
import { EVENT_CODES } from '../../js/trust/core/event-codes.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { TRUST_OPERATIONS } from '../../js/trust/core/trust-operations.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { PROVIDER_STATUSES } from '../../js/trust/core/vocabulary.js';
import { memoryFiles, remediationCenter, runOf } from './trust-remediation-support.mjs';
import { legacyEnv } from './migration-support.mjs';
import { freshProfile } from './trust-provider-support.mjs';
import { hexIds, lockManager, manualClock, realTimers, settingsArea } from './trust-support.mjs';

/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */
/** @typedef {import('../../js/trust/core/checks.js').CheckResult} CheckResult */
/** @typedef {import('../../js/trust/core/records.js').Incident} Incident */

const DAY = 24 * 60 * 60 * 1000;

/**
 * A fixture provider whose check answers what `answers[id]` holds when it runs
 * @param {string} id
 * @param {import('../../js/trust/core/vocabulary.js').HealthGroup} group
 * @param {Record<string, CheckResult | (() => CheckResult)>} answers
 * @param {Partial<Descriptor>} [extra]
 * @returns {Descriptor}
 */
const provider = (id, group, answers, extra = {}) => ({
  id,
  version: 1,
  apiVersion: 1,
  group,
  rank: 10,
  hosts: ['workspace'],
  label: `Fixture ${id}`,
  owner: 20,
  operation: `fixture.${id}`,
  costClass: 'local-cheap',
  timeoutMs: 200,
  freshnessMs: DAY,
  triggers: ['open', 'verify-now'],
  fixtures: ['truthful-receipt'],
  observes: [],
  implementation: {
    check: () => {
      const answer = answers[id];
      return typeof answer === 'function' ? answer() : answer;
    },
  },
  ...extra,
});

/**
 * A Trust Center over fixture providers that answer what `answers` holds
 * @param {Record<string, CheckResult | (() => CheckResult)>} answers
 * @param {{context?: Record<string, unknown>}} [options]
 */
async function center(answers, { context = {} } = {}) {
  const clock = manualClock();
  const records = createTrustRecords({
    store: createMemoryTrustStore(),
    settings: settingsArea(),
    clock,
    ids: hexIds(),
    locks: lockManager(),
  });
  await records.open();
  const journal = createDiagnosticJournal({ records, clock, strict: true });
  const root = createRegistryRoot({ host: 'workspace' });
  root.register(health, [
    provider('capture', 'storage', answers, { core: true, observes: ['probe-failed', 'quota'] }),
    provider('storage', 'storage', answers, {
      core: true,
      rank: 20,
      observes: ['open-failed', 'quota', 'scan-findings'],
    }),
    provider('index', 'indexing', answers, { observes: ['lagging'] }),
    provider('credentials', 'vault', answers, { observes: ['legacy-secret'] }),
    provider('backup', 'backup', answers),
  ]);
  root.register(remediation, REMEDIATIONS);
  const resolution = root.resolve();
  const runtime = createRuntime(resolution);
  await runtime.probe();
  const trust = createTrustUseCases({
    records,
    journal,
    clock,
    timers: realTimers,
    locks: lockManager(),
    registry: { resolution, runtime, context },
    versions: { extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 },
  });
  return { clock, records, trust };
}

/**
 * Every fixture provider passing, nothing found
 * @returns {Record<string, any>}
 */
const allPassing = () => ({
  capture: { status: 'verified', capture: 'safe', looked: [{ faultCode: 'probe-failed' }, { faultCode: 'quota' }] },
  storage: { status: 'verified', capture: 'safe', looked: [{ faultCode: 'open-failed' }, { faultCode: 'quota' }] },
  index: { status: 'verified', looked: [{ faultCode: 'lagging' }] },
  credentials: { status: 'not-configured', looked: [{ faultCode: 'legacy-secret' }] },
  backup: { status: 'not-configured' },
});

/** @param {unknown} answer @returns {any} */
const dataOf = answer => {
  assert.equal(/** @type {any} */ (answer).kind, 'ready', JSON.stringify(answer));
  return /** @type {any} */ (answer).data;
};

/**
 * Runs `use` and holds its answer to the operation's result schema
 * @param {string} name
 * @param {unknown} answer
 */
const checked = (name, answer) => {
  const held = checkResult(TRUST_OPERATIONS[name], answer);
  assert.equal(held.ok, true, `${name}: ${JSON.stringify(held)} for ${JSON.stringify(answer)}`);
  return /** @type {any} */ (answer);
};

let commands = 0;
/** @param {string} type @param {Record<string, unknown>} [more] */
const command = (type, more = {}) => ({ type, commandId: `s4a-${++commands}`, ...more });

const verifyNow = (/** @type {string[]} */ providerIds) =>
  command('trust.verify', { trigger: 'verify-now', providerIds });

// ============ 1. Dismissal ============

describe('a dismissal holds until the problem changes (#20 slice 4a, item 1)', () => {
  /** @type {Incident} */
  const dismissed = {
    id: 'a1b20001-0000-4000-8000-000000000000',
    ref: 'A1B200',
    key: 'storage/open-failed/CanvasTabDB',
    providerId: 'storage',
    faultCode: 'open-failed',
    subjectId: 'CanvasTabDB',
    severity: 'data-risk',
    state: 'open',
    dismissed: true,
    dismissChangedAt: 2000,
    dismissedCause: 'open-failed',
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    resolvedAt: null,
    occurrences: 1,
    affected: [],
    preserved: [],
    evidence: { errorCode: 'open-failed' },
    appliedOps: [],
    sightedBy: ['a1b20002-0000-4000-8000-000000000000'],
  };
  /**
   * A later sighting of the same fault and subject
   * @param {Partial<import('../../js/trust/core/incidents.js').Sighting>} sighting
   */
  const sighting = sighting => ({
    opId: 'a1b20003-0000-4000-8000-000000000000',
    kind: /** @type {const} */ ('raise'),
    at: 3000,
    key: dismissed.key,
    incidentId: 'a1b20004-0000-4000-8000-000000000000',
    sighting: {
      providerId: /** @type {const} */ ('storage'),
      faultCode: /** @type {const} */ ('open-failed'),
      subjectId: /** @type {const} */ ('CanvasTabDB'),
      severity: /** @type {const} */ ('data-risk'),
      affected: [],
      preserved: [],
      evidence: { errorCode: /** @type {const} */ ('open-failed') },
      ...sighting,
    },
    count: 1,
    lineage: 'a1b20003-0000-4000-8000-000000000000',
  });

  it('a re-sighting with the same severity and cause keeps it dismissed, and so does one that names no cause', () => {
    const same = applyRaise(dismissed, sighting({}));
    assert.equal(same.dismissed, true);
    assert.equal(same.occurrences, 2);
    const silent = applyRaise(dismissed, sighting({ evidence: {} }));
    assert.equal(silent.dismissed, true);
    // A milder one doesn't change it either
    const milder = applyRaise(dismissed, sighting({ severity: 'degraded' }));
    assert.equal(milder.dismissed, true);
    // A held replay keeps it too, when it's the same problem
    assert.equal(applyRaise(dismissed, sighting({}), { unseen: true }).dismissed, true);
  });

  it('a worse severity or another cause brings it back', () => {
    const worse = applyRaise(dismissed, sighting({ severity: 'capture-risk' }));
    assert.equal(worse.dismissed, false);
    assert.equal(worse.severity, 'capture-risk');
    const other = applyRaise(dismissed, sighting({ evidence: { errorCode: 'quota' } }));
    assert.equal(other.dismissed, false);
    // Evidence moving on to a sighting with no cause doesn't forget the cause it was dismissed with
    const silent = applyRaise(dismissed, sighting({ evidence: {} }));
    const again = applyRaise(silent, { ...sighting({}), at: 4000, opId: 'a1b20005-0000-4000-8000-000000000000' });
    assert.equal(again.dismissed, true);
  });

  it('recovery.dismiss and recovery.undismiss are #13 commands for the Trust and Recovery views', () => {
    for (const name of ['recovery.dismiss', 'recovery.undismiss', 'recovery.check']) {
      assert.ok(TRUST_COMMANDS[/** @type {keyof typeof TRUST_COMMANDS} */ (name)], name);
      assert.deepEqual(TRUST_COMMANDS[/** @type {keyof typeof TRUST_COMMANDS} */ (name)].surfaces, [
        'newtab',
        'recovery',
      ]);
    }
    assert.ok(TRUST_QUERIES['recovery.copies']);
  });

  it('a dismissed incident leaves the badge, the attention lines and the cards, stays listed, and checks on every open never undo it', async () => {
    const answers = /** @type {Record<string, any>} */ (allPassing());
    answers.credentials = {
      status: 'action-required',
      nextAction: 'remove-saved-key',
      faults: [{ faultCode: 'legacy-secret', subjectId: 'setting_llmApiKey', severity: 'data-risk' }],
      looked: [{ faultCode: 'legacy-secret' }],
    };
    const { trust, records, clock } = await center(answers);
    await trust.verify(verifyNow(['credentials']));
    const [incident] = await records.incidents();
    const dismissedAnswer = checked(
      'recovery.dismiss',
      await trust.dismiss(command('recovery.dismiss', { incidentId: incident.id })),
    );
    assert.equal(dismissedAnswer.kind, 'committed');
    assert.deepEqual(dismissedAnswer.changedIds, [incident.id]);

    for (let open = 0; open < 3; open++) {
      clock.advance(60_000);
      await trust.verify(command('trust.verify', { trigger: 'open' }));
    }
    const summary = dataOf(await trust.summary());
    assert.equal(summary.actionRequired, 0);
    assert.equal(summary.groups.find((/** @type {any} */ group) => group.group === 'vault').needsAction, 0);
    assert.equal(summary.groups.find((/** @type {any} */ group) => group.group === 'vault').cause, null);
    const listed = dataOf(await trust.incidents({})).incidents;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].dismissed, true);
    assert.equal(listed[0].occurrences, 4);

    // Show it again
    const shown = checked(
      'recovery.undismiss',
      await trust.undismiss(command('recovery.undismiss', { incidentId: incident.id })),
    );
    assert.equal(shown.kind, 'committed');
    assert.equal(dataOf(await trust.summary()).actionRequired, 1);
  });

  it('a dismissed capture-risk problem no longer puts the cards at risk, and a fixed one that comes back is a new problem to see', async () => {
    const answers = /** @type {Record<string, any>} */ (allPassing());
    answers.capture = {
      status: 'failed',
      capture: 'at-risk',
      faults: [
        { faultCode: 'probe-failed', subjectId: 'CanvasTabDB', severity: 'capture-risk', affected: ['capture'] },
      ],
    };
    const { trust, records, clock } = await center(answers);
    await trust.verify(verifyNow(['capture']));
    const [incident] = await records.incidents();
    await trust.dismiss(command('recovery.dismiss', { incidentId: incident.id }));
    // The receipt still says at risk, so only a fixed check makes it safe
    assert.equal(dataOf(await trust.summary()).capture, 'at-risk');
    answers.capture = allPassing().capture;
    clock.advance(1000);
    await trust.verify(verifyNow(['capture']));
    assert.equal((await records.incidents())[0].state, 'resolved');
    assert.equal(dataOf(await trust.summary()).capture, 'safe');
    // A dismissed incident that's only an incident (a one-off failed capture) doesn't hold the cards
    clock.advance(1000);
    const raised = await trust.raise(
      command('recovery.raise', { providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' }),
    );
    assert.equal(raised.kind, 'committed');
    assert.equal(dataOf(await trust.summary()).capture, 'at-risk');
    const failed = (await records.incidents()).find(item => item.faultCode === 'capture-failed');
    await trust.dismiss(command('recovery.dismiss', { incidentId: /** @type {Incident} */ (failed).id }));
    const summary = dataOf(await trust.summary());
    assert.equal(summary.capture, 'safe');
    assert.equal(summary.actionRequired, 0);
    // It comes back after it was fixed: a new sighting of a resolved incident isn't dismissed
    answers.capture = {
      status: 'failed',
      capture: 'at-risk',
      faults: [{ faultCode: 'probe-failed', subjectId: 'CanvasTabDB', severity: 'capture-risk' }],
    };
    clock.advance(1000);
    await trust.verify(verifyNow(['capture']));
    const back = (await records.incidents()).find(item => item.id === incident.id);
    assert.equal(back?.state, 'open');
    assert.equal(back?.dismissed, false);
  });

  it('refuses an incident that is not there, and a payload without one', async () => {
    const { trust } = await center(allPassing());
    const missing = checked(
      'recovery.dismiss',
      await trust.dismiss(command('recovery.dismiss', { incidentId: 'a1b2ffff-0000-4000-8000-000000000000' })),
    );
    assert.equal(missing.kind, 'rejected');
    assert.equal(missing.code, 'incident-not-found');
    assert.equal((await trust.undismiss(command('recovery.undismiss', {}))).kind, 'rejected');
  });
});

// ============ 2. A check after a repair ============

describe('a check after a repair (#20 slice 4a, item 2)', () => {
  it('only a passing check resolves the incident, and the answer says fixed or still there', async () => {
    const answers = /** @type {Record<string, any>} */ (allPassing());
    answers.index = {
      status: 'degraded',
      faults: [{ faultCode: 'lagging', severity: 'degraded' }],
      looked: [{ faultCode: 'lagging' }],
    };
    const { trust, records } = await center(answers);
    await trust.verify(verifyNow(['index']));
    const [incident] = await records.incidents();
    const still = checked('recovery.check', await trust.check(command('recovery.check', { incidentId: incident.id })));
    assert.equal(still.kind, 'checked');
    assert.equal(still.result, 'still-there');
    assert.equal(still.providerId, 'index');
    assert.equal((await records.incidents())[0].state, 'open');

    answers.index = allPassing().index;
    const fixed = checked('recovery.check', await trust.check(command('recovery.check', { incidentId: incident.id })));
    assert.equal(fixed.result, 'fixed');
    assert.equal((await records.incidents())[0].state, 'resolved');
  });

  it("a check that couldn't run says not checked, and resolves nothing", async () => {
    const answers = /** @type {Record<string, any>} */ (allPassing());
    answers.index = {
      status: 'degraded',
      faults: [{ faultCode: 'lagging', severity: 'degraded' }],
      looked: [{ faultCode: 'lagging' }],
    };
    const { trust, records } = await center(answers);
    await trust.verify(verifyNow(['index']));
    const [incident] = await records.incidents();
    answers.index = () => {
      throw new TypeError('no port');
    };
    const answer = checked('recovery.check', await trust.check(command('recovery.check', { incidentId: incident.id })));
    assert.equal(answer.result, 'not-checked');
    assert.equal((await records.incidents())[0].state, 'open');
  });

  it('a verified run never resolves its incident', async () => {
    const answers = /** @type {Record<string, any>} */ (allPassing());
    answers.index = {
      status: 'degraded',
      faults: [{ faultCode: 'lagging', severity: 'degraded' }],
      looked: [{ faultCode: 'lagging' }],
    };
    const files = memoryFiles();
    const salvage = { collect: async () => profileRead(), restorePoint: async () => null, has: async () => false };
    const made = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { files, salvage: /** @type {any} */ (salvage) },
    });
    const raised = await made.records.raise({
      providerId: 'storage',
      faultCode: 'open-failed',
      subjectId: 'CanvasTabDB',
      severity: 'capture-risk',
    });
    const incidentId = /** @type {Incident} */ (raised.incident).id;
    const done = /** @type {any} */ (await made.pipeline.run(runOf('save-salvage-file', { incidentId })));
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    assert.equal((await made.records.incidents())[0].state, 'open');
  });

  it('each repair the views offer is for a fault its provider observes, and applies to that provider', () => {
    assert.ok(REPAIRS.length > 0);
    for (const repair of REPAIRS) {
      const descriptor = PROVIDERS.find(item => item.id === repair.providerId);
      assert.ok(descriptor, `${repair.providerId} is a provider`);
      assert.ok(
        /** @type {readonly string[]} */ (/** @type {any} */ (descriptor).observes).includes(repair.faultCode),
        `${repair.providerId} observes ${repair.faultCode}, which ${repair.remediationId} repairs`,
      );
      const contribution = REMEDIATIONS.find(item => item.id === repair.remediationId);
      assert.ok(contribution, `${repair.remediationId} is registered`);
      assert.ok(
        contribution.appliesTo.includes(repair.providerId),
        `${repair.remediationId} applies to ${repair.providerId}`,
      );
      assert.ok(
        /** @type {readonly string[]} */ (/** @type {any} */ (descriptor).remediations || []).includes(
          repair.remediationId,
        ),
        `${repair.providerId} names ${repair.remediationId}`,
      );
    }
    // Nothing offers a repair for a fault no check sees again
    for (const [code, entry] of Object.entries(EVENT_CODES)) {
      if (!entry.incident) continue;
      const { providerId, faultCode } = entry.incident;
      const observed = /** @type {any} */ (PROVIDERS.find(item => item.id === providerId)).observes.includes(faultCode);
      if (!observed) assert.equal(repairFor({ providerId, faultCode }), null, code);
    }
  });
});

// ============ 3. Remove saved keys ============

/**
 * A secrets port over the three places, as the remover and reader see them
 * @param {string[]} held
 */
function secretsPort(held) {
  const port = {
    held: [...held],
    /** @type {string[][]} */
    removed: [],
    async present() {
      return Object.freeze([...port.held]);
    },
    /** @param {readonly string[]} places */
    async remove(places) {
      port.removed.push([...places]);
      port.held = port.held.filter(place => !places.includes(place));
    },
  };
  return port;
}

describe('Remove saved keys, a confirmed removal (#20 slice 4a, item 3)', () => {
  it('previews each place and what stops working, takes the confirmed digest, and removes only those places', async () => {
    const secrets = secretsPort(['setting_llmApiKey', 'setting_syncWebdavConfig', 'settings']);
    const files = memoryFiles();
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { secrets, files },
    });
    const first = /** @type {any} */ (await pipeline.run(runOf('remove-saved-key')));
    assert.ok(v.safeParse(runResult, first).success, JSON.stringify(first));
    assert.equal(first.state, 'awaiting-confirmation');
    assert.equal(first.class, 'secret-removal');
    assert.deepEqual(first.needs, ['confirmation']);
    assert.deepEqual(first.impact.places, [
      { place: 'setting_llmApiKey', stops: ['ai'] },
      { place: 'setting_syncWebdavConfig', stops: ['sync'] },
      { place: 'settings', stops: [] },
    ]);
    assert.deepEqual(first.impact.changes, [{ target: 'saved-keys', creates: 0, updates: 0, deletes: 3 }]);
    assert.deepEqual(secrets.removed, [], 'nothing removed before the confirmation');

    const done = /** @type {any} */ (
      await pipeline.run(
        runOf('remove-saved-key', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      )
    );
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    assert.equal(done.outcome, 'verified');
    assert.deepEqual(secrets.removed, [['setting_llmApiKey', 'setting_syncWebdavConfig', 'settings']]);
    assert.deepEqual(secrets.held, []);
    // No typed phrase and no recovery file: secrets never go into a file
    assert.equal(files.picks, 0);
  });

  it('goes back to the user when the places changed since the preview they confirmed', async () => {
    const secrets = secretsPort(['setting_llmApiKey']);
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { secrets },
    });
    const first = /** @type {any} */ (await pipeline.run(runOf('remove-saved-key')));
    secrets.held.push('settings');
    const back = /** @type {any} */ (
      await pipeline.run(
        runOf('remove-saved-key', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      )
    );
    assert.equal(back.state, 'awaiting-confirmation');
    assert.equal(back.outcome, 'preview-changed');
    assert.deepEqual(secrets.removed, []);
  });

  /**
   * A secret-removal remediation with these steps, run to its confirmation
   * @param {Record<string, any>} steps
   */
  const secretRemoval = async steps => {
    let applied = false;
    const contribution = {
      ...REMEDIATIONS.find(item => item.id === 'remove-saved-key'),
      implementation: {
        async apply() {
          applied = true;
          return null;
        },
        async verify() {
          return { ok: true };
        },
        ...steps,
      },
    };
    const { pipeline } = await remediationCenter({ contributions: /** @type {any} */ ([contribution]) });
    const first = /** @type {any} */ (await pipeline.run(runOf('remove-saved-key')));
    if (first.state !== 'awaiting-confirmation') return { answer: first, applied };
    const answer = /** @type {any} */ (
      await pipeline.run(
        runOf('remove-saved-key', { runId: first.runId, decision: 'confirm', previewDigest: first.previewDigest }),
      )
    );
    return { answer, applied };
  };

  it('refuses a removal that would change anything but the places it names', async () => {
    const places = [{ place: 'setting_llmApiKey', stops: ['ai'] }];
    const keys = { target: 'saved-keys', creates: 0, updates: 0, deletes: 1 };
    const cases = {
      'a note too': { changes: [keys, { target: 'canvases', creates: 0, updates: 0, deletes: 1 }], places },
      'a setting row': { changes: [{ target: 'settings', creates: 0, updates: 0, deletes: 1 }], places },
      'more than it lists': { changes: [{ ...keys, deletes: 2 }], places },
      'an update': { changes: [{ ...keys, updates: 1 }], places },
    };
    for (const [label, preview] of Object.entries(cases)) {
      const { answer, applied } = await secretRemoval({
        async preview() {
          return { preview, plan: ['setting_llmApiKey'] };
        },
        destroys: (/** @type {unknown} */ _context, /** @type {string[]} */ plan) => plan,
      });
      assert.equal(answer.state, 'failed', label);
      assert.equal(answer.outcome, 'changes-user-records', label);
      assert.equal(applied, false, label);
    }
  });

  it('refuses a removal whose destroys step is missing, or names other places than its preview', async () => {
    const preview = {
      changes: [{ target: 'saved-keys', creates: 0, updates: 0, deletes: 1 }],
      places: [{ place: 'setting_llmApiKey', stops: ['ai'] }],
    };
    const none = await secretRemoval({
      async preview() {
        return { preview, plan: ['setting_llmApiKey'] };
      },
    });
    assert.equal(none.answer.outcome, 'destroys-unnamed');
    assert.equal(none.applied, false);
    const other = await secretRemoval({
      async preview() {
        return { preview, plan: ['setting_llmApiKey'] };
      },
      destroys: () => ['settings'],
    });
    assert.equal(other.answer.outcome, 'changes-user-records');
    assert.equal(other.applied, false);
  });

  it('the remover takes out only the listed entries: the AI key, the WebDAV password and the 1.1 leftover row', async () => {
    const of = freshProfile();
    await legacyEnv.createDatabase(of.real, {
      records: {
        settings: [
          { key: 'llmApiKey', value: 'synthetic-key-1' },
          { key: 'theme', value: 'dark' },
        ],
        canvases: [{ id: 'n1', name: 'kept', updatedAt: 1 }],
      },
    });
    of.chrome.local.setting_llmApiKey = 'synthetic-key-2';
    of.chrome.local.setting_llmProvider = 'openai';
    of.chrome.local.setting_syncWebdavConfig = {
      serverUrl: 'https://dav.example.test/files',
      username: 'synthetic-user',
      password: 'synthetic-pass',
    };
    const remover = createLegacySecretRemover({ indexedDB: of.faults.factory, settings: of.chrome.api.storage.local });
    await remover.remove(['setting_llmApiKey']);
    assert.equal('setting_llmApiKey' in of.chrome.local, false);
    assert.equal(of.chrome.local.setting_llmProvider, 'openai');
    await remover.remove(['setting_syncWebdavConfig', 'settings']);
    assert.deepEqual(of.chrome.local.setting_syncWebdavConfig, {
      serverUrl: 'https://dav.example.test/files',
      username: 'synthetic-user',
    });
    const dump = await legacyEnv.dumpDatabase(of.real);
    assert.deepEqual(Object.keys(legacyEnv.recordsOf(dump, 'settings')), ['theme']);
    assert.deepEqual(Object.keys(legacyEnv.recordsOf(dump, 'canvases')), ['n1']);
    assert.deepEqual([...(await remover.present())], []);
    await assert.rejects(remover.remove(/** @type {any} */ (['setting_llmProvider'])), { code: 'not-applicable' });
    assert.equal(of.chrome.local.setting_llmProvider, 'openai');
  });
});

// ============ 4. The irreversible gate by rows ============

const COPY = 'recovery_backup_1793413294676';
const POINT = 'pre-repair-1793413294000';
const empty = { status: 'read', copies: [] };
const noPoints = { status: 'missing', points: [] };
const db = {
  status: 'open',
  stores: [
    { store: 'canvases', values: [{ id: 'n1' }] },
    { store: 'elements', values: [] },
  ],
};
/** @param {unknown[]} stores */
const point = stores => ({
  status: 'read',
  points: [{ id: POINT, kind: 'pre-repair', status: 'verified', verified: true, createdAt: 1, verifiedAt: 2, stores }],
});
/** A profile read with one note */
const profileRead = () => ({ database: db, legacyCopies: empty, recoveryPoints: noPoints });

describe('the irreversible gate holds the rows of what it destroys (#20 slice 4a, item 4)', () => {
  /**
   * Runs an irreversible remediation that destroys `subject` over `read`, to its end
   * @param {unknown} read
   * @param {{destroys?: () => string | null}} steps
   */
  const run = async (read, steps) => {
    let applied = false;
    const contribution = {
      ...REMEDIATIONS.find(item => item.id === 'rebuild-index'),
      class: 'irreversible',
      implementation: {
        phrase: 'delete it',
        ...steps,
        async preview() {
          return { preview: { changes: [{ target: 'canvases', creates: 0, updates: 0, deletes: 1 }] }, plan: null };
        },
        async apply() {
          applied = true;
          return null;
        },
        async verify() {
          return { ok: true };
        },
      },
    };
    const salvage = { collect: async () => read, restorePoint: async () => null, has: async () => false };
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ ([contribution]),
      ports: { salvage: /** @type {any} */ (salvage), files: memoryFiles() },
    });
    const first = /** @type {any} */ (await pipeline.run(runOf('rebuild-index')));
    if (first.state !== 'awaiting-confirmation') return { answer: first, applied };
    const answer = /** @type {any} */ (
      await pipeline.run(
        runOf('rebuild-index', {
          runId: first.runId,
          decision: 'confirm',
          previewDigest: first.previewDigest,
          typedPhrase: 'delete it',
        }),
      )
    );
    return { answer, applied };
  };
  /** @param {string | null} subject */
  const destroying = subject => ({ destroys: () => subject });

  const HELD = {
    'a legacy copy the file kept a row of': [
      {
        database: db,
        legacyCopies: { status: 'read', copies: [{ key: COPY, value: { canvases: [{ id: 'c1' }], elements: [] } }] },
        recoveryPoints: noPoints,
      },
      COPY,
    ],
    'a point whose rows the file holds': [
      { database: db, legacyCopies: empty, recoveryPoints: point([{ store: 'canvases', values: [{ id: 'p1' }] }]) },
      POINT,
    ],
    'a record in the current lists': [profileRead(), 'n1'],
  };
  const NOT_HELD = {
    "a legacy copy whose rows are in a field the file doesn't know": [
      {
        database: db,
        legacyCopies: {
          status: 'read',
          copies: [{ key: COPY, value: { recoveryBackup: true, data: { canvases: [{ id: 'c1' }] } } }],
        },
        recoveryPoints: noPoints,
      },
      COPY,
    ],
    'a legacy copy holding only settings': [
      {
        database: db,
        legacyCopies: {
          status: 'read',
          copies: [{ key: COPY, value: { recoveryBackup: true, settings: [{ key: 'theme', value: 'dark' }] } }],
        },
        recoveryPoints: noPoints,
      },
      COPY,
    ],
    'a legacy copy holding a row and a store the file leaves out': [
      {
        database: db,
        legacyCopies: {
          status: 'read',
          copies: [{ key: COPY, value: { canvases: [{ id: 'c1' }], extraStore: [{ id: 'x' }] } }],
        },
        recoveryPoints: noPoints,
      },
      COPY,
    ],
    'a legacy copy that is not there': [profileRead(), COPY],
    'a point whose stores did not read': [
      {
        database: db,
        legacyCopies: empty,
        recoveryPoints: point([
          { store: 'canvases', values: [], errorCode: 'unreadable' },
          { store: 'elements', values: [{ id: 'b1' }] },
        ]),
      },
      POINT,
    ],
    'a point holding only bookkeeping': [
      {
        database: db,
        legacyCopies: empty,
        recoveryPoints: point([
          { store: 'canvases', values: [] },
          { store: 'meta', values: [{ key: 'x', value: 1 }] },
        ]),
      },
      POINT,
    ],
    'a record only in an old point': [
      {
        database: { status: 'open', stores: [{ store: 'canvases', values: [{ id: 'n2' }] }] },
        legacyCopies: empty,
        recoveryPoints: point([{ store: 'canvases', values: [{ id: 'n1', name: 'old' }] }]),
      },
      'n1',
    ],
    'a record that is not there': [profileRead(), 'zzz'],
  };

  for (const [label, [read, subject]] of Object.entries(HELD)) {
    it(`applies when the file holds it: ${label}`, async () => {
      const { answer, applied } = await run(read, destroying(/** @type {string} */ (subject)));
      assert.equal(answer.state, 'succeeded', JSON.stringify(answer));
      assert.equal(applied, true);
    });
  }
  for (const [label, [read, subject]] of Object.entries(NOT_HELD)) {
    it(`changes nothing when the file doesn't hold it: ${label}`, async () => {
      const { answer, applied } = await run(read, destroying(/** @type {string} */ (subject)));
      assert.equal(answer.state, 'failed', JSON.stringify(answer));
      assert.equal(answer.outcome, 'salvage-incomplete');
      assert.equal(applied, false);
    });
  }
  it("refuses to run without a destroys step, or one that names nothing, before anything's saved", async () => {
    for (const steps of [{}, destroying(null)]) {
      const { answer, applied } = await run(profileRead(), steps);
      assert.equal(answer.state, 'failed', JSON.stringify(answer));
      assert.equal(answer.outcome, 'destroys-unnamed');
      assert.equal(applied, false);
    }
  });
});

// ============ 5. Answers the views need ============

describe('what a run answers for the views (#20 slice 4a, item 5)', () => {
  it('a saved file says how much it saved', async () => {
    const files = memoryFiles();
    const read = {
      database: {
        status: 'open',
        stores: [
          { store: 'canvases', values: [{ id: 'n1' }, { id: 'n2', trashed: true }] },
          {
            store: 'elements',
            values: [
              { id: 'b1', canvasId: 'n1' },
              { id: 'b2', canvasId: 'n1' },
              { id: 'b3', canvasId: 'n2' },
            ],
          },
        ],
      },
      legacyCopies: { status: 'read', copies: [{ key: COPY, value: { canvases: [{ id: 'c1' }] } }] },
      recoveryPoints: noPoints,
    };
    const salvage = { collect: async () => read, restorePoint: async () => null, has: async () => false };
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { salvage: /** @type {any} */ (salvage), files },
    });
    const done = /** @type {any} */ (await pipeline.run(runOf('save-salvage-file')));
    assert.ok(v.safeParse(runResult, done).success, JSON.stringify(done));
    assert.equal(done.state, 'succeeded');
    const text = [...files.files.values()][0];
    assert.deepEqual(done.saved, {
      notes: 2,
      blocks: 3,
      media: 0,
      folders: 0,
      legacyCopies: 1,
      recoveryPoints: 0,
      characters: text.length,
    });
  });

  it('export-diagnostics saves the report through the picker and reads it back', async () => {
    const files = memoryFiles();
    const serialized = JSON.stringify({ format: 'newtabnote-diagnostics', formatVersion: 1 }, null, 2);
    const diagnostics = async () => ({
      kind: 'diagnostics',
      filename: 'newtabnote-diagnostics-2026-10-20.json',
      bytes: serialized.length,
      fields: [],
      serialized,
      notices: [],
    });
    const { pipeline } = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { files, diagnostics },
    });
    const done = /** @type {any} */ (await pipeline.run(runOf('export-diagnostics')));
    assert.ok(v.safeParse(runResult, done).success, JSON.stringify(done));
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    assert.equal(done.class, 'non-destructive');
    assert.equal([...files.files.values()][0], serialized);
    assert.equal(files.lastName, 'newtabnote-diagnostics-2026-10-20.json');
    assert.equal(done.saved.characters, serialized.length);

    // A file that reads back different isn't saved
    files.alter = text => `${text} `;
    const short = /** @type {any} */ (await pipeline.run(runOf('export-diagnostics')));
    assert.equal(short.state, 'failed');
    assert.equal(short.outcome, 'file-mismatch');
    assert.equal(short.fileMayBeEmpty, true);
    // A closed picker saves nothing, and isn't a failure
    files.cancel = true;
    const closed = /** @type {any} */ (await pipeline.run(runOf('export-diagnostics')));
    assert.equal(closed.state, 'cancelled');
    // A report that won't build fails after the pick
    const broken = await remediationCenter({
      contributions: /** @type {any} */ (REMEDIATIONS),
      ports: { files: memoryFiles(), diagnostics: async () => unavailable('storage', 'not-open', true) },
    });
    const failed = /** @type {any} */ (await broken.pipeline.run(runOf('export-diagnostics')));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.outcome, 'build-failed');
  });
});

// ============ 6. A time and a cause per group ============

describe('trust.summary names each group’s time and cause (#20 slice 4a, item 6)', () => {
  it('a database that will not open reads apart from capture at risk', async () => {
    const answers = /** @type {Record<string, any>} */ (allPassing());
    answers.storage = {
      status: 'failed',
      capture: 'at-risk',
      evidence: { errorCode: 'open-failed' },
      faults: [{ faultCode: 'open-failed', subjectId: 'CanvasTabDB', severity: 'capture-risk' }],
    };
    const { trust, clock } = await center(answers);
    const started = clock.now();
    await trust.verify(verifyNow(['capture', 'storage', 'index']));
    const summary = dataOf(await trust.summary());
    assert.ok(v.safeParse(summarySchema, summary).success);
    const group = summary.groups.find((/** @type {any} */ item) => item.group === 'storage');
    assert.equal(group.checkedAt, started);
    assert.deepEqual(
      { ...group.cause, incidentId: null },
      {
        from: 'incident',
        providerId: 'storage',
        faultCode: 'open-failed',
        errorCode: null,
        severity: 'capture-risk',
        consequenceKey: null,
        incidentId: null,
        at: started,
      },
    );
    const indexing = summary.groups.find((/** @type {any} */ item) => item.group === 'indexing');
    assert.equal(indexing.cause, null);
    assert.equal(indexing.checkedAt, started);
    const backup = summary.groups.find((/** @type {any} */ item) => item.group === 'backup');
    assert.equal(backup.checkedAt, null);

    // Quota is capture at risk with another cause
    answers.storage = {
      status: 'action-required',
      capture: 'at-risk',
      consequenceKey: 'storage.quota',
      faults: [{ faultCode: 'quota', subjectId: 'CanvasTabDB', severity: 'capture-risk' }],
      looked: [{ faultCode: 'open-failed' }],
    };
    clock.advance(1000);
    await trust.verify(verifyNow(['storage']));
    const later = dataOf(await trust.summary()).groups.find((/** @type {any} */ item) => item.group === 'storage');
    assert.equal(later.cause.faultCode, 'quota');
    assert.equal(later.checkedAt, started + 1000);
  });

  it('a group at fault with no incident names its receipt', async () => {
    const answers = /** @type {Record<string, any>} */ (allPassing());
    answers.backup = {
      status: 'degraded',
      consequenceKey: 'backup.not-verified',
      evidence: { errorCode: 'timed-out' },
    };
    const { trust, clock } = await center(answers);
    await trust.verify(verifyNow(['backup']));
    const group = dataOf(await trust.summary()).groups.find((/** @type {any} */ item) => item.group === 'backup');
    assert.deepEqual(group.cause, {
      from: 'receipt',
      providerId: 'backup',
      faultCode: null,
      errorCode: 'timed-out',
      severity: null,
      consequenceKey: 'backup.not-verified',
      incidentId: null,
      at: clock.now(),
    });
  });
});

// ============ 7. One next-action picker ============

describe('one next-action picker for every status (#20 slice 4a, item 7)', () => {
  /** @param {Partial<import('../../js/trust/core/records.js').HealthReceipt>} receipt */
  const receiptOf = receipt =>
    /** @type {any} */ ({
      providerId: 'index',
      status: 'verified',
      verifiedAt: 1,
      freshnessMs: DAY,
      evidence: {},
      nextAction: null,
      ...receipt,
    });

  it('answers within its schema for every status, with and without a receipt', () => {
    for (const status of PROVIDER_STATUSES) {
      for (const receipt of [
        null,
        receiptOf({ status: /** @type {any} */ (status === 'stale' ? 'verified' : status) }),
      ]) {
        const next = nextActionOf({
          providerId: 'index',
          core: false,
          status,
          receipt,
          incidents: [],
          captureAtRisk: false,
        });
        assert.ok(next === null || v.is(nextActionSchema, next), `${status}: ${JSON.stringify(next)}`);
      }
    }
  });

  it('picks the repair for the incident, the receipt’s own next action, a check, or the Recovery Center', () => {
    const lagging = /** @type {any} */ ({
      id: 'a1b20001-0000-4000-8000-000000000000',
      providerId: 'index',
      faultCode: 'lagging',
      severity: 'degraded',
      lastSeenAt: 1,
    });
    assert.deepEqual(
      nextActionOf({
        providerId: 'index',
        core: false,
        status: 'degraded',
        receipt: receiptOf({ status: 'degraded' }),
        incidents: [lagging],
        captureAtRisk: false,
      }),
      { kind: 'remediation', remediationId: 'rebuild-index', incidentId: lagging.id },
    );
    assert.deepEqual(
      nextActionOf({
        providerId: 'credentials',
        core: false,
        status: 'action-required',
        receipt: receiptOf({ providerId: 'credentials', status: 'action-required', nextAction: 'remove-saved-key' }),
        incidents: [],
        captureAtRisk: false,
      }),
      { kind: 'remediation', remediationId: 'remove-saved-key', incidentId: null },
    );
    assert.deepEqual(
      nextActionOf({
        providerId: 'index',
        core: false,
        status: 'stale',
        receipt: receiptOf({}),
        incidents: [],
        captureAtRisk: false,
      }),
      {
        kind: 'check',
        providerId: 'index',
      },
    );
    assert.deepEqual(
      nextActionOf({
        providerId: 'index',
        core: false,
        status: 'unverified',
        receipt: receiptOf({ status: 'unverified', evidence: { errorCode: 'check-timed-out' } }),
        incidents: [],
        captureAtRisk: false,
      }),
      { kind: 'check', providerId: 'index' },
    );
    const quota = { ...lagging, providerId: 'storage', faultCode: 'quota', severity: 'capture-risk' };
    assert.deepEqual(
      nextActionOf({
        providerId: 'storage',
        core: true,
        status: 'action-required',
        receipt: receiptOf({ providerId: 'storage', status: 'action-required' }),
        incidents: [quota],
        captureAtRisk: true,
      }),
      { kind: 'recovery-center', incidentId: quota.id },
    );
    const missing = { ...lagging, providerId: 'permissions', faultCode: 'grant-missing', severity: 'data-risk' };
    assert.deepEqual(
      nextActionOf({
        providerId: 'permissions',
        core: false,
        status: 'failed',
        receipt: receiptOf({ providerId: 'permissions', status: 'failed' }),
        incidents: [missing],
        captureAtRisk: false,
      }),
      { kind: 'site-access' },
    );
    assert.equal(
      nextActionOf({
        providerId: 'index',
        core: false,
        status: 'verified',
        receipt: receiptOf({}),
        incidents: [],
        captureAtRisk: false,
      }),
      null,
    );
  });

  it('trust.report and recovery.incidents carry it, so no view picks its own', async () => {
    const answers = /** @type {Record<string, any>} */ (allPassing());
    answers.index = {
      status: 'degraded',
      faults: [{ faultCode: 'lagging', severity: 'degraded' }],
      looked: [{ faultCode: 'lagging' }],
    };
    const { trust, records } = await center(answers);
    await trust.verify(verifyNow(['index', 'storage']));
    const report = checked('trust.report', await trust.report()).data;
    const [incident] = await records.incidents();
    assert.deepEqual(report.providers.find((/** @type {any} */ row) => row.providerId === 'index').next, {
      kind: 'remediation',
      remediationId: 'rebuild-index',
      incidentId: incident.id,
    });
    assert.equal(report.providers.find((/** @type {any} */ row) => row.providerId === 'storage').next, null);
    assert.deepEqual(report.providers.find((/** @type {any} */ row) => row.providerId === 'capture').next, {
      kind: 'check',
      providerId: 'capture',
    });
    const listed = checked('recovery.incidents', await trust.incidents({})).data;
    assert.deepEqual(listed.next, [
      {
        incidentId: incident.id,
        next: { kind: 'remediation', remediationId: 'rebuild-index', incidentId: incident.id },
      },
    ]);
  });
});

// ============ 8. One preserved list ============

describe('one preserved list (#20 slice 4a, item 8)', () => {
  it("Credentials' receipt and its faults say the same still works", async () => {
    const result = await credentials.check({ secrets: { present: async () => ['setting_llmApiKey', 'settings'] } });
    assert.ok(result.faults && result.faults.length === 2);
    for (const fault of result.faults) assert.deepEqual(fault.preserved, result.preserved);
  });

  /**
   * An adapter whose commits answer `outcome`, and whose reads work or don't
   * @param {any} outcome
   * @param {boolean} reads
   */
  const adapterThat = (outcome, reads) => ({
    readSettings: async () => ({}),
    commit: async () => ({ outcome, replayed: false }),
    read: async (/** @type {unknown} */ _stores, /** @type {(tx: any) => Promise<unknown>} */ body) => {
      if (!reads) throw Object.assign(new Error('closed'), { name: 'UnavailableError', code: 'not-open' });
      return body({ get: async () => undefined, getAll: async () => [] });
    },
  });

  it('every capture-risk fault says whether reading still works, from a read it tried', async () => {
    const cases = [
      ['quota', true],
      ['quota', false],
      ['version-too-new', false],
      ['open-failed', false],
      ['transaction-failed', true],
    ];
    for (const [code, reads] of cases) {
      for (const check of [capture, storage]) {
        const result = await check.check({
          storage: adapterThat(
            unavailable('storage', /** @type {string} */ (code), false),
            /** @type {boolean} */ (reads),
          ),
        });
        const label = `${check === capture ? 'capture' : 'storage'} ${code}, reads ${reads}`;
        for (const fault of result.faults || []) {
          assert.equal(fault.severity, 'capture-risk', label);
          const affected = (fault.affected || []).includes('reading');
          const preserved = (fault.preserved || []).includes('reading');
          assert.equal(preserved, reads, label);
          assert.equal(affected, !reads, label);
        }
        assert.deepEqual(result.preserved || [], (result.faults || [])[0]?.preserved || [], label);
      }
    }
  });

  it("a database the worker couldn't open says reading doesn't work either", () => {
    const incident = /** @type {any} */ (EVENT_CODES['storage.open-failed'].incident);
    assert.ok(incident.affected.includes('reading'));
    assert.ok(!incident.preserved.includes('reading'));
  });
});

// ============ 9. Repair recovery points in the copies list ============

describe('the copies list (#20 slice 4a, item 9)', () => {
  it('lists repair recovery points beside the pre-migration point and the legacy copies, each with Save as file', async () => {
    const points = [
      {
        id: 'pre-migration-1760000000000',
        kind: 'pre-migration',
        status: 'verified',
        createdAt: 1760000000000,
        verifiedAt: 1760000000500,
      },
      {
        id: 'pre-repair-1760000100000',
        kind: 'pre-repair',
        status: 'verified',
        createdAt: 1760000100000,
        verifiedAt: 1760000100400,
      },
      {
        id: 'pre-repair-1760000200000',
        kind: 'pre-repair',
        status: 'partial',
        createdAt: 1760000200000,
        verifiedAt: null,
      },
    ];
    const settings = settingsArea();
    const context = {
      recovery: { points: async () => points, verify: async () => ({ ok: true }) },
      settings: {
        ...settings,
        getKeys: async () => ['setting_theme', 'auto_backup_1759000000000', 'recovery_backup_1759500000000'],
      },
    };
    const { trust, records } = await center(allPassing(), { context });
    const runId = 'a1b2eeee-0000-4000-8000-000000000000';
    await records.putRun({
      id: runId,
      commandId: 'recover-orphans',
      incidentId: null,
      state: 'succeeded',
      step: 'record',
      recoveryPointId: 'pre-repair-1760000100000',
      outcome: 'verified',
      startedAt: 1760000099000,
      updatedAt: 1760000101000,
    });
    const listed = checked('recovery.copies', await trust.copies()).data;
    assert.equal(listed.pointsRead, true);
    assert.equal(listed.copiesRead, true);
    assert.deepEqual(listed.copies, [
      {
        id: 'pre-repair-1760000200000',
        kind: 'recovery-point',
        pointKind: 'pre-repair',
        at: 1760000200000,
        verified: false,
        madeBy: null,
        actions: [],
      },
      {
        id: 'pre-repair-1760000100000',
        kind: 'recovery-point',
        pointKind: 'pre-repair',
        at: 1760000100000,
        verified: true,
        madeBy: { runId, remediationId: 'recover-orphans' },
        actions: ['save-recovery-file'],
      },
      {
        id: 'pre-migration-1760000000000',
        kind: 'recovery-point',
        pointKind: 'pre-migration',
        at: 1760000000000,
        verified: true,
        madeBy: null,
        actions: ['save-recovery-file'],
      },
      {
        id: 'recovery_backup_1759500000000',
        kind: 'legacy-copy',
        pointKind: null,
        at: 1759500000000,
        verified: false,
        madeBy: null,
        actions: ['save-recovery-file'],
      },
      {
        id: 'auto_backup_1759000000000',
        kind: 'legacy-copy',
        pointKind: null,
        at: 1759000000000,
        verified: false,
        madeBy: null,
        actions: ['save-recovery-file'],
      },
    ]);
  });

  it("says what it couldn't read, and never answers an empty list for a read that failed", async () => {
    const context = {
      recovery: {
        points: async () => {
          throw new TypeError('gone');
        },
      },
    };
    const { trust } = await center(allPassing(), { context });
    const listed = checked('recovery.copies', await trust.copies()).data;
    assert.deepEqual(listed, { copies: [], pointsRead: false, copiesRead: false });
  });
});
