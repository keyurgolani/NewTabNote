/**
 * NotesManager — manages note CRUD operations, auto-title, insights extraction,
 * search index updates, embedding generation, and note export/import.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 * @param {Object} deps.llm - The AI port (js/services/ai-port.mjs) the jobs call the provider through
 * @param {Object} [deps.documentClient] - What the title and insights jobs read and write
 *   through (js/kernel/composition/document.js): each write names its note, and none takes a
 *   note record
 */
/**
 * The error a job throws when the kernel didn't store its write: its kind and code, never the
 * note's content
 * @param {string} what
 * @param {{kind: string, code?: string}} outcome
 * @returns {Error}
 */
function notStored(what, outcome) {
  return new Error(`Not stored: ${what} (${outcome.kind}: ${outcome.code})`);
}

class NotesManager {
  constructor({ storage, domRefs, logger, llm, documentClient = null }) {
    this.storage = storage;
    this.domRefs = domRefs;
    this.logger = logger;
    this.llm = llm;
    this.documentClient = documentClient;

    // Auto-title state
    this.autoTitleIntervalId = null;
    this.autoTitleRunning = false;

    // Insights extraction state
    this.insightsIntervalId = null;
    this.insightsRunning = false;

    // Search indexer
    this.indexerWorker = null;
    this.searchEngine = null;
    this.searchIndexByNoteId = new Map();

    // Data arrays (synced from App)
    this.notes = [];
    this.archivedNotes = [];
    this.trashedNotes = [];
    this.templates = [];
    this.folders = [];

    // App-level callbacks (set by App after construction)
    this.onRefreshNotesList = null;
    this.onRenderNotesList = null;
    /** @type {((ids: Array<string>) => Promise<void>)|null} Panes move off notes about to leave the active set */
    this.onNotesLeaving = null;
    /** @type {((ids: Array<string>) => void)|null} Notes left the active set: the other new tabs hear of it */
    this.onNotesLeft = null;
    this.onOpenNoteInNewTab = null;
    this.onCreateFirstNote = null;
    this.onUpdateEmptyState = null;
    this.getEditor = null;
    this.getOpenTabs = null;
    this.onRenderTabs = null;
    this.onSaveTabs = null;

    this.triggerIndexing = Utils.debounce((noteId) => {
      if (noteId) {
        this.updateNoteIndex(noteId);
      } else {
        this.rebuildSearchIndex();
      }
    }, 300);
  }

  /** Initialize: setup auto-title (critical for note management). */
  async init() {
    await this.setupAutoTitle();
  }

  /**
   * Deferred initialization for non-critical features.
   * Called via requestIdleCallback after first note render.
   */
  async deferredInit() {
    await this.setupInsightsExtraction();
    this.initIndexer();
    await this.initEmbeddings();
  }

  /** Tear down intervals and workers. */
  destroy() {
    this.stopAutoTitleInterval();
    this.stopInsightsInterval();
    if (this.indexerWorker) {
      this.indexerWorker.terminate();
      this.indexerWorker = null;
    }
  }

  // ─── Note CRUD ───

  /**
   * Archive a note by ID
   */
  async archiveNote(noteId) {
    if (this.onNotesLeaving) await this.onNotesLeaving([noteId]);
    await this.storage.archiveNote(noteId);
    await this._afterNotesLeft([noteId]);
    this.removeNoteIndex(noteId);
    Utils.showToast('Note archived', 'success');
  }

  /**
   * After notes left the active set: tell the other new tabs, then refresh the lists.
   * Panes moved off them before the write (onNotesLeaving), so their edits landed first.
   * @param {Array<string>} ids
   * @returns {Promise<void>}
   */
  async _afterNotesLeft(ids) {
    if (this.onNotesLeft) this.onNotesLeft(ids);
    if (this.onRefreshNotesList) await this.onRefreshNotesList();
    if (this.onUpdateEmptyState) this.onUpdateEmptyState();
  }

  /**
   * Unarchive a note by ID
   */
  async unarchiveNote(noteId) {
    await this.storage.unarchiveNote(noteId);
    if (this.onRefreshNotesList) await this.onRefreshNotesList();
    Utils.showToast('Note restored from archive', 'success');
  }

  /**
   * Move note to trash by ID
   */
  async trashNoteById(noteId) {
    if (this.onNotesLeaving) await this.onNotesLeaving([noteId]);
    const result = await this.storage.trashNote(noteId);
    await this._afterNotesLeft([noteId]);
    this.removeNoteIndex(noteId);

    if (result && result.permanentlyDeleted) {
      Utils.showToast('Empty note deleted', 'success');
    } else {
      Utils.showToast('Note moved to trash', 'success');
    }
  }

  /**
   * Restore note from trash by ID
   */
  async restoreNoteById(noteId) {
    await this.storage.restoreNote(noteId);
    if (this.onRefreshNotesList) await this.onRefreshNotesList();
    Utils.showToast('Note restored from trash', 'success');
  }

