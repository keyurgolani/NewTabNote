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
} from './copy.js';

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

/** The providers the "NewTabNote's own parts" row folds into one */
export const PLATFORM = Object.freeze(['messaging', 'contributions', 'block-types']);

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

const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const full = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {number} at */
const dayOf = at => new Date(at).toDateString();

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

/**
 * Inside a sentence: at 10:42 AM, yesterday at 7:02 PM, on Oct 28
 * @param {number} at
 * @param {number} now
 */
export function whenText(at, now) {
  if (dayOf(at) === dayOf(now)) return `at ${clock.format(at)}`;
  if (dayOf(at) === dayOf(now - DAY_MS)) return `yesterday at ${clock.format(at)}`;
  return `on ${day.format(at)}`;
}

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
 * @property {string} title - the provider's label, for a folded row's sub-checks
 * @property {string} statusText
 * @property {string} tone
 * @property {string} sentence - what the check did
 * @property {Fact[]} facts
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
 * @property {Incident[]} open - its open problems that aren't dismissed
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

/**
 * A row's second line: a provider that isn't fine says what that means for you, one that's
 * fine or not set up what it found, and anything else what it is
 * @param {string} rowId
 * @param {string} status
 * @param {ProviderEntry[]} entries
 * @param {number} now
 */
function rowText(rowId, status, entries, now) {
  const notes = /** @type {Record<string, string>} */ (NOTE);
  const about = /** @type {Record<string, {about: string}>} */ (PROVIDER)[rowId].about;
  if (rowId === 'platform') {
    const bad = entries.find(entry => ATTENTION.includes(entry.status));
    if (bad) return consequenceOf(bad.providerId, bad.receipt, now) || about;
    return status === 'verified' ? notes['platform/verified'] : about;
  }
  const [entry] = entries;
  if (status === 'checking') return about;
  const receipt = entry.receipt;
  // No receipt: nothing on this device has checked it yet, which is its reason (change 8). A
  // check that hasn't run can't say more, such as whether the local model has loaded before
  if (!receipt) return PAGE.neverChecked;
  const evidence = /** @type {Record<string, any>} */ ((receipt && receipt.evidence) || {});
  const legacy = rowId === 'recovery-readiness' && evidence.records ? ` ${fill(notes['recovery-readiness/legacy'], { records: evidence.records })}` : '';
  const consequence = consequenceOf(rowId, receipt, now);
  if (consequence) return `${consequence}${legacy}`;
  const note = notes[`${rowId}/${status}`];
  if (note) {
    const verifiedAt = typeof evidence.verifiedAt === 'number' ? stampText(evidence.verifiedAt, now) : '';
    return `${fill(note, { count: evidence.count, verifiedAt })}${legacy}`;
  }
  return about;
}

/**
 * A row's one action, from its next action (next-action.js), as this page can take it: the
 * repair it runs, the problem in the Recovery Center, or Chrome's site access. A check, a
 * Settings area, or another remediation has no action here yet.
 * @param {string} rowId
 * @param {ProviderEntry[]} entries
 * @param {Incident[]} open
 * @returns {RowAction | null}
 */
