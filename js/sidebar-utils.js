(function (global) {
  const DEFAULT_PREVIEW_LENGTH = 120;
  const MAX_TAGS = 3;

  /**
   * Strip HTML tags from a string.
   * @param {string} [value=''] - HTML string
   * @returns {string} Plain text
   */
  function stripHtml(value = '') {
    return String(value)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Truncate text to a maximum length with ellipsis.
   * @param {string} value - Text to truncate
   * @param {number} [maxLength=120] - Maximum length
   * @returns {string} Truncated text
   */
  function truncateText(value, maxLength = DEFAULT_PREVIEW_LENGTH) {
    if (!value || value.length <= maxLength) {
      return value || '';
    }

    return `${value.slice(0, maxLength - 1).trimEnd()}…`;
  }

  /**
   * Extract plain text from a block object.
   * @param {Object} [block={}] - Block data
   * @returns {string} Extracted text
   */
  function extractBlockText(block = {}) {
    if (!block || typeof block !== 'object') {
      return '';
    }

    if (block.type === 'toggle') {
      return [stripHtml(block.content), stripHtml(block.children)].filter(Boolean).join(' ');
    }

    if (block.type === 'bookmark') {
      return [block.title, block.description, block.url].filter(Boolean).join(' ');
    }

    if (block.type === 'equation') {
      return stripHtml(block.equation);
    }

    if (block.type === 'table' && Array.isArray(block.tableData)) {
      return block.tableData.flat().map(cell => stripHtml(cell)).filter(Boolean).join(' ');
    }

    if (block.type === 'file') {
      return stripHtml(block.fileName);
    }

    if (block.type === 'video') {
      return stripHtml(block.videoUrl);
    }

    return stripHtml(block.content);
  }

  /**
   * Build save-time metadata (preview text, todo progress) from blocks.
   * @param {Array<Object>} [blocks=[]] - Array of block objects
   * @returns {{preview: string, todoProgress: {completed: number, total: number}|null}} Metadata
   */
  function buildNoteSaveMetadata(blocks = []) {
    let preview = '';
    let completed = 0;
    let total = 0;

    for (const block of blocks) {
      const text = extractBlockText(block);

      if (!preview && text) {
        preview = text;
      }

      if (block.type === 'todo') {
        total += 1;
        if (block.checked) {
          completed += 1;
        }
      }
    }

    return {
      preview: truncateText(preview),
      todoProgress: total > 0 ? { completed, total } : null,
    };
  }

  function compareNames(a, b) {
    const nameA = (a.name || 'Untitled').toLowerCase();
    const nameB = (b.name || 'Untitled').toLowerCase();
    return nameA.localeCompare(nameB);
  }

  function compareNotes(a, b, sortMode) {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1;
    }

    if (sortMode === 'alphabetical') {
      return compareNames(a, b);
    }

    const left = sortMode === 'created'
      ? (a.createdAt || 0)
      : (a.updatedAt || 0);
    const right = sortMode === 'created'
      ? (b.createdAt || 0)
      : (b.updatedAt || 0);

    if (left !== right) {
      return right - left;
    }

    return compareNames(a, b);
  }

  /**
   * Sort notes by the given sort mode, with pinned notes first.
   * @param {Array<Object>} [notes=[]] - Array of note objects
   * @param {string} [sortMode='updated'] - Sort mode ('updated', 'created', 'alphabetical')
   * @returns {Array<Object>} Sorted copy of the notes array
   */
  function sortNotes(notes = [], sortMode = 'updated') {
    return [...notes].sort((a, b) => compareNotes(a, b, sortMode));
  }

  /**
   * Get a human-readable relative time label (e.g. "2h ago").
   * @param {number} timestamp - Unix timestamp in milliseconds
   * @param {{now?: number}} [options={}] - Options with optional current time
   * @returns {string} Relative time label
   */
  function getRelativeTimeLabel(timestamp, { now = Date.now() } = {}) {
    if (!timestamp) {
      return '';
    }

    const diff = Math.max(0, now - timestamp);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;

    if (diff < minute) {
      return 'just now';
    }

    if (diff < hour) {
      return `${Math.floor(diff / minute)}m ago`;
    }

    if (diff < day) {
      return `${Math.floor(diff / hour)}h ago`;
    }

    if (diff < week) {
      return `${Math.floor(diff / day)}d ago`;
    }

    return `${Math.floor(diff / week)}w ago`;
  }

  /**
   * Build a view model for a sidebar note item.
   * @param {Object} [note={}] - Note object
   * @param {Object} [options={}] - Options with optional searchIndexEntry and now
   * @returns {{title: string, preview: string, relativeTime: string, tags: string[], todoSummary: string, isPinned: boolean}} View model
   */
  function buildSidebarNoteModel(note = {}, options = {}) {
    const previewSource = note.preview || options.searchIndexEntry?.content || '';
    const tags = Array.isArray(note.insights?.tags)
      ? note.insights.tags.slice(0, MAX_TAGS)
      : [];
    const todoProgress = note.todoProgress;

    return {
      title: note.name || 'Untitled',
      preview: truncateText(stripHtml(previewSource)),
      relativeTime: getRelativeTimeLabel(note.updatedAt || note.createdAt, options),
      tags,
      todoSummary: todoProgress && todoProgress.total
        ? `${todoProgress.completed}/${todoProgress.total} done`
        : '',
      isPinned: Boolean(note.pinned),
    };
  }

  const api = {
    buildNoteSaveMetadata,
    buildSidebarNoteModel,
    getRelativeTimeLabel,
    sortNotes,
    stripHtml,
    truncateText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.SidebarUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
