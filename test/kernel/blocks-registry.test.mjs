// #14 slice 1 (approved AC1, AC2, AC4): the `block` family on #15's kit, its 18 built-ins
// through #15's conformance suite and the `block-model` fixture, the startup diagnostics, one
// test per diagnostic, an invalid definition disabling only its own type, and the content-free
// block-health query.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { block, createBlockRegistry } from '../../js/kernel/composition/blocks.js';
import { BUILT_IN_BLOCKS, BUILT_IN_TYPES } from '../../js/kernel/core/blocks/builtins.js';
import { createCatalog } from '../../js/kernel/core/blocks/catalog.js';
import { PREVIEWS, previewOfContent } from '../../js/kernel/core/blocks/previews.js';
import {
  BLOCK_FAMILY,
  BLOCK_FIXTURE,
  BLOCK_HOSTS,
  DIAGNOSTICS,
  MANDATORY_CAPABILITIES,
  definitionProblems,
} from '../../js/kernel/core/blocks/contract.js';
import { HOSTS } from '../../js/kernel/registry/vocabulary.js';
import { BLOCK_FAMILY as PROVIDER_BLOCK_FAMILY } from '../../js/trust/core/providers/platform.js';
import { describeRegistryConformance } from './registry-conformance.mjs';

/** @typedef {import('../../js/kernel/core/blocks/builtins.js').BlockDescriptor} BlockDescriptor */
/** @typedef {import('../../js/kernel/core/blocks/models.js').BlockModel} BlockModel */
/** @typedef {import('../../js/kernel/core/blocks/catalog.js').Catalog} Catalog */

const text = /** @type {BlockDescriptor} */ (BUILT_IN_BLOCKS.find(descriptor => descriptor.id === 'text'));

/**
 * A definition like text's, as another type, with `change` applied
 * @param {string} id
 * @param {Record<string, unknown>} [change]
 * @returns {any}
 */
const like = (id, change = {}) => ({ ...text, id, rank: 1000 + id.length, ...change });

/**
 * Text's model with `path` (dotted) removed
 * @param {string} path
 * @returns {BlockModel}
 */
function modelWithout(path) {
  const copy = /** @type {any} */ (structuredCloneWithFunctions(text.implementation));
  const keys = path.split('.');
  let here = copy;
  for (const key of keys.slice(0, -1)) here = here[key];
  delete here[/** @type {string} */ (keys.at(-1))];
  return copy;
}

/**
 * A deep copy of plain objects that keeps functions by reference
 * @param {unknown} value
 * @returns {unknown}
 */
function structuredCloneWithFunctions(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(structuredCloneWithFunctions);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structuredCloneWithFunctions(item)]));
}

/**
 * The block-model fixture: a type's examples decode as what they are, and project and encode
 * @param {import('../../js/kernel/registry/resolve.js').Contribution} contribution
 * @param {unknown} implementation
 */
function blockModelFixture(contribution, implementation) {
  const model = /** @type {BlockModel} */ (implementation);
  const descriptor = /** @type {BlockDescriptor} */ (BUILT_IN_BLOCKS.find(candidate => candidate.id === contribution.id));
  assert.equal(model, descriptor.implementation, `${contribution.ref} loaded another model than it declares`);
  const catalog = createCatalog([descriptor]);
  const { current, legacy, newer, invalid } = model.examples;
  assert.equal(catalog.decode(current).state, 'current', `${contribution.ref}'s current example`);
  assert.equal(catalog.decode(legacy).state, 'upcast', `${contribution.ref}'s legacy example`);
  assert.equal(catalog.decode(newer).state, 'newer', `${contribution.ref}'s newer example`);
  assert.equal(catalog.decode(invalid).state, 'invalid', `${contribution.ref}'s invalid example`);
  for (const kind of /** @type {const} */ (['preview', 'plainText', 'search', 'aiContext'])) {
    assert.equal(typeof catalog.project(kind, current), 'string', `${contribution.ref}'s ${kind}`);
  }
  assert.equal(typeof catalog.markdown(current), 'string', `${contribution.ref}'s Markdown`);
}

describeRegistryConformance('block (#14)', {
  family: block,
  builtIns: BUILT_IN_BLOCKS,
  sample: (id, rank) => ({ ...text, id, rank, group: 'media' }),
  fixtures: { [BLOCK_FIXTURE]: blockModelFixture },
});

/**
 * The problems a registry of `descriptors` reports, as `type code field`
 * @param {readonly unknown[]} descriptors
 */
const problemsOf = descriptors =>
  createBlockRegistry({ host: 'workspace', descriptors }).problems.map(
    problem => `${problem.type} ${problem.code} ${problem.field}`,
  );

