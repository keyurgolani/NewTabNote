// #214: the diagnostics export leaves out, and counts, the journal events its own build can't parse.
// After a rollback, a later build's events stay in NewTabNoteTrust's journal for up to 14 days, since
// the journal's reads are raw, and the report parsed every event against this build's registry and
// evidence, so one it didn't know refused the whole report. Each event is now checked on its own:
// those that pass are kept, in their order, and those that don't are left out and counted in
// `journalLeftOut`, which is written only when it's above 0. Every other section of the report is
// as strict as before.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnostics, leaves, reportSchema } from '../../js/trust/core/diagnostics.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import * as v from '../../js/lib/valibot/index.mjs';
import { databaseOn, hexIds, manualClock, trustProfile } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {ReturnType<typeof trustProfile>} TrustProfile */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const VERSIONS = Object.freeze({ extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 });

/** A capture failure this build journals, as the worker does */
const KNOWN = Object.freeze({ surface: 'worker-internal', errorCode: 'quota', cause: 'quota' });

/** A fresh profile with NewTabNoteTrust open, its records, and a journal on them */
async function exportOn() {
  const profile = trustProfile();
  const store = databaseOn(profile);
  opened.push(store);
  const clock = manualClock();
  const records = createTrustRecords({ store, settings: profile.settings, clock, ids: hexIds(), locks: profile.locks });
  await records.open();
  const journal = createDiagnosticJournal({ records, clock, strict: true });
  return { profile, clock, records, journal };
}

/**
 * Puts `rows` straight into one of NewTabNoteTrust's stores, as a later build would have written
 * them, past this build's checks
 * @param {TrustProfile} profile
 * @param {'journal' | 'runs'} name
 * @param {Record<string, unknown>[]} rows
 */
async function laterBuildWrote(profile, name, rows) {
  const db = /** @type {IDBDatabase} */ (
    await new Promise((resolve, reject) => {
      const request = profile.real.open('NewTabNoteTrust');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })
  );
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      for (const row of rows) tx.objectStore(name).add(row);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * The report `exported` holds, and its journal's events as [code, fields]
 * @param {Awaited<ReturnType<typeof buildDiagnostics>>} exported
 */
function reportOf(exported) {
  /** @type {Record<string, unknown> & {journal: {code: string, fields: unknown}[], journalLeftOut?: number}} */
  const report = JSON.parse(exported.serialized);
  return { report, journal: report.journal.map(event => [event.code, event.fields]) };
}

describe('the diagnostics export with events a later build journaled (#214)', () => {
  it('leaves out an event with a code this build has no entry for and one with a field its evidence lacks, keeps the rest, and says how many it left out (#214, case 1)', async () => {
    const { profile, clock, records, journal } = await exportOn();
    journal.event('capture.failed', { ...KNOWN });
    await journal.flush();
    await laterBuildWrote(profile, 'journal', [
      { at: clock.now(), code: 'later.build-event', fields: { count: 1 } },
      { at: clock.now(), code: 'capture.failed', fields: { surface: 'worker-internal', laterField: 1 } },
    ]);
    journal.event('capture.failed', { ...KNOWN, retryable: true });
    // A third, so the kept count and the left-out count differ
    journal.event('capture.failed', { ...KNOWN, retryable: false });
    await journal.flush();
    const exported = await buildDiagnostics({ records, journal, clock, versions: VERSIONS });
    const { report, journal: kept } = reportOf(exported);
    assert.deepEqual(
      kept,
      [
        ['capture.failed', { ...KNOWN }],
        ['capture.failed', { ...KNOWN, retryable: true }],
        ['capture.failed', { ...KNOWN, retryable: false }],
      ],
      'the events this build knows are kept, in their order',
    );
    assert.equal(report.journalLeftOut, 2, 'both later events are left out, and counted');
    assert.deepEqual(
      Object.keys(report).slice(11, 14),
      ['journal', 'journalLeftOut', 'rejected'],
      'the count is beside the journal',
    );
    assert.ok(
      exported.fields.some(field => field.field === 'journalLeftOut' && field.value === 2),
      'the preview lists the count, as it lists every field',
    );
    assert.deepEqual(exported.fields, leaves(report));
    assert.ok(v.is(reportSchema, report), "the report is one this build's schema takes");
  });

  it('leaves out, and counts, an event this build knows whose field holds a value its evidence refuses, or that has a key its events lack, so no bad record reaches the report (#214, case 2)', async () => {
    const { profile, clock, records, journal } = await exportOn();
    journal.event('capture.failed', { ...KNOWN });
    await journal.flush();
    await laterBuildWrote(profile, 'journal', [
      {
        at: clock.now(),
        code: 'capture.failed',
        fields: { surface: 'worker-internal', errorCode: 'later-build-code' },
      },
      // A known code and fields, in an event with a key this build's events don't have
      { at: clock.now(), code: 'capture.failed', fields: { surface: 'worker-internal' }, laterKey: 1 },
    ]);
    const exported = await buildDiagnostics({ records, journal, clock, versions: VERSIONS });
    const { report, journal: kept } = reportOf(exported);
    assert.deepEqual(kept, [['capture.failed', { ...KNOWN }]], 'only the event that passes is kept');
    assert.equal(
      report.journalLeftOut,
      2,
      'the event with the refused value and the one with the later key are left out',
    );
  });

  it('says nothing of a count when no event was left out, so such a report is as it was (#214)', async () => {
    const { clock, records, journal } = await exportOn();
    journal.event('capture.failed', { ...KNOWN });
    await journal.flush();
    const { report } = reportOf(await buildDiagnostics({ records, journal, clock, versions: VERSIONS }));
    assert.equal(Object.hasOwn(report, 'journalLeftOut'), false);
  });

  it("still refuses the whole report for a run a later build wrote that fails this build's schema: only the journal's events are left out (#214's guard)", async () => {
    const { profile, clock, records, journal } = await exportOn();
    await laterBuildWrote(profile, 'runs', [{ id: 'a1b2-later-run', startedAt: clock.now(), laterField: 1 }]);
    await assert.rejects(buildDiagnostics({ records, journal, clock, versions: VERSIONS }), /diagnostic report refused/);
  });
});
