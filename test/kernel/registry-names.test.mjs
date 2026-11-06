// The registry's names and plans (registry-names.js, #35 slice 4b-0), which a page that only
// reads may import, and its steps, which write and which only the worker's adapter and the
// migration runner run (registry.js), agree: the names list each step's structural version in
// order, and this build's newest is the newest step's.

import { it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANGES_STORE,
  CONFLICTS_STORE,
  DAILY_INDEX_STORE,
  LATEST_STRUCTURAL,
  LEGACY_STORE_NAMES,
  META_STORE,
  MIGRATIONS_STORE,
  OPERATIONS_STORE,
  STRUCTURAL_VERSIONS,
  TOMBSTONES_STORE,
  schemaAt,
} from '../../js/kernel/adapters/indexeddb/registry-names.js';
import { STEPS } from '../../js/kernel/adapters/indexeddb/registry.js';
import { DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';

it("names each structural version the registry's steps leave, in order, and the newest of them this build's (#35 slice 4b-0)", () => {
  assert.deepEqual(
    STRUCTURAL_VERSIONS,
    STEPS.map(step => step.to),
  );
  assert.equal(LATEST_STRUCTURAL, Math.max(8, ...STEPS.map(step => step.to)));
  assert.equal(LATEST_STRUCTURAL, DB_VERSION);
});

it('schemaAt(11) lists the ten legacy stores and the seven later ones, by their names', () => {
  assert.deepEqual(
    Object.keys(/** @type {Record<string, unknown>} */ (schemaAt(11))).sort(),
    [
      ...LEGACY_STORE_NAMES,
      META_STORE,
      MIGRATIONS_STORE,
      OPERATIONS_STORE,
      CHANGES_STORE,
      CONFLICTS_STORE,
      TOMBSTONES_STORE,
      DAILY_INDEX_STORE,
    ].sort(),
  );
  assert.equal(LEGACY_STORE_NAMES.length, 10);
});
