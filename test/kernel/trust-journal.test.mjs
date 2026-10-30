// #20 slice 1's diagnostic journal and report (AC3, "Security and privacy"): logger.event
// takes registered codes and allowlisted fields only, throwing in tests and dropping and
// counting in production; the failure codes slice 1b moves onto it raise their incidents; and
// seeded canaries (a note title, a credential, a URL, and an error message) never reach a
// record, the journal, the diagnostic report, or a log line, whichever way they're fed in.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { checkEvidence, EVIDENCE_FIELD_NAMES } from '../../js/trust/core/evidence.js';
import { EVENT_CODES, EVENT_CODE_NAMES, eventCodeProblems } from '../../js/trust/core/event-codes.js';
import { createDiagnosticJournal, withEvents } from '../../js/trust/core/journal.js';
import { buildDiagnostics, leaves, reportSchema } from '../../js/trust/core/diagnostics.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { exportedSchema } from '../../js/trust/core/operations/diagnostics-export.js';
import { health } from '../../js/trust/core/families.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import * as v from '../../js/lib/valibot/index.mjs';
import { databaseOn, dumpTrustDatabase, hexIds, manualClock, realTimers, trustProfile } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */

/** @type {{createLogger: (level?: string) => Record<string, (...args: unknown[]) => void>}} */
const { createLogger } = createRequire(import.meta.url)('../../js/core/logger.js');

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const VERSIONS = Object.freeze({ extension: '1.4.1', browser: '131.0.6778.85', canvasSchema: 8, trustSchema: 1 });

// The canaries, each in the shape it has in the wild
const TITLE = 'Canary title: plans for 7Q9';
const CREDENTIAL = 'sk-CaNaRy-9xQ2Lp7Zt';
const URL_CANARY = 'https://canary.example.test/n/7Q9';
const MESSAGE = 'Canary failure while saving note 7Q9';
const CANARIES = [TITLE, CREDENTIAL, URL_CANARY, MESSAGE, 'Canary', 'CaNaRy', 'canary.example'];

/**
 * Fails when any canary appears in `text`
 * @param {string} text
 * @param {string} where
 */
const assertClean = (text, where) => {
  for (const canary of CANARIES) assert.ok(!text.includes(canary), `${where} holds "${canary}"`);
};

/** A fresh profile with NewTabNoteTrust open */
async function journalOn({ strict = false } = {}) {
  const profile = trustProfile();
  const store = databaseOn(profile);
  opened.push(store);
  const clock = manualClock();
  const records = createTrustRecords({ store, settings: profile.settings, clock, ids: hexIds(), locks: profile.locks });
  await records.open();
  const journal = createDiagnosticJournal({ records, clock, strict });
  return { profile, clock, records, journal };
}

/**
 * Runs `body` with every console method recording what it's given, and answers what it saw
 * @param {() => Promise<void>} body
 * @returns {Promise<string>}
 */
async function capturingConsole(body) {
  const methods = /** @type {const} */ (['log', 'info', 'warn', 'error', 'debug']);
  const saved = methods.map(method => console[method]);
  /** @type {unknown[][]} */
  const lines = [];
  for (const method of methods) console[method] = (...args) => lines.push(args);
  try {
    await body();
  } finally {
    methods.forEach((method, index) => {
      console[method] = saved[index];
    });
  }
  return lines
    .map(args => args.map(arg => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' '))
    .join('\n');
}

/** Every way a caller might try to put a canary into an event */
const CANARY_FIELDS = [
  { title: TITLE },
  { apiKey: CREDENTIAL },
  { authorization: `Bearer ${CREDENTIAL}` },
  { url: URL_CANARY },
  { message: MESSAGE },
  { error: new Error(MESSAGE) },
  { errorCode: MESSAGE },
  { errorCode: URL_CANARY },
  { exception: MESSAGE },
  { subjectId: TITLE },
  { subjectId: URL_CANARY },
  { subjectId: `Bearer ${CREDENTIAL}` },
  { surface: URL_CANARY },
  { count: TITLE },
];

