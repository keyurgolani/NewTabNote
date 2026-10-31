// #20 slice 2's Credentials provider and the legacy secret reader (security): a legacy
// plaintext secret in any of its three places makes Credentials `action-required` with
// "Remove saved key", and the secret appears nowhere: not in what the reader answers, a
// receipt, an incident, the journal, the diagnostic export, NewTabNoteTrust, chrome.storage
// beside its own key, or a line the console printed. The secrets are canaries, new each run,
// and no assertion message prints one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLegacySecretReader } from '../../js/kernel/adapters/indexeddb/legacy-secrets.js';
import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { credentials } from '../../js/trust/core/providers/legacy.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { KeyRange, dump, legacyEnv } from './migration-support.mjs';
import { MANIFEST, freshProfile, providerContext } from './trust-provider-support.mjs';
import { dumpTrustDatabase, hexIds, lockManager, manualClock, realTimers } from './trust-support.mjs';


/** A synthetic secret, new each run */
const canary = (/** @type {string} */ slot) => `ntn-canary-${slot}-${Math.random().toString(16).slice(2, 10)}`;

/**
 * Whether `text` holds any of `secrets`, said without naming one
 * @param {string} text
 * @param {readonly string[]} secrets
 */
const leaks = (text, secrets) => secrets.filter(secret => text.includes(secret)).length;

/**
 * Everything the console prints while `body` runs, as text, errors with their messages and stacks
 * @template T
 * @param {() => Promise<T>} body
 * @returns {Promise<{value: T, printed: string}>}
 */
async function capturingConsole(body) {
  const methods = /** @type {const} */ (['log', 'info', 'warn', 'error', 'debug', 'trace']);
  /** @type {string[]} */
  const lines = [];
  const saved = methods.map(name => console[name]);
  const show = (/** @type {unknown} */ value) =>
    value instanceof Error ? `${value.name}: ${value.message} ${value.stack} ${String(value.cause)}` : typeof value === 'string' ? value : JSON.stringify(value);
  for (const name of methods) console[name] = (...args) => lines.push(args.map(show).join(' '));
  try {
    const value = await body();
    return { value, printed: lines.join('\n') };
  } finally {
    methods.forEach((name, index) => {
      console[name] = saved[index];
    });
  }
}

/**
 * A profile holding all three legacy secrets, as 1.4.x and releases up to 1.1.2 left them
 */
async function profileWithSecrets() {
  const secrets = Object.freeze({ chromeKey: canary('llm'), webdav: canary('webdav'), idbKey: canary('idb-llm') });
  const of = freshProfile();
  await legacyEnv.createDatabase(of.real, {
    records: { settings: [{ key: 'llmApiKey', value: secrets.idbKey }, { key: 'theme', value: 'dark' }] },
  });
  of.chrome.local.setting_llmApiKey = secrets.chromeKey;
  of.chrome.local.setting_syncProvider = 'webdav';
  of.chrome.local.setting_syncWebdavConfig = { serverUrl: 'https://dav.example.test/files', username: 'synthetic-user', password: secrets.webdav };
  return { of, secrets: Object.values(secrets) };
}

describe('the legacy secret reader (#20 slice 2, Credentials)', () => {
  it('answers which places hold a secret, and nothing that holds one', async () => {
    const { of, secrets } = await profileWithSecrets();
    const reader = createLegacySecretReader({ indexedDB: of.faults.factory, settings: of.chrome.api.storage.local });
    const found = await reader.present();
    assert.deepEqual([...found], ['setting_llmApiKey', 'setting_syncWebdavConfig', 'settings']);
    assert.equal(leaks(JSON.stringify(found), secrets), 0);
    // An empty key, a config without a password, and none at all are absent
    of.chrome.local.setting_llmApiKey = '   ';
    of.chrome.local.setting_syncWebdavConfig = { serverUrl: 'https://dav.example.test', username: 'u', password: '' };
    assert.deepEqual([...(await reader.present())], ['settings']);
    const empty = freshProfile();
    const none = createLegacySecretReader({ indexedDB: empty.faults.factory, settings: empty.chrome.api.storage.local });
    assert.deepEqual([...(await none.present())], []);
  });

  it('writes nothing, and makes no database on a profile without one', async () => {
    const { of } = await profileWithSecrets();
    const before = JSON.stringify(await dump(of));
    const writes = of.chrome.writes().length;
    await createLegacySecretReader({ indexedDB: of.faults.factory, settings: of.chrome.api.storage.local }).present();
    assert.equal(JSON.stringify(await dump(of)), before);
    assert.equal(of.chrome.writes().length, writes);
    const empty = freshProfile();
    await createLegacySecretReader({ indexedDB: empty.faults.factory, settings: empty.chrome.api.storage.local }).present();
    const names = (await empty.real.databases()).map(database => database.name);
    assert.deepEqual(names, []);
  });

  it("a failing read rejects with its own code, and no part of what failed, the secret in its message included, leaves", async () => {
    const { of, secrets } = await profileWithSecrets();
    const [chromeKey] = secrets;
    const broken = {
      get: async () => {
        throw new Error(`storage choked on ${chromeKey}`);
      },
      set: async () => {},
    };
    const fromSettings = await createLegacySecretReader({ indexedDB: of.faults.factory, settings: broken })
      .present()
      .catch(error => error);
    assert.equal(fromSettings.name, 'UnavailableError');
    assert.equal(fromSettings.code, 'settings-read-failed');
    assert.equal(fromSettings.cause, undefined);
    assert.equal(leaks(`${fromSettings.message} ${fromSettings.stack}`, secrets), 0);
    const factory = /** @type {IDBFactory} */ (
      /** @type {unknown} */ ({
        open() {
          throw new DOMException(`cannot open, ${secrets[2]}`, 'UnknownError');
        },
      })
    );
    const fromIndexedDb = await createLegacySecretReader({ indexedDB: factory, settings: of.chrome.api.storage.local })
      .present()
      .catch(error => error);
    assert.deepEqual([fromIndexedDb.name, fromIndexedDb.code, fromIndexedDb.cause], ['UnavailableError', 'unreadable', undefined]);
    assert.equal(leaks(`${fromIndexedDb.message} ${fromIndexedDb.stack}`, secrets), 0);
    // Through the check, it's unverified with the exception's name only
    const { receipt } = await runCheck(
      {
        id: 'credentials',
        operation: 'credentials.find-legacy-secrets',
        costClass: 'local-cheap',
        timeoutMs: 5000,
        freshnessMs: 60_000,
        check: context => credentials.check(context),
      },
      { context: { secrets: createLegacySecretReader({ indexedDB: factory, settings: broken }) }, clock: manualClock(), timers: realTimers },
    );
    assert.deepEqual([receipt.status, receipt.evidence], ['unverified', { errorCode: 'check-threw', exception: 'UnavailableError' }]);
  });
});

