/**
 * The Trust Center's two registry families on #15's kit (#20, "Contracts"):
 * - `health`: a HealthProvider, `{id, group, owner, operation, costClass, timeoutMs,
 *   freshnessMs, triggers, observes, check(), remediations}`. Its descriptor is the static
 *   data, and its implementation (a static `implementation` or a lazy `load`) holds `check()`,
 *   which answers a CheckResult (checks.js). `core` marks the providers capture depends on, the
 *   only ones that set a receipt's `capture`. `observes` lists the faults (codes.js) its check
 *   can see, possibly none: a check that answers, whatever its status, resolves the provider's
 *   open incidents for those faults that it no longer reports, and its check reports no other
 *   fault. An incident for a fault no check observes (a failure event's) resolves through a
 *   remediation's verify step or a later success event from the same site.
 * - `remediation`: a RemediationCommand, `{id, owner, class, appliesTo, preview(), apply(),
 *   verify()}`, whose implementation holds the three steps. Slice 3 runs them through the
 *   pipeline its class sets.
 *
 * Providers run in the page that asks until #35 schedules them, so both families run on the
 * `workspace` host; slice 4 adds #15's `recovery` host for recovery.html. Neither may ask for a
 * Chrome permission, an AI scope beyond metadata, or a destination: a provider reads what its
 * root injects, and a check never sends anything anywhere.
 */

import { defineFamily } from '../../kernel/registry/family.js';
import { isId } from '../../kernel/registry/ids.js';
import { FAULT_CODES } from './codes.js';
import { COST_CLASSES, HEALTH_GROUPS, REMEDIATION_CLASSES, REMEDIATION_GROUPS, TRIGGERS } from './vocabulary.js';

/** The longest a check may be given, and the longest a receipt stays fresh */
export const MAX_TIMEOUT_MS = 60_000;
export const MAX_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

/** A verification operation's code, as records.js's operationCode takes it */
const OPERATION = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){0,3}$/;

/**
 * @param {unknown} value
 * @param {number} max
 */
const isPositiveInteger = (value, max) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

/**
 * A list of `of`'s members, at least one when `min` is 1, each once
 * @param {unknown} value
 * @param {(item: unknown) => boolean} of
 * @param {number} [min]
 */
const isList = (value, of, min = 0) =>
  Array.isArray(value) && value.length >= min && value.length <= 32 && value.every(of) && new Set(value).size === value.length;

/** The issue that owns a contribution, as a number such as 17 */
const isOwner = (/** @type {unknown} */ value) => isPositiveInteger(value, 999);

export const health = defineFamily({
  id: 'health',
  apiVersion: 1,
  groups: HEALTH_GROUPS,
  hosts: ['workspace'],
  loader: 'required',
  fixtures: ['truthful-receipt'],
  fields: {
    owner: isOwner,
    operation: value => typeof value === 'string' && value.length <= 64 && OPERATION.test(value),
    costClass: value => typeof value === 'string' && /** @type {readonly string[]} */ (COST_CLASSES).includes(value),
    timeoutMs: value => isPositiveInteger(value, MAX_TIMEOUT_MS),
    freshnessMs: value => isPositiveInteger(value, MAX_FRESHNESS_MS),
    triggers: value => isList(value, item => typeof item === 'string' && /** @type {readonly string[]} */ (TRIGGERS).includes(item), 1),
    observes: value =>
      isList(value, item => typeof item === 'string' && /** @type {readonly string[]} */ (FAULT_CODES).includes(item)),
    remediations: value => value === undefined || isList(value, item => isId(item)),
    core: value => value === undefined || typeof value === 'boolean',
  },
});

export const remediation = defineFamily({
  id: 'remediation',
  apiVersion: 1,
  groups: REMEDIATION_GROUPS,
  hosts: ['workspace'],
  loader: 'required',
  fixtures: ['remediation-steps'],
  fields: {
    owner: isOwner,
    class: value => typeof value === 'string' && /** @type {readonly string[]} */ (REMEDIATION_CLASSES).includes(value),
    appliesTo: value => isList(value, item => isId(item), 1),
  },
});
