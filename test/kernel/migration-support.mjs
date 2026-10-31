// Test contexts for #17's migration runner (migrate.js): a profile of fake-indexeddb behind the
// fault-injecting wrapper (storage-faults.mjs) and legacy-env's chrome.storage.local stub, the
// storage fixtures (test/fixtures/storage/), and a run with a still clock, Web Crypto, Web
// Locks, a roomy estimate, and a logger that keeps every line.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { startMigrations } from '../../js/kernel/adapters/indexeddb/migrate.js';
import { purgeRecoveryPoints } from '../../js/kernel/adapters/indexeddb/purge.js';
import { LATEST_STRUCTURAL } from '../../js/kernel/adapters/indexeddb/registry.js';
import { runTransforms } from '../../js/kernel/adapters/indexeddb/transforms.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { dumpFixture, fillCanaries, loadFixture } from '../fixtures/storage/load-fixture.mjs';
import { faultyFactory } from './storage-faults.mjs';
import { CALLERS, NOW } from './support.mjs';

/** @typedef {import('../fixtures/storage/load-fixture.mjs').Fixture} Fixture */
/** @typedef {import('../../js/kernel/adapters/indexeddb/migrate.js').MigrationOptions} MigrationOptions */
/** @typedef {import('../../js/kernel/adapters/indexeddb/migrate.js').MigrationRun} MigrationRun */
/** @typedef {import('../../js/kernel/adapters/indexeddb/transforms.js').TransformOptions} TransformOptions */
/** @typedef {import('./storage-faults.mjs').Faults} Faults */

const requireCommonJs = createRequire(import.meta.url);
/** @type {any} */
export const legacyEnv = requireCommonJs('../helpers/legacy-env.js');
/** @type {{IDBFactory: new () => IDBFactory, IDBKeyRange: typeof IDBKeyRange}} */
const fake = requireCommonJs('fake-indexeddb');
export const KeyRange = fake.IDBKeyRange;

export const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'storage');

/**
 * Every synthesized fixture, by id
 * @returns {Map<string, Fixture>}
 */
export function synthesized() {
  const dir = path.join(FIXTURES, 'synthesized');
  return new Map(
    fs
      .readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .sort()
      .map(file => {
        const fixture = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        return [fixture.header.id, fixture];
      }),
  );
}

/**
 * The expected file for fixture `id` after the registry runs to this build's newest structural
 * version (10 since #17 PR 2a)
 * @param {string} id
 * @returns {Fixture}
 */
export function expectedFor(id) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected', `${id}.v${LATEST_STRUCTURAL}.json`), 'utf8'));
}

/**
 * @typedef {object} Profile
 * @property {IDBFactory} real
 * @property {Faults} faults
 * @property {any} chrome
 * @property {Array<{event: string, detail: Record<string, unknown>}>} logs
 */

/** @returns {Profile} */
export function newProfile() {
  const real = new fake.IDBFactory();
  return { real, faults: faultyFactory(real), chrome: legacyEnv.createChromeStub(), logs: [] };
}

/**
 * A profile holding `fixture`
 * @param {Fixture} fixture
 * @returns {Promise<Profile>}
 */
export async function profileWith(fixture) {
  const of = newProfile();
  await loadFixture(fixture, { factory: of.real, storage: of.chrome.api.storage.local });
  return of;
}

/** A disk with room to spare */
export const ROOMY = async () => ({ quota: 10 * 1024 ** 3, usage: 1024 ** 2 });

/**
 * A run on `of`, as the worker's composition root will start one (#17 PR 1b)
 * @param {Profile} of
 * @param {Partial<MigrationOptions>} [options]
 * @returns {MigrationRun}
 */
export function start(of, options = {}) {
  return startMigrations({
    indexedDB: of.faults.factory,
    keyRange: KeyRange,
    locks: legacyEnv.createLockManager(),
    estimate: ROOMY,
    crypto: /** @type {any} */ (webcrypto),
    clock: { now: () => NOW },
    logger: { warn: (event, detail) => of.logs.push({ event, detail }) },
    ...options,
  });
}

/**
 * @param {Profile} of
 * @param {Partial<MigrationOptions>} [options]
 */
export const run = (of, options) => start(of, options).done;

/**
 * #17's data transforms on `of`, as the worker runs them once its run is in (#17 PR 3a), with
 * the run's test host and no wait between batches
 * @param {Profile} of
 * @param {Partial<TransformOptions>} [options]
 */
export function transform(of, options = {}) {
  return runTransforms({
    indexedDB: of.faults.factory,
    keyRange: KeyRange,
    locks: legacyEnv.createLockManager(),
    estimate: ROOMY,
    crypto: /** @type {any} */ (webcrypto),
    clock: { now: () => NOW },
    logger: { warn: (event, detail) => of.logs.push({ event, detail }) },
    yieldBetween: () => Promise.resolve(),
    ...options,
  });
}

/**
 * Commits on #17's adapter over `of`, opened as the worker opens it at this build's version,
 * that leave a row in each of step 10's stores: ledger rows, changes, a conflict record, and
 * a tombstone (#17 PR 2a). Answers each command's outcome.
 * @param {Profile} of
 * @returns {Promise<string[]>} each command's outcome kind, in order
 */
