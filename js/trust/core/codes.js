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
  // #17's recovery points (recovery-points.js): a database it refuses, and why a point failed
  // re-verification
  'recovery-unavailable',
  'manifest-mismatch',
  'row-mismatch',
  'record-mismatch',
  'key-mismatch',
  'purged-row-present',
  'count-mismatch',
  'id-set-mismatch',
  'content-mismatch',
  // #17 PR 1b's migration run: a versioned open below this build's version, and why a run
  // stopped or failed
  'migration-required',
  'space-short',
  'schema-mismatch',
  'recovery-point-unverified',
  'point-missing',
  'locks-unavailable',
  // A database whose shape no step knows, which the run refuses (migrate.js)
  'unknown-shape',
  // #17 PR 3a's data transforms: a meta.schema with no logical version, which they stop at
  // (transforms.js)
  'meta-unreadable',
  // #13's answers that didn't come (contracts/transport-codes.js)
  'unavailable',
  'deadline-exceeded',
  'unauthorized-sender',
  'forbidden-for-surface',
  // A check that couldn't verify (checks.js), and the storage probe finding a record under its
  // key, reading back another, or answered without running
  'probe-record-present',
  'probe-readback-mismatch',
  'probe-not-run',
  'check-threw',
  'check-timed-out',
  'invalid-check-result',
  'provider-unavailable',
  // #35's coordinator, degraded (system.coordinatorHealth): its kernel couldn't be built, or
  // its database couldn't be opened
  'coordinator-unavailable',
  'storage-unavailable',
  // A call the network guard refused (#21 slice 1b): a destination no registry row takes,
  // headers its row doesn't, a call that would follow a redirect it mustn't, or a registry
  // that can't be read
  'destination-refused',
  'headers-refused',
  'redirect-refused',
  'registry-unreadable',
  // #14's producers: a block one built that doesn't decode as a known block, by what decode
  // found (js/kernel/core/blocks/index.js, refusalOf)
  'block-unknown-type',
  'block-newer-version',
  'block-not-a-record',
  'block-invalid-type',
  'block-invalid-version',
  'block-upcast-failed',
  'block-invalid-field',
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
  // #17's recovery-point purge, stopped at a point that didn't verify (event-codes.js)
  'purge-stopped',
  'unreachable',
  'contribution-unavailable',
  // #35's coordinator, whose kernel the worker couldn't build
  'start-failed',
  // A migration to the latest version not done yet, failed, or blocked, with version 8 still
  // working (storage's check)
  'migration-pending',
  'migration-failed',
  'migration-blocked',
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
  'coordinator',
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

/**
 * Why a remediation run stopped short, or didn't start (slice 3's pipeline,
 * remediation/pipeline.js): a gate its class sets that wasn't met, a step that failed, or a
 * file that wasn't saved as written. Codes only, never a message.
 */
export const REMEDIATION_CODES = Object.freeze([
  // The run itself: another context holds its key, it doesn't apply, it expired, or its
  // record wouldn't write
  'remediation-running',
  'not-applicable',
  'run-not-found',
  'run-expired',
  'not-recorded',
  'interrupted',
  // The gates (gates.js)
  'not-confirmed',
  'phrase-mismatch',
  'preview-changed',
  'deletes-user-records',
  // An irreversible run or a secret removal whose destroys step names nothing to check against
  'destroys-unnamed',
  // The steps
  'preview-failed',
  'preview-invalid',
  'protect-failed',
  'apply-failed',
  'verify-failed',
  'nothing-to-do',
  // The recovery point a reversible run takes first (#17's NewTabNoteRecovery)
  'no-recovery-point',
  'recovery-point-unverified',
  'recovery-unavailable',
  'space-short',
  // Save as file and the salvage file (saved-file.js): "saved" means written, closed, read
  // back, parsed, and counted, and anything less is one of these
  'picker-unavailable',
  'file-not-saved',
  'file-unreadable',
  'file-mismatch',
  'build-failed',
  // What a saved salvage or restore-point file read: some of its sources, or none of them,
  // and an irreversible run's recovery file that didn't read CanvasTabDB
  'saved-partial',
  'nothing-readable',
  'salvage-incomplete',
  // Refusals before a run starts: a subject the remediation doesn't take, no Web Locks to keep
  // it to one context, and a regenerable or non-destructive preview that changes user records
  'subject-not-allowed',
  'no-locks',
  'changes-user-records',
]);

/** What a remediation run ended with: an error code, a remediation code, or one of these */
export const RUN_OUTCOMES = Object.freeze([
  ...new Set([...ERROR_CODES, ...REMEDIATION_CODES, 'verified', 'not-verified', 'cancelled-by-user']),
]);

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
  'NewTabNoteRecovery',
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
  // Where a legacy plaintext secret is kept (Credentials): the two chrome.storage.local keys,
  // named, never their values. The legacy IndexedDB one is the `settings` store above.
  'setting_llmApiKey',
  'setting_syncWebdavConfig',
]);
