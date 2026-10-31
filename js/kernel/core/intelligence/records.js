/**
 * The intelligence domain's records (#7, "Records and identity", approved AC1): the derived
 * `IntelligenceSignal`, and the user's `SignalDecision` and `SignalCorrection` beside it. Each
 * is versioned (`recordVersion`) and keyed by the signal's stable id (identity.js), and each
 * decision and correction stores the identity tuple too, so it can be matched to a signal
 * that's gone and come back.
 *
 * - A signal says what it is and why: its kind, whether it's an objective fact or an
 *   inference and where that ran, the producer and version, the sources and their revisions,
 *   a plain-text title, a reason as a rule code with parameters, a time basis or a stored
 *   category, the confidence band for an inference, when it was generated, and its freshness
 *   (`current`, `stale`, `suspended`, `invalidated`, with a cause). User status is never here.
 * - A decision holds the user's status (`active`, `snoozed` until a time, `completed`,
 *   `dismissed` with a reason), a `decisionRevision` every lifecycle commit moves, and the last
 *   HISTORY_MAX history entries.
 * - Corrections are append-only. The latest per field wins (lifecycle.js).
 *
 * Evidence is the minimum (#7, "Security and privacy"): a title up to TITLE_MAX characters
 * and a reason up to REASON_MAX, source references, and a provider id. Every object is strict,
 * so a field for a credential, prompt text, a page URL, or raw model output has nowhere to
 * go, and a text field refuses anything with a URL in it. Titles and reasons are plain text:
 * whatever renders them sets them as text, never as HTML.
 *
 * A record that fails its schema on read is quarantined and counted, never returned
 * (memory/intelligence.js).
 */

import * as v from '../../../lib/valibot/index.mjs';
import { content, count, entityId, id, revision, timestamp } from '../contracts/fields.js';
import { SIGNAL_ID, idOfIdentity } from './identity.js';
import { isLocalDate } from './time.js';

/** @typedef {import('./identity.js').Identity} Identity */

export const RECORD_VERSION = 1;
export const TITLE_MAX = 140;
export const REASON_MAX = 280;
export const HISTORY_MAX = 50;
export const SOURCES_MAX = 20;
export const SUBJECT_KEY_MAX = 200;

export const KINDS = Object.freeze(
  /** @type {const} */ ([
    'task',
    'pin',
    'inferred-task',
    'inferred-deadline',
    'inferred-reminder',
    'inferred-highlight',
    'inferred-resurface',
    'connection',
  ]),
);
/** @typedef {(typeof KINDS)[number]} Kind */

/** The kinds that are always objective, and the ones always inferred. A connection is either. */
export const OBJECTIVE_KINDS = Object.freeze(/** @type {readonly Kind[]} */ (['task', 'pin']));
export const INFERRED_KINDS = Object.freeze(
  /** @type {readonly Kind[]} */ ([
    'inferred-task',
    'inferred-deadline',
    'inferred-reminder',
    'inferred-highlight',
    'inferred-resurface',
  ]),
);

export const PROVENANCES = Object.freeze(/** @type {const} */ (['objective', 'inferred']));
/** @typedef {(typeof PROVENANCES)[number]} Provenance */

/** Where a signal was worked out. `unrecorded` is only for legacy insights (slice 3). */
export const EXECUTION_CLASSES = Object.freeze(
  /** @type {const} */ (['deterministic', 'local-model', 'local-endpoint', 'remote', 'unrecorded']),
);
/** @typedef {(typeof EXECUTION_CLASSES)[number]} ExecutionClass */

/** #21's location of a local endpoint, until #21 names its own */
export const LOCATION_KINDS = Object.freeze(/** @type {const} */ (['local-app', 'network-endpoint']));

export const CATEGORIES = Object.freeze(/** @type {const} */ (['now', 'today', 'soon', 'resurface', 'connection']));
/** @typedef {(typeof CATEGORIES)[number]} Category */

export const FRESHNESS_STATES = Object.freeze(/** @type {const} */ (['current', 'stale', 'suspended', 'invalidated']));
/** @typedef {(typeof FRESHNESS_STATES)[number]} FreshnessState */

