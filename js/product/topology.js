/**
 * Continuity Canvas topology (#1): apertures, routes and history, and the per-tab
 * ProductSession, as pure functions. docs/product/continuity-canvas.md is the
 * contract, and "rule N" below is its rule N.
 *
 * No I/O and no browser globals. Callers pass in what they read (the URL,
 * history.state, sessionStorage, chrome.storage.local records, open tabs) and
 * write any record a function returns. Nothing here mutates its input, and every
 * session or layout returned is a new object.
 */

import {
  fieldsIssue, invalid, isEntityId, isEntityIdOrNull, isOneOf, isOneOfOrNull, isRecord,
} from './validation.js';

/** @template T @typedef {import('./validation.js').Validation<T>} Validation */

/** @typedef {'moment' | 'workspace'} Aperture */
/** @typedef {Aperture | 'last-used'} DefaultAperture */
/** @typedef {'excerpts' | 'titles' | 'none'} ExcerptVisibility */
/**
 * @typedef {'inbox' | 'daily' | 'projects' | 'templates' | 'search' | 'insights'
 *   | 'trust' | 'settings' | 'graph' | 'analytics' | 'archive' | 'trash'} RouteId
 */
/** @typedef {'outline' | 'backlinks' | 'properties' | 'history' | 'ai'} InspectorId */
/** @typedef {'collection' | 'canvas' | 'inspector'} Pane */

/**
 * @typedef {object} SplitView
 * @property {boolean} enabled
 * @property {string | null} secondaryNoteId
 */

/**
 * The layout snapshot, stored as the workspaceLayout record (last writer wins,
 * seeds new instances only), and the layout each Workspace session carries.
 * documentTabs are note IDs, and activeIndex is 0 when there are none.
 * @typedef {object} WorkspaceLayout
 * @property {1} version
 * @property {string[]} documentTabs
 * @property {number} activeIndex
 * @property {SplitView} split
 * @property {InspectorId | null} inspector
 */

/**
 * One per newtab.html document, IDs only, written to sessionStorage under
 * SESSION_STORAGE_KEY. noteId is the canvas note. A Workspace session always has
 * a route and a layout, and a Moment session keeps the ones it left Workspace
 * with (rule 7).
 * @typedef {object} ProductSession
 * @property {1} version
 * @property {Aperture} aperture
 * @property {RouteId | null} route
 * @property {string | null} noteId
 * @property {WorkspaceLayout | null} layout
 */

/**
 * What a URL names
 * @typedef {{aperture: 'moment', route: null, noteId: string | null}
 *   | {aperture: 'workspace', route: RouteId, noteId: string | null}} RouteTarget
 */

/**
 * @typedef {{kind: 'none'}
 *   | {kind: 'route', aperture: 'moment', route: null, noteId: string | null}
 *   | {kind: 'route', aperture: 'workspace', route: RouteId, noteId: string | null}
 *   | {kind: 'unknown-route', aperture: Aperture, noteId: string | null}
 *   | {kind: 'invalid'}} ParsedRoute
 */

/** @typedef {'boot' | 'reload' | 'back-forward' | 'popstate'} LaunchTrigger */
/** @typedef {'unknown-route' | 'invalid-preference'} LaunchNotice */

/**
 * @typedef {object} LaunchInput
 * @property {LaunchTrigger} trigger
 * @property {string | null} [url] location.href, or just its hash
 * @property {unknown} [pane] history.state's pane
 * @property {unknown} [savedSession] the parsed sessionStorage session, or the live one on popstate
 * @property {unknown} [defaultAperture] the stored defaultAperture record
 * @property {unknown} [lastUsedAperture] the stored lastUsedAperture record
 * @property {unknown} [layoutSnapshot] the parsed workspaceLayout record, or null
 * @property {RouteId | null} [homeRoute] home collection of noteOnOpenWorkspace(null, layoutSnapshot), read only when the default opens Workspace
 */

/**
 * @typedef {{session: ProductSession, pane: Pane | null, notice: LaunchNotice | null}
 *   & ({history: 'none'} | {history: 'replace', url: string})} LaunchResult
 */

/** @typedef {'open-workspace' | 'return-to-moment'} TransitionEvent */
/**
 * @typedef {TransitionEvent | 'boot' | 'reload' | 'back-forward' | 'deep-link'
 *   | 'popstate' | 'default-change'} ApertureEvent
 */