function rowAction(rowId, entries, open) {
  const next = entries.map(entry => entry.next).find(Boolean) || null;
  if (next && next.kind === 'remediation' && RUNS_HERE.includes(next.remediationId) && next.incidentId) {
    return { kind: 'repair', label: REBUILD.action, incidentId: next.incidentId };
  }
  if (next && next.kind === 'site-access' && rowId === 'permissions') {
    return { kind: 'site-access', label: 'Review site access in Chrome', incidentId: null };
  }
  const incidentId = next && 'incidentId' in next && next.incidentId ? next.incidentId : open.length > 0 ? open[0].id : null;
  if (incidentId) return { kind: 'recovery', label: PAGE.seeInRecovery, incidentId };
  return null;
}

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
    const status = worstOf(meaningful.length > 0 ? meaningful : statuses);
    const incidents = report.incidents.filter(incident => ids.includes(incident.providerId) && incident.state !== 'resolved');
    const open = incidents.filter(incident => !incident.dismissed);
    const attention = open.length > 0 || ATTENTION.includes(status);
    const showsTime = !['not-configured', 'off', 'unsupported', 'checking', 'unverified'].includes(status);
    const verifiedTimes = entries
      .filter(entry => entry.receipt && (rowId !== 'platform' || entry.status === 'verified'))
      .map(entry => /** @type {HealthReceipt} */ (entry.receipt).verifiedAt);
    const stillWorks = [...new Set(entries.flatMap(entry => (attention ? entry.stillWorks : [])))];
    const notWorking = [...new Set(open.flatMap(incident => incident.affected))];
    return {
      id: rowId,
      label: /** @type {Record<string, {label: string}>} */ (PROVIDER)[rowId].label,
      status,
      statusText: rowId === 'platform' ? /** @type {Record<string, string>} */ (STATUS)[status] : statusWords(rowId, status),
      tone: /** @type {Record<string, string>} */ (TONE)[status] || 'unknown',
      time: showsTime && verifiedTimes.length > 0 ? Math.max(...verifiedTimes) : null,
      text: rowText(rowId, status, entries, now),
      attention,
      // A row whose status gives its reason, or that asks for nothing, folds; a row reading
      // "Not verified yet" or "Not checked recently" keeps its reason in sight, and so does a
      // Cloud AI row that's set up, which says what leaves the device (change 8). A row being
      // checked stays one line until its check answers, so the page doesn't jump (mockup t5)
      folded:
        !attention &&
        (status === 'checking' || (FOLDED.includes(status) && !(rowId === 'remote-ai' && status !== 'not-configured'))),
      stillWorks: stillWorks.filter(capability => !notWorking.includes(capability)),
      notWorking,
      open,
      action: rowAction(rowId, entries, open),
      evidence: /** @type {Evidence[]} */ (entries.map(entry => evidenceOf(entry, now)).filter(Boolean)),
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
  const attention = rows
    .filter(row => row.attention && !(atRisk && (row.id === 'capture' || row.id === 'storage')))
    .map(row => ({ id: row.id, label: row.label }));
  const verified = core.filter(row => row.status === 'verified' && row.time !== null).map(row => /** @type {number} */ (row.time));
  if (atRisk) {
    const worst = core.find(row => row.id === 'storage' && row.attention) || core.find(row => row.attention) || core[0];
    const checkedAt = worst && worst.time !== null ? ` Checked ${whenText(worst.time, now)}.` : '';
    return { tone: 'failed', title: PAGE.atRisk, proof: `${worst ? worst.text : ''}${checkedAt}`.trim(), openRecovery: true, attention };
  }
  if (checking && verified.length === 0) {
    return { tone: 'checking', title: PAGE.checkingNotes, proof: PAGE.checkingProof, openRecovery: false, attention };
  }
  if (summary.records === 'fallback') {
    return { tone: 'action', title: PAGE.cantConfirm, proof: PAGE.cantConfirmProof, openRecovery: true, attention };
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
  if (summary.worstCore === 'degraded') {
    const degraded = core.find(row => row.status === 'degraded');
    return { tone: 'partial', title: PAGE.saving, proof: (degraded && degraded.text) || PAGE.partOfDatabase, openRecovery: false, attention };
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
 * and past two, "Saved keys and 2 more need your attention."
 * @param {readonly {label: string}[]} rows
 */
export function attentionText(rows) {
  if (rows.length > 2) return fill(PAGE.attentionMore, { first: rows[0].label, count: rows.length - 1 });
  const names = joinList(rows.map(row => row.label));
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
 */

/**
 * An incident's title. A check's incident carries no evidence of its own (checks.js), so its
 * counts come from `evidence`, its provider's latest receipt's.
 * @param {Incident} incident
 * @param {Record<string, unknown>} [evidence]
 */
export function incidentTitle(incident, evidence = {}) {
  const titles = /** @type {Record<string, string>} */ (INCIDENT);
  evidence = /** @type {Record<string, any>} */ ({ ...evidence, ...(incident.evidence || {}) });
  const long = `${incident.providerId}/${incident.faultCode}/${incident.subjectId}`;
  const short = `${incident.providerId}/${incident.faultCode}`;
  return fill(titles[long] || titles[short] || 'Part of NewTabNote needs a look', { count: evidence.count });
}

/**
 * The problems `incidents` make, worst first and then most recently seen. `next` is each open
 * incident's card action from recovery.incidents, so no view picks its own. `providerOf` is a
 * provider's row in trust.report: its latest receipt's evidence holds the counts a check's
 * incidents don't, and its `stillWorks` is the one Still works list both views show (change 6).
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
  /** @type {Map<string, Incident[]>} */
  const byTitle = new Map();
  for (const incident of incidents) {
    const title = incidentTitle(incident, evidenceOf(incident.providerId));
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
    const severity = SEVERITY_ORDER.find(name => list.some(incident => incident.severity === name)) || first.severity;
    const affected = [...new Set(list.flatMap(incident => incident.affected))];
    // The provider row's own list where the report has one, else what these incidents preserve
    const entry = providerOf(first.providerId);
    const preserved = (entry && Array.isArray(entry.stillWorks) ? [...entry.stillWorks] : [...new Set(list.flatMap(incident => incident.preserved))]).filter(
      name => !affected.includes(name),
    );
    const evidence = /** @type {Record<string, any>} */ ({ ...evidenceOf(first.providerId), ...(first.evidence || {}) });
    const action = list.map(incident => next.get(incident.id)).find(Boolean) || null;
    const repair = action && action.kind === 'remediation' && action.remediationId && RUNS_HERE.includes(action.remediationId) ? action.remediationId : null;
    const resolved = list.every(incident => incident.state === 'resolved');
    const resolvedTimes = list.map(incident => incident.resolvedAt).filter(at => typeof at === 'number');
    const dismissed = !resolved && list.every(incident => incident.dismissed);
    const dismissTimes = list.map(incident => incident.dismissChangedAt).filter(at => typeof at === 'number');
    const rowId = PLATFORM.includes(first.providerId) ? 'platform' : first.providerId;
    problems.push({
      key,
      title,
      resolvedTitle: resolvedTitles[key] || title,
      severity,
      tone: /** @type {Record<string, string>} */ (SEVERITY_TONE)[severity] || 'partial',
      incidents: list,
      firstSeenAt: Math.min(...list.map(incident => incident.firstSeenAt)),
      lastSeenAt: Math.max(...list.map(incident => incident.lastSeenAt)),
      occurrences: Math.max(...list.map(incident => incident.occurrences)),
      // How far behind search is when its receipt says, and otherwise what that means
      text: key === 'index/lagging' && typeof evidence.lag === 'number' && evidence.lag > 0
        ? fill(CONSEQUENCE['indexing.lagging'], { lag: evidence.lag })
        : fill(texts[key] || '', { count: list.length }),
      places: key === 'credentials/legacy-secret' ? list.map(incident => capitalize(places[String(incident.subjectId)] || String(incident.subjectId))) : [],
      stillWorks: preserved,
      notWorking: affected,
      repair,
      // A capture-risk problem stays in sight until it's fixed
      dismissable: severity !== 'capture-risk' && !resolved,
      dismissed,
      dismissedAt: dismissed && dismissTimes.length > 0 ? Math.max(.../** @type {number[]} */ (dismissTimes)) : null,
      resolved,
      resolvedAt: resolved && resolvedTimes.length > 0 ? Math.max(.../** @type {number[]} */ (resolvedTimes)) : null,
      rowId: /** @type {Record<string, unknown>} */ (PROVIDER)[rowId] ? rowId : first.providerId,
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
  const ids = new Set(problem.incidents.map(incident => incident.id));
  const rebuilt = runs.some(
    run => run.commandId === 'rebuild-index' && run.state === 'succeeded' && run.incidentId !== null && ids.has(run.incidentId) && run.updatedAt <= at,
  );
  return fill(rebuilt ? PAGE.fixedAfterRebuild : PAGE.fixedAfterCheck, { time: stampText(at, now) });
}

/**
 * The Recovery Center's headline, from its open problems and the summary
 * @param {readonly Problem[]} open - the open problems that aren't dismissed
 * @param {TrustSummary} summary
 * @param {{now: number, lastCheckedAt: number | null, dismissed?: number}} options - `dismissed`:
 *   how many open problems are dismissed
 * @returns {{tone: string, title: string, proof: string}}
 */
export function recoveryHeadline(open, summary, { now, lastCheckedAt, dismissed = 0 }) {
  if (open.length === 0 && dismissed > 0) {
    // Every open problem is dismissed: none needs the user, and some are still there
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
    tone: open.some(problem => problem.severity === 'data-risk') ? 'action' : 'partial',
    title: fill(PAGE.problems, { count: plural(open.length, 'problem', 'problems') }),
    // "Saving normally" only on the summary's own word for it
    proof: summary.capture === 'safe' ? PAGE.problemsProof : PAGE.problemsProofUnsure,
  };
}

/**
 * Why a run, or a refusal to start one, stopped, in words
 * @param {string | null | undefined} code
 */
export const reasonText = code => (code && /** @type {Record<string, string>} */ (REASON)[code]) || REASON_FALLBACK;

/**
 * A recent repair's result
 * @param {RemediationRun} run
 * @returns {{tone: string, text: string}}
 */
export function runResult(run) {
  if (run.state === 'succeeded') return { tone: 'ok', text: PAGE.doneAndChecked };
  if (run.state === 'failed') return { tone: 'failed', text: fill(PAGE.failedRun, { reason: reasonText(run.outcome) }) };
  if (run.state === 'interrupted') {
    const steps = /** @type {Record<string, string>} */ (STEP);
    return { tone: 'action', text: fill(PAGE.cutOff, { step: (run.step && steps[run.step]) || run.step || '' }) };
  }
  // A rebuild that found nothing to write ended without the user cancelling anything
  if (run.state === 'cancelled' && run.outcome === 'nothing-to-do') return { tone: 'absent', text: PAGE.nothingToDoRun };
  return { tone: 'absent', text: PAGE.cancelled };
}
