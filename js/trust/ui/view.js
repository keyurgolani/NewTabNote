/**
 * recovery.html's views (#20 slice 4b): the Trust Center (#trust) and the Recovery Center
 * (#recovery), drawn from the trust operations' answers, which the page's root serves in the
 * page (js/kernel/composition/recovery.js). model.js decides what each shows; this draws it
 * and runs what the user asks for, through the root's trust client only.
 *
 * - It opens on "Opening your notes database…" and waits for the notes database. When the
 *   database can't open, it draws its error state, with no raw error text, and runs nothing:
 *   no read, no check, and no repair (#20 slice 4c's safe mode takes that state further).
 * - Once it opens, it draws the stored receipts and problems first, then runs the local-cheap
 *   checks (trust.verify on `open`), the rows reading "Checking…" until they answer, and
 *   draws again.
 * - One repair runs inline, under its problem: rebuild-index's preview, then its confirmed
 *   run, then the check after it (recovery.check), "Checking that it's fixed…". Only a pass
 *   resolves the problem, which then moves to "Fixed just now" under its resolved title
 *   (the design review's change 1).
 * - Dismiss takes a problem out of Needs action until it changes, and Undo or Show it again
 *   puts it back.
 *
 * Accessibility: the h1 is the state, one polite live region says what changed, runs are
 * role="status", a busy control is aria-disabled rather than disabled, and focus moves to a
 * panel's heading when it opens. Every element is built with DOM calls and every word is set
 * as text; the only markup is the packaged glyphs.
 */

import { EGRESS, PAGE, REBUILD, SEVERITY, TARGET } from './copy.js';
import { GLYPHS } from './glyphs.js';
import {
  SEVERITY_ORDER,
  attentionText,
  capabilitiesText,
  fill,
  fixedLine,
  plural,
  problemFacts,
  problemsOf,
  reasonText,
  recoveryHeadline,
  runResult,
  stampText,
  timeLabel,
  trustHeadline,
  trustSections,
  whenText,
} from './model.js';
import { UNCOVERED_EGRESS } from '../core/providers/egress.js';
import { FINISHED_RUN_STATES } from '../core/vocabulary.js';

/** @typedef {import('./model.js').Row} Row */
/** @typedef {import('./model.js').Problem} Problem */
/** @typedef {import('./model.js').Fact} Fact */
/** @typedef {import('./model.js').TrustReport} TrustReport */
/** @typedef {import('./model.js').TrustSummary} TrustSummary */
/** @typedef {import('./model.js').Incident} Incident */

/**
 * What the page runs on: its root's clients
 * @typedef {object} PageRoot
 * @property {{whenReady(): Promise<{cause: string, code: string} | null>}} kernel
 * @property {{preferencesOr(defaults: Record<string, unknown>): Promise<Record<string, unknown>>}} settings
 * @property {{query(query: Record<string, unknown> & {type: string}): Promise<any>, execute(command: Record<string, unknown> & {type: string, commandId: string}): Promise<any>}} trust
 * @property {{next(): string}} ids
 */

/**
 * One repair's panel, under its problem
 * @typedef {object} Flow
 * @property {'previewing' | 'awaiting' | 'running' | 'still-running' | 'checking' | 'still-there' | 'not-checked' | 'expired' | 'preview-missed' | 'untracked' | 'failed'} phase
 * @property {string | null} runId
 * @property {string | null} previewDigest
 * @property {{changes: Array<{target: string, creates: number, updates: number, deletes: number}>} | null} impact
 * @property {boolean} changed - the preview changed since the one before it
 * @property {string | null} reason - why it stopped
 * @property {boolean} retryable - a check that may decide when asked again
 * @property {number | null} at - when it ended
 */

/** The themes the page draws, by the setting's value; any other reads as the system's */
const SCHEMES = Object.freeze(/** @type {Record<string, string>} */ ({ dark: 'dark', light: 'light' }));

/** How long a problem fixed by a check stays under "Fixed just now" */
const FIXED_FOR_MS = 65 * 60 * 1000;

/** How many recent repairs the Recovery Center lists */
const RECENT_RUNS = 8;

/** How often a repair the page stopped waiting for reads its run's record, until it ends */
const RUN_POLL_MS = 2000;

/**
 * How long the page follows a repair it stopped waiting for. Past this, it says it can't tell
 * whether the repair finished, with Reload, rather than reading its record for good.
 */
export const FOLLOW_MS = 5 * 60 * 1000;

/**
 * Draw recovery.html in `document` and run it on `root`
 * @param {{
 *   document: Document,
 *   root: PageRoot,
 *   location?: {hash: string},
 *   addEventListener?: (type: string, listener: () => void) => void,
 *   now?: () => number,
 *   newTabUrl?: string,
 *   openSiteAccess?: () => void,
 *   reload?: () => void,
 *   wait?: (ms: number) => Promise<void>,
 * }} options - `wait`: how the page waits between reads of a run it stopped waiting for
 * @returns {{ready: Promise<void>}}
 */
