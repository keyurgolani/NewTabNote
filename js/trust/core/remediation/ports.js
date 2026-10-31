/**
 * What the remediation pipeline and its remediations take from their host (#20, "Remediation
 * pipeline"). Core reads no browser API, so a composition root passes these in, each from the
 * adapter named beside it, and a test passes fakes. A remediation that needs a port its root
 * didn't pass answers `not-applicable` and changes nothing.
 */

/** @typedef {import('../../../kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../vocabulary.js').ProviderStatus} ProviderStatus */

/**
 * Web Locks with `ifAvailable`, as navigator.locks has it: the callback gets null when another
 * context holds the lock, and the lock is held until the callback's promise settles
 * @typedef {{request: <T>(name: string, options: {ifAvailable: true}, callback: (lock: unknown) => Promise<T>) => Promise<T>}} RunLocks
 */

/**
 * The save picker (js/kernel/adapters/files/save-picker.js): showSaveFilePicker, a closed
 * write, and the same handle read back
 * @typedef {object} FilePort
 * @property {() => boolean} available
 * @property {(options: {suggestedName: string}) => Promise<unknown>} pick - null when the user cancelled
 * @property {(handle: any, parts: Iterable<string>) => Promise<void>} write - writes each part as it comes, and resolves once close() has
 * @property {(handle: any) => Promise<string>} read
 */

/**
 * #17's `pre-repair` points (js/kernel/adapters/indexeddb/repair-points.js)
 * @typedef {object} RecoveryPointPort
 * @property {(options: {holds?: Readonly<Record<string, readonly string[]>>}) => Promise<{ok: true, pointId: string, verifiedAt: number} | {ok: false, code: string}>} make
 * @property {(pointId: string) => Promise<boolean>} verify
 */

/**
 * What the salvage file and Save as file read (js/kernel/adapters/indexeddb/salvage-reader.js)
 * @typedef {object} SalvagePort
 * @property {() => Promise<import('./salvage-file.js').SalvageRead>} collect
 * @property {(subjectId: string) => Promise<import('./salvage-file.js').RestorePointRead | null>} restorePoint
 * @property {(subjectId: string) => Promise<boolean>} has - whether that restore point is there, read without its rows
 */

/**
 * The storage a retry opens again: CanvasTabDB's connection, or NewTabNoteTrust's records
 * @typedef {{reopen: () => Promise<{ok: true} | {ok: false, code: string}>}} StoragePort
 */

/**
 * Runs the named providers' checks now and answers each one's status as its receipt reads
 * after: trust.verify with `verify-now`, over the records (pipeline.js's providerChecks)
 * @typedef {(providerIds: readonly string[]) => Promise<Record<string, ProviderStatus>>} ProviderChecks
 */

/**
 * @typedef {object} RemediationPorts
 * @property {KernelAdapter} [adapter] - #17's IndexedDB adapter over CanvasTabDB, or the memory one
 * @property {FilePort} [files]
 * @property {RecoveryPointPort} [recoveryPoints]
 * @property {SalvagePort} [salvage]
 * @property {StoragePort} [storage]
 * @property {ProviderChecks} [checks]
 */

export {};