  /**
   * Permanently delete note by ID
   */
  async permanentlyDeleteNoteById(noteId) {
    if (!await confirmDialog({ title: 'Delete Permanently', message: 'Delete this note permanently? This cannot be undone.', confirmText: 'Delete', danger: true })) {
      return;
    }

    if (this.onNotesLeaving) await this.onNotesLeaving([noteId]);
    await this.storage.permanentlyDeleteNote(noteId);
    await this._afterNotesLeft([noteId]);
    Utils.showToast('Note permanently deleted', 'success');
  }

  /**
   * Legacy delete method - now uses trash
   */
  async deleteNoteById(noteId) {
    await this.trashNoteById(noteId);
  }

  /**
   * Convert a note to a template
   */
  async convertNoteToTemplate(noteId) {
    const note = await this.storage.getNote(noteId);
    if (!note) return;

    note.isTemplate = true;
    note.folderId = null; // Templates don't live in folders
    await this.storage.updateNote(note);
    Utils.showToast('Note converted to template', 'success');
    if (this.onRefreshNotesList) await this.onRefreshNotesList();
  }

  /**
   * Convert a template back to a note
   */
  async convertTemplateToNote(noteId) {
    const note = await this.storage.getNote(noteId);
    if (!note) return;

    note.isTemplate = false;
    await this.storage.updateNote(note);
    Utils.showToast('Template converted to note', 'success');
    if (this.onRefreshNotesList) await this.onRefreshNotesList();
  }

  /**
   * Handle when a note is removed (archived/trashed) - create new note or load another
   */
  async handleNoteRemoved(noteId) {
    const notes = await this.storage.getAllNotes();
    const openTabs = this.getOpenTabs ? this.getOpenTabs() : [];

    if (notes.length === 0) {
      if (this.onCreateFirstNote) await this.onCreateFirstNote();
    } else if (openTabs.length === 0) {
      if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(notes[0].id);
    }

    if (this.onUpdateEmptyState) this.onUpdateEmptyState();
  }

  // ─── Export ───

  /**
   * Export a note by ID as markdown
   */
  async exportNoteById(noteId) {
    try {
      const note = await this.storage.getNote(noteId);
      if (!note) {
        Utils.showToast('Note not found', 'error');
        return;
      }

      const blocks = await this.storage.getElementsByNote(noteId);

      // Build markdown content
      let markdown = `# ${note.name || 'Untitled'}\n\n`;

      // Sort blocks by order
      const sortedBlocks = blocks.sort((a, b) => (a.order || 0) - (b.order || 0));

      for (const block of sortedBlocks) {
        markdown += this.blockToMarkdown(block);
      }

      // Generate filename from note title
      const filename = (note.name || 'Untitled')
        .replace(/[^a-z0-9\s-]/gi, '')
        .replace(/\s+/g, '-')
        .toLowerCase() + '.md';

      Utils.downloadFile(markdown, filename);
      Utils.showToast('Note exported', 'success');
    } catch (error) {
      console.error('Export note failed:', error);
      Utils.showToast('Export failed', 'error');
    }
  }

  /**
   * Convert a block to markdown format
   */
  /**
     * Convert a block to markdown format
     */
    blockToMarkdown(block) {
      if (typeof AIResponseUtils !== 'undefined' && AIResponseUtils.blockToMarkdown) {
        return AIResponseUtils.blockToMarkdown(block);
      }

      const content = this.htmlToMarkdown(block.content || '');

      switch (block.type) {
        case 'h1':
          return `# ${content}\n\n`;
        case 'h2':
          return `## ${content}\n\n`;
        case 'h3':
          return `### ${content}\n\n`;
        case 'bullet':
          return `- ${content}\n`;
        case 'numbered':
          return `1. ${content}\n`;
        case 'todo':
          const checked = block.checked ? 'x' : ' ';
          return `- [${checked}] ${content}\n`;
        case 'quote':
          return `> ${content}\n\n`;
        case 'code':
          return `\`\`\`\n${block.content || ''}\n\`\`\`\n\n`;
        case 'divider':
          return `---\n\n`;
        case 'callout':
          return `> 💡 ${content}\n\n`;
        case 'toggle':
          const childContent = this.htmlToMarkdown(block.children || '');
          return `<details>\n<summary>${content}</summary>\n\n${childContent}\n</details>\n\n`;
        case 'table':
          if (block.tableData && Array.isArray(block.tableData)) {
            let tableMarkdown = '';
            block.tableData.forEach((row, index) => {
              tableMarkdown += '| ' + row.join(' | ') + ' |\n';
              if (index === 0) {
                tableMarkdown += '| ' + row.map(() => '---').join(' | ') + ' |\n';
              }
            });
            return tableMarkdown + '\n';
          }
          return '';
        case 'bookmark':
          return `[${block.title || block.url}](${block.url})\n\n`;
        case 'image':
          if (block.src) {
            return `![${block.caption || 'Image'}](${block.src})\n\n`;
          }
          return '';
        case 'equation':
          return `$$\n${block.equation || ''}\n$$\n\n`;
        case 'text':
        default:
          return content ? `${content}\n\n` : '';
      }
    }

  // ─── Import ───

