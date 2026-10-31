/**
 * What a surface renders for one signal (#7, "Contracts"): `toSignalViewModel(signal,
 * decision, corrections, now, prefs)`. It answers plain strings and plain data only. Category,
 * provenance, and confidence come as text and as typed discriminators, so objective and
 * inferred signals differ without color; the reason renders from the placement's rule code and
 * parameters; each action has its accessible name ("Complete: Call vendor") and its
 * confirmation text; and the role names #16's token. A view model never holds HTML, and its
 * only navigation targets are the signal's stored source references, which Open resolves
 * through the note repository.
 *
 * Labels are the owner-approved fallbacks from #7 until #21's trust glossary lands.
 */

import { placeSignal } from './categories.js';
import { LIFECYCLE_ACTIONS } from './lifecycle.js';
import { REASON_MAX } from './records.js';

/** @typedef {import('./records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('./records.js').SignalDecision} SignalDecision */
/** @typedef {import('./records.js').SignalCorrection} SignalCorrection */
/** @typedef {import('./records.js').Category} Category */
/** @typedef {import('./records.js').Provenance} Provenance */
/** @typedef {import('./records.js').ExecutionClass} ExecutionClass */
/** @typedef {import('./records.js').DecisionStatus} DecisionStatus */
/** @typedef {import('./records.js').FreshnessState} FreshnessState */
/** @typedef {import('./categories.js').Windows} Windows */
/** @typedef {import('./categories.js').Rule} Rule */

/** #21's fallbacks, owner-approved in #7 */
export const PROVENANCE_LABELS = Object.freeze({
  objective: 'Objective',
  'local-model': 'Generated locally',
  remote: 'Remote model',
  'local-app': 'Local app',
  'network-endpoint': 'Network endpoint',
  unrecorded: 'From an earlier AI extraction (model unknown)',
});

export const CATEGORY_LABELS = Object.freeze({
  now: 'Now',
  today: 'Today',
  soon: 'Soon',
  resurface: 'Resurface',
  connection: 'Connection',
});

export const CONFIDENCE_LABELS = Object.freeze({
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
  unrecorded: 'Confidence not recorded',
});

/** Why a signal is stale or invalidated, in its cause's words */
export const FRESHNESS_TEXT = Object.freeze({
  'source-edited': 'Source changed since this was generated',
  'producer-version': 'From an older recipe version',
  'recipe-version': 'From an older recipe version',
  'model-changed': 'Model or route changed since this was generated',
  'runtime-changed': 'Model or route changed since this was generated',
  'route-changed': 'Model or route changed since this was generated',
  legacy: PROVENANCE_LABELS.unrecorded,
  'anchor-deleted': 'Its source was deleted',
  'not-reproduced': 'No longer found in the note',
  'scope-revoked': 'Access to its source was removed',
  'note-trashed': 'Its note is in the trash',
  'note-archived': 'Its note is archived',
  template: 'Its note is a template',
});

export const CORRECTED_TEXT = 'Corrected';

/** The note is never changed by these, so their confirmation says so */
const NOTE_UNCHANGED = 'Your note is unchanged.';

/**
 * #16's role tokens
 * @typedef {'urgency' | 'private' | 'linked' | 'supporting' | 'neutral'} Role
 */

/**
 * @typedef {'complete' | 'mark-done' | 'reopen' | 'snooze' | 'dismiss' | 'correct' | 'edit-in-note' | 'inspect' | 'open'} ActionId
 */

/**
 * A stored source reference Open may resolve, and nothing else
 * @typedef {{kind: 'note', noteId: string} | {kind: 'block', noteId: string, blockId: string}} OpenTarget
 */

/**
 * @typedef {object} ActionView
 * @property {ActionId} id
 * @property {string} label - the button's text
 * @property {string} accessibleName - its name with the signal's title, as "Complete: Call vendor"
 * @property {string | null} confirmation - what the surface says once it's done
 * @property {OpenTarget | null} target - for Open and Edit in note, a stored source reference
 */

/**
 * @typedef {object} SignalViewModel
 * @property {string} signalId
 * @property {string} kind
 * @property {Provenance} provenance
 * @property {string} provenanceText
 * @property {ExecutionClass} executionClass
 * @property {Category} category
 * @property {string} categoryText
 * @property {boolean} active
 * @property {boolean} hidden - a suspended signal isn't shown
 * @property {number | null} activeFrom
 * @property {number | null} validUntil
 * @property {DecisionStatus} status
 * @property {FreshnessState} freshness
 * @property {string | null} freshnessText
 * @property {'low' | 'medium' | 'high' | null} confidence
 * @property {string | null} confidenceText
 * @property {string | null} confidenceReason
 * @property {string} title
 * @property {string} reason
 * @property {boolean} corrected
 * @property {string | null} correctedText
 * @property {Role} role
 * @property {ActionView[]} actions
 */

