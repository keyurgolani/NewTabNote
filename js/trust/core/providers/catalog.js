/**
 * Slice 2's health providers (#20, "Providers"), as `health` family descriptors on #15's kit:
 * the real ones, which verify by a real operation, and the interim ones, which read only
 * legacy facts and never record `verified` (legacy.js). Each descriptor is static data, and
 * its check loads lazily, so a page that only reads stored receipts loads none of them.
 *
 * No shipped root registers these yet: a test or a root registers PROVIDERS on a `workspace`
 * root with `health`, and passes the ports each check reads (context.js) as the registry
 * context. Slice 4's Trust page and #35's coordinator are the first roots.
 *
 * Every provider is owned by #20, which builds it; the interim ones name, in INTERIM, the
 * issue whose real provider replaces each. Each lists in `observes` the faults its check can
 * see, so an answer that no longer reports one resolves its incident; a provider that only
 * reads settings observes none, and none observes `write-failed`, the records' own. Storage
 * observes `open-failed` for CanvasTabDB only.
 */

/** @typedef {import('../../../kernel/registry/validate.js').Descriptor} Descriptor */
/** @typedef {import('../vocabulary.js').HealthGroup} HealthGroup */
/** @typedef {import('../vocabulary.js').CostClass} CostClass */
/** @typedef {import('../vocabulary.js').Trigger} Trigger */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a cheap check may take, and an expensive one (families.js caps both at a minute) */
const CHEAP_TIMEOUT_MS = 5000;
const EXPENSIVE_TIMEOUT_MS = 60_000;

/** @type {readonly Trigger[]} */
const CHEAP = Object.freeze(['open', 'verify-now', 'idle']);
/** @type {readonly Trigger[]} */
const EXPENSIVE = Object.freeze(['verify-now', 'idle']);

/**
 * @param {{
 *   id: string,
 *   group: HealthGroup,
 *   rank: number,
 *   label: string,
 *   operation: string,
 *   costClass?: CostClass,
 *   freshnessMs: number,
 *   triggers?: readonly Trigger[],
 *   observes: readonly string[],
 *   remediations?: readonly string[],
 *   core?: boolean,
 *   load: () => Promise<unknown>,
 * }} fields
 * @returns {Descriptor}
 */
function provider({ costClass = 'local-cheap', triggers, remediations, core, ...fields }) {
  /** @type {Descriptor} */
  const descriptor = {
    ...fields,
    version: 1,
    apiVersion: 1,
    hosts: ['workspace'],
    owner: 20,
    costClass,
    timeoutMs: costClass === 'local-cheap' ? CHEAP_TIMEOUT_MS : EXPENSIVE_TIMEOUT_MS,
    triggers: triggers || (costClass === 'local-cheap' ? CHEAP : EXPENSIVE),
    fixtures: ['truthful-receipt'],
  };
  if (remediations) descriptor.remediations = remediations;
  if (core) descriptor.core = true;
  return Object.freeze(descriptor);
}

