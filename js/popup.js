/**
 * Popup script for New Tab Note extension. It reads notes, and saves its quick note, through
 * the client its composition root hands it.
 */

// storage.js puts Storage on window, where Popup's root finds it
import './storage.js';
import { createPopupClient } from './kernel/composition/popup.js';

/** @typedef {import('./kernel/composition/host.js').Client} Client */
/** @typedef {import('./kernel/core/domain/note.js').NoteRecord} NoteRecord */

/** Shown instead of the popup when a newer build upgraded the notes database. */
const POPUP_GUARD_TEXT = {
  title: 'Your notes were upgraded by a newer NewTabNote version',
  body: "This version can't open them safely, so it won't change anything. Update NewTabNote to keep working, or export a copy now.",
};

/**
 * Why Popup can't show its notes, from a query that failed or a kernel that couldn't open:
 * with code NEWER_SCHEMA for a database a newer build upgraded, which shows the guard.
 * @param {{cause: string, code: string}} failure
 * @returns {Error & {code?: string}}
 */
function readFailure({ cause, code }) {
  const error = /** @type {Error & {code?: string}} */ (new Error(`Notes can't be read (${cause}: ${code})`));
  if (cause === 'newer-schema') error.code = 'NEWER_SCHEMA';
  return error;
}

/**
 * Whether the kernel couldn't open because no new tab has made the database yet. Popup shows
 * no notes then, as it did when its own open made an empty one.
 * @param {{code: string} | null} failure
 * @returns {boolean}
 */
function noDatabase(failure) {
  return Boolean(failure) && failure.code === 'no-database';
}

/**
 * The data a query answered, or `none` when it found nothing or there's no database yet. A
 * failed read throws.
 * @template T
 * @param {import('./kernel/core/contracts/outcomes.js').QueryState<T>} state
 * @param {T} none
 * @returns {T}
 */
function dataOf(state, none) {
  if (state.kind === 'ready' || state.kind === 'stale') return state.data;
  if (state.kind === 'failed' && !noDatabase(state)) throw readFailure(state);
  // Empty, and loading, which no query answers once whenReady has resolved
  return none;
}

/**
 * Popup's notes as it has always listed them: none archived or trashed by date, templates
 * included, newest first.
 * @param {Client} kernel
 * @returns {Promise<NoteRecord[]>}
 */
async function listNotes(kernel) {
  return dataOf(await kernel.query({ type: 'listNotes', view: 'popup' }), []);
}

/**
 * Whether to show the day's summary: insightsEnabled in IndexedDB's settings store, as Popup
 * has always read it (#4 moves it to the setting the new tab saves).
 * @param {Client} kernel
 * @returns {Promise<boolean>}
 */
async function insightsEnabled(kernel) {
  return dataOf(await kernel.query({ type: 'getPopupInsightsEnabled' }), { insightsEnabled: false }).insightsEnabled;
}

/**
 * The notes with AI-extracted insights: a todo, a reminder, or a deadline.
 * @param {Array<Object>} notes
 * @returns {Array<Object>}
 */
function withInsights(notes) {
  return notes.filter(note => note.insights && (
    (note.insights.todos && note.insights.todos.length > 0) ||
    (note.insights.reminders && note.insights.reminders.length > 0) ||
    (note.insights.deadlines && note.insights.deadlines.length > 0)
  ));
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return date.toLocaleDateString();
}

function formatDeadlineDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


