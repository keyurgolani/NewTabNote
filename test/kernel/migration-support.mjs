// Test contexts for #17's migration runner (migrate.js): a profile of fake-indexeddb behind the
// fault-injecting wrapper (storage-faults.mjs) and legacy-env's chrome.storage.local stub, the
// storage fixtures (test/fixtures/storage/), and a run with a still clock, Web Crypto, Web
// Locks, a roomy estimate, and a logger that keeps every line.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import { startMigrations } from '../../js/kernel/adapters/indexeddb/migrate.js';
import { dumpFixture, fillCanaries, loadFixture } from '../fixtures/storage/load-fixture.mjs';
import { faultyFactory } from './storage-faults.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('../fixtures/storage/load-fixture.mjs').Fixture} Fixture */
/** @typedef {import('../../js/kernel/adapters/indexeddb/migrate.js').MigrationOptions} MigrationOptions */
/** @typedef {import('../../js/kernel/adapters/indexeddb/migrate.js').MigrationRun} MigrationRun */
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
 * The expected file for fixture `id` after the registry runs to 9
 * @param {string} id
 * @returns {Fixture}
 */
export function expectedFor(id) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected', `${id}.v9.json`), 'utf8'));
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