/** Why a signal isn't current: invalidation.js has the table that sets each */
export const FRESHNESS_CAUSES = Object.freeze(
  /** @type {const} */ ([
    'source-edited',
    'producer-version',
    'recipe-version',
    'model-changed',
    'runtime-changed',
    'route-changed',
    'scope-revoked',
    'anchor-deleted',
    'source-deleted',
    'not-reproduced',
    'note-trashed',
    'note-archived',
    'template',
    'legacy',
  ]),
);
/** @typedef {(typeof FRESHNESS_CAUSES)[number]} FreshnessCause */

export const DECISION_STATUSES = Object.freeze(/** @type {const} */ (['active', 'snoozed', 'completed', 'dismissed']));
/** @typedef {(typeof DECISION_STATUSES)[number]} DecisionStatus */

export const DISMISS_REASONS = Object.freeze(/** @type {const} */ (['not-actionable', 'not-related', 'confirmed']));
/** @typedef {(typeof DISMISS_REASONS)[number]} DismissReason */

export const CONFIDENCE_BANDS = Object.freeze(/** @type {const} */ (['low', 'medium', 'high']));

/** The reason a producer gives, which categories.js may replace with a time rule's */
export const REASON_CODES = Object.freeze(
  /** @type {const} */ (['open-task', 'pinned-note', 'mentioned-in-note', 'linked-notes', 'related-notes']),
);

export const HISTORY_ACTIONS = Object.freeze(
  /** @type {const} */ (['complete', 'reopen', 'dismiss', 'snooze', 'correct', 'tombstone']),
);

/**
 * The top-level domains a bare `host.tld` counts as a link under, so a file name such as
 * `README.md/CHANGELOG.md` stays text: the common generic and country ones, the reserved test
 * ones, punycode, and any non-ASCII one
 */
const TLDS =
  'com|net|org|edu|gov|mil|int|io|co|ai|app|dev|info|biz|me|us|uk|de|fr|es|it|nl|ru|cn|jp|in|br|au|ca|ch|se|no|fi|' +
  'dk|pl|cz|at|be|ie|nz|za|kr|tw|hk|sg|mx|ar|tr|ua|il|eu|xyz|online|site|tech|store|cloud|page|link|live|news|blog|' +
  'shop|example|test|invalid|local|localdomain|internal|onion';

const LABEL = '[\\p{L}\\p{N}-]+';
const TLD = `(?:${TLDS}|xn--[a-z0-9-]+|(?:(?![\\x00-\\x7f])\\p{L}){2,})`;
const HOST = `(?:${LABEL}\\.)+${TLD}`;
const IPV4 = '\\d{1,3}(?:\\.\\d{1,3}){3}';
const USERINFO = '(?:[\\p{L}\\p{N}._~%+-]+(?::[^\\s@/]*)?@)';
// A bare host is a link only with a port, a path, a query, or a fragment after it, so a plain
// email or a word with a dot stays text
const AFTER_HOST = '(?::\\d{1,5}(?:[/?#]\\S*)?|[/?#]\\S*)';
// Not right after a letter, digit, colon, dot, or hyphen, so `re:sms:send` and `a.b` stay text
const START = '(?<![\\p{L}\\p{N}:._@-])';

/**
 * A link in text:
 * - any `word:` followed by `//` or `?` (`https://`, `chrome-extension://`, `magnet:?`)
 * - a scheme that needs neither: `javascript:`, `vbscript:`, `mailto:`, `data:` with a media
 *   type, `file:/`, `blob:`, `about:`, `tel:` and `sms:` with a number, `skype:`, `callto:`,
 *   `facetime:`, `irc:`, `sip:`
 * - a `www.` host, or a bare host, IPv4 address, or `localhost` with a port, path, query, or
 *   fragment after it, and any userinfo before it
 */
const LINK = new RegExp(
  [
    `${START}[a-z][a-z0-9+.-]*:(?:\\/\\/|\\?)\\S*`,
    `${START}(?:javascript:\\S+|vbscript:\\S+|mailto:\\S+|data:(?:[a-z]+\\/|,)\\S*|file:\\/\\S*|blob:[a-z]\\S*|` +
      'about:[a-z]\\S*|(?:tel|sms):\\+?\\d[\\d-]{2,}\\S*|(?:skype|callto|facetime|irc|sip):\\S+)',
    `${START}www\\.\\S+`,
    `${START}${USERINFO}?(?:${HOST}|${IPV4}|localhost)${AFTER_HOST}`,
  ].join('|'),
  'giu',
);

