// #20 slice 4c, PR 2 (Q4): recovery.html's words for the problems that had none, as the lead
// signed them on 2026-11-07: a purge that stopped at a recovery point (#17 PR 2b), and the
// background worker's two (#117), which fold into NewTabNote's own parts. At capture risk from the
// worker's problem, the Trust Center's headline names it by its title, on recovery.html's own
// summary too, which leaves the worker's providers out of every group. Read together (the design
// review's round 2), no Still works list claims what an unfixed problem lists as not working, and
// a row that needs the user because of a problem says which. No check on recovery.html covers the
// worker, so the rows that hold its problems take their shape and words, Saving new notes among
// them while it stops saving new notes (the coordinator's ruling, signed as round 3).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_CODES } from '../../js/trust/core/event-codes.js';
import { rowsOn } from '../../js/trust/core/providers/rows.js';
import { summarize } from '../../js/trust/core/summary.js';
import { INCIDENT, INCIDENT_TEXT, RESOLVED } from '../../js/trust/ui/copy.js';
import { problemsOf, trustHeadline, trustSections } from '../../js/trust/ui/model.js';

const AT = new Date(2026, 10, 7, 18, 42).getTime();

/**
 * A provider's entry in trust.report, verified at AT
 * @param {string} providerId
 * @param {string} group
 * @param {Record<string, unknown>} [fields]
 */
const entry = (providerId, group, fields = {}) =>
  /** @type {any} */ ({
    providerId,
    group,
    core: providerId === 'capture' || providerId === 'storage',
    operation: `${providerId}.check`,
    costClass: 'local-cheap',
    freshnessMs: 86_400_000,
    status: 'verified',
    receipt: {
      id: `00000000-0000-4000-8000-0000000000${providerId === 'capture' ? 'c1' : providerId === 'storage' ? 'c2' : 'c3'}`,
      providerId,
      verifiedAt: AT,
      durationMs: 1,
      freshnessMs: 86_400_000,
      operation: `${providerId}.check`,
      consequenceKey: null,
      preserved: ['capture', 'editing', 'reading'],
      nextAction: null,
      executionClass: 'local-cheap',
      status: 'verified',
      capture: providerId === 'capture' || providerId === 'storage' ? 'safe' : undefined,
      evidence: {},
    },
    next: null,
    stillWorks: ['capture', 'editing', 'reading'],
    ...fields,
  });

/** The background worker's start that failed, a capture risk, as its event raises it */
const START_FAILED = /** @type {any} */ ({
  id: '00000000-0000-4000-8000-0000000000e1',
  ref: '0000e1',
  key: 'coordinator/start-failed',
  providerId: 'coordinator',
  faultCode: 'start-failed',
  subjectId: null,
  severity: 'capture-risk',
  state: 'open',
  dismissed: false,
  dismissChangedAt: null,
  firstSeenAt: AT,
  lastSeenAt: AT,
  resolvedAt: null,
  occurrences: 1,
  affected: ['capture'],
  preserved: ['editing', 'reading'],
  evidence: {},
  appliedOps: [],
});

/** A change the journal kept and couldn't replay, a data risk that keeps capture, as its event raises it */
const KEPT = /** @type {any} */ ({
  ...START_FAILED,
  id: '00000000-0000-4000-8000-0000000000e2',
  ref: '0000e2',
  key: 'coordinator/entry-unreplayable',
  faultCode: 'entry-unreplayable',
  severity: 'data-risk',
  affected: [],
  preserved: ['capture', 'editing', 'reading'],
});

/** A key saved as plain text, which a credentials row holds */
const SAVED_KEY = /** @type {any} */ ({
  ...START_FAILED,
  id: '00000000-0000-4000-8000-0000000000e3',
  ref: '0000e3',
  key: 'credentials/legacy-secret/setting_llmApiKey',
  providerId: 'credentials',
  faultCode: 'legacy-secret',
  subjectId: 'setting_llmApiKey',
  severity: 'data-risk',
  affected: [],
  preserved: [],
});

/** A purge that stopped at a recovery point, as its event raises it */
const PURGE = /** @type {any} */ ({
  ...START_FAILED,
  id: '00000000-0000-4000-8000-0000000000e4',
  ref: '0000e4',
  key: 'recovery-readiness/purge-stopped/pre-migration-1762300000000',
  providerId: 'recovery-readiness',
  faultCode: 'purge-stopped',
  subjectId: 'pre-migration-1762300000000',
  severity: 'degraded',
  affected: [],
  preserved: [],
});

/** recovery.html's report: every core row verified, and the worker's start failed */
const REPORT = /** @type {any} */ ({
  records: 'open',
  providers: [entry('capture', 'storage'), entry('storage', 'storage'), entry('messaging', 'platform')],
  incidents: [START_FAILED],
  copyRead: true,
  recordsRead: true,
  runs: [],
});

/**
 * Its summary as recovery.html's root answers it: summarize over the providers that run there,
 * which leave the background worker's out, so its problem puts capture at risk and is no group's
 * cause
 */