/**
 * @typedef {{session: ProductSession, history: 'none'}
 *   | {session: ProductSession, history: 'push', url: string}} TransitionResult
 */

/**
 * @typedef {'defaultAperture' | 'lastUsedAperture' | 'excerptVisibility'} PreferenceKey
 */

/**
 * The three preference records as read, defaults filled in. invalid lists the
 * records that were present but malformed or of an unknown version.
 * @typedef {object} AperturePreferences
 * @property {DefaultAperture} defaultAperture
 * @property {Aperture | null} lastUsedAperture
 * @property {ExcerptVisibility} excerptVisibility
 * @property {PreferenceKey[]} invalid
 */

/** @typedef {{version: 1, value: Aperture, at: number}} LastUsedApertureRecord */

/**
 * One tab from #2's readOpenTabs()
 * @typedef {object} OpenTab
 * @property {number} tabId
 * @property {number} windowId
 * @property {string} url the documentUrl chrome.runtime.getContexts reports
 * @property {number} [lastAccessed] from chrome.tabs.query
 */

/**
 * @typedef {object} OpenNoteInput
 * @property {string | null} [noteId] the note to open, or none for a Workspace target
 * @property {number} windowId the current window
 * @property {ReadonlyArray<OpenTab>} [tabs]
 * @property {unknown} [defaultAperture] the stored defaultAperture record
 * @property {unknown} [lastUsedAperture] the stored lastUsedAperture record
 * @property {RouteId | null} [homeRoute] the note's home collection, for a new Workspace tab
 */

/** @typedef {{action: 'activate', tabId: number} | {action: 'open', url: string}} OpenNoteAction */

/**
 * 1.4.0's tab settings, as getSetting returns them
 * @typedef {object} LegacyTabState
 * @property {unknown} [openTabs] [{noteId, name}], or null
 * @property {unknown} [activeTabIndex]
 * @property {unknown} [splitViewEnabled]
 * @property {unknown} [secondaryNoteId]
 */

export const PRODUCT_NAME = 'NewTabNote';
export const NEWTAB_PAGE = 'newtab.html';
export const SESSION_STORAGE_KEY = 'ntn.productSession';

/** @type {ReadonlyArray<Aperture>} */
export const APERTURES = Object.freeze(['moment', 'workspace']);
/** @type {ReadonlyArray<DefaultAperture>} */
export const DEFAULT_APERTURES = Object.freeze(['moment', 'workspace', 'last-used']);
/** @type {ReadonlyArray<ExcerptVisibility>} */
export const EXCERPT_VISIBILITIES = Object.freeze(['excerpts', 'titles', 'none']);

/**
 * Workspace routes until #15's navigation registry supplies them
 * @type {ReadonlyArray<RouteId>}
 */
export const WORKSPACE_ROUTES = Object.freeze([
  'inbox', 'daily', 'projects', 'templates', 'search', 'insights',
  'trust', 'settings', 'graph', 'analytics', 'archive', 'trash',
]);

/**
 * Routes that list notes beside the canvas. The others are route destinations,
 * whose outlet covers the canvas, so Open Workspace doesn't restore them (rule 7).
 * @type {ReadonlyArray<RouteId>}
 */
export const NOTE_DESTINATIONS = Object.freeze(['inbox', 'daily', 'projects', 'templates', 'search', 'archive', 'trash']);

/**
 * Tab-title labels for the routes, until #15's registry supplies them (rule 11)
 * @type {Readonly<Record<RouteId, string>>}
 */
export const ROUTE_LABELS = Object.freeze({
  inbox: 'Inbox',
  daily: 'Daily',
  projects: 'Projects',
  templates: 'Templates',
  search: 'Search',
  insights: 'Insights',
  trust: 'Trust',
  settings: 'Settings',
  graph: 'Graph',
  analytics: 'Analytics',
  archive: 'Archive',
  trash: 'Trash',
});

/**
 * Inspectors until #15's registry supplies them
 * @type {ReadonlyArray<InspectorId>}
 */
export const INSPECTORS = Object.freeze(['outline', 'backlinks', 'properties', 'history', 'ai']);

/**
 * Panes of #3's one-pane stack below 720 px, carried in history.state
 * @type {ReadonlyArray<Pane>}
 */
export const PANES = Object.freeze(['collection', 'canvas', 'inspector']);

