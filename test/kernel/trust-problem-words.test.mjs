// #20 slice 4c, PR 2 (Q4): recovery.html's words for the problems that had none, as signed on
// 2026-11-07: a purge that stopped at a recovery point (#17 PR 2b), and the
// background worker's two (#117), which fold into NewTabNote's own parts. At capture risk from the
// worker's problem, the Trust Center's headline names it by its title, on recovery.html's own
// summary too, which leaves the worker's providers out of every group. Read together (the design
// review's round 2), no Still works list claims what an unfixed problem lists as not working, and
// a row that needs the user because of a problem says which. No check on recovery.html covers the
// worker, so the rows that hold its problems take their shape and words, Saving new notes among
// them while it stops saving new notes (decided at the Design gate, signed as round 3).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EVENT_CODES } from '../../js/trust/core/event-codes.js';
import { PROVIDER_ROWS, rowsOn } from '../../js/trust/core/providers/rows.js';
import { narrowStatus } from '../../js/trust/core/status-message.js';
import { leadingOf, summarize } from '../../js/trust/core/summary.js';
import { OPEN_FAILED_KEY, WRITE_FAILED_KEY } from '../../js/trust/core/trust-records.js';
import { HEALTH_GROUPS } from '../../js/trust/core/vocabulary.js';
import { INCIDENT, INCIDENT_TEXT, PAGE, RESOLVED } from '../../js/trust/ui/copy.js';
import { attentionText, problemsOf, trustHeadline, trustSections } from '../../js/trust/ui/model.js';
import { statusOf } from '../../js/trust/ui/status.js';
import { GROUP } from '../../js/trust/ui/status-copy.js';

