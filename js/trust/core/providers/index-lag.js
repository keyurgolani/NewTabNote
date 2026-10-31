/**
 * Index and derived data (#20, "Providers"): for each pipeline that consumes #17's commit
 * feed, its lag, the feed's head `seq` minus the checkpoint the pipeline has applied up to,
 * read now from both. It's `degraded` once a pipeline is further behind than its declared
 * window, with one `lagging` incident, `degraded` and `stalled` once a checkpoint is past the
 * head (the log was replaced, so it must resync), and `not-configured` while no pipeline is registered,
 * which is every profile until #22 registers its projections and #17's PR 2 makes the feed
 * durable. #22's per-projection providers then report the pipelines they own, and this one
 * keeps the rest.
 */

import { portOf } from './context.js';

/** @typedef {import('../checks.js').CheckResult} CheckResult */

/**
 * @param {unknown} value
 * @returns {number}
 */
const position = value => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('not a commit position');
  return value;
};

/** What it looked at once the head and every checkpoint were read */
const LOOKED = () => [{ faultCode: 'lagging', subjectId: null }, { faultCode: 'stalled', subjectId: null }];

export const indexLag = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {Promise<CheckResult>}
   */
  async check(context) {
    // A root with no pipelines passes an empty list; one that passes none can't say
    const pipelines = /** @type {unknown} */ (portOf(context, 'pipelines'));
    if (!Array.isArray(pipelines)) throw new TypeError('not a list of pipelines');
    if (pipelines.length === 0) return { status: 'not-configured', evidence: { records: 0 }, looked: LOOKED() };
    const head = position(await portOf(context, 'commitLog').head());
    let lag = 0;
    let lagging = 0;
    let ahead = 0;
    for (const pipeline of pipelines) {
      const checkpoint = position(await pipeline.checkpoint());
      // Past the head, as when the log was replaced under it: the pipeline has to resync
      // (ports/commit-log.js's `resync-required`), so it's applying nothing now
      if (checkpoint > head) {
        ahead += 1;
        continue;
      }
      const behind = head - checkpoint;
      lag = Math.max(lag, behind);
      if (behind > pipeline.windowSeq) lagging += 1;
    }
    const evidence = { records: pipelines.length, lag, ...(head > 0 ? { seq: head } : {}) };
    // Every pipeline was read, so both faults were looked for; each one that applies is
    // reported, so a stalled pipeline never resolves another one's lag
    const looked = LOOKED();
    /** @type {NonNullable<CheckResult['faults']>} */
    const faults = [];
    const kept = /** @type {const} */ (['capture', 'editing', 'reading']);
    if (ahead > 0) faults.push({ faultCode: 'stalled', subjectId: null, severity: 'degraded', affected: ['search'], preserved: [...kept] });
    if (lagging > 0) faults.push({ faultCode: 'lagging', subjectId: null, severity: 'degraded', affected: ['search'], preserved: [...kept] });
    if (faults.length === 0) return { status: 'verified', evidence, looked };
    return {
      status: 'degraded',
      evidence: { ...evidence, count: ahead + lagging },
      consequenceKey: ahead > 0 ? 'indexing.resync-required' : 'indexing.lagging',
      preserved: [...kept],
      faults,
      looked,
    };
  },
});
