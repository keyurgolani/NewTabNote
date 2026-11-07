// #20 slice 4c, PR 1: one summary every page reads. trust.summary's answer comes from what the
// records read and each provider's static row (js/trust/core/summary.js and
// js/trust/core/providers/rows.js), with no registry, checks module or payload schema, so a page
// that only shows status can compute it beside the records. An update that's waiting needs
// action nowhere, by the one rule the Trust Center reads it by (js/trust/core/updates.js, the
// design review's change 9). And a group's cause says why an update waits or didn't finish, from
// storage's receipt, when the check's incident carries no code of its own.
//
// The two modules this PR adds load inside the cases that read them, so on a tree without them
// those cases fail on their own and the rest still run.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../../js/lib/valibot/index.mjs';

import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { summarySchema } from '../../js/trust/core/operations/trust-summary.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { hexIds, lockManager, manualClock, realTimers, settingsArea } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/operations/trust-summary.js').TrustSummary} TrustSummary */

const MINUTE = 60 * 1000;

/** Storage's migration reader at this build's version */
const AT_LATEST = Object.freeze({ current: async () => ({ version: 9, latest: 9, status: 'migrated', code: null }) });

/**
 * Storage's migration reader below this build's version, with the worker's last run as `state` says
 * @param {Record<string, unknown>} state
 */
const below = state => ({
  current: async () => ({ version: 8, latest: 11, status: null, code: null, blocked: false, ...state }),
});

/**
 * A repository adapter whose commits run each unit against a map, so the real capture and
 * storage probes commit, and whose reads answer
 */
function committingAdapter() {
  /** @type {Map<string, unknown>} */
  const held = new Map();
  /**
   * @param {string} store
   * @param {unknown} key
   */
  const at = (store, key) => JSON.stringify([store, key]);
  const tx = {
    get: async (/** @type {string} */ store, /** @type {unknown} */ key) => held.get(at(store, key)),
    put: (/** @type {string} */ store, /** @type {{id: unknown}} */ record) => {
      held.set(at(store, record.id), record);
    },
    delete: (/** @type {string} */ store, /** @type {unknown} */ key) => {
      held.delete(at(store, key));
    },
  };
  return {
    readSettings: async () => ({}),
    read: async (/** @type {string[]} */ _stores, /** @type {(transaction: typeof tx) => unknown} */ body) => body(tx),
    /** @param {any} work */
    commit: async work => {
      for (const unit of work.effect.units) {
        const refused = await unit.run(tx);
        if (refused) return { outcome: refused, replayed: false };
      }
      return { outcome: work.done(), replayed: false };
    },
  };
}

/** The two core providers as the catalog has them, whose real checks run against the context */
const CORE = PROVIDERS.filter(descriptor => descriptor.id === 'capture' || descriptor.id === 'storage');

/**
 * The use cases over the real capture and storage checks, with storage's migration state `state`
 * @param {Record<string, unknown> | null} state - null: at this build's version
 */
async function center(state) {
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
  root.register(health, CORE);
  const resolution = root.resolve();
  const runtime = createRuntime(resolution);
  await runtime.probe();
  const context = {
    storage: committingAdapter(),
    migration: state === null ? AT_LATEST : below(state),
    trust: records,
  };
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
 * trust.summary's answer, held to its schema
 * @param {Awaited<ReturnType<typeof center>>['trust']} trust
 * @returns {Promise<TrustSummary>}
 */
async function summaryOf(trust) {
  const answer = /** @type {any} */ (await trust.summary());
  assert.equal(answer.kind, 'ready', JSON.stringify(answer));
  assert.ok(v.is(summarySchema, answer.data), 'trust.summary holds only what its schema allows');
  return answer.data;
}

/**
 * The storage group's row in a summary
 * @param {TrustSummary} summary
 */
const storageGroup = summary => {
  const group = summary.groups.find(item => item.group === 'storage');
  assert.ok(group, 'the summary has a storage group');
  return group;
};

/**
 * The open incidents the records hold, as provider/fault
 * @param {Awaited<ReturnType<typeof center>>['records']} records
 */
const openFaults = async records =>
  (await records.incidentsRead()).incidents
    .filter(incident => incident.state !== 'resolved')
    .map(incident => `${incident.providerId}/${incident.faultCode}`);

/**
 * Runs the checks opening the Trust Center runs
 * @param {Awaited<ReturnType<typeof center>>['trust']} trust
 * @param {string} [commandId]
 */
const checkOnOpen = async (trust, commandId = 'c1') => {
  const outcome = /** @type {any} */ (await trust.verify({ type: 'trust.verify', commandId, trigger: 'open' }));
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
};

describe("an update that is waiting needs action nowhere, in trust.summary as in the Trust Center (#20 slice 4c, the design review's change 9)", () => {
  it('a blocked upgrade and a plain wait need no action, and a wait for free space and an update that did not finish do', async () => {
    for (const [state, faultCode, needs] of /** @type {const} */ ([
      [{ blocked: true }, 'migration-blocked', 0],
      [{}, 'migration-pending', 0],
      [{ status: 'space-blocked', code: 'space-short' }, 'migration-blocked', 1],
      [{ status: 'failed', code: 'schema-mismatch' }, 'migration-failed', 1],
    ])) {
      const { trust, records } = await center(state);
      await checkOnOpen(trust);
      // The update's incident is open either way: the summary leaves out only the one that waits
      assert.deepEqual(await openFaults(records), [`storage/${faultCode}`], JSON.stringify(state));
      const summary = await summaryOf(trust);
      assert.deepEqual(
        [storageGroup(summary).needsAction, summary.actionRequired, summary.capture, summary.route],
        [needs, needs, 'safe', 'trust'],
        JSON.stringify(state),
      );
    }
  });

  it('a group with a waiting update and another problem still needs action for the other, which is its cause', async () => {
    const { trust, records, clock } = await center({});
    // Another problem in the storage group, seen before the update's check
    const raised = /** @type {any} */ (
      await trust.raise({
        type: 'recovery.raise',
        commandId: 'c0',
        providerId: 'storage',
        faultCode: 'scan-findings',
        subjectId: 'CanvasTabDB',
        severity: 'degraded',
        evidence: { count: 3 },
      })
    );
    assert.equal(raised.kind, 'committed', JSON.stringify(raised));
    clock.advance(MINUTE);
    await checkOnOpen(trust);
    assert.deepEqual((await openFaults(records)).sort(), ['storage/migration-pending', 'storage/scan-findings']);
    const group = storageGroup(await summaryOf(trust));
    assert.deepEqual([group.needsAction, group.cause && group.cause.faultCode], [1, 'scan-findings']);
  });
});

describe("a group's cause says why an update waits or didn't finish, from storage's receipt (#20 slice 4c)", () => {
  it("names a wait for free space as space-short and an update that didn't finish by its run's code, though the check's incident carries none", async () => {
    for (const [state, faultCode, errorCode] of /** @type {const} */ ([
      [{ status: 'space-blocked', code: 'space-short' }, 'migration-blocked', 'space-short'],
      [{ status: 'failed', code: 'schema-mismatch' }, 'migration-failed', 'schema-mismatch'],
    ])) {
      const { trust } = await center(state);
      await checkOnOpen(trust);
      const { cause } = storageGroup(await summaryOf(trust));
      assert.deepEqual(
        cause && [cause.from, cause.providerId, cause.faultCode, cause.errorCode],
        ['incident', 'storage', faultCode, errorCode],
        JSON.stringify(state),
      );
    }
  });
});