describe('the block family (#14 slice 1)', () => {
  it('is #20 provider\'s family, on every host, with the 18 built-ins in BlockTypes order', () => {
    assert.equal(block.id, BLOCK_FAMILY);
    assert.equal(block.id, PROVIDER_BLOCK_FAMILY);
    assert.deepEqual([...BLOCK_HOSTS], [...HOSTS]);
    assert.deepEqual([...block.hosts], [...HOSTS]);
    assert.deepEqual(BUILT_IN_TYPES, [
      'text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle', 'quote', 'code', 'divider',
      'callout', 'image', 'table', 'bookmark', 'video', 'file', 'equation',
    ]);
    for (const descriptor of BUILT_IN_BLOCKS) {
      assert.equal(descriptor.version, 1, `${descriptor.id} is model version 1`);
      assert.equal('load' in descriptor, false, `${descriptor.id}'s model is static`);
    }
  });

  it('starts on every host with no problem and every built-in enabled', () => {
    for (const host of HOSTS) {
      const registry = createBlockRegistry({ host });
      assert.deepEqual(registry.problems, [], host);
      assert.deepEqual(registry.catalog.types, BUILT_IN_TYPES, host);
      assert.deepEqual(registry.health(), { types: 18, enabled: 18, disabled: 0, problems: [] }, host);
    }
  });

  it("has every built-in pass both the kit's rules and the catalog's contract, and previews dispatch exactly the catalog's types", () => {
    // The new tab runs the catalog alone, and a root on the kit runs both: neither refuses one
    const catalog = createCatalog(BUILT_IN_BLOCKS);
    assert.deepEqual(catalog.problems, []);
    assert.deepEqual(catalog.types, BUILT_IN_TYPES);
    for (const host of HOSTS) assert.deepEqual(createBlockRegistry({ host }).catalog.types, catalog.types, host);
    // previews.js gives each enabled type the catalog's own preview, and nothing else a type
    for (const type of catalog.types) {
      const model = /** @type {{model: BlockModel}} */ (catalog.definition(type)).model;
      assert.equal(model.project.preview, Object.hasOwn(PREVIEWS, type) ? PREVIEWS[type] : previewOfContent, type);
    }
    for (const type of Object.keys(PREVIEWS)) assert.ok(catalog.types.includes(type), type);
  });

  it("reads a type for other hosts only as no problem on a host it doesn't apply to", () => {
    const workspaceOnly = like('workspaceonly', { hosts: ['workspace'] });
    const popup = createBlockRegistry({ host: 'popup', descriptors: [...BUILT_IN_BLOCKS, workspaceOnly] });
    assert.deepEqual(popup.problems, []);
    assert.deepEqual(popup.catalog.types, BUILT_IN_TYPES);
    assert.deepEqual(popup.health(), { types: 18, enabled: 18, disabled: 0, problems: [] });
    const workspace = createBlockRegistry({ host: 'workspace', descriptors: [...BUILT_IN_BLOCKS, workspaceOnly] });
    assert.deepEqual(workspace.catalog.types, [...BUILT_IN_TYPES, 'workspaceonly']);
    assert.equal(workspace.health().disabled, 0);
  });

  it('has code-owned text for every diagnostic', () => {
    for (const [code, entry] of Object.entries(DIAGNOSTICS)) {
      assert.ok(entry.message.length > 0 && entry.remediation.length > 0, code);
    }
  });
});