  /**
   * Import a single note from file (.md, .txt, or .json)
   */
  async importNote(file) {
    try {
      const text = await Utils.readFileAsText(file);
      const filename = file.name;
      const extension = filename.split('.').pop().toLowerCase();

      // Get title from filename (without extension)
      const title = filename.replace(/\.[^/.]+$/, '');

      if (extension === 'json') {
        // Try to import as backup format
        const data = JSON.parse(text);

        if (data.exportType === 'single-note' && data.note && data.blocks) {
          // Single note export format
          const note = await this.storage.createNote(data.note.name || title);

          // Import blocks with new note ID
          for (const block of data.blocks) {
            const newBlock = {
              ...block,
              id: Utils.generateId(),
              canvasId: note.id,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            await this.storage.saveElement(newBlock);
          }

          if (this.onRefreshNotesList) await this.onRefreshNotesList();
          if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);
          Utils.showToast('Note imported', 'success');
        } else if (data.version && data.canvases) {
          // Full backup format - delegate to App-level importFromFile
          throw new Error('Full backup import not supported from NotesManager');
        } else {
          throw new Error('Invalid JSON format');
        }
      } else {
        // .md or .txt file - parse into blocks
        const blocks = this.markdownToBlocks(text);
        // Use first H1 as title if found, otherwise use filename
        let noteTitle = title;
        if (blocks.length > 0 && blocks[0].type === 'h1') {
          noteTitle = blocks[0].content || title;
          blocks.shift(); // Remove the H1 since it becomes the note title
        }

        const note = await this.storage.createNote(noteTitle);

        for (let i = 0; i < blocks.length; i++) {
          const block = {
            ...blocks[i],
            id: Utils.generateId(),
            canvasId: note.id,
            order: i,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await this.storage.saveElement(block);
        }

        if (this.onRefreshNotesList) await this.onRefreshNotesList();
        if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);
        Utils.showToast('Note imported', 'success');
      }
    } catch (error) {
      console.error('Import note failed:', error);
      Utils.showToast('Import failed: ' + error.message, 'error');
    }
  }

  /**
   * Parse markdown text into an array of block objects
   */
  markdownToBlocks(text) {
    if (typeof AIResponseUtils !== 'undefined' && AIResponseUtils.markdownToBlocks) {
      return AIResponseUtils.markdownToBlocks(text);
    }
    // Fallback: single text block
    return [{ type: 'text', content: text }];
  }

  // ─── AI: Generate Title ───

  /**
   * Generate title for a note using AI (ignores all configurations)
   */
  async generateTitleForNote(noteId) {
    // Check if LLM is configured
    if (!this.llm.isConfigured()) {
      Utils.showToast('AI not configured. Please set up in Settings.', 'error');
      return;
    }

    // Show loading state
    const editor = this.getEditor ? this.getEditor() : null;
    const isCurrentNote = editor && editor.noteId === noteId;
    const pageTitle = document.getElementById('page-title');
    const sidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);

    if (isCurrentNote && pageTitle) {
      pageTitle.classList.add('title-generating');
    }
    if (sidebarItem) {
      sidebarItem.classList.add('generating');
    }

