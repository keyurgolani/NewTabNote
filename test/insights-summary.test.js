const test = require('node:test');
const assert = require('node:assert/strict');

const { buildInsightsSummary } = require('../js/insights-summary.js');

test('buildInsightsSummary aggregates intelligence from active notes', () => {
  const summary = buildInsightsSummary([
    {
      id: 'note-1',
      name: 'Project Plan',
      updatedAt: 200,
      insights: {
        todos: ['Send launch brief'],
        reminders: ['Ask design for screenshots'],
        deadlines: [{ text: 'Submit store package', date: '2026-05-04' }],
        highlights: ['Users expect side panel access']
      }
    },
    {
      id: 'note-2',
      name: 'Daily Note',
      updatedAt: 100,
      insights: {
        todos: ['Review release notes'],
        reminders: [],
        deadlines: ['Follow up with beta users'],
        highlights: ['Chrome sidebar is available']
      }
    }
  ], { today: '2026-05-02' });

  assert.deepEqual(summary.todos.map(item => item.text), [
    'Send launch brief',
    'Review release notes'
  ]);
  assert.deepEqual(summary.reminders.map(item => item.text), [
    'Ask design for screenshots'
  ]);
  assert.deepEqual(summary.deadlines.map(item => item.text), [
    'Submit store package',
    'Follow up with beta users'
  ]);
  assert.deepEqual(summary.highlights.map(item => item.text), [
    'Users expect side panel access',
    'Chrome sidebar is available'
  ]);
  assert.equal(summary.totalCount, 7);
});

test('buildInsightsSummary ignores archived, trashed, and empty notes', () => {
  const summary = buildInsightsSummary([
    {
      id: 'archived',
      name: 'Archived',
      archivedAt: 1,
      insights: { todos: ['Ignore archived'] }
    },
    {
      id: 'trashed',
      name: 'Trashed',
      trashedAt: 1,
      insights: { reminders: ['Ignore trashed'] }
    },
    {
      id: 'empty',
      name: 'Empty',
      insights: null
    }
  ]);

  assert.deepEqual(summary.todos, []);
  assert.deepEqual(summary.reminders, []);
  assert.deepEqual(summary.deadlines, []);
  assert.deepEqual(summary.highlights, []);
  assert.equal(summary.totalCount, 0);
});

test('buildInsightsSummary sorts dated deadlines before undated deadlines', () => {
  const summary = buildInsightsSummary([
    {
      id: 'note-1',
      name: 'Planning',
      insights: {
        deadlines: [
          { text: 'Later', date: '2026-05-08' },
          'No date',
          { text: 'Sooner', date: '2026-05-03' }
        ]
      }
    }
  ]);

  assert.deepEqual(summary.deadlines.map(item => item.text), [
    'Sooner',
    'Later',
    'No date'
  ]);
});