const AT = new Date(2026, 10, 7, 18, 42).getTime();
const ROOT = path.join(import.meta.dirname, '..', '..');

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

  it("puts the problem's title on the line of a row that needs the user because of it, and the rows that hold the worker's problem take its shape and words with no time, since no check on recovery.html covers the worker (the design review's round 2, S3, and the Design gate)", () => {
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
          'degraded',
          'Partly working',
          'partial',
          null,
          'Something you deleted is still in a recovery point.',
        ],
        ['platform', 'failed', 'Not working', 'failed', null, worker],
      ],
    );
    const capture = /** @type {any} */ (rows.find(row => row.id === 'capture'));
    assert.deepEqual(
      [capture.open.map((/** @type {any} */ incident) => incident.id), capture.notWorking, capture.action],
      [[START_FAILED.id], [], { kind: 'recovery', label: 'See it in Recovery Center', incidentId: START_FAILED.id }],
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

  it("leads the evidence of the rows that hold the worker's failed start with it, their own checks after it as they read, gives a row with a finding its finding's status, and leaves saving new notes out of Saving new notes' own Not working (round 4)", () => {
    const report = /** @type {any} */ ({
      ...REPORT,
      providers: [
        ...REPORT.providers,
        entry('recovery-readiness', 'recovery', { status: 'unverified', receipt: null, stillWorks: [] }),
        entry('local-inference', 'inference', { status: 'unverified', receipt: null, stillWorks: [] }),
      ],
      incidents: [START_FAILED, PURGE],
    });
    const rows = trustSections(report, { now: AT }).flatMap(section => section.rows);
    const row = (/** @type {string} */ id) => /** @type {any} */ (rows.find(item => item.id === id));
    /** @param {any} item */
    const shown = item => [item.title, item.statusText, item.tone, Boolean(item.problem)];
    // Saving new notes' "How this was checked" names the worker's failed start as its evidence,
    // and its own passing write check after it, as passed
    const [failed, own] = row('capture').evidence;
    assert.deepEqual(
      [shown(failed), failed.sentence, failed.facts.map((/** @type {any} */ fact) => fact.label), shown(own)],
      [
        ["The background worker couldn't start", 'Not working', 'failed', true],
        'New notes and changes may not be saved until it starts.',
        [PAGE.firstSeen, PAGE.lastSeen, PAGE.timesSeen, PAGE.ref],
        ['Saving new notes', 'Verified', 'ok', false],
      ],
    );
    // NewTabNote's own parts the same, before the parts its checks read
    assert.deepEqual(row('platform').evidence.map(shown), [
      ["The background worker couldn't start", 'Not working', 'failed', true],
      ['Background worker', 'Verified', 'ok', false],
    ]);
    // A row with a finding takes its status and shape; one with none keeps Not verified yet
    assert.deepEqual(
      ['recovery-readiness', 'local-inference'].map(id => [
        id,
        row(id).status,
        row(id).statusText,
        row(id).tone,
        row(id).attention,
      ]),
      [
        ['recovery-readiness', 'degraded', 'Partly working', 'partial', true],
        ['local-inference', 'unverified', 'Not verified yet', 'unknown', false],
      ],
    );
    // Saving new notes' name and status say saving new notes isn't working; its own parts list it
    assert.deepEqual([row('capture').notWorking, row('platform').notWorking], [[], ['capture']]);
  });

  it("counts the rest as other under a headline a problem leads, to match the header's badge, and as signed under one it doesn't (round 4)", () => {
    // r2-12: the worker's failed start leads; Recovery points and NewTabNote's own parts follow
    const report = /** @type {any} */ ({
      ...REPORT,
      providers: [
        ...REPORT.providers,
        entry('recovery-readiness', 'recovery', { status: 'unverified', receipt: null, stillWorks: [] }),
      ],
      incidents: [START_FAILED, KEPT, PURGE],
    });
    const rows = trustSections(report, { now: AT }).flatMap(section => section.rows);
    const head = trustHeadline(SUMMARY, rows, { now: AT, checking: false });
    assert.equal(
      attentionText(head.attention, head.openRecovery),
      "2 other things need your attention: Recovery points and NewTabNote's own parts.",
    );
    const keys = { id: 'credentials', label: 'Saved keys' };
    const access = { id: 'permissions', label: 'Permissions' };
    assert.deepEqual(
      [
        attentionText([keys], true),
        attentionText([keys]),
        attentionText([keys, access]),
        attentionText([keys, access, { id: 'backup', label: 'Backups' }], true),
      ],
      [
        '1 other thing needs your attention: Saved keys.',
        '1 thing needs your attention: Saved keys.',
        '2 things need your attention: Saved keys and Permissions.',
        'Saved keys and 2 more need your attention.',
      ],
    );
  });

  it("lays recovery.html's cards and rows out as the Design gate's review of round 3 asked: card text that wraps pretty, a balanced attention line, each row's link at its far end, and a card's lone link on a line of text at the card's far end, the Undo link's way, each link's target 44px tall at least (round 4, and the code review's R4-3)", () => {
    const sheet = fs.readFileSync(path.join(ROOT, 'css', 'recovery.css'), 'utf8');
    /** The declarations of the first rule whose selector is exactly `selector` */
    const rule = (/** @type {string} */ selector) => {
      const start = sheet.indexOf(`\n${selector} {\n`);
      assert.ok(start >= 0, `css/recovery.css has a ${selector} rule`);
      return sheet.slice(start, sheet.indexOf('\n}', start));
    };
    // "changed." no longer alone on a card's last line, and "NewTabNote's own / parts." no more
    assert.match(rule('.trust-incident-body'), /\n {2}text-wrap: pretty;/);
    assert.match(rule('.trust-attention-line'), /\n {2}text-wrap: balance;/);
    // "See it in Recovery Center" at the row's far end, with evidence before it or none
    assert.match(rule('.trust-row-actions'), /^\n\.trust-row-actions \{\n {2}margin-left: auto;$/);
    // A card with no Dismiss: its link alone on a line of text at the card's far end, so no
    // button-high band, and the link the Undo link's way: inline on its baseline, with half of
    // 44px less 1em above and below the text's own box, 1em tall or more, so each link's target
    // is 44px tall at least without making its line taller
    assert.match(
      rule('.trust-incident-actions:has(> .trust-crosslink:only-child)'),
      /^\n\.trust-incident-actions:has\(> \.trust-crosslink:only-child\) \{\n {2}display: block;\n {2}text-align: end;$/,
    );
    /** A rule's declarations, after its selector */
    const declarations = (/** @type {string} */ selector) => rule(selector).slice(rule(selector).indexOf('{') + 1);
    const undo =
      '\n  display: inline;\n  min-height: 0;\n  padding: calc((var(--target-min) - 1em) / 2) 0;\n  vertical-align: baseline;';
    assert.deepEqual(
      [
        declarations('.trust-incident-actions > .trust-crosslink:only-child'),
        declarations('.trust-notice .trust-linkbtn'),
      ],
      [undo, undo],
    );
  });

  it("counts as other only a row that holds a problem besides the ones the headline leads with: none for the worker's failed start alone, and none for the records' own at can't confirm (round 4b)", () => {
    const withRows = (/** @type {any[]} */ providers, /** @type {any[]} */ incidents) =>
      trustSections(/** @type {any} */ ({ ...REPORT, providers: [...REPORT.providers, ...providers], incidents }), {
        now: AT,
      }).flatMap(section => section.rows);
    const ids = (/** @type {any} */ head) => head.attention.map((/** @type {any} */ row) => row.id);
    const readiness = entry('recovery-readiness', 'recovery', { status: 'unverified', receipt: null, stillWorks: [] });
    // At capture risk: NewTabNote's own parts holds only the failed start the headline names
    const alone = trustHeadline(SUMMARY, withRows([], [START_FAILED]), { now: AT, checking: false });
    const beside = trustHeadline(SUMMARY, withRows([readiness], [START_FAILED, PURGE]), { now: AT, checking: false });
    assert.deepEqual([ids(alone), ids(beside)], [[], ['recovery-readiness']]);
    // At can't confirm: Notes database holds only the records' own problem, which the headline names
    const RECORDS = /** @type {any} */ ({
      ...START_FAILED,
      id: '00000000-0000-4000-8000-0000000000e7',
      ref: '0000e7',
      key: 'storage/open-failed/NewTabNoteTrust',
      providerId: 'storage',
      faultCode: 'open-failed',
      subjectId: 'NewTabNoteTrust',
      severity: 'data-risk',
      affected: [],
      preserved: [],
    });
    const blind = /** @type {any} */ ({ ...SUMMARY, capture: 'unknown', route: 'recovery', records: 'fallback' });
    const keys = entry('credentials', 'vault');
    const records = trustHeadline(blind, withRows([keys], [RECORDS]), { now: AT, checking: false });
    const andKeys = trustHeadline(blind, withRows([keys], [RECORDS, SAVED_KEY]), { now: AT, checking: false });
    assert.deepEqual(
      [records.title, ids(records), ids(andKeys)],
      ["NewTabNote can't confirm your notes are saving", [], ['credentials']],
    );
  });

  /**
   * The row of `providerId`, whose check passed, holding a finding of its own, which its check
   * covers, after `also`
   * @param {string} providerId
   * @param {string} group
   * @param {string} faultCode
   * @param {string} severity
   * @param {string[]} affected
   * @param {any[]} [also]
   */
  const findingOver = (providerId, group, faultCode, severity, affected, also = []) => {
    const finding = /** @type {any} */ ({
      ...START_FAILED,
      id: '00000000-0000-4000-8000-0000000000e8',
      ref: '0000e8',
      key: `${providerId}/${faultCode}`,
      providerId,
      faultCode,
      severity,
      affected,
      preserved: [],
    });
    const own = REPORT.providers.some((/** @type {any} */ item) => item.providerId === providerId);
    const providers = own ? REPORT.providers : [...REPORT.providers, entry(providerId, group)];
    const rows = trustSections(/** @type {any} */ ({ ...REPORT, providers, incidents: [...also, finding] }), {
      now: AT,
    }).flatMap(section => section.rows);
    return /** @type {any} */ (rows.find(row => row.id === providerId));
  };
  /** @param {any} item */
  const shownEvidence = item => [item.title, item.statusText, item.tone, Boolean(item.problem)];

  it("leads a row's evidence with every problem that makes it worse than its check found, one its own check covers as well as one no check here covers: a page capture that wasn't saved, after the worker's failed start, over a write check that passed (round 4b)", () => {
    const earlier = { ...START_FAILED, firstSeenAt: AT - 120_000, lastSeenAt: AT - 60_000 };
    const capture = findingOver('capture', 'storage', 'capture-failed', 'capture-risk', ['capture'], [earlier]);
    assert.deepEqual(
      [capture.evidence.map(shownEvidence), capture.evidence[0].facts.map((/** @type {any} */ fact) => fact.label)],
      [
        [
          ["A page capture wasn't saved", 'Not working', 'failed', true],
          ["The background worker couldn't start", 'Not working', 'failed', true],
          ['Saving new notes', 'Verified', 'ok', false],
        ],
        [PAGE.firstSeen, PAGE.lastSeen, PAGE.timesSeen, PAGE.ref],
      ],
    );
  });

  it("gives Search, its check passed, a degraded finding's Partly working, and leads its evidence with the finding (round 4b)", () => {
    const index = findingOver('index', 'indexing', 'indexer-start-failed', 'degraded', []);
    assert.deepEqual(
      [index.status, index.statusText, index.evidence.map(shownEvidence)],
      [
        'degraded',
        'Partly working',
        [
          ["Search indexing didn't start", 'Partly working', 'partial', true],
          ['Search', 'Verified', 'ok', false],
        ],
      ],
    );
  });

  it("gives Backups, its check passed, a data-risk finding's Needs action, and leads its evidence with the finding (round 4b)", () => {
    const backup = findingOver('backup', 'backup', 'auto-backup-failed', 'data-risk', []);
    assert.deepEqual(
      [backup.status, backup.statusText, backup.evidence.map(shownEvidence)],
      [
        'action-required',
        'Needs action',
        [
          ["An automatic backup didn't finish", 'Needs action', 'action', true],
          ['Backups', 'Verified', 'ok', false],
        ],
      ],
    );
  });

  it("gives Saving new notes, its check passed, a capture-risk finding's Not working, and leads its evidence with the finding (round 4b)", () => {
    const capture = findingOver('capture', 'storage', 'capture-failed', 'capture-risk', ['capture']);
    assert.deepEqual(
      [capture.status, capture.statusText, capture.evidence.map(shownEvidence)],
      [
        'failed',
        'Not working',
        [
          ["A page capture wasn't saved", 'Not working', 'failed', true],
          ['Saving new notes', 'Verified', 'ok', false],
        ],
      ],
    );
  });

  it("leaves a row's own check to speak for it when its finding is no worse than what the check found, and still leads with a problem no check here covers: Backups' check and finding both Needs action, and Saving new notes' check Not working beside the worker's failed start (round 4b)", () => {
    /** A provider's entry whose check found `status` */
    const found = (/** @type {string} */ providerId, /** @type {string} */ group, /** @type {string} */ status) =>
      entry(providerId, group, { status, receipt: { ...entry(providerId, group).receipt, status } });
    const backupFailed = /** @type {any} */ ({
      ...START_FAILED,
      id: '00000000-0000-4000-8000-0000000000e9',
      ref: '0000e9',
      key: 'backup/auto-backup-failed',
      providerId: 'backup',
      faultCode: 'auto-backup-failed',
      severity: 'data-risk',
      affected: [],
      preserved: [],
    });
    const others = REPORT.providers.filter((/** @type {any} */ item) => item.providerId !== 'capture');
    const report = /** @type {any} */ ({
      ...REPORT,
      providers: [found('capture', 'storage', 'failed'), ...others, found('backup', 'backup', 'action-required')],
      incidents: [START_FAILED, backupFailed],
    });
    const rows = trustSections(report, { now: AT }).flatMap(section => section.rows);
    const row = (/** @type {string} */ id) => /** @type {any} */ (rows.find(item => item.id === id));
    assert.deepEqual(
      [row('backup').evidence.map(shownEvidence), row('capture').evidence.map(shownEvidence)],
      [
        [['Backups', 'Needs action', 'action', false]],
        [
          ["The background worker couldn't start", 'Not working', 'failed', true],
          ['Saving new notes', 'Not working', 'failed', false],
        ],
      ],
    );
  });

  it("leads a row's evidence with a finding only where a check has read the row, besides the worker's own problem: Recovery points and Local model, unchecked, keep their finding's status and no evidence (round 4b)", () => {
    const LOAD_FAILED = /** @type {any} */ ({
      ...START_FAILED,
      id: '00000000-0000-4000-8000-0000000000ea',
      ref: '0000ea',
      key: 'local-inference/load-failed',
      providerId: 'local-inference',
      faultCode: 'load-failed',
      severity: 'degraded',
      affected: [],
      preserved: [],
    });
    const unchecked = (/** @type {string} */ providerId, /** @type {string} */ group) =>
      entry(providerId, group, { status: 'unverified', receipt: null, stillWorks: [] });
    const report = /** @type {any} */ ({
      ...REPORT,
      providers: [
        ...REPORT.providers,
        unchecked('recovery-readiness', 'recovery'),
        unchecked('local-inference', 'inference'),
      ],
      incidents: [START_FAILED, PURGE, LOAD_FAILED],
    });
    const rows = trustSections(report, { now: AT }).flatMap(section => section.rows);
    const row = (/** @type {string} */ id) => /** @type {any} */ (rows.find(item => item.id === id));
    assert.deepEqual(
      ['recovery-readiness', 'local-inference', 'capture'].map(id => [
        id,
        row(id).statusText,
        row(id).evidence.map(shownEvidence),
      ]),
      [
        ['recovery-readiness', 'Partly working', []],
        ['local-inference', 'Partly working', []],
        // The worker's failed start still leads where no check covers it
        [
          'capture',
          'Not working',
          [
            ["The background worker couldn't start", 'Not working', 'failed', true],
            ['Saving new notes', 'Verified', 'ok', false],
          ],
        ],
      ],
    );
  });

  it("leaves out of the line under a problem that leads a row the user needs only by its check's status, as the header's badge counts no such row, and keeps it under a headline no problem leads: Saved keys, its key dismissed while its check still asks (round 4b)", () => {
    const passed = entry('credentials', 'vault');
    const asks = entry('credentials', 'vault', {
      status: 'action-required',
      receipt: { ...passed.receipt, status: 'action-required' },
    });
    const dismissedKey = /** @type {any} */ ({ ...SAVED_KEY, dismissed: true, dismissChangedAt: AT });
    const providers = [...REPORT.providers, asks];
    /** @param {any[]} incidents */
    const headOf = incidents => {
      const rows = trustSections(/** @type {any} */ ({ ...REPORT, providers, incidents }), { now: AT }).flatMap(
        section => section.rows,
      );
      const summary = summarize({
        providers: rowsOn('recovery'),
        receipts: providers.map(provider => provider.receipt),
        incidents,
        copyRead: true,
        recordsRead: true,
        recordsState: 'open',
        now: AT,
      });
      return trustHeadline(summary, rows, { now: AT, checking: false });
    };
    const leading = headOf([START_FAILED, dismissedKey]);
    const plain = headOf([dismissedKey]);
    assert.deepEqual(
      [leading.title, leading.attention, plain.title, plain.attention.map(row => row.id)],
      [PAGE.atRisk, [], PAGE.saving, ['credentials']],
    );
  });

  it("counts the same things as other in Settings and in the Trust Center, from the same records, whether a problem leads or not (the code review's F1)", () => {
    /** One more problem, as its producer raises it */
    const raised = (/** @type {Record<string, unknown>} */ fields) =>
      /** @type {any} */ ({ ...START_FAILED, affected: [], preserved: [], ...fields });
    const quota = (/** @type {string} */ providerId, /** @type {string} */ n) =>
      raised({
        id: `00000000-0000-4000-8000-0000000000${n}`,
        ref: `0000${n}`,
        key: `${providerId}/quota/CanvasTabDB`,
        providerId,
        faultCode: 'quota',
        subjectId: 'CanvasTabDB',
        severity: 'capture-risk',
        affected: ['capture'],
      });
    const CAPTURE_QUOTA = quota('capture', 'f1');
    const STORAGE_QUOTA = quota('storage', 'f2');
    const SCAN = raised({
      id: '00000000-0000-4000-8000-0000000000f3',
      ref: '0000f3',
      key: 'storage/scan-findings/CanvasTabDB',
      providerId: 'storage',
      faultCode: 'scan-findings',
      subjectId: 'CanvasTabDB',
      severity: 'degraded',
    });
    const OPEN = raised({
      id: '00000000-0000-4000-8000-0000000000f4',
      ref: '0000f4',
      key: OPEN_FAILED_KEY,
      providerId: 'storage',
      faultCode: 'open-failed',
      subjectId: 'NewTabNoteTrust',
      severity: 'data-risk',
    });
    const WRITE = raised({
      id: '00000000-0000-4000-8000-0000000000f5',
      ref: '0000f5',
      key: WRITE_FAILED_KEY,
      providerId: 'storage',
      faultCode: 'write-failed',
      subjectId: null,
      severity: 'data-risk',
    });
    const providers = [
      ...REPORT.providers,
      entry('recovery-readiness', 'recovery', { status: 'unverified', receipt: null, stillWorks: [] }),
      entry('credentials', 'vault'),
    ];
    const receipts = providers.filter(provider => provider.receipt).map(provider => provider.receipt);
    /**
     * Each surface's line after its first, over the same receipts and incidents: the Trust
     * Center's on recovery.html's rows, and Settings' from the worker's read on the new tab's,
     * with the groups each names
     * @param {any[]} incidents
     * @param {'open' | 'fallback'} recordsState
     */
    const lines = (incidents, recordsState) => {
      const common = { receipts, incidents, copyRead: true, recordsRead: true, recordsState, now: AT };
      const report = /** @type {any} */ ({ ...REPORT, records: recordsState, providers, incidents });
      const rows = trustSections(report, { now: AT }).flatMap(section => section.rows);
      const head = trustHeadline(summarize({ ...common, providers: rowsOn('recovery') }), rows, {
        now: AT,
        checking: false,
      });
      const workspace = { ...common, providers: rowsOn('workspace') };
      const settings = statusOf(narrowStatus(summarize(workspace), leadingOf(workspace)), { now: AT }).settings.second;
      // Groups and rows don't map one to one: Notes database's group holds Saving new notes'
      // row and its own, AI's holds Local model and Cloud AI, Permissions' its own and AI access
      // to notes, and NewTabNote's own parts folds four providers into one row. So each row
      // stands for its group, and the states here name the same words on both surfaces
      const groupOf = (/** @type {string} */ id) =>
        id === 'platform' ? 'platform' : PROVIDER_ROWS.find(row => row.id === id)?.group;
      return {
        trust: head.attention.length > 0 ? attentionText(head.attention, head.openRecovery) : null,
        settings,
        groups: [
          [...new Set(head.attention.map(row => groupOf(row.id)))],
          HEALTH_GROUPS.filter(
            group => settings !== null && settings.includes(/** @type {Record<string, string>} */ (GROUP)[group]),
          ),
        ],
      };
    };
    // Both name what they count in the Trust Center's page order, so each line reads the same
    for (const [
      why,
      incidents,
      recordsState,
      line,
    ] of /** @type {Array<[string, any[], 'open' | 'fallback', string | null]>} */ ([
      ["the worker's failed start alone", [START_FAILED], 'open', null],
      [
        "the worker's failed start, a change the journal kept, and the stopped purge",
        [START_FAILED, KEPT, PURGE],
        'open',
        "2 other things need your attention: Recovery points and NewTabNote's own parts.",
      ],
      ['both probes out of space', [CAPTURE_QUOTA, STORAGE_QUOTA], 'open', null],
      [
        'both probes out of space, and a scan finding in the notes database',
        [CAPTURE_QUOTA, STORAGE_QUOTA, SCAN],
        'open',
        '1 other thing needs your attention: Notes database.',
      ],
      [
        'both probes out of space, and a saved key',
        [CAPTURE_QUOTA, STORAGE_QUOTA, SAVED_KEY],
        'open',
        '1 other thing needs your attention: Saved keys.',
      ],
      ['NewTabNoteTrust not opening and its writes failing', [OPEN, WRITE], 'fallback', null],
      [
        'NewTabNoteTrust not opening and its writes failing, and a saved key',
        [OPEN, WRITE, SAVED_KEY],
        'fallback',
        '1 other thing needs your attention: Saved keys.',
      ],
      [
        'a saved key and the stopped purge, with no problem leading',
        [SAVED_KEY, PURGE],
        'open',
        '2 things need your attention: Recovery points and Saved keys.',
      ],
    ])) {
      const seen = lines(incidents, recordsState);
      assert.deepEqual([seen.trust, seen.settings], [line, line], why);
      assert.deepEqual([...seen.groups[0]].sort(), [...seen.groups[1]].sort(), `${why}: the same groups`);
    }
  });
});
