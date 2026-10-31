// recovery.html's surface (#20 slice 4b). #13's router policy accepts the trust operations
// only by recovery.html's rows (js/trust/core/router-rows.js): only from the `recovery`
// surface, and only what its Trust Center and Recovery Center call. The kernel lets it read
// its theme and nothing else, #15's `recovery` host resolves the trust families there, and its
// root (js/kernel/composition/recovery.js) serves the rows in the page through #13's router,
// over the in-process transport, so the worker serves none of them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { principalOf } from '../../js/kernel/adapters/messaging/runtime-port.js';
import { browserRecoveryHost, createRecoveryRoot } from '../../js/kernel/composition/recovery.js';
import { COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { createClient } from '../../js/kernel/core/messaging/client.js';
import { createInProcessTransport } from '../../js/kernel/core/messaging/in-process.js';
import { createLookup } from '../../js/kernel/core/messaging/operations.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { SURFACES, createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { HOSTS } from '../../js/kernel/registry/vocabulary.js';
import { REMEDIATION_IDS } from '../../js/trust/core/codes.js';
import { health, remediation } from '../../js/trust/core/families.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { countLegacyCopies } from '../../js/trust/core/providers/recovery-readiness.js';
import { REMEDIATIONS } from '../../js/trust/core/remediation/catalog.js';
import { RECOVERY_PAGE_REMEDIATIONS, RECOVERY_PAGE_ROWS } from '../../js/trust/core/router-rows.js';
import { TRUST_OPERATIONS } from '../../js/trust/core/trust-operations.js';
import { TRIGGERS } from '../../js/trust/core/vocabulary.js';
import { INCIDENT as TITLES, PAGE, PROVIDER, RESOLVED } from '../../js/trust/ui/copy.js';
import { PLATFORM } from '../../js/trust/ui/model.js';
import { EXTENSION_ID } from './chrome-fake.mjs';
import { KeyRange } from './migration-support.mjs';
import { adapterOn } from './storage-fixture.mjs';
import { CALLERS } from './support.mjs';
import { MANIFEST, freshProfile, grantedAsDeclared, settingsOf } from './trust-provider-support.mjs';
import { realTimers, webLocks } from './trust-support.mjs';

/** @typedef {import('../../js/kernel/core/contracts/surfaces.js').Surface} Surface */

const ID = '00000000-0000-4000-8000-0000000000a1';
const INCIDENT = '00000000-0000-4000-8000-0000000000b2';

/** The rows, in the order the body lists them, each with a request it accepts, as the views send it */
const REQUESTS = Object.freeze({
  'trust.summary': { type: 'trust.summary' },
  'trust.report': { type: 'trust.report' },
  'recovery.incidents': { type: 'recovery.incidents' },
  'trust.verify': { type: 'trust.verify', commandId: ID, trigger: 'open' },
  'recovery.check': { type: 'recovery.check', commandId: ID, incidentId: INCIDENT },
  'recovery.dismiss': { type: 'recovery.dismiss', commandId: ID, incidentId: INCIDENT, occurrences: 1 },
  'recovery.undismiss': { type: 'recovery.undismiss', commandId: ID, incidentId: INCIDENT },
  'recovery.run': { type: 'recovery.run', commandId: ID, remediationId: 'rebuild-index', userInitiated: true },
});

/** Every surface but recovery.html's */
const OTHERS = /** @type {Surface[]} */ (SURFACES.filter(surface => surface !== 'recovery'));

const DENIED = Object.freeze({ allowed: false, code: 'not-on-surface' });

describe("recovery.html's rows in #13's router policy (#20 slice 4b)", () => {
  const policy = createBaselinePolicy({ rows: RECOVERY_PAGE_ROWS });

  it('are the reads, the check on open, the check after a repair, dismissal, and rebuild-index, all in the trust catalog', () => {
    assert.deepEqual(Object.keys(RECOVERY_PAGE_ROWS), Object.keys(REQUESTS));
    for (const type of Object.keys(RECOVERY_PAGE_ROWS)) assert.ok(Object.hasOwn(TRUST_OPERATIONS, type), type);
    assert.deepEqual(RECOVERY_PAGE_REMEDIATIONS, ['rebuild-index']);
  });

  it('accepts each row from recovery.html, and refuses it from every other surface', () => {
    for (const [type, request] of Object.entries(REQUESTS)) {
      assert.deepEqual(policy.authorize(request, CALLERS.recovery), { allowed: true }, type);
      for (const surface of OTHERS) assert.deepEqual(policy.authorize(request, CALLERS[surface]), DENIED, `${surface} ${type}`);
    }
  });

  it('takes trust.verify only as the page opens, and recovery.run only for rebuild-index', () => {
    for (const trigger of TRIGGERS.filter(trigger => trigger !== 'open')) {
      /** @type {Record<string, unknown>} */
      const request = { ...REQUESTS['trust.verify'], trigger };
      assert.deepEqual(policy.authorize(request, CALLERS.recovery), DENIED, trigger);
    }
    const { trigger: _trigger, ...noTrigger } = REQUESTS['trust.verify'];
    assert.deepEqual(policy.authorize(noTrigger, CALLERS.recovery), DENIED);
    for (const remediationId of REMEDIATION_IDS.filter(id => id !== 'rebuild-index')) {
      /** @type {Record<string, unknown>} */
      const request = { ...REQUESTS['recovery.run'], remediationId };
      assert.deepEqual(policy.authorize(request, CALLERS.recovery), DENIED, remediationId);
    }
    const { remediationId: _remediationId, ...noRemediation } = REQUESTS['recovery.run'];
    assert.deepEqual(policy.authorize(noRemediation, CALLERS.recovery), DENIED);
  });

  it("has no row for the rest of the trust catalog, which nothing may run from the page", () => {
    const rest = Object.keys(TRUST_OPERATIONS).filter(type => !Object.hasOwn(RECOVERY_PAGE_ROWS, type));
    assert.deepEqual(rest.sort(), ['diagnostics.export', 'recovery.copies', 'recovery.raise']);
    for (const type of rest) {
      for (const surface of SURFACES) {
        assert.deepEqual(policy.authorize({ type }, CALLERS[surface]), { allowed: false, code: 'unknown-operation' }, `${surface} ${type}`);
      }
    }
  });

  it("leaves every other root's policy as it was: without rows, no trust operation runs anywhere", () => {
    const baseline = createBaselinePolicy();
    for (const type of Object.keys(TRUST_OPERATIONS)) {
      for (const surface of SURFACES) {
        assert.deepEqual(baseline.authorize({ type }, CALLERS[surface]), { allowed: false, code: 'unknown-operation' }, `${surface} ${type}`);
      }
    }
  });

  it("never lets a row widen a kernel catalog entry, whose own surfaces decide", () => {
    const widened = createBaselinePolicy({ rows: { createNote: { surfaces: ['recovery'] }, listFolders: { surfaces: ['recovery'] } } });
    assert.deepEqual(widened.authorize({ type: 'createNote' }, CALLERS.recovery), DENIED);
    assert.deepEqual(widened.authorize({ type: 'listFolders' }, CALLERS.recovery), DENIED);
    assert.deepEqual(widened.authorize({ type: 'createNote' }, CALLERS.newtab), { allowed: true });
  });

  it('lets recovery.html read its preferences, its theme, and run no other kernel command or query', () => {
    for (const type of [...COMMAND_TYPES, ...QUERY_TYPES]) {
      const expected = type === 'getPreferences' ? { allowed: true } : DENIED;
      assert.deepEqual(policy.authorize({ type }, CALLERS.recovery), expected, type);
    }
  });
});

/**
 * A router serving the rows as recovery.html's root does, whose handlers record what reached
 * them, and a client of it as `surface`
 */
function servedRows() {
  /** @type {string[]} */
  const reached = [];
  const clock = { now: () => Date.now() };
  const handlers = Object.fromEntries(
    Object.keys(RECOVERY_PAGE_ROWS).map(type => [
      type,
      () => {
        reached.push(type);
        return TRUST_OPERATIONS[type].entry.kind === 'query' ? { kind: 'loading' } : rejected('validation', 'cancelled');
      },
    ]),
  );
  const lookup = createLookup({ ...TRUST_OPERATIONS });
  const router = createRouter({
    lookup,
    handlers,
    policy: createBaselinePolicy({ rows: RECOVERY_PAGE_ROWS }),
    clock,
    timers: realTimers,
    coordinatorId: 'recovery-page-router',
    extensionVersion: MANIFEST.version,
  });
  let n = 0;
  /** @param {Surface} surface */
  const clientAs = surface =>
    createClient({
      transport: createInProcessTransport({ router, surface }),
      surface,
      extensionVersion: MANIFEST.version,
      lookup,
      ids: { next: () => `${surface}-${++n}` },
      clock,
      timers: realTimers,
    });
  return { reached, clientAs, close: () => router.close() };
}

describe("the page's router serves the rows only to recovery.html", () => {
  it('answers each row from recovery.html, and refuses every other sender before any handler runs', async () => {
    const { reached, clientAs, close } = servedRows();
    try {
      const page = clientAs('recovery');
      for (const [type, request] of Object.entries(REQUESTS)) {
        const kind = TRUST_OPERATIONS[type].entry.kind;
        const answer = kind === 'query' ? await page.query(request) : await page.execute(/** @type {any} */ (request));
        assert.notEqual(/** @type {{code?: string}} */ (answer).code, 'forbidden-for-surface', type);
      }
      assert.deepEqual(reached, Object.keys(REQUESTS));
      reached.length = 0;
      for (const surface of OTHERS) {
        const other = clientAs(surface);
        for (const [type, request] of Object.entries(REQUESTS)) {
          const kind = TRUST_OPERATIONS[type].entry.kind;
          if (kind === 'query') {
            assert.deepEqual(await other.query(request), { kind: 'failed', cause: 'policy', code: 'forbidden-for-surface' }, `${surface} ${type}`);
          } else {
            const answer = /** @type {{kind: string, reason?: string, code?: string}} */ (await other.execute(/** @type {any} */ (request)));
            assert.deepEqual([answer.kind, answer.reason, answer.code], ['rejected', 'policy', 'forbidden-for-surface'], `${surface} ${type}`);
          }
        }
        other.close();
      }
      assert.deepEqual(reached, [], 'a refused request reached a handler');
    } finally {
      close();
    }
  });

  it('refuses recovery.html itself any other remediation and any other trigger, before any handler runs', async () => {
    const { reached, clientAs, close } = servedRows();
    try {
      const page = clientAs('recovery');
      for (const remediationId of REMEDIATION_IDS.filter(id => id !== 'rebuild-index')) {
        const answer = /** @type {{kind: string, reason?: string, code?: string}} */ (
          await page.execute({ ...REQUESTS['recovery.run'], commandId: `run-${remediationId}`, remediationId })
        );
        assert.deepEqual([answer.kind, answer.reason, answer.code], ['rejected', 'policy', 'forbidden-for-surface'], remediationId);
      }
      const verifyNow = /** @type {{kind: string, reason?: string, code?: string}} */ (
        await page.execute({ ...REQUESTS['trust.verify'], commandId: 'verify-now', trigger: 'verify-now' })
      );
      assert.deepEqual([verifyNow.kind, verifyNow.reason, verifyNow.code], ['rejected', 'policy', 'forbidden-for-surface']);
      assert.deepEqual(reached, []);
    } finally {
      close();
    }
  });

  it("names only recovery.html's own page `recovery`, so no other sender can claim its rows", () => {
    const own = `chrome-extension://${EXTENSION_ID}`;
    // The origin as Chrome gives it, which Node's URL leaves opaque for this scheme
    const sender = (/** @type {string} */ url, id = EXTENSION_ID) => ({ id, url, origin: url.split('/').slice(0, 3).join('/') });
    assert.equal(principalOf(sender(`${own}/recovery.html`), EXTENSION_ID), 'recovery');
    assert.equal(principalOf(sender(`${own}/recovery.html#recovery`), EXTENSION_ID), 'recovery');
    for (const url of [`${own}/newtab.html`, `${own}/popup.html`, `${own}/sidepanel.html`, `${own}/offscreen.html`]) {
      assert.notEqual(principalOf(sender(url), EXTENSION_ID), 'recovery', url);
    }
    for (const url of [`${own}/recovery.htm`, `${own}/js/recovery.js`, `${own}/x/recovery.html`]) {
      assert.equal(principalOf(sender(url), EXTENSION_ID), null, url);
    }
    // Another extension's recovery.html is no page of this one
    assert.equal(principalOf(sender('chrome-extension://otherextensionid/recovery.html', 'otherextensionid'), EXTENSION_ID), null);
  });
});

describe("#15's recovery host (#20 slice 4b)", () => {
  it('is a host, and every provider and remediation resolves on it but Background tasks, which has no row there yet', () => {
    assert.ok(HOSTS.includes('recovery'));
    assert.ok(health.hosts.includes('recovery') && remediation.hosts.includes('recovery'));
    const root = createRegistryRoot({ host: 'recovery' });
    root.register(health, PROVIDERS);
    root.register(remediation, REMEDIATIONS);
    const resolution = root.resolve();
    const off = [...resolution.list('health'), ...resolution.list('remediation')].filter(
      contribution => contribution.state === 'not-applicable',
    );
    assert.deepEqual(off.map(contribution => contribution.id), ['coordinator']);
    assert.equal(resolution.list('health').length, PROVIDERS.length);
    assert.equal(resolution.list('remediation').length, REMEDIATIONS.length);
  });

  it('gives every provider that runs on it a row, a label, and titles for each fault it observes, open and fixed', () => {
    const root = createRegistryRoot({ host: 'recovery' });
    root.register(health, PROVIDERS);
    const runs = root.resolve().list('health').filter(contribution => contribution.state === 'enabled').map(contribution => String(contribution.id));
    assert.equal(runs.length, PROVIDERS.length - 1);
    const rows = PAGE.sections.flatMap(section => section.rows);
    /** @param {Record<string, string>} table @param {string} id @param {string} fault */
    const titled = (table, id, fault) => Object.keys(table).some(key => key === `${id}/${fault}` || key.startsWith(`${id}/${fault}/`));
    for (const id of runs) {
      assert.ok(rows.includes(id) || PLATFORM.includes(id), `${id} has a row`);
      assert.ok(/** @type {Record<string, {label?: string}>} */ (PROVIDER)[id]?.label, `${id} has a label`);
      const descriptor = /** @type {{observes: readonly string[]}} */ (/** @type {unknown} */ (PROVIDERS.find(provider => provider.id === id)));
      for (const fault of descriptor.observes) {
        assert.ok(titled(TITLES, id, fault), `${id}/${fault} has a title`);
        assert.ok(titled(RESOLVED, id, fault), `${id}/${fault} has a title for when it's fixed`);
      }
    }
  });
});

/**
 * recovery.html's root on a fresh profile, with #17's adapter for its notes database
 * @param {ReturnType<typeof freshProfile>} [of]
 */
function rootOn(of = freshProfile()) {
  const local = of.chrome.api.storage.local;
  const root = createRecoveryRoot({
    host: {
      adapter: adapterOn(of),
      indexedDB: of.faults.factory,
      keyRange: /** @type {any} */ (KeyRange),
      settings: settingsOf(of),
      secretSettings: /** @type {any} */ (local),
      locks: webLocks(),
      crypto: /** @type {any} */ (webcrypto),
      permissions: grantedAsDeclared(),
      manifest: MANIFEST,
      timers: realTimers,
    },
  });
  return { of, root };
}

let commands = 0;
const commandId = () => `00000000-0000-4000-8000-${(++commands).toString(16).padStart(12, '0')}`;

describe("recovery.html's root", () => {
  it('serves the reads and the check on open in the page, and storage verifies with no migration port on a version 8 database', async () => {
    const { root } = rootOn();
    try {
      const before = /** @type {any} */ (await root.trust.query({ type: 'trust.summary' }));
      assert.equal(before.kind, 'ready', JSON.stringify(before));
      const verified = /** @type {any} */ (
        await root.trust.execute({ type: 'trust.verify', commandId: commandId(), trigger: 'open' })
      );
      assert.equal(verified.kind, 'committed', JSON.stringify(verified));
      const report = /** @type {any} */ (await root.trust.query({ type: 'trust.report' }));
      assert.equal(report.kind, 'ready', JSON.stringify(report));
      const storage = report.data.providers.find((/** @type {any} */ provider) => provider.providerId === 'storage');
      assert.equal(storage.status, 'verified', JSON.stringify(storage));
      // Opening runs only the local-cheap checks: recovery readiness and local inference wait
      const expensive = report.data.providers.filter((/** @type {any} */ provider) => provider.costClass === 'local-expensive');
      assert.ok(expensive.length > 0);
      for (const provider of expensive) assert.equal(provider.receipt, null, provider.providerId);
      const incidents = /** @type {any} */ (await root.trust.query({ type: 'recovery.incidents' }));
      assert.equal(incidents.kind, 'ready', JSON.stringify(incidents));
    } finally {
      root.close();
    }
  });

  it("refuses what its rows don't name from the page itself: another remediation, a verify not on open, and recovery.raise", async () => {
    const { root } = rootOn();
    try {
      const other = /** @type {any} */ (
        await root.trust.execute({ type: 'recovery.run', commandId: commandId(), remediationId: 'retry-open', userInitiated: true })
      );
      assert.deepEqual([other.kind, other.reason, other.code], ['rejected', 'policy', 'forbidden-for-surface']);
      const now = /** @type {any} */ (
        await root.trust.execute({ type: 'trust.verify', commandId: commandId(), trigger: 'verify-now' })
      );
      assert.deepEqual([now.kind, now.reason, now.code], ['rejected', 'policy', 'forbidden-for-surface']);
      const raise = /** @type {any} */ (
        await root.trust.execute({
          type: 'recovery.raise',
          commandId: commandId(),
          providerId: 'storage',
          faultCode: 'open-failed',
          severity: 'data-risk',
        })
      );
      assert.equal(raise.kind, 'rejected', JSON.stringify(raise));
    } finally {
      root.close();
    }
  });
});

describe("recovery.html's browser host (#20 slice 4b)", () => {
  /**
   * `work` on the host browserRecoveryHost() makes with `local` as chrome.storage.local, which
   * stays the page's chrome until it's done
   * @param {Record<string, unknown>} local
   * @param {(host: ReturnType<typeof browserRecoveryHost>) => Promise<void>} work
   */
  const withHost = async (local, work) => {
    const scope = /** @type {{chrome?: unknown}} */ (globalThis);
    const before = scope.chrome;
    scope.chrome = { storage: { local }, permissions: {}, runtime: { getManifest: () => ({ version: '1.4.1', permissions: [] }) } };
    try {
      await work(browserRecoveryHost());
    } finally {
      scope.chrome = before;
    }
  };
  /** chrome.storage.local with one legacy copy, which notes every read */
  const area = (/** @type {{getKeys?: boolean}} */ { getKeys = false } = {}) => {
    /** @type {unknown[]} */
    const reads = [];
    const local = {
      get: async (/** @type {unknown} */ keys) => {
        reads.push(keys);
        return {};
      },
      set: async () => {},
      ...(getKeys ? { getKeys: async () => ['setting_theme', 'auto_backup_1760000000000'] } : {}),
    };
    return { local, reads };
  };

  it("lists chrome.storage.local's keys through getKeys where Chrome has it, and has no list where it doesn't, never reading every value", async () => {
    const modern = area({ getKeys: true });
    await withHost(modern.local, async host => {
      assert.equal(await countLegacyCopies(host.settings), 1);
    });
    // Chrome 116 to 129: no getKeys, so the count is unavailable, never read through get(null)
    const old = area();
    await withHost(old.local, async host => {
      assert.equal(/** @type {{getKeys?: unknown}} */ (host.settings).getKeys, undefined);
      assert.equal(await countLegacyCopies(host.settings), null);
    });
    assert.deepEqual([...modern.reads, ...old.reads], []);
  });
});
