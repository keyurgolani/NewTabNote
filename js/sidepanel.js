/**
 * Side panel intelligence dashboard for New Tab Note.
 */
class SidePanelStorage {
  constructor() {
    this.dbName = 'CanvasTabDB';
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  hasStore(name) {
    return this.db.objectStoreNames.contains(name);
  }

  async getAllNotes() {
    if (!this.hasStore('canvases')) return [];

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('canvases', 'readonly');
      const store = tx.objectStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => resolve(request.result.reverse());
      request.onerror = () => reject(request.error);
    });
  }
}

const SECTION_CONFIG = [
  { key: 'deadlines', label: 'Deadlines', tone: 'deadline' },
  { key: 'todos', label: 'Action Items', tone: 'todo' },
  { key: 'reminders', label: 'Reminders', tone: 'reminder' },
  { key: 'highlights', label: 'Highlights', tone: 'highlight' }
];

function formatDate(dateValue) {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateValue;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function openNotes() {
  chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
}

function createInsightItem(item) {
  const element = document.createElement('article');
  element.className = 'item';

  const text = document.createElement('p');
  text.className = 'item-text';
  text.textContent = item.text;
  element.appendChild(text);

  const meta = document.createElement('div');
  meta.className = 'item-meta';

  const noteName = document.createElement('span');
  noteName.className = 'note-name';
  noteName.textContent = item.noteName;
  meta.appendChild(noteName);

  if (item.date) {
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = formatDate(item.date);
    meta.appendChild(date);
  }

  element.appendChild(meta);
  return element;
}

function createSection(config, items) {
  const section = document.createElement('section');
  section.className = 'section';

  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `<span class="dot ${config.tone}"></span><span>${config.label}</span>`;
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'list';
  for (const item of items) {
    list.appendChild(createInsightItem(item));
  }
  section.appendChild(list);

  return section;
}

function renderSummary(summary) {
  const sections = document.getElementById('sections');
  const emptyState = document.getElementById('empty-state');
  const status = document.getElementById('status');
  const statusCount = document.getElementById('status-count');

  sections.innerHTML = '';

  if (!summary || summary.totalCount === 0) {
    status.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  statusCount.textContent = String(summary.totalCount);
  status.classList.remove('hidden');
  emptyState.classList.add('hidden');

  for (const config of SECTION_CONFIG) {
    const items = summary[config.key] || [];
    if (items.length > 0) {
      sections.appendChild(createSection(config, items));
    }
  }
}

async function init() {
  document.getElementById('open-notes').addEventListener('click', openNotes);
  document.querySelector('[data-open-notes]').addEventListener('click', openNotes);

  const storage = new SidePanelStorage();
  try {
    await storage.init();
    const notes = await storage.getAllNotes();
    const summary = InsightsSummary.buildInsightsSummary(notes, { maxItems: 8 });
    renderSummary(summary);
  } catch (error) {
    console.error('Failed to load side panel intelligence:', error);
    renderSummary(null);
  }
}

document.addEventListener('DOMContentLoaded', init);
