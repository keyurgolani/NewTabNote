'use strict';

// Feature-parity inventory (#1 slice 3): docs/product/feature-parity.json gives every
// 1.4.0 feature exactly one home in the Continuity Canvas, and an owner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INVENTORY_PATH = path.join(__dirname, '..', 'docs', 'product', 'feature-parity.json');

// editor-core, one ID per feature in the parity table of docs/product/continuity-canvas.md
// (a row naming four features has four), and one per export and import format. Fixed on
// purpose: a feature leaves this list only when the record's table drops it.
const REQUIRED_IDS = [
  'editor-core',
  'document-tabs', 'split-view',
  'picture-in-picture',
  'focus-mode',
  'templates', 'daily-notes', 'calendar', 'daily-note-template',
  'command-palette', 'shortcuts-list',
  'save-status',
  'folders', 'pin', 'sort', 'list-or-cards', 'bulk-actions', 'drag-block-to-sidebar',
  'notes-list', 'new-note', 'sidebar-toggle',
  'resizable-sidebar', 'resizable-ai-sidebar',
  'archive', 'trash', 'trash-retention', 'empty-trash',
  'version-history', 'backlinks', 'graph', 'analytics',
  'keyword-search', 'semantic-search',
  'note-chat', 'context-window-indicator', 'block-ai', 'ai-insert-preview', 'insights-panel',
  'generate-title', 'note-insights',
  'global-chat',
  'auto-title-scheduler', 'insights-scheduler',
  'ai-provider-settings', 'prompt-template-editor',
  'themes', 'font', 'editor-width', 'theme-builder',
  'settings-navigation', 'settings-search',
  'export-json', 'export-markdown-zip', 'export-backup', 'import-json', 'auto-backup',
  'webdav-sync',
  'export-note-json', 'export-note-markdown', 'import-note-json', 'import-note-markdown',
  'onboarding-walkthrough', 'welcome-note', 'quick-start-prompt',
  'popup-quick-note', 'popup-daily-summary', 'popup-recent-notes',
  'sidepanel-insights',
  'capture-page', 'capture-selection',
];

const FORMAT_IDS = [
  'export-json', 'export-backup', 'export-markdown-zip', 'export-note-json',
  'export-note-markdown', 'import-json', 'import-note-json', 'import-note-markdown',
];

const HOME_KINDS = [
  'rail', 'collection-view', 'inspector', 'canvas-mode', 'canvas-action', 'route', 'settings-route',
  'top-line', 'moment', 'both-apertures', 'popup', 'side-panel', 'background',
];
const STATUSES = ['mapped', 'owner-question'];
const INVENTORY_KEYS = ['about', 'features'];
const ENTRY_KEYS = ['id', 'home', 'owner', 'status'];
const HOME_KEYS = ['kind', 'id'];
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Every way a parsed inventory breaks the rules, as messages; empty when it follows them
 */