describe('block registry startup diagnostics (#14, approved AC4)', () => {
  it('duplicate-id: two definitions of one type are both disabled, and named once', () => {
    const descriptors = [...BUILT_IN_BLOCKS, { ...text, rank: 5000 }];
    assert.deepEqual(problemsOf(descriptors), ['text duplicate-id id']);
    const registry = createBlockRegistry({ host: 'workspace', descriptors });
    assert.equal(registry.catalog.definition('text'), undefined);
    assert.equal(registry.catalog.decode({ id: 'b', type: 'text', content: 'x' }).state, 'unknown');
    // The catalog alone finds it too
    assert.deepEqual(
      createCatalog([text, text]).problems.map(problem => problem.code),
      ['duplicate-id'],
    );
  });

  it('missing-capability: a model without a mandatory capability is disabled, naming the capability', () => {
    for (const capability of MANDATORY_CAPABILITIES) {
      assert.deepEqual(
        problemsOf([like('lacking', { implementation: modelWithout(capability) })]),
        [`lacking missing-capability ${capability}`],
        capability,
      );
    }
    assert.deepEqual(problemsOf([like('modelless', { implementation: {} })]).length, MANDATORY_CAPABILITIES.length);
  });

  it('upcaster-gap: a version with no upcaster to the next is disabled, naming the missing step', () => {
    const upcast = { 0: text.implementation.upcast[0], 2: (/** @type {any} */ record) => ({ ...record, schemaVersion: 3 }) };
    assert.deepEqual(problemsOf([like('gappy', { version: 3, implementation: { ...text.implementation, upcast } })]), [
      'gappy upcaster-gap upcast.1',
    ]);
    assert.deepEqual(problemsOf([like('none', { implementation: { ...text.implementation, upcast: {} } })]), [
      'none upcaster-gap upcast.0',
    ]);
  });

  it('view-version-mismatch: a view for another model version is disabled', () => {
    assert.deepEqual(problemsOf([like('viewed', { viewVersion: 2 })]), ['viewed view-version-mismatch viewVersion']);
    assert.deepEqual(problemsOf([like('matched', { viewVersion: 1 })]), []);
  });

  it('model-not-static: a model behind a lazy loader is disabled on every host', () => {
    const { implementation, ...rest } = like('lazy');
    for (const host of HOSTS) {
      const problems = createBlockRegistry({ host, descriptors: [{ ...rest, load: async () => implementation }] }).problems;
      assert.ok(
        problems.some(problem => problem.type === 'lazy' && problem.code === 'model-not-static' && problem.field === 'load') ||
          problems.some(problem => problem.code === 'unresolved' && problem.field === 'dynamic-loader-on-background'),
        `${host}: ${JSON.stringify(problems)}`,
      );
    }
    assert.deepEqual(
      definitionProblems({ ...rest, load: async () => implementation }).map(problem => problem.code),
      ['model-not-static', ...MANDATORY_CAPABILITIES.map(() => 'missing-capability')],
    );
  });

  it('invalid-definition: an id, version, or field map that isn\'t one', () => {
    assert.deepEqual(definitionProblems(like('Not An Id')).map(problem => [problem.code, problem.field]), [['invalid-definition', 'id']]);
    assert.deepEqual(definitionProblems(like('versionless', { version: 0 })).map(problem => problem.field), ['version']);
    assert.deepEqual(definitionProblems(like('fieldless', { fields: { id: 'plainText' } })).map(problem => problem.field), ['fields']);
    assert.deepEqual(definitionProblems(like('oddfield', { fields: { a: 'html' } })).map(problem => problem.field), ['fields']);
    assert.deepEqual(definitionProblems(null).map(problem => problem.code), ['invalid-definition']);
  });

  it('unresolved: a definition the kit refuses is disabled and named with the kit\'s reason', () => {
    assert.deepEqual(problemsOf([like('grouped', { group: 'nowhere' })]), ['grouped unresolved invalid-order']);
    assert.deepEqual(problemsOf([like('unfixtured', { fixtures: [] })]), ['unfixtured unresolved missing-fixture']);
    assert.deepEqual(problemsOf([like('fieldless', { fields: undefined })]), ['fieldless unresolved invalid-field']);
  });

  it('an invalid definition disables only its own type: every other one decodes, projects, and creates', () => {
    const broken = { ...BUILT_IN_BLOCKS[13], implementation: modelWithout('project.preview') };
    const descriptors = BUILT_IN_BLOCKS.map(descriptor => (descriptor.id === 'table' ? broken : descriptor));
    const registry = createBlockRegistry({ host: 'workspace', descriptors });
    assert.deepEqual(
      registry.problems.map(problem => `${problem.type} ${problem.code} ${problem.field}`),
      ['table missing-capability project.preview'],
    );
    assert.deepEqual(registry.catalog.types, BUILT_IN_TYPES.filter(type => type !== 'table'));
    assert.deepEqual(registry.health(), {
      types: 18,
      enabled: 17,
      disabled: 1,
      problems: [{ type: 'table', code: 'missing-capability', field: 'project.preview' }],
    });
    // A table record is kept as it is, and reads as a type this root doesn't have
    const table = { id: 't', type: 'table', content: '', tableData: [['a', 'b']] };
    const decoded = registry.catalog.decode(table);
    assert.equal(decoded.state, 'unknown');
    assert.equal(registry.catalog.encode(decoded), table);
    assert.equal(registry.projections.previewText(table), '');
    assert.equal(registry.catalog.create('table', { id: 'n' }).ok, false);
    // Every other type works as before
    assert.equal(registry.projections.previewText({ type: 'toggle', content: 'a', children: '<b>b</b>' }), 'a b');
    assert.equal(registry.catalog.decode({ id: 'x', type: 'text', content: 'x' }).state, 'upcast');
    assert.equal(registry.catalog.create('todo', { id: 'n', checked: true }).ok, true);
  });

  it('never throws at startup for a bad definition', () => {
    const odd = [null, 5, 'text', [], { id: 'x' }, like('fine')];
    const registry = createBlockRegistry({ host: 'workspace', descriptors: odd });
    assert.deepEqual(registry.catalog.types, ['fine']);
    assert.ok(registry.health().disabled >= 1);
  });

  it('the health query holds counts, type ids, codes, and paths, and nothing else', () => {
    const registry = createBlockRegistry({
      host: 'workspace',
      descriptors: [...BUILT_IN_BLOCKS, like('viewed', { viewVersion: 3, label: 'A private label' })],
    });
    const health = registry.health();
    assert.deepEqual(Object.keys(health).sort(), ['disabled', 'enabled', 'problems', 'types']);
    for (const problem of health.problems) assert.deepEqual(Object.keys(problem).sort(), ['code', 'field', 'type']);
    assert.equal(JSON.stringify(health).includes('A private label'), false);
    assert.ok(Object.isFrozen(health));
  });
});
