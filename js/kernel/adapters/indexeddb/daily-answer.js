/**
 * Logical 3's answer while its batches run (#17 PR 3b; transforms.js), as `meta` keeps it under
 * TRANSFORM_DAILY_KEY until the step's receipt, and what a Daily Note lookup reads of it in its
 * own transaction (#17 PR 4a, F10), so a lookup between two batches finds what the run, once
 * done, will have the notes say. The transforms write it; #17's adapter only reads it.
 */

/** `meta`'s record of logical 3's answer while its batches run */
export const TRANSFORM_DAILY_KEY = 'transform-daily';

/** @typedef {import('../../core/domain/daily.js').DailyAssignment} DailyAssignment */

/**
 * Logical 3's answer, as `meta` keeps it: each Daily Note's id, key, holder when another holds
 * it, and whether it moves to its local date, and the zone the run took local dates in
 * @typedef {{key: typeof TRANSFORM_DAILY_KEY, zone: string, assignments: Array<[string, string, string | null, boolean]>}} TransformDaily
 */

/**
 * The answer `record` keeps, by note id, or null for none: no run of logical 3's is in progress,
 * or the record isn't one
 * @param {unknown} record - what `meta` holds under TRANSFORM_DAILY_KEY
 * @returns {Map<string, DailyAssignment> | null}
 */
export function answerOf(record) {
  const kept = /** @type {Partial<TransformDaily> | null | undefined} */ (record);
  if (!kept || typeof kept !== 'object' || !Array.isArray(kept.assignments)) return null;
  return new Map(
    kept.assignments.map(([id, dailyKey, duplicateOf, rekeyed]) => [id, { dailyKey, duplicateOf, rekeyed }]),
  );
}
