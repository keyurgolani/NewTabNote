/**
 * What slice 2's health providers read (#20, "Providers"): the ports a composition root puts in
 * the registry context, each one a provider names, and the helpers every check shares. A
 * provider reads only the ports it names here, so a check that finds its port missing throws,
 * and checks.js records that as `unverified`: nothing was verified, which is never a failure
 * and never a pass.
 *
 * No port hands a provider a secret. Credentials asks a reader that answers present or absent
 * (js/kernel/adapters/indexeddb/legacy-secrets.js), and the legacy facts read only the keys
 * legacy.js lists, none of which holds a credential.
 */

import { ERROR_CODES } from '../codes.js';
import { FAIL_CAUSES } from '../../../kernel/core/contracts/outcomes.js';

/** @typedef {import('../../../kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../../kernel/core/ports/commit-log.js').CommitLog} CommitLog */
/** @typedef {import('../../../kernel/registry/resolve.js').Resolution} Resolution */
/** @typedef {import('../ports.js').SettingsPort} SettingsPort */

/**
 * A pipeline that consumes #17's commit feed, with the checkpoint it has applied up to and how
 * far behind the head it may be before it's lagging (#22 registers them)
 * @typedef {{id: string, windowSeq: number, checkpoint(): Promise<number>}} Pipeline
 */

/**
 * What recovery readiness reads of #17's recovery points: each point's kind, status, and
 * times, never a row (js/kernel/adapters/indexeddb/health.js)
 * @typedef {{id: string, kind: string, status: string, createdAt: number, verifiedAt: number | null}} PointSummary
 */

/**
 * @typedef {object} RecoveryReader
 * @property {() => Promise<PointSummary[]>} points - every point, none when NewTabNoteRecovery doesn't exist
 * @property {(pointId: string) => Promise<{ok: true} | {ok: false, code: string}>} verify
 *   Reads the point back and matches it, writing nothing (#17's verifyPoint)
 */

/**
 * Where a legacy plaintext secret was found: the chrome.storage.local AI key, the WebDAV
 * password in chrome.storage.local, or the AI key in the legacy IndexedDB `settings` store
 * @typedef {'setting_llmApiKey' | 'setting_syncWebdavConfig' | 'settings'} SecretSource
 */

/**
 * @typedef {object} SecretReader
 * @property {() => Promise<readonly SecretSource[]>} present
 *   The sources holding a non-empty secret, never the secret
 */

/**
 * chrome.permissions, or anything with its promise-returning getAll
 * @typedef {{getAll(): Promise<{permissions?: string[], origins?: string[]}>}} PermissionsReader
 */

/**
 * The manifest fields that decide permissions, as chrome.runtime.getManifest() answers them
 * @typedef {{permissions?: string[], optional_permissions?: string[], host_permissions?: string[], optional_host_permissions?: string[], chrome_url_overrides?: Record<string, string>, version?: string}} ManifestPermissions
 */

/**
 * #13's client, or anything with its query
 * @typedef {{query(query: {type: string} & Record<string, unknown>): Promise<import('../../../kernel/core/contracts/outcomes.js').QueryState<unknown>>}} MessagingClient
 */

/**
 * The trust records a provider may read: the journal's events, which slice 1b's failure sites
 * write, and whether NewTabNoteTrust takes writes (`fallback` while it doesn't). No provider
 * reads incidents: a check decides from evidence, never from what an earlier check raised.
 * @typedef {{eventsRead(): Promise<{events: readonly import('../records.js').JournalEvent[], ok: boolean}>, state?: () => string}} TrustReader
 */

/**
 * The registry context slice 2's providers read. Each is optional here, since a root passes
 * only what its host has; a provider whose port is missing can't verify.
 * @typedef {object} ProviderContext
 * @property {KernelAdapter} [storage]
 *   The repository adapter on the path capture uses, which capture and storage probe: #17's
 *   `existing` open below the latest version (the worker's, since PR 1b), `versioned` at it
 * @property {{read(): Promise<{version: number, latest: number, status: string | null, code: string | null}>}} [migration]
 *   CanvasTabDB's version, the latest, and the worker's last recorded run, for storage below 9
 * @property {SettingsPort} [settings] - chrome.storage.local, for the legacy facts legacy.js lists
 * @property {SecretReader} [secrets]
 * @property {RecoveryReader} [recovery]
 * @property {{stored(): Promise<boolean>, newerThan(at: number): Promise<boolean>}} [vectors]
 *   Whether CanvasTabDB's `vectors` store holds a record, and whether one was written (its
 *   `updatedAt`) after `at`
 * @property {PermissionsReader} [permissions]
 * @property {ManifestPermissions} [manifest]
 * @property {CommitLog} [commitLog]
 * @property {readonly Pipeline[]} [pipelines]
 *   Every pipeline the root registered, an empty list for none. A root that couldn't build the
 *   list must throw from it or leave the port out, never pass `[]`: index lag can't tell none
 *   from failed.
 * @property {MessagingClient} [messaging]
 * @property {() => readonly Resolution[]} [resolutions]
 *   Each registry root's resolution, or its runtime's snapshot. A root that couldn't resolve
 *   must throw from it, never answer `[]`: contributions can't tell none from failed.
 * @property {TrustReader} [trust]
 */

/**
 * The port `name` from `context`, or a throw that names only the port, so the check records
 * `unverified`
 * @template {keyof ProviderContext} K
 * @param {Readonly<Record<string, unknown>>} context
 * @param {K} name
 * @returns {NonNullable<ProviderContext[K]>}
 */
export function portOf(context, name) {
  const port = /** @type {ProviderContext} */ (context)[name];
  if (port === undefined || port === null) throw new TypeError(`no ${name} port`);
  return /** @type {NonNullable<ProviderContext[K]>} */ (port);
}

/**
 * What an `unavailable` outcome or a failed query state says, as evidence: its cause, and its
 * code when codes.js registers it. Nothing else of it, so no message reaches a receipt.
 * @param {{cause?: unknown, code?: unknown}} answer
 * @returns {{cause?: string, errorCode?: string}}
 */
export function failureEvidence({ cause, code }) {
  /** @type {{cause?: string, errorCode?: string}} */
  const evidence = {};
  if (typeof cause === 'string' && /** @type {readonly string[]} */ (FAIL_CAUSES).includes(cause)) evidence.cause = cause;
  if (typeof code === 'string' && ERROR_CODES.includes(code)) evidence.errorCode = code;
  return evidence;
}

/**
 * Whether `value` is a time a receipt can hold: a non-negative safe integer
 * @param {unknown} value
 * @returns {value is number}
 */
export const isTime = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
