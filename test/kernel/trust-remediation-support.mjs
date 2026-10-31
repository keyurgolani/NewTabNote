// Test doubles for #20 slice 3's remediation pipeline: Web Locks with ifAvailable, a file
// port standing in for showSaveFilePicker, and a Trust Center with the remediation family
// registered, over the memory trust store.

import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { remediation } from '../../js/trust/core/families.js';
import { createRemediationPipeline } from '../../js/trust/core/remediation/pipeline.js';
import { hexIds, manualClock, settingsArea } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/remediation/ports.js').RemediationPorts} RemediationPorts */
/** @typedef {import('../../js/trust/core/remediation/ports.js').FilePort} FilePort */
/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */

/**
 * Web Locks shared by a profile's contexts, with `ifAvailable` (the callback gets null while
 * another holds the name) and, without it, one callback per name at a time
 */
export function runLocks() {
  /** @type {Set<string>} */
  const held = new Set();
  /** @type {Map<string, Promise<unknown>>} */
  const queues = new Map();
  return {
    held,
    /**
     * @param {string} name
     * @param {{ifAvailable?: boolean, mode?: string}} options
     * @param {(lock: unknown) => Promise<any>} callback
     */
    request(name, options, callback) {
      if (options && options.ifAvailable) {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve()
          .then(() => callback({ name }))
          .finally(() => held.delete(name));
      }
      const before = queues.get(name) || Promise.resolve();
      const turn = before.then(async () => {
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      });
      queues.set(
        name,
        turn.catch(() => {}),
      );
      return turn;
    },
  };
}

/**
 * A file port: what it saved, and what to break. `cancel` makes the next pick a cancelled
 * picker, `failWrite` the next write fail, and `alter` change what the next read gives back.
 */
export function memoryFiles() {
  /** @type {Map<number, string>} */
  const files = new Map();
  let next = 1;
  const port = {
    files,
    picks: 0,
    unavailable: false,
    cancel: false,
    failWrite: false,
    /** @type {((text: string) => string) | null} */
    alter: null,
    available: () => !port.unavailable,
    /** @param {{suggestedName: string}} options */
    async pick(options) {
      port.picks++;
      port.lastName = options.suggestedName;
      if (port.cancel) {
        port.cancel = false;
        return null;
      }
      return { file: next++ };
    },
    /** @type {string | null} */
    lastName: null,
    /**
     * @param {{file: number}} handle
     * @param {Iterable<string>} parts
     */
    async write(handle, parts) {
      if (port.failWrite) {
        port.failWrite = false;
        throw new DOMException('disk full', 'QuotaExceededError');
      }
      files.set(handle.file, [...parts].join(''));
    },
    /** @param {{file: number}} handle */
    async read(handle) {
      const text = files.get(handle.file);
      if (text === undefined) throw new DOMException('gone', 'NotFoundError');
      if (port.alter) {
        const alter = port.alter;
        port.alter = null;
        return alter(text);
      }
      return text;
    },
    /** The last file saved, parsed */
    last() {
      const texts = [...files.values()];
      return texts.length === 0 ? null : JSON.parse(texts[texts.length - 1]);
    },
  };
  return port;
}

/**
 * A Trust Center with `contributions` registered in the remediation family and a pipeline
 * over them, in a fresh profile. `store` is shared when a second context is made over it.
 * @param {{
 *   contributions: readonly Descriptor[],
 *   ports?: RemediationPorts,
 *   store?: ReturnType<typeof createMemoryTrustStore>,
 *   locks?: ReturnType<typeof runLocks> | null,
 *   clock?: ReturnType<typeof manualClock>,
 *   hooks?: {between?: (step: string) => void | Promise<void>},
 *   wrapStore?: (store: any) => any,
 * }} options
 */
export async function remediationCenter({
  contributions,
  ports = {},
  store = createMemoryTrustStore(),
  locks = runLocks(),
  clock = manualClock(),
  hooks = {},
  wrapStore = s => s,
}) {
  const records = createTrustRecords({
    store: wrapStore(store),
    settings: settingsArea(),
    clock,
    ids: hexIds('c0de'),
  });
  await records.open();
  const journal = createDiagnosticJournal({ records, clock, strict: true });
  const root = createRegistryRoot({ host: 'workspace' });
  root.register(remediation, contributions);
  const resolution = root.resolve();
  const runtime = createRuntime(resolution);
  await runtime.probe();
  const pipeline = createRemediationPipeline({
    records,
    journal,
    clock,
    ids: hexIds('feed'),
    locks: /** @type {any} */ (locks),
    registry: { resolution, runtime },
    ports,
    hooks: /** @type {any} */ (hooks),
  });
  return { store, records, journal, clock, locks, pipeline, resolution };
}

let commands = 0;

/**
 * A recovery.run payload
 * @param {string} remediationId
 * @param {Record<string, unknown>} [more]
 * @param {string} [commandId]
 */
export function runOf(remediationId, more = {}, commandId = `cmd-${++commands}`) {
  return { type: 'recovery.run', commandId, remediationId, userInitiated: true, ...more };
}

/** What a hook throws to stop a run where it stands, as a closed tab stops it */
export class Closed extends Error {
  constructor() {
    super('closed');
    this.name = 'Closed';
  }
}

/** The settings area tests share, re-exported for the salvage tests */
export { settingsArea };
