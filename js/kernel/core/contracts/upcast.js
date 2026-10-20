/**
 * Journal upcasting (#13, "Handshake and compatibility"). A journal entry's `v` is the catalog
 * version of the command it holds, as it was when the entry was written. At replay #35
 * (background coordinator) upcasts that command to the catalog's current version with
 * upcastJournalEntry, then sends it. The journal record's schema stays #17's: this reads only
 * the entry's `v` and the command #17's journal client takes out of it.
 *
 * Each command type's steps go from one version to the next, and the chain runs from the
 * entry's version to the current one. The result must pass the current version's schema. An
 * entry with no path there (a version a newer build wrote, or a step missing) or whose command
 * doesn't pass is refused with a transport code, and #35 turns it into a #17 conflict record
 * and a #20 incident: an entry is never dropped. Every command is at version 1, so there are
 * no steps yet, and the PR that moves a command to version 2 adds its step here.
 */

import { isRecord } from './checks.js';
import { check } from './validate.js';

/** @typedef {import('./validate.js').Operation} Operation */
/** @typedef {import('./validate.js').Issue} Issue */
/** @typedef {import('./transport-codes.js').TransportCode} TransportCode */

/**
 * One step: the command at a version, as the next version has it. A step keeps the command's
 * type and commandId, which name it in the journal and the idempotency ledger.
 * @typedef {(command: Readonly<Record<string, unknown>>) => Record<string, unknown>} UpcastStep
 */

/**
 * Each command type's steps, keyed by the version a step upcasts from
 * @typedef {Readonly<Record<string, Readonly<Record<number, UpcastStep>>>>} Upcasters
 */

/** @type {Upcasters} */
export const JOURNAL_UPCASTERS = Object.freeze({});

/**
 * @typedef {{ok: true, command: Record<string, unknown>}
 *   | {ok: false, code: TransportCode, issues: Issue[]}} Upcast
 */

/**
 * The command a journal entry holds, at the catalog's current version.
 * @param {{v: unknown, command: unknown}} entry - the entry's catalog version, and its command as written
 * @param {(name: string) => Operation | undefined} lookup - the operations the router knows
 * @param {Upcasters} [upcasters]
 * @returns {Upcast}
 */
export function upcastJournalEntry({ v, command }, lookup, upcasters = JOURNAL_UPCASTERS) {
  /**
   * @param {TransportCode} code
   * @param {Issue[]} [issues]
   * @returns {Upcast}
   */
  const refuse = (code, issues = []) => ({ ok: false, code, issues });
  if (!Number.isSafeInteger(v) || /** @type {number} */ (v) < 1) return refuse('invalid-payload');
  if (!isRecord(command) || typeof command.type !== 'string') return refuse('invalid-payload');
  const operation = lookup(command.type);
  // A query is never journaled
  if (!operation || operation.entry.kind !== 'command') return refuse('unknown-operation');
  const { type, commandId } = command;
  const steps = Object.hasOwn(upcasters, type) ? upcasters[type] : {};
  /** @type {Record<string, unknown>} */
  let current = command;
  for (let version = /** @type {number} */ (v); version < operation.entry.version; version++) {
    if (!Object.hasOwn(steps, version)) return refuse('unsupported-version');
    try {
      current = steps[version](current);
    } catch {
      return refuse('invalid-payload');
    }
    if (!isRecord(current) || current.type !== type || current.commandId !== commandId) {
      return refuse('invalid-payload');
    }
  }
  // A version newer than the catalog's has no path back
  if (/** @type {number} */ (v) > operation.entry.version) return refuse('unsupported-version');
  const checked = check(operation.payload, current);
  if (!checked.ok) return refuse('invalid-payload', checked.issues);
  return { ok: true, command: current };
}