/** @type {ReadonlyArray<LaunchTrigger>} */
const LAUNCH_TRIGGERS = Object.freeze(['boot', 'reload', 'back-forward', 'popstate']);
const SESSION_FIELDS = Object.freeze(['version', 'aperture', 'route', 'noteId', 'layout']);
const LAYOUT_FIELDS = Object.freeze(['version', 'documentTabs', 'activeIndex', 'split', 'inspector']);
const SPLIT_FIELDS = Object.freeze(['enabled', 'secondaryNoteId']);
const PREFERENCE_FIELDS = Object.freeze(['version', 'value']);
const LAST_USED_FIELDS = Object.freeze(['version', 'value', 'at']);

// ============ Routes ============

/**
 * Read the route in a URL or a hash (Routes and history)
 *
 * - `none`: no hash, as a fresh Moment keeps it.
 * - `route`: `#/moment[?note=<id>]` or `#/workspace/<route>[?note=<id>]`.
 * - `unknown-route`: a known aperture with a missing or unknown route, which
 *   opens that aperture's default destination with a notice.
 * - `invalid`: anything else, an unknown aperture or a query other than one
 *   note included, which counts as no URL (rule 3).
 *
 * @param {string | null | undefined} url
 * @returns {ParsedRoute}
 */
export function parseRoute(url) {
  const hash = hashOf(url);
  if (hash === '') return { kind: 'none' };

  const fragment = hash.slice(1);
  const queryStart = fragment.indexOf('?');
  const path = queryStart === -1 ? fragment : fragment.slice(0, queryStart);
  /** @type {string | null} */
  let noteId = null;
  if (queryStart !== -1) {
    const note = readNoteQuery(fragment.slice(queryStart + 1));
    if (note === null) return { kind: 'invalid' };
    noteId = note;
  }

  const [root, aperture, route, ...rest] = path.split('/');
  if (root !== '') return { kind: 'invalid' };
  if (aperture === 'moment') {
    return route === undefined
      ? { kind: 'route', aperture: 'moment', route: null, noteId }
      : { kind: 'unknown-route', aperture: 'moment', noteId };
  }
  if (aperture === 'workspace') {
    return rest.length === 0 && isOneOf(WORKSPACE_ROUTES, route)
      ? { kind: 'route', aperture: 'workspace', route, noteId }
      : { kind: 'unknown-route', aperture: 'workspace', noteId };
  }
  return { kind: 'invalid' };
}

/**
 * The hash for a session or a route target. It carries the aperture, the route,
 * and the encoded note ID, and nothing else (AC6). A Moment hash has no route,
 * since the route waits in the session.
 * @param {{aperture: Aperture, route: RouteId | null, noteId: string | null}} target
 * @returns {string}
 */
export function formatRoute(target) {
  const { aperture, route, noteId } = target;
  if (!isEntityIdOrNull(noteId)) {
    throw new TypeError('formatRoute: noteId must be a note ID or null');
  }
  const query = noteId === null ? '' : `?note=${encodeURIComponent(noteId)}`;
  if (aperture === 'moment') return `#/moment${query}`;
  if (aperture === 'workspace' && isOneOf(WORKSPACE_ROUTES, route)) return `#/workspace/${route}${query}`;
  throw new TypeError('formatRoute: needs a Moment target, or a Workspace target with a known route');
}

/**
 * The hash of a URL or of a hash, '#' included, or '' when there's none
 * @param {string | null | undefined} url
 * @returns {string}
 */
function hashOf(url) {
  if (typeof url !== 'string') return '';
  const start = url.indexOf('#');
  return start === -1 || start === url.length - 1 ? '' : url.slice(start);
}

/**
 * The note ID in a route's query, which must be exactly `note=<encoded id>`, or
 * null when it isn't
 * @param {string} query the text after '?'
 * @returns {string | null}
 */
function readNoteQuery(query) {
  if (!query.startsWith('note=') || query.includes('&')) return null;
  let noteId;
  try {
    noteId = decodeURIComponent(query.slice('note='.length));
  } catch {
    return null;
  }
  return isEntityId(noteId) ? noteId : null;
}

// ============ Sessions and layouts ============

/**
 * Check a saved or live ProductSession, and return a copy. Rejects any field
 * beyond version, aperture, route, noteId, and layout (AC6).
 * @param {unknown} value
 * @returns {Validation<ProductSession>}
 */
