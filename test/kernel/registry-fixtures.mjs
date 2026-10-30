// Fixture families for #15's registry kit (slice 1): four made-up families, shaped like the
// real ones slices 2 to 4 add, that between them use every rule the kit has. Commands bind
// chords and run in the service worker, navigation has path ids and no loaders, providers
// reach a destination and have placeholders and probes, and producers ask for AI scopes and
// require a conformance fixture. None is a real family, and nothing here is wired to a page.

import { defineFamily } from '../../js/kernel/registry/family.js';

/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */

/** @param {unknown} value */
const isContexts = value =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(context => ['global', 'editor', 'selection'].includes(context));

export const commands = defineFamily({
  id: 'fixture-commands',
  apiVersion: 1,
  groups: ['navigate', 'create', 'edit', 'view', 'trust'],
  ceilings: { chromePermissions: ['contextMenus'] },
  chords: true,
  requireDescription: true,
  fields: { contexts: isContexts },
});

/** @type {Descriptor[]} */
export const commandBuiltIns = [
  {
    id: 'open-palette',
    version: 1,
    apiVersion: 1,
    group: 'navigate',
    rank: 10,
    hosts: ['workspace', 'pip'],
    label: 'Open command palette',
    description: 'Search commands and notes.',
    keywords: ['search', 'commands'],
    chords: { default: ['Mod+K'] },
    contexts: ['global', 'editor'],
    implementation: { run: () => 'palette' },
  },
  {
    id: 'new-note',
    version: 1,
    apiVersion: 1,
    group: 'create',
    rank: 10,
    hosts: ['workspace'],
    label: 'New note',
    description: 'Start a blank note.',
    chords: { default: ['Alt+N'] },
    contexts: ['global'],
    load: async () => ({ run: () => 'new' }),
  },
  {
    id: 'toggle-sidebar',
    version: 2,
    apiVersion: 1,
    group: 'view',
    rank: 10,
    hosts: ['workspace'],
    label: 'Toggle sidebar',
    description: 'Show or hide the sidebar.',
    chords: { default: ['Mod+Backslash'], mac: ['Mod+Alt+Backslash'] },
    contexts: ['global'],
    accessibility: { keyboard: 'Works from anywhere but text fields.' },
    load: async () => ({ run: () => 'sidebar' }),
  },
  {
    id: 'capture-page',
    version: 1,
    apiVersion: 1,
    group: 'create',
    rank: 20,
    hosts: ['background'],
    label: 'Capture page',
    description: "Save the current page to today's note.",
    contexts: ['global'],
    chromePermissions: ['contextMenus'],
    implementation: { run: () => 'capture' },
  },
];

/**
 * @param {string} id
 * @param {number} rank
 * @returns {Descriptor}
 */
/**
 * A command that needs another family's contribution, so its family's conformance run has to
 * resolve it with navigation alongside
 * @type {Descriptor}
 */
export const openSettings = {
  id: 'open-settings',
  version: 1,
  apiVersion: 1,
  group: 'navigate',
  rank: 20,
  hosts: ['workspace'],
  requires: ['fixture-navigation:settings'],
  label: 'Open settings',
  description: 'Go to settings.',
  contexts: ['global'],
  implementation: { run: () => 'settings' },
};
commandBuiltIns.push(openSettings);

export const commandSample = (id, rank) => ({
  id,
  version: 1,
  apiVersion: 1,
  group: 'edit',
  rank,
  hosts: ['workspace'],
  label: `Sample ${id}`,
  description: 'A sample command.',
  contexts: ['editor'],
  implementation: { run: () => id },
});

export const navigation = defineFamily({
  id: 'fixture-navigation',
  apiVersion: 1,
  groups: ['rail', 'route'],
  hosts: ['workspace', 'pip'],
  pathIds: true,
  loader: 'none',
  fields: {
    placement: value => ['rail', 'collection', 'route', 'command-only'].includes(/** @type {string} */ (value)),
    parentId: value => value === undefined || typeof value === 'string',
  },
});

/** @type {Descriptor[]} */
export const navigationBuiltIns = [
  {
    id: 'settings',
    version: 1,
    apiVersion: 1,
    group: 'rail',
    rank: 30,
    hosts: ['workspace'],
    label: 'Settings',
    icon: 'settings',
    placement: 'rail',
    accessibility: { landmark: 'navigation' },
  },
  {
    id: 'settings/general',
    version: 1,
    apiVersion: 1,
    group: 'rail',
    rank: 31,
    hosts: ['workspace'],
    requires: ['settings'],
    label: 'General',
    placement: 'collection',
    parentId: 'settings',
  },
  {
    id: 'archive',
    version: 1,
    apiVersion: 1,
    group: 'route',
    rank: 10,
    hosts: ['workspace', 'pip'],
    label: 'Archive',
    placement: 'route',
  },
];

/**
 * @param {string} id
 * @param {number} rank
 * @returns {Descriptor}
 */
export const navigationSample = (id, rank) => ({
  id,
  version: 1,
  apiVersion: 1,
  group: 'route',
  rank: 100 + rank,
  hosts: ['workspace'],
  label: `Sample ${id}`,
  placement: 'route',
});