function generateDailySummary(notesWithInsights) {
  if (!notesWithInsights || notesWithInsights.length === 0) {
    return null;
  }

  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const allTodos = [];
  const allReminders = [];
  const todayDeadlines = [];
  const upcomingDeadlines = [];

  for (const note of notesWithInsights) {
    if (!note.insights) continue;

    const prefix = note.name ? `[${note.name}] ` : '';

    if (note.insights.todos) {
      allTodos.push(...note.insights.todos.map(t => prefix + t));
    }
    if (note.insights.reminders) {
      allReminders.push(...note.insights.reminders.map(r => prefix + r));
    }
    if (note.insights.deadlines) {
      for (const d of note.insights.deadlines) {
        const deadline = {
          text: prefix + (typeof d === 'object' ? d.text : d),
          date: typeof d === 'object' ? d.date : null,
          noteId: note.id
        };

        if (deadline.date === today) {
          todayDeadlines.push(deadline);
        } else if (deadline.date && deadline.date > today && deadline.date <= nextWeek) {
          upcomingDeadlines.push(deadline);
        } else if (!deadline.date) {
          upcomingDeadlines.push(deadline);
        }
      }
    }
  }

  upcomingDeadlines.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });

  return {
    todayDeadlines: todayDeadlines.slice(0, 5),
    upcomingDeadlines: upcomingDeadlines.slice(0, 5),
    todos: allTodos.slice(0, 5),
    reminders: allReminders.slice(0, 5)
  };
}


function renderDailySummary(summary) {
  const container = document.getElementById('daily-summary');
  const content = document.getElementById('summary-content');

  if (!summary || (
    summary.todayDeadlines.length === 0 &&
    summary.upcomingDeadlines.length === 0 &&
    summary.todos.length === 0 &&
    summary.reminders.length === 0
  )) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  content.innerHTML = '';

  const today = new Date().toISOString().split('T')[0];
  const threeDaysFromNow = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];

  // Deadlines category (combine today and upcoming)
  const allDeadlines = [...summary.todayDeadlines, ...summary.upcomingDeadlines];
  if (allDeadlines.length > 0) {
    const category = document.createElement('div');
    category.className = 'summary-category';
    category.innerHTML = '<div class="summary-category-title"><span class="dot deadlines"></span>Deadlines</div>';
    
    const list = document.createElement('ul');
    list.className = 'summary-list deadlines';
    
    for (const deadline of allDeadlines.slice(0, 4)) {
      const li = document.createElement('li');
      const isToday = deadline.date === today;
      if (isToday) li.className = 'today';
      
      li.textContent = deadline.text;
      if (deadline.date) {
        const isSoon = deadline.date <= threeDaysFromNow;
        const dateSpan = document.createElement('span');
        dateSpan.className = 'deadline-date ' + (isToday ? 'today' : (isSoon ? 'soon' : ''));
        dateSpan.textContent = isToday ? 'Today' : formatDeadlineDate(deadline.date);
        li.appendChild(document.createTextNode(' '));
        li.appendChild(dateSpan);
      }
      list.appendChild(li);
    }
    
    category.appendChild(list);
    content.appendChild(category);
  }

  // Action Items category
  if (summary.todos.length > 0) {
    const category = document.createElement('div');
    category.className = 'summary-category';
    category.innerHTML = '<div class="summary-category-title"><span class="dot todos"></span>Action Items</div>';
    
    const list = document.createElement('ul');
    list.className = 'summary-list todos';
    
    for (const todo of summary.todos.slice(0, 4)) {
      const li = document.createElement('li');
      li.textContent = todo;
      list.appendChild(li);
    }
    
    category.appendChild(list);
    content.appendChild(category);
  }

  // Reminders category
  if (summary.reminders.length > 0) {
    const category = document.createElement('div');
    category.className = 'summary-category';
    category.innerHTML = '<div class="summary-category-title"><span class="dot reminders"></span>Reminders</div>';
    
    const list = document.createElement('ul');
    list.className = 'summary-list reminders';
    
    for (const reminder of summary.reminders.slice(0, 4)) {
      const li = document.createElement('li');
      li.textContent = reminder;
      list.appendChild(li);
    }
    
    category.appendChild(list);
    content.appendChild(category);
  }
}


/**
 * Render the recent notes list in the popup.
 * @param {Array<Object>} notes - All active notes sorted by updatedAt descending
 */
