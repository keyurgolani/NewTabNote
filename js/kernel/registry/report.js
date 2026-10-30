/**
 * The resolution report (#15, "Kit" and "Security and privacy"): why each contribution is in
 * the state it's in, for advanced settings and the Trust Center to render. #20 (health)
 * exposes it as a kernel query with its first consumer. It's a pure function of a resolution,
 * or of a runtime's snapshot once probes and loaders have answered.
 *
 * A row holds the contribution's family, id (null for a malformed one with characters no id
 * has), and version, its state, the reason code, the
 * code-owned text for that reason and its remediation, whether it's privileged (it reaches a
 * destination, or an AI scope beyond `metadata`), and the refs a conflict or requirement is
 * about. Nothing else: no label, no field a family defines, no probe answer beyond its code,
 * and no error message, so no note content can reach it.
 */

import { reasonFor } from './reasons.js';

/**
 * The characters an id may have, loosely, so a malformed id still names its row when it's
 * close to one (`BadId`), and free text (`Bad Id`, a sentence) never reaches the report
 */
const ID_CHARACTERS = /^[A-Za-z0-9._/:-]{1,64}$/;

/** @typedef {import('./resolve.js').Resolution} Resolution */
/** @typedef {import('./reasons.js').State} State */

/**
 * @typedef {Readonly<{
 *   family: string,
 *   id: string | null,
 *   version: number | null,
 *   state: State,
 *   reason: string,
 *   message: string,
 *   remediation: string,
 *   privileged: boolean,
 *   related: readonly string[],
 * }>} ReportRow
 */

/**
 * One row per contribution, in the resolution's order
 * @param {Resolution} resolution
 * @returns {readonly ReportRow[]}
 */
export function resolutionReport(resolution) {
  const reasons = new Map(resolution.families.map(family => [family.id, family.reasons]));
  return Object.freeze(
    resolution.contributions.map(contribution => {
      const reason = reasonFor(reasons.get(contribution.family) ?? {}, contribution.reason);
      return Object.freeze({
        family: contribution.family,
        id:
          contribution.id ??
          (contribution.rawId !== null && ID_CHARACTERS.test(contribution.rawId) ? contribution.rawId : null),
        version: contribution.version,
        state: contribution.state,
        reason: contribution.reason,
        message: reason ? reason.message : '',
        remediation: reason ? reason.remediation : '',
        privileged: contribution.privileged,
        related: contribution.related,
      });
    }),
  );
}