    try {
      // Get note and its content
      const note = await this.documentClient.readNote(noteId);
      if (!note) {
        Utils.showToast('Note not found', 'error');
        return;
      }

      const content = this.noteText(await this.documentClient.blocksOf(noteId));

      if (content.trim().length < 10) {
        Utils.showToast('Not enough content to generate title', 'error');
        return;
      }

      const newTitle = await this.llm.generateTitle(content);

      if (!newTitle || !newTitle.trim()) {
        Utils.showToast('Failed to generate title', 'error');
        return;
      }

      // The user asked for it, so it goes over a title set by hand too, as 1.4.x put it, and it
      // goes to the note it was asked for, whichever note is open now
      const outcome = await this.documentClient.renameNote(noteId, newTitle, 'generated');
      if (outcome.kind === 'rejected' && outcome.code === 'note-not-found') {
        Utils.showToast('Note not found', 'error');
        return;
      }
      if (outcome.kind !== 'committed') throw notStored('title', outcome);

      await this.showCommittedTitle(noteId, newTitle);

      Utils.showToast(`Title updated: "${newTitle}"`, 'success');
    } catch (error) {
      console.error('Failed to generate title:', error);
      Utils.showToast('Failed to generate title: ' + error.message, 'error');
    } finally {
      // Remove loading state
      if (pageTitle) {
        pageTitle.classList.remove('title-generating');
      }
      // Sidebar item may have been re-rendered, so query again
      const updatedSidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);
      if (updatedSidebarItem) {
        updatedSidebarItem.classList.remove('generating');
      }
    }
  }

  // ─── AI: Insights Extraction ───

  /**
   * Extract insights for a note by ID
   */
  async extractInsightsForNote(noteId) {
    // Check if LLM is configured
    if (!this.llm.isConfigured()) {
      Utils.showToast('AI not configured. Please set up in Settings.', 'error');
      return;
    }

    // Mark extraction as in progress (persisted across page refreshes)
    await this.markInsightsPending(noteId, true);

    // Show loading state on sidebar item
    const sidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);
    if (sidebarItem) {
      sidebarItem.classList.add('generating');
    }

    // Show loading state in insights section if this is the current note
    const editor = this.getEditor ? this.getEditor() : null;
    const isCurrentNote = editor && editor.noteId === noteId;
    if (isCurrentNote) {
      this.showInsightsLoading();
    }

    /** @type {Object|null} The insights stored, which the editor shows once the mark is cleared */
    let stored = null;
    try {
      // Get note and its content
      const note = await this.documentClient.readNote(noteId);
      if (!note) {
        Utils.showToast('Note not found', 'error');
        return;
      }

      const content = this.noteText(await this.documentClient.blocksOf(noteId));

      if (content.trim().length < 20) {
        Utils.showToast('Not enough content to extract insights', 'error');
        return;
      }

      this.logger.debug('NotesManager', 'Extracting insights for note content length:', content.length);
      const insights = await this.llm.extractInsights(content, note.name);

      if (!insights) {
        Utils.showToast('Could not extract insights. Check console for details.', 'info');
        return;
      }

      // The insight fields of the note it was asked for, and nothing else of it
      const outcome = await this.documentClient.attachInsights(noteId, insights, this.generateContentHash(content));
      if (outcome.kind === 'rejected' && outcome.code === 'note-not-found') {
        Utils.showToast('Note not found', 'error');
        return;
      }
      if (outcome.kind !== 'committed') throw notStored('insights', outcome);
      stored = insights;

      // Count extracted items
      const itemCount = (insights.todos?.length || 0) +
        (insights.reminders?.length || 0) +
        (insights.deadlines?.length || 0) +
        (insights.highlights?.length || 0);

      Utils.showToast(`Extracted ${itemCount} insight${itemCount !== 1 ? 's' : ''}`, 'success');
    } catch (error) {
      console.error('Failed to extract insights:', error);
      Utils.showToast('Failed to extract insights: ' + error.message, 'error');
      // Remove loading state from insights on error, while the editor still shows that note
      if (this.editorHolds(noteId)) {
        this.hideInsightsLoading();
      }
    } finally {
      // Clear extraction state
      await this.markInsightsPending(noteId, false);

      // Remove loading state
      const updatedSidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);
      if (updatedSidebarItem) {
        updatedSidebarItem.classList.remove('generating');
      }
    }
    // Shown after the mark is cleared, so the editor draws the insights rather than "Extracting..."
    if (stored) this.showCommittedInsights(noteId, stored);
  }

  // ─── Jobs: what they read and write through the document client ───

  /**
   * The text the jobs send the provider: a note's blocks in order, as 1.4.x joined them
   * @param {Array<Object>} blocks
   * @returns {string}
   */
  noteText(blocks) {
    return blocks
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(b => this.extractBlockText(b))
      .filter(t => t.trim())
      .join('\n\n');
  }

  /**
   * Whether the editor getEditor answers holds `noteId` now
   * @param {string} noteId
   * @returns {boolean}
   */
  editorHolds(noteId) {
    const editor = this.getEditor ? this.getEditor() : null;
    return Boolean(editor && editor.noteId === noteId);
  }

  /**
   * Show a title the kernel committed for `noteId`, as 1.4.x showed it: in the editor if it
   * holds that note (display only, no save), in the note's tab, and in the list. A title the
   * user typed there that no save has stored yet stays, and names the tab when it lands.
   * @param {string} noteId
   * @param {string} name
   * @returns {Promise<void>}
   */
  async showCommittedTitle(noteId, name) {
    const editor = this.getEditor ? this.getEditor() : null;
    const shown = editor && typeof editor.showCommittedTitle === 'function'
      ? editor.showCommittedTitle(noteId, name)
      : 'not-open';
    if (shown !== 'typed-title-pending') {
      const openTabs = this.getOpenTabs ? this.getOpenTabs() : [];
      const tabIndex = openTabs.findIndex(t => t.noteId === noteId);
      if (tabIndex !== -1) {
        openTabs[tabIndex].name = name;
        if (this.onRenderTabs) this.onRenderTabs();
        if (this.onSaveTabs) await this.onSaveTabs();
      }
    }
    if (this.onRenderNotesList) this.onRenderNotesList();
  }

  /**
   * Show insights the kernel committed for `noteId` in the editor, if it holds that note
   * (display only, no save)
   * @param {string} noteId
   * @param {Object} insights
   * @returns {void}
   */
  showCommittedInsights(noteId, insights) {
    const editor = this.getEditor ? this.getEditor() : null;
    if (editor && typeof editor.showCommittedInsights === 'function') {
      editor.showCommittedInsights(noteId, { insights, lastInsightsExtractedAt: Date.now() });
    }
  }

  /**
   * Mark `noteId`'s insights as being extracted, or clear the mark. A mark that isn't stored is
   * logged, as 1.4.x logged a failed setSetting, and the extraction goes on.
   * @param {string} noteId
   * @param {boolean} pending
   * @returns {Promise<void>}
   */
  async markInsightsPending(noteId, pending) {
    const outcome = await this.documentClient.setInsightsPending(noteId, pending);
    if (outcome.kind !== 'committed') console.error('Insights: the extraction mark was not stored', outcome.kind, outcome.code);
  }

  /**
   * The stored preferences of `keys`, or none when the read fails, as 1.4.x's getSetting
   * answered its defaults
   * @param {Array<string>} keys
   * @returns {Promise<Object>}
   */
  async jobPreferences(keys) {
    try {
      return await this.documentClient.preferences(keys);
    } catch (error) {
      console.warn('NotesManager: could not read the job settings', error && error.message);
      return {};
    }
  }

  /**
   * When each job last started, 0 for never or when the read fails, as 1.4.x's getSetting
   * answered its default
   * @returns {Promise<{lastAutoTitleRun: number, lastInsightsRun: number}>}
   */
  async jobRuns() {
    try {
      return await this.documentClient.jobRuns();
    } catch (error) {
      console.warn('NotesManager: could not read when the jobs last ran', error && error.message);
      return { lastAutoTitleRun: 0, lastInsightsRun: 0 };
    }
  }

  /**
   * Record that `job` starts a run now. A run whose start isn't stored stops, as 1.4.x's did
   * when its setSetting failed.
   * @param {'autoTitle'|'insights'} job
   * @returns {Promise<void>}
   */
  async recordJobRun(job) {
    const outcome = await this.documentClient.recordJobRun(job);
    if (outcome.kind !== 'committed') throw notStored(`the ${job} run`, outcome);
  }

  /**
   * Show loading indicator in insights section
   */
  showInsightsLoading() {
    // Remove existing insights section
    const existingInsights = document.getElementById('note-insights');
    if (existingInsights) {
      existingInsights.remove();
    }

    // Create loading placeholder
    const loadingEl = document.createElement('div');
    loadingEl.id = 'note-insights';
    loadingEl.className = 'note-insights insights-loading';
    loadingEl.innerHTML = `
      <div class="note-insights-header">
        <div class="note-insights-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path>
          </svg>
          <span>AI Insights</span>
        </div>
        <div class="insights-loading-indicator">
          <div class="insights-spinner"></div>
          <span>Extracting...</span>
        </div>
      </div>
    `;

    // Insert after timestamp
    const timestamp = document.getElementById('page-timestamp');
    if (timestamp) {
      timestamp.after(loadingEl);
    }
  }

  /**
   * Hide loading indicator in insights section
   */
  hideInsightsLoading() {
    const loadingEl = document.getElementById('note-insights');
    if (loadingEl && loadingEl.classList.contains('insights-loading')) {
      loadingEl.remove();
    }
  }

  // ─── Auto-Title ───

  /**
   * Setup auto-title feature
   */
  async setupAutoTitle() {
    const { autoTitleEnabled: enabled = false, autoTitleInterval: interval = 15 } =
      await this.jobPreferences(['autoTitleEnabled', 'autoTitleInterval']);

    if (enabled && this.llm.isConfigured()) {
      await this.checkMissedAutoTitles(interval);
      this.startAutoTitleInterval(interval);
    }
  }

  /**
   * Check for missed auto-title generations (browser was closed)
   */
  async checkMissedAutoTitles(intervalMinutes) {
    const { lastAutoTitleRun: lastRunTimestamp } = await this.jobRuns();
    const oneHourMs = 60 * 60 * 1000;

    if (lastRunTimestamp && (Date.now() - lastRunTimestamp) > oneHourMs) {
      this.logger.debug('NotesManager', 'Missed auto-title window, running catch-up');
      await this.runAutoTitle(true);
    }
  }

  /**
   * Start the auto-title interval
   */
  startAutoTitleInterval(intervalMinutes) {
    this.stopAutoTitleInterval();
    const intervalMs = intervalMinutes * 60 * 1000;

    this.runAutoTitle();

    this.autoTitleIntervalId = setInterval(() => {
      this.runAutoTitle();
    }, intervalMs);

    this.logger.info('NotesManager', `Auto-title started with ${intervalMinutes} minute interval`);
  }

  /**
   * Stop the auto-title interval
   */
  stopAutoTitleInterval() {
    if (this.autoTitleIntervalId) {
      clearInterval(this.autoTitleIntervalId);
      this.autoTitleIntervalId = null;
      this.logger.debug('NotesManager', 'Auto-title stopped');
    }
  }

  /**
   * Run auto-title generation for eligible notes
   */
  async runAutoTitle(isCatchUp = false) {
    if (this.autoTitleRunning) {
      this.logger.debug('NotesManager', 'Auto-title already running, skipping');
      return;
    }

    if (!this.llm.isConfigured()) {
      this.logger.debug('NotesManager', 'LLM not configured, skipping auto-title');
      return;
    }

    this.autoTitleRunning = true;

    try {
      await this.recordJobRun('autoTitle');

      const notes = await this.documentClient.activeNotes();

      for (const note of notes) {
        // The note this pass is for, whichever note the editor shows when the provider answers
        const noteId = note.id;
        if (note.titleManuallySet) continue;

        const currentTitle = (note.name || '').trim();
        const isUntitled = !currentTitle ||
          currentTitle.toLowerCase() === 'untitled' ||
          currentTitle.toLowerCase().startsWith('untitled ');

        if (!isUntitled) continue;

        const content = this.noteText(await this.documentClient.blocksOf(noteId));

        if (content.trim().length < 20) continue;

        const contentHash = this.generateContentHash(content);
        if (note.lastTitleContentHash && note.lastTitleContentHash === contentHash) continue;

        try {
          this.logger.debug('NotesManager', `Generating title for note: ${noteId}`);

          const isCurrentNote = this.editorHolds(noteId);
          const pageTitle = document.getElementById('page-title');
          const sidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);

          if (isCurrentNote && pageTitle) {
            pageTitle.classList.add('title-generating');
          }
          if (sidebarItem) {
            sidebarItem.classList.add('generating');
          }

          const newTitle = await this.llm.generateTitle(content);

          if (pageTitle) {
            pageTitle.classList.remove('title-generating');
          }
          const updatedSidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);
          if (updatedSidebarItem) {
            updatedSidebarItem.classList.remove('generating');
          }

          if (newTitle && newTitle.trim()) {
            // Checked against the note as committed: a title set by hand meanwhile keeps it
            const outcome = await this.documentClient.deriveTitle(noteId, newTitle, contentHash);
            if (outcome.kind === 'committed' && outcome.code === 'title-derived') {
              await this.showCommittedTitle(noteId, newTitle);
              this.logger.info('NotesManager', `Auto-title generated for note ${noteId}`);
            } else if (outcome.kind !== 'committed') {
              console.error(`Auto-title for note ${noteId} was not stored:`, outcome.kind, outcome.code);
            }
          }
        } catch (error) {
          console.error(`Failed to generate title for note ${noteId}:`, error);

          const pageTitle = document.getElementById('page-title');
          if (pageTitle) {
            pageTitle.classList.remove('title-generating');
          }
          const sidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);
          if (sidebarItem) {
            sidebarItem.classList.remove('generating');
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error('Auto-title run failed:', error);
    } finally {
      this.autoTitleRunning = false;
    }
  }

  /**
   * Update auto-title settings and restart interval if needed
   */
  async updateAutoTitleSettings(enabled, interval) {
    await this.storage.setSetting('autoTitleEnabled', enabled);
    await this.storage.setSetting('autoTitleInterval', interval);

    if (enabled && this.llm.isConfigured()) {
      this.startAutoTitleInterval(interval);
    } else {
      this.stopAutoTitleInterval();
    }
  }

  // ─── Insights Extraction ───

  /**
   * Setup insights extraction feature
   */
  async setupInsightsExtraction() {
    const { insightsEnabled: enabled = false, insightsInterval: interval = 360 } =
      await this.jobPreferences(['insightsEnabled', 'insightsInterval']);

    if (enabled && this.llm.isConfigured()) {
      await this.checkMissedInsightsExtraction(interval);
      this.startInsightsInterval(interval);
    }
  }

  /**
   * Check for missed insights extractions (browser was closed)
   */
  async checkMissedInsightsExtraction(intervalMinutes) {
    const { lastInsightsRun: lastRunTimestamp } = await this.jobRuns();
    const intervalMs = intervalMinutes * 60 * 1000;

    if (lastRunTimestamp && (Date.now() - lastRunTimestamp) > intervalMs) {
      this.logger.debug('NotesManager', 'Missed insights extraction window, running catch-up');
      await this.runInsightsExtraction(true);
    }
  }

  /**
   * Start the insights extraction interval
   */
  startInsightsInterval(intervalMinutes) {
    this.stopInsightsInterval();
    const intervalMs = intervalMinutes * 60 * 1000;

    this.runInsightsExtraction();

    this.insightsIntervalId = setInterval(() => {
      this.runInsightsExtraction();
    }, intervalMs);

    this.logger.info('NotesManager', `Insights extraction started with ${intervalMinutes} minute interval`);
  }

  /**
   * Stop the insights extraction interval
   */
  stopInsightsInterval() {
    if (this.insightsIntervalId) {
      clearInterval(this.insightsIntervalId);
      this.insightsIntervalId = null;
      this.logger.debug('NotesManager', 'Insights extraction stopped');
    }
  }

  /**
   * Run insights extraction for all notes
   */
  async runInsightsExtraction(isCatchUp = false) {
    if (this.insightsRunning) {
      this.logger.debug('NotesManager', 'Insights extraction already running, skipping');
      return;
    }

    if (!this.llm.isConfigured()) {
      this.logger.debug('NotesManager', 'LLM not configured, skipping insights extraction');
      return;
    }

    this.insightsRunning = true;

    try {
      await this.recordJobRun('insights');

      const notes = await this.documentClient.activeNotes();
      let extractedCount = 0;
      let authError = false;

      for (const note of notes) {
        if (authError) break;
        // The note this pass is for, whichever note the editor shows when the provider answers
        const noteId = note.id;

        const content = this.noteText(await this.documentClient.blocksOf(noteId));

        if (content.trim().length < 50) continue;

        const contentHash = this.generateContentHash(content);
        if (note.lastInsightsContentHash && note.lastInsightsContentHash === contentHash) continue;

        try {
          this.logger.debug('NotesManager', `Extracting insights for note: ${noteId}`);

          const insights = await this.llm.extractInsights(content, note.name);

          if (insights) {
            // The insight fields and nothing else, so an edit, pin, or trash made meanwhile stays
            const outcome = await this.documentClient.attachInsights(noteId, insights, contentHash);
            if (outcome.kind === 'committed') {
              this.showCommittedInsights(noteId, insights);
              extractedCount++;
              this.logger.debug('NotesManager', `Insights extracted for note: ${noteId}`);
            } else {
              console.error(`Insights for note ${noteId} were not stored:`, outcome.kind, outcome.code);
            }
          }
        } catch (error) {
          const errorMsg = (error.message || '').toLowerCase();
          const errorName = (error.name || '').toLowerCase();

          if (errorMsg.includes('401') ||
              errorMsg.includes('unauthorized') ||
              errorMsg.includes('auth') ||
              errorMsg.includes('api key') ||
              errorMsg.includes('invalid') ||
              errorMsg.includes('cookie') ||
              errorMsg.includes('forbidden') ||
              errorMsg.includes('not authorized')) {
            console.warn('Insights extraction stopped: Authentication error. Please check your API key in Settings.');
            authError = true;
            break;
          }

          if (errorName === 'typeerror' ||
              errorMsg.includes('failed to fetch') ||
              errorMsg.includes('network') ||
              errorMsg.includes('enotfound') ||
              errorMsg.includes('econnrefused') ||
              errorMsg.includes('econnreset')) {
            console.warn('Insights extraction stopped: Network error. Please check your internet connection.');
            authError = true;
            break;
          }

          console.warn(`Failed to extract insights for note ${note.id}:`, error.message);
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      if (extractedCount > 0) {
        this.logger.info('NotesManager', `Insights extraction complete: ${extractedCount} note(s) updated`);
      }
    } catch (error) {
      console.error('Insights extraction run failed:', error);
    } finally {
      this.insightsRunning = false;
    }
  }

  /**
   * Update insights settings and restart interval if needed
   */
  async updateInsightsSettings(enabled, interval) {
    await this.storage.setSetting('insightsEnabled', enabled);
    await this.storage.setSetting('insightsInterval', interval);

    if (enabled && this.llm.isConfigured()) {
      this.startInsightsInterval(interval);
    } else {
      this.stopInsightsInterval();
    }
  }

  /**
   * Get all notes with their insights for daily summary
   */
  async getNotesWithInsights() {
    const notes = await this.storage.getAllNotes();
    return notes.filter(note => note.insights && (
      (note.insights.todos && note.insights.todos.length > 0) ||
      (note.insights.reminders && note.insights.reminders.length > 0) ||
      (note.insights.deadlines && note.insights.deadlines.length > 0)
    ));
  }

  // ─── Search Index & Embeddings ───

  /**
   * Refresh search index entries from storage
   */
  async refreshSearchIndexEntries() {
    const entries = await this.storage.getSearchIndex();
    this.searchIndexByNoteId = new Map(entries.map(entry => [entry.noteId, entry]));
    return entries;
  }

  /**
   * Initialize search indexer
   */
  initIndexer() {
    if (typeof Worker === 'undefined') return;
    // Search indexing is off while the search_index store is missing.
    if (!this.storage.hasStore('search_index')) return;
    try {
      this.indexerWorker = new Worker('js/workers/indexer.js');
      this.indexerWorker.onmessage = async (e) => {
        if (e.data.type === 'INDEX_COMPLETE') {
          await this.storage.setSearchIndex(e.data.data);
          await this.refreshSearchIndexEntries();
        } else if (e.data.type === 'INDEX_UPDATED') {
          const { entry } = e.data.data;
          await this.storage.setSearchIndexEntry(entry);
          this.searchIndexByNoteId.set(entry.noteId, entry);
        } else if (e.data.type === 'INDEX_REMOVED') {
          const { noteId } = e.data.data;
          await this.storage.removeSearchIndexEntry(noteId);
          this.searchIndexByNoteId.delete(noteId);
        }
      };

      this.rebuildSearchIndex();
    } catch (e) {
      console.warn('Failed to start indexer worker:', e);
    }
  }

  /**
   * Rebuild the search index
   */
  async rebuildSearchIndex() {
    if (!this.indexerWorker) return;
    const blocksByNote = {};
    for (const note of this.notes) {
      blocksByNote[note.id] = await this.storage.getElementsByNote(note.id);
    }
    this.indexerWorker.postMessage({
      type: 'INDEX_NOTES',
      data: { notes: this.notes, blocks: blocksByNote }
    });
  }

  /**
   * Send an incremental index update for a single note to the worker
   * @param {string} noteId
   */
  async updateNoteIndex(noteId) {
    if (!this.indexerWorker) return;
    const note = this.notes.find(n => n.id === noteId);
    if (!note) return;
    const blocks = await this.storage.getElementsByNote(noteId);
    this.indexerWorker.postMessage({
      type: 'UPDATE_NOTE',
      data: { note, blocks }
    });
  }

  /**
   * Remove a note from the search index via the worker
   * @param {string} noteId
   */
  removeNoteIndex(noteId) {
    if (!this.indexerWorker) return;
    this.indexerWorker.postMessage({
      type: 'REMOVE_NOTE',
      data: { noteId }
    });
  }

  /**
   * Initialize embeddings: load existing vectors into search engine.
   * Does NOT load the AI model — that happens lazily on first use (Req 27.3).
   */
  async initEmbeddings() {
    if (typeof Embeddings === 'undefined') return;

    const vectors = await this.storage.getAllVectors();
    if (this.searchEngine) {
      this.searchEngine.setVectors(vectors);
    }
  }

  /**
   * Trigger embedding model load and update missing embeddings.
   * Called lazily when AI sidebar is first opened or semantic search is used.
   */
  async loadEmbeddingsModel() {
    if (typeof Embeddings === 'undefined') return;
    this.updateMissingEmbeddings();
  }

  /**
   * Background process to update missing embeddings
   */
  async updateMissingEmbeddings() {
    if (typeof Embeddings === 'undefined') return;
    // Semantic search is off while the vectors store is missing: don't load the model for nothing.
    if (!this.storage.hasStore('vectors')) return;

    const vectors = await this.storage.getAllVectors();
    const vectorMap = new Map(vectors.map(v => [v.noteId, v]));

    const notesToEmbed = this.notes.filter(note => {
      const vector = vectorMap.get(note.id);
      return !vector || vector.updatedAt < note.updatedAt;
    });

    if (notesToEmbed.length === 0) return;

    this.logger.debug('NotesManager', `Embeddings: Found ${notesToEmbed.length} notes needing updates`);

    for (let i = 0; i < notesToEmbed.length; i++) {
      const note = notesToEmbed[i];
      const elements = await this.storage.getElementsByNote(note.id);
      const content = elements
        .filter(el => el.type === 'text')
        .map(el => el.content)
        .join(' ');

      const textToEmbed = `${note.name}\n${content}`;
      if (textToEmbed.trim().length > 0) {
        const vector = await Embeddings.generateEmbedding(textToEmbed);
        if (vector) {
          await this.storage.saveVector(note.id, vector);
        }
      }

      // Yield to main thread
      if (i % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Refresh vectors in engine after update
    const updatedVectors = await this.storage.getAllVectors();
    if (this.searchEngine) {
      this.searchEngine.setVectors(updatedVectors);
    }
    this.logger.debug('NotesManager', 'Embeddings: Background indexing complete');
  }

  // ─── Utility helpers ───

  /**
   * Generate a simple hash of content for change detection
   */
  generateContentHash(content) {
    let hash = 0;
    const str = content.trim();
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  /**
   * Extract text content from a block
   */
  extractBlockText(block) {
    if (!block) return '';

    switch (block.type) {
      case 'text':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'bullet':
      case 'numbered':
      case 'todo':
      case 'quote':
      case 'callout':
        return this.stripHtml(block.content || '');

      case 'code':
        return block.content || '';

      case 'toggle':
        const mainText = this.stripHtml(block.content || '');
        const childText = this.stripHtml(block.children || '');
        return [mainText, childText].filter(t => t).join('\n');

      case 'table':
        if (block.tableData && Array.isArray(block.tableData)) {
          return block.tableData.map(row => row.join(' ')).join('\n');
        }
        return '';

      case 'bookmark':
        return block.title || block.url || '';

      case 'equation':
        return block.equation || '';

      default:
        return '';
    }
  }

  /**
   * Strip HTML tags from string
   */
  stripHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  /**
   * High-fidelity HTML to Markdown converter for simple formatting
   */
  htmlToMarkdown(html) {
    if (!html) return '';

    const div = document.createElement('div');
    div.innerHTML = html;

    const replacements = [
      { sel: 'b, strong', tag: '**' },
      { sel: 'i, em', tag: '*' },
      { sel: 'u', tag: '__' },
      { sel: 'code', tag: '`' },
      { sel: 'del, s, strike', tag: '~~' }
    ];

    replacements.forEach(({ sel, tag }) => {
      div.querySelectorAll(sel).forEach(el => {
        el.textContent = `${tag}${el.textContent}${tag}`;
      });
    });

    div.querySelectorAll('a').forEach(el => {
      const href = el.getAttribute('href') || '';
      el.textContent = `[${el.textContent}](${href})`;
    });

    div.querySelectorAll('span').forEach(el => {
      const color = el.style.color;
      const bg = el.style.backgroundColor;
      if (color || bg) {
        el.outerHTML = el.innerHTML;
      }
    });

    return div.textContent || div.innerText || '';
  }
}

// Dual CommonJS/browser export pattern
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NotesManager };
} else if (typeof window !== 'undefined') {
  window.NotesManager = NotesManager;
}