/** @type {readonly Descriptor[]} */
export const PROVIDERS = Object.freeze([
  // Where notes live: capture and storage (core), then recovery readiness
  provider({
    id: 'capture',
    group: 'storage',
    rank: 10,
    label: 'Capture',
    operation: 'capture.probe-commit',
    observes: ['quota', 'version-too-new', 'probe-failed'],
    freshnessMs: DAY,
    triggers: [...CHEAP, 'storage-restored'],
    remediations: ['retry-open'],
    core: true,
    load: async () => (await import('./probe.js')).capture,
  }),
  provider({
    id: 'storage',
    group: 'storage',
    rank: 20,
    label: 'Storage',
    operation: 'storage.probe-readwrite',
    observes: ['quota', 'version-too-new', 'probe-failed', 'open-failed'],
    freshnessMs: DAY,
    triggers: [...CHEAP, 'storage-restored'],
    remediations: ['retry-open', 'save-salvage-file'],
    core: true,
    load: async () => (await import('./probe.js')).storage,
  }),
  provider({
    id: 'recovery-readiness',
    group: 'recovery',
    rank: 10,
    label: 'Recovery points',
    operation: 'recovery.verify-newest-points',
    observes: ['point-unverified'],
    costClass: 'local-expensive',
    freshnessMs: 7 * DAY,
    triggers: [...EXPENSIVE, 'storage-restored'],
    load: async () => (await import('./recovery-readiness.js')).recoveryReadiness,
  }),
  // What protects them: backup, sync, credentials (interim)
  provider({
    id: 'backup',
    group: 'backup',
    rank: 10,
    label: 'Backup',
    operation: 'backup.read-legacy-settings',
    observes: [],
    freshnessMs: DAY,
    load: async () => (await import('./legacy.js')).backup,
  }),
  provider({
    id: 'sync',
    group: 'sync',
    rank: 10,
    label: 'Sync',
    operation: 'sync.read-legacy-settings',
    observes: [],
    freshnessMs: DAY,
    load: async () => (await import('./legacy.js')).sync,
  }),
  provider({
    id: 'credentials',
    group: 'vault',
    rank: 10,
    label: 'Saved keys',
    operation: 'credentials.find-legacy-secrets',
    observes: ['legacy-secret'],
    freshnessMs: DAY,
    remediations: ['remove-saved-key'],
    load: async () => (await import('./legacy.js')).credentials,
  }),
  // What can leave: permissions and destinations (real), AI scope grants and remote AI (interim)
  provider({
    id: 'permissions',
    group: 'permissions',
    rank: 10,
    label: 'Permissions and destinations',
    operation: 'permissions.compare-manifest',
    observes: ['grant-missing', 'permission-changed'],
    freshnessMs: DAY,
    triggers: [...CHEAP, 'permissions-changed'],
    load: async () => (await import('./permissions.js')).permissions,
  }),
  provider({
    id: 'ai-scope-grants',
    group: 'permissions',
    rank: 20,
    label: 'AI scope grants',
    operation: 'ai-scope-grants.read-grants',
    observes: [],
    freshnessMs: DAY,
    load: async () => (await import('./legacy.js')).aiScopeGrants,
  }),
  provider({
    id: 'remote-ai',
    group: 'inference',
    rank: 10,
    label: 'Remote AI',
    operation: 'remote-ai.read-legacy-settings',
    observes: [],
    freshnessMs: DAY,
    load: async () => (await import('./legacy.js')).remoteAi,
  }),
  // What runs on notes: local inference (interim), the index, and the platform (real)
  provider({
    id: 'local-inference',
    group: 'inference',
    rank: 20,
    label: 'Local model',
    operation: 'local-inference.read-load-history',
    observes: ['load-failed'],
    costClass: 'local-expensive',
    freshnessMs: DAY,
    remediations: ['safe-disable'],
    load: async () => (await import('./legacy.js')).localInference,
  }),
  provider({
    id: 'index',
    group: 'indexing',
    rank: 10,
    label: 'Index and derived data',
    operation: 'index.measure-lag',
    observes: ['lagging', 'stalled'],
    freshnessMs: HOUR,
    remediations: ['rebuild-index'],
    load: async () => (await import('./index-lag.js')).indexLag,
  }),
  provider({
    id: 'coordinator',
    group: 'platform',
    rank: 5,
    label: 'Background coordinator',
    operation: 'coordinator.query-health',
    observes: ['start-failed', 'unreachable'],
    freshnessMs: HOUR,
    load: async () => (await import('./platform.js')).coordinator,
  }),
  provider({
    id: 'messaging',
    group: 'platform',
    rank: 10,
    label: 'Messaging',
    operation: 'messaging.query-health',
    observes: ['unreachable'],
    freshnessMs: HOUR,
    load: async () => (await import('./platform.js')).messaging,
  }),
  provider({
    id: 'contributions',
    group: 'platform',
    rank: 20,
    label: 'Contributions',
    operation: 'contributions.read-resolution-report',
    observes: ['contribution-unavailable'],
    freshnessMs: DAY,
    load: async () => (await import('./platform.js')).contributions,
  }),
  provider({
    id: 'block-types',
    group: 'platform',
    rank: 30,
    label: 'Block types',
    operation: 'block-types.read-resolution-report',
    observes: ['contribution-unavailable'],
    freshnessMs: DAY,
    load: async () => (await import('./platform.js')).blockTypes,
  }),
]);

/**
 * The interim providers, each with the issue whose real provider replaces it, which deletes
 * the interim one when it registers (#20, "Providers")
 */
export const INTERIM = Object.freeze({
  backup: 18,
  sync: 19,
  credentials: 21,
  'ai-scope-grants': 21,
  'remote-ai': 11,
  'local-inference': 9,
});

/** The real providers: every other one */
export const REAL = Object.freeze(
  PROVIDERS.map(descriptor => descriptor.id).filter(id => !Object.prototype.hasOwnProperty.call(INTERIM, id)),
);