describe('the settings area every other provider reads (#20 slice 2, security)', () => {
  it('no provider asks chrome.storage.local for a secret key: only the secret reader reads them', async () => {
    const { of } = await profileWithSecrets();
    const { context } = await providerContext(of);
    /** @type {string[]} */
    const asked = [];
    const settings = /** @type {any} */ (context.settings);
    const spied = {
      ...settings,
      get: (/** @type {string[]} */ keys) => {
        asked.push(...keys);
        return settings.get(keys);
      },
    };
    for (const descriptor of PROVIDERS) {
      const implementation = /** @type {any} */ (await /** @type {() => Promise<unknown>} */ (descriptor.load)());
      await implementation.check({ ...context, settings: spied });
    }
    assert.ok(asked.length > 0, 'no provider read the settings area');
    assert.deepEqual(
      asked.filter(key => key === 'setting_llmApiKey' || key === 'setting_syncWebdavConfig'),
      [],
    );
  });
});

describe('Credentials, end to end with every provider (#20 slice 2, security)', () => {
  it('is action-required with "Remove saved key", and no seeded secret reaches a receipt, an incident, the journal, the export, NewTabNoteTrust, chrome.storage, or the console', async () => {
    const { of, secrets } = await profileWithSecrets();
    const clock = manualClock();
    const store = createTrustDatabase({ indexedDB: of.faults.factory, keyRange: KeyRange });
    const records = createTrustRecords({
      store,
      settings: of.chrome.api.storage.local,
      clock,
      ids: hexIds(),
      locks: lockManager(),
    });
    const { context } = await providerContext(of, { events: () => records.events() });
    const { value, printed } = await capturingConsole(async () => {
      await records.open();
      const journal = createDiagnosticJournal({ records, clock, strict: true });
      const root = createRegistryRoot({ host: 'workspace' });
      root.register(health, PROVIDERS);
      const resolution = root.resolve();
      const runtime = createRuntime(resolution);
      await runtime.probe();
      const trust = createTrustUseCases({
        records,
        journal,
        clock,
        timers: realTimers,
        locks: lockManager(),
        registry: { resolution, runtime, context: { ...context, trust: records } },
        versions: { extension: MANIFEST.version, browser: null, canvasSchema: 8, trustSchema: 1 },
      });
      const verified = await trust.verify({ type: 'trust.verify', commandId: '00000000-0000-4000-8000-0000000000b1', trigger: 'verify-now' });
      await journal.flush();
      return {
        verified,
        summary: await trust.summary(),
        report: await trust.report(),
        incidents: await trust.incidents({ includeResolved: true }),
        exported: await trust.exportDiagnostics(),
        events: await records.events(),
      };
    });
    assert.equal(value.verified.kind, 'committed');
    const report = /** @type {any} */ (value.report).data;
    const row = report.providers.find((/** @type {any} */ provider) => provider.providerId === 'credentials');
    assert.deepEqual([row.status, row.receipt.nextAction, row.receipt.evidence], ['action-required', 'remove-saved-key', { count: 3 }]);
    const raised = report.incidents.filter((/** @type {any} */ incident) => incident.providerId === 'credentials');
    assert.deepEqual(
      raised.map((/** @type {any} */ incident) => [incident.faultCode, incident.subjectId]).sort(),
      [
        ['legacy-secret', 'setting_llmApiKey'],
        ['legacy-secret', 'setting_syncWebdavConfig'],
        ['legacy-secret', 'settings'],
      ],
    );
    // Nowhere the Trust Center keeps or shows anything
    assert.equal(leaks(JSON.stringify(value), secrets), 0, 'a use case answered with a seeded secret');
    assert.equal(leaks(await dumpTrustDatabase(of.real), secrets), 0, 'NewTabNoteTrust holds a seeded secret');
    assert.equal(leaks(printed, secrets), 0, 'the console printed a seeded secret');
    // chrome.storage holds each secret only where 1.4.x put it
    const elsewhere = Object.entries(of.chrome.local).filter(
      ([key]) => key !== 'setting_llmApiKey' && key !== 'setting_syncWebdavConfig',
    );
    assert.equal(leaks(JSON.stringify(elsewhere), secrets), 0, 'chrome.storage holds a seeded secret under another key');
    // And the secret is still where it was: removing it is slice 3's remediation, never a check's
    assert.equal(of.chrome.local.setting_llmApiKey, secrets[0]);
  });
});
