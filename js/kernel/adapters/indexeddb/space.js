/**
 * The space check before a recovery point (#17, "Recovery points", Q6): there's enough room
 * when the free space `navigator.storage.estimate()` reports is at least twice the measured
 * size of the stores the point copies, plus 64 MB. Short of that, nothing is copied and
 * nothing migrates (migrate.js answers `space-blocked`), the build keeps running on the shape
 * it found, and capture is never gated on it. A point the disk runs out of room for anyway is
 * dropped (Q7), since it never verified.
 */

/** The margin on top of twice the copy (Q6) */
export const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * navigator.storage.estimate, or anything with its answer
 * @typedef {() => Promise<{quota?: number, usage?: number}>} Estimate
 */

/**
 * @typedef {{status: 'enough' | 'short', need: number, free: number} | {status: 'unknown', need: number}} SpaceCheck
 */

/**
 * Whether there's room to copy `bytes`. `unknown` when the estimate can't be read, which isn't
 * short: the copy goes ahead, and a disk that fills up drops the point.
 * @param {{estimate?: Estimate | null, bytes: number}} options
 * @returns {Promise<SpaceCheck>}
 */
export async function checkSpace({ estimate, bytes }) {
  const need = 2 * bytes + SPACE_MARGIN_BYTES;
  if (typeof estimate !== 'function') return { status: 'unknown', need };
  /** @type {{quota?: number, usage?: number}} */
  let reported;
  try {
    reported = await estimate();
  } catch {
    return { status: 'unknown', need };
  }
  const { quota, usage } = reported || {};
  if (typeof quota !== 'number' || typeof usage !== 'number' || !Number.isFinite(quota) || !Number.isFinite(usage)) {
    return { status: 'unknown', need };
  }
  const free = Math.max(0, quota - usage);
  return { status: free >= need ? 'enough' : 'short', need, free };
}
