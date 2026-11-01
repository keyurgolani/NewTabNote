// The kernel the tests build (#17 PR 4b): createKernel with every handler the catalog has
// (handlers-all.js) unless a test passes a table, so the policy alone decides what a test's
// caller may send, as it did before each page had its own table. handlers.test.mjs holds the
// pages' own tables.

import { ALL_HANDLERS } from '../../js/kernel/core/application/handlers-all.js';
import { createKernel as createContextKernel } from '../../js/kernel/core/application/kernel.js';

/** @typedef {import('../../js/kernel/core/application/kernel.js').KernelOptions} KernelOptions */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */

/**
 * @param {Omit<KernelOptions, 'handlers'> & {handlers?: KernelOptions['handlers']}} options
 * @returns {Kernel}
 */
export const createKernel = options => createContextKernel({ handlers: ALL_HANDLERS, ...options });