export function mountRecoveryPage({
  document: doc,
  root,
  location = { hash: '' },
  addEventListener = () => {},
  now = () => Date.now(),
  newTabUrl = 'newtab.html',
  openSiteAccess = () => {},
  reload = () => {},
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const state = {
    /** @type {'opening' | 'error' | 'unreadable' | 'ready'} */
    phase: 'opening',
    /** @type {{cause: string, code: string} | null} */
    failure: null,
    /** @type {'trust' | 'recovery'} */
    view: viewOf(location.hash) || 'trust',
    viewChosen: viewOf(location.hash) !== null,
    /** @type {TrustSummary | null} */
    summary: null,
    /** @type {TrustReport | null} */
    report: null,
    /** @type {Incident[]} */
    incidents: [],
    /** @type {Map<string, any>} */
    next: new Map(),
    /** @type {Set<string>} */
    checking: new Set(),
    /** @type {Map<string, Flow>} by the problem's first incident's id */
    flows: new Map(),
    /** @type {Map<string, string>} by problem key: what Dismiss or Undo said */
    notices: new Map(),
    /** @type {Set<string>} problem keys dismissed on this page, shown in place with Undo */
    dismissedHere: new Set(),
    /** @type {Set<string>} problem keys whose Dismiss is on its way */
    dismissing: new Set(),
    /** @type {Set<string>} the ids of the runs this page started, so its own reads as its own */
    ownRuns: new Set(),
    /** @type {string | null} the id of the element to focus once drawn */
    focus: null,
  };

  // ───────── Drawing ─────────

  /**
   * An element with its attributes, text, listeners, and children
   * @param {string} tag
   * @param {Record<string, unknown>} [props]
   * @param {...(Node | string | null | undefined | false | Array<Node | string | null | undefined | false>)} children
   * @returns {HTMLElement}
   */
  const h = (tag, props = {}, ...children) => {
    const element = /** @type {HTMLElement} */ (doc.createElement(tag));
    for (const [name, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (name === 'class') element.className = String(value);
      else if (name === 'text') element.textContent = String(value);
      else if (name === 'onclick') element.addEventListener('click', /** @type {EventListener} */ (value));
      else element.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      element.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    }
    return element;
  };

  /** @param {string} tone */
  const glyph = tone => {
    const span = h('span', { class: `trust-glyph trust-tone-${tone}`, 'aria-hidden': 'true' });
    span.innerHTML = /** @type {Record<string, string>} */ (GLYPHS)[tone] || GLYPHS.unknown;
    return span;
  };

  /**
   * A time, as the rows show it, with its datetime
   * @param {number} at
   * @param {string} [text]
   */
  const time = (at, text) => h('time', { datetime: new Date(at).toISOString() }, text === undefined ? timeLabel(at, now()) : text);

  /** @param {string} text */
  const live = text => {
    const region = doc.getElementById('trust-live');
    if (region) region.textContent = text;
  };

  /**
   * A button, aria-disabled rather than disabled while `busy`, so it keeps its place in the tab order
   * @param {string} label
   * @param {() => void} onclick
   * @param {{primary?: boolean, busy?: boolean, quiet?: boolean, id?: string}} [options]
   */
  const button = (label, onclick, { primary = false, busy = false, quiet = false, id } = {}) =>
    h(
      'button',
      {
        type: 'button',
        id,
        class: quiet ? 'trust-linkbtn' : `${primary ? 'primary-btn' : 'secondary-btn'} trust-btn`,
        'aria-disabled': busy ? 'true' : null,
        onclick: () => {
          if (!busy) onclick();
        },
      },
      label,
    );

  /**
   * Facts as a list of terms and their values
   * @param {Fact[]} facts
   * @param {string} className
   */
  const factsList = (facts, className) =>
    h(
      'dl',
      { class: className },
      facts.map(fact =>
        h(
          'div',
          {},
          h('dt', {}, fact.label),
          h('dd', {}, fact.at !== undefined ? time(fact.at, fact.text) : fact.code ? h('code', {}, fact.text) : fact.text),
        ),
      ),
    );

  /**
   * "Still works:" and "Not working:", when there's anything to say
   * @param {string[]} stillWorks
   * @param {string[]} notWorking
   * @param {string} className
   */
  const keeps = (stillWorks, notWorking, className) => {
    if (stillWorks.length === 0 && notWorking.length === 0) return null;
    return h(
      'p',
      { class: className },
      stillWorks.length > 0 ? [h('strong', {}, PAGE.stillWorks), ` ${capabilitiesText(stillWorks)}.`] : null,
      stillWorks.length > 0 && notWorking.length > 0 ? ' ' : null,
      notWorking.length > 0 ? [h('strong', {}, PAGE.notWorking), ` ${capabilitiesText(notWorking)}.`] : null,
    );
  };

  /**
   * A provider's row in the report: its receipt's evidence and its Still works list
   * @param {string} providerId
   */
  const providerOf = providerId => (state.report ? state.report.providers.find(entry => entry.providerId === providerId) || null : null);

  /**
   * The problems `incidents` make, with their cards' actions and their providers' rows
   * @param {readonly Incident[]} incidents
   */
  const problems = incidents => problemsOf(incidents, state.next, providerOf);

  /** The open problems that aren't dismissed, for the badge and the Recovery Center's headline */
  const openProblems = () =>
    problems(state.incidents.filter(incident => incident.state !== 'resolved')).filter(problem => !problem.dismissed);

  /** The header: the brand, the two views, the open problems' badge, and the way back */
  function drawHeader() {
    const nav = doc.getElementById('trust-views');
    if (nav) {
      nav.textContent = '';
      if (state.phase === 'ready') {
        const open = openProblems();
        const badge =
          open.length > 0
            ? [
                h('span', { class: 'trust-count', 'data-tone': open[0].severity === 'capture-risk' ? 'failed' : 'action', 'aria-hidden': 'true' }, String(open.length)),
                h('span', { class: 'sr-only' }, `, ${plural(open.length, 'problem', 'problems')}`),
              ]
            : null;
        for (const view of /** @type {const} */ (['trust', 'recovery'])) {
          nav.appendChild(
            h(
              'a',
              {
                href: `#${view}`,
                'aria-current': state.view === view ? 'page' : null,
                onclick: (/** @type {Event} */ event) => {
                  event.preventDefault();
                  showView(view, true);
                },
              },
              PAGE[view],
              view === 'recovery' ? badge : null,
            ),
          );
        }
      }
    }
    for (const link of doc.querySelectorAll('.trust-home')) /** @type {HTMLAnchorElement} */ (link).setAttribute('href', newTabUrl);
    doc.title = `${state.phase === 'ready' ? PAGE[state.view] : PAGE.recovery} - ${PAGE.brand}`;
  }

  /**
   * A headline: its shape and title in the h1, and what proves it
   * @param {{tone: string, title: string, proof?: string, lines?: Array<Node | null>, actions?: Array<Node | null>, view?: string}} headline
   */
  const headline = ({ tone, title, proof, lines = [], actions = [], view }) =>
    h(
      'section',
      { class: 'trust-headline', 'data-tone': tone, 'aria-labelledby': 'trust-h1' },
      h(
        'div',
        { class: 'trust-headline-body' },
        h('h1', { id: 'trust-h1', tabindex: '-1' }, glyph(tone), h('span', {}, view ? h('span', { class: 'sr-only' }, `${view}: `) : null, title)),
        proof ? h('p', { class: 'trust-proof' }, proof) : null,
        lines,
      ),
      actions.some(Boolean) ? h('div', { class: 'trust-headline-actions' }, actions) : null,
    );

  // ───────── The Trust Center ─────────

  /** @param {Row} row */
  function rowAction(row) {
    const action = row.action;
    if (!action) return null;
    if (action.kind === 'site-access') {
      // Chrome's extensions page is one step short of NewTabNote's site access, so it says the rest
      return h('div', { class: 'trust-site-access' }, button(action.label, openSiteAccess), h('p', { class: 'trust-action-note' }, PAGE.siteAccessHow));
    }
    if (action.kind === 'repair') {
      // The repair opens at its preview, under its problem
      return button(action.label, () => {
        showProblem(action.incidentId);
        const problem = problemWith(action.incidentId);
        if (problem && !state.flows.has(problem.incidents[0].id)) startRepair(problem);
      });
    }
    return h(
      'a',
      {
        class: 'trust-linkbtn',
        href: `#recovery`,
        onclick: (/** @type {Event} */ event) => {
          event.preventDefault();
          showProblem(action.incidentId);
        },
      },
      action.label,
    );
  }

  /**
   * The problem `incidentId` is part of
   * @param {string | null} incidentId
   */
  const problemWith = incidentId =>
    problems(state.incidents).find(problem => problem.incidents.some(incident => incident.id === incidentId)) || null;

  /** @param {Row} row */
  function evidenceBody(row) {
    const parts = [];
    if (row.id === 'platform') {
      for (const evidence of row.evidence) {
        parts.push(
          h(
            'div',
            { class: 'trust-sub' },
            h('h4', {}, glyph(evidence.tone), `${evidence.title}: ${evidence.statusText}`),
            evidence.sentence ? h('p', {}, evidence.sentence) : null,
            factsList(evidence.facts, 'trust-facts'),
          ),
        );
      }
    } else if (row.evidence.length > 0) {
      const [evidence] = row.evidence;
      parts.push(evidence.sentence ? h('p', {}, evidence.sentence) : null, factsList(evidence.facts, 'trust-facts'));
    }
    return parts;
  }

  /** @param {Row} row */
  function destinations(row) {
    const egress = /** @type {Record<string, {what: string, sends: string}>} */ (EGRESS);
    return h(
      'details',
      { class: 'trust-evidence' },
      h('summary', {}, PAGE.connect),
      h(
        'div',
        { class: 'trust-evidence-body' },
        h('p', {}, PAGE.connectLead),
        h(
          'table',
          { class: 'trust-dest' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, PAGE.place), h('th', { scope: 'col' }, PAGE.usedFor), h('th', { scope: 'col' }, PAGE.receives))),
          h(
            'tbody',
            {},
            UNCOVERED_EGRESS.map(item =>
              h(
                'tr',
                {},
                h('td', {}, item.origins.map(origin => h('span', { class: 'trust-origin' }, origin.replace(/^https:\/\//, '')))),
                h('td', {}, egress[item.id] ? egress[item.id].what : item.id),
                h('td', {}, egress[item.id] ? egress[item.id].sends : ''),
              ),
            ),
          ),
        ),
        h('p', { class: 'trust-dest-note' }, row.pending ? fill(PAGE.connectLimited, { count: row.pending }) : PAGE.connectNote),
      ),
    );
  }

  /** @param {Row} row */
  function trustRow(row) {
    const status = h(
      'span',
      { class: 'trust-row-status' },
      glyph(row.tone),
      h('span', {}, row.statusText),
      row.time !== null ? [h('span', { class: 'sr-only' }, ','), ' ', time(row.time)] : null,
    );
    const label = h('h3', { class: 'trust-row-label' }, row.label);
    const evidence = evidenceBody(row);
    if (row.folded && !row.action) {
      // One line, its reason and evidence inside it
      return h(
        'li',
        { class: 'trust-row trust-row--line', id: `row-${row.id}`, 'data-attention': 'false' },
        h(
          'details',
          { class: 'trust-line' },
          h('summary', {}, label, status, h('span', { class: 'trust-line-chevron', 'aria-hidden': 'true' })),
          h('div', { class: 'trust-line-body' }, row.text ? h('p', { class: 'trust-row-text' }, row.text) : null, evidence, row.destinations ? destinations(row) : null),
        ),
      );
    }
    return h(
      'li',
      { class: 'trust-row', id: `row-${row.id}`, 'data-attention': String(row.attention) },
      h('div', { class: 'trust-row-head' }, label, h('p', { class: 'trust-row-status-line' }, status)),
      row.text ? h('p', { class: 'trust-row-text' }, row.text) : null,
      row.attention ? keeps(row.stillWorks, row.notWorking, 'trust-row-keeps') : null,
      row.destinations ? destinations(row) : null,
      h(
        'div',
        { class: 'trust-row-foot' },
        evidence.length > 0
          ? h(
              'details',
              { class: 'trust-evidence' },
              h('summary', {}, row.id === 'platform' ? PAGE.howCheckedAll : PAGE.howChecked),
              h('div', { class: 'trust-evidence-body' }, evidence),
            )
          : null,
        h('div', { class: 'trust-row-actions' }, rowAction(row)),
      ),
    );
  }

  function trustView() {
    const summary = /** @type {TrustSummary} */ (state.summary);
    const sections = trustSections(/** @type {TrustReport} */ (state.report), { now: now(), checking: state.checking });
    const rows = sections.flatMap(section => section.rows);
    const model = trustHeadline(summary, rows, { now: now(), checking: state.checking.size > 0 });
    const attention =
      model.attention.length > 0
        ? h(
            'p',
            { class: 'trust-attention-line' },
            attentionLine(model.attention),
          )
        : null;
    return [
      headline({
        tone: model.tone,
        title: model.title,
        proof: model.proof,
        lines: [attention],
        actions: [model.openRecovery ? h('a', { class: 'primary-btn trust-btn', href: '#recovery', onclick: (/** @type {Event} */ event) => { event.preventDefault(); showView('recovery', true); } }, PAGE.openRecovery) : null],
        view: PAGE.trust,
      }),
      h(
        'div',
        { class: 'trust-groups', 'data-density': 'compact' },
        sections.map(section =>
          h(
            'section',
            { class: 'trust-group', 'aria-labelledby': `g-${section.id}` },
            h('h2', { id: `g-${section.id}` }, section.title),
            h('ul', { class: 'trust-rows' }, section.rows.map(trustRow)),
          ),
        ),
      ),
    ];
  }

  /**
   * "2 things need your attention: Saved keys and Permissions.", each name a link to its row
   * @param {Array<{id: string, label: string}>} rows
   */
  function attentionLine(rows) {
    const text = attentionText(rows);
    const parts = [];
    let rest = text;
    for (const row of rows) {
      const at = rest.indexOf(row.label);
      if (at === -1) continue;
      parts.push(rest.slice(0, at), h('a', { class: 'trust-link', href: `#row-${row.id}` }, row.label));
      rest = rest.slice(at + row.label.length);
    }
    parts.push(rest);
    return parts;
  }

  // ───────── The Recovery Center ─────────

  /**
   * Each step's state in a repair's phase: preview, apply, and the check after it. The check is
   * done only once it passes, which takes the panel away, so a panel never shows it done: it's
   * in progress while it runs, not passed when the problem is still there, and not run when it
   * couldn't run (the review's item 2)
   * @param {Flow} flow
   * @returns {string[]}
   */
  function stepStates(flow) {
    if (flow.phase === 'previewing' || flow.phase === 'awaiting') return ['current', 'todo', 'todo'];
    if (flow.phase === 'running' || flow.phase === 'still-running') return ['done', 'current', 'todo'];
    if (flow.phase === 'checking') return ['done', 'done', 'current'];
    if (flow.phase === 'still-there') return ['done', 'done', 'not-passed'];
    if (flow.phase === 'not-checked') return ['done', 'done', 'not-run'];
    // A failed run stops at its step, and the ones after it never started
    const stopped = stoppedAt(flow);
    return [0, 1, 2].map(index => (index < stopped ? 'done' : index === stopped ? 'failed' : 'todo'));
  }

  /** Each step state's shape, and its words for a screen reader */
  const STEP_TONE = Object.freeze(/** @type {Record<string, string>} */ ({ done: 'ok', current: 'checking', failed: 'failed', 'not-passed': 'failed', 'not-run': 'todo', todo: 'todo' }));
  const STEP_WORDS = Object.freeze(
    /** @type {Record<string, string>} */ ({
      done: PAGE.stepDone,
      current: PAGE.stepCurrent,
      failed: PAGE.stepFailed,
      'not-passed': PAGE.stepNotPassed,
      'not-run': PAGE.stepNotRun,
      todo: PAGE.stepTodo,
    }),
  );

  /**
   * A repair's steps, each with its state in words for a screen reader
   * @param {Flow} flow
   */
  function steps(flow) {
    const states = stepStates(flow);
    return h(
      'ol',
      { class: 'trust-steps', 'aria-label': PAGE.steps },
      ['preview', 'apply', 'verify'].map((step, index) =>
        h(
          'li',
          { 'data-step': states[index] },
          glyph(STEP_TONE[states[index]]),
          h('span', {}, /** @type {Record<string, string>} */ (REBUILD.steps)[step], h('span', { class: 'sr-only' }, `: ${STEP_WORDS[states[index]]}`)),
        ),
      ),
    );
  }

  /**
   * The step a failed run stopped at, as an index of preview, apply, verify
   * @param {Flow} flow
   */
  const stoppedAt = flow => (flow.reason === 'not-verified' || flow.reason === 'verify-failed' ? 2 : flow.reason === 'preview-failed' ? 0 : 1);

  /**
   * "What changes": the preview's counts
   * @param {Flow['impact']} impact
   */
  function impactTable(impact) {
    if (!impact || impact.changes.length === 0) return null;
    const targets = /** @type {Record<string, string>} */ (TARGET);
    return h(
      'table',
      { class: 'trust-impact' },
      h('caption', {}, PAGE.whatChanges),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, PAGE.where), h('th', { scope: 'col' }, PAGE.adds), h('th', { scope: 'col' }, PAGE.changes), h('th', { scope: 'col' }, PAGE.removes))),
      h(
        'tbody',
        {},
        impact.changes.map(change =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, targets[change.target] || change.target),
            [change.creates, change.updates, change.deletes].map(n => h('td', { class: n === 0 ? 'trust-zero' : null }, String(n))),
          ),
        ),
      ),
    );
  }

  /**
   * The repair's panel under its problem
   * @param {Problem} problem
   * @param {Flow} flow
   */
  function flowPanel(problem, flow) {
    const incidentId = problem.incidents[0].id;
    const titleId = `flow-${incidentId}-title`;
    /** @type {Array<Node | null>} */
    let body = [];
    let busy = false;
    if (flow.phase === 'previewing') {
      busy = true;
      body = [h('p', { class: 'trust-result', role: 'status' }, glyph('checking'), h('span', {}, PAGE.checkingProof)), steps(flow)];
    } else if (flow.phase === 'awaiting') {
      const index = flow.impact ? flow.impact.changes.find(change => change.target === 'search_index') : null;
      body = [
        flow.changed ? h('div', { class: 'trust-warning', role: 'status' }, glyph('action'), h('p', {}, REBUILD.previewChanged)) : null,
        h('p', {}, fill(REBUILD.preview, { creates: index ? index.creates : 0, updates: index ? index.updates : 0 })),
        impactTable(flow.impact),
        h(
          'div',
          { class: 'trust-flow-actions' },
          button(REBUILD.confirm, () => confirmRepair(problem), { primary: true }),
          button(PAGE.cancel, () => cancelRepair(problem)),
        ),
      ];
    } else if (flow.phase === 'running') {
      busy = true;
      body = [
        h('p', { class: 'trust-result', role: 'status' }, glyph('checking'), h('span', {}, REBUILD.running)),
        steps(flow),
        h(
          'div',
          { class: 'trust-flow-actions' },
          button(REBUILD.confirm, () => {}, { primary: true, busy: true }),
          h('span', { class: 'trust-muted' }, REBUILD.keepOpen),
        ),
      ];
    } else if (flow.phase === 'still-running') {
      // The page stopped waiting for its answer; the run goes on, and the page reads its record
      busy = true;
      body = [h('p', { class: 'trust-result', role: 'status' }, glyph('checking'), h('span', {}, REBUILD.stillRunning)), steps(flow)];
    } else if (flow.phase === 'expired' || flow.phase === 'preview-missed') {
      // A preview it can't confirm: one that expired, or one that finished after the page
      // stopped waiting, so the page never got what it would confirm
      body = [
        h('p', { class: 'trust-result', role: 'status' }, glyph('todo'), h('span', {}, flow.phase === 'expired' ? REBUILD.previewExpired : REBUILD.previewMissed)),
        h('div', { class: 'trust-flow-actions' }, button(REBUILD.previewAgain, () => startRepair(problem), { primary: true })),
      ];
    } else if (flow.phase === 'untracked') {
      // It followed the run as long as it would, and the run's record never ended
      body = [
        h('p', { class: 'trust-result', role: 'status' }, glyph('partial'), h('span', {}, REBUILD.untracked)),
        h('div', { class: 'trust-flow-actions' }, button(PAGE.reload, () => reload(), { primary: true })),
      ];
    } else if (flow.phase === 'checking') {
      busy = true;
      body = [h('p', { class: 'trust-result', role: 'status' }, glyph('checking'), h('span', {}, REBUILD.checking)), steps(flow)];
    } else if (flow.phase === 'still-there') {
      // Its way forward, as mockup f5 drew it: the notes are as they were, and Try again
      body = [
        h('p', { class: 'trust-result', role: 'status' }, glyph('partial'), h('span', {}, REBUILD.stillThere)),
        steps(flow),
        h('p', { class: 'trust-muted' }, REBUILD.unchanged),
        h('div', { class: 'trust-flow-actions' }, button(REBUILD.tryAgain, () => startRepair(problem), { primary: true })),
      ];
    } else if (flow.phase === 'not-checked') {
      body = [
        h('p', { class: 'trust-result', role: 'status' }, glyph('partial'), h('span', {}, REBUILD.notChecked)),
        steps(flow),
        flow.retryable ? h('div', { class: 'trust-flow-actions' }, button(REBUILD.checkAgain, () => checkRepair(problem), { primary: true })) : null,
      ];
    } else if (flow.phase === 'failed') {
      body = [
        h(
          'p',
          { class: 'trust-result', role: 'status' },
          glyph('failed'),
          h('span', {}, h('strong', {}, fill(REBUILD.failed, { reason: reasonText(flow.reason) })), flow.at !== null ? ` Tried ${whenText(flow.at, now())}.` : null),
        ),
        steps(flow),
        h('p', { class: 'trust-muted' }, REBUILD.unchanged),
        h('div', { class: 'trust-flow-actions' }, button(REBUILD.tryAgain, () => startRepair(problem), { primary: true })),
      ];
    }
    return h(
      'section',
      { class: 'trust-flow', 'aria-labelledby': titleId, 'data-state': flow.phase, 'aria-busy': busy ? 'true' : null },
      h('h4', { id: titleId, tabindex: '-1' }, REBUILD.action),
      body,
    );
  }

  /**
   * One problem's card
   * @param {Problem} problem
   * @param {{fixed?: boolean}} [options]
   */
  function problemCard(problem, { fixed = false } = {}) {
    const first = problem.incidents[0];
    const flow = state.flows.get(first.id) || null;
    const dismissedHere = state.dismissedHere.has(problem.key) && problem.dismissed;
    const notice = state.notices.get(problem.key) || null;
    const tone = fixed ? 'ok' : problem.tone;
    /** @type {Array<Node | null>} */
    const actions = [];
    if (!fixed && !dismissedHere) {
      if (problem.repair && !flow) actions.push(button(REBUILD.action, () => startRepair(problem), { primary: true }));
      if (problem.dismissable && !problem.dismissed) {
        // Dismiss waits while its problem's repair runs, and while its own call is on its way
        const running = flow !== null && ['previewing', 'running', 'still-running', 'checking'].includes(flow.phase);
        actions.push(button(PAGE.dismiss, () => dismissProblem(problem), { busy: running || state.dismissing.has(problem.key) }));
      }
    }
    actions.push(
      h(
        'a',
        {
          class: 'trust-linkbtn trust-crosslink',
          href: `#trust`,
          onclick: (/** @type {Event} */ event) => {
            event.preventDefault();
            showRow(problem.rowId);
          },
        },
        fill(PAGE.seeInTrust, { label: rowLabel(problem.rowId) }),
      ),
    );
    return h(
      'li',
      { class: 'trust-incident', id: `incident-${first.ref}`, 'data-tone': tone, 'data-state': fixed ? 'resolved' : 'open' },
      h(
        'div',
        { class: 'trust-incident-head' },
        glyph(tone),
        h('h3', {}, fixed ? problem.resolvedTitle : problem.title, fixed ? h('span', { class: 'sr-only' }, PAGE.fixed) : null),
      ),
      h(
        'div',
        { class: 'trust-incident-body' },
        fixed ? h('p', { class: 'trust-fixed-line' }, fixedLine(problem, /** @type {TrustReport} */ (state.report).runs, now())) : null,
        // Undo sits in the sentence, on its baseline
        dismissedHere
          ? h('p', { class: 'trust-notice', role: 'status' }, PAGE.dismissed, ' ', button(PAGE.undo, () => undoDismiss(problem), { quiet: true }))
          : null,
        !fixed && problem.text ? h('p', { class: 'trust-incident-text' }, problem.text) : null,
        !fixed && problem.places.length > 0 ? h('ul', { class: 'trust-places' }, problem.places.map(place => h('li', {}, place))) : null,
        !fixed ? keeps(problem.stillWorks, problem.notWorking, 'trust-keeps') : null,
        factsList(problemFacts(problem, now()), 'trust-incident-facts'),
        notice ? h('p', { class: 'trust-muted', role: 'status' }, notice) : null,
        h('div', { class: 'trust-incident-actions' }, actions),
        flow && !fixed ? flowPanel(problem, flow) : null,
      ),
    );
  }

  /** @param {string} rowId */
  function rowLabel(rowId) {
    const sections = trustSections(/** @type {TrustReport} */ (state.report), { now: now() });
    const row = sections.flatMap(section => section.rows).find(candidate => candidate.id === rowId);
    return row ? row.label : rowId;
  }

  function recoveryView() {
    const summary = /** @type {TrustSummary} */ (state.summary);
    const report = /** @type {TrustReport} */ (state.report);
    const all = problems(state.incidents);
    const open = all.filter(problem => !problem.resolved && (!problem.dismissed || state.dismissedHere.has(problem.key)));
    const counted = open.filter(problem => !problem.dismissed);
    const fixed = all.filter(problem => problem.resolved && problem.resolvedAt !== null && now() - problem.resolvedAt < FIXED_FOR_MS);
    const dismissed = all.filter(problem => problem.dismissed && !state.dismissedHere.has(problem.key));
    const times = report.providers.map(entry => (entry.receipt ? entry.receipt.verifiedAt : 0)).filter(at => at > 0);
    const model = recoveryHeadline(counted, summary, {
      now: now(),
      lastCheckedAt: times.length > 0 ? Math.max(...times) : null,
      dismissed: all.filter(problem => !problem.resolved && problem.dismissed).length,
    });
    const severity = /** @type {Record<string, string>} */ (SEVERITY);
    // Finished runs only: one waiting for its confirmation, or running, is its panel's
    const runs = report.runs
      .filter(run => FINISHED_RUN_STATES.includes(/** @type {any} */ (run.state)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_RUNS);
    return [
      headline({ tone: model.tone, title: model.title, proof: model.proof, view: PAGE.recovery }),
      fixed.length > 0
        ? h(
            'section',
            { class: 'trust-section', 'aria-labelledby': 'h-fixed' },
            h('h2', { id: 'h-fixed' }, PAGE.fixedJustNow),
            h('ol', { class: 'trust-incidents' }, fixed.map(problem => problemCard(problem, { fixed: true }))),
          )
        : null,
      SEVERITY_ORDER.map(level => {
        const list = open.filter(problem => problem.severity === level);
        if (list.length === 0) return null;
        return h(
          'section',
          { class: 'trust-section', 'aria-labelledby': `sev-${level}` },
          h('h2', { id: `sev-${level}` }, severity[level]),
          h('ol', { class: 'trust-incidents' }, list.map(problem => problemCard(problem))),
        );
      }),
      runs.length > 0
        ? h(
            'section',
            { class: 'trust-section', 'aria-labelledby': 'h-runs' },
            h('h2', { id: 'h-runs' }, PAGE.recentRepairs),
            h(
              'div',
              { class: 'trust-table-wrap' },
              h(
                'table',
                { class: 'trust-runs' },
                h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, PAGE.repair), h('th', { scope: 'col' }, PAGE.result), h('th', { scope: 'col' }, PAGE.when))),
                h(
                  'tbody',
                  {},
                  runs.map(run => {
                    const result = runResult(run, state.incidents);
                    return h(
                      'tr',
                      {},
                      h('td', {}, run.commandId === 'rebuild-index' ? REBUILD.action : run.commandId),
                      h('td', {}, h('span', { class: 'trust-row-status' }, glyph(result.tone), h('span', {}, result.text))),
                      h('td', {}, time(run.updatedAt, stampText(run.updatedAt, now()))),
                    );
                  }),
                ),
              ),
            ),
          )
        : null,
      dismissed.length > 0
        ? h(
            'section',
            { class: 'trust-section', 'aria-labelledby': 'h-dismissed' },
            h('h2', { id: 'h-dismissed' }, PAGE.dismissedTitle),
            h('p', { class: 'trust-section-text' }, PAGE.dismissedText),
            h(
              'ul',
              { class: 'trust-rows' },
              dismissed.map(problem =>
                h(
                  'li',
                  { class: 'trust-dismissed', id: `dismissed-${problem.incidents[0].ref}` },
                  h(
                    'div',
                    { class: 'trust-dismissed-text' },
                    h('h3', {}, problem.title),
                    problem.dismissedAt !== null ? h('p', { class: 'trust-muted' }, fill(PAGE.dismissedWhen, { when: whenText(problem.dismissedAt, now()) })) : null,
                  ),
                  button(PAGE.showAgain, () => undoDismiss(problem)),
                ),
              ),
            ),
          )
        : null,
    ];
  }

  // ───────── The page's states ─────────

  function openingView() {
    return [headline({ tone: 'checking', title: PAGE.opening })];
  }

  /** The notes database didn't open: what that means, without its error text, and nothing run */
  function errorView() {
    const failure = state.failure || { cause: '', code: '' };
    // Nothing new can be saved in either, so both take the ring with a cross (change 14)
    if (failure.code === 'no-database') {
      return [headline({ tone: 'failed', title: PAGE.noDatabase, proof: PAGE.noDatabaseBody })];
    }
    if (failure.cause === 'newer-schema' || failure.code === 'newer-schema' || failure.code === 'version-too-new') {
      return [headline({ tone: 'failed', title: PAGE.newerSchema, proof: PAGE.newerSchemaBody })];
    }
    if (failure.cause === 'quota' || failure.code === 'quota') {
      // The Recovery Center's words for the same condition (change 7)
      return [
        headline({
          tone: 'failed',
          title: PAGE.outOfSpace,
          proof: PAGE.outOfSpaceBody,
          lines: [h('p', { class: 'trust-proof' }, PAGE.reloadKeeps)],
          actions: [button(PAGE.reload, reload, { primary: true, id: 'trust-reload' })],
        }),
      ];
    }
    return [
      headline({
        tone: 'failed',
        title: PAGE.openFailed,
        proof: PAGE.openFailedBody,
        lines: [h('p', { class: 'trust-proof' }, PAGE.reloadKeeps)],
        actions: [button(PAGE.reload, reload, { primary: true, id: 'trust-reload' })],
      }),
    ];
  }

  function unreadableView() {
    return [
      headline({
        tone: 'action',
        title: PAGE.cantConfirm,
        proof: PAGE.readFailed,
        actions: [button(PAGE.reload, reload, { primary: true, id: 'trust-reload' })],
      }),
    ];
  }

  function render() {
    drawHeader();
    const main = doc.getElementById('trust-main');
    if (!main) return;
    main.textContent = '';
    /** @type {Array<Node | null | Array<Node | null>>} */
    let parts;
    if (state.phase === 'opening') parts = openingView();
    else if (state.phase === 'error') parts = errorView();
    else if (state.phase === 'unreadable') parts = unreadableView();
    else parts = state.view === 'trust' ? trustView() : recoveryView();
    for (const part of parts.flat(2)) if (part) main.appendChild(part);
    if (state.focus) {
      const target = doc.getElementById(state.focus);
      state.focus = null;
      if (target) /** @type {HTMLElement} */ (target).focus();
    }
  }

  // ───────── What the user does ─────────

  /**
   * @param {'trust' | 'recovery'} view
   * @param {boolean} chosen - by the user, so its heading takes focus
   */
  function showView(view, chosen) {
    state.view = view;
    state.viewChosen = true;
    if (chosen && location.hash !== `#${view}`) location.hash = `#${view}`;
    if (chosen) state.focus = 'trust-h1';
    render();
  }

  /** @param {string | null} incidentId */
  function showProblem(incidentId) {
    showView('recovery', true);
    const incident = state.incidents.find(candidate => candidate.id === incidentId);
    if (incident) {
      const card = doc.getElementById(`incident-${incident.ref}`);
      if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start' });
    }
  }

  /** @param {string} rowId */
  function showRow(rowId) {
    showView('trust', true);
    const row = doc.getElementById(`row-${rowId}`);
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'start' });
  }

  const commandId = () => root.ids.next();

  /** Read the summary, the report, and the problems, and draw them */
  async function refresh() {
    const [summary, report, incidents] = await Promise.all([
      root.trust.query({ type: 'trust.summary' }),
      root.trust.query({ type: 'trust.report' }),
      root.trust.query({ type: 'recovery.incidents', includeResolved: true }),
    ]);
    if (![summary, report, incidents].every(answer => answer && (answer.kind === 'ready' || answer.kind === 'stale'))) {
      state.phase = 'unreadable';
      state.focus = 'trust-reload';
      render();
      return false;
    }
    state.summary = summary.data;
    state.report = report.data;
    state.incidents = incidents.data.incidents;
    state.next = new Map(incidents.data.next.map((/** @type {{incidentId: string, next: any}} */ entry) => [entry.incidentId, entry.next]));
    state.phase = 'ready';
    // A capture at risk, or records this page can't read, open on the Recovery Center
    if (!state.viewChosen && state.summary && state.summary.route === 'recovery') state.view = 'recovery';
    render();
    return true;
  }

  /**
   * Set a repair's panel and draw it
   * @param {Problem} problem
   * @param {Partial<Flow>} changes
   */
  function setFlow(problem, changes) {
    const id = problem.incidents[0].id;
    const before = state.flows.get(id) || {
      phase: 'previewing',
      runId: null,
      previewDigest: null,
      impact: null,
      changed: false,
      reason: null,
      retryable: false,
      at: null,
    };
    state.flows.set(id, { ...before, ...changes });
    render();
  }

  /**
   * What a recovery.run answered, as the panel's next state. An answer the page stopped waiting
   * for (`unknown`), or a refusal because this page's own run still holds the repair, isn't a
   * failure: the run goes on, so the panel says so and reads its record until it ends.
   * @param {Problem} problem
   * @param {any} answer
   * @param {{runId?: string | null, askedAt?: number}} [asked] - the run it confirmed, and when it asked
   */
  async function onRunAnswer(problem, answer, { runId = null, askedAt = now() } = {}) {
    if (answer && answer.kind === 'remediation' && typeof answer.runId === 'string') state.ownRuns.add(answer.runId);
    if (answer && answer.kind === 'unknown') return followRun(problem, runId, askedAt);
    if (answer && answer.kind === 'unavailable' && answer.code === 'remediation-running') {
      // The report can be a read behind this page's own runs, as when Try again comes before
      // the read after a failure lands, so read it again before deciding whose run holds it
      await refreshQuietly();
      const own = ownRunOf(problem);
      if (own) return followRun(problem, own.id, own.startedAt);
    }
    if (answer && answer.kind === 'remediation') {
      if (answer.state === 'awaiting-confirmation') {
        setFlow(problem, {
          phase: 'awaiting',
          runId: answer.runId,
          previewDigest: answer.previewDigest,
          impact: answer.impact,
          changed: answer.outcome === 'preview-changed',
        });
        state.focus = `flow-${problem.incidents[0].id}-title`;
        render();
        return;
      }
      // A rebuild with nothing to write, as one that wrote everything, leaves the check after
      // it to decide what shows: a pass is Fixed just now, and anything else its panel's state
      if (answer.state === 'succeeded' || (answer.state === 'cancelled' && answer.outcome === 'nothing-to-do')) return checkRepair(problem);
      // A confirmation sent after the preview expired: say so, and offer it again (N1)
      if (answer.state === 'cancelled' && answer.outcome === 'run-expired') {
        setFlow(problem, { phase: 'expired', at: now() });
        live(REBUILD.previewExpired);
        return refreshQuietly();
      }
      if (answer.state === 'cancelled') {
        state.flows.delete(problem.incidents[0].id);
        return refreshQuietly();
      }
      setFlow(problem, { phase: 'failed', reason: answer.outcome || null, at: now() });
      live(fill(REBUILD.failed, { reason: reasonText(answer.outcome) }));
      return refreshQuietly();
    }
    const code = answer && typeof answer.code === 'string' ? answer.code : null;
    setFlow(problem, { phase: 'failed', reason: code, at: now() });
    live(fill(REBUILD.failed, { reason: reasonText(code) }));
  }

  /**
   * This page's own run of the repair for `problem` that hasn't ended, from the report, if any.
   * It matches the problem's own incidents only, so a run this page started for the other index
   * problem holds the same repair yet reads as another tab's until #22 gives each its own run.
   * @param {Problem} problem
   */
  function ownRunOf(problem) {
    const ids = new Set(problem.incidents.map(incident => incident.id));
    const runs = state.report ? state.report.runs : [];
    return (
      runs
        .filter(run => state.ownRuns.has(run.id) && run.incidentId !== null && ids.has(run.incidentId))
        .filter(run => !FINISHED_RUN_STATES.includes(/** @type {any} */ (run.state)))
        .sort((a, b) => b.startedAt - a.startedAt)[0] || null
    );
  }

  /**
   * A repair the page stopped waiting for: "Still running" until its run's record ends, read
   * every RUN_POLL_MS, then what it ended as, or Preview again for a preview that ended
   * waiting. Past FOLLOW_MS it says it can't tell. `runId` is the run when the page knows it (a
   * confirmation); without it (a preview), the run is the newest for the problem since `since`.
   * @param {Problem} problem
   * @param {string | null} runId
   * @param {number} since
   */
  async function followRun(problem, runId, since) {
    const incidentId = problem.incidents[0].id;
    setFlow(problem, { phase: 'still-running', ...(runId ? { runId } : {}) });
    live(REBUILD.stillRunning);
    const started = now();
    /** @type {string | null} the followed run's record as the page last drew it */
    let drawn = null;
    for (;;) {
      await wait(RUN_POLL_MS);
      // Another action took the panel over, or the page left the Recovery Center's data
      const flow = state.flows.get(incidentId);
      if (!flow || flow.phase !== 'still-running') return;
      if (now() - started >= FOLLOW_MS) {
        setFlow(problem, { phase: 'untracked', at: now() });
        live(REBUILD.untracked);
        return;
      }
      // The run's record, read without drawing: the page draws again only when it changes, so
      // focus, and an open "How this was checked", stay as they are while nothing happens
      const report = await reportNow();
      if (!report) {
        await refreshQuietly();
        if (state.phase !== 'ready') return;
        continue;
      }
      const ids = new Set(problem.incidents.map(incident => incident.id));
      const run = runId
        ? report.runs.find(candidate => candidate.id === runId)
        : report.runs
            .filter(candidate => candidate.commandId === 'rebuild-index' && candidate.incidentId !== null && ids.has(candidate.incidentId) && candidate.startedAt >= since)
            .sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!run) continue;
      state.ownRuns.add(run.id);
      const record = JSON.stringify([run.id, run.state, run.step, run.outcome, run.updatedAt]);
      if (record !== drawn) {
        drawn = record;
        state.report = report;
        render();
      }
      if (run.state === 'awaiting-confirmation') {
        // A preview this page never got waits for a confirmation the page can't send without
        // it, so the page offers the preview again rather than starting another run itself
        setFlow(problem, { phase: 'preview-missed', at: now() });
        live(REBUILD.previewMissed);
        return;
      }
      if (!FINISHED_RUN_STATES.includes(/** @type {any} */ (run.state))) continue;
      if (run.state === 'succeeded' || (run.state === 'cancelled' && run.outcome === 'nothing-to-do')) return checkRepair(problem);
      if (run.state === 'cancelled' && run.outcome === 'run-expired') {
        setFlow(problem, { phase: 'expired', at: now() });
        live(REBUILD.previewExpired);
        return;
      }
      if (run.state === 'cancelled') {
        state.flows.delete(incidentId);
        render();
        return;
      }
      setFlow(problem, { phase: 'failed', reason: run.outcome || (run.state === 'interrupted' ? 'interrupted' : null), at: now() });
      live(fill(REBUILD.failed, { reason: reasonText(run.outcome) }));
      return;
    }
  }

  /** @param {Problem} problem */
  async function startRepair(problem) {
    setFlow(problem, { phase: 'previewing', runId: null, previewDigest: null, impact: null, changed: false, reason: null });
    state.focus = `flow-${problem.incidents[0].id}-title`;
    render();
    const askedAt = now();
    const answer = await root.trust.execute({
      type: 'recovery.run',
      commandId: commandId(),
      remediationId: 'rebuild-index',
      incidentId: problem.incidents[0].id,
      userInitiated: true,
    });
    await onRunAnswer(problem, answer, { askedAt });
  }

  /** @param {Problem} problem */
  async function confirmRepair(problem) {
    const flow = state.flows.get(problem.incidents[0].id);
    if (!flow || !flow.runId || !flow.previewDigest) return;
    setFlow(problem, { phase: 'running' });
    live(REBUILD.running);
    state.ownRuns.add(flow.runId);
    const answer = await root.trust.execute({
      type: 'recovery.run',
      commandId: commandId(),
      remediationId: 'rebuild-index',
      incidentId: problem.incidents[0].id,
      runId: flow.runId,
      decision: 'confirm',
      previewDigest: flow.previewDigest,
      userInitiated: true,
    });
    await onRunAnswer(problem, answer, { runId: flow.runId });
  }

  /** @param {Problem} problem */
  async function cancelRepair(problem) {
    const id = problem.incidents[0].id;
    const flow = state.flows.get(id);
    state.flows.delete(id);
    render();
    if (flow && flow.runId) {
      await root.trust.execute({
        type: 'recovery.run',
        commandId: commandId(),
        remediationId: 'rebuild-index',
        incidentId: id,
        runId: flow.runId,
        decision: 'cancel',
        ...(flow.previewDigest ? { previewDigest: flow.previewDigest } : {}),
        userInitiated: true,
      });
    }
  }

  /**
   * The check after a repair: only a pass resolves the problem, which then reads as fixed
   * @param {Problem} problem
   */
  async function checkRepair(problem) {
    const incidentId = problem.incidents[0].id;
    setFlow(problem, { phase: 'checking' });
    live(REBUILD.checking);
    const checked = await root.trust.execute({ type: 'recovery.check', commandId: commandId(), incidentId });
    if (checked && checked.kind === 'checked' && checked.result === 'fixed') {
      state.flows.delete(incidentId);
      live(`${PAGE.fixedJustNow}: ${problem.resolvedTitle}`);
      await refreshQuietly();
      return;
    }
    if (checked && checked.kind === 'checked' && checked.result === 'still-there') {
      setFlow(problem, { phase: 'still-there', at: now() });
      live(REBUILD.stillThere);
    } else {
      setFlow(problem, { phase: 'not-checked', retryable: Boolean(checked && checked.retryable), at: now() });
      live(REBUILD.notChecked);
    }
    await refreshQuietly();
  }

  /** @param {Problem} problem */
  async function dismissProblem(problem) {
    // Busy until it's answered, so a second press can't send it again (N4)
    if (state.dismissing.has(problem.key)) return;
    state.dismissing.add(problem.key);
    state.notices.delete(problem.key);
    render();
    try {
      await dismissEach(problem);
    } finally {
      state.dismissing.delete(problem.key);
    }
    await refreshQuietly();
  }

  /** @param {Problem} problem */
  async function dismissEach(problem) {
    for (const incident of problem.incidents.filter(candidate => !candidate.dismissed)) {
      const answer = await root.trust.execute({
        type: 'recovery.dismiss',
        commandId: commandId(),
        incidentId: incident.id,
        occurrences: incident.occurrences,
      });
      if (!answer || answer.kind !== 'committed') {
        state.notices.set(problem.key, answer && answer.kind === 'conflict' ? PAGE.changedSinceShown : PAGE.dismissFailed);
        break;
      }
    }
    if (!state.notices.has(problem.key)) {
      state.dismissedHere.add(problem.key);
      live(PAGE.dismissed);
    }
  }

  /** @param {Problem} problem */
  async function undoDismiss(problem) {
    state.notices.delete(problem.key);
    for (const incident of problem.incidents.filter(candidate => candidate.dismissed)) {
      const answer = await root.trust.execute({ type: 'recovery.undismiss', commandId: commandId(), incidentId: incident.id });
      if (!answer || answer.kind !== 'committed') {
        state.notices.set(problem.key, PAGE.showFailed);
        break;
      }
    }
    state.dismissedHere.delete(problem.key);
    await refreshQuietly();
  }

  /**
   * The report as it stands, read without drawing, or null when it can't be read
   * @returns {Promise<TrustReport | null>}
   */
  async function reportNow() {
    try {
      const answer = await root.trust.query({ type: 'trust.report' });
      return answer && (answer.kind === 'ready' || answer.kind === 'stale') ? answer.data : null;
    } catch {
      return null;
    }
  }

  /** Read again after an action, and draw what it shows, never losing the page to a read that failed */
  async function refreshQuietly() {
    try {
      await refresh();
    } catch {
      state.phase = 'unreadable';
      state.focus = 'trust-reload';
      render();
    }
  }

  // ───────── Opening ─────────

  /** @param {Record<string, unknown>} preferences */
  const applyTheme = preferences => {
    const html = /** @type {HTMLElement} */ (doc.documentElement);
    html.dataset.scheme = SCHEMES[String(preferences.theme)] || 'system';
  };

  async function open() {
    render();
    // Its theme, through the settings port; the system's until it answers, or if it can't
    root.settings.preferencesOr({ theme: 'system' }).then(applyTheme, () => {});
    const failure = await root.kernel.whenReady();
    if (failure) {
      // The notes database didn't open: the error state, and no row runs
      state.phase = 'error';
      state.failure = failure;
      render();
      const reloadButton = doc.getElementById('trust-reload');
      if (reloadButton) /** @type {HTMLElement} */ (reloadButton).focus();
      return;
    }
    if (!(await refresh())) return;
    // Stored receipts are drawn; now the local-cheap checks run, and their rows read as checking
    const report = /** @type {TrustReport} */ (state.report);
    state.checking = new Set(report.providers.filter(entry => entry.costClass === 'local-cheap').map(entry => entry.providerId));
    render();
    live(PAGE.checkingNotes);
    await root.trust.execute({ type: 'trust.verify', commandId: commandId(), trigger: 'open' });
    state.checking = new Set();
    await refreshQuietly();
    live('');
  }

  addEventListener('hashchange', () => {
    const view = viewOf(location.hash);
    if (view && view !== state.view) showView(view, false);
  });

  const ready = open().catch(() => {
    state.phase = 'unreadable';
    state.focus = 'trust-reload';
    render();
  });
  return { ready };
}

/**
 * The view a location's hash names, or null for none
 * @param {string} hash
 * @returns {'trust' | 'recovery' | null}
 */
function viewOf(hash) {
  if (hash === '#trust') return 'trust';
  if (hash === '#recovery') return 'recovery';
  return null;
}

