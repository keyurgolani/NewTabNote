/**
 * Each health provider's static row (#20 slice 4c): its id, its health group, whether it's core,
 * and where it runs. A status page groups the records' receipts and incidents by these rows
 * (summary.js) and never imports catalog.js, whose descriptors load each check with import(), so
 * a page that only shows status puts no check in its graph. catalog.js builds its descriptors
 * from these rows, so the two can't differ.
 *
 * In the catalog's order, which in each group is its rank order, the order the registry browses
 * a group in (resolve.js), so a page that reads the rows breaks a tie in a group as
 * trust.summary does.
 *
 * Nothing here is imported: a page loads this module and no other with it.
 */

/** @typedef {import('../vocabulary.js').HealthGroup} HealthGroup */

/**
 * @typedef {object} ProviderRow
 * @property {string} id
 * @property {HealthGroup} group
 * @property {boolean} core - capture and storage, the two the core status reads
 * @property {readonly ('workspace' | 'recovery')[]} hosts - the roots it runs on
 */

/**
 * Where a provider runs: the new tab, and recovery.html (#20 slice 4b), whose Trust Center has a
 * row, a label and titles for every provider that runs there (test/kernel/recovery-surface.test.mjs)
 */
const ON_PAGES = Object.freeze(/** @type {const} */ (['workspace', 'recovery']));

/**
 * @param {string} id
 * @param {HealthGroup} group
 * @param {{core?: boolean, hosts?: readonly ('workspace' | 'recovery')[]}} [options] - `hosts`: the
 *   new tab and recovery.html unless it says otherwise
 * @returns {Readonly<ProviderRow>}
 */
const row = (id, group, { core = false, hosts = ON_PAGES } = {}) =>
  Object.freeze({ id, group, core, hosts: Object.freeze([...hosts]) });

/** @type {readonly Readonly<ProviderRow>[]} */
export const PROVIDER_ROWS = Object.freeze([
  // Where notes live: capture and storage (core), then recovery readiness
  row('capture', 'storage', { core: true }),
  row('storage', 'storage', { core: true }),
  row('recovery-readiness', 'recovery'),
  // What protects them: backup, sync, credentials
  row('backup', 'backup'),
  row('sync', 'sync'),
  row('credentials', 'vault'),
  // What can leave: permissions and destinations, AI scope grants, remote AI
  row('permissions', 'permissions'),
  row('ai-scope-grants', 'permissions'),
  row('remote-ai', 'inference'),
  // What runs on notes: local inference, the index, and the platform
  row('local-inference', 'inference'),
  row('index', 'indexing'),
  // Not on recovery.html yet: its row and words come with the slice that first shows it, through
  // the design review, and the page's surface doesn't carry system.coordinatorHealth
  row('coordinator', 'platform', { hosts: ['workspace'] }),
  row('messaging', 'platform'),
  row('contributions', 'platform'),
  row('block-types', 'platform'),
]);
