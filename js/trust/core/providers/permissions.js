/**
 * Permissions and destinations (#20, "Providers"): what Chrome has granted, read from
 * chrome.permissions.getAll(), matched against what the manifest declares, beside the packaged
 * list of egress no permission covers (egress.js), which the receipt counts and the Trust
 * Center lists. It's verified by Chrome's answer, never by the manifest alone.
 *
 * - `verified` when every declared permission and host permission is granted and nothing
 *   outside the manifest (its optional fields included) is;
 * - `degraded` when a declared host permission isn't granted, as when the user limits site
 *   access in chrome://extensions: AI requests to that host fail, and nothing else changes;
 * - `action-required` when a declared API permission is missing, or Chrome grants one the
 *   manifest doesn't declare, each with its incident.
 *
 * Its trigger includes `permissions-changed`: the root that registers it (slice 4's Trust page,
 * then #35's worker) rechecks on chrome.permissions' onAdded and onRemoved. #21 adds optional
 * grants and the origins a user enters.
 */

import { SUBJECT_NAMES } from '../codes.js';
import { portOf } from './context.js';
import { UNCOVERED_EGRESS } from './egress.js';

/** @typedef {import('../checks.js').CheckResult} CheckResult */
/** @typedef {import('../checks.js').CheckResult['faults']} Faults */

/**
 * What losing each declared API permission costs, in the capabilities codes.js lists
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const AFFECTS = Object.freeze({
  storage: Object.freeze(['capture', 'editing', 'reading']),
  unlimitedStorage: Object.freeze(['capture', 'editing']),
  offscreen: Object.freeze(['ai', 'search']),
  contextMenus: Object.freeze(['context-menus', 'capture']),
  notifications: Object.freeze([]),
  activeTab: Object.freeze(['capture']),
  sidePanel: Object.freeze(['side-panel']),
});

/**
 * @param {unknown} value
 * @returns {string[]}
 */
const strings = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);

/**
 * The permission's name as an incident's subject, when codes.js lists it
 * @param {string} name
 */
const subjectOf = name => (SUBJECT_NAMES.includes(name) ? name : null);

/**
 * The permissions Chrome grants for a manifest key rather than a `permissions` entry, which
 * getAll() lists: a page override, as the new tab is (seen in Chromium by
 * e2e/trust-permissions.spec.js)
 */
const IMPLIED = Object.freeze({ newtab: 'newTabPageOverride', bookmarks: 'bookmarksPageOverride', history: 'historyPageOverride' });

/**
 * @param {{chrome_url_overrides?: unknown}} manifest
 * @returns {string[]}
 */
function impliedBy(manifest) {
  const overrides = manifest.chrome_url_overrides;
  if (overrides === null || typeof overrides !== 'object') return [];
  return Object.entries(IMPLIED)
    .filter(([page]) => Object.prototype.hasOwnProperty.call(overrides, page))
    .map(([, permission]) => permission);
}

/**
 * Compares Chrome's grants with the manifest
 * @param {{permissions?: unknown, origins?: unknown}} granted
 * @param {{permissions?: unknown, optional_permissions?: unknown, host_permissions?: unknown, optional_host_permissions?: unknown, chrome_url_overrides?: unknown}} manifest
 */
export function comparePermissions(granted, manifest) {
  const grantedApis = new Set(strings(granted.permissions));
  const grantedOrigins = new Set(strings(granted.origins));
  const declaredApis = strings(manifest.permissions);
  const declaredOrigins = strings(manifest.host_permissions);
  const allowedApis = new Set([...declaredApis, ...strings(manifest.optional_permissions), ...impliedBy(manifest)]);
  const allowedOrigins = new Set([...declaredOrigins, ...strings(manifest.optional_host_permissions)]);
  return {
    missingApis: declaredApis.filter(name => !grantedApis.has(name)),
    missingOrigins: declaredOrigins.filter(origin => !grantedOrigins.has(origin)),
    extraApis: [...grantedApis].filter(name => !allowedApis.has(name)),
    extraOrigins: [...grantedOrigins].filter(origin => !allowedOrigins.has(origin)),
    granted: grantedApis.size + grantedOrigins.size,
  };
}

export const permissions = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {Promise<CheckResult>}
   */
  async check(context) {
    const reader = portOf(context, 'permissions');
    const manifest = portOf(context, 'manifest');
    const found = comparePermissions(await reader.getAll(), manifest);
    const evidence = { count: found.granted, records: UNCOVERED_EGRESS.length };
    /** @type {NonNullable<Faults>} */
    const faults = [];
    for (const name of found.missingApis) {
      faults.push({
        faultCode: 'grant-missing',
        subjectId: subjectOf(name),
        severity: 'degraded',
        affected: [.../** @type {string[]} */ (AFFECTS[name] || [])],
      });
    }
    if (found.extraApis.length > 0 || found.extraOrigins.length > 0) {
      faults.push({ faultCode: 'permission-changed', subjectId: null, severity: 'degraded' });
    }
    if (faults.length > 0) {
      return {
        status: 'action-required',
        evidence: { ...evidence, pending: found.missingApis.length + found.missingOrigins.length },
        consequenceKey: 'permissions.changed',
        faults: found.missingOrigins.length > 0 ? [...faults, missingOriginsFault()] : faults,
      };
    }
    if (found.missingOrigins.length > 0) {
      return {
        status: 'degraded',
        evidence: { ...evidence, pending: found.missingOrigins.length },
        consequenceKey: 'permissions.site-access-limited',
        preserved: ['capture', 'editing', 'reading', 'search'],
        faults: [missingOriginsFault()],
      };
    }
    return { status: 'verified', evidence };
  },
});

/**
 * One incident for every declared host Chrome doesn't grant: AI requests to them fail
 * @returns {NonNullable<Faults>[number]}
 */
function missingOriginsFault() {
  return {
    faultCode: 'grant-missing',
    subjectId: null,
    severity: 'degraded',
    affected: ['ai'],
    preserved: ['capture', 'editing', 'reading', 'search'],
  };
}