/** What a redacted link reads as */
export const LINK_PLACEHOLDER = '[link]';

const LINK_IN_TEXT = new RegExp(LINK.source, 'iu');

/** @param {string} text */
const hasLink = text => LINK_IN_TEXT.test(text);

/**
 * A link's match without the punctuation that ends the sentence around it: a final `.`, `,`,
 * `;`, `:`, `!`, `?`, or quote, and a closing bracket the link didn't open
 * @param {string} match
 * @returns {[string, string]} the link and what follows it
 */
const splitTrailing = match => {
  let link = match;
  for (;;) {
    const last = link[link.length - 1];
    if (/[.,;:!?'"]/.test(last)) link = link.slice(0, -1);
    else if (last === ')' && link.split(')').length > link.split('(').length) link = link.slice(0, -1);
    else if (last === ']' && link.split(']').length > link.split('[').length) link = link.slice(0, -1);
    else break;
  }
  return [link, match.slice(link.length)];
};

/**
 * Invisible characters that change how text reads without showing: the soft hyphen, the
 * Arabic letter mark, zero-width spaces and joiners, the left-to-right and right-to-left
 * marks, the bidi embeddings, overrides, and isolates, the invisible operators, and the
 * byte-order mark
 * @param {number} unit
 */
const isInvisibleUnit = unit =>
  unit === 0x00ad ||
  unit === 0x061c ||
  unit === 0x180e ||
  (unit >= 0x200b && unit <= 0x200f) ||
  (unit >= 0x202a && unit <= 0x202e) ||
  (unit >= 0x2060 && unit <= 0x2064) ||
  (unit >= 0x2066 && unit <= 0x2069) ||
  unit === 0xfeff;

/**
 * Whether a UTF-16 unit can't sit in plain text: a control character other than a tab, the
 * line and paragraph separators, and the invisible characters above
 * @param {number} unit
 */
const isUnsafeUnit = unit =>
  (unit < 0x20 && unit !== 0x09) || unit === 0x7f || unit === 0x2028 || unit === 0x2029 || isInvisibleUnit(unit);

/**
 * @param {string} text
 */
const hasControl = text => {
  for (let index = 0; index < text.length; index += 1) {
    if (isUnsafeUnit(text.charCodeAt(index))) return true;
  }
  return false;
};

/**
 * Plain text up to `max` characters, with no link and no unsafe character
 * @param {number} max
 */
export const plainText = max =>
  v.pipe(
    v.string(),
    v.maxLength(max),
    v.check(text => !hasLink(text) && !hasControl(text), 'plain text with no URL'),
  );

/**
 * An id a producer, model, provider, scope, or location goes by: lowercase letters, digits,
 * `.`, `-`, `_`, and `@` for a version, up to 64 characters, so no URL, token, or free text
 * fits
 */
export const slug = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._@-]{0,63}$/));

/** `YYYY-MM-DD`, a real calendar date */
export const localDate = v.pipe(
  v.string(),
  v.maxLength(10),
  v.check(date => isLocalDate(date), 'a local date'),
);

export const signalId = v.pipe(v.string(), v.regex(SIGNAL_ID));

export const identitySchema = v.strictObject({
  producerId: slug,
  noteId: entityId('note'),
  anchorBlockId: v.nullable(entityId('block')),
  // A recipe's subject key is normalized from what the user wrote, so plain text, no link
  subjectKey: content(v.pipe(plainText(SUBJECT_KEY_MAX), v.minLength(1))),
});

/**
 * When a signal is due or comes back: an instant (`dueAt`) or a floating local date
 * (`dueDate`), never both, and `resurfaceAt`
 */
export const timeBasisSchema = v.pipe(
  v.strictObject({
    dueAt: v.optional(timestamp),
    dueDate: v.optional(localDate),
    resurfaceAt: v.optional(timestamp),
  }),
  v.check(time => time.dueAt === undefined || time.dueDate === undefined, 'an instant or a date, not both'),
);

export const blockSourceSchema = v.strictObject({
  kind: v.literal('block'),
  noteId: entityId('note'),
  blockId: entityId('block'),
  revision: v.nullable(revision),
});

export const noteSourceSchema = v.strictObject({
  kind: v.literal('note'),
  noteId: entityId('note'),
  revision: v.nullable(revision),
});

