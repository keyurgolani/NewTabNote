/**
 * The shape every operation's payload schema shares (#13, "Validation"): a command carries its
 * `type` and its `commandId`, and a query its `type`, then the fields it declares and nothing
 * else, so a field a schema doesn't declare can't carry content past it.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { id } from './fields.js';

/**
 * A command's payload: `type`, `commandId`, and `entries`
 * @template {string} T
 * @template {v.ObjectEntries} E
 * @param {T} type
 * @param {E} entries
 */
export const commandPayload = (type, entries) => v.strictObject({ type: v.literal(type), commandId: id, ...entries });

/**
 * A query's payload: `type` and `entries`
 * @template {string} T
 * @template {v.ObjectEntries} E
 * @param {T} type
 * @param {E} entries
 */
export const queryPayload = (type, entries) => v.strictObject({ type: v.literal(type), ...entries });
