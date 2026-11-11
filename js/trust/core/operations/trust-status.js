/**
 * trust.status, catalog version 1 (#280's probe): what the new tab's status lines read over #13's
 * port, trust.summary narrowed with each group's count of the problems that lead
 * (status-message.js, narrowStatus). Its data is checked by statusFrom, the check the lines run on
 * the worker message's answer: exactly the fields narrowStatus gives, each a value this build
 * registers, so no key the sender chose passes.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { queryPayload } from '../../../kernel/core/contracts/operation.js';
import { queryStateSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { statusFrom } from '../status-message.js';

export const payload = queryPayload('trust.status', {});

/** A status the lines read in full, as statusFrom takes one */
export const statusSchema = v.custom(value => statusFrom(value) !== null);

export const result = queryStateSchema(statusSchema);
