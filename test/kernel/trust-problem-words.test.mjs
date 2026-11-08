// #20 slice 4c, PR 2 (Q4): recovery.html's words for the problems that had none, as the lead
// signed them on 2026-11-07: a purge that stopped at a recovery point (#17 PR 2b), and the
// background worker's two (#117), which fold into NewTabNote's own parts. At capture risk from a
// problem no core row explains, the Trust Center's headline names it by its title.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_CODES } from '../../js/trust/core/event-codes.js';
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

/** recovery.html's report: every core row verified, and the worker's start failed */
const REPORT = /** @type {any} */ ({
  records: 'open',
  providers: [entry('capture', 'storage'), entry('storage', 'storage'), entry('messaging', 'platform')],
  incidents: [START_FAILED],
  copyRead: true,
  recordsRead: true,
  runs: [],
});

/** Its summary: capture at risk, from the worker's problem, which is the platform group's cause */
const SUMMARY = /** @type {any} */ ({
  worstCore: 'verified',
  capture: 'at-risk',
  actionRequired: 1,
  route: 'recovery',
  records: 'open',
  groups: [
    { group: 'storage', providers: 2, needsAction: 0, worst: 'verified', checkedAt: AT, cause: null },
    {
      group: 'platform',
      providers: 1,
      needsAction: 1,
      worst: 'verified',
      checkedAt: AT,
      cause: {
        from: 'incident',
        providerId: 'coordinator',
        faultCode: 'start-failed',
        errorCode: null,
        severity: 'capture-risk',
        consequenceKey: null,
        incidentId: START_FAILED.id,
        at: AT,
      },
    },
  ],
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

  it('says them in the signed words', () => {
    assert.deepEqual(
      ['recovery-readiness/purge-stopped', 'coordinator/start-failed', 'coordinator/entry-unreplayable'].map(key => [
        /** @type {Record<string, string>} */ (INCIDENT)[key],
        /** @type {Record<string, string>} */ (INCIDENT_TEXT)[key],
        /** @type {Record<string, string>} */ (RESOLVED)[key],
      ]),
      [
        [
          'Something you deleted is still in a recovery point',
          "NewTabNote takes what you delete for good out of its recovery points too. It stopped at a point that didn't pass its check, so what you deleted is still in that point. Nothing else changed.",
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

  it('names a capture-risk problem no core row explains in the headline, by its title', () => {
    const rows = trustSections(REPORT, { now: AT }).flatMap(section => section.rows);
    const head = trustHeadline(SUMMARY, rows, { now: AT, checking: false });
    assert.deepEqual(
      [head.tone, head.title, head.proof, head.openRecovery],
      ['failed', 'New notes may not be saved', "The background worker couldn't start.", true],
    );
  });
});