describe('the event registry and the evidence allowlist (#20, "Diagnostic journal")', () => {
  it('lists only codes in the pattern, with fields on the allowlist', () => {
    assert.deepEqual(eventCodeProblems(), []);
    // The failure sites #20 slice 1b moves onto logger.event each have a code and an incident
    for (const code of [
      'capture.failed',
      'storage.open-failed',
      'embeddings.load-failed',
      'backup.auto-failed',
      'indexer.start-failed',
    ]) {
      assert.ok(EVENT_CODES[code]?.incident, `${code} raises no incident`);
    }
  });

  it('holds only ids, codes, counts, enums, durations, versions, times, revisions, seq, and hashes', () => {
    assert.deepEqual(EVIDENCE_FIELD_NAMES, [
      'ageMs',
      'at',
      'attempts',
      'browserVersion',
      'bytes',
      'capture',
      'cause',
      'code',
      'commandId',
      'costClass',
      'count',
      'durationMs',
      'errorCode',
      'exception',
      'extensionVersion',
      'faultCode',
      'incidentId',
      'lag',
      'operation',
      'packageHash',
      'pending',
      'providerId',
      'reason',
      'records',
      'recoveryPointId',
      'remediationId',
      'retryable',
      'revision',
      'runId',
      'schemaVersion',
      'seq',
      'severity',
      'since',
      'state',
      'status',
      'subjectId',
      'surface',
      'timeoutMs',
      'trigger',
      'verifiedAt',
      'version',
    ]);
    for (const fields of CANARY_FIELDS)
      assert.equal(checkEvidence(fields).ok, false, JSON.stringify(Object.keys(fields)));
    assert.equal(checkEvidence({ exception: 'QuotaExceededError', errorCode: 'quota', durationMs: 4 }).ok, true);
    assert.equal(checkEvidence([1]).ok, false);
    assert.equal(checkEvidence(new Error('x')).ok, false);
  });
});

describe('logger.event (#20 slice 1, AC3)', () => {
  it('appends a registered event with its allowlisted fields', async () => {
    const { journal, records } = await journalOn({ strict: true });
    assert.equal(
      journal.event('trust.check-timed-out', { providerId: 'storage', durationMs: 20, timeoutMs: 20 }),
      true,
    );
    await journal.flush();
    const [event] = await records.events();
    assert.equal(event.code, 'trust.check-timed-out');
    assert.deepEqual(event.fields, { providerId: 'storage', durationMs: 20, timeoutMs: 20 });
  });

  it('throws in tests on an unregistered code, a field outside the allowlist or its code, and a value its field refuses', async () => {
    const { journal, records } = await journalOn({ strict: true });
    const message = await capturingConsole(async () => {
      assert.throws(() => journal.event('note.saved', {}), /unregistered-code/);
      assert.throws(
        () => journal.event('trust.reconciled', { providerId: 'storage' }),
        /field-not-allowed \(providerId\)/,
      );
      for (const fields of CANARY_FIELDS) {
        assert.throws(
          () => journal.event('capture.failed', /** @type {any} */ (fields)),
          error => {
            assertClean(String(/** @type {Error} */ (error).message), 'the thrown message');
            return error instanceof TypeError;
          },
        );
      }
    });
    assert.equal(message, '', 'the journal wrote to the console');
    await journal.flush();
    assert.deepEqual(await records.events(), []);
  });

  it('drops and counts in production, recording only the reason and the count', async () => {
    const { journal, records } = await journalOn();
    assert.equal(journal.event('note.saved', { title: TITLE }), false);
    assert.equal(journal.event('capture.failed', { message: MESSAGE }), false);
    assert.equal(journal.event('capture.failed', { errorCode: URL_CANARY }), false);
    assert.equal(journal.event('capture.failed', { surface: 'worker-internal', errorCode: 'quota' }), true);
    await journal.flush();
    assert.deepEqual(journal.rejected(), {
      'unregistered-code': 1,
      'field-not-allowed': 1,
      'value-not-allowed': 1,
      'not-an-object': 0,
    });
    const events = await records.events();
    assert.deepEqual(
      events.map(event => [event.code, event.fields]),
      [
        ['diagnostics.rejected', { reason: 'unregistered-code', count: 1 }],
        ['diagnostics.rejected', { reason: 'field-not-allowed', count: 1 }],
        ['diagnostics.rejected', { reason: 'value-not-allowed', count: 1 }],
        ['capture.failed', { surface: 'worker-internal', errorCode: 'quota' }],
      ],
    );
  });

  it('raises the incident a failure code names, and a repeat updates it', async () => {
    const { journal, records } = await journalOn({ strict: true });
    journal.event('storage.open-failed', {
      surface: 'worker-internal',
      cause: 'storage',
      errorCode: 'open-failed',
      exception: 'UnknownError',
    });
    journal.event('storage.open-failed', { surface: 'worker-internal', cause: 'storage', errorCode: 'open-failed' });
    journal.event('indexer.start-failed', { surface: 'newtab', exception: 'TypeError' });
    journal.event('embeddings.load-failed', { surface: 'offscreen', durationMs: 900 });
    journal.event('backup.auto-failed', { cause: 'quota', errorCode: 'quota', records: 12 });
    journal.event('capture.failed', {
      surface: 'worker-internal',
      errorCode: 'store-unavailable',
      subjectId: 'daily-2026-10-30',
    });
    await journal.flush();
    const incidents = await records.incidents();
    assert.deepEqual(incidents.map(incident => [incident.key, incident.severity, incident.occurrences]).sort(), [
      ['backup/auto-backup-failed/-', 'data-risk', 1],
      ['capture/capture-failed/daily-2026-10-30', 'capture-risk', 1],
      ['index/indexer-start-failed/-', 'degraded', 1],
      ['local-inference/load-failed/-', 'degraded', 1],
      ['storage/open-failed/-', 'capture-risk', 2],
    ]);
  });

  it('gives a logger an event method and leaves its level methods console-only', () => {
    const logger = createLogger('warn');
    const journal = /** @type {any} */ ({ event: () => true });
    const extended = withEvents(logger, journal);
    assert.equal(extended.event, journal.event);
    for (const method of ['debug', 'info', 'warn', 'error', 'setLevel', 'getLevel']) {
      assert.equal(/** @type {any} */ (extended)[method], logger[method]);
    }
    assert.ok(!('event' in logger), "js/core/logger.js's logger is unchanged");
  });
});

