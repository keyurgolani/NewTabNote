/**
 * What a status page says (#20 slice 4c), from the status the worker answers, trust.summary
 * narrowed to what the lines read (js/trust/core/status-message.js), and one fact of the page's
 * own: the new tab's sidebar line, and Settings' Trust Center lines. Pure: no DOM and no request,
 * so the trust-status chunk draws what this returns and tests read it directly.
 *
 * - It names groups by what needs action (`needsAction`), so a dismissed problem and an update
 *   that's waiting never show (the design review's changes 9 and 10). It never says a number of
 *   problems: the summary counts incidents, and the Recovery Center counts problems, merging
 *   incidents that share a title. A count here is of the groups it names.
 * - It reads saving from `capture` and the storage group's last check. The status doesn't carry
 *   `worstCore`, which reads `degraded` while an update waits though nothing needs the user.
 * - At capture risk, for any cause, the line says new notes may not be saved, and Settings adds
 *   the cause's sentence when the summary has one of the four recovery.html words. While the
 *   health records can't be read, so the summary routes to the Recovery Center with capture
 *   unknown, it can't confirm notes are saving.
 * - A wait for free space alone shows no sidebar line while 1b's space notice shows (change 9).
 */

import { CAPTURE_CONSEQUENCE, GROUP, ROUTE_HREF, STATUS } from './status-copy.js';
import { whenText } from './when.js';

/** @typedef {import('../core/status-message.js').TrustStatus} TrustStatus */
/** @typedef {TrustStatus['groups'][number]} Group */
/** @typedef {NonNullable<Group['cause']>} Cause */

/**
 * The sidebar line: its words, where it opens, and its shape's tone
 * @typedef {{text: string, href: string, tone: 'action' | 'failed'}} SidebarLine
 */

/**
 * Settings' Trust Center lines: the first, with the cause's sentence at capture risk; the second,
 * or null; the line in place of the section's sentence at capture risk, or null; and its button
 * @typedef {object} SettingsLines
 * @property {{text: string, cause: string | null, tone: 'ok' | 'unknown' | 'action' | 'failed'}} first
 * @property {string | null} second
 * @property {string | null} riskLine
 * @property {{label: string, href: string, primary: boolean}} action
 */

/**
 * A capture-risk problem's consequence, by its provider and fault, as recovery.html's rows read
 * the receipt beside it (providers/probe.js)
 */
const CAUSE_CONSEQUENCE = Object.freeze({
  'capture/quota': 'storage.quota',
  'storage/quota': 'storage.quota',
  'capture/version-too-new': 'storage.version-too-new',
  'storage/version-too-new': 'storage.version-too-new',
  'storage/open-failed': 'storage.unavailable',
  'capture/probe-failed': 'storage.capture-at-risk',
  'storage/probe-failed': 'storage.unavailable',
});

/**
 * `text` with each {name} replaced by its value
 * @param {string} text
 * @param {Record<string, string | number>} values
 */
const fill = (text, values) =>
  text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );

/**
 * The sentence a capture-risk cause has, of recovery.html's four, or null
 * @param {Cause | null} cause
 * @returns {string | null}
 */
export function causeSentence(cause) {
  if (!cause) return null;
  const key =
    cause.from === 'receipt'
      ? cause.consequenceKey
      : /** @type {Record<string, string>} */ (CAUSE_CONSEQUENCE)[`${cause.providerId}/${cause.faultCode}`];
  return key && Object.prototype.hasOwnProperty.call(CAPTURE_CONSEQUENCE, key)
    ? /** @type {Record<string, string>} */ (CAPTURE_CONSEQUENCE)[key]
    : null;
}

/**
 * Whether a group's one problem is an update waiting for free space
 * @param {Group} group
 */
const waitsForSpace = group =>
  group.needsAction === 1 &&
  group.cause !== null &&
  group.cause.providerId === 'storage' &&
  group.cause.faultCode === 'migration-blocked' &&
  group.cause.errorCode === 'space-short';

/** @param {Group} group */
const nameOf = group => /** @type {Record<string, string>} */ (GROUP)[group.group] || group.group;

/**
 * The sidebar's words for the groups `names` names
 * @param {string[]} names
 */
const sidebarWords = names =>
  names.length === 1
    ? fill(STATUS.sidebarOne, { a: names[0] })
    : names.length === 2
      ? fill(STATUS.sidebarTwo, { a: names[0], b: names[1] })
      : fill(STATUS.sidebarMore, { a: names[0], count: names.length - 1 });

/**
 * Settings' second line for the groups `names` names, or null for none
 * @param {string[]} names
 */
const settingsWords = names => {
  if (names.length === 0) return null;
  if (names.length === 1) return fill(STATUS.attentionOne, { names: names[0] });
  if (names.length === 2) return fill(STATUS.attentionMany, { count: 2, names: `${names[0]} and ${names[1]}` });
  return fill(STATUS.attentionMore, { first: names[0], count: names.length - 1 });
};

/**
 * What the status lines say
 * @param {TrustStatus} summary
 * @param {{now: number, spaceNotice?: boolean}} facts - `spaceNotice`: 1b's space notice shows
 * @returns {{sidebar: SidebarLine | null, settings: SettingsLines}}
 */
export function statusOf(summary, { now, spaceNotice = false }) {
  const atRisk = summary.capture === 'at-risk';
  // The records couldn't be read, or nothing fresh proves saving while the summary routes to
  // the Recovery Center: nothing here can confirm notes are saving
  const unsure = !atRisk && summary.route === 'recovery';
  const storage = summary.groups.find(group => group.group === 'storage') || null;
  // The group capture is at risk in: the one whose cause is a capture risk, else storage
  const risky = atRisk ? summary.groups.find(group => group.cause && group.cause.severity === 'capture-risk') || storage : null;
  const needing = summary.groups.filter(group => group.needsAction > 0 && group !== risky);

  /** @type {SidebarLine | null} */
  let sidebar = null;
  if (atRisk) sidebar = { text: STATUS.atRisk, href: ROUTE_HREF.recovery, tone: 'failed' };
  else if (unsure) sidebar = { text: STATUS.cantConfirm, href: ROUTE_HREF.recovery, tone: 'action' };
  else {
    const shown = spaceNotice ? needing.filter(group => !waitsForSpace(group)) : needing;
    if (shown.length > 0) sidebar = { text: sidebarWords(shown.map(nameOf)), href: ROUTE_HREF[summary.route], tone: 'action' };
  }

  /** @type {SettingsLines['first']} */
  let first;
  if (atRisk) first = { text: STATUS.atRiskLine, cause: causeSentence(risky ? risky.cause : null), tone: 'failed' };
  else if (unsure) first = { text: STATUS.cantConfirmLine, cause: null, tone: 'action' };
  else if (summary.capture === 'safe' && storage && storage.checkedAt !== null) {
    first = { text: fill(STATUS.saving, { when: whenText(storage.checkedAt, now) }), cause: null, tone: 'ok' };
  } else if (storage && storage.checkedAt !== null) {
    first = { text: fill(STATUS.notCheckedRecently, { when: whenText(storage.checkedAt, now) }), cause: null, tone: 'unknown' };
  } else first = { text: STATUS.notVerifiedYet, cause: null, tone: 'unknown' };

  return {
    sidebar,
    settings: {
      first,
      second: settingsWords(needing.map(nameOf)),
      riskLine: atRisk ? STATUS.recoveryShows : null,
      action: {
        label: summary.route === 'recovery' ? STATUS.openRecovery : STATUS.openTrust,
        href: ROUTE_HREF[summary.route],
        primary: atRisk,
      },
    },
  };
}