export async function writeHistory(of) {
  const adapter = createIndexedDbAdapter({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    keyRange: KeyRange,
    clock: { now: () => NOW },
  });
  await adapter.open();
  try {
    let count = 0;
    const ids = { next: () => `history-${(count += 1)}` };
    const clock = { now: () => NOW };
    const policy = createBaselinePolicy();
    const tab = createKernel({ adapter, policy, caller: CALLERS.newtab, ids, clock });
    const worker = createKernel({ adapter, policy, caller: CALLERS['worker-internal'], ids, clock });
    const block = (/** @type {string} */ content) => ({ id: 'history-block', type: 'text', content, order: 0 });
    /** @type {Array<[typeof tab, Record<string, unknown>]>} */
    const commands = [
      [
        tab,
        { type: 'createNote', commandId: 'h1', noteId: 'history-note', name: 'Kept after', blocks: [block('One')] },
      ],
      [tab, { type: 'saveNoteContent', commandId: 'h2', noteId: 'history-note', blocks: [block('Two')] }],
      [
        tab,
        {
          type: 'saveNoteContent',
          commandId: 'h3',
          noteId: 'history-note',
          blocks: [block('Lost')],
          expectedRevision: 1,
        },
      ],
      [tab, { type: 'setPinned', commandId: 'h4', noteId: 'history-note', pinned: true }],
      [tab, { type: 'createNote', commandId: 'h5', noteId: 'history-empty' }],
      [tab, { type: 'trashNote', commandId: 'h6', noteId: 'history-empty' }],
      [
        worker,
        {
          type: 'captureToDailyNote',
          commandId: 'h7',
          noteId: 'history-daily',
          blockId: 'history-capture',
          capture: { type: 'text', content: 'Captured' },
        },
      ],
    ];
    /** @type {string[]} */
    const kinds = [];
    for (const [kernel, command] of commands) kinds.push((await kernel.execute(/** @type {any} */ (command))).kind);
    return kinds;
  } finally {
    adapter.close();
  }
}

/**
 * When these tests delete for good: a minute after the upgrade's point, which a run makes at
 * NOW, since the purge takes from a point only what deletes after it was made took (purge.js)
 */
export const DELETED_AT = NOW + 60_000;

/**
 * Deletes the profile's first note (by id) and its first folder for good on #17's adapter, as a
 * page would, a minute after the run, then purges the recovery points of both, as the worker
 * does (#17 PR 2b). Answers their ids and the purge's outcome.
 * @param {Profile} of
 * @returns {Promise<{noteId: string, folderId: string | null, purged: import('../../js/kernel/adapters/indexeddb/purge.js').PurgeOutcome}>}
 */
export async function deleteAndPurge(of) {
  const adapter = createIndexedDbAdapter({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    keyRange: KeyRange,
    clock: { now: () => DELETED_AT },
  });
  await adapter.open();
  /** @type {string} */
  let noteId;
  /** @type {string | null} */
  let folderId;
  try {
    let count = 0;
    const ids = { next: () => `deleted-${(count += 1)}` };
    const tab = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids,
      clock: { now: () => DELETED_AT },
    });
    const notes = await tab.query({ type: 'listNotes', view: 'active' });
    const folders = await tab.query({ type: 'listFolders' });
    noteId = notes.kind === 'ready' ? [...notes.data.map(note => note.id)].sort()[0] : '';
    folderId = folders.kind === 'ready' ? [...folders.data.map(folder => folder.id)].sort()[0] : null;
    /** @param {Record<string, unknown>} fields */
    const send = async fields => {
      const outcome = await tab.execute(/** @type {any} */ ({ commandId: ids.next(), ...fields }));
      if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
    };
    await send({ type: 'trashNote', noteId });
    await send({ type: 'deleteNotePermanently', noteId });
    if (folderId) await send({ type: 'deleteFolder', folderId });
  } finally {
    adapter.close();
  }
  const purged = await purgeRecoveryPoints({
    indexedDB: of.faults.factory,
    keyRange: KeyRange,
    locks: legacyEnv.createLockManager(),
    crypto: /** @type {any} */ (webcrypto),
    clock: { now: () => DELETED_AT },
    logger: { warn: (event, detail) => of.logs.push({ event, detail }) },
  });
  return { noteId, folderId, purged };
}

/**
 * Everything the profile holds, in the fixture format
 * @param {Profile} of
 * @param {Record<string, any>} [header]
 * @returns {Promise<Fixture>}
 */
export function dump(of, header) {
  return dumpFixture({ factory: of.real, storage: of.chrome.api.storage.local, header });
}

/**
 * `expected` as a dump of the profile it describes reads, canaries filled
 * @param {Fixture} expected
 * @returns {Fixture}
 */
export function asDumped(expected) {
  return fillCanaries({ ...expected, chromeStorageLocal: expected.chromeStorageLocal || {} });
}

/** What a hook throws to stop a run where it stands, as a worker killed there stops */
export class Killed extends Error {
  constructor() {
    super('killed');
    this.name = 'Killed';
  }
}

/**
 * Hooks that stop the run at its `at`th stop (1-based), and count the stops it reached
 * @param {number} at
 */
export function killAt(at) {
  const reached = { count: 0, labels: /** @type {string[]} */ ([]) };
  return {
    reached,
    hooks: {
      between: (/** @type {string} */ label) => {
        reached.count += 1;
        reached.labels.push(label);
        if (reached.count === at) throw new Killed();
      },
    },
  };
}

/**
 * Every string in `value`, deep
 * @param {unknown} value
 * @returns {string[]}
 */
export function stringsIn(value) {
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} item */
  const walk = item => {
    if (typeof item === 'string') out.push(item);
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === 'object') Object.values(item).forEach(walk);
  };
  walk(value);
  return out;
}

/**
 * The records of `store` in `database` of a dump, or none
 * @param {Fixture} fixture
 * @param {string} database
 * @param {string} store
 * @returns {Array<{key: any, value: any}>}
 */
export function recordsIn(fixture, database, store) {
  const db = fixture.databases.find(candidate => candidate.name === database);
  const found = db && db.stores.find(candidate => candidate.name === store);
  return found ? /** @type {any} */ (found.records) : [];
}