export function validateProductSession(value) {
  if (!isRecord(value)) return invalid('session is not an object');
  const issue = fieldsIssue(value, SESSION_FIELDS);
  if (issue !== null) return invalid(`session has ${issue}`);
  if (value.version !== 1) return invalid('session version is not 1');

  const { aperture, route, noteId, layout } = value;
  if (!isOneOf(APERTURES, aperture)) return invalid('session aperture is not moment or workspace');
  if (!isOneOfOrNull(WORKSPACE_ROUTES, route)) return invalid('session route is unknown');
  if (!isEntityIdOrNull(noteId)) return invalid('session noteId is not a note ID');
  /** @type {WorkspaceLayout | null} */
  let checkedLayout = null;
  if (layout !== null) {
    const result = validateWorkspaceLayout(layout);
    if (result.ok === false) return invalid(`session ${result.reason}`);
    checkedLayout = result.value;
  }
  if (aperture === 'workspace' && (route === null || checkedLayout === null)) {
    return invalid('a Workspace session needs a route and a layout');
  }
  return { ok: true, value: { version: 1, aperture, route, noteId, layout: checkedLayout } };
}

/**
 * Check a workspaceLayout record or a session's layout, and return a copy
 * @param {unknown} value
 * @returns {Validation<WorkspaceLayout>}
 */
export function validateWorkspaceLayout(value) {
  if (!isRecord(value)) return invalid('layout is not an object');
  const issue = fieldsIssue(value, LAYOUT_FIELDS);
  if (issue !== null) return invalid(`layout has ${issue}`);
  if (value.version !== 1) return invalid('layout version is not 1');

  const { documentTabs, activeIndex, split, inspector } = value;
  if (!Array.isArray(documentTabs) || !documentTabs.every(isEntityId)) {
    return invalid('layout documentTabs is not a list of note IDs');
  }
  if (typeof activeIndex !== 'number' || !Number.isInteger(activeIndex)
    || activeIndex < 0 || activeIndex >= Math.max(documentTabs.length, 1)) {
    return invalid('layout activeIndex is out of range');
  }
  if (!isRecord(split) || fieldsIssue(split, SPLIT_FIELDS) !== null) return invalid('layout split is malformed');
  const { enabled, secondaryNoteId } = split;
  if (typeof enabled !== 'boolean') return invalid('layout split.enabled is not a boolean');
  if (!isEntityIdOrNull(secondaryNoteId)) {
    return invalid('layout split.secondaryNoteId is not a note ID');
  }
  if (!isOneOfOrNull(INSPECTORS, inspector)) return invalid('layout inspector is unknown');
  return {
    ok: true,
    value: { version: 1, documentTabs: [...documentTabs], activeIndex, split: { enabled, secondaryNoteId }, inspector },
  };
}

/**
 * @returns {ProductSession}
 */
function pristineMoment() {
  return { version: 1, aperture: 'moment', route: null, noteId: null, layout: null };
}

/**
 * @returns {WorkspaceLayout}
 */
function emptyLayout() {
  return { version: 1, documentTabs: [], activeIndex: 0, split: { enabled: false, secondaryNoteId: null }, inspector: null };
}

/**
 * @param {WorkspaceLayout} layout
 * @returns {WorkspaceLayout}
 */
function copyLayout(layout) {
  return { ...layout, documentTabs: [...layout.documentTabs], split: { ...layout.split } };
}

/**
 * @param {WorkspaceLayout} layout
 * @returns {string | null}
 */
function activeDocument(layout) {
  return layout.documentTabs[layout.activeIndex] ?? null;
}

/**
 * A valid layout snapshot, or null
 * @param {unknown} value
 * @returns {WorkspaceLayout | null}
 */
function readSnapshot(value) {
  const result = validateWorkspaceLayout(value);
  return result.ok ? result.value : null;
}

/**
 * A session entering Workspace takes a copy of the snapshot when it has no
 * layout, and the layout's active document when it has no note. A note it has
 * becomes the active document tab, added at the end when it isn't open, as
 * 1.4.0's openNoteInNewTab does (rule 6).
 * @param {string | null} noteId
 * @param {WorkspaceLayout | null} layout
 * @param {WorkspaceLayout | null} snapshot
 * @returns {{noteId: string | null, layout: WorkspaceLayout}}
 */
