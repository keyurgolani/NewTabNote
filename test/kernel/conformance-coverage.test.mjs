// #28 slice 2 (approved AC2): every implementation of a port with a shared conformance suite
// runs that suite, and every suite runs against an implementation. conformance-inventory.mjs
// lists them; conformance-coverage.mjs finds them in the source. The planted cases show each
// rule failing on what it's there to catch, the way #17's durable adapters and #15's families
// will arrive.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coverageProblems, repoTree, withFiles } from './conformance-coverage.mjs';
import * as inventory from './conformance-inventory.mjs';

const tree = repoTree();

/**
 * The problems with `files` planted in the repository, and with `changes` to the inventory
 * @param {Record<string, string | null>} files
 * @param {Partial<typeof inventory>} [changes]
 */
const problemsWith = (files, changes = {}) => coverageProblems(withFiles(tree, files), { ...inventory, ...changes });

/**
 * @param {string[]} problems
 * @param {RegExp} expected
 */
function assertFlags(problems, expected) {
  assert.ok(problems.some(problem => expected.test(problem)), `expected a problem matching ${expected}, got ${JSON.stringify(problems, null, 2)}`);
}

describe('conformance coverage', () => {
  it('binds every implementation to a suite run, and every suite to an implementation', () => {
    assert.deepEqual(coverageProblems(tree), []);
  });

  it('lists each port with its suite, implementations, and runs', () => {
    const rows = Object.entries(inventory.PORTS).map(([id, port]) => ({
      id,
      suite: port.suite.module,
      runs: port.implementations.map(implementation => `${implementation.module ?? implementation.host} in ${implementation.run}`),
    }));
    assert.deepEqual(rows.map(row => row.id), [
      'kernel-adapter',
      'idempotency-ledger',
      'commit-log',
      'messaging-transport',
      'registry-family',
      'chrome-storage-local',
    ]);
    for (const row of rows) assert.ok(row.runs.length > 0, row.id);
  });
});

