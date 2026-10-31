// The conformance inventory (#28 slice 2, approved AC2): every port or contract that has a
// shared conformance suite, the suite, each implementation it runs against, and the test file
// where that run happens. conformance-coverage.test.mjs holds the repository to it, and
// conformance-coverage.mjs says how an implementation, a suite, and a run are found. A new
// adapter, ledger, log, transport, family, or storage fake fails `npm test` until it's bound
// here with a run, so its suite runs against it.

/**
 * An implementation and where its run happens. `module` is the file that makes it. A browser
 * that provides one is `host`, reached through `via`, the harness module its e2e spec imports.
 * @typedef {{module: string, run: string, host?: undefined, via?: undefined}
 *   | {host: 'chromium', via: string, run: string, module?: undefined}} Implementation
 */

/**
 * @typedef {object} Port
 * @property {string} contract - the file that defines the port, or the browser API it is
 * @property {boolean} [browser] - the contract is a browser API, so a fake of it needs a run in the browser too
 * @property {readonly string[]} types - the typedefs in `contract` an implementation's type matches
 * @property {{module: string, runner: string}} suite
 * @property {readonly Implementation[]} implementations
 */

/** @type {Readonly<Record<string, Port>>} */
export const PORTS = Object.freeze({
  // #12's use cases on each repository adapter (approved AC2: repositories)
  'kernel-adapter': {
    contract: 'js/kernel/core/ports/repository.js',
    types: ['KernelAdapter'],
    suite: { module: 'test/kernel/contract.mjs', runner: 'runContractSuite' },
    implementations: [
      { module: 'js/kernel/core/memory/adapter.js', run: 'test/kernel/memory.test.mjs' },
      { module: 'js/kernel/adapters/legacy/adapter.js', run: 'test/kernel/legacy.test.mjs' },
      { module: 'js/kernel/adapters/indexeddb/adapter.js', run: 'test/kernel/storage-contract.test.mjs' },
    ],
  },
  // #13 slice 3's port suites, on the in-memory ledger and log and on #17's durable ones (#17 PR 2a)
  'idempotency-ledger': {
    contract: 'js/kernel/core/ports/idempotency-ledger.js',
    types: ['IdempotencyLedger'],
    suite: { module: 'test/kernel/idempotency-ledger-suite.mjs', runner: 'describeIdempotencyLedger' },
    implementations: [
      { module: 'js/kernel/core/memory/ledger.js', run: 'test/kernel/idempotency-ledger.test.mjs' },
      { module: 'js/kernel/adapters/indexeddb/ledger.js', run: 'test/kernel/storage-ledger.test.mjs' },
    ],
  },
  'commit-log': {
    contract: 'js/kernel/core/ports/commit-log.js',
    types: ['CommitLog'],
    suite: { module: 'test/kernel/commit-log-suite.mjs', runner: 'describeCommitLog' },
    implementations: [
      { module: 'js/kernel/core/memory/commit-log.js', run: 'test/kernel/commit-log.test.mjs' },
      { module: 'js/kernel/adapters/indexeddb/changes.js', run: 'test/kernel/storage-ledger.test.mjs' },
    ],
  },
  // #13's messaging conformance on each transport (approved AC2: runtime and message)
  'messaging-transport': {
    contract: 'js/kernel/core/messaging/link.js',
    types: ['Transport'],
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
    types: [],
    suite: { module: 'test/kernel/registry-conformance.mjs', runner: 'describeRegistryConformance' },
    implementations: [
      { module: 'test/kernel/registry-fixtures.mjs', run: 'test/kernel/registry-conformance-fixtures.test.mjs' },
      // #20's health and remediation families
      { module: 'js/trust/core/families.js', run: 'test/kernel/trust-families.test.mjs' },
    ],
  },
  // The stub every legacy test runs on, held to Chromium (#28 slice 2)
  'chrome-storage-local': {
    contract: 'chrome.storage.local',
    browser: true,
    types: [],
    suite: { module: 'test/helpers/chrome-storage-suite.js', runner: 'describeChromeStorageLocal' },
    implementations: [
      { module: 'test/helpers/legacy-env.js', run: 'test/chrome-storage-conformance.test.js' },
      { host: 'chromium', via: 'e2e/harness/index.js', run: 'e2e/chrome-storage.spec.js' },
    ],
  },
  // #20's trust store: NewTabNoteTrust on #17's adapter, and the memory store, through the
  // records layer's bounds and repeat rule (#20 slice 1)
  'trust-store': {
    contract: 'js/trust/core/ports.js',
    types: ['TrustStore'],
    suite: { module: 'test/kernel/trust-store-suite.mjs', runner: 'describeTrustStore' },
    implementations: [
      { module: 'js/trust/core/memory-store.js', run: 'test/kernel/trust-store.test.mjs' },
      { module: 'js/kernel/adapters/indexeddb/trust.js', run: 'test/kernel/trust-store.test.mjs' },
    ],
  },
});

