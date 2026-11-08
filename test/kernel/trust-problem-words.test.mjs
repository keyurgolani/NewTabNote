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
import { INTERIM, PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { PROVIDER_ROWS, rowsOn } from '../../js/trust/core/providers/rows.js';
import { narrowStatus } from '../../js/trust/core/status-message.js';
import { leadingOf, summarize } from '../../js/trust/core/summary.js';
import { OPEN_FAILED_KEY, WRITE_FAILED_KEY } from '../../js/trust/core/trust-records.js';
import { HEALTH_GROUPS } from '../../js/trust/core/vocabulary.js';
import { INCIDENT, INCIDENT_TEXT, PAGE, RESOLVED } from '../../js/trust/ui/copy.js';
import { PLATFORM, attentionText, problemsOf, trustHeadline, trustSections } from '../../js/trust/ui/model.js';
import { statusOf } from '../../js/trust/ui/status.js';
import { CAPTURE_CONSEQUENCE, GROUP } from '../../js/trust/ui/status-copy.js';

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

  it("says them in the signed words, the stopped purge's text as round 3 has it, and the worker's failed start as round 5 names it: what failed is saving", () => {
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
          "The background worker couldn't start saving",
          'New notes and changes may not be saved until it starts.',
          'The background worker saves again',
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
    assert.deepEqual([problem.title, problem.rowId], ["The background worker couldn't start saving", 'platform']);
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
      ['failed', 'New notes may not be saved', "The background worker couldn't start saving.", true],
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
        ["The background worker couldn't start saving", ['editing', 'reading'], ['capture']],
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
    const worker = "The background worker couldn't start saving.";
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
    // and its own passing write check after it, apart, as what it tested and passed (round 5)
    const [failed, own] = row('capture').evidence;
    assert.deepEqual(
      [shown(failed), failed.sentence, failed.facts.map((/** @type {any} */ fact) => fact.label), shown(own)],
      [
        ["The background worker couldn't start saving", 'Not working', 'failed', true],
        'New notes and changes may not be saved until it starts.',
        [PAGE.firstSeen, PAGE.lastSeen, PAGE.timesSeen, PAGE.ref],
        ['Test save', 'Passed', 'ok', false],
      ],
    );
    // NewTabNote's own parts the same, before the parts its checks read
    assert.deepEqual(row('platform').evidence.map(shown), [
      ["The background worker couldn't start saving", 'Not working', 'failed', true],
      ['Connections to the background worker', 'Passed', 'ok', false],
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

  it("lays recovery.html's cards and rows out as the Design gate's review of round 3 asked: card text that wraps pretty, a balanced attention line, each row's link at its far end, and a card's lone link on a line of text at the card's far end, clear of the card's facts, each link's target at least 44px tall in its own box (round 4, and the code review's R4-3 and its fix check)", () => {
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
    // button-high band, and 16px below the card's facts, so its focus ring clears them
    // A card with no Dismiss also keeps 3px more below its link, so the ring keeps 4px from the
    // card's border (round 5)
    assert.match(
      rule('.trust-incident-actions:has(> .trust-crosslink:only-child)'),
      /^\n\.trust-incident-actions:has\(> \.trust-crosslink:only-child\) \{\n {2}display: block;\n {2}margin-top: var\(--space-region\);\n {2}padding-bottom: 3px;\n {2}text-align: end;$/,
    );
    /** A rule's declarations, after its selector */
    const declarations = (/** @type {string} */ selector) => rule(selector).slice(rule(selector).indexOf('{') + 1);
    // Each target at least 44px tall in its own box. The lone link, an <a>, inline on its
    // baseline: half of 44px less 1em above and below its text's own box, 1em tall or more,
    // which leaves its line as tall as the text's. Undo, a <button>, whose inline is
    // inline-block: 0.7rem above and below the button's 24px line (the fix check's ruling).
    // Each says only what's above and below it, and the text actions' rule the room beside it
    // (round 5)
    assert.deepEqual(
      [
        declarations('.trust-incident-actions > .trust-crosslink:only-child'),
        declarations('.trust-notice .trust-linkbtn'),
      ],
      [
        '\n  display: inline;\n  min-height: 0;\n  padding-block: calc((var(--target-min) - 1em) / 2);\n  vertical-align: baseline;',
        '\n  display: inline;\n  margin-inline-start: 4px;\n  min-height: 0;\n  padding-block: 0.7rem;\n  vertical-align: baseline;',
      ],
    );
  });

  it("gives recovery.html's text actions, the headline's links, the facts and the rows' status the room and alignment the Design gate's review of round 4's shots asked for: 4px beside each text action's words, the link at a card's far end where its words were, Undo 4px further from its sentence, a headline link never split across lines, a fact's last line never alone, and a row's status on its label's first baseline (round 5)", () => {
    const sheet = fs.readFileSync(path.join(ROOT, 'css', 'recovery.css'), 'utf8');
    /** The declarations of the first rule whose selector is exactly `selector`, after it */
    const declarations = (/** @type {string} */ selector) => {
      const start = sheet.indexOf(`\n${selector} {\n`);
      assert.ok(start >= 0, `css/recovery.css has a ${selector} rule`);
      return sheet.slice(sheet.indexOf('{', start) + 1, sheet.indexOf('\n}', start));
    };
    // The "See ... in Trust Center" links and Undo: 4px of room beside their words, so a focus
    // ring keeps 4px from them, the inner ring in dark too
    assert.equal(declarations('.trust-crosslink,\n.trust-notice .trust-linkbtn'), '\n  padding-inline: 4px;');
    // The link at a card's far end reaches 4px past it, so its words stay where they were
    assert.equal(declarations('.trust-crosslink'), '\n  margin-left: auto;\n  margin-inline-end: -4px;');
    // A link in the headline's line wraps whole, never "Recovery / points"
    assert.equal(declarations('.trust-attention-line .trust-link'), '\n  white-space: nowrap;');
    // A fact's value doesn't leave its last word alone, as "page." was
    assert.equal(declarations('.trust-facts dd'), '\n  margin: 0;\n  text-wrap: pretty;');
    // The status's words give it its baseline, its shape beside them still centered, so the
    // status sits on its label's first baseline in a row with a line under it
    assert.equal(declarations('.trust-row-status > :not(.trust-glyph)'), '\n  align-self: baseline;');
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
          ["The background worker couldn't start saving", 'Not working', 'failed', true],
          ['Test save', 'Passed', 'ok', false],
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
          ['Search index up to date', 'Passed', 'ok', false],
        ],
      ],
    );
  });

  it("gives Notes database, its check passed, a data-risk finding's Needs action, and leads its evidence with the finding: the health records' failed writes, which its probe doesn't look for (round 4b, rebuilt on a check that can pass for the code review's R6-2)", () => {
    const storage = findingOver('storage', 'storage', 'write-failed', 'data-risk', []);
    assert.deepEqual(
      [storage.status, storage.statusText, storage.evidence.map(shownEvidence)],
      [
        'action-required',
        'Needs action',
        [
          ["Some health records weren't saved", 'Needs action', 'action', true],
          ['Test read and write', 'Passed', 'ok', false],
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
          ['Test save', 'Passed', 'ok', false],
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
          ["The background worker couldn't start saving", 'Not working', 'failed', true],
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
            ["The background worker couldn't start saving", 'Not working', 'failed', true],
            ['Test save', 'Passed', 'ok', false],
          ],
        ],
      ],
    );
  });

  it("sets a row's passing checks apart under Also checked where a problem leads its evidence, each as what it tested and Passed, keeps a check that didn't pass where it reads, and lists each as it does where no problem leads (the Design gate's review of round 4's shots, signed as round 5)", () => {
    /** A provider's entry whose check found `status`, by its real operation */
    const checked = (
      /** @type {string} */ providerId,
      /** @type {string} */ group,
      /** @type {string} */ operation,
      status = 'verified',
    ) => entry(providerId, group, { status, receipt: { ...entry(providerId, group).receipt, operation, status } });
    const providers = [
      checked('capture', 'storage', 'capture.probe-commit'),
      entry('storage', 'storage'),
      checked('messaging', 'platform', 'messaging.query-health'),
      checked('contributions', 'platform', 'contributions.read-resolution-report'),
      checked('block-types', 'platform', 'block-types.read-resolution-report'),
    ];
    /** @param {any[]} list @param {any[]} incidents */
    const rowsOf = (list, incidents) =>
      trustSections(/** @type {any} */ ({ ...REPORT, providers: list, incidents }), { now: AT }).flatMap(
        section => section.rows,
      );
    /** @param {any[]} rows @param {string} id */
    const evidenceOf = (rows, id) =>
      /** @type {any} */ (rows.find(row => row.id === id)).evidence.map((/** @type {any} */ item) => [
        item.title,
        item.statusText,
        item.tone,
        Boolean(item.problem),
        Boolean(item.also),
      ]);
    const worker = ["The background worker couldn't start saving", 'Not working', 'failed', true, false];
    const led = rowsOf(providers, [START_FAILED]);
    // Saving new notes' write check is the test save it ran, with its sentence as it is, so the
    // row's own name never sits beside Verified while the row isn't working
    assert.deepEqual(evidenceOf(led, 'capture'), [worker, ['Test save', 'Passed', 'ok', false, true]]);
    const capture = /** @type {any} */ (led.find(row => row.id === 'capture'));
    assert.deepEqual(
      [capture.status, capture.evidence[1].sentence],
      ['failed', 'Saved a test entry where new notes go, read it back, and removed it.'],
    );
    // NewTabNote's own parts: each part its checks read, by its own name
    assert.deepEqual(evidenceOf(led, 'platform'), [
      worker,
      ['Connections to the background worker', 'Passed', 'ok', false, true],
      ['Built-in features', 'Passed', 'ok', false, true],
      ['Block types', 'Passed', 'ok', false, true],
    ]);
    // A check that didn't pass isn't set apart: it reads where it did, after the problem
    const partly = providers.map(item =>
      item.providerId === 'block-types'
        ? checked('block-types', 'platform', 'block-types.read-resolution-report', 'degraded')
        : item,
    );
    assert.deepEqual(evidenceOf(rowsOf(partly, [START_FAILED]), 'platform'), [
      worker,
      ['Block types', 'Partly working', 'partial', false, false],
      ['Connections to the background worker', 'Passed', 'ok', false, true],
      ['Built-in features', 'Passed', 'ok', false, true],
    ]);
    // With no problem leading, each check lists as it does now, with its usual status word
    const plain = rowsOf(providers, []);
    assert.deepEqual(evidenceOf(plain, 'capture'), [['Saving new notes', 'Verified', 'ok', false, false]]);
    assert.deepEqual(evidenceOf(plain, 'platform'), [
      ['Connections to the background worker', 'Verified', 'ok', false, false],
      ['Built-in features', 'Verified', 'ok', false, false],
      ['Block types', 'Verified', 'ok', false, false],
    ]);
  });

  it("titles no check set apart under Also checked by its own row's name, on every row that can reach it: a check that can pass under a problem it doesn't look for, or under the worker's, which no check here covers (the code review's R5-1, signed as round 5's check titles)", () => {
    // The faults each provider's problems can carry: those its events raise, and on Notes
    // database the health records' own two, which no check looks for
    /** @type {Map<string, Map<string, string>>} */
    const holds = new Map();
    const hold = (/** @type {string} */ providerId, /** @type {string} */ faultCode, /** @type {string} */ severity) =>
      holds.set(providerId, (holds.get(providerId) || new Map()).set(faultCode, severity));
    for (const code of Object.values(EVENT_CODES)) {
      if ('incident' in code && code.incident)
        hold(code.incident.providerId, code.incident.faultCode, code.incident.severity);
    }
    hold('storage', 'write-failed', 'data-risk');
    hold('storage', 'open-failed', 'data-risk');
    /** @type {Set<string>} */
    const reached = new Set();
    for (const provider of PROVIDERS) {
      const place = PROVIDER_ROWS.find(row => row.id === provider.id);
      // An interim check never records verified, so it never passes; and the Trust Center runs
      // only on recovery.html
      if (Object.prototype.hasOwnProperty.call(INTERIM, provider.id) || !place || !place.hosts.includes('recovery'))
        continue;
      const observes = /** @type {readonly string[]} */ (provider.observes);
      const unlooked = [...(holds.get(provider.id) || new Map())].filter(([fault]) => !observes.includes(fault));
      const problems = unlooked.map(([faultCode, severity]) => ({
        ...START_FAILED,
        id: '00000000-0000-4000-8000-0000000000ec',
        ref: '0000ec',
        key: `${provider.id}/${faultCode}`,
        providerId: provider.id,
        faultCode,
        severity,
        affected: [],
        preserved: [],
      }));
      if (provider.id === 'capture' || PLATFORM.includes(provider.id)) problems.push(START_FAILED);
      const rowId = PLATFORM.includes(provider.id) ? 'platform' : provider.id;
      const others = REPORT.providers.filter((/** @type {any} */ item) => item.providerId !== provider.id);
      for (const problem of problems) {
        const report = /** @type {any} */ ({
          ...REPORT,
          providers: [...others, entry(provider.id, place.group)],
          incidents: [problem],
        });
        const row = /** @type {any} */ (
          trustSections(report, { now: AT })
            .flatMap(section => section.rows)
            .find(item => item.id === rowId)
        );
        for (const item of row.evidence.filter((/** @type {any} */ evidence) => evidence.also)) {
          reached.add(rowId);
          assert.notEqual(
            item.title,
            row.label,
            `${row.label}'s passing check, under ${problem.key}, needs a title of what it tested`,
          );
        }
      }
    }
    // The rows that reach it in this build, so the guard isn't empty: each check's title is what
    // it tested, Test save, Test read and write, Newest recovery point, Search index up to date,
    // and own parts' parts by their own names
    assert.deepEqual([...reached].sort(), ['capture', 'index', 'platform', 'recovery-readiness', 'storage']);
  });

  it("names on NewTabNote's own parts' visible lines each problem it's counted for that its line doesn't, under the problem's status word, as Not working names what stopped: the change the journal kept, under the worker's failed start (the Design gate's review of round 4's shots, signed as round 5)", () => {
    const providers = [
      ...REPORT.providers,
      entry('recovery-readiness', 'recovery', { status: 'unverified', receipt: null, stillWorks: [] }),
    ];
    /** Saving new notes' and NewTabNote's own parts' line, and the problems each names besides it */
    const lines = (/** @type {any[]} */ incidents) =>
      trustSections(/** @type {any} */ ({ ...REPORT, providers, incidents }), { now: AT })
        .flatMap(section => section.rows)
        .filter(row => row.id === 'capture' || row.id === 'platform')
        .map(row => [row.id, row.text, /** @type {any} */ (row).problemLines]);
    const worker = "The background worker couldn't start saving.";
    // r2-12: the headline counts NewTabNote's own parts as other for the kept change, so its
    // visible lines say so
    assert.deepEqual(lines([START_FAILED, KEPT, PURGE]), [
      ['capture', worker, []],
      ['platform', worker, [{ status: 'Needs action', what: "a change NewTabNote kept isn't in your notes yet" }]],
    ]);
    // A row's line that names its one problem says it all: the failed start alone, or the kept change
    assert.deepEqual(lines([START_FAILED]), [
      ['capture', worker, []],
      ['platform', worker, []],
    ]);
    assert.deepEqual(lines([KEPT])[1], ['platform', "A change NewTabNote kept isn't in your notes yet.", []]);
  });

  it("names each problem on a row's lines by its own status word: a part that didn't load reads Partly working on NewTabNote's own parts, and Saving new notes, with a page capture beside the worker's failed start, names the one its line doesn't (round 5, and the code review's R5-2)", () => {
    /** A part of NewTabNote that didn't load, as its event raises it */
    const part = /** @type {any} */ ({
      ...START_FAILED,
      id: '00000000-0000-4000-8000-0000000000eb',
      ref: '0000eb',
      key: 'contributions/contribution-unavailable',
      providerId: 'contributions',
      faultCode: 'contribution-unavailable',
      severity: 'degraded',
      affected: [],
      preserved: [],
    });
    const rows = trustSections(/** @type {any} */ ({ ...REPORT, incidents: [START_FAILED, KEPT, part] }), {
      now: AT,
    }).flatMap(section => section.rows);
    assert.deepEqual(/** @type {any} */ (rows.find(row => row.id === 'platform')).problemLines, [
      { status: 'Needs action', what: "a change NewTabNote kept isn't in your notes yet" },
      { status: 'Partly working', what: "part of NewTabNote didn't load" },
    ]);
    // Every row names more, as signed in round 5's check titles: Saving new notes holds two, its
    // line names the page capture, seen last, and the worker's failed start comes after it
    const earlier = { ...START_FAILED, firstSeenAt: AT - 120_000, lastSeenAt: AT - 60_000 };
    const capture = findingOver('capture', 'storage', 'capture-failed', 'capture-risk', ['capture'], [earlier]);
    assert.deepEqual(
      [capture.text, capture.problemLines],
      [
        "A page capture wasn't saved.",
        [{ status: 'Not working', what: "the background worker couldn't start saving" }],
      ],
    );
  });

  it("names on every row's visible lines each problem it's counted for that its line doesn't, not only on NewTabNote's own parts: Notes database out of space names its scan finding too, and a title that starts with a name keeps it, as Chrome (the code review's R5-2, signed as round 5's check titles)", () => {
    /** A problem of `providerId`'s, as its producer raises it */
    const raised = (/** @type {string} */ n, /** @type {Record<string, unknown>} */ fields) =>
      /** @type {any} */ ({
        ...START_FAILED,
        id: `00000000-0000-4000-8000-0000000000${n}`,
        ref: `0000${n}`,
        affected: [],
        preserved: [],
        ...fields,
      });
    const quota = (/** @type {string} */ providerId, /** @type {string} */ n) =>
      raised(n, {
        key: `${providerId}/quota/CanvasTabDB`,
        providerId,
        faultCode: 'quota',
        subjectId: 'CanvasTabDB',
        severity: 'capture-risk',
        affected: ['capture'],
      });
    const scan = raised('d1', {
      key: 'storage/scan-findings/CanvasTabDB',
      providerId: 'storage',
      faultCode: 'scan-findings',
      subjectId: 'CanvasTabDB',
      severity: 'degraded',
      evidence: { count: 3 },
    });
    const rowsOf = (/** @type {any[]} */ providers, /** @type {any[]} */ incidents) =>
      trustSections(/** @type {any} */ ({ ...REPORT, providers, incidents }), { now: AT }).flatMap(
        section => section.rows,
      );
    // Both probes out of space, and a scan finding: the headline counts Notes database as other
    // for the finding, and its line names the space it's out of, so the finding comes after it
    const space = rowsOf(REPORT.providers, [quota('capture', 'd2'), quota('storage', 'd3'), scan]);
    assert.deepEqual(
      space
        .filter(row => row.id === 'capture' || row.id === 'storage')
        .map(row => [row.id, row.text, /** @type {any} */ (row).problemLines]),
      [
        ['capture', 'This device is out of space for NewTabNote.', []],
        [
          'storage',
          'This device is out of space for NewTabNote.',
          [{ status: 'Partly working', what: "3 blocks aren't in any note" }],
        ],
      ],
    );
    // A title as the rest of a sentence keeps a name it starts with
    const access = rowsOf(
      [...REPORT.providers, entry('permissions', 'permissions')],
      [
        raised('d4', {
          key: 'permissions/grant-missing',
          providerId: 'permissions',
          faultCode: 'grant-missing',
          severity: 'data-risk',
        }),
        raised('d5', {
          key: 'permissions/permission-changed',
          providerId: 'permissions',
          faultCode: 'permission-changed',
          severity: 'degraded',
        }),
      ],
    ).find(row => row.id === 'permissions');
    assert.deepEqual(
      [/** @type {any} */ (access).text, /** @type {any} */ (access).problemLines],
      [
        'Site access is limited.',
        [{ status: 'Partly working', what: 'Chrome grants NewTabNote more than it asks for' }],
      ],
    );
  });

  it("names on a row's lines each problem its own check doesn't look for, though that check found something and speaks the row's line: out of space, Notes database's probe reports the space, and the health records' own two still get their lines, and Saving new notes' probe the same beside a page capture that wasn't saved (the code review's R6-1)", () => {
    /** A provider's entry whose probe found the device out of space, as each probe answers it */
    const full = (
      /** @type {string} */ providerId,
      /** @type {string} */ operation,
      /** @type {string} */ consequenceKey,
    ) =>
      entry(providerId, 'storage', {
        status: 'action-required',
        receipt: {
          ...entry(providerId, 'storage').receipt,
          operation,
          status: 'action-required',
          capture: 'at-risk',
          consequenceKey,
          evidence: { subjectId: 'CanvasTabDB' },
          preserved: ['reading'],
        },
        stillWorks: ['reading'],
      });
    /** A problem as its producer raises it */
    const raised = (/** @type {string} */ n, /** @type {Record<string, unknown>} */ fields) =>
      /** @type {any} */ ({
        ...START_FAILED,
        id: `00000000-0000-4000-8000-0000000000${n}`,
        ref: `0000${n}`,
        affected: [],
        preserved: [],
        ...fields,
      });
    const quota = (/** @type {string} */ providerId, /** @type {string} */ n) =>
      raised(n, {
        key: `${providerId}/quota/CanvasTabDB`,
        providerId,
        faultCode: 'quota',
        subjectId: 'CanvasTabDB',
        severity: 'capture-risk',
        affected: ['capture', 'editing'],
      });
    const incidents = [
      quota('capture', 'b1'),
      quota('storage', 'b2'),
      // The health records can't open or take writes either: their own two, which no check looks for
      raised('b3', {
        key: OPEN_FAILED_KEY,
        providerId: 'storage',
        faultCode: 'open-failed',
        subjectId: 'NewTabNoteTrust',
        severity: 'data-risk',
      }),
      raised('b4', {
        key: WRITE_FAILED_KEY,
        providerId: 'storage',
        faultCode: 'write-failed',
        subjectId: null,
        severity: 'data-risk',
      }),
      // And a page capture failed, which the capture probe doesn't look for
      raised('b5', {
        key: 'capture/capture-failed',
        providerId: 'capture',
        faultCode: 'capture-failed',
        severity: 'capture-risk',
        affected: ['capture'],
      }),
    ];
    const others = REPORT.providers.filter(
      (/** @type {any} */ item) => item.providerId !== 'capture' && item.providerId !== 'storage',
    );
    const rows = trustSections(
      /** @type {any} */ ({
        ...REPORT,
        providers: [
          full('capture', 'capture.probe-commit', 'storage.capture-at-risk'),
          full('storage', 'storage.probe-readwrite', 'storage.quota'),
          ...others,
        ],
        incidents,
      }),
      { now: AT },
    ).flatMap(section => section.rows);
    const row = (/** @type {string} */ id) => /** @type {any} */ (rows.find(item => item.id === id));
    // Each row's line is its probe's finding, which speaks for the space the probe looks for:
    // the test save that failed, and the device out of space
    const consequence = /** @type {Record<string, string>} */ (CAPTURE_CONSEQUENCE);
    assert.deepEqual(
      [row('capture').text, row('storage').text],
      [consequence['storage.capture-at-risk'], consequence['storage.quota']],
    );
    assert.deepEqual(row('storage').problemLines, [
      { status: 'Needs action', what: "NewTabNote can't keep its health records" },
      { status: 'Needs action', what: "some health records weren't saved" },
    ]);
    assert.deepEqual(row('capture').problemLines, [{ status: 'Not working', what: "a page capture wasn't saved" }]);
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
