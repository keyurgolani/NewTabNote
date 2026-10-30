// The conformance inventory (#28 slice 2, approved AC2): every port or contract that has a
// shared conformance suite, the suite, each implementation it runs against, and the test file
// where that run happens. conformance-coverage.test.mjs holds the repository to it, with the
// detection rules in conformance-coverage.mjs:
//
// - every module under js/kernel/adapters/ and js/kernel/core/memory/ is an implementation
//   here, a helper of one, or an unshared module;
// - every module in js/ or a shared test double that has a port's shape (a create...Transport
//   export, a defineFamily call, a chrome.storage area) is an implementation of that port;
// - every suite module under test/ (one exporting describe... or run...Suite) is a suite here;
// - each suite has an implementation, and each run file is one `npm test` or
//   `npm run test:extension` runs, reaches the suite and the implementation through its
//   imports, and calls the suite.
//
// A new adapter, transport, family, or storage fake fails `npm test` until it's bound here with
// a run, so its suite runs against it.

/**
 * An implementation and where its run happens. `module` is the file that makes it, or `host`
 * names a browser that provides it (the run is then an e2e spec).
 * @typedef {{module: string, run: string, host?: undefined} | {host: 'chromium', run: string, module?: undefined}} Implementation
 */

/**
 * @typedef {object} Port
 * @property {string} contract - the file that defines the port, or the API it is
 * @property {{module: string, runner: string}} suite
 * @property {readonly Implementation[]} implementations
 * @property {readonly string[]} [exempt] - modules of this port that run no suite, each in EXEMPT
 */

/** @type {Readonly<Record<string, Port>>} */
export const PORTS = Object.freeze({
  // #12's use cases on each repository adapter (approved AC2: repositories)
  'kernel-adapter': {
    contract: 'js/kernel/core/ports/repository.js',
    suite: { module: 'test/kernel/contract.mjs', runner: 'runContractSuite' },
    implementations: [
      { module: 'js/kernel/core/memory/adapter.js', run: 'test/kernel/memory.test.mjs' },
      { module: 'js/kernel/adapters/legacy/adapter.js', run: 'test/kernel/legacy.test.mjs' },
      { module: 'js/kernel/adapters/indexeddb/adapter.js', run: 'test/kernel/storage-contract.test.mjs' },
    ],
  },
  // #13 slice 3's port suites, which #17's durable ledger and log run when they land
  'idempotency-ledger': {
    contract: 'js/kernel/core/ports/idempotency-ledger.js',
    suite: { module: 'test/kernel/idempotency-ledger-suite.mjs', runner: 'describeIdempotencyLedger' },
    implementations: [{ module: 'js/kernel/core/memory/ledger.js', run: 'test/kernel/idempotency-ledger.test.mjs' }],
  },
  'commit-log': {
    contract: 'js/kernel/core/ports/commit-log.js',
    suite: { module: 'test/kernel/commit-log-suite.mjs', runner: 'describeCommitLog' },
    implementations: [{ module: 'js/kernel/core/memory/commit-log.js', run: 'test/kernel/commit-log.test.mjs' }],
  },
  // #13's messaging conformance on each transport (approved AC2: runtime and message)
  'messaging-transport': {
    contract: 'js/kernel/core/messaging/link.js',
    suite: { module: 'test/kernel/messaging-conformance.mjs', runner: 'describeConformance' },
    implementations: [
      { module: 'js/kernel/core/messaging/in-process.js', run: 'test/kernel/conformance-in-process.test.mjs' },
      { module: 'js/kernel/adapters/messaging/runtime-port.js', run: 'test/kernel/conformance-runtime-port.test.mjs' },
    ],
  },
  // #15's registry conformance on each family (approved AC2: registry). Slices 2 to 4 add the
  // real families under js/registries/<family>/.
  'registry-family': {
    contract: 'js/kernel/registry/family.js',
    suite: { module: 'test/kernel/registry-conformance.mjs', runner: 'describeRegistryConformance' },
    implementations: [
      { module: 'test/kernel/registry-fixtures.mjs', run: 'test/kernel/registry-conformance-fixtures.test.mjs' },
    ],
  },
  // The stub every legacy test runs on, held to Chromium (#28 slice 2)
  'chrome-storage-local': {
    contract: 'chrome.storage.local',
    suite: { module: 'test/helpers/chrome-storage-suite.js', runner: 'describeChromeStorageLocal' },
    implementations: [
      { module: 'test/helpers/legacy-env.js', run: 'test/chrome-storage-conformance.test.js' },
      { host: 'chromium', run: 'e2e/chrome-storage.spec.js' },
    ],
    exempt: ['js/storage.js'],
  },
});

/**
 * Modules under js/kernel/adapters/ and js/kernel/core/memory/ that implement no port
 * themselves: each is part of the implementations it names, which import it, and its
 * behavior is checked through their runs.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const HELPERS = Object.freeze({
  'js/kernel/adapters/indexeddb/connection.js': ['js/kernel/adapters/indexeddb/adapter.js'],
  'js/kernel/adapters/indexeddb/failures.js': ['js/kernel/adapters/indexeddb/adapter.js'],
  'js/kernel/adapters/indexeddb/recovery.js': ['js/kernel/adapters/indexeddb/adapter.js'],
  'js/kernel/adapters/indexeddb/requests.js': ['js/kernel/adapters/indexeddb/adapter.js', 'js/kernel/adapters/legacy/adapter.js'],
  'js/kernel/adapters/indexeddb/schema.js': ['js/kernel/adapters/indexeddb/adapter.js', 'js/kernel/adapters/legacy/adapter.js'],
  'js/kernel/adapters/indexeddb/settings.js': ['js/kernel/adapters/indexeddb/adapter.js', 'js/kernel/adapters/legacy/adapter.js'],
  'js/kernel/core/memory/fingerprint.js': ['js/kernel/core/memory/adapter.js', 'js/kernel/core/memory/ledger.js'],
});

/**
 * Modules under js/kernel/adapters/ that are the only implementation of what they implement,
 * so there's nothing to share a suite with: each names that interface and the test that
 * covers it. The PR that adds a second implementation of one of them moves the interface to
 * PORTS with a shared suite, since the new module fails the check until it's classified.
 * @type {Readonly<Record<string, {implements: string, tests: string}>>}
 */
export const UNSHARED = Object.freeze({
  'js/kernel/adapters/messaging/hint-channel.js': {
    implements: 'Channel (js/kernel/core/messaging/hints.js), on BroadcastChannel',
    tests: 'test/kernel/hints.test.mjs',
  },
  'js/kernel/adapters/messaging/status-region.js': {
    implements: "the status region over #13's client (StatusSource)",
    tests: 'test/kernel/status-region.test.mjs',
  },
});

/**
 * Implementations that run no suite, each with the issue that removes it and why it can wait.
 * The check fails once the module no longer has the port's shape, so the entry goes with it.
 * @type {Readonly<Record<string, {port: string, owner: string, reason: string}>>}
 */
export const EXEMPT = Object.freeze({
  'js/storage.js': {
    port: 'chrome-storage-local',
    owner: '#12 slice 7 or #17',
    reason: 'the localStorage stand-in for chrome.storage when a page runs from file://, which a packaged '
      + "extension never reaches. #28's build-to scope defers deleting it (Production change 2).",
  },
});