/**
 * The other contracts in js/kernel/core/ports/, which have no shared suite: the typedefs an
 * implementation's type matches, each implementation there is with the test that covers it,
 * and why there's no suite. A module whose type matches one of them and isn't listed fails,
 * so a second implementation, or the first of the journal, comes with a suite.
 * @type {Readonly<Record<string, {types: readonly string[], implementations: Readonly<Record<string, string>>, reason: string}>>}
 */
export const WITHOUT_SUITE = Object.freeze({
  'js/kernel/core/ports/journal.js': {
    types: ['JournalReader'],
    implementations: {},
    reason: "nothing implements it yet: #17's journal client does, in its slice 2, with a suite",
  },
  'js/kernel/core/ports/policy.js': {
    types: ['PolicyPort'],
    implementations: { 'js/kernel/core/ports/policy.js': 'test/kernel/policy.test.mjs' },
    reason: 'the baseline policy is the only one until #21 replaces it behind the same port',
  },
  'js/kernel/core/ports/runtime.js': {
    types: [],
    implementations: {},
    reason: "the host's clock, ids, timers, and logger are values a composition root passes in, not adapters",
  },
});

/**
 * Where under js/kernel/ a module isn't taken for an implementation by where it is. A module
 * here still is one when its type or shape says so (conformance-coverage.mjs). Every other
 * module under js/kernel/ is bound in PORTS, or listed in HELPERS, UNSHARED, or COMPOSERS.
 * @type {Readonly<Record<string, string>>}
 */
export const NOT_IMPLEMENTATIONS = Object.freeze({
  'js/kernel/core/application/': 'the use cases, which the kernel-adapter suite runs on each adapter',
  'js/kernel/core/contracts/': 'the message catalog, codec, and validators',
  'js/kernel/core/domain/': 'the domain rules',
  'js/kernel/core/intelligence/': "#7's intelligence domain: records, rules, use cases, and the view model",
  'js/kernel/core/messaging/': 'the router, the client, and their parts',
  'js/kernel/core/ports/': 'the contracts, each in PORTS or WITHOUT_SUITE',
  'js/kernel/composition/': 'the composition roots',
  'js/kernel/registry/': 'the registry kit',
});

/**
 * Modules that implement no port themselves: each is part of the implementations it names,
 * which load it, and its behavior is checked through their runs.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const HELPERS = Object.freeze({
  // #17 PR 2a's conflict records and note versions, which only #17's adapter writes
  'js/kernel/adapters/indexeddb/conflicts.js': ['js/kernel/adapters/indexeddb/adapter.js'],
  'js/kernel/adapters/indexeddb/connection.js': ['js/kernel/adapters/indexeddb/adapter.js'],
  // #17 PR 2b's tombstones: the adapter completes them, and the purge reads and marks them
  'js/kernel/adapters/indexeddb/deletion.js': [
    'js/kernel/adapters/indexeddb/adapter.js',
    'js/kernel/adapters/indexeddb/purge.js',
  ],
  'js/kernel/adapters/indexeddb/failures.js': [
    'js/kernel/adapters/indexeddb/adapter.js',
    'js/kernel/adapters/indexeddb/changes.js',
    'js/kernel/adapters/indexeddb/ledger.js',
  ],
  'js/kernel/adapters/indexeddb/requests.js': [
    'js/kernel/adapters/indexeddb/adapter.js',
    'js/kernel/adapters/indexeddb/changes.js',
    'js/kernel/adapters/indexeddb/ledger.js',
    'js/kernel/adapters/legacy/adapter.js',
  ],
  'js/kernel/adapters/indexeddb/schema.js': [
    'js/kernel/adapters/indexeddb/adapter.js',
    'js/kernel/adapters/legacy/adapter.js',
  ],
  'js/kernel/adapters/indexeddb/settings.js': [
    'js/kernel/adapters/indexeddb/adapter.js',
    'js/kernel/adapters/legacy/adapter.js',
  ],
  'js/kernel/adapters/indexeddb/versions.js': ['js/kernel/adapters/indexeddb/adapter.js'],
  // The digest #17's ledger keeps too, so a command is the same command on every adapter
  'js/kernel/core/memory/fingerprint.js': [
    'js/kernel/core/memory/adapter.js',
    'js/kernel/core/memory/ledger.js',
    'js/kernel/adapters/indexeddb/adapter.js',
    'js/kernel/adapters/indexeddb/ledger.js',
  ],
});

/**
 * Modules that hand out a port's implementations without being one: a root choosing a
 * transport, a test fixture opening an adapter for its runs. Each names the port and the
 * implementations it loads.
 * @type {Readonly<Record<string, {port: string, of: readonly string[]}>>}
 */
