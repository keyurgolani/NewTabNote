// The kernel the tests build (#17 PR 4b): createKernel with every handler the catalog has
// (handlers-all.js) unless a test passes a table, so the policy alone decides what a test's
// caller may send, as it did before each page had its own table. handlers.test.mjs holds the
// pages' own tables. catalogFor gives a test the catalog its context's root builds its policy
// on: the shared one for a page, and the worker's composed with it for the service worker
// (contracts/worker-catalog.js, the lead's split for #182).

import { ALL_HANDLERS } from '../../js/kernel/core/application/handlers-all.js';
import { createKernel as createContextKernel } from '../../js/kernel/core/application/kernel.js';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { QUERIES } from '../../js/kernel/core/contracts/queries.js';
import { WORKER_CATALOG } from '../../js/kernel/core/contracts/worker-catalog.js';

/** @typedef {import('../../js/kernel/core/application/kernel.js').KernelOptions} KernelOptions */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/ports/policy.js').Caller} Caller */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Catalog} Catalog */

/**
 * @param {Omit<KernelOptions, 'handlers'> & {handlers?: KernelOptions['handlers']}} options
 * @returns {Kernel}
 */
export const createKernel = options => createContextKernel({ handlers: ALL_HANDLERS, ...options });

/** The shared catalog, which every page's root builds its policy on */
const SHARED_CATALOG = Object.freeze({ commands: COMMANDS, queries: QUERIES });

/**
 * The catalog `caller`'s root builds its baseline policy on: the shared one for a page, and the
 * worker's for the service worker
 * @param {Caller} caller
 * @returns {Catalog}
 */
export const catalogFor = caller => (caller.surface === 'worker-internal' ? WORKER_CATALOG : SHARED_CATALOG);