const SUMMARY = summarize({
  providers: rowsOn('recovery'),
  receipts: REPORT.providers.map((/** @type {any} */ provider) => provider.receipt),
  incidents: REPORT.incidents,
  copyRead: true,
  recordsRead: true,
  recordsState: 'open',
  now: AT,
});

describe("recovery.html's words for a stopped purge and the background worker's problems (#20 slice 4c, Q4)", () => {
  it('gives every fault an event raises a title, open and fixed', () => {
    /** @param {Record<string, string>} table @param {string} key */
    const titled = (table, key) => Object.keys(table).some(name => name === key || name.startsWith(`${key}/`));
    const raised = Object.values(EVENT_CODES).flatMap(code =>
      'incident' in code && code.incident ? [code.incident] : [],
    );
    assert.ok(raised.length > 5, 'the event codes raise incidents');
    for (const { providerId, faultCode } of raised) {
      const key = `${providerId}/${faultCode}`;
      assert.ok(titled(INCIDENT, key), `${key} has a title`);
      assert.ok(titled(RESOLVED, key), `${key} has a title for when it's fixed`);
    }
  });

  it("says them in the signed words, the stopped purge's text as round 3 has it", () => {
    assert.deepEqual(
      ['recovery-readiness/purge-stopped', 'coordinator/start-failed', 'coordinator/entry-unreplayable'].map(key => [
        /** @type {Record<string, string>} */ (INCIDENT)[key],
        /** @type {Record<string, string>} */ (INCIDENT_TEXT)[key],
        /** @type {Record<string, string>} */ (RESOLVED)[key],
      ]),
      [
        [
          'Something you deleted is still in a recovery point',
          "When you delete something for good, NewTabNote also removes it from its recovery points. One recovery point didn't pass its check, so what you deleted is still in it. Nothing else changed.",
          'What you deleted is out of every recovery point',
        ],
        [
          "The background worker couldn't start",
          'New notes and changes may not be saved until it starts.',
          'The background worker starts again',
        ],
        [
          "A change NewTabNote kept isn't in your notes yet",
          "NewTabNote kept it, so nothing is lost, but it couldn't add it to your notes as it was written.",
          'Every kept change is in your notes',
        ],
      ],
    );
  });

  it("folds the background worker's problems into NewTabNote's own parts, whose row needs attention and which its card links to", () => {
    const rows = trustSections(REPORT, { now: AT }).flatMap(section => section.rows);
    const platform = /** @type {any} */ (rows.find(row => row.id === 'platform'));
    assert.deepEqual(
      [
        platform.attention,
        platform.open.map((/** @type {any} */ incident) => incident.id),
        platform.action && platform.action.incidentId,
      ],
      [true, [START_FAILED.id], START_FAILED.id],
    );
    const [problem] = problemsOf([START_FAILED], new Map(), () => null);
    assert.deepEqual([problem.title, problem.rowId], ["The background worker couldn't start", 'platform']);
  });

  it("names the worker's capture-risk problem in the headline, by its title, from recovery.html's own summary, where it's no group's cause", () => {
    assert.deepEqual(
      [SUMMARY.capture, SUMMARY.groups.filter(group => group.cause !== null).map(group => group.group)],
      ['at-risk', []],
      "the worker's problem puts capture at risk, and no group on recovery.html has it",
    );
    const rows = trustSections(REPORT, { now: AT }).flatMap(section => section.rows);
    const head = trustHeadline(SUMMARY, rows, { now: AT, checking: false });
    assert.deepEqual(
      [head.tone, head.title, head.proof, head.openRecovery],
      ['failed', 'New notes may not be saved', "The background worker couldn't start.", true],
    );
  });

  it("leaves out of every card's and row's Still works what an unfixed problem on the page lists as not working, so the two views keep one list (the design review's round 2, S2)", () => {
    // r2-11: the worker's start failed, beside a kept change and a saved key whose lists keep
    // saving new notes
    const report = /** @type {any} */ ({
      ...REPORT,
      providers: [...REPORT.providers, entry('credentials', 'vault')],
      incidents: [START_FAILED, KEPT, SAVED_KEY],
    });
    const providerOf = (/** @type {string} */ id) =>
      report.providers.find((/** @type {any} */ provider) => provider.providerId === id) || null;
    const cards = problemsOf(report.incidents, new Map(), providerOf);
    assert.deepEqual(
      cards.map(problem => [problem.title, problem.stillWorks, problem.notWorking]),
      [
        ["The background worker couldn't start", ['editing', 'reading'], ['capture']],
        ["A change NewTabNote kept isn't in your notes yet", ['editing', 'reading'], []],
        ['A key is saved as plain text', ['editing', 'reading'], []],
      ],
    );
    const rows = trustSections(report, { now: AT }).flatMap(section => section.rows);
    assert.deepEqual(
      rows
        .filter(row => row.id === 'credentials' || row.id === 'platform')
        .map(row => [row.id, row.attention, row.stillWorks, row.notWorking]),
      [
        ['credentials', true, ['editing', 'reading'], []],
        ['platform', true, ['editing', 'reading'], ['capture']],
      ],
    );
    // A problem that's fixed lists nothing: once the worker starts again, saving new notes still works
    const fixed = { ...START_FAILED, state: 'resolved', resolvedAt: AT };
    const [kept] = problemsOf([fixed, KEPT], new Map(), providerOf).filter(problem => !problem.resolved);
    assert.deepEqual(kept.stillWorks, ['capture', 'editing', 'reading']);
  });

  it("puts the problem's title on the line of a row that needs the user because of it, and the rows that hold the worker's problem take its shape and words with no time, since no check on recovery.html covers the worker (the design review's round 2, S3, and the coordinator's ruling)", () => {
    // r2-12: the worker's two problems, and the purge stopped at a point no check here has read
    const report = /** @type {any} */ ({
      ...REPORT,
      providers: [
        ...REPORT.providers,
        entry('recovery-readiness', 'recovery', { status: 'unverified', receipt: null, stillWorks: [] }),
      ],
      incidents: [START_FAILED, KEPT, PURGE],
    });
    const rows = trustSections(report, { now: AT }).flatMap(section => section.rows);
    const worker = "The background worker couldn't start.";
    assert.deepEqual(
      rows.filter(row => row.attention).map(row => [row.id, row.status, row.statusText, row.tone, row.time, row.text]),
      [
        // Saving new notes follows the worker's problem while it stops saving new notes
        ['capture', 'failed', 'Not working', 'failed', null, worker],
        [
          'recovery-readiness',
          'unverified',
          'Not verified yet',
          'unknown',
          null,
          'Something you deleted is still in a recovery point.',
        ],
        ['platform', 'failed', 'Not working', 'failed', null, worker],
      ],
    );
    const capture = /** @type {any} */ (rows.find(row => row.id === 'capture'));
    assert.deepEqual(
      [capture.open.map((/** @type {any} */ incident) => incident.id), capture.notWorking, capture.action],
      [
        [START_FAILED.id],
        ['capture'],
        { kind: 'recovery', label: 'See it in Recovery Center', incidentId: START_FAILED.id },
      ],
    );
    // The kept change alone stops nothing: Saving new notes reads as its check found it, and
    // the folded row takes the change's shape and words
    const kept = trustSections({ ...report, incidents: [KEPT] }, { now: AT }).flatMap(section => section.rows);
    assert.deepEqual(
      kept
        .filter(row => row.id === 'capture' || row.id === 'platform')
        .map(row => [row.id, row.attention, row.statusText, row.tone, row.text]),
      [
        ['capture', false, 'Verified', 'ok', 'New notes, quick notes, and captured pages.'],
        ['platform', true, 'Needs action', 'action', "A change NewTabNote kept isn't in your notes yet."],
      ],
    );
    // A row whose own check found its problem keeps the check's words, which the headline's proof
    // reads: the test save that failed for want of space
    const space = /** @type {any} */ ({
      ...REPORT,
      providers: [
        entry('capture', 'storage', {
          status: 'failed',
          receipt: {
            ...entry('capture', 'storage').receipt,
            status: 'failed',
            capture: 'at-risk',
            consequenceKey: 'storage.capture-at-risk',
            preserved: ['reading'],
          },
          stillWorks: ['reading'],
        }),
        entry('storage', 'storage'),
        entry('messaging', 'platform'),
      ],
      incidents: [
        {
          ...START_FAILED,
          id: '00000000-0000-4000-8000-0000000000e5',
          ref: '0000e5',
          key: 'capture/quota/CanvasTabDB',
          providerId: 'capture',
          faultCode: 'quota',
          subjectId: 'CanvasTabDB',
          preserved: ['reading'],
        },
      ],
    });
    const probed = /** @type {any} */ (
      trustSections(space, { now: AT })
        .flatMap(section => section.rows)
        .find(row => row.id === 'capture')
    );
    assert.deepEqual(
      [probed.attention, probed.text],
      [true, "NewTabNote couldn't save a test entry, so new notes and captures may not be saved."],
    );
    // A problem a check here covers stays on its own row, though it stops saving new notes too:
    // Notes database holds the database that won't open, and Saving new notes reads as its check
    // found it
    const unopened = /** @type {any} */ ({
      ...REPORT,
      incidents: [
        {
          ...START_FAILED,
          id: '00000000-0000-4000-8000-0000000000e6',
          ref: '0000e6',
          key: 'storage/open-failed/CanvasTabDB',
          providerId: 'storage',
          faultCode: 'open-failed',
          subjectId: 'CanvasTabDB',
          affected: ['capture', 'editing', 'reading'],
          preserved: [],
        },
      ],
    });
    assert.deepEqual(
      trustSections(unopened, { now: AT })
        .flatMap(section => section.rows)
        .filter(row => row.attention)
        .map(row => row.id),
      ['storage'],
    );
  });
});
