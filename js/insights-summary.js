/**
 * Build compact intelligence summaries from notes with extracted insights.
 */
(function initInsightsSummary(root) {
  'use strict';

  const DEFAULT_LIMIT = 12;

  function isActiveNote(note) {
    return note && !note.archivedAt && !note.trashedAt;
  }

  function normalizeText(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value.text === 'string') return value.text.trim();
    return '';
  }

  function normalizeDate(value) {
    if (value && typeof value === 'object' && typeof value.date === 'string') {
      return value.date;
    }
    return null;
  }

  function createItem(note, value, category) {
    const text = normalizeText(value);
    if (!text) return null;

    return {
      category,
      text,
      date: normalizeDate(value),
      noteId: note.id || '',
      noteName: note.name || 'Untitled',
      updatedAt: note.updatedAt || 0
    };
  }

  function collectItems(notes, key, category) {
    return notes.flatMap(note => {
      const values = Array.isArray(note.insights?.[key]) ? note.insights[key] : [];
      return values.map(value => createItem(note, value, category)).filter(Boolean);
    });
  }

  function sortDeadlines(deadlines) {
    return deadlines.slice().sort((a, b) => {
      if (a.date && b.date) return a.date.localeCompare(b.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  function byRecentNote(a, b) {
    return b.updatedAt - a.updatedAt;
  }

  function limit(items, maxItems) {
    return items.slice(0, maxItems);
  }

  function buildInsightsSummary(notes, options = {}) {
    const maxItems = options.maxItems || DEFAULT_LIMIT;
    const activeNotes = Array.isArray(notes) ? notes.filter(isActiveNote) : [];
    const deadlines = sortDeadlines(collectItems(activeNotes, 'deadlines', 'deadline'));
    const todos = collectItems(activeNotes, 'todos', 'todo').sort(byRecentNote);
    const reminders = collectItems(activeNotes, 'reminders', 'reminder').sort(byRecentNote);
    const highlights = collectItems(activeNotes, 'highlights', 'highlight').sort(byRecentNote);

    return {
      deadlines: limit(deadlines, maxItems),
      todos: limit(todos, maxItems),
      reminders: limit(reminders, maxItems),
      highlights: limit(highlights, maxItems),
      totalCount: deadlines.length + todos.length + reminders.length + highlights.length
    };
  }

  const api = { buildInsightsSummary };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.InsightsSummary = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