function enterWorkspace(noteId, layout, snapshot) {
  const source = layout || snapshot;
  const restored = source ? copyLayout(source) : emptyLayout();
  if (noteId === null) return { noteId: activeDocument(restored), layout: restored };

  const open = restored.documentTabs.indexOf(noteId);
  if (open === -1) restored.documentTabs.push(noteId);
  restored.activeIndex = open === -1 ? restored.documentTabs.length - 1 : open;
  return { noteId, layout: restored };
}

/**
 * The session Open Workspace gives (rules 6 and 7). The route comes back only
 * for a note destination, and otherwise it's the canvas note's home
 * collection, or Inbox with no note.
 * @param {ProductSession} session
 * @param {WorkspaceLayout | null} snapshot
 * @param {unknown} homeRoute
 * @returns {ProductSession}
 */
function openWorkspace(session, snapshot, homeRoute) {
  const { noteId, layout } = enterWorkspace(session.noteId, session.layout, snapshot);
  /** @type {RouteId} */
  let route = 'inbox';
  if (isOneOf(NOTE_DESTINATIONS, session.route)) route = session.route;
  else if (noteId !== null && isOneOf(NOTE_DESTINATIONS, homeRoute)) route = homeRoute;
  return { version: 1, aperture: 'workspace', route, noteId, layout };
}

/**
 * The note Open Workspace shows in the canvas, so the caller can look up its
 * home collection for homeRoute. Pass null for a brand-new tab whose default
 * opens Workspace.
 * @param {ProductSession | null | undefined} session
 * @param {unknown} [layoutSnapshot]
 * @returns {string | null}
 */
export function noteOnOpenWorkspace(session, layoutSnapshot = null) {
  let current = pristineMoment();
  if (session) {
    const checked = validateProductSession(session);
    if (checked.ok === false) throw new TypeError(`noteOnOpenWorkspace: ${checked.reason}`);
    current = checked.value;
  }
  return enterWorkspace(current.noteId, current.layout, readSnapshot(layoutSnapshot)).noteId;
}

// ============ Launch and transitions ============

/**
 * The resolveLaunch trigger for a document load, from
 * PerformanceNavigationTiming.type. Duplicated and restored tabs report
 * back_forward (the record's browser check). Anything else, prerender
 * included, is a boot.
 * @param {unknown} navigationType
 * @returns {Exclude<LaunchTrigger, 'popstate'>}
 */
export function launchTriggerFor(navigationType) {
  if (navigationType === 'reload') return 'reload';
  if (navigationType === 'back_forward') return 'back-forward';
  return 'boot';
}

/**
 * Resolve a document load, or a same-document Back or Forward (rules 1 to 3)
 *
 * - `reload`, and `boot` with no valid URL, restore a valid saved session in full.
 * - `boot` with a valid URL, `back-forward`, and `popstate` apply a valid URL to
 *   the saved session under the popstate rules: no `?note=` means no note, a
 *   Moment URL keeps the session's route and layout, and a Workspace URL keeps
 *   its layout. `back-forward` and `popstate` with no URL give Moment on the
 *   session's note, with its route and layout kept.
 * - With no valid session, a load applies a valid URL as a new instance, else
 *   follows the default (rule 1).
 *
 * An unknown aperture or a malformed query counts as no URL, and an unknown
 * route opens the aperture's default destination with notice `unknown-route`.
 * A default read from a malformed record gives notice `invalid-preference`.
 * History `replace` carries formatRoute(session) whenever the session differs
 * from the URL, a default-Workspace boot included, except a Moment session over
 * a bare URL, which stays bare. `pane` comes from history.state for a Workspace
 * session the URL or the saved session gave, and is null otherwise.
 *
 * @param {LaunchInput} input
 * @returns {LaunchResult}
 */
export function resolveLaunch(input) {
  const { trigger } = input;
  if (!isOneOf(LAUNCH_TRIGGERS, trigger)) throw new TypeError('resolveLaunch: unknown trigger');

  const saved = validateProductSession(input.savedSession);
  const base = saved.ok ? saved.value : null;
  const snapshot = readSnapshot(input.layoutSnapshot);
  const target = urlTarget(parseRoute(input.url));

  /** @type {ProductSession} */
  let session;
  /** @type {LaunchNotice | null} */
  let notice = null;
  let fromDefault = false;
  if (base && (trigger === 'reload' || (trigger === 'boot' && target === null))) {
    session = base;
  } else if (target !== null) {
    session = applyRoute(target.route, base, snapshot);
    if (target.unknownRoute) notice = 'unknown-route';
  } else if (base) {
    session = { ...base, aperture: 'moment' };
  } else {
    ({ session, notice } = launchFromDefault(input, snapshot));
    fromDefault = true;
  }

  const pane = !fromDefault && session.aperture === 'workspace' && isOneOf(PANES, input.pane) ? input.pane : null;
  return { session, pane, notice, ...historyFor(session, input.url) };
}

