/**
 * The probe Capture's and Storage's checks commit (#20's providers, js/trust/core/providers/probe.js):
 * a record under PROBE_KEY written, read back and deleted in each store it names, all in one
 * readwrite transaction, so the database holds after it exactly what it held before. Every other
 * context's checks commit it on their own adapter, and recovery.html's on the worker's queue
 * (probeCommit, contracts/recovery-port.js, #35 slice 8), where captures commit.
 */

import { committed, rejected } from '../contracts/outcomes.js';
import { invalid } from './notes.js';

/** @typedef {import('../ports/repository.js').StoreName} StoreName */
/** @typedef {import('../ports/repository.js').Work} Work */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../contracts/operations/probe-commit.js').ProbeCommit} ProbeCommit */

/**
 * The key a probe writes under: an array, which no note, block, or folder key can be, since
 * every release and the kernel (isId) key them by strings, so an imported record can't take it
 */
export const PROBE_KEY = Object.freeze(['ntn-trust-probe']);

/**
 * The commandId a probe's work carries in a context's own check. A probe isn't a catalog command
 * there: an adapter with idempotency keeps no record of it, since #17's ledger keeps only catalog
 * commands' (#17 PR 2a), and every run runs
 */
export const PROBE_COMMAND_ID = 'trust-probe';

/** What each check probes: what a capture writes, and the notes store */
const PROBED = Object.freeze({ capture: Object.freeze(['notes', 'blocks']), storage: Object.freeze(['notes']) });

/** Whether `record` is the probe's own */
const isProbe = (/** @type {unknown} */ record) =>
  record !== null &&
  typeof record === 'object' &&
  JSON.stringify(/** @type {{id?: unknown}} */ (record).id) === JSON.stringify(PROBE_KEY);

/**
 * The probe's work on `stores`, which changes no entity (`changedIds` is empty), so a commit log
 * that appends one entry per changed entity gets none, and whether its unit ran: a commit that
 * answers without running it, or replays an earlier answer, verified nothing
 * @param {readonly StoreName[]} stores
 * @param {{type: string, commandId: string}} [command]
 * @returns {{work: Work, ran: () => boolean}}
 */
export function probeWork(stores, command = { type: 'trust.probe', commandId: PROBE_COMMAND_ID }) {
  const key = /** @type {string} */ (/** @type {unknown} */ ([...PROBE_KEY]));
  const names = [...stores];
  let ran = false;
  /** @type {Work} */
  const work = {
    commandId: command.commandId,
    command: /** @type {any} */ (command),
    effect: {
      kind: 'units',
      units: [
        {
          stores: names,
          async run(tx) {
            ran = false;
            for (const store of names) {
              if ((await tx.get(store, key)) !== undefined) return rejected('validation', 'probe-record-present');
            }
            for (const store of names) tx.put(store, /** @type {any} */ ({ id: [...PROBE_KEY] }));
            for (const store of names) {
              if (!isProbe(await tx.get(store, key))) return rejected('validation', 'probe-readback-mismatch');
            }
            for (const store of names) tx.delete(store, key);
            ran = true;
            return undefined;
          },
        },
      ],
    },
    done: () => committed('trust-probe', [], { severity: 'info' }),
  };
  return { work, ran: () => ran };
}

export const probeCommands = {
  /**
   * recovery.html's probe, on the worker's queue: capture's reads the Daily Note template
   * setting first, as a capture does, so a settings area that fails it fails the probe
   * @param {ProbeCommit} command
   * @param {{adapter: KernelAdapter}} context
   * @returns {Promise<Work | Outcome>}
   */
  async probeCommit(command, { adapter }) {
    const stores = Object.hasOwn(PROBED, command.provider) ? PROBED[command.provider] : null;
    if (!stores) return invalid();
    if (command.provider === 'capture') await adapter.readSettings('preferences', ['dailyNoteTemplate']);
    return probeWork(/** @type {readonly StoreName[]} */ (stores), command).work;
  },
};
