/**
 * The diagnostic report (#20, "Security and privacy"; approved: "diagnostics never upload
 * without explicit, scoped consent"): `newtabnote-diagnostics-<date>.json`, with the
 * extension, browser, and schema versions, migration receipts, and the latest receipts,
 * incidents, run outcomes, and journal events, and nothing else. Every record in it went
 * through its schema when it was stored, and the whole report goes through the report schema
 * here, a strict one, so a field nobody listed can't reach the file.
 *
 * Its preview lists every field the file holds, by path, with its value, so what the user
 * reads before saving is exactly what's saved. Saving it is slice 4's view, locally only.
 */

import * as v from '../../lib/valibot/index.mjs';
import { encodedBytes } from '../../kernel/core/contracts/codec.js';
import { code, count, timestamp } from '../../kernel/core/contracts/fields.js';
import { dottedVersion, opaqueId } from './evidence.js';
import { REJECTION_REASONS } from './journal.js';
import { incidentSchema, journalEventSchema, receiptSchema, runSchema } from './records.js';

/** @typedef {import('./trust-records.js').TrustRecords} TrustRecords */
/** @typedef {import('./journal.js').DiagnosticJournal} DiagnosticJournal */
/** @typedef {import('./ports.js').Clock} Clock */
/** @typedef {import('./operations/diagnostics-export.js').DiagnosticsExported} DiagnosticsExported */

const schemaVersion = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/**
 * What the root knows about the build and the browser: the extension's version from its
 * manifest, the browser's major and full version when it can read them, and the schema
 * versions of CanvasTabDB (#17) and NewTabNoteTrust
 */
export const versionsSchema = v.strictObject({
  extension: dottedVersion,
  browser: v.nullable(dottedVersion),
  canvasSchema: schemaVersion,
  trustSchema: schemaVersion,
});

/** @typedef {v.InferOutput<typeof versionsSchema>} Versions */

/** One migration receipt (#17 slice 2 writes them; none exist before it) */
export const migrationSchema = v.strictObject({
  id: opaqueId,
  fromVersion: count,
  toVersion: count,
  at: timestamp,
  outcome: code,
});

/** @typedef {v.InferOutput<typeof migrationSchema>} MigrationReceipt */

export const reportSchema = v.strictObject({
  format: v.literal('newtabnote-diagnostics'),
  formatVersion: v.literal(1),
  createdAt: timestamp,
  installId: opaqueId,
  versions: versionsSchema,
  records: v.picklist(['closed', 'open', 'fallback']),
  recordsFailure: v.nullable(code),
  migrations: v.array(migrationSchema),
  receipts: v.array(receiptSchema),
  incidents: v.array(incidentSchema),
  runs: v.array(runSchema),
  journal: v.array(journalEventSchema),
  rejected: v.strictObject(
    /** @type {Record<import('./journal.js').RejectionReason, typeof count>} */ (
      Object.fromEntries(REJECTION_REASONS.map(reason => [reason, count]))
    ),
  ),
});

/** @typedef {v.InferOutput<typeof reportSchema>} DiagnosticReport */

/**
 * Every leaf of `value`, by its dotted path, in the order JSON.stringify writes them
 * @param {unknown} value
 * @param {string} [at]
 * @returns {{field: string, value: string | number | boolean | null}[]}
 */
export function leaves(value, at = '') {
  if (value === null || typeof value !== 'object') {
    return [{ field: at, value: /** @type {string | number | boolean | null} */ (value) }];
  }
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  return entries.flatMap(([key, item]) => (item === undefined ? [] : leaves(item, at ? `${at}.${key}` : key)));
}

/**
 * Builds the report and its preview
 * @param {{
 *   records: TrustRecords,
 *   journal: DiagnosticJournal,
 *   clock: Clock,
 *   versions: Versions,
 *   migrations?: () => Promise<readonly MigrationReceipt[]>,
 * }} options
 * @returns {Promise<DiagnosticsExported>}
 */
export async function buildDiagnostics({ records, journal, clock, versions, migrations = async () => [] }) {
  const now = clock.now();
  const [installId, receipts, incidents, runs, events, migrated] = await Promise.all([
    records.installId(),
    records.latestReceipts(),
    records.incidents(),
    records.runs(),
    records.events(),
    migrations(),
  ]);
  const report = v.parse(reportSchema, {
    format: 'newtabnote-diagnostics',
    formatVersion: 1,
    createdAt: now,
    installId,
    versions,
    records: records.state(),
    recordsFailure: records.failureCode(),
    migrations: [...migrated],
    receipts,
    incidents,
    runs,
    journal: events,
    rejected: journal.rejected(),
  });
  const serialized = JSON.stringify(report, null, 2);
  const preview = leaves(JSON.parse(serialized));
  return {
    kind: 'diagnostics',
    filename: `newtabnote-diagnostics-${new Date(now).toISOString().slice(0, 10)}.json`,
    bytes: encodedBytes(serialized),
    preview,
    serialized,
  };
}