describe('the diagnostic report (#20, "Security and privacy")', () => {
  it('previews every field it holds, with its value, and holds only the listed sections', async () => {
    const { journal, records, clock } = await journalOn({ strict: true });
    journal.event('capture.failed', { surface: 'worker-internal', errorCode: 'quota', cause: 'quota' });
    await journal.flush();
    await records.record({
      providerId: 'storage',
      status: 'verified',
      verifiedAt: clock.now(),
      durationMs: 3,
      freshnessMs: 1000,
      operation: 'storage.probe-readwrite',
      evidence: { durationMs: 3, seq: 9 },
      consequenceKey: null,
      preserved: [],
      nextAction: null,
    });
    const exported = await buildDiagnostics({ records, journal, clock, versions: VERSIONS });
    assert.ok(v.is(exportedSchema, exported));
    assert.equal(exported.filename, `newtabnote-diagnostics-${new Date(clock.now()).toISOString().slice(0, 10)}.json`);
    const report = JSON.parse(exported.serialized);
    assert.ok(v.is(reportSchema, report));
    assert.deepEqual(Object.keys(report), [
      'format',
      'formatVersion',
      'createdAt',
      'installId',
      'versions',
      'records',
      'recordsFailure',
      'migrations',
      'receipts',
      'incidents',
      'runs',
      'journal',
      'rejected',
    ]);
    // The preview is exactly the file's fields, nothing hidden and nothing extra
    assert.deepEqual(exported.fields, leaves(report));
    assert.ok(exported.fields.some(field => field.field === 'versions.extension' && field.value === '1.4.1'));
    assert.ok(
      exported.fields.some(
        field => field.field === 'receipts.0.operation' && field.value === 'storage.probe-readwrite',
      ),
    );
    assert.equal(exported.bytes, Buffer.byteLength(exported.serialized));
    // A field nobody listed can't reach the file
    assert.equal(v.is(reportSchema, { ...report, notes: [] }), false);
  });
});

