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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from '../../js/lib/valibot/index.mjs';

import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { PROVIDER_IDS } from '../../js/trust/core/codes.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { summarySchema } from '../../js/trust/core/operations/trust-summary.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { HEALTH_GROUPS } from '../../js/trust/core/vocabulary.js';
import { importGraph } from './import-graph.mjs';
import { hexIds, lockManager, manualClock, realTimers, settingsArea } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/operations/trust-summary.js').TrustSummary} TrustSummary */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

  it('a group with a waiting update and another problem still needs action for the other, which is its cause, with its own code', async () => {
    for (const state of [{}, { blocked: true }]) {
      const { trust, records, clock } = await center(state);
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
      const update = state.blocked ? 'storage/migration-blocked' : 'storage/migration-pending';
      assert.deepEqual((await openFaults(records)).sort(), [update, 'storage/scan-findings']);
      const group = storageGroup(await summaryOf(trust));
      // The update's code (blocked-upgrade) is the update's own: the other problem's evidence has none
      assert.deepEqual(
        [group.needsAction, group.cause && group.cause.faultCode, group.cause && group.cause.errorCode],
        [1, 'scan-findings', null],
        JSON.stringify(state),
      );
    }
  });

  it("an update that didn't finish beside a later problem: the later one is the cause, with none of the update's code", async () => {
    const { trust, records, clock } = await center({ status: 'failed', code: 'schema-mismatch' });
    await checkOnOpen(trust);
    clock.advance(MINUTE);
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
    assert.deepEqual((await openFaults(records)).sort(), ['storage/migration-failed', 'storage/scan-findings']);
    const group = storageGroup(await summaryOf(trust));
    assert.deepEqual(
      [group.needsAction, group.cause && group.cause.faultCode, group.cause && group.cause.errorCode],
      [2, 'scan-findings', null],
    );
  });

  it('a group whose only problem is an update that waits has no cause', async () => {
    for (const state of [{}, { blocked: true }]) {
      const { trust, records } = await center(state);
      await checkOnOpen(trust);
      assert.equal((await openFaults(records)).length, 1, JSON.stringify(state));
      const group = storageGroup(await summaryOf(trust));
      assert.deepEqual([group.needsAction, group.cause], [0, null], JSON.stringify(state));
    }
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

describe("summarize: trust.summary from what the records read and the providers' rows (#20 slice 4c)", () => {
  /**
   * What summarize takes, as the records read it now
   * @param {Awaited<ReturnType<typeof center>>} at
   * @param {readonly {id: string, group: string, core: boolean}[]} providers
   */
  const inputOf = async ({ records, clock }, providers) => {
    const read = await records.incidentsRead();
    return {
      providers,
      receipts: await records.latestReceipts(),
      incidents: read.incidents,
      copyRead: read.copyRead,
      recordsRead: read.recordsRead,
      recordsState: records.state(),
      now: clock.now(),
    };
  };

  it("answers what trust.summary answers, from the providers' rows alone, with no registry", async () => {
    const { summarize } = await import('../../js/trust/core/summary.js');
    const { PROVIDER_ROWS } = await import('../../js/trust/core/providers/rows.js');
    const rows = PROVIDER_ROWS.filter(row => row.id === 'capture' || row.id === 'storage');
    for (const state of [null, { blocked: true }, { status: 'space-blocked', code: 'space-short' }]) {
      const at = await center(state);
      await checkOnOpen(at.trust);
      assert.deepEqual(summarize(await inputOf(at, rows)), await summaryOf(at.trust), JSON.stringify(state));
    }
  });

  it('reads capture as unknown, routes to the Recovery Center, and counts something as needing action while a read failed or the records fell back', async () => {
    const { summarize } = await import('../../js/trust/core/summary.js');
    const { PROVIDER_ROWS } = await import('../../js/trust/core/providers/rows.js');
    const rows = PROVIDER_ROWS.filter(row => row.id === 'capture' || row.id === 'storage');
    const at = await center(null);
    await checkOnOpen(at.trust);
    const input = await inputOf(at, rows);
    const seen = summarize(input);
    assert.deepEqual([seen.capture, seen.actionRequired, seen.route], ['safe', 0, 'trust']);
    for (const blind of [
      { copyRead: false },
      { recordsRead: false },
      { recordsState: /** @type {const} */ ('fallback') },
    ]) {
      const summary = summarize({ ...input, ...blind });
      assert.deepEqual(
        [summary.capture, summary.actionRequired, summary.route],
        ['unknown', 1, 'recovery'],
        JSON.stringify(blind),
      );
    }
  });

  it('never carries an unregistered code in a cause, from an incident or a receipt', async () => {
    const { summarize } = await import('../../js/trust/core/summary.js');
    const { PROVIDER_ROWS } = await import('../../js/trust/core/providers/rows.js');
    const at = await center({ status: 'failed', code: 'schema-mismatch' });
    await checkOnOpen(at.trust);
    const input = await inputOf(
      at,
      PROVIDER_ROWS.filter(row => row.id === 'capture' || row.id === 'storage'),
    );
    /** @param {any} held */
    const unregistered = held =>
      held.providerId === 'storage' ? { ...held, evidence: { ...held.evidence, errorCode: 'not-a-code' } } : held;
    const incidentCause = storageGroup(
      summarize({ ...input, receipts: input.receipts.map(unregistered), incidents: input.incidents.map(unregistered) }),
    ).cause;
    assert.deepEqual(incidentCause && [incidentCause.from, incidentCause.errorCode], ['incident', null]);
    // A group at fault with no incident names its receipt
    const now = at.clock.now();
    const lagging = {
      id: 'r1',
      providerId: 'index',
      status: 'degraded',
      verifiedAt: now,
      freshnessMs: MINUTE,
      consequenceKey: 'indexing.lagging',
      evidence: { errorCode: 'not-a-code' },
    };
    const receiptCause = summarize({
      providers: [{ id: 'index', group: 'indexing', core: false }],
      receipts: /** @type {any} */ ([lagging]),
      incidents: [],
      copyRead: true,
      recordsRead: true,
      recordsState: 'open',
      now,
    }).groups[0].cause;
    assert.deepEqual(receiptCause && [receiptCause.from, receiptCause.consequenceKey, receiptCause.errorCode], [
      'receipt',
      'indexing.lagging',
      null,
    ]);
  });

  it("counts an incident whose fault code or severity this build doesn't register, but never makes it the cause", async () => {
    const { summarize } = await import('../../js/trust/core/summary.js');
    const now = 1_800_000_000_000;
    /**
     * An open storage incident, as a newer build could have written it
     * @param {string} id
     * @param {string} faultCode
     * @param {string} severity
     * @param {number} lastSeenAt
     */
    const incident = (id, faultCode, severity, lastSeenAt) => ({
      id,
      providerId: 'storage',
      faultCode,
      subjectId: 'CanvasTabDB',
      severity,
      state: 'open',
      dismissed: false,
      firstSeenAt: lastSeenAt,
      lastSeenAt,
      occurrences: 1,
      evidence: {},
      affected: [],
      preserved: [],
    });
    /** @param {any[]} incidents */
    const storageOf = incidents =>
      summarize({
        providers: [{ id: 'storage', group: 'storage', core: true }],
        receipts: [],
        incidents: /** @type {any} */ (incidents),
        copyRead: true,
        recordsRead: true,
        recordsState: 'open',
        now,
      }).groups[0];
    const known = incident('known', 'scan-findings', 'degraded', now - 2000);
    // Seen later, so it would be the worst; and a severity no list has, which sorts first
    for (const unknown of [
      incident('new-fault', 'not-a-fault', 'degraded', now - 1000),
      incident('new-severity', 'scan-findings', 'not-a-severity', now - 3000),
    ]) {
      const group = storageOf([known, unknown]);
      assert.deepEqual([group.needsAction, group.cause && group.cause.incidentId], [2, 'known'], unknown.id);
      const alone = storageOf([unknown]);
      assert.deepEqual([alone.needsAction, alone.cause], [1, null], unknown.id);
    }
  });

  it('reaches only the vocabulary, the codes and the update rule, so a status page loads no registry, checks module, Valibot or payload schema with it', async () => {
    const reached = [...importGraph(path.join(ROOT, 'js', 'trust', 'core', 'summary.js'))].map(file =>
      path.relative(ROOT, file).split(path.sep).join('/'),
    );
    assert.deepEqual(reached.sort(), [
      'js/trust/core/codes.js',
      'js/trust/core/summary.js',
      'js/trust/core/updates.js',
      'js/trust/core/vocabulary.js',
    ]);
    const rows = [...importGraph(path.join(ROOT, 'js', 'trust', 'core', 'providers', 'rows.js'))];
    assert.equal(rows.length, 1, 'rows.js imports nothing');
  });
});

describe("the providers' rows (#20 slice 4c)", () => {
  it('rowsOn(host) gives the rows of the providers that run on a host, so summarize answers what a root on recovery.html answers over the whole catalog', async () => {
    const { summarize } = await import('../../js/trust/core/summary.js');
    const { PROVIDER_ROWS, rowsOn } = await import('../../js/trust/core/providers/rows.js');
    const clock = manualClock();
    const records = createTrustRecords({
      store: createMemoryTrustStore(),
      settings: settingsArea(),
      clock,
      ids: hexIds(),
      locks: lockManager(),
    });
    await records.open();
    // recovery.html's root registers the whole catalog, on its own host
    const root = createRegistryRoot({ host: 'recovery' });
    root.register(health, PROVIDERS);
    const resolution = root.resolve();
    const runtime = createRuntime(resolution);
    await runtime.probe();
    const trust = createTrustUseCases({
      records,
      journal: createDiagnosticJournal({ records, clock, strict: true }),
      clock,
      timers: realTimers,
      locks: lockManager(),
      registry: { resolution, runtime, context: {} },
      versions: { extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 },
    });
    // A problem of a provider that runs only on the new tab: it counts, in no group
    const raised = /** @type {any} */ (
      await trust.raise({
        type: 'recovery.raise',
        commandId: 'c0',
        providerId: 'coordinator',
        faultCode: 'start-failed',
        severity: 'degraded',
      })
    );
    assert.equal(raised.kind, 'committed', JSON.stringify(raised));
    const read = await records.incidentsRead();
    const summary = await summaryOf(trust);
    assert.deepEqual(
      summarize({
        providers: rowsOn('recovery'),
        receipts: await records.latestReceipts(),
        incidents: read.incidents,
        copyRead: read.copyRead,
        recordsRead: read.recordsRead,
        recordsState: records.state(),
        now: clock.now(),
      }),
      summary,
    );
    const platform = summary.groups.find(group => group.group === 'platform');
    assert.deepEqual(
      [platform && platform.providers, PROVIDER_ROWS.filter(row => row.group === 'platform').length],
      [3, 4],
      'the coordinator runs only on the new tab',
    );
    assert.deepEqual(
      rowsOn('workspace').map(row => row.id),
      PROVIDER_ROWS.map(row => row.id),
    );
  });

  it("are the catalog's id, group, core and hosts, one for one, in its order", async () => {
    const { PROVIDER_ROWS } = await import('../../js/trust/core/providers/rows.js');
    /** @param {{id: string, group: string, core?: boolean, hosts: readonly string[]}} item */
    const fields = item => [item.id, item.group, item.core === true, [...item.hosts]];
    const PAGES = ['workspace', 'recovery'];
    // The groups every status page names its problems by: a change here changes what they say
    assert.deepEqual(PROVIDER_ROWS.map(fields), [
      ['capture', 'storage', true, PAGES],
      ['storage', 'storage', true, PAGES],
      ['recovery-readiness', 'recovery', false, PAGES],
      ['backup', 'backup', false, PAGES],
      ['sync', 'sync', false, PAGES],
      ['credentials', 'vault', false, PAGES],
      ['permissions', 'permissions', false, PAGES],
      ['ai-scope-grants', 'permissions', false, PAGES],
      ['remote-ai', 'inference', false, PAGES],
      ['local-inference', 'inference', false, PAGES],
      ['index', 'indexing', false, PAGES],
      ['coordinator', 'platform', false, ['workspace']],
      ['messaging', 'platform', false, PAGES],
      ['contributions', 'platform', false, PAGES],
      ['block-types', 'platform', false, PAGES],
    ]);
    assert.deepEqual(PROVIDERS.map(fields), PROVIDER_ROWS.map(fields));
    for (const row of PROVIDER_ROWS) {
      assert.ok(PROVIDER_IDS.includes(row.id), `${row.id} is a registered provider`);
      assert.ok(HEALTH_GROUPS.includes(/** @type {any} */ (row.group)), `${row.id}'s group is a health group`);
    }
  });
});