/** What a signal cites: a block with its revision, or a note for an anchor-null signal */
export const sourceRefSchema = v.variant('kind', [blockSourceSchema, noteSourceSchema]);

export const reasonSchema = v.strictObject({
  code: v.picklist(REASON_CODES),
  params: v.strictObject({ count: v.optional(count) }),
});

export const confidenceSchema = v.strictObject({
  band: v.picklist(CONFIDENCE_BANDS),
  reason: content(plainText(REASON_MAX)),
});

/**
 * What a suspended signal goes back to. `regenerationSent` says whether its stale state has
 * had its regeneration request already, so restoring it sends one only for a signal that went
 * stale while it was suspended.
 */
const resumeSchema = v.strictObject({
  state: v.picklist(['current', 'stale', 'invalidated']),
  cause: v.nullable(v.picklist(FRESHNESS_CAUSES)),
  invalidatedAt: v.nullable(timestamp),
  regenerationSent: v.boolean(),
});

/**
 * `resumeTo` is what a suspended signal goes back to when the note is restored or stops being
 * a template
 */
export const freshnessSchema = v.pipe(
  v.strictObject({
    state: v.picklist(FRESHNESS_STATES),
    cause: v.nullable(v.picklist(FRESHNESS_CAUSES)),
    since: v.nullable(timestamp),
    invalidatedAt: v.nullable(timestamp),
    resumeTo: v.nullable(resumeSchema),
  }),
  v.check(
    f =>
      (f.state === 'current') === (f.cause === null) &&
      (f.state === 'invalidated') === (f.invalidatedAt !== null) &&
      (f.state === 'suspended') === (f.resumeTo !== null),
    'a cause unless current, invalidatedAt exactly when invalidated, and resumeTo exactly when suspended',
  ),
);

export const contextSchema = v.strictObject({
  // The latest block edit in the note, from #17's content commits, never the note's updatedAt
  lastEditAt: v.nullable(timestamp),
  // The local date when the note is a Daily Note (#17's local-date identity)
  dailyNoteDate: v.nullable(localDate),
  notePinned: v.boolean(),
});

/**
 * @param {readonly string[]} list
 * @param {unknown} value
 */
const isIn = (list, value) => list.includes(/** @type {string} */ (value));

/**
 * The cross-field rules a signal keeps, as text for the first it breaks, or null
 * @param {SignalShape} s
 * @returns {string | null}
 */
function signalProblem(s) {
  if (s.id !== idOfIdentity(s.identity)) return 'id-not-identity';
  if (isIn(OBJECTIVE_KINDS, s.kind) && s.provenance !== 'objective') return 'kind-is-objective';
  if (isIn(INFERRED_KINDS, s.kind) && s.provenance !== 'inferred') return 'kind-is-inferred';
  const inference = s.derivationRef !== null || s.model !== null || s.providerId !== null || s.scopeId !== null;
  if (s.provenance === 'objective') {
    if (s.executionClass !== 'deterministic') return 'objective-is-deterministic';
    if (s.confidence !== null || inference) return 'objective-has-no-inference';
  } else if (s.executionClass === 'deterministic') {
    return 'inferred-is-not-deterministic';
  } else if (s.executionClass === 'unrecorded') {
    if (s.confidence !== null || inference) return 'unrecorded-has-no-inference';
    if (s.sourceRefs.some(source => source.kind !== 'note' || source.revision !== null)) return 'unrecorded-cites-note';
  } else if (
    s.confidence === null ||
    s.derivationRef === null ||
    s.model === null ||
    s.providerId === null ||
    s.scopeId === null
  ) {
    return 'inferred-needs-derivation';
  }
  if ((s.executionClass === 'local-endpoint') !== (s.location !== null)) return 'location-for-local-endpoint';
  const anchor = s.identity.anchorBlockId;
  if (anchor === null) {
    if (s.sourceRefs.some(source => source.kind !== 'note')) return 'anchor-null-cites-notes';
    if (!s.sourceRefs.some(source => source.noteId === s.identity.noteId)) return 'cites-own-note';
  } else {
    if (s.sourceRefs.some(source => source.kind !== 'block')) return 'anchored-cites-blocks';
    if (
      !s.sourceRefs.some(
        source => source.kind === 'block' && source.blockId === anchor && source.noteId === s.identity.noteId,
      )
    ) {
      return 'cites-own-anchor';
    }
  }
  if ((s.kind === 'connection') !== (s.category === 'connection')) return 'connection-category';
  if (isIn(OBJECTIVE_KINDS, s.kind) && s.category !== null) return 'objective-category-is-computed';
  if ((s.kind === 'task') !== (s.checked !== null)) return 'checked-for-tasks';
  if (s.checked === null && s.checkedAt !== null) return 'checked-at-for-tasks';
  if (s.title === '' && s.freshness.cause !== 'scope-revoked') return 'title-cleared-only-on-revoke';
  const cited = new Set([s.identity.noteId, ...s.sourceRefs.map(source => source.noteId)]);
  if (s.unavailableNotes.some(entry => !cited.has(entry.noteId))) return 'unavailable-note-is-cited';
  return null;
}

