'use strict';

// #26 slice 1: the states catalog. Every cause's message, every state's headline and every
// action's label, Inspect's and Open's destinations' among them, has a string in a registered
// chunk, and each chunk resolves on its hosts and keeps its rules: placeholders exactly its
// declared parameters, each of a safe type, no note title where background loads it, and no
// success word but where a ready or committed key backs it. Formatting fills in only what a string
// declares, and Moment's chunk imports nothing but the catalog module.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** @type {any} */ let catalog;
/** @type {any} */ let chunks;
/** @type {any} */ let causes;
/** @type {any} */ let words;
/** @type {any} */ let conformance;
/** @type {any} */ let graph;
/** @type {Map<string, Record<string, string>>} */
const loaded = new Map();
before(async () => {
  catalog = await import('../js/states/core/catalog.js');
  chunks = await import('../js/states/catalog/chunks.js');
  causes = await import('../js/states/core/causes.js');
  words = await import('../js/states/core/vocabulary.js');
  conformance = await import('./kernel/registry-conformance.mjs');
  graph = await import('./kernel/import-graph.mjs');
  for (const chunk of chunks.CHUNKS) loaded.set(chunk.id, (await chunk.load()).default);
});

describe('the states catalog (#26 slice 1)', () => {
  it("has a string for every cause's message, state's headline and action's label in a registered chunk", () => {
    const keys = [
      ...causes.KERNEL_CAUSES.map((/** @type {any} */ cause) => cause.messageKey),
      ...words.STATES.map((/** @type {string} */ state) => `state.${state}.headline`),
      ...[...words.ACTIONS, words.INSPECT].map((/** @type {string} */ action) => `action.${action}`),
      ...['archive', 'recovery-center', 'settings'].map(where => `action.open.${where}`),
    ];
    const strings = Object.assign({}, ...loaded.values());
    for (const key of keys) assert.equal(typeof strings[key], 'string', key);
  });

  it('resolves each chunk on each of its hosts and holds it to its rules, with no key segment in two', () => {
    const holds = chunks.CHUNKS.flatMap((/** @type {any} */ chunk) => chunk.holds);
    assert.equal(new Set(holds).size, holds.length);
    for (const chunk of chunks.CHUNKS) {
      for (const host of chunk.hosts) {
        const resolved = conformance.resolveOne(catalog.catalog, [chunk], host).get(`catalog:${chunk.id}`);
        assert.deepEqual([resolved?.state, host], ['enabled', host], chunk.id);
      }
      assert.ok(!chunk.hosts.includes('background'), `${chunk.id} loads lazily, so never on background`);
      assert.deepEqual(catalog.chunkProblems(chunk, loaded.get(chunk.id)), [], chunk.id);
    }
  });

  it("fills in a string's declared parameters and refuses anything else", () => {
    const counts = { committed: 'count', total: 'count' };
    const partial = (/** @type {unknown} */ values) => catalog.format('{committed} of {total}', counts, values, 'popup');
    assert.equal(partial({ committed: 2, total: 5, extra: 'left out' }), '2 of 5');
    for (const values of [{ committed: -1 }, { committed: 1.5 }, { committed: '2' }, { committed: { n: 2 } }, {}])
      assert.equal(partial({ total: 5, ...values }), null, JSON.stringify(values));
    assert.equal(catalog.format('Waiting on {subsystem}', { subsystem: 'subsystem' }, { subsystem: 'sync' }, 'pip'), 'Waiting on sync');
    const reach = (/** @type {unknown} */ host) => catalog.format("Can't reach {host}", { host: 'host' }, { host }, 'workspace');
    assert.equal(reach('localhost:11434'), "Can't reach localhost:11434");
    for (const host of ['https://example.test/v1', 'Example.test', '', 42]) assert.equal(reach(host), null, String(host));
    assert.equal(catalog.format('{note} is open', {}, { note: 'Plans' }, 'workspace'), null, 'an undeclared placeholder');

    const titled = (/** @type {unknown} */ title, host = 'workspace') =>
      catalog.format('{title} is open', { title: 'title' }, { title }, host);
    assert.equal(titled('Plans'), 'Plans is open');
    assert.equal(titled('Plans', 'background'), null, 'a note title on background');
    for (const title of ['x'.repeat(catalog.TITLE_MAX + 1), 'Plans\u0007', ' ']) assert.equal(titled(title), null, title);
  });

  it("finds a loaded chunk's strings that stray from its descriptor", () => {
    const chunk = { holds: ['state'], parameters: { 'state.partial.headline': { committed: 'count' } }, hosts: ['popup'] };
    const fine = { 'state.partial.headline': '{committed} finished' };
    const problems = (/** @type {object} */ strings, /** @type {object} */ of = chunk) => catalog.chunkProblems(of, strings);
    assert.deepEqual(problems(fine), []);
    assert.deepEqual(problems({ 'state.partial.headline': '{committed} of {total}' }), ['placeholders: state.partial.headline']);
    assert.deepEqual(problems({ ...fine, 'cause.x': 'X' }), ['outside-holds: cause.x']);
    assert.deepEqual(problems({ ...fine, 'state.blank': ' ' }), ['invalid-text: state.blank']);
    assert.deepEqual(problems({}), ['declared-missing: state.partial.headline']);
    const onBackground = { holds: ['state'], parameters: { 'state.open': { title: 'title' } }, hosts: ['background'] };
    assert.deepEqual(problems({ 'state.open': '{title} is open' }, onBackground), ['title-on-background: state.open']);

    // A success word is a claim that only a ready or committed key backs; an action's label names what it does
    const plain = { holds: ['state', 'action'], parameters: {}, hosts: ['popup'] };
    for (const text of ['Saved', 'All synced, mostly', 'Export complete'])
      assert.deepEqual(problems({ 'state.failed.headline': text }, plain), ['success-word: state.failed.headline'], text);
    for (const [key, text] of [
      ['state.ready.headline', 'Saved'],
      ['state.loading.headline', 'Checking whether this saved'],
      ['state.failed.headline', "Wasn't exported"],
      ['state.failed.headline', 'Not saved yet'],
      ['state.partial.headline', 'Incomplete'],
      ['action.create-verified-backup', 'Create verified backup'],
    ])
      assert.deepEqual(problems({ [key]: text }, plain), [], text);
  });

  it("keeps Moment's chunk on Moment, importing nothing but the catalog module", () => {
    const reached = [...graph.importGraph(path.join(ROOT, 'js/states/catalog/moment.js'))].map(file => path.relative(ROOT, file));
    assert.deepEqual(reached.filter(file => !['js/states/catalog/moment.js', 'js/states/core/catalog.js'].includes(file)), []);
    const moment = chunks.CHUNKS.find((/** @type {any} */ chunk) => chunk.id === 'moment');
    assert.deepEqual([...moment.hosts], ['moment']);
  });
});
