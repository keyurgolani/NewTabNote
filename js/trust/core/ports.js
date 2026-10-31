/**
 * What js/trust/core/ takes from its host (#20, "Records"): the trust store, the settings
 * area its fallback and install id live in, Web Locks, the time, timers, and new ids. Core
 * reads no browser API, so a composition root passes these in: #17's NewTabNoteTrust adapter
 * (js/kernel/adapters/indexeddb/trust.js) or the memory store (memory-store.js),
 * chrome.storage.local, navigator.locks, and crypto.randomUUID.
 *
 * The trust store keeps #17's transaction rules: a unit runs in one transaction over the
 * stores it names and awaits nothing but that transaction, a write answers only once the
 * transaction commits, a unit that throws aborts it so nothing it wrote commits, and a
 * transient abort runs once more.
 */

/**
 * The stores of NewTabNoteTrust, and the indexes each has:
 * - receipts (key `id`): `providerId`, `verifiedAt`
 * - incidents (key `id`): `key` (unique), `state`
 * - runs (key `id`): `startedAt`
 * - journal (key `seq`, assigned in order): `at`
 * @typedef {'receipts' | 'incidents' | 'runs' | 'journal'} TrustStoreName
 */

/** @typedef {string | number} TrustKey */

/**
 * One unit's view of its transaction. Reads resolve in the transaction; writes are queued in
 * it and take effect when it commits. `keys` lists primary keys in ascending order of the
 * index (or the key) given, those below `below` only when it's given, `limit` at most.
 * @typedef {object} TrustTx
 * @property {(store: TrustStoreName, key: TrustKey) => Promise<any>} get
 * @property {(store: TrustStoreName) => Promise<any[]>} getAll
 * @property {(store: TrustStoreName, index: string, value: TrustKey) => Promise<any[]>} getAllByIndex
 * @property {(store: TrustStoreName) => Promise<number>} count
 * @property {(store: TrustStoreName, options?: {index?: string, below?: number, limit?: number}) => Promise<TrustKey[]>} keys
 * @property {(store: TrustStoreName, record: object) => void} put
 * @property {(store: 'journal', record: object) => Promise<number>} append - adds a journal event and resolves to its seq
 * @property {(store: TrustStoreName, key: TrustKey) => void} delete
 */

/**
 * Every promise a TrustStore answers settles: the adapter's open() answers within 5 seconds
 * (`open-pending` while it keeps connecting), and a transaction always completes or aborts.
 * The records hold the settings copy's lock across a write, so a store whose run never settled
 * would hold every context's writes behind it.
 * @typedef {object} TrustStore
 * @property {() => Promise<void>} open
 *   Opens the database at version 1. Rejects with an UnavailableError when it won't open.
 * @property {<T>(stores: readonly TrustStoreName[], mode: 'readonly' | 'readwrite', unit: (tx: TrustTx) => Promise<T>) => Promise<T>} run
 *   Runs `unit` in one transaction, and resolves to what it returned once the transaction
 *   commits. Rejects with an UnavailableError when the transaction aborts or the store isn't
 *   open, and with what the unit threw, after aborting it.
 * @property {() => void} close
 */

/**
 * chrome.storage.local, or anything with its promise-returning get and set. A set settles
 * (chrome.storage.local answers or fails); the records bound their reads of the settings copy
 * themselves when given timers, since a read is safe to give up on.
 * @typedef {object} SettingsPort
 * @property {(keys: string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/**
 * Web Locks, or anything with its request(name, callback)
 * @typedef {{request: <T>(name: string, callback: () => Promise<T>) => Promise<T>}} Locks
 */

/** @typedef {{now(): number}} Clock */

/** New random ids: crypto.randomUUID in a composition root */
/** @typedef {{next(): string}} Ids */

/** @typedef {{set(callback: () => void, ms: number): unknown, clear(handle: unknown): void}} Timers */

/**
 * The chrome.storage.local keys the Trust Center writes, both `diagnostic`: the latest storage
 * incident while NewTabNoteTrust won't open, and the random id that stamps receipts, written
 * once
 */
export const SETTINGS_KEYS = Object.freeze({
  lastStorageIncident: 'trust.lastStorageIncident',
  installId: 'trust.installId',
});
