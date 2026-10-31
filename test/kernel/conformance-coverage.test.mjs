// #28 slice 2 (approved AC2): every implementation of a port with a shared conformance suite
// runs that suite, and every suite runs against an implementation. conformance-inventory.mjs
// lists them; conformance-coverage.mjs finds them in the source. The planted cases show each
// rule failing on what it's there to catch, the way #17's durable adapters and #15's families
// will arrive, and on the ways a run can look like one without running anything.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coverageProblems, repoTree, withFiles } from './conformance-coverage.mjs';
import * as inventory from './conformance-inventory.mjs';

const tree = repoTree();

/** @typedef {typeof inventory.PORTS} Ports */

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

/**
 * The inventory's ports with `id` changed
 * @param {string} id
 * @param {Partial<Ports[string]>} change
 * @returns {Ports}
 */
const portsWith = (id, change) => ({ ...inventory.PORTS, [id]: { ...inventory.PORTS[id], ...change } });

/** @param {string[]} lines */
const text = lines => `${lines.join('\n')}\n`;

describe('conformance coverage', () => {
  it('binds every implementation to a suite run, and every suite to an implementation', () => {
    assert.deepEqual(coverageProblems(tree), []);
  });

  it('lists each port with its suite, implementations, and runs', () => {
    const rows = Object.entries(inventory.PORTS).map(([id, port]) => ({
      id,
      runs: port.implementations.map(implementation => `${implementation.module ?? implementation.host} in ${implementation.run}`),
    }));
    assert.deepEqual(rows.map(row => row.id), [
      'kernel-adapter',
      'idempotency-ledger',
      'commit-log',
      'messaging-transport',
      'registry-family',
      'chrome-storage-local',
      'trust-store',
    ]);
    for (const row of rows) assert.ok(row.runs.length > 0, row.id);
  });
});