describe('seeded canaries reach no record, journal event, report, or log line (#20, AC3 and AC14)', () => {
  it('whichever way they are fed in', async () => {
    const { profile, journal, records, clock } = await journalOn();
    // A provider whose check sees a note, a saved key, and a page, and tries to report them
    const note = { id: 'n1', title: TITLE, url: URL_CANARY, apiKey: CREDENTIAL };
    /** @type {Array<(context: any) => unknown>} */
    const checks = [
      () => ({ status: 'verified', evidence: { title: note.title } }),
      () => ({ status: 'degraded', evidence: { subjectId: note.url } }),
      () => ({ status: 'failed', faults: [{ faultCode: 'lost', subjectId: note.title, severity: 'data-risk' }] }),
      () => ({ status: 'action-required', consequenceKey: note.apiKey }),
      () => {
        throw new Error(MESSAGE);
      },
      () => Promise.reject(Object.assign(new Error(MESSAGE), { name: URL_CANARY })),
      () => ({ status: 'verified', evidence: { exception: MESSAGE } }),
    ];
    const root = createRegistryRoot({ host: 'workspace' });
    root.register(
      health,
      checks.map((check, index) => ({
        id: `canary-${index}`,
        version: 1,
        apiVersion: 1,
        group: 'recovery',
        rank: index + 1,
        hosts: ['workspace'],
        label: 'Canary',
        owner: 20,
        operation: 'fixture.canary',
        costClass: 'local-cheap',
        timeoutMs: 50,
        freshnessMs: 60_000,
        triggers: ['verify-now'],
        fixtures: ['truthful-receipt'],
        implementation: { check },
      })),
    );
    const resolution = root.resolve();
    const runtime = createRuntime(resolution);
    await runtime.probe();
    const trust = createTrustUseCases({
      records,
      journal,
      clock,
      timers: realTimers,
      registry: { resolution, runtime, context: { note } },
      versions: VERSIONS,
    });

    /** @type {unknown[]} */
    const answers = [];
    const logged = await capturingConsole(async () => {
      answers.push(await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' }));
      for (const fields of CANARY_FIELDS) answers.push(journal.event('capture.failed', /** @type {any} */ (fields)));
      answers.push(journal.event(TITLE, {}));
      for (const evidence of CANARY_FIELDS) {
        answers.push(
          await trust.raise({
            type: 'recovery.raise',
            commandId: 'c2',
            providerId: 'storage',
            faultCode: 'open-failed',
            severity: 'capture-risk',
            evidence,
          }),
        );
        await records
          .raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'degraded', evidence })
          .catch(error => {
            answers.push(String(error && error.message));
          });
      }
      // Straight at the records, past every schema a router would apply first
      /** @param {Promise<unknown>} attempt */
      const refused = attempt =>
        attempt.then(
          () => assert.fail('the records stored a canary'),
          error => answers.push(String(error && error.message)),
        );
      await refused(records.raise({ providerId: 'storage', faultCode: MESSAGE, severity: 'degraded' }));
      await refused(records.raise({ providerId: 'storage', faultCode: 'x', subjectId: TITLE, severity: 'degraded' }));
      await refused(
        records.raise({ providerId: 'storage', faultCode: 'x', severity: 'degraded', affected: [MESSAGE] }),
      );
      const base = {
        providerId: 'storage',
        status: /** @type {const} */ ('verified'),
        verifiedAt: 1,
        durationMs: 1,
        freshnessMs: 1,
        operation: 'storage.probe-readwrite',
        evidence: {},
        consequenceKey: null,
        preserved: [],
        nextAction: null,
      };
      await refused(records.record({ ...base, evidence: /** @type {any} */ ({ url: URL_CANARY }) }));
      await refused(records.record({ ...base, consequenceKey: CREDENTIAL }));
      await refused(records.record({ ...base, operation: MESSAGE }));
      await refused(
        records.append({ at: 1, code: 'capture.failed', fields: /** @type {any} */ ({ message: MESSAGE }) }),
      );
      await refused(records.append({ at: 1, code: TITLE, fields: {} }));
      await refused(
        records.putRun({
          id: 'r1',
          commandId: 'retry',
          incidentId: null,
          state: 'failed',
          outcome: MESSAGE,
          startedAt: 1,
          updatedAt: 1,
        }),
      );
      answers.push(
        await trust.raise({
          type: 'recovery.raise',
          commandId: 'c3',
          providerId: URL_CANARY,
          faultCode: 'x',
          severity: 'degraded',
        }),
      );
      answers.push(
        await trust.raise({
          type: 'recovery.raise',
          commandId: 'c4',
          providerId: 'storage',
          faultCode: MESSAGE,
          severity: 'degraded',
        }),
      );
      await journal.flush();
      answers.push(await trust.summary(), await trust.report(), await trust.incidents({ includeResolved: true }));
      answers.push(await trust.exportDiagnostics());
    });

    const exported = /** @type {any} */ (answers[answers.length - 1]);
    assert.equal(exported.kind, 'diagnostics');
    assertClean(exported.serialized, 'the diagnostic report');
    assertClean(JSON.stringify(exported.fields), 'the report preview');
    assertClean(await dumpTrustDatabase(profile.real), 'NewTabNoteTrust');
    assertClean(JSON.stringify([...profile.settings.items.entries()]), 'chrome.storage.local');
    assertClean(JSON.stringify(await records.events()), 'the journal');
    assertClean(JSON.stringify(answers), 'what the use cases answered');
    assertClean(logged, 'the console');
    // The checks did run: each canary provider has a receipt, none verified on what it tried
    const statuses = (await records.latestReceipts()).map(receipt => receipt.status);
    assert.equal(statuses.length, checks.length);
    assert.ok(
      statuses.every(status => status === 'unverified'),
      statuses.join(),
    );
    // And the canaries were counted, not stored
    assert.ok(journal.rejected()['field-not-allowed'] > 0);
    assert.ok(journal.rejected()['value-not-allowed'] > 0);
  });
});
