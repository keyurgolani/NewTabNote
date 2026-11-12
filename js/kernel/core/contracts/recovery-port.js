/**
 * What recovery.html sends the service worker over #13's port (#35 slice 8): rebuild-index's
 * batches, and Capture's and Storage's probes, which the worker's queue runs on its kernel for
 * `recovery`. Neither the shared catalog nor the worker's part lists them, so no other page's
 * start moves: the worker's router takes each
 * by its policy row (ports/policy.js), from recovery.html alone, and the worker's kernel for
 * recovery.html runs on this module's catalog (core/application/handlers-worker.js). Only the
 * worker and recovery.html load it, with the schemas.
 */

import { commandEntry } from './commands.js';
import * as probeCommitOperation from './operations/probe-commit.js';
import * as rebuildSearchIndexOperation from './operations/rebuild-search-index.js';

/** @typedef {import('./commands.js').CommandEntry} CommandEntry */
/** @typedef {import('./commands.js').Catalog} Catalog */
/** @typedef {import('./surfaces.js').Surface} Surface */
/** @typedef {import('./validate.js').Operation} Operation */
/** @typedef {import('../ports/policy.js').PolicyRow} PolicyRow */

/** recovery.html, as #13's runtime port names it, the one surface each of these is sent from */
const recovery = () => /** @type {Surface[]} */ (['recovery']);

/** @type {Readonly<Record<'rebuildSearchIndex' | 'probeCommit', CommandEntry>>} */
export const RECOVERY_PORT_COMMANDS = Object.freeze({
  // The search entries of up to a hundred notes, written again from their blocks (#20's rebuild-index)
  rebuildSearchIndex: commandEntry('rebuild-search-index', 'index', recovery(), { entityTypes: ['note'] }),
  // Capture's or Storage's check, on the path a capture commits on (#20's providers), changing no entity
  probeCommit: commandEntry('probe-commit', 'system', recovery(), { entityTypes: [] }),
});

/** @type {Catalog} the catalog the worker's kernel for recovery.html runs on: these, and no query */
export const RECOVERY_PORT_CATALOG = Object.freeze({ commands: RECOVERY_PORT_COMMANDS, queries: Object.freeze({}) });

/** @type {Readonly<Record<string, Operation>>} each as the routers and clients find it (messaging/operations.js) */
export const RECOVERY_PORT_OPERATIONS = Object.freeze({
  rebuildSearchIndex: Object.freeze({
    entry: RECOVERY_PORT_COMMANDS.rebuildSearchIndex,
    payload: rebuildSearchIndexOperation.payload,
    result: rebuildSearchIndexOperation.result,
  }),
  probeCommit: Object.freeze({
    entry: RECOVERY_PORT_COMMANDS.probeCommit,
    payload: probeCommitOperation.payload,
    result: probeCommitOperation.result,
  }),
});

/** @type {Readonly<Record<string, PolicyRow>>} the worker's router's row for each: recovery.html's alone */
export const RECOVERY_PORT_ROWS = Object.freeze({
  rebuildSearchIndex: Object.freeze({ surfaces: RECOVERY_PORT_COMMANDS.rebuildSearchIndex.surfaces }),
  probeCommit: Object.freeze({ surfaces: RECOVERY_PORT_COMMANDS.probeCommit.surfaces }),
});