describe('conformance coverage fails on', () => {
  it("a new module under js/kernel/adapters/, as #17's durable ledger will be, until a suite runs against it", () => {
    const ledger = 'js/kernel/adapters/indexeddb/ledger.js';
    const planted = { [ledger]: 'export function createIndexedDbLedger() { return { read: async () => ({ status: "absent" }) }; }\n' };
    assertFlags(problemsWith(planted), /^js\/kernel\/adapters\/indexeddb\/ledger\.js is an implementation module with no conformance run/);

    // Bound, with a run that loads it and calls the suite, it passes
    const run = 'test/kernel/indexeddb-ledger.test.mjs';
    const bound = problemsWith(
      {
        ...planted,
        [run]: [
          "import { createIndexedDbLedger } from '../../js/kernel/adapters/indexeddb/ledger.js';",
          "import { describeIdempotencyLedger } from './idempotency-ledger-suite.mjs';",
          'describeIdempotencyLedger({ name: "indexeddb", start: async () => ({ ledger: createIndexedDbLedger() }) });',
          '',
        ].join('\n'),
      },
      {
        PORTS: {
          ...inventory.PORTS,
          'idempotency-ledger': {
            ...inventory.PORTS['idempotency-ledger'],
            implementations: [...inventory.PORTS['idempotency-ledger'].implementations, { module: ledger, run }],
          },
        },
      },
    );
    assert.deepEqual(bound, []);
  });

  it("a module that calls defineFamily, as #15's families under js/registries/ will", () => {
    const planted = {
      'js/registries/commands/family.js': "import { defineFamily } from '../../kernel/registry/family.js';\nexport const commands = defineFamily({ id: 'commands' });\n",
    };
    assertFlags(problemsWith(planted), /^js\/registries\/commands\/family\.js calls defineFamily, so it's a registry-family implementation, with no conformance run/);
  });

  it('a module that exports a transport, wherever it is', () => {
    const planted = { 'js/kernel/core/messaging/message-port.js': 'export function createMessagePortTransport() { return { connect() {} }; }\n' };
    assertFlags(problemsWith(planted), /^js\/kernel\/core\/messaging\/message-port\.js exports a create\.\.\.Transport, so it's a messaging-transport implementation/);
  });

  it('a chrome.storage fake shared by tests', () => {
    const planted = {
      'test/support/chrome-storage.mjs': 'export const chrome = { storage: { local: { get() {}, set() {} } } };\n',
    };
    assertFlags(problemsWith(planted), /^test\/support\/chrome-storage\.mjs makes a chrome\.storage area, so it's a chrome-storage-local implementation/);
  });

  it('a suite that no port binds to an implementation', () => {
    const planted = { 'test/kernel/journal-suite.mjs': 'export function describeJournalReader(fixture) {}\n' };
    assertFlags(problemsWith(planted), /^test\/kernel\/journal-suite\.mjs exports the suite describeJournalReader, which no port/);
  });

  it('a port whose suite has no implementation bound', () => {
    const PORTS = { ...inventory.PORTS, 'commit-log': { ...inventory.PORTS['commit-log'], implementations: [] } };
    const problems = problemsWith({}, { PORTS });
    assertFlags(problems, /^commit-log: the suite test\/kernel\/commit-log-suite\.mjs has no implementation bound/);
    // and its implementation, no longer bound, is flagged too
    assertFlags(problems, /^js\/kernel\/core\/memory\/commit-log\.js is an implementation module with no conformance run/);
  });

  it("a run that doesn't call the suite, or doesn't load the implementation", () => {
    const run = 'test/kernel/commit-log.test.mjs';
    assertFlags(
      problemsWith({ [run]: "import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';\nimport './commit-log-suite.mjs';\n" }),
      /^commit-log: test\/kernel\/commit-log\.test\.mjs never calls describeCommitLog/,
    );
    assertFlags(
      problemsWith({ [run]: "import { describeCommitLog } from './commit-log-suite.mjs';\ndescribeCommitLog({});\n" }),
      /^commit-log: test\/kernel\/commit-log\.test\.mjs doesn't load js\/kernel\/core\/memory\/commit-log\.js/,
    );
  });

  it("a run that npm test doesn't run, and a browser run that isn't an e2e spec", () => {
    const moved = 'test/kernel/storage/commit-log.test.mjs';
    const PORTS = {
      ...inventory.PORTS,
      'commit-log': { ...inventory.PORTS['commit-log'], implementations: [{ module: 'js/kernel/core/memory/commit-log.js', run: moved }] },
      'chrome-storage-local': {
        ...inventory.PORTS['chrome-storage-local'],
        implementations: [inventory.PORTS['chrome-storage-local'].implementations[0], { host: /** @type {const} */ ('chromium'), run: 'test/chrome-storage-conformance.test.js' }],
      },
    };
    const problems = problemsWith({ [moved]: tree.read('test/kernel/commit-log.test.mjs') ?? '' }, { PORTS });
    assertFlags(problems, /^commit-log: test\/kernel\/storage\/commit-log\.test\.mjs, the run for js\/kernel\/core\/memory\/commit-log\.js, isn't a file npm test runs/);
    assertFlags(problems, /^chrome-storage-local: test\/chrome-storage-conformance\.test\.js, the run on chromium, isn't a spec npm run test:extension runs/);
  });

  it('a fake of a browser API with no run in the browser', () => {
    const port = inventory.PORTS['chrome-storage-local'];
    const PORTS = { ...inventory.PORTS, 'chrome-storage-local': { ...port, implementations: port.implementations.filter(implementation => implementation.host === undefined) } };
    assertFlags(problemsWith({}, { PORTS }), /^chrome-storage-local: chrome\.storage\.local is a browser API, so its suite needs a run in the browser too/);
  });

  it('a helper its implementation no longer loads, and an exemption that no longer applies', () => {
    assertFlags(
      problemsWith({}, { HELPERS: { ...inventory.HELPERS, 'js/kernel/core/memory/fingerprint.js': ['js/kernel/adapters/legacy/adapter.js'] } }),
      /^the helper js\/kernel\/core\/memory\/fingerprint\.js names js\/kernel\/adapters\/legacy\/adapter\.js, which doesn't load it/,
    );
    assertFlags(problemsWith({ 'js/storage.js': 'const Storage = {};\n' }), /^js\/storage\.js is no longer a chrome-storage-local implementation: delete its exemption/);
  });
});
