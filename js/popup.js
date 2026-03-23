/**
 * Popup script for New Tab Note extension
 */

class PopupStorage {
  constructor() {
    this.dbName = 'CanvasTabDB';
    this.db = null;
  }

  /**
   * Initialize the database connection.
   * @returns {Promise<void>}
   */
  async init() {
    return new Promise((resolve, reject) => {
      // Open without a version to use whatever version currently exists.
      // The popup only reads data, so it should never trigger onupgradeneeded.
      const request = indexedDB.open(this.dbName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  /**
   * Check if an object store exists in the database.
   * @param {string} name - Store name
   * @returns {boolean} True if the store exists
   */
  hasStore(name) {
    return this.db.objectStoreNames.contains(name);
  }

  /**
   * Get all active (non-archived, non-trashed) notes.
   * @returns {Promise<Array<Object>>} Active notes sorted by updatedAt descending
   */
  async getAllNotes() {
    if (!this.hasStore('canvases')) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('canvases', 'readonly');
      const store = tx.objectStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        const activeNotes = request.result.filter(note => !note.archivedAt && !note.trashedAt);
        resolve(activeNotes.reverse());
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get notes that have AI-extracted insights.
   * @returns {Promise<Array<Object>>} Notes with insights
   */
  async getNotesWithInsights() {
    const notes = await this.getAllNotes();
    return notes.filter(note => note.insights && (
      (note.insights.todos && note.insights.todos.length > 0) ||
      (note.insights.reminders && note.insights.reminders.length > 0) ||
      (note.insights.deadlines && note.insights.deadlines.length > 0)
    ));
  }

  /**
   * Get a setting value from the settings store.
   * @param {string} key - Setting key
   * @param {*} [defaultValue=null] - Default value if not found
   * @returns {Promise<*>} Setting value
   */
  async getSetting(key, defaultValue = null) {
    if (!this.hasStore('settings')) return defaultValue;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const request = store.get(key);
      request.onsuccess = () => {
        resolve(request.result?.value ?? defaultValue);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Create a new note.
   * @param {string} name - Note name
   * @returns {Promise<Object>} Created note object
   */
  async createNote(name) {
    const note = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('canvases', 'readwrite');
      const store = tx.objectStore('canvases');
      const request = store.add(note);
      request.onsuccess = () => resolve(note);
      request.onerror = () => reject(request.error);
    });
  }
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
    item.addEventListener('click', () => {
      chrome.tabs.create({ url: 'newtab.html' });
    });
    list.appendChild(item);
  }
}


async function init() {
  const storage = new PopupStorage();

  try {
    await storage.init();

    let hasSummary = false;
    const insightsEnabled = await storage.getSetting('insightsEnabled', false);
    if (insightsEnabled) {
      const notesWithInsights = await storage.getNotesWithInsights();
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

    const notes = await storage.getAllNotes();
    renderRecentNotes(notes);
  } catch (error) {
    console.error('Failed to load notes:', error);
    document.getElementById('page-list').innerHTML = '<div class="empty">Failed to load notes</div>';
  }

  document.getElementById('open-tab').addEventListener('click', () => {
    chrome.tabs.create({ url: 'newtab.html' });
  });

  // Quick Note input — creates a new note on Enter
  const quickNoteInput = document.getElementById('quick-note-input');
  quickNoteInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = quickNoteInput.value.trim();
    if (!text) return;

    quickNoteInput.disabled = true;
    try {
      await storage.createNote(text);
      quickNoteInput.value = '';
      // Refresh the recent notes list
      const updatedNotes = await storage.getAllNotes();
      renderRecentNotes(updatedNotes);
    } catch (err) {
      console.error('Failed to create quick note:', err);
    } finally {
      quickNoteInput.disabled = false;
      quickNoteInput.focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