/**
 * What a surface knows about its user
 * @typedef {object} ViewPrefs
 * @property {string} timeZone - IANA
 * @property {Windows} [windows]
 * @property {Readonly<Record<string, string>>} [locationNames] - #21's names for local endpoints, by id
 */

/** What an action's name reads when a revoked scope cleared the title */
const UNTITLED = 'Untitled item';

/**
 * Intl's text with plain spaces: some ICU versions put a narrow no-break space before AM and PM
 * @param {string} text
 */
const spaced = text => text.replace(/[\u00a0\u202f]/g, ' ');

/**
 * @param {number} instant
 * @param {string} timeZone
 */
const dayText = (instant, timeZone) =>
  spaced(new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(instant));

/**
 * @param {number} instant
 * @param {string} timeZone
 */
const timeText = (instant, timeZone) =>
  spaced(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(instant));

/**
 * A local date as text: a floating date is read at UTC noon, so no zone moves it a day
 * @param {string} date
 */
const dateText = date => {
  const [year, month, day] = date.split('-').map(Number);
  return dayText(Date.UTC(year, month - 1, day, 12), 'UTC');
};

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 */
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * The producer's own reason
 * @param {IntelligenceSignal} signal
 * @returns {string}
 */
function storedReason(signal) {
  const count = signal.reason.params.count;
  switch (signal.reason.code) {
    case 'open-task':
      return 'Open task';
    case 'pinned-note':
      return 'Pinned note';
    case 'mentioned-in-note':
      return 'Mentioned in your note';
    case 'linked-notes':
      return count === undefined ? 'Linked notes' : `Linked across ${plural(count, 'note', 'notes')}`;
    case 'related-notes':
      return count === undefined ? 'Related notes' : `Related to ${plural(count, 'note', 'notes')}`;
    default:
      return '';
  }
}

/**
 * The reason a placement's rule renders to
 * @param {Rule} rule
 * @param {IntelligenceSignal} signal
 * @param {string} timeZone
 * @returns {string}
 */
function reasonText(rule, signal, timeZone) {
  switch (rule.code) {
    case 'overdue':
      return `Overdue since ${dateText(rule.date)}`;
    case 'due-within':
      return `Due at ${timeText(rule.at, timeZone)}`;
    case 'due-today':
      return rule.at === null ? 'Due today' : `Due today at ${timeText(rule.at, timeZone)}`;
    case 'due-on':
      return `Due ${dateText(rule.date)}`;
    case 'daily-note':
      return signal.kind === 'task' ? "Open task in today's Daily Note" : "In today's Daily Note";
    case 'not-edited':
      return `Not edited since ${dateText(rule.date)}`;
    default:
      return storedReason(signal);
  }
}

/**
 * @param {IntelligenceSignal} signal
 * @param {ViewPrefs} prefs
 * @returns {string}
 */
function provenanceText(signal, prefs) {
  switch (signal.executionClass) {
    case 'deterministic':
      return PROVENANCE_LABELS.objective;
    case 'local-model':
      return PROVENANCE_LABELS['local-model'];
    case 'remote':
      return PROVENANCE_LABELS.remote;
    case 'unrecorded':
      return PROVENANCE_LABELS.unrecorded;
    default: {
      const location = /** @type {{kind: 'local-app' | 'network-endpoint', id: string}} */ (signal.location);
      if (location.kind === 'local-app') return PROVENANCE_LABELS['local-app'];
      const name = prefs.locationNames?.[location.id];
      return name ? `${PROVENANCE_LABELS['network-endpoint']} (${name})` : PROVENANCE_LABELS['network-endpoint'];
    }
  }
}

/**
 * #16's role: urgency for an objective explicit deadline, private for a local inference, linked
 * for a connection, supporting for a resurfaced signal, and neutral for the rest, in that order
 * @param {IntelligenceSignal} effective
 * @param {Category} category
 * @returns {Role}
 */
function roleOf(effective, category) {
  const dated = effective.time?.dueAt !== undefined || effective.time?.dueDate !== undefined;
  if (effective.provenance === 'objective' && dated && effective.kind !== 'connection') return 'urgency';
  const local =
    effective.executionClass === 'local-model' ||
    (effective.executionClass === 'local-endpoint' && effective.location?.kind === 'local-app');
  if (effective.provenance === 'inferred' && local) return 'private';
  if (category === 'connection') return 'linked';
  if (category === 'resurface') return 'supporting';
  return 'neutral';
}

