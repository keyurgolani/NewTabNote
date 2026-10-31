/**
 * The interim providers (#20, "Providers"): Backup, Sync, Credentials, AI scope grants, Remote
 * AI, and Local inference, until the issue that owns each real one replaces it (#18, #19, #21,
 * #21, #11, and #9 with #10). They read only 1.4.x's legacy facts, so none of them can verify
 * anything, and `interim()` holds them to that: whatever a check answers, `verified` is
 * recorded as `unverified` (approved AC3; #20 AC5: "Each legacy flag alone yields `unverified`
 * or `not-configured`"). A configured fact goes into the receipt as evidence, never as health.
 *
 * Credentials is the one that can ask for action: `action-required`, with next action "Remove
 * saved key" (`remove-saved-key`, slice 3's remediation), when the legacy secret reader finds a
 * plaintext secret. That reader answers which sources hold one, never the value, so no secret
 * reaches this module, a receipt, an incident, the journal, or the export.
 */

import { isTime, portOf } from './context.js';

/** @typedef {import('../checks.js').CheckResult} CheckResult */
/** @typedef {import('./context.js').SecretSource} SecretSource */

/**
 * The chrome.storage.local keys the interim providers read, as Storage.setSetting writes them.
 * None holds a credential: the AI key and the WebDAV config (whose password is plaintext) are
 * read only by the secret reader, which answers present or absent.
 */
export const LEGACY_FACT_KEYS = Object.freeze([
  'setting_syncProvider',
  'setting_syncLastSyncAt',
  'setting_lastBackupAt',
  'setting_autoBackupEnabled',
  'setting_llmProvider',
]);

/**
 * 1.4.x's legacy facts, each reduced to what a receipt may say of it: a time, or whether it's set
 * @typedef {object} LegacyFacts
 * @property {boolean} syncConfigured - a sync provider is chosen
 * @property {number | null} syncLastSyncAt
 * @property {number | null} lastBackupAt - when an export or an auto-backup last started
 * @property {boolean} autoBackupEnabled
 * @property {boolean} remoteAiConfigured - an AI provider other than none is chosen
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const chosen = value => typeof value === 'string' && value.trim() !== '' && value !== 'none';

/**
 * Reads the legacy facts from chrome.storage.local, the keys LEGACY_FACT_KEYS lists and no others
 * @param {import('../ports.js').SettingsPort} settings
 * @returns {Promise<LegacyFacts>}
 */
export async function readLegacyFacts(settings) {
  const stored = (await settings.get([...LEGACY_FACT_KEYS])) || {};
  return {
    syncConfigured: chosen(stored.setting_syncProvider),
    syncLastSyncAt: isTime(stored.setting_syncLastSyncAt) ? stored.setting_syncLastSyncAt : null,
    lastBackupAt: isTime(stored.setting_lastBackupAt) ? stored.setting_lastBackupAt : null,
    autoBackupEnabled: stored.setting_autoBackupEnabled === true,
    remoteAiConfigured: chosen(stored.setting_llmProvider),
  };
}

/**
 * An interim provider's check, which can never record `verified`
 * @param {(context: Readonly<Record<string, unknown>>) => Promise<CheckResult> | CheckResult} check
 */
export function interim(check) {
  return Object.freeze({
    /**
     * @param {Readonly<Record<string, unknown>>} context
     * @returns {Promise<CheckResult>}
     */
    async check(context) {
      const result = await check(context);
      return result.status === 'verified' ? { ...result, status: 'unverified' } : result;
    },
  });
}

/** The legacy facts from the context's settings area */
const factsOf = (/** @type {Readonly<Record<string, unknown>>} */ context) => readLegacyFacts(portOf(context, 'settings'));

/** Backup: the last export or auto-backup's start, and whether auto-backup is on. #18 verifies backups. */
export const backup = interim(async context => {
  const facts = await factsOf(context);
  if (facts.lastBackupAt === null && !facts.autoBackupEnabled) return { status: 'not-configured' };
  return {
    status: 'unverified',
    evidence: facts.lastBackupAt === null ? {} : { since: facts.lastBackupAt },
    consequenceKey: 'backup.not-verified',
  };
});

/** Sync: `unverified` whenever a provider is chosen. #19 verifies sync. */
export const sync = interim(async context => {
  const facts = await factsOf(context);
  if (!facts.syncConfigured) return { status: 'not-configured' };
  return {
    status: 'unverified',
    evidence: facts.syncLastSyncAt === null ? {} : { since: facts.syncLastSyncAt },
    consequenceKey: 'sync.not-verified',
  };
});

/** Remote AI: `unverified` whenever a provider other than none is chosen. #11 verifies it. */
export const remoteAi = interim(async context => {
  const facts = await factsOf(context);
  return facts.remoteAiConfigured ? { status: 'unverified', consequenceKey: 'inference.not-verified' } : { status: 'not-configured' };
});

/** AI scope grants: none exist before #21, so there's nothing granted to check */
export const aiScopeGrants = interim(() => ({ status: 'not-configured', evidence: { count: 0 } }));

/**
 * Local inference: `not-configured` until the model has loaded once, then `unverified`, and
 * `action-required` while a load failure slice 1b journals is open as an incident. #9 and #10
 * verify the runtime and the model library. That the model loaded shows as a non-empty
 * `vectors` store, since nothing journals a load that worked.
 */
export const localInference = interim(async context => {
  const incidents = await portOf(context, 'trust').incidents();
  const failing = incidents.filter(
    incident => incident.providerId === 'local-inference' && incident.faultCode === 'load-failed' && incident.state !== 'resolved',
  );
  if (failing.length > 0) {
    return {
      status: 'action-required',
      evidence: { count: failing.reduce((total, incident) => total + incident.occurrences, 0) },
      consequenceKey: 'inference.load-failed',
      preserved: ['capture', 'editing', 'reading'],
    };
  }
  const loaded = await portOf(context, 'vectors').stored();
  return loaded ? { status: 'unverified', consequenceKey: 'inference.not-verified' } : { status: 'not-configured' };
});

/**
 * The incident subject for each source of a legacy secret: its key, named, never its value
 * @type {Readonly<Record<SecretSource, string>>}
 */
const SECRET_SUBJECTS = Object.freeze({
  setting_llmApiKey: 'setting_llmApiKey',
  setting_syncWebdavConfig: 'setting_syncWebdavConfig',
  settings: 'settings',
});

/**
 * Credentials: `action-required` with "Remove saved key" when a legacy plaintext secret is
 * kept, one incident per place it's kept, and `not-configured` otherwise, since there's no
 * vault before #21
 */
export const credentials = interim(async context => {
  const sources = [...new Set(await portOf(context, 'secrets').present())].filter(source =>
    Object.prototype.hasOwnProperty.call(SECRET_SUBJECTS, source),
  );
  if (sources.length === 0) return { status: 'not-configured', evidence: { count: 0 } };
  return {
    status: 'action-required',
    evidence: { count: sources.length },
    consequenceKey: 'vault.legacy-secret',
    preserved: ['capture', 'editing', 'reading', 'ai', 'sync'],
    nextAction: 'remove-saved-key',
    faults: sources.map(source => ({
      faultCode: /** @type {const} */ ('legacy-secret'),
      subjectId: SECRET_SUBJECTS[source],
      severity: /** @type {const} */ ('data-risk'),
      preserved: ['capture', 'editing', 'reading'],
    })),
  };
});
