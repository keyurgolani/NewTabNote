// #20 slice 4c, PR 2: what the new tab's sidebar line and Settings' Trust Center lines say, from
// the status the worker answers, trust.summary narrowed to what they read (js/trust/ui/status.js),
// in the words the lead signed on 2026-11-07, with round 2 of 2026-11-08. They name groups by what
// needs action, never a number of problems, each name with the verb it takes, and a row with a
// name of its own when its group's one problem sits there, and read saving from capture and the
// storage group's last check: the status carries no worstCore. A dismissed problem and an update
// that's waiting never show; a wait for free space shows no sidebar line while 1b's space notice
// does (the design review's changes 9 and 10).
//
// status.js is new in this PR, so it loads inside each case, and on a tree without it each case
// fails on its own.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GROUP } from '../../js/trust/ui/copy.js';
import { whenText } from '../../js/trust/ui/model.js';

/** @typedef {import('../../js/trust/core/status-message.js').TrustStatus} TrustStatus */

const NOW = Date.parse('2026-11-07T18:42:00');
const CHECKED = NOW - 5 * 60 * 1000;

/**
 * A group in a summary: verified and needing nothing unless `fields` say otherwise
 * @param {string} group
 * @param {Record<string, unknown>} [fields]
 */
const group = (group, fields = {}) => ({
  group,
  needsAction: 0,
  checkedAt: CHECKED,
  cause: null,
  ...fields,
});

/**
 * A cause, as the summary names one
 * @param {Record<string, unknown>} fields
 */
const cause = fields => ({
  from: 'incident',
  providerId: 'storage',
  faultCode: null,
  errorCode: null,
  severity: 'degraded',
  consequenceKey: null,
  ...fields,
});

/**
 * A status where everything is fine, with `fields` over it
 * @param {Record<string, unknown>} [fields]
 * @returns {TrustStatus}
 */
const summary = (fields = {}) =>
  /** @type {any} */ ({
    capture: 'safe',
    route: 'trust',
    records: 'open',
    groups: [group('storage'), group('backup'), group('vault'), group('permissions')],
    ...fields,
  });

/**
 * What the status lines say for `given`
 * @param {TrustStatus} given
 * @param {{spaceNotice?: boolean}} [facts]
 */
async function linesOf(given, facts = {}) {
  const { statusOf } = await import('../../js/trust/ui/status.js');
  return statusOf(given, { now: NOW, ...facts });
}

const SAVING = `Your notes are saving normally. Checked ${whenText(CHECKED, NOW)}.`;

