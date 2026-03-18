const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNoteSaveMetadata,
  buildSidebarNoteModel,
  sortNotes,
} = require('../js/sidebar-utils.js');

test('sortNotes keeps pinned notes first before applying updated sort order', () => {
  const notes = [
    { id: 'a', name: 'Alpha', updatedAt: 100, createdAt: 50, pinned: false },
    { id: 'b', name: 'Beta', updatedAt: 90, createdAt: 40, pinned: true },
    { id: 'c', name: 'Gamma', updatedAt: 110, createdAt: 60, pinned: false },
    { id: 'd', name: 'Delta', updatedAt: 80, createdAt: 30, pinned: true },
  ];

  const result = sortNotes(notes, 'updated');

  assert.deepEqual(result.map(note => note.id), ['b', 'd', 'c', 'a']);
});

test('sortNotes supports alphabetical sorting after pinning priority', () => {
  const notes = [
    { id: 'b', name: 'Bravo', updatedAt: 90, createdAt: 40, pinned: false },
    { id: 'a', name: 'Alpha', updatedAt: 100, createdAt: 50, pinned: false },
    { id: 'd', name: 'Delta', updatedAt: 80, createdAt: 30, pinned: true },
    { id: 'c', name: 'Charlie', updatedAt: 110, createdAt: 60, pinned: true },
  ];

  const result = sortNotes(notes, 'alphabetical');

  assert.deepEqual(result.map(note => note.id), ['c', 'd', 'a', 'b']);
});

test('buildNoteSaveMetadata extracts a clean preview and todo progress from blocks', () => {
  const metadata = buildNoteSaveMetadata([
    { type: 'text', content: '<b>Plan</b> the <i>week</i>' },
    { type: 'todo', content: 'Write tests', checked: true },
    { type: 'todo', content: 'Ship changes', checked: false },
  ]);

  assert.equal(metadata.preview, 'Plan the week');
  assert.deepEqual(metadata.todoProgress, { completed: 1, total: 2 });
});

test('buildSidebarNoteModel returns plain-text preview, tags, and todo summary', () => {
  const model = buildSidebarNoteModel({
    name: 'Unsafe <script>alert(1)</script>',
    preview: '<img src=x onerror=alert(1)>Sprint review notes',
    updatedAt: Date.UTC(2026, 2, 13, 17, 0, 0),
    pinned: true,
    insights: { tags: ['planning', 'review', 'team', 'extra'] },
    todoProgress: { completed: 2, total: 5 },
  }, {
    now: Date.UTC(2026, 2, 13, 18, 0, 0),
  });

  assert.equal(model.title, 'Unsafe <script>alert(1)</script>');
  assert.equal(model.preview, 'Sprint review notes');
  assert.deepEqual(model.tags, ['planning', 'review', 'team']);
  assert.equal(model.todoSummary, '2/5 done');
  assert.equal(model.isPinned, true);
  assert.equal(model.relativeTime, '1h ago');
});