/**
 * What a URL's route opens, with an unknown route mapped to its aperture's
 * default destination
 * @param {ParsedRoute} parsed
 * @returns {{route: RouteTarget, unknownRoute: boolean} | null}
 */
function urlTarget(parsed) {
  if (parsed.kind === 'none' || parsed.kind === 'invalid') return null;
  const { noteId } = parsed;
  if (parsed.aperture === 'moment') {
    return { route: { aperture: 'moment', route: null, noteId }, unknownRoute: parsed.kind === 'unknown-route' };
  }
  const route = parsed.kind === 'route' ? parsed.route : 'inbox';
  return { route: { aperture: 'workspace', route, noteId }, unknownRoute: parsed.kind === 'unknown-route' };
}

/**
 * Apply a URL's route to the saved session under the popstate rules, or start a
 * new instance from it when there's no saved session
 * @param {RouteTarget} target
 * @param {ProductSession | null} base
 * @param {WorkspaceLayout | null} snapshot
 * @returns {ProductSession}
 */
function applyRoute(target, base, snapshot) {
  if (target.aperture === 'moment') {
    return {
      version: 1,
      aperture: 'moment',
      route: base ? base.route : null,
      noteId: target.noteId,
      layout: base ? base.layout : null,
    };
  }
  if (base && base.layout) {
    return { version: 1, aperture: 'workspace', route: target.route, noteId: target.noteId, layout: base.layout };
  }
  const entered = enterWorkspace(target.noteId, null, snapshot);
  return { version: 1, aperture: 'workspace', route: target.route, noteId: entered.noteId, layout: entered.layout };
}

/**
 * Rule 1: a brand-new tab follows the default. `workspace` acts like Open
 * Workspace from a pristine Moment, and `last-used` opens the stored aperture,
 * else Moment.
 * @param {LaunchInput} input
 * @param {WorkspaceLayout | null} snapshot
 * @returns {{session: ProductSession, notice: LaunchNotice | null}}
 */
function launchFromDefault(input, snapshot) {
  const prefs = readAperturePreferences({
    defaultAperture: input.defaultAperture,
    lastUsedAperture: input.lastUsedAperture,
  });
  const lastUsed = prefs.defaultAperture === 'last-used';
  const aperture = lastUsed ? prefs.lastUsedAperture || 'moment' : prefs.defaultAperture;
  const readInvalid = prefs.invalid.includes('defaultAperture')
    || (lastUsed && prefs.invalid.includes('lastUsedAperture'));
  const notice = readInvalid ? 'invalid-preference' : null;
  const session = aperture === 'workspace'
    ? openWorkspace(pristineMoment(), snapshot, input.homeRoute)
    : pristineMoment();
  return { session, notice };
}

/**
 * The history step that keeps the URL on the session
 * @param {ProductSession} session
 * @param {string | null | undefined} url
 * @returns {{history: 'none'} | {history: 'replace', url: string}}
 */
function historyFor(session, url) {
  const current = hashOf(url);
  if (session.aperture === 'moment' && current === '') return { history: 'none' };
  const next = formatRoute(session);
  return next === current ? { history: 'none' } : { history: 'replace', url: next };
}

/**
 * Open Workspace and Return to Moment (rules 6 and 7), in-place transitions
 * that push one history entry each. Open Workspace keeps the canvas note as the
 * active tab of the restored layout, or takes that layout's active document
 * from a pristine Moment. Return to Moment keeps the note, the route, and the
 * layout, which wait in the session.
 * @param {ProductSession} session the tab's live session
 * @param {TransitionEvent} event
 * @param {unknown} [layoutSnapshot] the parsed workspaceLayout record, or null
 * @param {RouteId | null} [homeRoute] home collection of noteOnOpenWorkspace(session, layoutSnapshot)
 * @returns {TransitionResult}
 */