describe('conformance coverage finds an implementation', () => {
  it("under js/kernel/adapters/, as a second durable ledger beside #17's would be, and passes once a suite runs against it", () => {
    const ledger = 'js/kernel/adapters/indexeddb/second-ledger.js';
    const planted = { [ledger]: 'export function createSecondLedger() { return { read: async () => ({ status: "absent" }) }; }\n' };
    const problems = problemsWith(planted);
    assertFlags(problems, /^js\/kernel\/adapters\/indexeddb\/second-ledger\.js is an implementation module with no conformance run/);
    assertFlags(problems, /^js\/kernel\/adapters\/indexeddb\/second-ledger\.js exports createSecondLedger, which is a IdempotencyLedger/);

    const run = 'test/kernel/second-ledger.test.mjs';
    const bound = problemsWith(
      {
        ...planted,
        [run]: text([
          "import { createSecondLedger } from '../../js/kernel/adapters/indexeddb/second-ledger.js';",
          "import { describeIdempotencyLedger } from './idempotency-ledger-suite.mjs';",
          "describeIdempotencyLedger({ name: 'second', start: async () => ({ ledger: createSecondLedger() }) });",
        ]),
      },
      {
        PORTS: portsWith('idempotency-ledger', {
          implementations: [...inventory.PORTS['idempotency-ledger'].implementations, { module: ledger, run }],
        }),
      },
    );
    assert.deepEqual(bound, []);
  });

  it('in a new area of js/kernel/, by where it is and by its type', () => {
    const problems = problemsWith({ 'js/kernel/core/durable/ledger.js': 'export function createDurableLedger() { return { read: async () => ({ status: "absent" }) }; }\n' });
    assertFlags(problems, /^js\/kernel\/core\/durable\/ledger\.js is an implementation module with no conformance run/);
    assertFlags(problems, /^js\/kernel\/core\/durable\/ledger\.js exports createDurableLedger, which is a IdempotencyLedger, so it's a idempotency-ledger implementation/);
  });

  it('by its type in an area that is not an implementation one: a commit log and a repository adapter', () => {
    const problems = problemsWith({
      'js/kernel/core/messaging/log.js': 'export const log = { readChangesSince: async () => ({ kind: "changes", entries: [], cursor: 0, more: false }), head: async () => 0 };\n',
      'js/kernel/core/application/store.js': text([
        'export class Store {',
        "  constructor() { this.name = 'store'; this.flags = { atomicMultiStore: true, revisions: true, idempotency: true }; }",
        '  recall() { return undefined; }',
        '  async commit() { return { outcome: { kind: "committed" }, replayed: false }; }',
        '  async read() { return undefined; }',
        '  async readSettings() { return {}; }',
        '  async exportBackup() { return new Blob([]); }',
        '}',
      ]),
    });
    assertFlags(problems, /^js\/kernel\/core\/messaging\/log\.js exports log, which is a CommitLog, so it's a commit-log implementation/);
    assertFlags(problems, /^js\/kernel\/core\/application\/store\.js exports Store, which is a KernelAdapter, so it's a kernel-adapter implementation/);
  });

  it('as a transport, by an object or class with connect, whatever it is called', () => {
    for (const [file, source] of [
      ['js/kernel/core/messaging/message-port.js', 'export function openMessagePortLink() { return { connect() {} }; }\n'],
      ['js/kernel/core/messaging/port-class.js', 'export class MessagePortTransport { connect() {} }\n'],
      ['js/kernel/core/messaging/port-object.js', 'export const messagePortTransport = { connect() {} };\n'],
      ['js/kernel/core/messaging/created.js', 'export function createMessagePortTransport(options) { return options.transport; }\n'],
    ]) {
      assertFlags(problemsWith({ [file]: source }), new RegExp(`^${file.replace(/[./]/g, '\\$&')} .*so it's a messaging-transport implementation`));
    }
  });

  it("as a registry family, by defineFamily from the kit under any name, as #15's under js/registries/ will be", () => {
    for (const source of [
      "import { defineFamily } from '../../kernel/registry/family.js';\nexport const commands = defineFamily({ id: 'commands' });\n",
      "import { defineFamily as df } from '../../kernel/registry/family.js';\nexport const commands = df({ id: 'commands' });\n",
      "import * as kit from '../../kernel/registry/family.js';\nexport const commands = kit.defineFamily({ id: 'commands' });\n",
    ]) {
      assertFlags(problemsWith({ 'js/registries/commands/family.js': source }), /^js\/registries\/commands\/family\.js calls defineFamily, so it's a registry-family implementation/);
    }
    // A function of that name from anywhere else isn't the kit's
    assert.deepEqual(problemsWith({ 'js/registries/commands/family.js': 'const defineFamily = spec => spec;\nexport const commands = defineFamily({});\n' }), []);
  });

  it('as a chrome.storage fake, however its local area is made, in test/, e2e/, or js/', () => {
    for (const [file, source] of [
      ['test/support/chrome-storage.mjs', 'export const chrome = { storage: { local: { get() {}, set() {} } } };\n'],
      ['test/support/area.mjs', 'const area = { get() {}, set() {} };\nexport const storage = { local: area };\n'],
      ['test/support/made.mjs', 'function makeArea() { return { get() {}, set() {} }; }\nexport const storage = { local: makeArea() };\n'],
      ['test/support/quoted.mjs', "export const storage = { 'local': { get() {}, set() {} } };\n"],
      ['e2e/harness/storage.js', 'globalThis.chrome.storage.local = { get() {}, set() {} };\n'],
    ]) {
      assertFlags(problemsWith({ [file]: source }), new RegExp(`^${file.replace(/[./]/g, '\\$&')} makes a chrome\\.storage area`));
    }
  });

  it('as a second fake in js/storage.js, outside the exempt stand-in', () => {
    const storage = tree.read('js/storage.js') ?? '';
    const planted = { 'js/storage.js': `${storage}\nconst fake = { local: { get() {}, set() {} } };\n` };
    assertFlags(problemsWith(planted), /^js\/storage\.js makes a chrome\.storage area, so it's a chrome-storage-local implementation/);
  });

  it("that implements a contract with no suite, and a contract that's neither listed nor a port's", () => {
    assertFlags(
      problemsWith({ 'js/kernel/adapters/indexeddb/journal.js': 'export function openJournal() { return { inFlight: async () => [] }; }\n' }),
      /^js\/kernel\/adapters\/indexeddb\/journal\.js exports openJournal, which is a JournalReader, and js\/kernel\/core\/ports\/journal\.js has no shared suite/,
    );
    assertFlags(problemsWith({ 'js/kernel/core/ports/search.js': 'export {};\n' }), /^js\/kernel\/core\/ports\/search\.js is a contract that's neither a port in PORTS nor listed in WITHOUT_SUITE/);
  });
});

describe('conformance coverage finds a suite or a port', () => {
  it('a suite that no port binds to an implementation', () => {
    assertFlags(problemsWith({ 'test/kernel/journal-suite.mjs': 'export function describeJournalReader(fixture) {}\n' }), /^test\/kernel\/journal-suite\.mjs exports the suite describeJournalReader, which no port/);
  });

  it('a suite whose runner has any name, once a port lists it', () => {
    const suite = 'test/kernel/commit-log-suite.mjs';
    // Every run of the port's suite: the in-memory log's, and #17's durable one's
    const runs = inventory.PORTS['commit-log'].implementations.map(implementation => implementation.run);
    assert.ok(runs.includes('test/kernel/commit-log.test.mjs'));
    const renamed = {
      [suite]: (tree.read(suite) ?? '').replace('export function describeCommitLog(', 'export function conformanceOf('),
      ...Object.fromEntries(runs.map(run => [run, (tree.read(run) ?? '').replaceAll('describeCommitLog', 'conformanceOf')])),
    };
    assert.deepEqual(problemsWith(renamed, { PORTS: portsWith('commit-log', { suite: { module: suite, runner: 'conformanceOf' } }) }), []);
  });

  it('a port whose suite has no implementation bound', () => {
    const problems = problemsWith({}, { PORTS: portsWith('commit-log', { implementations: [] }) });
    assertFlags(problems, /^commit-log: the suite test\/kernel\/commit-log-suite\.mjs has no implementation bound/);
    assertFlags(problems, /^js\/kernel\/core\/memory\/commit-log\.js is an implementation module with no conformance run/);
  });

  it('a browser API fake with no run in the browser, as the port says', () => {
    const port = inventory.PORTS['chrome-storage-local'];
    const PORTS = portsWith('chrome-storage-local', { implementations: port.implementations.filter(implementation => implementation.host === undefined) });
    assertFlags(problemsWith({}, { PORTS }), /^chrome-storage-local: chrome\.storage\.local is a browser API, so its suite needs a run in the browser too/);
  });
});

describe("conformance coverage fails a run that doesn't run the suite", () => {
  const run = 'test/kernel/commit-log.test.mjs';
  const imports = [
    "import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';",
    "import { describeCommitLog } from './commit-log-suite.mjs';",
  ];
  const call = 'describeCommitLog({ name: "memory", start: async () => ({ log: createMemoryCommitLog() }) })';

  it('when it never calls the runner', () => {
    assertFlags(problemsWith({ [run]: text([imports[0], "import './commit-log-suite.mjs';"]) }), /^commit-log: test\/kernel\/commit-log\.test\.mjs never calls describeCommitLog/);
  });

  for (const [what, body] of [
    ['under a condition', `if (false) ${call};`],
    ['in a function nothing calls', `const never = () => ${call};`],
    ['in a skipped describe', `describe.skip('skipped', () => { ${call}; });`],
    ['in a todo describe', `describe.todo('todo', () => { ${call}; });`],
    ['in a describe with skip in its options', `describe('later', { skip: true }, () => { ${call}; });`],
    ["in Playwright's skipped describe", `test.describe.skip('skipped', () => { ${call}; });`],
  ]) {
    it(`when it calls the runner only ${what}`, () => {
      assertFlags(problemsWith({ [run]: text([...imports, "import { describe } from 'node:test';", body]) }), /^commit-log: test\/kernel\/commit-log\.test\.mjs calls describeCommitLog only where it never runs/);
    });
  }

  it('and passes one that calls it at the top level, in a loop, or in a describe', () => {
    for (const body of [
      `${call};`,
      `for (const name of ['a']) { ${call}; }`,
      `describe('log', () => { ${call}; });`,
      `describe('log', { skip: false }, () => { describe('inner', () => { ${call}; }); });`,
    ]) {
      assert.deepEqual(problemsWith({ [run]: text([...imports, "import { describe } from 'node:test';", body]) }), [], body);
    }
  });

  it('when nothing it passes the runner is made from the implementation', () => {
    assertFlags(problemsWith({ [run]: text([...imports, 'describeCommitLog({});', 'createMemoryCommitLog();']) }), /^commit-log: test\/kernel\/commit-log\.test\.mjs calls describeCommitLog with nothing made from js\/kernel\/core\/memory\/commit-log\.js/);
    const spec = 'e2e/chrome-storage.spec.js';
    assertFlags(
      problemsWith({ [spec]: text(["const { test } = require('./harness');", "const { describeChromeStorageLocal } = require('../test/helpers/chrome-storage-suite');", 'describeChromeStorageLocal(() => {}, {});']) }),
      /^chrome-storage-local: e2e\/chrome-storage\.spec\.js calls describeChromeStorageLocal with nothing made from e2e\/harness\/index\.js/,
    );
  });

  it('when it reaches the implementation only through the suite', () => {
    // messaging-conformance.mjs itself loads the memory adapter, which the in-process run doesn't
    const PORTS = portsWith('messaging-transport', {
      implementations: [
        ...inventory.PORTS['messaging-transport'].implementations,
        { module: 'js/kernel/core/memory/adapter.js', run: 'test/kernel/conformance-in-process.test.mjs' },
      ],
    });
    assertFlags(problemsWith({}, { PORTS }), /^messaging-transport: test\/kernel\/conformance-in-process\.test\.mjs doesn't load js\/kernel\/core\/memory\/adapter\.js other than through the suite/);
  });

  it("when npm test doesn't run it, or a browser run isn't an e2e spec", () => {
    const moved = 'test/kernel/storage/commit-log.test.mjs';
    const port = inventory.PORTS['chrome-storage-local'];
    const PORTS = {
      ...portsWith('commit-log', { implementations: [{ module: 'js/kernel/core/memory/commit-log.js', run: moved }] }),
      'chrome-storage-local': {
        ...port,
        implementations: [port.implementations[0], { host: /** @type {const} */ ('chromium'), via: 'e2e/harness/index.js', run: 'test/chrome-storage-conformance.test.js' }],
      },
    };
    const problems = problemsWith({ [moved]: (tree.read(run) ?? '').replaceAll("'../../js/", "'../../../js/").replaceAll("'./", "'../") }, { PORTS });
    assertFlags(problems, /^commit-log: test\/kernel\/storage\/commit-log\.test\.mjs, the run for js\/kernel\/core\/memory\/commit-log\.js, isn't a file npm test runs/);
    assertFlags(problems, /^chrome-storage-local: test\/chrome-storage-conformance\.test\.js, the run on chromium, isn't a spec npm run test:extension runs/);
  });
});

describe('conformance coverage keeps its lists true', () => {
  it('a helper its implementation no longer loads, and a composer that loads none of what it names', () => {
    assertFlags(
      problemsWith({}, { HELPERS: { ...inventory.HELPERS, 'js/kernel/core/memory/fingerprint.js': ['js/kernel/adapters/legacy/adapter.js'] } }),
      /^the helper js\/kernel\/core\/memory\/fingerprint\.js names js\/kernel\/adapters\/legacy\/adapter\.js, which doesn't load it/,
    );
    assertFlags(
      problemsWith({}, { COMPOSERS: { ...inventory.COMPOSERS, 'test/kernel/legacy-fixture.mjs': { port: 'kernel-adapter', of: ['js/kernel/core/memory/adapter.js'] } } }),
      /^the composer test\/kernel\/legacy-fixture\.mjs names js\/kernel\/core\/memory\/adapter\.js, which it doesn't load/,
    );
  });

  it('an exemption once the stand-in it covers is gone', () => {
    assertFlags(problemsWith({ 'js/storage.js': 'const Storage = {};\n' }), /^js\/storage\.js no longer has the chrome-storage-local implementation its exemption covers/);
  });
});