/** The causes a note the signal cites is unavailable for: trashed, archived, or a template */
export const UNAVAILABLE_CAUSES = Object.freeze(/** @type {const} */ (['note-trashed', 'note-archived', 'template']));

/**
 * A note the signal cites, its own included, that is trashed, archived, or a template. The
 * domain keeps these, so restoring the note puts the signal back as it was (lifecycle.js).
 */
export const unavailableNoteSchema = v.strictObject({
  noteId: entityId('note'),
  cause: v.picklist(UNAVAILABLE_CAUSES),
});

const signalEntries = {
  recordVersion: v.literal(RECORD_VERSION),
  id: signalId,
  identity: identitySchema,
  kind: v.picklist(KINDS),
  provenance: v.picklist(PROVENANCES),
  executionClass: v.picklist(EXECUTION_CLASSES),
  location: v.nullable(v.strictObject({ kind: v.picklist(LOCATION_KINDS), id: slug })),
  producerVersion: count,
  sourceRefs: v.pipe(v.array(sourceRefSchema), v.minLength(1), v.maxLength(SOURCES_MAX)),
  title: content(plainText(TITLE_MAX)),
  reason: reasonSchema,
  time: v.nullable(timeBasisSchema),
  category: v.nullable(v.picklist(CATEGORIES)),
  context: contextSchema,
  checked: v.nullable(v.boolean()),
  checkedAt: v.nullable(timestamp),
  confidence: v.nullable(confidenceSchema),
  derivationRef: v.nullable(slug),
  model: v.nullable(v.strictObject({ id: slug, version: slug })),
  providerId: v.nullable(slug),
  scopeId: v.nullable(slug),
  generatedAt: timestamp,
  freshness: freshnessSchema,
  unavailableNotes: v.pipe(v.array(unavailableNoteSchema), v.maxLength(SOURCES_MAX)),
  revision,
};

/** @typedef {v.InferOutput<v.StrictObjectSchema<typeof signalEntries, undefined>>} SignalShape */

/** An IntelligenceSignal as its repository stores it */
export const signalRecord = v.pipe(
  v.strictObject(signalEntries),
  v.check(signal => signalProblem(signal) === null, 'a signal keeps its cross-field rules'),
);

export const historyEntrySchema = v.strictObject({
  decisionRevision: v.pipe(revision, v.minValue(1)),
  action: v.picklist(HISTORY_ACTIONS),
  status: v.picklist(DECISION_STATUSES),
  at: timestamp,
  commandId: v.nullable(id),
});

/** A SignalDecision as its repository stores it */
export const decisionRecord = v.pipe(
  v.strictObject({
    recordVersion: v.literal(RECORD_VERSION),
    signalId,
    identity: identitySchema,
    status: v.picklist(DECISION_STATUSES),
    snoozedUntil: v.nullable(timestamp),
    dismissReason: v.nullable(v.picklist(DISMISS_REASONS)),
    completedAt: v.nullable(timestamp),
    decisionRevision: v.pipe(revision, v.minValue(1)),
    updatedAt: timestamp,
    history: v.pipe(v.array(historyEntrySchema), v.maxLength(HISTORY_MAX)),
    tombstone: v.nullable(v.strictObject({ at: timestamp, cause: v.literal('anchor-deleted') })),
  }),
  v.check(
    d =>
      d.signalId === idOfIdentity(d.identity) &&
      (d.status === 'snoozed') === (d.snoozedUntil !== null) &&
      (d.status === 'completed') === (d.completedAt !== null) &&
      (d.status === 'dismissed' || d.dismissReason === null),
    'a decision keeps its cross-field rules',
  ),
);

