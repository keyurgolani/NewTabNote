const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCommandPaletteItems,
} = require('../js/command-palette-utils.js');

test('command palette matches commands by title and keyword aliases', () => {
  const items = buildCommandPaletteItems({
    query: 'prefs',
    commands: [
      {
        id: 'new-note',
        title: 'New Note',
        keywords: ['create', 'note'],
      },
      {
        id: 'open-settings',
        title: 'Open Settings',
        keywords: ['preferences', 'config'],
      },
    ],
    notes: [],
  });

  assert.equal(items[0].id, 'command:open-settings');
  assert.equal(items[0].kind, 'command');
});

test('command palette ranks title note matches above body-only matches', () => {
  const items = buildCommandPaletteItems({
    query: 'sprint',
    commands: [],
    notes: [
      {
        id: 'title-hit',
        name: 'Sprint plan',
        preview: 'Review next week milestones',
        searchText: 'Review next week milestones',
        updatedAt: 20,
      },
      {
        id: 'body-hit',
        name: 'Weekly review',
        preview: 'Sprint retrospective and follow-ups',
        searchText: 'Sprint retrospective and follow-ups',
        updatedAt: 30,
      },
    ],
  });

  assert.equal(items[0].id, 'note:title-hit');
  assert.equal(items[1].id, 'note:body-hit');
});

test('command palette empty query shows commands first and recent notes after', () => {
  const items = buildCommandPaletteItems({
    query: '',
    commands: [
      { id: 'new-note', title: 'New Note' },
      { id: 'open-settings', title: 'Open Settings' },
    ],
    notes: [
      { id: 'older', name: 'Older note', updatedAt: 10 },
      { id: 'newer', name: 'Newer note', updatedAt: 20 },
    ],
  });

  assert.deepEqual(items.map(item => item.id), [
    'command:new-note',
    'command:open-settings',
    'note:newer',
    'note:older',
  ]);
});

test('command palette note results surface current and open badges', () => {
  const items = buildCommandPaletteItems({
    query: 'roadmap',
    commands: [],
    notes: [
      {
        id: 'roadmap',
        name: 'Roadmap',
        preview: 'Current milestone tracker',
        updatedAt: 50,
        isActive: true,
        isOpen: true,
      },
    ],
  });

  assert.deepEqual(items[0].badges, ['Current', 'Open']);
});