export const COMPOSERS = Object.freeze({
  'js/kernel/composition/messaging.js': {
    port: 'messaging-transport',
    of: ['js/kernel/core/messaging/in-process.js', 'js/kernel/adapters/messaging/runtime-port.js'],
  },
  // #20 slice 1b: a context's failure events, on NewTabNoteTrust (js/kernel/composition/
  // lazy-failure-events.js, the new tab's, only imports this one and composes nothing itself)
  'js/kernel/composition/trust.js': { port: 'trust-store', of: ['js/kernel/adapters/indexeddb/trust.js'] },
  'test/kernel/legacy-fixture.mjs': { port: 'kernel-adapter', of: ['js/kernel/adapters/legacy/adapter.js'] },
  'test/kernel/storage-fixture.mjs': { port: 'kernel-adapter', of: ['js/kernel/adapters/indexeddb/adapter.js'] },
  'test/kernel/trust-support.mjs': { port: 'trust-store', of: ['js/kernel/adapters/indexeddb/trust.js'] },
});

/**
 * Modules under js/kernel/ that are the only implementation of what they implement, which no
 * contract in js/kernel/core/ports/ defines, so there's nothing to share a suite with: each
 * names that interface and the test that covers it. A second implementation of one fails the
 * check until it's classified, and the PR that adds it moves the interface to PORTS.
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
  // #7 slice 2's IndexedDB stores are the second, and move IntelligenceRepository to PORTS
  'js/kernel/core/memory/intelligence.js': {
    implements: 'IntelligenceRepository (js/kernel/core/intelligence/repository.js), in memory',
    tests: 'test/kernel/intelligence-records.test.mjs',
  },
  // #17 PR 1a's migration framework, which the service worker's root runs since PR 1b (and the
  // new tab's reads, for its pre-update copy); one runner, one recovery database, one registry,
  // so nothing to share a suite with
  'js/kernel/adapters/indexeddb/migrate.js': {
    implements: "#17's migration runner (startMigrations, runMigrations), under Web Lock storage.migrate",
    tests: 'test/kernel/storage-migrate.test.mjs',
  },
  'js/kernel/adapters/indexeddb/registry.js': {
    implements: "#17's sequential migration registry and step 9",
    tests: 'test/kernel/storage-migrate.test.mjs',
  },
  'js/kernel/adapters/indexeddb/shapes.js': {
    implements: "#17's shape detection for CanvasTabDB",
    tests: 'test/kernel/storage-migrate.test.mjs',
  },
  'js/kernel/adapters/indexeddb/space.js': {
    implements: "#17's space check before a recovery point",
    tests: 'test/kernel/storage-migrate.test.mjs',
  },
  // #20 slice 2's IndexedDB reads for its health providers, which no shipped root loads yet;
  // each is the one reader of what it reads, so nothing to share a suite with
  'js/kernel/adapters/indexeddb/health.js': {
    implements: "#20's recovery reader (RecoveryReader) and vectors reader, over NewTabNoteRecovery and CanvasTabDB",
    tests: 'test/kernel/trust-recovery-readiness.test.mjs',
  },
  'js/kernel/adapters/indexeddb/legacy-secrets.js': {
    implements: "#20's legacy secret reader (SecretReader), present or absent and never the value",
    tests: 'test/kernel/trust-secrets.test.mjs',
  },
  'js/kernel/adapters/indexeddb/recovery-points.js': {
    implements: "#17's verified recovery points in NewTabNoteRecovery",
    tests: 'test/kernel/storage-recovery-points.test.mjs',
  },
  'js/kernel/adapters/indexeddb/records.js': {
    implements: "#17's record, set, and content hashes for recovery points",
    tests: 'test/kernel/storage-recovery-points.test.mjs',
  },
  'js/kernel/adapters/indexeddb/legacy-export.js': {
    implements: "#17's export of a pre-migration point as 1.4.1's import file",
    tests: 'test/kernel/storage-legacy-export.test.mjs',
  },
  // #17 PR 2b: the one purge of the one recovery database, driven by tombstones
  'js/kernel/adapters/indexeddb/purge.js': {
    implements: "#17's recovery-point purge (purgeRecoveryPoints), under Web Lock storage.migrate",
    tests: 'test/kernel/storage-purge.test.mjs',
  },
});

/**
 * Implementations that run no suite, each with the issue that removes it and why it can wait.
 * `within` scopes the exemption to the top-level statement of the file that holds that text,
 * so a second implementation elsewhere in the file is still caught. The check fails once the
 * exempt one is gone, so the entry goes with it.
 * @type {Readonly<Record<string, {port: string, within: string, owner: string, reason: string}>>}
 */
export const EXEMPT = Object.freeze({
  'js/storage.js': {
    port: 'chrome-storage-local',
    within: 'chrome_mock_',
    owner: '#17',
    reason:
      'the localStorage stand-in for chrome.storage when a page runs from file://, which a packaged ' +
      "extension never reaches. #17 removes it, and #28's build-to scope defers deleting it here.",
  },
});
