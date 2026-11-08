/**
 * What the Trust Center and Recovery Center show, from the trust operations' answers (#20
 * slice 4b): the rows, the headlines, the problems, and the words each takes. Pure: no DOM
 * and no request, so view.js draws what this returns and tests read it directly.
 *
 * Times are local, as the rows show them, with no time zone (the design review's change 14),
 * and a duration of a second or more reads in seconds.
 */

import {
  CAPABILITY,
  CONSEQUENCE,
  EVIDENCE,
  INCIDENT,
  INCIDENT_TEXT,
  INTERIM_LIMIT,
  NOTE,
  OPERATION,
  PAGE,
  PROVIDER,
  REASON,
  REASON_FALLBACK,
  REBUILD,
  RESOLVED,
  SECRET_PLACE,
  STATUS,
  STATUS_BY_PROVIDER,
  STEP,
  SUBJECT,
  TESTED,
  UPDATE_SAVES,
  UPDATE_STATUS,
} from './copy.js';
import { EVENT_CODES } from '../core/event-codes.js';
import { PROVIDERS } from '../core/providers/catalog.js';
import { OPEN_FAILED_KEY, WRITE_FAILED_KEY } from '../core/trust-records.js';
import { WAITING, updateKeyOf, updateOf, waits, whyOf } from '../core/updates.js';
import { DAY_MS, clockFormat as clock, dayFormat as day, dayOf, whenText } from './when.js';

/** @typedef {import('../core/operations/trust-report.js').TrustReport} TrustReport */
/** @typedef {import('../core/operations/trust-summary.js').TrustSummary} TrustSummary */
/** @typedef {import('../core/records.js').Incident} Incident */
/** @typedef {import('../core/records.js').HealthReceipt} HealthReceipt */
/** @typedef {import('../core/records.js').RemediationRun} RemediationRun */
/** @typedef {TrustReport['providers'][number]} ProviderEntry */
/** @typedef {'ok' | 'unknown' | 'absent' | 'partial' | 'action' | 'failed' | 'locked' | 'checking'} Tone */

/** Each status's shape, which reads in grayscale as well as in color */
export const TONE = Object.freeze({
  verified: 'ok',
  stale: 'unknown',
  unverified: 'unknown',
  checking: 'checking',
  'not-configured': 'absent',
  off: 'absent',
  unsupported: 'absent',
  locked: 'locked',
  degraded: 'partial',
  'action-required': 'action',
  failed: 'failed',
});

/** Each severity's shape */
export const SEVERITY_TONE = Object.freeze({ 'capture-risk': 'failed', 'data-risk': 'action', degraded: 'partial' });

/** The severities, worst first */
export const SEVERITY_ORDER = Object.freeze(['capture-risk', 'data-risk', 'degraded']);

/**
 * The status a problem's severity reads as on a row that holds it, whose shape is the severity's
 * (SEVERITY_TONE): a row with a finding never reads as its check alone does (round 4)
 */
const SEVERITY_STATUS = Object.freeze({ 'capture-risk': 'failed', 'data-risk': 'action-required', degraded: 'degraded' });

/** The statuses, worst first (vocabulary.js's STATUS_ORDER) */
const STATUS_ORDER = Object.freeze([
  'failed',
  'action-required',
  'degraded',
  'locked',
  'stale',
  'unverified',
  'checking',
  'unsupported',
  'off',
  'not-configured',
  'verified',
]);

/** The statuses that need the user */
const ATTENTION = Object.freeze(['action-required', 'degraded', 'failed', 'locked']);

/** The statuses a compact row folds to one line for, its reason not needed in sight (change 8) */
const FOLDED = Object.freeze(['verified', 'not-configured', 'off', 'unsupported']);

/**
 * The providers the "NewTabNote's own parts" row folds into one: the background worker's own
 * problems (#117) fold there too, with its row's words (Q4, #20 slice 4c)
 */
export const PLATFORM = Object.freeze(['coordinator', 'messaging', 'contributions', 'block-types']);

/** The interim providers, which read only legacy facts and never record `verified` (legacy.js) */
const INTERIM = Object.freeze(['backup', 'sync', 'remote-ai', 'ai-scope-grants']);

/** The remediations this page runs (js/trust/core/router-rows.js) */
export const RUNS_HERE = Object.freeze(['rebuild-index']);

// ───────── Words ─────────

/**
 * `text` with each {name} replaced by `vars[name]`, and left as it was when that's missing
 * @param {string} text
 * @param {Readonly<Record<string, unknown>>} vars
 */
export const fill = (text, vars) =>
  text.replace(/\{(\w+)\}/g, (match, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : match));

/**
 * `n` and the word for it: 1 problem, 2 problems
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Items as one list: a, a and b, a, b, and c
 * @param {readonly string[]} items
 */