function inventoryProblems(inventory, requiredIds = REQUIRED_IDS) {
  if (!isRecord(inventory) || !Array.isArray(inventory.features)) {
    return ['the inventory has to be an object with a `features` array'];
  }
  const problems = Object.keys(inventory).filter(key => !INVENTORY_KEYS.includes(key)).map(key => `unknown key \`${key}\``);
  const seen = new Set();

  inventory.features.forEach((entry, index) => {
    const name = isRecord(entry) && typeof entry.id === 'string' ? entry.id : `features[${index}]`;
    const problem = message => problems.push(`${name}: ${message}`);
    if (!isRecord(entry)) {
      problem('has to be an object');
      return;
    }

    Object.keys(entry).filter(key => !ENTRY_KEYS.includes(key)).forEach(key => problem(`unknown key \`${key}\``));
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) {
      problem('`id` has to be lowercase words joined by hyphens');
    } else if (seen.has(entry.id)) {
      problem('is listed again, which gives it a second home');
    } else if (!requiredIds.includes(entry.id)) {
      problem('isn\'t in requiredIds, so add it to the record\'s parity table and the list together');
    }
    seen.add(entry.id);

    if (entry.home === undefined || entry.home === null) {
      problem('has no home');
    } else if (Array.isArray(entry.home)) {
      problem('has more than one home');
    } else if (!isRecord(entry.home)) {
      problem('`home` has to be one {kind, id} object');
    } else {
      Object.keys(entry.home).filter(key => !HOME_KEYS.includes(key)).forEach(key => problem(`unknown home key \`${key}\``));
      if (!HOME_KINDS.includes(entry.home.kind)) problem(`unknown home kind ${JSON.stringify(entry.home.kind)}`);
      if (typeof entry.home.id !== 'string' || entry.home.id.trim() === '') problem('`home.id` has to name the place');
    }

    const owner = entry.owner;
    if (!Array.isArray(owner) || owner.length === 0) {
      problem('has no owner');
    } else if (!owner.every(issue => Number.isInteger(issue) && issue > 0) || new Set(owner).size !== owner.length) {
      problem('`owner` has to list distinct issue numbers');
    }

    if (entry.status === 'removed') problem('is removed, and every baseline feature keeps a home');
    else if (!STATUSES.includes(entry.status)) problem(`unknown status ${JSON.stringify(entry.status)}`);
  });

  requiredIds.filter(id => !seen.has(id)).forEach(id => problems.push(`${id}: is absent`));
  return problems;
}

function committedInventory() {
  return JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
}

/** The committed inventory with one entry changed, or removed when change returns undefined */
function withEntry(id, change) {
  const inventory = committedInventory();
  inventory.features = inventory.features.flatMap(entry => {
    if (entry.id !== id) return [entry];
    const changed = change(structuredClone(entry));
    return changed === undefined ? [] : [changed];
  });
  return inventory;
}

test('AC9: the committed inventory gives every baseline feature exactly one home and an owner', () => {
  const inventory = committedInventory();
  assert.deepEqual(inventoryProblems(inventory), []);
  assert.deepEqual(inventory.features.map(entry => entry.id).sort(), [...REQUIRED_IDS].sort());
});

test('requiredIds names each feature once, with editor-core and the eight format IDs', () => {
  assert.equal(new Set(REQUIRED_IDS).size, REQUIRED_IDS.length);
  assert.ok(REQUIRED_IDS.includes('editor-core'));
  for (const id of FORMAT_IDS) assert.ok(REQUIRED_IDS.includes(id), id);
});

test('every home kind in the closed list has a feature, and owner-question entries wait on Q2 or Q4', () => {
  const inventory = committedInventory();
  assert.deepEqual([...new Set(inventory.features.map(entry => entry.home.kind))].sort(), [...HOME_KINDS].sort());
  const waiting = inventory.features.filter(entry => entry.status === 'owner-question').map(entry => entry.id).sort();
  // Q2: Unfiled and folders under Projects. Q4: Picture-in-Picture, Trash, "Ask across notes".
  assert.deepEqual(waiting, ['empty-trash', 'folders', 'global-chat', 'notes-list', 'picture-in-picture', 'trash']);
});

test('fails on an absent requiredIds entry', () => {
  assert.deepEqual(inventoryProblems(withEntry('webdav-sync', () => undefined)), ['webdav-sync: is absent']);
  assert.deepEqual(inventoryProblems(withEntry('editor-core', () => undefined)), ['editor-core: is absent']);
  const inventory = committedInventory();
  inventory.features = inventory.features.filter(entry => !FORMAT_IDS.includes(entry.id));
  const absent = REQUIRED_IDS.filter(id => FORMAT_IDS.includes(id)).map(id => `${id}: is absent`);
  assert.equal(absent.length, 8);
  assert.deepEqual(inventoryProblems(inventory), absent);
});

