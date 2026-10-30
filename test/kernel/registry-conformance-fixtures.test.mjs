// #15's registry conformance suite (registry-conformance.mjs) over the four fixture families,
// and the checks that a built-in breaking a rule fails it (#15 slice 1, AC2)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFORMANCE_CASES,
  CONFORMANCE_RUNS,
  assertBuiltInsValid,
  builtInProblems,
  describeRegistryConformance,
} from './registry-conformance.mjs';
import {
  FIXTURE_FAMILIES,
  commandBuiltIns,
  commands,
  navigation,
  navigationBuiltIns,
  producerBuiltIns,
  producers,
} from './registry-fixtures.mjs';

for (const { family, builtIns, sample } of FIXTURE_FAMILIES) {
  describeRegistryConformance(family.id, {
    family,
    builtIns,
    sample,
    fixtures: {
      'sample-note': (contribution, implementation) => {
        const { produce } = /** @type {{produce: (note: {words: number}) => unknown}} */ (implementation);
        assert.notEqual(produce({ words: 3 }), undefined, `${contribution.ref} produced nothing for the sample note`);
      },
    },
  });
}

describe('registry conformance: a built-in that breaks a rule fails npm test', () => {
  const [, newNote, toggleSidebar, capturePage] = commandBuiltIns;
  /** @type {[string, import('../../js/kernel/registry/family.js').Family, readonly import('../../js/kernel/registry/validate.js').Descriptor[], string][]} */
  const broken = [
    ['an id from a label', commands, [{ ...newNote, id: 'New note' }], 'invalid-id'],
    ['a version that is not an integer', commands, [{ ...newNote, version: 1.5 }], 'invalid-version'],
    ['another apiVersion', commands, [{ ...newNote, apiVersion: 2 }], 'incompatible-api-version'],
    ['a group its family lacks', commands, [{ ...newNote, group: 'misc' }], 'invalid-order'],
    ['a rank that is not an integer', commands, [{ ...newNote, rank: 1.5 }], 'invalid-order'],
    ['a requires entry that is not a ref', commands, [{ ...newNote, requires: ['Not A Ref'] }], 'invalid-requires'],
    ['a requires cycle', commands, [{ ...newNote, requires: ['new-note'] }], 'dependency-cycle'],
    ['a missing requirement', commands, [{ ...newNote, requires: ['absent'] }], 'missing-dependency'],
    ['a Chrome-reserved chord', commands, [{ ...newNote, chords: { default: ['Mod+Shift+N'] } }], 'reserved-chord'],
    ['a chord that is not exact', commands, [{ ...newNote, chords: { default: ['Shift+Mod+N'] } }], 'invalid-chord'],
    [
      'two built-ins on one chord',
      commands,
      [newNote, { ...toggleSidebar, chords: { default: ['Alt+N'] } }],
      'chord-conflict',
    ],
    [
      'an equal group and rank',
      commands,
      [newNote, { ...toggleSidebar, group: 'create', rank: 10 }],
      'ordering-conflict',
    ],
    ['a duplicate id', commands, [newNote, { ...newNote, rank: 99 }], 'duplicate-id'],
    [
      'a Chrome permission beyond the ceiling',
      commands,
      [{ ...capturePage, chromePermissions: ['tabs'] }],
      'unauthorized',
    ],
    [
      'a Chrome permission off background',
      commands,
      [{ ...newNote, chromePermissions: ['contextMenus'] }],
      'unauthorized',
    ],
    [
      'a lazy loader on background',
      commands,
      [{ ...capturePage, implementation: undefined, load: async () => ({}) }],
      'dynamic-loader-on-background',
    ],
    ['no description where its family needs one', commands, [{ ...newNote, description: undefined }], 'invalid-text'],
    ["a family field's bad value", commands, [{ ...newNote, contexts: ['everywhere'] }], 'invalid-field'],
    ["a field its family doesn't define", commands, [{ ...newNote, placement: 'rail' }], 'unknown-field'],
    [
      'a loader where its family has none',
      navigation,
      [{ ...navigationBuiltIns[2], load: async () => ({}) }],
      'invalid-loader',
    ],
    [
      'an AI scope beyond the ceiling',
      producers,
      [{ ...producerBuiltIns[0], aiScopes: ['workspace'] }],
      'unauthorized',
    ],
    ['a missing required fixture', producers, [{ ...producerBuiltIns[0], fixtures: [] }], 'missing-fixture'],
  ];

  for (const [what, family, builtIns, code] of broken) {
    it(`fails on ${what} (${code})`, () => {
      assert.ok(
        builtInProblems(family, builtIns).some(problem => problem.includes(` ${code}`)),
        builtInProblems(family, builtIns).join('\n'),
      );
      assert.throws(() => assertBuiltInsValid(family, builtIns), /break registry rules/);
    });
  }

  it('covers every case, and records each family that ran', () => {
    assert.deepEqual(CONFORMANCE_CASES, [
      'valid',
      'disabled',
      'duplicate',
      'cyclic',
      'missing',
      'incompatible',
      'unauthorized',
      'lazy',
    ]);
    assert.deepEqual([...CONFORMANCE_RUNS.keys()].sort(), FIXTURE_FAMILIES.map(({ family }) => family.id).sort());
  });
});