/**
 * @param {string} text
 * @param {number} max
 */
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * The view of `signal` at `now`
 * @param {IntelligenceSignal} signal
 * @param {SignalDecision | null} decision
 * @param {readonly SignalCorrection[]} corrections
 * @param {number} now
 * @param {ViewPrefs} prefs
 * @returns {SignalViewModel}
 */
export function toSignalViewModel(signal, decision, corrections, now, prefs) {
  const placement = placeSignal(signal, decision, corrections, {
    now,
    timeZone: prefs.timeZone,
    windows: prefs.windows,
  });
  const { effective, status } = placement;
  const title = signal.title === '' ? UNTITLED : signal.title;
  const inferred = signal.provenance === 'inferred';

  /**
   * @param {ActionId} id
   * @param {string} label
   * @param {string | null} [confirmation]
   * @param {OpenTarget | null} [target]
   * @returns {ActionView}
   */
  const action = (id, label, confirmation = null, target = null) => ({
    id,
    label,
    accessibleName: `${label}: ${title}`,
    confirmation,
    target,
  });

  /** @type {OpenTarget[]} */
  const targets = effective.sourceRefs.map(source =>
    source.kind === 'block'
      ? { kind: 'block', noteId: source.noteId, blockId: source.blockId }
      : { kind: 'note', noteId: source.noteId },
  );
  const allowed = LIFECYCLE_ACTIONS[signal.kind];
  const done = status !== 'active';
  const gone = signal.freshness.state === 'invalidated' || signal.freshness.state === 'suspended';
  /** @type {ActionView[]} */
  const actions = [];
  if (!gone) {
    if (done) {
      actions.push(
        action(
          'reopen',
          'Reopen',
          signal.kind === 'task' && status === 'completed' ? 'Unchecked in your note.' : NOTE_UNCHANGED,
        ),
      );
    } else {
      if (allowed.includes('complete')) {
        actions.push(
          signal.kind === 'task'
            ? action('complete', 'Complete', 'Checked off in your note.')
            : action('mark-done', 'Mark done', NOTE_UNCHANGED),
        );
      }
      if (allowed.includes('snooze')) actions.push(action('snooze', 'Snooze', NOTE_UNCHANGED));
      if (allowed.includes('dismiss')) {
        actions.push(action('dismiss', signal.kind === 'connection' ? 'Not related' : 'Dismiss', NOTE_UNCHANGED));
      }
    }
    if (allowed.includes('correct')) {
      actions.push(action('correct', signal.kind === 'connection' ? 'Remove a source' : 'Correct', NOTE_UNCHANGED));
    } else if (signal.kind === 'task') {
      actions.push(action('edit-in-note', 'Edit in note', null, targets[0] ?? null));
    }
  }
  actions.push(action('inspect', 'Inspect'));
  if (signal.kind === 'connection') {
    targets.forEach((target, index) =>
      actions.push(action('open', `Open source ${index + 1} of ${targets.length}`, null, target)),
    );
  } else if (targets[0]) {
    actions.push(action('open', 'Open', null, targets[0]));
  }

  const stateCause = signal.freshness.state === 'current' ? null : signal.freshness.cause;
  return {
    signalId: signal.id,
    kind: signal.kind,
    provenance: signal.provenance,
    provenanceText: provenanceText(signal, prefs),
    executionClass: signal.executionClass,
    category: placement.category,
    categoryText: CATEGORY_LABELS[placement.category],
    active: placement.active,
    hidden: signal.freshness.state === 'suspended',
    activeFrom: placement.activeFrom,
    validUntil: placement.validUntil,
    status,
    freshness: signal.freshness.state,
    freshnessText: stateCause === null ? null : FRESHNESS_TEXT[stateCause],
    confidence: signal.confidence?.band ?? null,
    confidenceText: inferred
      ? signal.confidence
        ? CONFIDENCE_LABELS[signal.confidence.band]
        : CONFIDENCE_LABELS.unrecorded
      : null,
    confidenceReason: signal.confidence && signal.confidence.reason !== '' ? signal.confidence.reason : null,
    title: signal.title,
    reason: clip(reasonText(placement.rule, effective, prefs.timeZone), REASON_MAX),
    corrected: placement.corrected,
    correctedText: placement.corrected ? CORRECTED_TEXT : null,
    role: roleOf(effective, placement.category),
    actions,
  };
}