test('fails on a missing home', () => {
  assert.deepEqual(inventoryProblems(withEntry('graph', ({ home, ...entry }) => entry)), ['graph: has no home']);
  assert.deepEqual(inventoryProblems(withEntry('graph', entry => ({ ...entry, home: null }))), ['graph: has no home']);
  assert.deepEqual(inventoryProblems(withEntry('graph', entry => ({ ...entry, home: 'route' }))),
    ['graph: `home` has to be one {kind, id} object']);
  assert.deepEqual(inventoryProblems(withEntry('graph', entry => ({ ...entry, home: { kind: 'route', id: '' } }))),
    ['graph: `home.id` has to name the place']);
});

test('fails on a duplicate home', () => {
  const twoHomes = withEntry('focus-mode', entry => ({
    ...entry,
    home: [{ kind: 'canvas-mode', id: 'focus' }, { kind: 'moment', id: 'focus' }],
  }));
  assert.deepEqual(inventoryProblems(twoHomes), ['focus-mode: has more than one home']);

  const listedTwice = committedInventory();
  listedTwice.features.push({ id: 'focus-mode', home: { kind: 'moment', id: 'canvas' }, owner: [2], status: 'mapped' });
  assert.deepEqual(inventoryProblems(listedTwice), ['focus-mode: is listed again, which gives it a second home']);
});

test('fails on an unknown home kind', () => {
  for (const kind of ['sidebar', 'Rail', 'settings', '', undefined]) {
    const problems = inventoryProblems(withEntry('analytics', entry => ({ ...entry, home: { kind, id: 'analytics' } })));
    assert.deepEqual(problems, [`analytics: unknown home kind ${JSON.stringify(kind)}`], String(kind));
  }
});

test('fails on a missing owner', () => {
  assert.deepEqual(inventoryProblems(withEntry('trash', ({ owner, ...entry }) => entry)), ['trash: has no owner']);
  assert.deepEqual(inventoryProblems(withEntry('trash', entry => ({ ...entry, owner: [] }))), ['trash: has no owner']);
  for (const owner of [['#3'], [0], [3, 3], [3.5]]) {
    assert.deepEqual(inventoryProblems(withEntry('trash', entry => ({ ...entry, owner }))),
      ['trash: `owner` has to list distinct issue numbers'], JSON.stringify(owner));
  }
});

test('fails on a removed status, or any status but mapped and owner-question', () => {
  assert.deepEqual(inventoryProblems(withEntry('onboarding-walkthrough', entry => ({ ...entry, status: 'removed' }))),
    ['onboarding-walkthrough: is removed, and every baseline feature keeps a home']);
  for (const status of ['replaced', 'Mapped', undefined]) {
    assert.deepEqual(inventoryProblems(withEntry('onboarding-walkthrough', entry => ({ ...entry, status }))),
      [`onboarding-walkthrough: unknown status ${JSON.stringify(status)}`], String(status));
  }
});

test('fails on an ID requiredIds doesn\'t name, a malformed ID, or an unknown key', () => {
  const extra = committedInventory();
  extra.features.push({ id: 'reading-time', home: { kind: 'inspector', id: 'properties' }, owner: [3], status: 'mapped' });
  assert.deepEqual(inventoryProblems(extra),
    ['reading-time: isn\'t in requiredIds, so add it to the record\'s parity table and the list together']);

  const malformed = withEntry('pin', entry => ({ ...entry, id: 'Pin Notes' }));
  assert.deepEqual(inventoryProblems(malformed), ['Pin Notes: `id` has to be lowercase words joined by hyphens', 'pin: is absent']);

  assert.deepEqual(inventoryProblems(withEntry('pin', entry => ({ ...entry, note: 'x' }))), ['pin: unknown key `note`']);
  assert.deepEqual(inventoryProblems(withEntry('pin', entry => ({ ...entry, home: { ...entry.home, label: 'Pin' } }))),
    ['pin: unknown home key `label`']);
  assert.deepEqual(inventoryProblems({ ...committedInventory(), version: 1 }), ['unknown key `version`']);
  assert.deepEqual(inventoryProblems([]), ['the inventory has to be an object with a `features` array']);
});
