/**
 * The state rows owners register (#26, "Registries"): one matrix descriptor per contribution, each
 * from its owner's module. Empty in slice 1, so ci/baselines/states.json lists every contribution's
 * missing rows until slice 3's baseline sweep and their owners write them.
 */

/** @type {readonly Readonly<Record<string, unknown>>[]} */
export const ROWS = Object.freeze([]);