/** What a correction changes, by field. `source` removes (or, undone, restores) one source. */
export const correctionChangeSchema = v.variant('field', [
  v.strictObject({
    field: v.literal('category'),
    before: v.nullable(v.picklist(CATEGORIES)),
    after: v.nullable(v.picklist(CATEGORIES)),
  }),
  v.strictObject({ field: v.literal('time'), before: v.nullable(timeBasisSchema), after: v.nullable(timeBasisSchema) }),
  v.strictObject({ field: v.literal('actionable'), before: v.boolean(), after: v.boolean() }),
  v.strictObject({ field: v.literal('source'), sourceRef: sourceRefSchema, before: v.boolean(), after: v.boolean() }),
]);

/** A SignalCorrection as its repository stores it: one entry of an append-only list */
export const correctionRecord = v.pipe(
  v.strictObject({
    recordVersion: v.literal(RECORD_VERSION),
    entryId: id,
    signalId,
    identity: identitySchema,
    change: correctionChangeSchema,
    note: v.nullable(content(plainText(REASON_MAX))),
    at: timestamp,
    commandId: id,
  }),
  v.check(c => c.signalId === idOfIdentity(c.identity), 'a correction names its signal'),
);

/** @typedef {v.InferOutput<typeof signalRecord>} IntelligenceSignal */
/** @typedef {v.InferOutput<typeof decisionRecord>} SignalDecision */
/** @typedef {v.InferOutput<typeof correctionRecord>} SignalCorrection */
/** @typedef {v.InferOutput<typeof timeBasisSchema>} TimeBasis */
/** @typedef {v.InferOutput<typeof sourceRefSchema>} SourceRef */
/** @typedef {v.InferOutput<typeof freshnessSchema>} Freshness */
/** @typedef {v.InferOutput<typeof correctionChangeSchema>} CorrectionChange */
/** @typedef {v.InferOutput<typeof historyEntrySchema>} HistoryEntry */

/**
 * The first rule `signal` breaks, as a code, or null when it's a valid signal. A producer's
 * fake, or #8's recipe, gets this back when it offers a signal that isn't one.
 * @param {unknown} signal
 * @returns {string | null}
 */
export function signalRefusal(signal) {
  const shape = v.safeParse(v.strictObject(signalEntries), signal);
  if (!shape.success) return 'invalid-signal';
  return signalProblem(shape.output);
}

/** @param {unknown} value */
export const isSignal = value => v.is(signalRecord, value);
/** @param {unknown} value */
export const isDecision = value => v.is(decisionRecord, value);
/** @param {unknown} value */
export const isCorrection = value => v.is(correctionRecord, value);

/** The most of a source's text redaction reads, so a huge block can't make it slow */
const MAX_SOURCE_TEXT = 4000;

/**
 * `text` as plain text up to `max` characters: invisible characters removed, each link
 * replaced by LINK_PLACEHOLDER (the punctuation after it kept), control characters and line
 * separators turned to spaces, whitespace collapsed, and clipped with an ellipsis. A note's own text, a todo with a link included, still makes a
 * signal, and the signal keeps no URL. Text that only says something, like "password:
 * hunter2", passes as written, and so does a plain email address, the user's own text: this
 * redacts links, it can't tell what a sentence means.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function redactText(text, max) {
  const visible = [...String(text).slice(0, MAX_SOURCE_TEXT)]
    .filter(character => !isInvisibleUnit(character.charCodeAt(0)))
    .join('');
  const redacted = visible.replace(LINK, match => {
    const [, after] = splitTrailing(match);
    return `${LINK_PLACEHOLDER}${after}`;
  });
  const plain = [...redacted]
    .map(character => (hasControl(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  // Clipped by UTF-16 length, as the schema counts, never inside a surrogate pair
  let clipped = '';
  for (const character of plain) {
    if (clipped.length + character.length > max - 1) break;
    clipped += character;
  }
  return `${clipped.trimEnd()}…`;
}

/**
 * `text` as a signal title (redactText, up to TITLE_MAX)
 * @param {string} text
 * @returns {string}
 */
export function plainTitle(text) {
  return redactText(text, TITLE_MAX);
}