export function joinList(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** @param {string} text */
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

// ───────── Times ─────────

const full = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * The time column: 10:42 AM today, Yesterday, 7:02 PM, Oct 28
 * @param {number} at
 * @param {number} now
 */
export function timeLabel(at, now) {
  if (dayOf(at) === dayOf(now)) return clock.format(at);
  if (dayOf(at) === dayOf(now - DAY_MS)) return `Yesterday, ${clock.format(at)}`;
  return day.format(at);
}

// Inside a sentence (when.js), as every trust surface says a time
export { whenText };

/**
 * A fact's time: 10:42 AM today, else Oct 28 at 10:42 AM
 * @param {number} at
 * @param {number} now
 */
export const stampText = (at, now) => (dayOf(at) === dayOf(now) ? clock.format(at) : `${day.format(at)} at ${clock.format(at)}`);

/** @param {number} at */
export const fullText = at => full.format(at);

/**
 * A duration: 120 ms, 1.8 seconds
 * @param {number} ms
 */
export function durationText(ms) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

// ───────── Statuses ─────────

/**
 * The worst of `statuses`
 * @param {readonly string[]} statuses
 */
export const worstOf = statuses =>
  STATUS_ORDER[Math.min(...statuses.map(status => Math.max(0, STATUS_ORDER.indexOf(status))))] || 'unverified';

/**
 * A provider's status, in the words its row shows
 * @param {string} providerId
 * @param {string} status
 */
export function statusWords(providerId, status) {
  const narrower = /** @type {Record<string, Record<string, string>>} */ (STATUS_BY_PROVIDER)[providerId];
  return (narrower && narrower[status]) || /** @type {Record<string, string>} */ (STATUS)[status] || status;
}

/**
 * Capabilities, as a list in words
 * @param {readonly string[]} list
 */
export const capabilitiesText = list => joinList(list.map(name => /** @type {Record<string, string>} */ (CAPABILITY)[name] || name));

/**
 * A receipt's consequence, filled from its evidence, or '' for none
 * @param {string} providerId
 * @param {HealthReceipt | null} receipt
 * @param {number} now
 */
export function consequenceOf(providerId, receipt, now) {
  if (!receipt || !receipt.consequenceKey) return '';
  const words = /** @type {Record<string, string>} */ (CONSEQUENCE);
  const text = words[`${providerId}/${receipt.consequenceKey}`] || words[receipt.consequenceKey] || '';
  const evidence = /** @type {Record<string, any>} */ (receipt.evidence || {});
  return fill(text, {
    since: typeof evidence.since === 'number' ? whenText(evidence.since, now) : '',
    count: evidence.count,
    lag: evidence.lag,
    records: evidence.records,
  });
}

// ───────── An update to how notes are stored (the director's change 9) ─────────

/**
 * An update's words: its consequence, and that notes save normally when the check saved its test
 * entry where new notes go, but for the wait for free space, whose words say what to do
 * @param {string} key - updateKeyOf's
 * @param {HealthReceipt | null} receipt
 */
function updateText(key, receipt) {
  const words = /** @type {Record<string, string>} */ (CONSEQUENCE)[key];
  return key !== 'storage.migration-blocked' && receipt && receipt.capture === 'safe' ? `${words} ${UPDATE_SAVES}` : words;
}

// ───────── The Trust Center ─────────

/**
 * @typedef {object} Fact
 * @property {string} label
 * @property {string} text
 * @property {number} [at] - when the fact is a time, for its datetime
 * @property {boolean} [code] - shown as code
 */

/**
 * @typedef {object} Evidence
 * @property {string} title - the provider's label, for a folded row's sub-checks, or a problem's title
 * @property {string} statusText
 * @property {string} tone
 * @property {string} sentence - what the check did, or what the problem means
 * @property {Fact[]} facts
 * @property {boolean} [problem] - a problem that makes a row a check has read worse than its
 *   checks found, or that no check on the page covers, which leads the row's evidence, its own
 *   checks after it as they read (round 4, and the code review's R4-2)
 * @property {boolean} [also] - a check of the row's that passed, under a problem that leads its
 *   evidence: set apart after the rest, as what it tested and Passed (signed as round 5)
 */

/**
 * @typedef {object} RowAction
 * @property {'repair' | 'recovery' | 'site-access'} kind
 * @property {string} label
 * @property {string | null} incidentId
 */

/**
 * @typedef {object} Row
 * @property {string} id - the provider's id, or `platform`
 * @property {string} label
 * @property {string} status
 * @property {string} statusText
 * @property {string} tone
 * @property {number | null} time - the time its status was verified at, for a row that shows one
 * @property {string} text - its second line
 * @property {boolean} attention - it needs the user: a problem that isn't dismissed, or a status that asks
 * @property {boolean} folded - one line, its evidence a disclosure
 * @property {string[]} stillWorks
 * @property {string[]} notWorking
 * @property {Array<{status: string, what: string}>} problemLines - each problem it's counted for
 *   that its line doesn't name, by its status word and its title, as "Not working:" names what
 *   stopped (signed as round 5, and round 5's check titles)
 * @property {Incident[]} open - its open problems that aren't dismissed
 * @property {Incident[]} counted - those that need the user: an update that's waiting doesn't
 *   (change 9)
 * @property {RowAction | null} action
 * @property {Evidence[]} evidence
 * @property {boolean} destinations - the permissions row, which lists where NewTabNote can connect
 * @property {number | null} pending - permissions: AI provider sites asked for and not granted
 */

/**
 * The facts under "How this was checked"
 * @param {string} providerId
 * @param {ProviderEntry} entry
 * @param {HealthReceipt} receipt
 * @param {number} now
 * @returns {Fact[]}
 */
function factsOf(providerId, entry, receipt, now) {
  const until = stampText(receipt.verifiedAt + receipt.freshnessMs, now);
  /** @type {Fact[]} */
  const facts = [
    { label: PAGE.checked, text: fullText(receipt.verifiedAt), at: receipt.verifiedAt },
    { label: PAGE.took, text: durationText(receipt.durationMs) },
    {
      label: PAGE.currentUntil,
      text: fill(entry.costClass === 'local-cheap' ? PAGE.checkedOnOpen : PAGE.checkedLater, { until }),
    },
  ];
  const labels = /** @type {Record<string, string>} */ (EVIDENCE);
  for (const [field, value] of Object.entries(/** @type {Record<string, unknown>} */ (receipt.evidence || {}))) {
    const label = labels[`${providerId}.${field}`] || labels[field] || field;
    if (field === 'since' || field === 'at' || field === 'verifiedAt') {
      facts.push({ label, text: stampText(/** @type {number} */ (value), now), at: /** @type {number} */ (value) });
    } else if (field === 'durationMs' || field === 'timeoutMs' || field === 'ageMs') {
      facts.push({ label, text: durationText(/** @type {number} */ (value)) });
    } else if (field === 'subjectId') {
      facts.push({ label, text: /** @type {Record<string, string>} */ (SUBJECT)[String(value)] || String(value) });
    } else if (field === 'errorCode' || field === 'exception' || field === 'cause' || field === 'faultCode') {
      facts.push({ label, text: String(value), code: true });
    } else if (field === 'seq') {
      facts.push({ label, text: `#${value}` });
    } else {
      facts.push({ label, text: String(value) });
    }
  }
  if (INTERIM.includes(providerId)) facts.push({ label: PAGE.limits, text: INTERIM_LIMIT });
  facts.push({ label: PAGE.check, text: receipt.operation, code: true });
  return facts;
}

/**
 * One provider's evidence, or none when it has no receipt
 * @param {ProviderEntry} entry
 * @param {number} now
 * @returns {Evidence | null}
 */
function evidenceOf(entry, now) {
  if (!entry.receipt) return null;
  const sentences = /** @type {Record<string, string>} */ (OPERATION);
  return {
    title: /** @type {Record<string, {label: string}>} */ (PROVIDER)[entry.providerId].label,
    statusText: statusWords(entry.providerId, entry.status),
    tone: /** @type {Record<string, string>} */ (TONE)[entry.status] || 'unknown',
    sentence: sentences[entry.receipt.operation] || '',
    facts: factsOf(entry.providerId, entry, entry.receipt, now),
  };
}

/** The names a problem's title can start with, which keep their capital mid-sentence */
const NAMES = Object.freeze(['Chrome', 'NewTabNote']);

/**
 * A title as the rest of a sentence: its first letter lower case, unless its first word is a name,
 * as Chrome is, or has capitals of its own, as NewTabNote has
 * @param {string} title
 */
const lowerFirst = title => {
  const [first] = title.split(/[\s']/);
  return NAMES.includes(first) || !/^[A-Z][^A-Z]*$/.test(first) ? title : `${title[0].toLowerCase()}${title.slice(1)}`;
};

/** The capability a row is itself, which its own Not working list doesn't repeat (round 4) */
const ROW_IS = Object.freeze(/** @type {Record<string, string>} */ ({ capture: 'capture' }));

/**
 * A problem that leads a row's evidence, one that makes a row a check has read worse than its
 * checks found, or that no check on the page covers: its title, its severity's status and shape,
 * what it means, and when it was seen
 * @param {Problem} problem
 * @param {number} now
 * @returns {Evidence}
 */
function problemEvidence(problem, now) {
  const status = /** @type {Record<string, string>} */ (SEVERITY_STATUS)[problem.severity];
  return {
    title: problem.title,
    statusText: /** @type {Record<string, string>} */ (STATUS)[status] || status,
    tone: /** @type {Record<string, string>} */ (TONE)[status] || 'unknown',
    sentence: problem.text,
    facts: problemFacts(problem, now),
    problem: true,
  };
}

/**
 * The faults each line states, by the consequence key its words are under (CONSEQUENCE's, or an
 * update's): provider/fault/subject, or provider/fault for any subject. A problem counts as said
 * by its row's line only when its fault is here and the line is its own check's, so a problem the
 * line's words don't state gets a line of its own, though the row's check looks for it, as an
 * older finding of the check's own does beside a failing answer, which looks at nothing (the code
 * review's R8-1, ruled as this table). A capture-risk line states the causes Settings' line gives
 * its words to (status.js), the health records' line their own two (R7-1), and every other line
 * what its own words say.
 */
export const STATED = Object.freeze({
  // The probes' failures, by their causes' words: a test save that failed, the device out of
  // space, a newer NewTabNote's database, and a database that won't open
  'storage.capture-at-risk': Object.freeze(['capture/probe-failed']),
  'storage.quota': Object.freeze(['capture/quota', 'storage/quota']),
  'storage.version-too-new': Object.freeze(['capture/version-too-new', 'storage/version-too-new']),
  'storage.unavailable': Object.freeze(['storage/open-failed/CanvasTabDB', 'storage/probe-failed']),
  'storage.trust-records-unavailable': Object.freeze([OPEN_FAILED_KEY, WRITE_FAILED_KEY]),
  'storage.migration-pending': Object.freeze(['storage/migration-pending']),
  'storage.migration-blocked': Object.freeze(['storage/migration-blocked']),
  'storage.migration-failed': Object.freeze(['storage/migration-failed']),
  'recovery.point-unverified': Object.freeze(['recovery-readiness/point-unverified']),
  'vault.legacy-secret': Object.freeze(['credentials/legacy-secret']),
  // Permissions that changed: a grant missing, or one Chrome gives beyond what's asked for
  'permissions.changed': Object.freeze(['permissions/grant-missing', 'permissions/permission-changed']),
  'permissions.site-access-limited': Object.freeze(['permissions/grant-missing']),
  'inference.load-failed': Object.freeze(['local-inference/load-failed']),
  'indexing.lagging': Object.freeze(['index/lagging']),
  // Search that has to start over is behind as well, which the index's answer reports beside it
  'indexing.resync-required': Object.freeze(['index/stalled', 'index/lagging']),
  'platform.coordinator-unreachable': Object.freeze(['messaging/unreachable']),
  'platform.contribution-unavailable': Object.freeze(['contributions/contribution-unavailable', 'block-types/contribution-unavailable']),
  // What nothing has checked yet, as an interim check, a model that has loaded before, or
  // recovery points none of which is checked, states no problem
  'backup.not-verified': Object.freeze([]),
  'sync.not-verified': Object.freeze([]),
  'inference.not-verified': Object.freeze([]),
  'recovery.no-verified-point': Object.freeze([]),
});

/**
 * A row's second line: a provider that isn't fine says what that means for you, one that's
 * fine or not set up what it found, and anything else what it is. Where its words are a check's
 * finding, the consequence key they're under and whose check it is, for what it states (STATED)
 * @param {string} rowId
 * @param {string} status
 * @param {ProviderEntry[]} entries
 * @param {number} now
 * @returns {{text: string, key: string | null, providerId: string | null}}
 */
function rowLine(rowId, status, entries, now) {
  const notes = /** @type {Record<string, string>} */ (NOTE);
  const about = /** @type {Record<string, {about: string}>} */ (PROVIDER)[rowId].about;
  /** @param {string} text */
  const plain = text => ({ text, key: null, providerId: null });
  if (rowId === 'platform') {
    const bad = entries.find(entry => ATTENTION.includes(entry.status));
    const consequence = bad ? consequenceOf(bad.providerId, bad.receipt, now) : '';
    if (bad && consequence) return { text: consequence, key: /** @type {HealthReceipt} */ (bad.receipt).consequenceKey, providerId: bad.providerId };
    return plain(bad || status !== 'verified' ? about : notes['platform/verified']);
  }
  const [entry] = entries;
  if (status === 'checking') return plain(about);
  const receipt = entry.receipt;
  // No receipt: nothing on this device has checked it yet, which is its reason (change 8). A
  // check that hasn't run can't say more, such as whether the local model has loaded before
  if (!receipt) return plain(PAGE.neverChecked);
  const update = rowId === 'storage' ? updateOf(receipt) : null;
  if (update) return { text: updateText(update, receipt), key: update, providerId: entry.providerId };
  const evidence = /** @type {Record<string, any>} */ ((receipt && receipt.evidence) || {});
  const legacy = rowId === 'recovery-readiness' && evidence.records ? ` ${fill(notes['recovery-readiness/legacy'], { records: evidence.records })}` : '';
  const consequence = consequenceOf(rowId, receipt, now);
  if (consequence) return { text: `${consequence}${legacy}`, key: receipt.consequenceKey, providerId: entry.providerId };
  const note = notes[`${rowId}/${status}`];
  if (note) {
    const verifiedAt = typeof evidence.verifiedAt === 'number' ? stampText(evidence.verifiedAt, now) : '';
    return plain(`${fill(note, { count: evidence.count, verifiedAt })}${legacy}`);
  }
  return plain(about);
}

/**
 * A row's one action, from its next action (next-action.js), as this page can take it: the
 * repair it runs, the problem in the Recovery Center, or Chrome's site access. A check, a
 * Settings area, or another remediation has no action here yet. The Recovery Center is offered
 * only for an incident in `counted`: a dismissed one, or an update that's waiting, asks nothing
 * of the user, and its card has nothing to do (the design look, change 6).
 * @param {string} rowId
 * @param {ProviderEntry[]} entries
 * @param {Incident[]} counted - the row's open incidents that need the user
 * @returns {RowAction | null}
 */
function rowAction(rowId, entries, counted) {
  const next = entries.map(entry => entry.next).find(Boolean) || null;
  if (next && next.kind === 'remediation' && RUNS_HERE.includes(next.remediationId) && next.incidentId) {
    return { kind: 'repair', label: REBUILD.action, incidentId: next.incidentId };
  }
  if (next && next.kind === 'site-access' && rowId === 'permissions') {
    return { kind: 'site-access', label: 'Review site access in Chrome', incidentId: null };
  }
  const named = next && 'incidentId' in next && next.incidentId ? next.incidentId : null;
  const incidentId = named && counted.some(incident => incident.id === named) ? named : counted.length > 0 ? counted[0].id : null;
  if (incidentId) return { kind: 'recovery', label: PAGE.seeInRecovery, incidentId };
  return null;
}

/**
 * What the unfixed problems among `incidents` list as not working. No Still works list on a page
 * that shows them claims any of it, so no card or row there says a capability works while
 * another problem says it doesn't (the design review's round 2, S2). Dismissing a problem
 * doesn't fix it, so a dismissed one counts too.
 * @param {readonly Incident[]} incidents
 * @returns {Set<string>}
 */
const notWorkingOn = incidents =>
  new Set(incidents.filter(incident => incident.state !== 'resolved').flatMap(incident => incident.affected));

/**
 * The Trust Center's rows, in its four groups' order. `checking` names the providers whose
 * checks are running now, which read as checking until they answer.
 * @param {TrustReport} report
 * @param {{now: number, checking?: ReadonlySet<string>}} options
 * @returns {Array<{id: string, title: string, rows: Row[]}>}
 */
export function trustSections(report, { now, checking = new Set() }) {
  /** @param {string} id */
  const entryOf = id => report.providers.find(entry => entry.providerId === id);
  // The rows keep the cards' rule, so both views keep one list (change 6)
  const down = notWorkingOn(report.incidents);
  /**
   * A problem no check on this page covers, such as the background worker's on recovery.html,
   * whose host doesn't run the worker's check
   * @param {Incident} incident
   */
  const uncovered = incident => !entryOf(incident.providerId);
  /**
   * @param {string} rowId
   * @returns {Row | null}
   */
  const rowOf = rowId => {
    const ids = rowId === 'platform' ? PLATFORM : [rowId];
    const entries = /** @type {ProviderEntry[]} */ (ids.map(entryOf).filter(Boolean));
    if (entries.length === 0) return null;
    const statuses = entries.map(entry => (checking.has(entry.providerId) ? 'checking' : entry.status));
    // The folded row reads as the worst of its parts that say anything
    const meaningful = rowId === 'platform' ? statuses.filter(status => status !== 'not-configured') : statuses;
    // What the row's own checks found
    const checked = worstOf(meaningful.length > 0 ? meaningful : statuses);
    // Its own problems, and Saving new notes holds an uncovered one that stops saving new notes
    // (decided at the Design gate, signed as round 3)
    const incidents = report.incidents.filter(
      incident =>
        incident.state !== 'resolved' &&
        (ids.includes(incident.providerId) || (rowId === 'capture' && uncovered(incident) && incident.affected.includes('capture'))),
    );
    const open = incidents.filter(incident => !incident.dismissed);
    const counted = open.filter(incident => !waits(incident, entries[0].receipt));
    // A problem that needs the user gives the row its shape and words where they're worse than
    // its checks', which can't speak for it: Recovery points with something deleted still in a
    // point is Partly working, not Not verified yet (the design review's round 2, S3, and round 4)
    const status = worstOf([checked, ...counted.map(incident => /** @type {Record<string, string>} */ (SEVERITY_STATUS)[incident.severity])]);
    // Storage's update state, when its check reported one: its own words and shape, and a wait
    // that needs no one (change 9)
    const update = rowId === 'storage' && status === 'degraded' ? updateOf(entries[0].receipt) : null;
    const waiting = update !== null && WAITING.includes(update);
    const attention = counted.length > 0 || (ATTENTION.includes(status) && !waiting);
    // A row that needs the user because of a problem, its checks finding nothing to ask, says
    // which by its title, in place of its check's sentence (round 2, S3)
    const [named] = counted.length > 0 && !ATTENTION.includes(checked) ? problemsOf(counted, new Map(), id => entryOf(id) || null) : [];
    // Each row names each problem it's counted for that its line doesn't: the line names its
    // first problem, or is what a check that found something found, which states only the
    // faults its words state (STATED), whatever else that check looks for. So the headline's
    // link lands on what it counted, on any row, and no line repeats the row's (the Design
    // gate's review of round 4's shots, signed as round 5, and the code review's R5-2, R6-1,
    // R7-1 and R8-1)
    const line = named ? null : rowLine(rowId, checked, entries, now);
    const stated = /** @type {Record<string, readonly string[]>} */ (STATED)[(line && line.key) || ''] || [];
    /** @param {Incident} incident */
    const said = incident =>
      line !== null &&
      incident.providerId === line.providerId &&
      (stated.includes(`${incident.providerId}/${incident.faultCode}/${incident.subjectId || '-'}`) ||
        stated.includes(`${incident.providerId}/${incident.faultCode}`));
    const problemLines = problemsOf(counted, new Map(), id => entryOf(id) || null)
      .filter(problem => (named ? problem.title !== named.title : !problem.incidents.every(said)))
      .map(problem => ({
        status: /** @type {Record<string, string>} */ (STATUS)[/** @type {Record<string, string>} */ (SEVERITY_STATUS)[problem.severity]],
        what: lowerFirst(problem.title),
      }));
    const showsTime = !['not-configured', 'off', 'unsupported', 'checking', 'unverified'].includes(status);
    const verifiedTimes = entries
      .filter(entry => entry.receipt && (rowId !== 'platform' || entry.status === 'verified'))
      .map(entry => /** @type {HealthReceipt} */ (entry.receipt).verifiedAt);
    const stillWorks = [...new Set(entries.flatMap(entry => (attention ? entry.stillWorks : [])))];
    // Saving new notes doesn't list saving new notes, which its name and status already say (round 4)
    const notWorking = [...new Set(open.flatMap(incident => incident.affected))].filter(capability => ROW_IS[rowId] !== capability);
    // A problem that makes the row worse than its checks found leads the row's evidence where a
    // check has read the row, and one no check here covers leads it anywhere, so a row it fails
    // never offers a check that passed as its evidence: those come after it, as they read. A row
    // no check has read has no check to correct, so its finding stays its line and its card
    // (round 4, and the code review's R4-2 and its fix check)
    const read = entries.some(entry => entry.receipt);
    /** @param {Incident} incident */
    const leads = incident =>
      uncovered(incident) ||
      (read && worstOf([checked, /** @type {Record<string, string>} */ (SEVERITY_STATUS)[incident.severity]]) !== checked);
    const problemsFirst = counted.some(leads)
      ? problemsOf(counted.filter(leads), new Map(), id => entryOf(id) || null).map(problem => problemEvidence(problem, now))
      : [];
    const checks = entries.filter(entry => entry.receipt);
    // Under a problem that leads, the row's checks that passed come last, set apart, each as what
    // it tested and Passed, so Saving new notes never reads beside Verified while it isn't
    // working. A check that didn't pass reads where it did, and with no problem leading each
    // reads as it does (the Design gate's review of round 4's shots, signed as round 5)
    const apart = problemsFirst.length > 0 ? checks.filter(entry => entry.status === 'verified') : [];
    const tested = /** @type {Record<string, string>} */ (TESTED);
    const ownEvidence = [
      ...checks.filter(entry => !apart.includes(entry)).map(entry => /** @type {Evidence} */ (evidenceOf(entry, now))),
      ...apart.map(entry => {
        const evidence = /** @type {Evidence} */ (evidenceOf(entry, now));
        return { ...evidence, title: tested[entry.providerId] || evidence.title, statusText: PAGE.passed, also: true };
      }),
    ];
    return {
      id: rowId,
      label: /** @type {Record<string, {label: string}>} */ (PROVIDER)[rowId].label,
      status,
      statusText: update
        ? /** @type {Record<string, {text: string}>} */ (UPDATE_STATUS)[update].text
        : rowId === 'platform'
          ? /** @type {Record<string, string>} */ (STATUS)[status]
          : statusWords(rowId, status),
      tone: update ? /** @type {Record<string, {tone: string}>} */ (UPDATE_STATUS)[update].tone : /** @type {Record<string, string>} */ (TONE)[status] || 'unknown',
      // A check's time, never beside the shape of a problem no check here covers
      time: status === checked && showsTime && verifiedTimes.length > 0 ? Math.max(...verifiedTimes) : null,
      text: named ? `${named.title}.` : /** @type {{text: string}} */ (line).text,
      attention,
      // A row whose status gives its reason, or that asks for nothing, folds; a row reading
      // "Not verified yet" or "Not checked recently" keeps its reason in sight, and so does a
      // Cloud AI row that's set up, which says what leaves the device (change 8). A row being
      // checked stays one line until its check answers, so the page doesn't jump (mockup t5)
      folded:
        !attention &&
        (status === 'checking' || (FOLDED.includes(status) && !(rowId === 'remote-ai' && status !== 'not-configured'))),
      stillWorks: stillWorks.filter(capability => !down.has(capability)),
      notWorking,
      problemLines,
      open,
      counted,
      action: rowAction(rowId, entries, counted),
      evidence: [...problemsFirst, ...ownEvidence],
      destinations: rowId === 'permissions',
      pending:
        rowId === 'permissions' && entries[0].receipt && typeof entries[0].receipt.evidence.pending === 'number'
          ? entries[0].receipt.evidence.pending
          : null,
    };
  };
  return PAGE.sections.map(section => ({
    id: section.id,
    title: section.title,
    rows: /** @type {Row[]} */ (section.rows.map(rowOf).filter(Boolean)),
  }));
}

/**
 * @typedef {object} Headline
 * @property {string} tone
 * @property {string} title
 * @property {string} proof
 * @property {boolean} openRecovery - its one button opens the Recovery Center
 * @property {Array<{id: string, label: string}>} attention - the rows that need you, linked
 */

/**
 * The Trust Center's headline, from the summary and the two core rows
 * @param {TrustSummary} summary
 * @param {Row[]} rows
 * @param {{now: number, checking: boolean}} options
 * @returns {Headline}
 */
export function trustHeadline(summary, rows, { now, checking }) {
  const core = rows.filter(row => row.id === 'capture' || row.id === 'storage');
  const atRisk = summary.capture === 'at-risk';
  /**
   * The rows that need the user, each its link. Under a headline a problem leads, a row counts
   * only if it holds a problem that needs the user besides the leading ones, which the headline
   * names, so the line never counts one as other (the code review's R4-1)
   * @param {(incident: Incident) => boolean} [leads]
   */
  const needing = leads =>
    rows
      .filter(row => row.attention && (!leads || row.counted.some(incident => !leads(incident))))
      .map(row => ({ id: row.id, label: row.label }));
  const attention = needing();
  const verified = core.filter(row => row.status === 'verified' && row.time !== null).map(row => /** @type {number} */ (row.time));
  if (atRisk) {
    // At the background worker's risk, Saving new notes follows its problem, so the proof names
    // it by its title, with no check's time (#20 slice 4c). The capture-risk problems Saving new
    // notes and Notes database hold lead it
    const worst = core.find(row => row.id === 'storage' && row.attention) || core.find(row => row.attention) || core[0];
    const checkedAt = worst && worst.time !== null ? ` Checked ${whenText(worst.time, now)}.` : '';
    const leading = new Set(core.flatMap(row => row.counted).filter(incident => incident.severity === 'capture-risk').map(incident => incident.id));
    return {
      tone: 'failed',
      title: PAGE.atRisk,
      proof: `${worst ? worst.text : ''}${checkedAt}`.trim(),
      openRecovery: true,
      attention: needing(incident => leading.has(incident.id)),
    };
  }
  if (checking && verified.length === 0) {
    return { tone: 'checking', title: PAGE.checkingNotes, proof: PAGE.checkingProof, openRecovery: false, attention };
  }
  if (summary.records === 'fallback') {
    // The records' own two problems lead it
    const records = needing(incident => incident.key === OPEN_FAILED_KEY || incident.key === WRITE_FAILED_KEY);
    return { tone: 'action', title: PAGE.cantConfirm, proof: PAGE.cantConfirmProof, openRecovery: true, attention: records };
  }
  if (summary.worstCore === 'stale' || summary.worstCore === 'unverified' || verified.length === 0) {
    const last = core.map(row => row.time).filter(time => time !== null);
    return {
      tone: 'unknown',
      title: summary.worstCore === 'stale' ? PAGE.notCheckedRecently : PAGE.notVerifiedYet,
      proof: last.length > 0 ? fill(PAGE.lastChecked, { when: whenText(Math.max(.../** @type {number[]} */ (last)), now) }) : PAGE.neverChecked,
      openRecovery: false,
      attention,
    };
  }
  // The half-filled shape only when a core row shows it: a waiting update's row shows the dashed
  // ring, so the headline stays as when every check passed, and its attention line says the rest
  // (the design look, round 7)
  const degraded = core.filter(row => row.status === 'degraded');
  const partial = degraded.find(row => row.tone === 'partial');
  if (summary.worstCore === 'degraded' && (partial || degraded.length === 0)) {
    return { tone: 'partial', title: PAGE.saving, proof: (partial && partial.text) || PAGE.partOfDatabase, openRecovery: false, attention };
  }
  return {
    tone: 'ok',
    title: PAGE.saving,
    proof: fill(PAGE.savingProof, { when: whenText(Math.max(...verified), now) }),
    openRecovery: false,
    attention,
  };
}

/**
 * The headline's attention line: "2 things need your attention: Saved keys and Permissions.",
 * and past two, "Saved keys and 2 more need your attention." Under a headline a problem leads,
 * at capture risk and at can't confirm, the rest are other: "2 other things need your
 * attention: ...", as the header's badge counts them all (round 4)
 * @param {readonly {label: string}[]} rows
 * @param {boolean} [other] - a problem leads the headline
 */
export function attentionText(rows, other = false) {
  if (rows.length > 2) return fill(PAGE.attentionMore, { first: rows[0].label, count: rows.length - 1 });
  const names = joinList(rows.map(row => row.label));
  if (other) return rows.length === 1 ? fill(PAGE.attentionOtherOne, { names }) : fill(PAGE.attentionOther, { count: rows.length, names });
  return rows.length === 1 ? fill(PAGE.attentionOne, { names }) : fill(PAGE.attention, { count: `${rows.length} things`, names });
}

// ───────── The Recovery Center ─────────

/**
 * A problem: incidents with the same title read as one, such as a key in two places, or out of
 * space seen by both capture and storage
 * @typedef {object} Problem
 * @property {string} key - provider/fault
 * @property {string} title
 * @property {string} resolvedTitle - its title under "Fixed just now"
 * @property {string} severity
 * @property {string} tone
 * @property {Incident[]} incidents
 * @property {number} firstSeenAt
 * @property {number} lastSeenAt
 * @property {number} occurrences
 * @property {string} text
 * @property {string[]} places - where a saved key is, in words
 * @property {string[]} stillWorks
 * @property {string[]} notWorking
 * @property {string | null} repair - the remediation this page runs for it, when its provider observes the fault
 * @property {boolean} dismissable
 * @property {boolean} dismissed
 * @property {number | null} dismissedAt
 * @property {boolean} resolved
 * @property {number | null} resolvedAt
 * @property {string} rowId - the Trust Center row it belongs to
 * @property {boolean} waiting - an update that's waiting, which counts as needing attention nowhere (change 9)
 * @property {boolean} updateWait - an update waiting, for free space or not, which takes the dashed
 *   ring and sits under Waiting
 */

/**
 * An incident's title. A check's incident carries no evidence of its own (checks.js), so its
 * counts come from `evidence`, its provider's latest receipt's, and why an update waits from
 * `why` (whyOf's)
 * @param {Incident} incident
 * @param {Record<string, unknown>} [evidence]
 * @param {Readonly<Record<string, unknown>> | null} [why]
 */
export function incidentTitle(incident, evidence = {}, why = { ...evidence, ...(incident.evidence || {}) }) {
  const titles = /** @type {Record<string, string>} */ (INCIDENT);
  evidence = /** @type {Record<string, any>} */ ({ ...evidence, ...(incident.evidence || {}) });
  const long = `${incident.providerId}/${incident.faultCode}/${incident.subjectId}`;
  const short = `${incident.providerId}/${incident.faultCode}`;
  // An update waiting on anything but free space reads as an update waiting (change 9)
  if (incident.providerId === 'storage' && updateKeyOf(incident.faultCode, why) === 'storage.migration-pending') {
    return titles['storage/migration-pending'];
  }
  return fill(titles[long] || titles[short] || 'Part of NewTabNote needs a look', { count: evidence.count });
}

/**
 * The problems `incidents` make, worst first and then most recently seen. `next` is each open
 * incident's card action from recovery.incidents, so no view picks its own. `providerOf` is a
 * provider's row in trust.report: its latest receipt's evidence holds the counts a check's
 * incidents don't, and its `stillWorks` is the one Still works list both views show (change 6),
 * less what an unfixed problem among `incidents` lists as not working.
 * @param {readonly Incident[]} incidents
 * @param {ReadonlyMap<string, {kind: string, remediationId?: string} | null>} [next]
 * @param {(providerId: string) => ProviderEntry | null} [providerOf]
 * @returns {Problem[]}
 */
export function problemsOf(incidents, next = new Map(), providerOf = () => null) {
  /** @param {string} providerId */
  const evidenceOf = providerId => {
    const entry = providerOf(providerId);
    return /** @type {Record<string, unknown>} */ ((entry && entry.receipt && entry.receipt.evidence) || {});
  };
  /** @param {Incident} incident */
  const whyFor = incident => {
    const entry = providerOf(incident.providerId);
    return whyOf(entry ? entry.receipt : null, incident.evidence || {});
  };
  // What any unfixed problem here lists as not working, which no card's Still works claims
  const down = notWorkingOn(incidents);
  /** @type {Map<string, Incident[]>} */
  const byTitle = new Map();
  for (const incident of incidents) {
    const title = incidentTitle(incident, evidenceOf(incident.providerId), whyFor(incident));
    const list = byTitle.get(title) || [];
    list.push(incident);
    byTitle.set(title, list);
  }
  const resolvedTitles = /** @type {Record<string, string>} */ (RESOLVED);
  const texts = /** @type {Record<string, string>} */ (INCIDENT_TEXT);
  const places = /** @type {Record<string, string>} */ (SECRET_PLACE);
  /** @type {Problem[]} */
  const problems = [];
  for (const [title, list] of byTitle) {
    const [first] = list;
    const key = `${first.providerId}/${first.faultCode}`;
    const subjectKey = `${key}/${first.subjectId}`;
    const severity = SEVERITY_ORDER.find(name => list.some(incident => incident.severity === name)) || first.severity;
    const affected = [...new Set(list.flatMap(incident => incident.affected))];
    // The provider row's own list where the report has one, else what these incidents preserve,
    // less what they or any other unfixed problem here affects
    const entry = providerOf(first.providerId);
    const preserved = (entry && Array.isArray(entry.stillWorks) ? [...entry.stillWorks] : [...new Set(list.flatMap(incident => incident.preserved))]).filter(
      name => !affected.includes(name) && !down.has(name),
    );
    const evidence = /** @type {Record<string, any>} */ ({ ...evidenceOf(first.providerId), ...(first.evidence || {}) });
    const action = list.map(incident => next.get(incident.id)).find(Boolean) || null;
    const repair = action && action.kind === 'remediation' && action.remediationId && RUNS_HERE.includes(action.remediationId) ? action.remediationId : null;
    const resolved = list.every(incident => incident.state === 'resolved');
    const resolvedTimes = list.map(incident => incident.resolvedAt).filter(at => typeof at === 'number');
    const dismissed = !resolved && list.every(incident => incident.dismissed);
    const dismissTimes = list.map(incident => incident.dismissChangedAt).filter(at => typeof at === 'number');
    const rowId = PLATFORM.includes(first.providerId) ? 'platform' : first.providerId;
    const update = first.providerId === 'storage' ? updateKeyOf(first.faultCode, whyFor(first)) : null;
    // An update waiting, for free space or not, takes the dashed ring, its row's shape, and sits
    // under Waiting (the design look, round 7)
    const updateWait = update !== null && update !== 'storage.migration-failed';
    const waiting = update !== null && WAITING.includes(update);
    problems.push({
      key,
      title,
      // By its subject first, so the health records' own database never reads as the notes one
      resolvedTitle: resolvedTitles[subjectKey] || resolvedTitles[key] || title,
      severity,
      tone: updateWait ? 'unknown' : /** @type {Record<string, string>} */ (SEVERITY_TONE)[severity] || 'partial',
      incidents: list,
      firstSeenAt: Math.min(...list.map(incident => incident.firstSeenAt)),
      lastSeenAt: Math.max(...list.map(incident => incident.lastSeenAt)),
      occurrences: Math.max(...list.map(incident => incident.occurrences)),
      // How far behind search is when its receipt says, and otherwise what that means
      text: update
        ? updateText(update, entry ? entry.receipt : null)
        : key === 'index/lagging' && typeof evidence.lag === 'number' && evidence.lag > 0
          ? fill(CONSEQUENCE['indexing.lagging'], { lag: evidence.lag })
          : fill(texts[key] || '', { count: list.length }),
      places: key === 'credentials/legacy-secret' ? list.map(incident => capitalize(places[String(incident.subjectId)] || String(incident.subjectId))) : [],
      stillWorks: preserved,
      notWorking: affected,
      repair,
      // A capture-risk problem stays in sight until it's fixed, and an update that's waiting
      // counts nowhere, so there's nothing to dismiss
      dismissable: severity !== 'capture-risk' && !resolved && !waiting,
      dismissed,
      dismissedAt: dismissed && dismissTimes.length > 0 ? Math.max(.../** @type {number[]} */ (dismissTimes)) : null,
      resolved,
      resolvedAt: resolved && resolvedTimes.length > 0 ? Math.max(.../** @type {number[]} */ (resolvedTimes)) : null,
      rowId: /** @type {Record<string, unknown>} */ (PROVIDER)[rowId] ? rowId : first.providerId,
      waiting,
      updateWait,
    });
  }
  return problems.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.lastSeenAt - a.lastSeenAt,
  );
}

/**
 * A problem's facts: when it was first and last seen, how often, its error, and its refs
 * @param {Problem} problem
 * @param {number} now
 * @returns {Fact[]}
 */
export function problemFacts(problem, now) {
  const evidence = /** @type {Record<string, any>} */ (problem.incidents[0].evidence || {});
  /** @type {Fact[]} */
  const facts = [
    { label: PAGE.firstSeen, text: stampText(problem.firstSeenAt, now), at: problem.firstSeenAt },
    { label: PAGE.lastSeen, text: stampText(problem.lastSeenAt, now), at: problem.lastSeenAt },
    { label: PAGE.timesSeen, text: String(problem.occurrences) },
  ];
  if (evidence.errorCode) {
    facts.push({ label: PAGE.error, text: [evidence.errorCode, evidence.exception].filter(Boolean).join(' '), code: true });
  }
  facts.push({ label: PAGE.ref, text: problem.incidents.map(incident => incident.ref).join(', ') });
  return facts;
}

/**
 * A fixed problem's line under its resolved title: when, and that a check passed, after the
 * rebuild when one of its runs succeeded before it was resolved (s5)
 * @param {Problem} problem
 * @param {readonly {commandId: string, incidentId: string | null, state: string, updatedAt: number}[]} runs
 * @param {number} now
 */
export function fixedLine(problem, runs, now) {
  const at = problem.resolvedAt;
  if (at === null) return '';
  // Only a check says "a check passed": an event or the records themselves resolve the rest
  if (!problem.incidents.every(resolvedByCheck)) return fill(PAGE.resolvedAt, { time: stampText(at, now) });
  const ids = new Set(problem.incidents.map(incident => incident.id));
  const rebuilt = runs.some(
    run => run.commandId === 'rebuild-index' && run.state === 'succeeded' && run.incidentId !== null && ids.has(run.incidentId) && run.updatedAt <= at,
  );
  return fill(rebuilt ? PAGE.fixedAfterRebuild : PAGE.fixedAfterCheck, { time: stampText(at, now) });
}

/** Each provider's faults its check looks for (catalog.js's `observes`), as provider/fault */
const CHECKED = new Set(
  PROVIDERS.flatMap(provider => /** @type {readonly string[]} */ (provider.observes).map(fault => `${provider.id}/${fault}`)),
);

/** The faults a success event resolves (event-codes.js's `resolves`), as provider/fault */
const BY_EVENT = new Set(
  Object.values(EVENT_CODES).flatMap(entry => {
    const failure = entry.resolves ? /** @type {Record<string, {incident?: {providerId: string, faultCode: string}}>} */ (EVENT_CODES)[entry.resolves] : null;
    return failure && failure.incident ? [`${failure.incident.providerId}/${failure.incident.faultCode}`] : [];
  }),
);

/**
 * Whether a check resolves `incident`: its fault is one its provider's check looks for, no
 * success event resolves it too, and it isn't one of the two the records resolve themselves
 * (trust-records.js). Anything else says only when it was resolved.
 * @param {Incident} incident
 */
function resolvedByCheck(incident) {
  const fault = `${incident.providerId}/${incident.faultCode}`;
  return CHECKED.has(fault) && !BY_EVENT.has(fault) && incident.key !== OPEN_FAILED_KEY && incident.key !== WRITE_FAILED_KEY;
}

/**
 * The Recovery Center's headline, from its open problems and the summary
 * @param {readonly Problem[]} open - the open problems that aren't dismissed
 * @param {TrustSummary} summary
 * @param {{now: number, lastCheckedAt: number | null, dismissed?: number, waiting?: number}} options -
 *   `dismissed`: how many open problems are dismissed; `waiting`: how many are an update that's
 *   waiting, which needs no one (change 9)
 * @returns {{tone: string, title: string, proof: string}}
 */
export function recoveryHeadline(open, summary, { now, lastCheckedAt, dismissed = 0, waiting = 0 }) {
  if (open.length === 0 && (dismissed > 0 || waiting > 0)) {
    // Every open problem is dismissed, or an update that's waiting: none needs the user, and some are still there
    return {
      tone: 'ok',
      title: PAGE.nothingNeedsYou,
      proof: lastCheckedAt !== null ? fill(PAGE.lastChecksRan, { when: whenText(lastCheckedAt, now) }) : '',
    };
  }
  if (open.length === 0) {
    return {
      tone: 'ok',
      title: PAGE.nothingToRecover,
      proof: lastCheckedAt !== null ? fill(PAGE.nothingToRecoverProof, { when: whenText(lastCheckedAt, now) }) : PAGE.noProblemsYet,
    };
  }
  if (open[0].severity === 'capture-risk') {
    const others = open.length - 1;
    return {
      tone: 'failed',
      title: PAGE.atRisk,
      proof: others > 0 ? fill(PAGE.othersBelow, { count: plural(others, 'other problem is', 'other problems are') }) : '',
    };
  }
  return {
    // An update waiting for free space takes its card's dashed ring when it's all there is
    tone: open.every(problem => problem.updateWait)
      ? 'unknown'
      : open.some(problem => problem.severity === 'data-risk')
        ? 'action'
        : 'partial',
    title: fill(PAGE.problems, { count: plural(open.length, 'problem', 'problems') }),
    // "Saving normally" only on the summary's own word for it, and no promise about the cards
    // while the health records can't be saved, when they may not say what still works (N3)
    proof:
      summary.records === 'fallback'
        ? PAGE.cantConfirmProof
        : summary.capture === 'safe'
          ? PAGE.problemsProof
          : PAGE.problemsProofUnsure,
  };
}

/**
 * Why a run, or a refusal to start one, stopped, in words
 * @param {string | null | undefined} code
 */
export const reasonText = code => (code && /** @type {Record<string, string>} */ (REASON)[code]) || REASON_FALLBACK;

/**
 * A recent repair's result. A run that finished says "checked" only once its problem's check
 * passed after it: still there when a sighting came after it, and not checked yet with no
 * word since, or no problem to read. A sighting in the millisecond of the run's last update
 * counts as after it, as a resolution then does (#265): the page asks for the check after a
 * run only once the run has answered, after that update is stored, so the check never reads an
 * earlier time, and on a fast machine it reads the same one. A sighting from before the run's
 * end shares that millisecond only when another check lands in it, and the check after the run
 * settles the row once it lands.
 * @param {RemediationRun} run
 * @param {readonly Incident[]} [incidents]
 * @returns {{tone: string, text: string}}
 */
export function runResult(run, incidents = []) {
  if (run.state === 'succeeded') {
    const incident = run.incidentId === null ? null : incidents.find(candidate => candidate.id === run.incidentId) || null;
    if (incident && incident.state === 'resolved' && incident.resolvedAt !== null && incident.resolvedAt >= run.updatedAt) {
      return { tone: 'ok', text: PAGE.doneAndChecked };
    }
    if (incident && incident.state !== 'resolved' && incident.lastSeenAt >= run.updatedAt) return { tone: 'partial', text: PAGE.doneStillThere };
    return { tone: 'todo', text: PAGE.doneNotChecked };
  }
  if (run.state === 'failed') return { tone: 'failed', text: fill(PAGE.failedRun, { reason: reasonText(run.outcome) }) };
  if (run.state === 'interrupted') {
    const steps = /** @type {Record<string, string>} */ (STEP);
    return { tone: 'action', text: fill(PAGE.cutOff, { step: (run.step && steps[run.step]) || run.step || '' }) };
  }
  // A rebuild that found nothing to write, or a preview whose confirmation expired, ended
  // without the user cancelling anything
  if (run.state === 'cancelled' && run.outcome === 'nothing-to-do') return { tone: 'absent', text: PAGE.nothingToDoRun };
  if (run.state === 'cancelled' && run.outcome === 'run-expired') return { tone: 'absent', text: PAGE.previewExpiredRun };
  return { tone: 'absent', text: PAGE.cancelled };
}