function renderRecentNotes(notes) {
  const list = document.getElementById('page-list');

  if (notes.length === 0) {
    list.innerHTML = '<div class="empty">No notes yet</div>';
    return;
  }

  list.innerHTML = '';
  const recentNotes = notes.slice(0, 5);

  for (const note of recentNotes) {
    const item = document.createElement('div');
    item.className = 'page-item';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = note.name || 'Untitled';
    item.appendChild(nameSpan);
    const dateSpan = document.createElement('span');
    dateSpan.className = 'date';
    dateSpan.textContent = formatDate(note.updatedAt);
    item.appendChild(dateSpan);
    item.addEventListener('click', openNewTab);
    list.appendChild(item);
  }
}

/**
 * Open the new tab page, where the notes (and Export) live.
 * @returns {void}
 */
function openNewTab() {
  chrome.tabs.create({ url: 'newtab.html' });
}

/**
 * Replace the popup body with the newer-version guard: the new tab's text and
 * one Open new tab button, which leads to Export. Nothing here reads or writes notes.
 * @returns {void}
 */
function renderStorageGuard() {
  const main = document.getElementById('main-content');
  main.innerHTML = '';
  main.classList.add('no-summary');

  const guard = document.createElement('section');
  guard.className = 'storage-guard';
  guard.setAttribute('aria-labelledby', 'storage-guard-title');

  const heading = document.createElement('h2');
  heading.id = 'storage-guard-title';
  heading.className = 'storage-guard-title';
  heading.textContent = POPUP_GUARD_TEXT.title;
  guard.appendChild(heading);

  const body = document.createElement('p');
  body.className = 'storage-guard-body';
  body.textContent = POPUP_GUARD_TEXT.body;
  guard.appendChild(body);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'storage-guard-btn';
  button.textContent = 'Open new tab';
  button.addEventListener('click', openNewTab);
  guard.appendChild(button);

  main.appendChild(guard);
}


async function init() {
  const kernel = createPopupClient();
  const quickNoteInput = /** @type {HTMLInputElement} */ (document.getElementById('quick-note-input'));
  let guarded = false;

  try {
    const failure = await kernel.whenReady();
    if (failure && !noDatabase(failure)) throw readFailure(failure);

    let hasSummary = false;
    if (await insightsEnabled(kernel)) {
      const notesWithInsights = withInsights(await listNotes(kernel));
      const summary = generateDailySummary(notesWithInsights);
      if (summary && (
        summary.todayDeadlines.length > 0 ||
        summary.upcomingDeadlines.length > 0 ||
        summary.todos.length > 0 ||
        summary.reminders.length > 0
      )) {
        hasSummary = true;
        renderDailySummary(summary);
      }
    }

    // If no summary, make recent pages full width
    if (!hasSummary) {
      document.getElementById('main-content').classList.add('no-summary');
    }

    renderRecentNotes(await listNotes(kernel));
  } catch (error) {
    if (error && error.code === 'NEWER_SCHEMA') {
      guarded = true;
      renderStorageGuard();
    } else {
      console.error('Failed to load notes:', error);
      document.getElementById('page-list').innerHTML = '<div class="empty">Failed to load notes</div>';
    }
  }

  document.getElementById('open-tab').addEventListener('click', openNewTab);

  if (guarded) {
    // A newer build owns the database: no quick notes until NewTabNote is updated.
    quickNoteInput.disabled = true;
    return;
  }

  // Quick Note input — creates a new note on Enter, with the record and search entry the new tab's notes get
  quickNoteInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = quickNoteInput.value.trim();
    if (!text) return;

    quickNoteInput.disabled = true;
    try {
      const outcome = await kernel.execute({
        type: 'createNote',
        commandId: kernel.ids.next(),
        noteId: kernel.ids.next(),
        name: text,
      });
      if (outcome.kind !== 'committed') throw new Error(`The quick note wasn't saved (${outcome.kind}: ${outcome.code})`);
      quickNoteInput.value = '';
      // Refresh the recent notes list
      renderRecentNotes(await listNotes(kernel));
    } catch (err) {
      console.error('Failed to create quick note:', err);
    } finally {
      quickNoteInput.disabled = false;
      quickNoteInput.focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
