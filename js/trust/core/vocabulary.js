/**
 * The fixed words of the Trust and Recovery Center (#20, "Required states"): what a provider,
 * a remediation run, and an incident can be, how bad an incident is, what a check costs, and
 * the groups providers and remediations sort into. Records, contracts, and the families read
 * these, and nothing adds to them at run time.
 *
 * js/trust/core/ is host-neutral under #12's module rules: no browser API, no legacy global,
 * and imports only from itself, #12's kernel core, #15's registry kit, and the vendored
 * Valibot. `npm run check:boundaries` holds it to that (`trust-global`, `trust-import`).
 */

/**
 * A provider's status. `checking` is a check in flight, and `stale` a receipt past its window
 * or dated in the future; neither is ever stored, since both come from the time a receipt is
 * read. `unverified` is "Not verified yet".
 */
export const PROVIDER_STATUSES = Object.freeze(
  /** @type {const} */ ([
    'checking',
    'verified',
    'stale',
    'unverified',
    'not-configured',
    'off',
    'unsupported',
    'locked',
    'degraded',
    'action-required',
    'failed',
  ]),
);

/** @typedef {(typeof PROVIDER_STATUSES)[number]} ProviderStatus */

/** The statuses a check can report and a receipt can store: all but the two read-time ones */
export const RECEIPT_STATUSES = Object.freeze(
  /** @type {const} */ ([
    'verified',
    'unverified',
    'not-configured',
    'off',
    'unsupported',
    'locked',
    'degraded',
    'action-required',
    'failed',
  ]),
);

/** @typedef {(typeof RECEIPT_STATUSES)[number]} ReceiptStatus */

/**
 * Statuses from worst to best, for the worst core status trust.summary reports. A status
 * that says nothing is wrong but nothing was verified either sits above `verified`, so a
 * summary is never healthy on a provider that only read settings.
 */
export const STATUS_ORDER = Object.freeze(
  /** @type {const} */ ([
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
  ]),
);

/** What a core provider says about capture: still safe, or at risk */
export const CAPTURE_STATES = Object.freeze(/** @type {const} */ (['safe', 'at-risk']));

/** @typedef {(typeof CAPTURE_STATES)[number]} CaptureState */

/** A remediation run's states */
export const RUN_STATES = Object.freeze(
  /** @type {const} */ (['planned', 'awaiting-confirmation', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
);

/** @typedef {(typeof RUN_STATES)[number]} RunState */

/**
 * A remediation run's steps, in order (#20, "Remediation pipeline"). A run's record names the
 * step it's on, written before the step starts, so a run cut off anywhere says where it
 * stopped. `record` is the last write, of how it ended.
 */
export const RUN_STEPS = Object.freeze(
  /** @type {const} */ (['plan', 'preview', 'protect', 'apply', 'verify', 'record']),
);

/** @typedef {(typeof RUN_STEPS)[number]} RunStep */

/**
 * What a remediation's class needs before apply, beside its preview: the user's confirmation,
 * a verified #17 recovery point, a recovery file saved in this run, and the action's name
 * typed out
 */
export const PROTECTIONS = Object.freeze(
  /** @type {const} */ (['confirmation', 'recovery-point', 'recovery-file', 'typed-phrase']),
);

/** @typedef {(typeof PROTECTIONS)[number]} Protection */

/** The run states nothing moves on from */
export const FINISHED_RUN_STATES = Object.freeze(
  /** @type {const} */ (['succeeded', 'failed', 'cancelled', 'interrupted']),
);

/**
 * An incident's states. It's `resolved` only after re-verification passes. Dismissal is a
 * flag on an open incident, never a state.
 */
export const INCIDENT_STATES = Object.freeze(/** @type {const} */ (['open', 'remediating', 'resolved']));

/** @typedef {(typeof INCIDENT_STATES)[number]} IncidentState */

/** How bad an incident is, worst first */
export const SEVERITIES = Object.freeze(/** @type {const} */ (['capture-risk', 'data-risk', 'degraded']));

/** @typedef {(typeof SEVERITIES)[number]} Severity */

/** What a check costs, which decides when it may run (#20, "Where checks run") */
export const COST_CLASSES = Object.freeze(/** @type {const} */ (['local-cheap', 'local-expensive', 'network']));

/** @typedef {(typeof COST_CLASSES)[number]} CostClass */

/**
 * What can start a check: opening Trust, Verify now, idle work, a Chrome permission change, a
 * restore finishing, or #35's scheduled refresh once it lands
 */
export const TRIGGERS = Object.freeze(
  /** @type {const} */ (['open', 'verify-now', 'idle', 'permissions-changed', 'storage-restored', 'scheduled']),
);

/** @typedef {(typeof TRIGGERS)[number]} Trigger */

/**
 * The subsystems providers report on (approved scope: "storage, vault, backup, sync, indexing,
 * inference, permissions, and recovery"), plus `platform` for #13's messaging health and #15's
 * resolution report. Group order on screen is slice 4's, under the Design gate.
 */
export const HEALTH_GROUPS = Object.freeze(
  /** @type {const} */ (['storage', 'vault', 'backup', 'sync', 'indexing', 'inference', 'permissions', 'recovery', 'platform']),
);

/** @typedef {(typeof HEALTH_GROUPS)[number]} HealthGroup */

/**
 * What a remediation does, from approved AC2: inspect, retry, rollback, export, repair, or
 * safe-disable
 */
export const REMEDIATION_GROUPS = Object.freeze(
  /** @type {const} */ (['inspect', 'retry', 'rollback', 'export', 'repair', 'safe-disable']),
);

/**
 * A remediation's class, which sets the protection it needs before apply (#20, "Remediation
 * pipeline"): nothing, a preview and confirmation, those and a verified recovery point, or
 * those and a recovery file saved in this run with a typed confirmation. `secret-removal`
 * (slice 4a, Remove saved keys) is outside the four's record rules: a preview and
 * confirmation, for a removal that touches only the saved-key entries it names, since a
 * secret never goes into a file and so no file can be the way back.
 */
export const REMEDIATION_CLASSES = Object.freeze(
  /** @type {const} */ (['non-destructive', 'regenerable', 'reversible', 'irreversible', 'secret-removal']),
);

/** @typedef {(typeof REMEDIATION_CLASSES)[number]} RemediationClass */

/**
 * Where 1.4.x and releases up to 1.1.2 kept a plaintext secret (the legacy secret reader's
 * places): the AI key (with its owner setting) and the WebDAV password in
 * chrome.storage.local, and the AI key 1.1 left in CanvasTabDB's `settings` store
 */
export const SECRET_PLACES = Object.freeze(
  /** @type {const} */ (['setting_llmApiKey', 'setting_syncWebdavConfig', 'settings']),
);

/** @typedef {(typeof SECRET_PLACES)[number]} SecretPlace */

/**
 * The providers whose incidents count as storage incidents: the one kind that survives in
 * chrome.storage.local while IndexedDB won't open (#20, "Records")
 */
export const STORAGE_PROVIDERS = Object.freeze(/** @type {const} */ (['capture', 'storage']));
