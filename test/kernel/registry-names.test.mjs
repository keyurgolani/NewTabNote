// The registry's names and plans (registry-names.js, #35 slice 4b-0), which a page that only
// reads may import, and its steps, which write and which only the worker's adapter and the
// migration runner run (registry.js), agree: the names list each step's structural version in
// order, and this build's newest is the newest step's.

import { it } from 'node:test';
import assert from 'node:assert/strict';

import { LATEST_STRUCTURAL, STRUCTURAL_VERSIONS } from '../../js/kernel/adapters/indexeddb/registry-names.js';
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