export function resolveTransition(session, event, layoutSnapshot = null, homeRoute = null) {
  const checked = validateProductSession(session);
  if (checked.ok === false) throw new TypeError(`resolveTransition: ${checked.reason}`);
  const current = checked.value;

  /** @type {ProductSession} */
  let next;
  if (event === 'open-workspace') {
    if (current.aperture === 'workspace') return { session: current, history: 'none' };
    next = openWorkspace(current, readSnapshot(layoutSnapshot), homeRoute);
  } else if (event === 'return-to-moment') {
    if (current.aperture === 'moment') return { session: current, history: 'none' };
    next = { ...current, aperture: 'moment' };
  } else {
    throw new TypeError('resolveTransition: unknown event');
  }
  return { session: next, history: 'push', url: formatRoute(next) };
}

// ============ Opening a note in a tab ============

/**
 * Where Popup, Side Panel, a notification, or the open-workspace command opens a
 * note (Opening a note in a tab). A current-window tab whose URL names the note
 * is activated, the latest accessed when several do, and a tab with a bare URL
 * never matches. Else a new tab opens in the default aperture. With no note,
 * the current window's latest Workspace tab is activated, else a new tab opens
 * at #/workspace/inbox.
 * @param {OpenNoteInput} input
 * @returns {OpenNoteAction}
 */
export function resolveOpenNote(input) {
  const noteId = input.noteId ?? null;
  if (!isEntityIdOrNull(noteId)) throw new TypeError('resolveOpenNote: noteId must be a note ID or none');

  /** @type {OpenTab | null} */
  let latest = null;
  for (const tab of input.tabs || []) {
    if (!isRecord(tab) || !Number.isInteger(tab.tabId) || !Number.isInteger(tab.windowId)) continue;
    if (tab.windowId !== input.windowId || !isNewTabPage(tab.url)) continue;
    const parsed = parseRoute(tab.url);
    if (parsed.kind !== 'route') continue;
    if (noteId === null ? parsed.aperture !== 'workspace' : parsed.noteId !== noteId) continue;
    if (latest === null || accessedAt(tab) > accessedAt(latest)) latest = tab;
  }
  if (latest !== null) return { action: 'activate', tabId: latest.tabId };

  if (noteId === null) {
    return { action: 'open', url: NEWTAB_PAGE + formatRoute({ aperture: 'workspace', route: 'inbox', noteId: null }) };
  }
  const prefs = readAperturePreferences({
    defaultAperture: input.defaultAperture,
    lastUsedAperture: input.lastUsedAperture,
  });
  const aperture = prefs.defaultAperture === 'last-used' ? prefs.lastUsedAperture || 'moment' : prefs.defaultAperture;
  const route = isOneOf(NOTE_DESTINATIONS, input.homeRoute) ? input.homeRoute : 'inbox';
  const hash = aperture === 'workspace'
    ? formatRoute({ aperture: 'workspace', route, noteId })
    : formatRoute({ aperture: 'moment', route: null, noteId });
  return { action: 'open', url: NEWTAB_PAGE + hash };
}

/**
 * Whether a tab's URL is newtab.html, so a page whose own hash looks like a
 * route never matches
 * @param {unknown} url
 * @returns {boolean}
 */
function isNewTabPage(url) {
  if (typeof url !== 'string') return false;
  const page = url.split('#')[0];
  return page === NEWTAB_PAGE || page.endsWith(`/${NEWTAB_PAGE}`);
}

/**
 * @param {OpenTab} tab
 * @returns {number}
 */
function accessedAt(tab) {
  return typeof tab.lastAccessed === 'number' && Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : -Infinity;
}

// ============ Preferences ============

/**
 * Read the three preference records (Data and migration). A missing, malformed,
 * or unknown-version record reads as its default: defaultAperture `moment`,
 * lastUsedAperture none, excerptVisibility `excerpts`. Nothing is returned to
 * write back, so a read never rewrites a setting (AC3).
 * @param {{defaultAperture?: unknown, lastUsedAperture?: unknown, excerptVisibility?: unknown}} [records]
 * @returns {AperturePreferences}
 */
export function readAperturePreferences(records = {}) {
  /** @type {Record<string, unknown>} */
  const source = isRecord(records) ? records : {};
  /** @type {PreferenceKey[]} */
  const invalidKeys = [];
  const defaultAperture = readPreference(source, 'defaultAperture', DEFAULT_APERTURES, invalidKeys) || 'moment';
  const lastUsedAperture = readPreference(source, 'lastUsedAperture', APERTURES, invalidKeys);
  const excerptVisibility = readPreference(source, 'excerptVisibility', EXCERPT_VISIBILITIES, invalidKeys) || 'excerpts';
  return { defaultAperture, lastUsedAperture, excerptVisibility, invalid: invalidKeys };
}

