/**
 * The registered codes and names evidence may hold (#20, "Security and privacy"). A code that
 * only follows a pattern lets a caller pass a title as `my-divorce-plans` or a key as an
 * exception's name, so every field that names an error, a fault, a reason, a subject, or a
 * capability takes one of the values listed here and nothing else. Slice 2's providers add
 * the faults and subjects they report, by PR, here.
 */

/**
 * Error and DOMException names: ECMAScript's own, the WebIDL DOMException names, and the
 * kernel's UnavailableError. An error whose name isn't one of these is recorded without one.
 */
export const EXCEPTION_NAMES = Object.freeze([
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'UnavailableError',
  'AbortError',
  'ConstraintError',
  'DataCloneError',
  'DataError',
  'EncodingError',
  'HierarchyRequestError',
  'IndexSizeError',
  'InvalidAccessError',
  'InvalidCharacterError',
  'InvalidModificationError',
  'InvalidNodeTypeError',
  'InvalidStateError',
  'NamespaceError',
  'NetworkError',
  'NoModificationAllowedError',
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'NotSupportedError',
  'OperationError',
  'OptOutError',
  'QuotaExceededError',
  'ReadOnlyError',
  'SecurityError',
  'TimeoutError',
  'TransactionInactiveError',
  'TypeMismatchError',
  'URLMismatchError',
  'UnknownError',
  'VersionError',
  'WrongDocumentError',
]);

/**
 * Error codes: what the kernel's adapters answer (UnavailableError codes), and the Trust
 * Center's own for a check that couldn't verify
 */
export const ERROR_CODES = Object.freeze([
  // #12's and #17's adapters
  'adapter-failed',
  'blocked-upgrade',
  'constraint',
  'database-closed',
  'invalid-cursor',
  'invalid-key',
  'invalid-limit',
  'maintenance-failed',
  'maintenance-needs-versioned-open',
  'missing-core-stores',
  'no-database',
  'not-cloneable',
  'not-open',
  'open-failed',
  'open-pending',
  'quota',
  'reload-required',
  'retries-exhausted',
  'revision-before-get',
  'setting-not-served',
  'settings-read-failed',
  'settings-write-failed',
  'store-outside-transaction',
  'store-unavailable',
  'timed-out',
  'transaction-ended-early',
  'transaction-failed',
  'transaction-inactive',
  'unknown-store',
  'unreadable',
  'version-too-new',
  'write-in-readonly-transaction',
  'write-outside-scope',
  // A check that couldn't verify (checks.js)
  'check-threw',
  'check-timed-out',
  'invalid-check-result',
  'provider-unavailable',
]);

/** Faults an incident can be about, from the failure sites and the providers that report them */
export const FAULT_CODES = Object.freeze([
  // The failure sites #20 slice 1b moves onto logger.event (event-codes.js)
  'capture-failed',
  'open-failed',
  'load-failed',
  'auto-backup-failed',
  'indexer-start-failed',
  // Storage and capture (#17's storage health)
  'quota',
  'version-too-new',
  'scan-findings',
  'journal-backlog',
  'probe-failed',
  // Backup, sync, index, models, and permissions (slice 2's providers)
  'stale-backup',
  'conflict',
  'lagging',
  'stalled',
  'model-corrupt',
  'model-rebuilding',
  'grant-missing',
  'permission-changed',
  'legacy-secret',
  // Recovery readiness, messaging, and the registry's resolution report (slice 2's providers)
  'point-unverified',
  'unreachable',
  'contribution-unavailable',
  // A write to NewTabNoteTrust that failed, counted while the store won't take writes
  'write-failed',
]);

/**
 * The health providers there are, by id: slice 2's real and interim ones (#20, "Providers").
 * A provider's descriptor id is one of these, and so is every providerId a record or an event
 * holds, so no string a caller makes up passes as one.
 */
export const PROVIDER_IDS = Object.freeze([
  'capture',
  'storage',
  'recovery-readiness',
  'backup',
  'sync',
  'credentials',
  'permissions',
  'ai-scope-grants',
  'remote-ai',
  'local-inference',
  'index',
  'messaging',
  'contributions',
  'block-types',
]);

/** The remediations there are, by id: slice 3's (#20, "Remediation pipeline") */
export const REMEDIATION_IDS = Object.freeze([
  'retry-open',
  'retry-sync',
  'reconnect',
  'safe-disable',
  'rebuild-index',
  'remove-index',
  'save-recovery-file',
  'save-salvage-file',
  'export-diagnostics',
  'recover-orphans',
  'discard-orphans',
  'remove-saved-key',
  'restore-point',
  'delete-restore-point',
  'reset',
]);

/** Reasons: why an event didn't reach the journal (journal.js) */
export const REASON_CODES = Object.freeze([
  'unregistered-code',
  'field-not-allowed',
  'value-not-allowed',
  'not-an-object',
  'write-failed',
]);

/** What a remediation run ended with: an error code, or one of these */
export const RUN_OUTCOMES = Object.freeze([...ERROR_CODES, 'verified', 'not-verified', 'cancelled-by-user']);

/** The capabilities an incident affects, or a degraded system still preserves */
export const CAPABILITIES = Object.freeze([
  'capture',
  'editing',
  'reading',
  'search',
  'backup',
  'restore',
  'sync',
  'export',
  'ai',
  'indexing',
  'context-menus',
  'side-panel',
]);

/**
 * Named subjects an incident can be about, beside a record's id: the databases and their
 * stores, and the manifest's permissions
 */
export const SUBJECT_NAMES = Object.freeze([
  'CanvasTabDB',
  'NewTabNoteTrust',
  'NewTabNoteJournal',
  'canvases',
  'elements',
  'settings',
  'media',
  'search_index',
  'folders',
  'links',
  'themes',
  'vectors',
  'snapshots',
  'receipts',
  'incidents',
  'runs',
  'journal',
  'storage',
  'unlimitedStorage',
  'offscreen',
  'contextMenus',
  'notifications',
  'activeTab',
  'sidePanel',
]);
