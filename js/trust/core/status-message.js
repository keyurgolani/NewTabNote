/**
 * The status read (#20 slice 4c): the one message the new tab sends the worker for what its
 * sidebar line and Settings' Trust Center lines say, and Popup's and the Side Panel's cards will
 * send for theirs, and its answer: trust.summary narrowed to what those lines and cards read. It's
 * one of the worker's own messages (js/background.js, installWorkerNetwork's ownHandlers), not a
 * query over #13's port, so a page that sends it loads neither Valibot nor #13's client: with
 * both, the new tab's typical heap read 3.52 MiB in CI's perf job, over its 3.28.
 *
 * So no schema checks the answer, and the page checks it here by hand (statusFrom), against the
 * groups and codes this build registers: anything else, such as a worker of another build's, is
 * no answer, and the page draws nothing.
 *
 * It imports only the vocabulary and the codes, which import nothing.
 */

import { ERROR_CODES, FAULT_CODES, PROVIDER_IDS } from './codes.js';
import { HEALTH_GROUPS, SEVERITIES } from './vocabulary.js';

/** @typedef {import('./operations/trust-summary.js').TrustSummary} TrustSummary */

/**
 * A group's cause, as a line or card reads it: an incident's provider, fault, error and severity,
 * or a receipt's provider, error and consequence
 * @typedef {object} StatusCause
 * @property {'incident' | 'receipt'} from
 * @property {string} providerId
 * @property {string | null} faultCode
 * @property {string | null} errorCode
 * @property {string | null} severity
 * @property {string | null} consequenceKey
 */

/**
 * What a status line or card reads of trust.summary
 * @typedef {object} TrustStatus
 * @property {'safe' | 'at-risk' | 'unknown'} capture
 * @property {'trust' | 'recovery'} route
 * @property {'closed' | 'open' | 'fallback'} records
 * @property {Array<{group: string, needsAction: number, checkedAt: number | null, cause: StatusCause | null}>} groups
 */

/**
 * The message's type, which no other message of the worker's takes. The new tab's ask repeats it
 * (js/kernel/composition/trust-status-ask.js), since its chunk loads no trust code.
 */
export const TRUST_STATUS_MESSAGE = 'trust.status';

const CAPTURES = Object.freeze(['safe', 'at-risk', 'unknown']);
const ROUTES = Object.freeze(['trust', 'recovery']);
const RECORDS = Object.freeze(['closed', 'open', 'fallback']);
const FROM = Object.freeze(['incident', 'receipt']);
const STATUS_KEYS = Object.freeze(['capture', 'route', 'records', 'groups']);
const GROUP_KEYS = Object.freeze(['group', 'needsAction', 'checkedAt', 'cause']);
const CAUSE_KEYS = Object.freeze(['from', 'providerId', 'faultCode', 'errorCode', 'severity', 'consequenceKey']);

/** A consequence key, `<group>.<code>`, as the records' schema takes one (records.js) */
const CONSEQUENCE_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * trust.summary narrowed to what a status line or card reads
 * @param {TrustSummary} summary
 * @returns {TrustStatus}
 */
export function narrowStatus(summary) {
  return {
    capture: summary.capture,
    route: summary.route,
    records: summary.records,
    groups: summary.groups.map(({ group, needsAction, checkedAt, cause }) => ({
      group,
      needsAction,
      checkedAt,
      cause: cause
        ? {
            from: cause.from,
            providerId: cause.providerId,
            faultCode: cause.faultCode,
            errorCode: cause.errorCode,
            severity: cause.severity,
            consequenceKey: cause.consequenceKey,
          }
        : null,
    })),
  };
}

/**
 * Whether `value` is a plain object with exactly `keys`
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function exactly(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Whether `value` is one of `list`, or null where `nullable`
 * @param {unknown} value
 * @param {readonly unknown[]} list
 * @param {boolean} [nullable]
 */
const oneOf = (value, list, nullable = false) => (nullable && value === null) || list.includes(value);

/**
 * A time: a whole, non-negative number of milliseconds
 * @param {unknown} value
 */
const isTime = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The cause in `value`, or undefined when it isn't one this build reads
 * @param {unknown} value
 * @returns {StatusCause | null | undefined}
 */
function causeFrom(value) {
  if (value === null) return null;
  if (!exactly(value, CAUSE_KEYS)) return undefined;
  const { from, providerId, faultCode, errorCode, severity, consequenceKey } = value;
  if (!oneOf(from, FROM) || !oneOf(providerId, PROVIDER_IDS)) return undefined;
  if (!oneOf(faultCode, FAULT_CODES, true) || !oneOf(errorCode, ERROR_CODES, true)) return undefined;
  if (!oneOf(severity, SEVERITIES, true)) return undefined;
  if (
    consequenceKey !== null &&
    !(typeof consequenceKey === 'string' && consequenceKey.length <= 80 && CONSEQUENCE_KEY.test(consequenceKey))
  ) {
    return undefined;
  }
  return /** @type {StatusCause} */ ({ from, providerId, faultCode, errorCode, severity, consequenceKey });
}

/**
 * The status in `answer`, the worker's to the status read, when it's one this build reads in
 * full: exactly the fields narrowStatus gives, each a value this build registers, each group
 * once. Null for anything else, which a page draws nothing for.
 * @param {unknown} answer
 * @returns {TrustStatus | null}
 */
export function statusFrom(answer) {
  if (!exactly(answer, STATUS_KEYS)) return null;
  const { capture, route, records, groups } = answer;
  if (!oneOf(capture, CAPTURES) || !oneOf(route, ROUTES) || !oneOf(records, RECORDS)) return null;
  if (!Array.isArray(groups) || groups.length > HEALTH_GROUPS.length) return null;
  /** @type {TrustStatus['groups']} */
  const read = [];
  for (const item of groups) {
    if (!exactly(item, GROUP_KEYS)) return null;
    const { group, needsAction, checkedAt } = item;
    if (!oneOf(group, HEALTH_GROUPS) || read.some(seen => seen.group === group)) return null;
    if (!isTime(needsAction) || !(checkedAt === null || isTime(checkedAt))) return null;
    const cause = causeFrom(item.cause);
    if (cause === undefined) return null;
    read.push({
      group: /** @type {string} */ (group),
      needsAction: /** @type {number} */ (needsAction),
      checkedAt: /** @type {number | null} */ (checkedAt),
      cause,
    });
  }
  return {
    capture: /** @type {TrustStatus['capture']} */ (capture),
    route: /** @type {TrustStatus['route']} */ (route),
    records: /** @type {TrustStatus['records']} */ (records),
    groups: read,
  };
}