/**
 * The value of one version 1 preference record, or null when it's missing or
 * malformed. A malformed record's key goes in invalidKeys.
 * @template {string} T
 * @param {Record<string, unknown>} records
 * @param {PreferenceKey} key
 * @param {ReadonlyArray<T>} values
 * @param {PreferenceKey[]} invalidKeys
 * @returns {T | null}
 */
function readPreference(records, key, values, invalidKeys) {
  const record = records[key];
  if (record === undefined || record === null) return null;
  const stamped = key === 'lastUsedAperture';
  if (isRecord(record)
    && fieldsIssue(record, stamped ? LAST_USED_FIELDS : PREFERENCE_FIELDS) === null
    && record.version === 1
    && (!stamped || isTimestamp(record.at))
    && isOneOf(values, record.value)) {
    return record.value;
  }
  invalidKeys.push(key);
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The lastUsedAperture record to write after an event, or null. Only an
 * explicit Open Workspace or Return to Moment counts, from any tab, last write
 * winning (rule 4). Loads, history, deep links, and default changes don't.
 * @param {ApertureEvent} event
 * @param {number} now ms since the epoch
 * @returns {LastUsedApertureRecord | null}
 */
export function nextLastUsed(event, now) {
  const value = event === 'open-workspace' ? 'workspace' : event === 'return-to-moment' ? 'moment' : null;
  if (value === null) return null;
  if (!isTimestamp(now)) throw new TypeError('nextLastUsed: now must be a timestamp');
  return { version: 1, value, at: now };
}

// ============ Layout seed ============

/**
 * Build the workspaceLayout record once from 1.4.0's openTabs, activeTabIndex,
 * splitViewEnabled, and secondaryNoteId, for the caller to write when there's
 * none (AC8). Each tab keeps its note ID and loses the legacy name, and tabs
 * and a secondary note whose notes are gone are dropped, as loadSavedTabs does.
 * The active tab keeps its place when its note survives, else the next
 * survivor takes it, else the last. The legacy keys are only read; they stay
 * as they are until #17 moves per-tab state.
 * @param {LegacyTabState} legacy
 * @param {Iterable<string>} existingNoteIds the notes getNote finds, trashed and archived included
 * @returns {WorkspaceLayout}
 */
export function seedWorkspaceLayout(legacy, existingNoteIds) {
  /** @type {Record<string, unknown>} */
  const source = isRecord(legacy) ? legacy : {};
  const exists = new Set(existingNoteIds);
  const { openTabs, activeTabIndex, splitViewEnabled, secondaryNoteId } = source;
  const savedIndex = typeof activeTabIndex === 'number' && Number.isInteger(activeTabIndex) && activeTabIndex >= 0
    ? activeTabIndex
    : 0;

  /** @type {string[]} */
  const documentTabs = [];
  let keptBeforeActive = 0;
  (Array.isArray(openTabs) ? openTabs : []).forEach((tab, index) => {
    const noteId = isRecord(tab) ? tab.noteId : undefined;
    if (!isEntityId(noteId) || !exists.has(noteId)) return;
    if (index < savedIndex) keptBeforeActive += 1;
    documentTabs.push(noteId);
  });

  return {
    version: 1,
    documentTabs,
    activeIndex: documentTabs.length === 0 ? 0 : Math.min(keptBeforeActive, documentTabs.length - 1),
    split: {
      enabled: Boolean(splitViewEnabled),
      secondaryNoteId: isEntityId(secondaryNoteId) && exists.has(secondaryNoteId) ? secondaryNoteId : null,
    },
    inspector: null,
  };
}

// ============ Titles ============

/**
 * The tab title (rule 11): "NewTabNote" in Moment, "<route label> · NewTabNote"
 * in Workspace. It reads only the aperture and the route, so no note text can
 * reach it (AC6, open Q3).
 * @param {{aperture?: unknown, route?: unknown} | null | undefined} session
 * @returns {string}
 */
export function documentTitle(session) {
  if (!session || session.aperture !== 'workspace') return PRODUCT_NAME;
  const { route } = session;
  return isOneOf(WORKSPACE_ROUTES, route) ? `${ROUTE_LABELS[route]} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}