describe("the new tab's sidebar line and Settings' Trust Center lines (#20 slice 4c, the lead's signed words)", () => {
  it('say nothing in the sidebar while nothing needs the user, and that saving works, with when it was checked', async () => {
    const lines = await linesOf(summary());
    assert.equal(lines.sidebar, null);
    assert.deepEqual(lines.settings, {
      first: { text: SAVING, cause: null, tone: 'ok' },
      second: null,
      riskLine: null,
      action: { label: 'Open Trust Center', href: 'recovery.html#trust', primary: false },
    });
  });

  it('name one group, two, and past two the first and how many more, never how many problems', async () => {
    const needing = (/** @type {string[]} */ ...names) =>
      summary({
        // A group's needsAction counts its incidents: three for Saved keys, as a key kept in three places
        groups: [group('storage'), group('backup'), group('vault'), group('permissions'), group('indexing')].map(
          item => (names.includes(item.group) ? { ...item, needsAction: item.group === 'vault' ? 3 : 1 } : item),
        ),
      });
    for (const [names, sidebar, second] of /** @type {Array<[string[], string, string]>} */ ([
      [['vault'], 'Saved keys need your attention', '1 thing needs your attention: Saved keys.'],
      [
        ['vault', 'permissions'],
        'Saved keys and Permissions need your attention',
        '2 things need your attention: Saved keys and Permissions.',
      ],
      [
        ['backup', 'vault', 'permissions', 'indexing'],
        'Backups and 3 more need your attention',
        'Backups and 3 more need your attention.',
      ],
    ])) {
      const lines = await linesOf(needing(...names));
      assert.deepEqual(lines.sidebar, { text: sidebar, href: 'recovery.html#trust', tone: 'action' }, names.join());
      assert.deepEqual([lines.settings.first.text, lines.settings.second], [SAVING, second], names.join());
    }
  });

  it('never name a group whose problems were all dismissed', async () => {
    const lines = await linesOf(summary({ groups: [group('storage'), group('vault', { needsAction: 0 })] }));
    assert.deepEqual([lines.sidebar, lines.settings.second], [null, null]);
  });

  it('read an update that waits as saving normally, and show no line for it', async () => {
    const { summarize } = await import('../../js/trust/core/summary.js');
    const { narrowStatus } = await import('../../js/trust/core/status-message.js');
    const { rowsOn } = await import('../../js/trust/core/providers/rows.js');
    /**
     * A core provider's receipt, verified at CHECKED with capture safe, with `fields` over it
     * @param {string} providerId
     * @param {Record<string, unknown>} [fields]
     */
    const receipt = (providerId, fields = {}) => ({
      id: `00000000-0000-4000-8000-0000000000${providerId === 'capture' ? 'c1' : 'c2'}`,
      providerId,
      verifiedAt: CHECKED,
      durationMs: 1,
      freshnessMs: 86_400_000,
      operation: `${providerId}.check`,
      consequenceKey: null,
      preserved: ['capture', 'editing', 'reading'],
      nextAction: null,
      executionClass: 'local-cheap',
      status: 'verified',
      capture: 'safe',
      evidence: {},
      ...fields,
    });
    // Storage's check while CanvasTabDB waits below the latest version: degraded, its update
    // pending and capture still safe (providers/probe.js), and the update's incident open
    const update = {
      id: '00000000-0000-4000-8000-0000000000d1',
      ref: '0000d1',
      key: 'storage/migration-pending/CanvasTabDB',
      providerId: 'storage',
      faultCode: 'migration-pending',
      subjectId: 'CanvasTabDB',
      severity: 'degraded',
      state: 'open',
      dismissed: false,
      dismissChangedAt: null,
      firstSeenAt: CHECKED,
      lastSeenAt: CHECKED,
      resolvedAt: null,
      occurrences: 1,
      affected: [],
      preserved: ['capture', 'editing', 'reading'],
      evidence: {},
      appliedOps: [],
    };
    const waiting = narrowStatus(
      summarize({
        providers: rowsOn('workspace'),
        receipts: /** @type {any} */ ([
          receipt('capture'),
          receipt('storage', {
            status: 'degraded',
            consequenceKey: 'storage.migration-pending',
            evidence: { subjectId: 'CanvasTabDB' },
          }),
        ]),
        incidents: /** @type {any} */ ([update]),
        copyRead: true,
        recordsRead: true,
        recordsState: 'open',
        now: NOW,
      }),
    );
    // The update is open, and it waits, so the storage group needs nothing for it
    assert.deepEqual(
      waiting.groups.find(item => item.group === 'storage'),
      {
        group: 'storage',
        needsAction: 0,
        checkedAt: CHECKED,
        cause: null,
      },
    );
    const lines = await linesOf(waiting);
    assert.deepEqual([lines.sidebar, lines.settings.first.text, lines.settings.second], [null, SAVING, null]);
  });

  it("show no sidebar line for a wait for free space while 1b's space notice shows, and name it in Settings either way", async () => {
    const space = summary({
      groups: [
        group('storage', {
          needsAction: 1,
          cause: cause({ faultCode: 'migration-blocked', errorCode: 'space-short' }),
        }),
        group('backup'),
      ],
    });
    const shown = await linesOf(space, { spaceNotice: true });
    assert.deepEqual([shown.sidebar, shown.settings.second], [null, '1 thing needs your attention: Notes database.']);
    const hidden = await linesOf(space, { spaceNotice: false });
    assert.deepEqual(hidden.sidebar, {
      text: 'Notes database needs your attention',
      href: 'recovery.html#trust',
      tone: 'action',
    });
    // Another problem beside the wait still shows, by its own group
    const both = await linesOf(summary({ ...space, groups: [...space.groups, group('vault', { needsAction: 1 })] }), {
      spaceNotice: true,
    });
    assert.equal(both.sidebar && both.sidebar.text, 'Saved keys need your attention');
  });

  it('at capture risk say new notes may not be saved, with the cause the summary has, and point to the Recovery Center', async () => {
    for (const [riskCause, sentence] of /** @type {const} */ ([
      [
        cause({ providerId: 'capture', faultCode: 'quota', severity: 'capture-risk' }),
        "This device is out of space for NewTabNote, so new notes and changes can't be saved.",
      ],
      [
        cause({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' }),
        "NewTabNote couldn't open your notes database, so notes can't be read or saved here.",
      ],
      [
        cause({ providerId: 'capture', faultCode: 'probe-failed', severity: 'capture-risk' }),
        "NewTabNote couldn't save a test entry, so new notes and captures may not be saved.",
      ],
      [
        cause({
          from: 'receipt',
          faultCode: null,
          severity: null,
          consequenceKey: 'storage.version-too-new',
        }),
        "A newer version of NewTabNote changed your notes database, so this version won't write to it.",
      ],
      [cause({ providerId: 'storage', faultCode: 'scan-findings', severity: 'capture-risk' }), null],
    ])) {
      const lines = await linesOf(
        summary({
          capture: 'at-risk',
          route: 'recovery',
          groups: [group('storage', { needsAction: 1, cause: riskCause }), group('vault', { needsAction: 1 })],
        }),
      );
      assert.deepEqual(lines.sidebar, {
        text: 'New notes may not be saved',
        href: 'recovery.html#recovery',
        tone: 'failed',
      });
      assert.deepEqual(lines.settings, {
        first: { text: 'New notes may not be saved.', cause: sentence, tone: 'failed' },
        // The other groups, not the one at risk, counted as other after the line that leads (round 4)
        second: '1 other thing needs your attention: Saved keys.',
        riskLine: 'The Recovery Center shows what went wrong and can save a copy of everything that can still be read.',
        action: { label: 'Open Recovery Center', href: 'recovery.html#recovery', primary: true },
      });
    }
  });

  it('at capture risk from the background worker say the same, with no cause sentence, and name storage if it needs action too', async () => {
    const lines = await linesOf(
      summary({
        capture: 'at-risk',
        route: 'recovery',
        groups: [
          group('storage', {
            needsAction: 1,
            cause: cause({ faultCode: 'scan-findings' }),
          }),
          group('platform', {
            needsAction: 1,
            cause: cause({ providerId: 'coordinator', faultCode: 'start-failed', severity: 'capture-risk' }),
          }),
        ],
      }),
    );
    assert.equal(lines.sidebar && lines.sidebar.text, 'New notes may not be saved');
    assert.deepEqual(
      [lines.settings.first, lines.settings.second],
      [
        { text: 'New notes may not be saved.', cause: null, tone: 'failed' },
        '1 other thing needs your attention: Notes database.',
      ],
    );
  });

  it("say NewTabNote can't confirm notes are saving while the health records can't be read, and point to the Recovery Center, change 7's line following the button (round 2)", async () => {
    for (const blind of [
      { records: 'fallback', capture: 'unknown', route: 'recovery' },
      // A store or settings copy the read couldn't reach, with the records open
      { capture: 'unknown', route: 'recovery' },
    ]) {
      const lines = await linesOf(summary(blind));
      assert.deepEqual(lines.sidebar, {
        text: "NewTabNote can't confirm your notes are saving",
        href: 'recovery.html#recovery',
        tone: 'action',
      });
      assert.deepEqual(lines.settings, {
        first: { text: "NewTabNote can't confirm your notes are saving.", cause: null, tone: 'action' },
        second: null,
        riskLine: 'The Recovery Center shows what went wrong and can save a copy of everything that can still be read.',
        action: { label: 'Open Recovery Center', href: 'recovery.html#recovery', primary: false },
      });
    }
  });

  it("count the rest as other after a first line that leads with a problem, at capture risk and at can't confirm, and as signed without one (round 4)", async () => {
    const riskCause = cause({ faultCode: 'quota', errorCode: 'quota', severity: 'capture-risk' });
    /** @param {Record<string, unknown>} fields @param {string[]} needing */
    const second = async (fields, needing) =>
      (
        await linesOf(
          summary({
            ...fields,
            groups: [
              group('storage', fields.capture === 'at-risk' ? { needsAction: 1, cause: riskCause } : {}),
              ...needing.map(name => group(name, { needsAction: 1 })),
            ],
          }),
        )
      ).settings.second;
    const atRisk = { capture: 'at-risk', route: 'recovery' };
    const unsure = { capture: 'unknown', route: 'recovery' };
    assert.deepEqual(
      [
        await second(atRisk, ['vault']),
        await second(atRisk, ['vault', 'permissions']),
        await second(unsure, ['vault']),
        await second(unsure, ['vault', 'permissions']),
        await second({}, ['vault']),
        await second({}, ['vault', 'permissions']),
        await second(atRisk, ['vault', 'permissions', 'backup']),
      ],
      [
        '1 other thing needs your attention: Saved keys.',
        '2 other things need your attention: Saved keys and Permissions.',
        '1 other thing needs your attention: Saved keys.',
        '2 other things need your attention: Saved keys and Permissions.',
        '1 thing needs your attention: Saved keys.',
        '2 things need your attention: Saved keys and Permissions.',
        // Past two, as signed: no count of things to call other
        'Saved keys and 2 more need your attention.',
      ],
    );
  });

  it('say saving is not verified yet before any check, and not checked recently once the last check is old', async () => {
    const unchecked = await linesOf(
      summary({
        capture: 'unknown',
        groups: [group('storage', { checkedAt: null })],
      }),
    );
    assert.deepEqual(
      [unchecked.sidebar, unchecked.settings.first],
      [null, { text: "Saving isn't verified yet.", cause: null, tone: 'unknown' }],
    );
    const old = NOW - 3 * 24 * 60 * 60 * 1000;
    const stale = await linesOf(
      summary({
        capture: 'unknown',
        groups: [group('storage', { checkedAt: old })],
      }),
    );
    assert.deepEqual(stale.settings.first, {
      text: `Saving hasn't been checked recently. Last checked ${whenText(old, NOW)}.`,
      cause: null,
      tone: 'unknown',
    });
  });

  it('name each group as every surface does (change 6), with the verb its name takes, which every group has (round 2)', async () => {
    const { statusOf } = await import('../../js/trust/ui/status.js');
    const { GROUP_VERB } = await import('../../js/trust/ui/status-copy.js');
    const { HEALTH_GROUPS } = await import('../../js/trust/core/vocabulary.js');
    // A name and its verb for each group, so a group added later can't ship without its verb
    assert.deepEqual(
      [Object.keys(GROUP).sort(), Object.keys(GROUP_VERB || {}).sort()],
      [[...HEALTH_GROUPS].sort(), [...HEALTH_GROUPS].sort()],
    );
    // The one-group line as the lead signed it, round 2 (2026-11-08 00:12:20)
    const signed = {
      storage: 'Notes database needs your attention',
      vault: 'Saved keys need your attention',
      backup: 'Backups need your attention',
      sync: 'Sync needs your attention',
      indexing: 'Search needs your attention',
      inference: 'AI needs your attention',
      permissions: 'Permissions need your attention',
      recovery: 'Recovery points need your attention',
      platform: "NewTabNote's own parts need your attention",
    };
    for (const id of HEALTH_GROUPS) {
      const lines = statusOf(summary({ groups: [group(id, { needsAction: 1 })] }), { now: NOW });
      assert.equal(lines.sidebar && lines.sidebar.text, /** @type {Record<string, string>} */ (signed)[id], id);
    }
  });

  it("name a row with a name of its own, in recovery.html's label, when its group's one problem sits on it, and the group past one (round 2)", async () => {
    const { ROW_LABEL } = await import('../../js/trust/ui/status-copy.js');
    const { PROVIDER } = await import('../../js/trust/ui/copy.js');
    // One list, which recovery.html's rows read too
    const labels = {
      'local-inference': 'Local model',
      'remote-ai': 'Cloud AI',
      'ai-scope-grants': 'AI access to notes',
    };
    assert.deepEqual(ROW_LABEL, labels);
    for (const [id, label] of Object.entries(labels)) {
      assert.equal(/** @type {Record<string, {label: string}>} */ (PROVIDER)[id].label, label, id);
    }
    /**
     * A status with one group needing action, its cause on `providerId`'s row
     * @param {string} id
     * @param {number} needsAction
     * @param {string} providerId
     * @param {string} faultCode
     */
    const needing = (id, needsAction, providerId, faultCode) =>
      summary({ groups: [group('storage'), group(id, { needsAction, cause: cause({ providerId, faultCode }) })] });
    for (const [id, providerId, faultCode, name] of [
      ['inference', 'local-inference', 'load-failed', 'Local model'],
      ['inference', 'remote-ai', 'load-failed', 'Cloud AI'],
      ['permissions', 'ai-scope-grants', 'grant-missing', 'AI access to notes'],
    ]) {
      const lines = await linesOf(needing(id, 1, providerId, faultCode));
      assert.deepEqual(
        [lines.sidebar && lines.sidebar.text, lines.settings.second],
        [`${name} needs your attention`, `1 thing needs your attention: ${name}.`],
        providerId,
      );
    }
    // Two problems in the AI group sit on both its rows: no AI row raises more than one
    const both = await linesOf(needing('inference', 2, 'local-inference', 'load-failed'));
    assert.deepEqual(
      [both.sidebar && both.sidebar.text, both.settings.second],
      ['AI needs your attention', '1 thing needs your attention: AI.'],
    );
    // A row named as its group is, and the group's own row in a group with another
    const own = await linesOf(needing('permissions', 1, 'permissions', 'grant-missing'));
    assert.equal(own.sidebar && own.sidebar.text, 'Permissions need your attention');
    // Beside another group, the row's name in the pair
    const pair = await linesOf(
      summary({
        groups: [
          group('storage'),
          group('vault', { needsAction: 1 }),
          group('inference', {
            needsAction: 1,
            cause: cause({ providerId: 'local-inference', faultCode: 'load-failed' }),
          }),
        ],
      }),
    );
    assert.deepEqual(
      [pair.sidebar && pair.sidebar.text, pair.settings.second],
      ['Saved keys and Local model need your attention', '2 things need your attention: Saved keys and Local model.'],
    );
  });
});