export const providers = defineFamily({
  id: 'fixture-providers',
  apiVersion: 2,
  groups: ['transport'],
  hosts: ['workspace', 'sidepanel'],
  loader: 'required',
  ceilings: { destinations: ['webdav-server'] },
  reasons: {
    offline: {
      state: 'temporarily-unavailable',
      message: "You're offline.",
      remediation: 'Reconnect, then try again.',
    },
    'needs-server': {
      state: 'needs-setup',
      message: 'Needs a server address.',
      remediation: 'Add the server in setup.',
    },
  },
});

/** @type {Descriptor[]} */
export const providerBuiltIns = [
  {
    id: 'webdav',
    version: 1,
    apiVersion: 2,
    group: 'transport',
    rank: 10,
    hosts: ['workspace', 'sidepanel'],
    label: 'WebDAV',
    destinations: ['webdav-server'],
    // Availability from configuration and a verified operation, both injected by the root
    probe: async context => {
      if (!context.configured) return { state: 'needs-setup', reason: 'needs-server' };
      if (!context.online) return { state: 'temporarily-unavailable', reason: 'offline' };
      return { state: 'enabled' };
    },
    load: async () => ({ connect: () => true }),
  },
  {
    id: 'gdrive',
    version: 1,
    apiVersion: 2,
    group: 'transport',
    rank: 20,
    hosts: ['workspace', 'sidepanel'],
    label: 'Google Drive',
    notImplemented: true,
  },
  {
    id: 'dropbox',
    version: 1,
    apiVersion: 2,
    group: 'transport',
    rank: 30,
    hosts: ['workspace', 'sidepanel'],
    label: 'Dropbox',
    notImplemented: true,
  },
];

/**
 * @param {string} id
 * @param {number} rank
 * @returns {Descriptor}
 */
export const providerSample = (id, rank) => ({
  id,
  version: 1,
  apiVersion: 2,
  group: 'transport',
  rank: 100 + rank,
  hosts: ['workspace'],
  label: `Sample ${id}`,
  load: async () => ({ connect: () => true }),
});

export const producers = defineFamily({
  id: 'fixture-producers',
  apiVersion: 1,
  groups: ['cards'],
  hosts: ['workspace', 'sidepanel', 'pip'],
  ceilings: { aiScopes: ['metadata', 'current-note'] },
  fixtures: ['sample-note'],
});

/** @type {Descriptor[]} */
export const producerBuiltIns = [
  {
    id: 'word-count',
    version: 1,
    apiVersion: 1,
    group: 'cards',
    rank: 10,
    hosts: ['workspace', 'sidepanel'],
    label: 'Word count',
    aiScopes: ['metadata'],
    fixtures: ['sample-note'],
    load: async () => ({ produce: (/** @type {{words: number}} */ note) => note.words }),
  },
  {
    id: 'summary',
    version: 1,
    apiVersion: 1,
    group: 'cards',
    rank: 20,
    hosts: ['workspace'],
    requires: ['word-count'],
    label: 'Summary',
    aiScopes: ['current-note'],
    fixtures: ['sample-note'],
    load: async () => ({ produce: (/** @type {{words: number}} */ note) => (note.words > 0 ? 'summary' : '') }),
  },
];

/**
 * @param {string} id
 * @param {number} rank
 * @returns {Descriptor}
 */
export const producerSample = (id, rank) => ({
  id,
  version: 1,
  apiVersion: 1,
  group: 'cards',
  rank: 100 + rank,
  hosts: ['workspace'],
  label: `Sample ${id}`,
  aiScopes: ['metadata'],
  fixtures: ['sample-note'],
  load: async () => ({ produce: () => 0 }),
});

export const workers = defineFamily({
  id: 'fixture-workers',
  apiVersion: 1,
  groups: ['listeners'],
  hosts: ['background'],
  ceilings: { chromePermissions: ['contextMenus'] },
});

/** @type {Descriptor[]} */
export const workerBuiltIns = [
  {
    id: 'context-menus',
    version: 1,
    apiVersion: 1,
    group: 'listeners',
    rank: 10,
    hosts: ['background'],
    label: 'Context menus',
    chromePermissions: ['contextMenus'],
    probe: () => ({ state: 'enabled' }),
    implementation: { register: () => true },
  },
];

/**
 * @param {string} id
 * @param {number} rank
 * @returns {Descriptor}
 */
export const workerSample = (id, rank) => ({
  id,
  version: 1,
  apiVersion: 1,
  group: 'listeners',
  rank: 100 + rank,
  hosts: ['background'],
  label: `Sample ${id}`,
  implementation: { register: () => true },
});

/**
 * Every fixture family, with its built-ins and sample, and the families its built-ins need
 * beside it
 */
export const FIXTURE_FAMILIES = Object.freeze([
  {
    family: commands,
    builtIns: commandBuiltIns,
    sample: commandSample,
    alongside: /** @type {[import('../../js/kernel/registry/family.js').Family, readonly Descriptor[]][]} */ ([
      [navigation, navigationBuiltIns],
    ]),
  },
  { family: navigation, builtIns: navigationBuiltIns, sample: navigationSample },
  { family: providers, builtIns: providerBuiltIns, sample: providerSample },
  { family: producers, builtIns: producerBuiltIns, sample: producerSample },
  { family: workers, builtIns: workerBuiltIns, sample: workerSample },
]);
