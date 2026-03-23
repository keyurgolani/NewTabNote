/**
 * Block Editor - handles all editor interactions
 */

class BlockEditor {
  constructor(config = {}) {
    this.root = config.root || document;
    this.doc = this.root.ownerDocument || this.root || document;
    this.noteId = null;
    this.noteData = null;
    this.blocks = [];
    this.onChange = config.onChange || null;
    this.container = this.root.querySelector('.blocks-container') || this.doc.getElementById('blocks-container');
    this.titleEl = this.root.querySelector('.page-title') || this.doc.getElementById('page-title');
    this.slashMenu = this.root.querySelector('.slash-menu') || this.doc.getElementById('slash-menu');
    this.slashMenuItems = this.slashMenu ? this.slashMenu.querySelector('.slash-menu-items') : null;
    this.activeBlock = null;
    this.slashMenuVisible = false;
    this.slashMenuIndex = 0;
    this.slashFilter = '';

    // Wiki menu (for bidirectional linking)
    this.wikiMenu = this.root.querySelector('.wiki-menu') || this.doc.getElementById('wiki-menu');
    this.wikiMenuItems = this.wikiMenu ? this.wikiMenu.querySelector('.slash-menu-items') : null;
    this.wikiMenuVisible = false;
    this.wikiMenuIndex = 0;
    this.wikiFilter = '';
    this.noteNames = []; // Cached note names for autocomplete

    // Template menu
    this.templateMenu = this.root.querySelector('.template-menu') || this.doc.getElementById('template-menu');
    this.templateMenuItems = this.templateMenu ? this.templateMenu.querySelector('.slash-menu-items') : null;
    this.templateMenuVisible = false;
    this.templateMenuIndex = 0;
    this.templateFilter = '';
    this.templates = []; // Cached templates

    this.saveTimeout = null;
    this.isDragging = false;
    this.draggedBlock = null;
    this.isAutoTitleUpdate = false; // Flag to track programmatic title updates
    this.hasReceivedFirstContent = false; // Track if note has received content
    this.pendingAutoTitle = false; // Prevent duplicate auto-title calls
    this.insightsPollingId = null; // Polling interval for insights extraction completion

    // Image/File inputs are usually global per editor pane or shared
    this.imageInput = this.root.querySelector('.image-input') || this.doc.getElementById('image-input');
    this.fileInput = this.root.querySelector('.file-input') || this.doc.getElementById('file-input');

    // Undo/Redo stacks (Req 11.1–11.5)
    /** @type {Array<UndoEntry>} */
    this.undoStack = [];
    /** @type {Array<UndoEntry>} */
    this.redoStack = [];
    /** @type {number} */
    this.undoMaxSize = 100;
    /** @type {Object<string, {timer: number, before: Object}>} */
    this._contentUndoPending = {};

    // Multi-block selection (Req 13.1–13.5)
    /** @type {Set<string>} */
    this.selectedBlockIds = new Set();
    /** @type {string|null} */
    this.lastSelectedBlockId = null;

    // Lazy loading for images
    this.initImageObserver();

    // Version history snapshot tracking (Req 31.1)
    this._snapshotDirty = false;
    this._snapshotInterval = null;
    this._versionHistoryOpen = false;

    this.setupEventListeners();
    this.buildSlashMenu();

    // Floating formatting toolbar (Req 9.1–9.5)
    if (typeof FormattingToolbar !== 'undefined') {
      this.formattingToolbar = new FormattingToolbar({ doc: this.doc });
    }

    // Touch device detection (Req 10.1)
    this.isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (this.isTouchDevice) {
      this.doc.body.classList.add('touch-device');
    }
  }

  /**
   * Helper to get the app instance, searching opener if in PiP.
   * @returns {Object|null} App instance
   */
  getApp() {
    return window.app || (window.opener && window.opener.app);
  }

  /**
   * Helper to get the LLM instance, searching opener if in PiP.
   * @returns {Object|null} LLM service instance
   */
  getLLM() {
    return window.LLM || (window.opener && window.opener.LLM);
  }

  /**
   * Setup all event listeners for the editor.
   * @returns {void}
   */
  setupEventListeners() {
    // Title events
    this.titleEl.addEventListener('input', () => this.onTitleChange());
    this.titleEl.addEventListener('keydown', (e) => this.onTitleKeyDown(e));

    // Container events for delegation
    this.container.addEventListener('input', (e) => this.onBlockInput(e));
    this.container.addEventListener('keydown', (e) => this.onBlockKeyDown(e));
    this.container.addEventListener('focus', (e) => this.onBlockFocus(e), true);
    this.container.addEventListener('blur', (e) => this.onBlockBlur(e), true);
    this.container.addEventListener('click', (e) => this.onBlockClick(e));

    // Table cell right-click context menu (Req 33.3)
    this.container.addEventListener('contextmenu', (e) => this.onTableContextMenu(e));

    // Drag and drop
    this.container.addEventListener('dragstart', (e) => this.onDragStart(e));
    this.container.addEventListener('dragend', (e) => this.onDragEnd(e));
    this.container.addEventListener('dragover', (e) => this.onDragOver(e));
    this.container.addEventListener('drop', (e) => this.onDrop(e));

    // Long-press drag for touch devices (Req 10.2)
    this._longPressTimer = null;
    this.container.addEventListener('touchstart', (e) => this.onHandleTouchStart(e), { passive: false });
    this.container.addEventListener('touchend', (e) => this.onHandleTouchEnd(e));
    this.container.addEventListener('touchmove', (e) => this.onHandleTouchMove(e));

    // Add block hint
    const addBlockHint = this.root.querySelector('.add-block-hint') || this.doc.getElementById('add-block-hint');
    if (addBlockHint) {
      addBlockHint.addEventListener('click', () => {
        this.addBlockAtEnd();
      });
    }

    // Slash menu
    this.slashMenu.addEventListener('click', (e) => this.onSlashMenuClick(e));

    // Close slash menu on outside click
    this.doc.addEventListener('click', (e) => {
      if (!this.slashMenu.contains(e.target) && this.slashMenuVisible) {
        this.hideSlashMenu();
      }
    });

    // Image input
    if (this.imageInput) {
      this.imageInput.addEventListener('change', (e) => {
        this.handleImageUpload(e);
      });
    }

    // File input
    if (this.fileInput) {
      this.fileInput.addEventListener('change', (e) => {
        this.handleFileUpload(e);
      });
    }

    // Global keyboard shortcuts
    this.doc.addEventListener('keydown', (e) => this.onGlobalKeyDown(e));

    // Global paste handler
    this.doc.addEventListener('paste', (e) => this.onPaste(e));

    // Window resize
    this.doc.defaultView.addEventListener('resize', Utils.debounce(() => {
      this.updateWideContentCentering();
    }, 100));
  }

  /**
   * Load a note by ID into the editor.
   * @param {string} noteId - Note ID to load
   * @returns {Promise<void>}
   */
  async loadNote(noteId) {
    // Clear any existing insights polling
    if (this.insightsPollingId) {
      clearInterval(this.insightsPollingId);
      this.insightsPollingId = null;
    }

    this.noteId = noteId;
    this.noteData = await Storage.getNote(noteId);

    // Clear undo/redo stacks for new note
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._contentUndoPending = {};

    // Clear multi-block selection
    this.clearBlockSelection();

    // Reset snapshot tracking for new note (Req 31.1)
    this._snapshotDirty = false;
    this._stopSnapshotInterval();
    this._startSnapshotInterval();

    if (!this.noteData) {
      console.error('Note not found:', noteId);
      return;
    }

    // Set title
    this.titleEl.textContent = this.noteData.name || '';

    // Set timestamp
    this.updateTimestampDisplay();

    // Render insights section if available (async - checks for extraction state)
    await this.renderInsights();

    // Start polling if extraction is in progress
    await this.startInsightsPollingIfNeeded();

    // Load blocks
    const blocksData = await Storage.getElementsByNote(noteId);
    this.blocks = blocksData
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((data) => Block.deserialize(data));

    // Check if note already has content (for first-content detection)
    const existingContent = this.blocks.some(block => {
      const text = this.extractBlockTextContent(block);
      return text && text.trim().length > 0;
    });
    this.hasReceivedFirstContent = existingContent;
    this.pendingAutoTitle = false;

    // Render blocks
    this.renderBlocks();

    // Render backlinks
    this.renderBacklinks();

    // If no blocks, create initial empty block and focus it
    if (this.blocks.length === 0) {
      const block = this.createBlock('text');
      this.blocks.push(block);
      this.renderBlocks();
    }

    // Scroll to top of editor
    // Set editor width
    const editorContainer = this.root.querySelector('.editor-container') || this.doc.getElementById('editor-container');

    // Focus first block, then ensure scroll is at top
    setTimeout(() => {
      const firstContent = this.container.querySelector('.block-content');
      if (firstContent) {
        firstContent.focus();
        this.placeCaretAtEnd(firstContent);
      }
      // Reset scroll after focus (focus can cause scroll)
      if (editorContainer) {
        editorContainer.scrollTop = 0;
      }
    }, 50);
  }

  /**
   * Start polling for insights extraction completion if needed
   */
  async startInsightsPollingIfNeeded() {
    const extractingTimestamp = await Storage.getSetting(`insightsExtracting_${this.noteId}`, null);
    if (!extractingTimestamp) {
      return;
    }

    // Check if extraction started within the last 5 minutes
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    if (extractingTimestamp <= fiveMinutesAgo) {
      return;
    }

    // Poll every 2 seconds to check if extraction completed
    this.insightsPollingId = setInterval(async () => {
      const stillExtracting = await Storage.getSetting(`insightsExtracting_${this.noteId}`, null);

      if (!stillExtracting) {
        // Extraction completed - reload note data and render insights
        clearInterval(this.insightsPollingId);
        this.insightsPollingId = null;

        // Reload note data to get updated insights
        this.noteData = await Storage.getNote(this.noteId);
        await this.renderInsights();
      }
    }, 2000);
  }

  /**
   * Render the insights section for the current note
   */
  async renderInsights() {
    // Remove existing insights section
    const existingInsights = this.root.querySelector('.note-insights') || this.doc.getElementById('note-insights');
    if (existingInsights) {
      existingInsights.remove();
    }

    if (!this.noteData) {
      return;
    }

    // Check if extraction is in progress for this note
    const extractingTimestamp = await Storage.getSetting(`insightsExtracting_${this.noteId}`, null);
    if (extractingTimestamp) {
      // Check if extraction started within the last 5 minutes (timeout protection)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      if (extractingTimestamp > fiveMinutesAgo) {
        // Show loading state
        this.showInsightsLoadingInEditor();
        return;
      } else {
        // Extraction timed out, clear the stale state
        await Storage.setSetting(`insightsExtracting_${this.noteId}`, null);
      }
    }

    // Check if note has insights
    if (!this.noteData.insights) {
      return;
    }

    const insights = this.noteData.insights;
    const hasContent = (insights.todos && insights.todos.length > 0) ||
      (insights.reminders && insights.reminders.length > 0) ||
      (insights.deadlines && insights.deadlines.length > 0) ||
      (insights.highlights && insights.highlights.length > 0) ||
      (insights.tags && insights.tags.length > 0);

    if (!hasContent) {
      return;
    }

    // Create insights container
    const insightsEl = this.doc.createElement('div');
    insightsEl.id = 'note-insights';
    insightsEl.className = 'note-insights';

    // Header
    const header = this.doc.createElement('div');
    header.className = 'note-insights-header';

    const titleContainer = this.doc.createElement('div');
    titleContainer.className = 'note-insights-title';
    titleContainer.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path>
      </svg>
      <span>AI Insights</span>
    `;

    const meta = this.doc.createElement('div');
    meta.className = 'note-insights-meta';
    if (insights.extractedAt) {
      meta.textContent = `Updated ${this.formatRelativeTime(insights.extractedAt)}`;
    }

    const refreshBtn = this.doc.createElement('button');
    refreshBtn.className = 'note-insights-refresh';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', () => this.refreshInsights());

    header.appendChild(titleContainer);
    header.appendChild(meta);
    header.appendChild(refreshBtn);
    insightsEl.appendChild(header);

    // Tags section (displayed at top as pills)
    if (insights.tags && insights.tags.length > 0) {
      const tagsContainer = this.doc.createElement('div');
      tagsContainer.className = 'note-insights-tags';

      insights.tags.forEach(tag => {
        const tagEl = this.doc.createElement('span');
        tagEl.className = 'note-insights-tag';
        tagEl.textContent = tag;
        tagsContainer.appendChild(tagEl);
      });

      insightsEl.appendChild(tagsContainer);
    }

    // Content container
    const content = this.doc.createElement('div');
    content.className = 'note-insights-content';

    // Deadlines section
    if (insights.deadlines && insights.deadlines.length > 0) {
      content.appendChild(this.createInsightsSection('Deadlines', insights.deadlines, 'deadlines'));
    }

    // Todos section
    if (insights.todos && insights.todos.length > 0) {
      content.appendChild(this.createInsightsSection('Action Items', insights.todos, 'todos'));
    }

    // Reminders section
    if (insights.reminders && insights.reminders.length > 0) {
      content.appendChild(this.createInsightsSection('Reminders', insights.reminders, 'reminders'));
    }

    // Highlights section
    if (insights.highlights && insights.highlights.length > 0) {
      content.appendChild(this.createInsightsSection('Key Points', insights.highlights, 'highlights'));
    }

    insightsEl.appendChild(content);

    // Insert after timestamp
    const timestamp = this.root.querySelector('.page-timestamp') || this.doc.getElementById('page-timestamp');
    if (timestamp) {
      timestamp.after(insightsEl);
    } else {
      this.titleEl.after(insightsEl);
    }
  }

  /**
   * Create an insights section
   */
  createInsightsSection(title, items, type) {
    const section = this.doc.createElement('div');
    section.className = 'note-insights-section';

    const sectionTitle = this.doc.createElement('div');
    sectionTitle.className = 'note-insights-section-title';
    sectionTitle.textContent = title;
    section.appendChild(sectionTitle);

    const list = this.doc.createElement('ul');
    list.className = `note-insights-list ${type}`;

    items.forEach(item => {
      const li = this.doc.createElement('li');

      if (type === 'deadlines' && typeof item === 'object') {
        const textSpan = this.doc.createElement('span');
        textSpan.textContent = item.text;
        li.appendChild(textSpan);

        if (item.date) {
          const dateInfo = this.getRelativeDateInfo(item.date);
          const dateSpan = this.doc.createElement('span');
          dateSpan.className = 'deadline-date';
          if (dateInfo.urgency) {
            dateSpan.classList.add(dateInfo.urgency);
          }

          // Show relative date with actual date in parentheses
          if (dateInfo.relative !== dateInfo.formatted) {
            dateSpan.textContent = dateInfo.relative + ' ';
            const actualDateSpan = this.doc.createElement('span');
            actualDateSpan.className = 'deadline-actual-date';
            actualDateSpan.textContent = `(${dateInfo.formatted})`;
            dateSpan.appendChild(actualDateSpan);
          } else {
            dateSpan.textContent = dateInfo.formatted;
          }
          li.appendChild(dateSpan);
        }
      } else {
        li.textContent = typeof item === 'object' ? item.text : item;
      }

      list.appendChild(li);
    });

    section.appendChild(list);
    return section;
  }

  /**
   * Get relative date info for deadline display
   */
  getRelativeDateInfo(dateStr) {
    if (!dateStr) return { relative: '', formatted: '', urgency: null };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const targetDate = new Date(dateStr + 'T00:00:00');
    const diffTime = targetDate.getTime() - today.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    const formatted = targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    let relative = '';
    let urgency = null;

    if (diffDays < -1) {
      relative = `${Math.abs(diffDays)} days ago`;
      urgency = 'overdue';
    } else if (diffDays === -1) {
      relative = 'Yesterday';
      urgency = 'overdue';
    } else if (diffDays === 0) {
      relative = 'Today';
      urgency = 'today';
    } else if (diffDays === 1) {
      relative = 'Tomorrow';
      urgency = 'soon';
    } else if (diffDays <= 3) {
      relative = `In ${diffDays} days`;
      urgency = 'soon';
    } else if (diffDays <= 7) {
      relative = `In ${diffDays} days`;
      urgency = 'upcoming';
    } else {
      relative = formatted;
      urgency = null;
    }

    return { relative, formatted, urgency };
  }

  /**
   * Format date for display
   */
  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /**
   * Format relative time
   */
  formatRelativeTime(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  /**
   * Show loading indicator in insights section (called from editor)
   */
  showInsightsLoadingInEditor() {
    // Remove existing insights section
    const existingInsights = this.root.querySelector('.note-insights') || this.doc.getElementById('note-insights');
    if (existingInsights) {
      existingInsights.remove();
    }

    // Create loading placeholder
    const loadingEl = this.doc.createElement('div');
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
    const timestamp = this.doc.getElementById('page-timestamp');
    if (timestamp) {
      timestamp.after(loadingEl);
    }
  }

  /**
   * Refresh insights for current note
   */
  async refreshInsights() {
    const llm = this.getLLM();
    if (!this.noteId || !llm || !llm.isConfigured()) {
      Utils.showToast('AI not configured', 'error');
      return;
    }

    const refreshBtn = this.doc.querySelector('.note-insights-refresh');
    if (refreshBtn) {
      refreshBtn.classList.add('loading');
      refreshBtn.textContent = 'Extracting...';
    }

    try {
      const content = this.getAllBlocksTextContent();
      if (content.trim().length < 20) {
        Utils.showToast('Not enough content to extract insights', 'error');
        return;
      }

      const insights = await llm.extractInsights(content, this.noteData.name);

      if (insights) {
        this.noteData.insights = insights;
        this.noteData.lastInsightsExtractedAt = Date.now();
        await Storage.updateNote(this.noteData);
        this.renderInsights();
        Utils.showToast('Insights updated', 'success');
      } else {
        Utils.showToast('No insights found', 'info');
      }
    } catch (error) {
      console.error('Failed to refresh insights:', error);
      Utils.showToast('Failed to extract insights', 'error');
    } finally {
      if (refreshBtn) {
        refreshBtn.classList.remove('loading');
        refreshBtn.textContent = 'Refresh';
      }
    }
  }

  /**
   * Extract text content from a block object (for content detection)
   */
  extractBlockTextContent(block) {
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
      case 'code':
        return this.stripHtmlTags(block.content || '');
      case 'toggle':
        return this.stripHtmlTags(block.content || '') + ' ' + this.stripHtmlTags(block.children || '');
      case 'table':
        if (block.tableData && Array.isArray(block.tableData)) {
          return block.tableData.map(row => row.join(' ')).join(' ');
        }
        return '';
      default:
        return '';
    }
  }

  /**
   * Strip HTML tags from a string
   */
  stripHtmlTags(html) {
    if (!html) return '';
    const div = this.doc.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  /**
   * Render all blocks
   */
  renderBlocks() {
    this.container.innerHTML = '';

    this.blocks.forEach((block, index) => {
      const el = block.createElement();
      if (block.type === 'numbered') {
        el.dataset.number = this.getNumberedListNumber(index);
      }
      this.container.appendChild(el);
    });

    this.observeImages();
    this.updateAddBlockHint();

    // Update wide content centering after render
    requestAnimationFrame(() => this.updateWideContentCentering());
  }

  /**
   * Setup load handlers for images to update centering once they're fully loaded
   */
  setupImageLoadHandlers() {
    const images = this.container.querySelectorAll('.block[data-type="image"] img');
    images.forEach(img => {
      if (img.complete) {
        // Image already loaded
        this.updateWideContentCentering();
      } else {
        // Wait for image to load
        img.addEventListener('load', () => {
          this.updateWideContentCentering();
        }, { once: true });
      }
    });
  }

  /**
   * Update centering for wide content blocks (tables, images, videos)
   * When content is wider than editor width, center it by applying negative left margin
   */
  updateWideContentCentering() {
    const editor = this.root.querySelector('.editor') || this.doc.getElementById('editor');
    if (!editor) return;

    const editorWidth = editor.offsetWidth;
    const wideBlockTypes = ['table', 'image', 'video'];

    console.debug('[Wide Content Centering] Editor width:', editorWidth);

    wideBlockTypes.forEach(type => {
      const blocks = this.container.querySelectorAll(`.block[data-type="${type}"]`);
      blocks.forEach(blockEl => {
        // Get the actual content element
        let contentEl;
        if (type === 'table') {
          contentEl = blockEl.querySelector('table');
        } else if (type === 'image') {
          contentEl = blockEl.querySelector('img');
        } else if (type === 'video') {
          contentEl = blockEl.querySelector('.video-container');
        }

        if (!contentEl) {
          // Reset if no content
          blockEl.style.marginLeft = '';
          blockEl.classList.remove('wide-content-centered');
          return;
        }

        // Get the natural/scroll width of the content
        const contentWidth = contentEl.scrollWidth || contentEl.offsetWidth;

        console.debug(`[Wide Content Centering] ${type} - Content width:`, contentWidth, 'Editor width:', editorWidth);

        if (contentWidth > editorWidth) {
          // Content is wider than editor - center it
          const overflow = contentWidth - editorWidth;
          const negativeMargin = -(overflow / 2);
          console.debug(`[Wide Content Centering] ${type} - Overflow:`, overflow, 'Negative margin:', negativeMargin);
          blockEl.style.marginLeft = `${negativeMargin}px`;
          blockEl.classList.add('wide-content-centered');
        } else {
          // Content fits - reset
          blockEl.style.marginLeft = '';
          blockEl.classList.remove('wide-content-centered');
        }
      });
    });
  }

  /**
   * Get number for numbered list item
   */
  getNumberedListNumber(index) {
    let num = 1;
    for (let i = index - 1; i >= 0; i--) {
      if (this.blocks[i].type === 'numbered') {
        num++;
      } else {
        break;
      }
    }
    return num;
  }

  /**
   * Update numbered list numbers
   */
  updateNumberedLists() {
    const blockEls = this.container.querySelectorAll('.block[data-type="numbered"]');
    blockEls.forEach((el) => {
      const block = this.getBlockById(el.dataset.id);
      if (block) {
        const index = this.blocks.indexOf(block);
        el.dataset.number = this.getNumberedListNumber(index);
      }
    });
  }

  /**
   * Create a new block object.
   * @param {string} type - Block type
   * @param {string} [content=''] - Block content
   * @param {Object} [options={}] - Additional block options
   * @returns {Object} New Block instance
   */
  createBlock(type, content = '', options = {}) {
    return new Block({
      type,
      content,
      ...options,
    });
  }

  /**
   * Add a new empty text block at the end of the note.
   * @returns {void}
   */
  addBlockAtEnd() {
    const block = this.createBlock('text');
    this.blocks.push(block);
    const el = block.createElement();
    this.container.appendChild(el);
    this.focusBlock(block.id);

    this.pushUndo({
      type: 'add',
      blockId: block.id,
      before: null,
      after: this.snapshotBlock(block),
    });

    this.scheduleSave();
    this.updateAddBlockHint();

    if (this.onChange) this.onChange();
  }

  /**
   * Get the next block order number (for appending new blocks)
   */
  async getNextBlockOrder() {
    if (this.blocks.length === 0) {
      return 0;
    }
    const maxOrder = Math.max(...this.blocks.map(b => b.order || 0));
    return maxOrder + 1;
  }

  /**
   * Insert block after another
   */
  insertBlockAfter(afterId, type = 'text', content = '', options = {}) {
    const index = this.blocks.findIndex((b) => b.id === afterId);
    const block = this.createBlock(type, content, options);

    if (index === -1) {
      this.blocks.push(block);
    } else {
      this.blocks.splice(index + 1, 0, block);
    }

    // Record undo for block creation
    const afterSnapshot = this.snapshotBlock(block);
    afterSnapshot.order = index === -1 ? this.blocks.length - 1 : index + 1;
    this.pushUndo({
      type: 'add',
      blockId: block.id,
      before: null,
      after: afterSnapshot,
    });

    // Insert DOM element incrementally instead of full re-render (Req 50.2)
    this.insertBlockDOM(block, afterId);
    this.focusBlock(block.id);
    this.scheduleSave();

    return block;
  }

  /**
   * Move a block up or down in the document order
   */
  moveBlockByDirection(blockId, direction) {
    const index = this.blocks.findIndex((block) => block.id === blockId);
    if (index === -1) return;

    const targetIndex = Math.max(0, Math.min(this.blocks.length - 1, index + direction));
    if (targetIndex === index) return;

    this.pushUndo({
      type: 'move',
      blockId,
      before: null,
      after: null,
      fromIndex: index,
      toIndex: targetIndex,
    });

    if (typeof ShortcutUtils !== 'undefined') {
      this.blocks = ShortcutUtils.moveItemInArray(this.blocks, index, targetIndex);
    } else {
      const moved = [...this.blocks];
      const [item] = moved.splice(index, 1);
      moved.splice(targetIndex, 0, item);
      this.blocks = moved;
    }

    this.renderBlocks();
    this.focusBlock(blockId, true);
    this.scheduleSave();
  }

  /**
   * Adjust indentation for list-like blocks
   */
  adjustBlockIndent(blockId, delta) {
    const block = this.getBlockById(blockId);
    if (!block || !['bullet', 'numbered', 'todo'].includes(block.type)) {
      return;
    }

    const currentIndent = block.indentLevel || 0;
    const nextIndent = typeof ShortcutUtils !== 'undefined'
      ? ShortcutUtils.clampIndentLevel(currentIndent, delta)
      : Math.max(0, Math.min(4, currentIndent + delta));

    if (nextIndent === currentIndent) {
      return;
    }

    block.indentLevel = nextIndent;
    this.rerenderBlock(block);
    this.focusBlock(block.id, true);
    this.scheduleSave();
  }

  /**
   * Delete a block
   */
  deleteBlock(blockId) {
    const index = this.blocks.findIndex((b) => b.id === blockId);
    if (index === -1) return;

    // Don't delete if it's the only block
    if (this.blocks.length === 1) {
      // Just clear it
      const beforeSnapshot = this.snapshotBlock(this.blocks[0]);
      this.blocks[0].content = '';
      this.blocks[0].type = 'text';
      this.pushUndo({
        type: 'content',
        blockId: this.blocks[0].id,
        before: beforeSnapshot,
        after: this.snapshotBlock(this.blocks[0]),
      });
      this.rerenderBlock(this.blocks[0]);
      this.focusBlock(this.blocks[0].id);
      return;
    }

    const beforeSnapshot = this.snapshotBlock(this.blocks[index]);
    beforeSnapshot.order = index;
    this.pushUndo({
      type: 'delete',
      blockId,
      before: beforeSnapshot,
      after: null,
    });

    this.blocks.splice(index, 1);
    Storage.deleteElement(blockId);

    // Remove DOM element incrementally instead of full re-render (Req 50.2)
    const focusIndex = Math.max(0, index - 1);
    this.removeBlockDOM(blockId);
    this.focusBlock(this.blocks[focusIndex].id, true);
    this.scheduleSave();
  }

  /**
   * Change block type
   */
  changeBlockType(blockId, newType) {
    const block = this.getBlockById(blockId);
    if (!block) return;

    const beforeSnapshot = this.snapshotBlock(block);
    const oldType = block.type;

    // Extract text content from incompatible block types (Req 12.3)
    if (['image', 'video', 'file', 'bookmark', 'equation', 'table'].includes(oldType)) {
      block.content = this.extractBlockTextContent(block) || '';
    }

    block.type = newType;

    // Discard incompatible properties (Req 12.3)
    if (newType !== 'table') {
      block.tableData = null;
      block.rows = 2;
      block.cols = 2;
    }
    if (newType !== 'image') {
      block.imageUrl = null;
    }
    if (newType !== 'bookmark') {
      block.url = '';
      block.title = '';
      block.description = '';
      block.favicon = '';
    }
    if (newType !== 'video') {
      block.videoUrl = '';
    }
    if (newType !== 'file') {
      block.fileName = '';
      block.fileSize = 0;
      block.fileData = null;
    }
    if (newType !== 'equation') {
      block.equation = '';
    }
    if (newType !== 'toggle') {
      block.collapsed = true;
      block.children = '';
    }
    if (newType !== 'todo') {
      block.checked = false;
    }
    if (!['bullet', 'numbered', 'todo'].includes(newType)) {
      block.indentLevel = 0;
    }

    // Record undo for type conversion
    this.pushUndo({
      type: 'convert',
      blockId,
      before: beforeSnapshot,
      after: this.snapshotBlock(block),
    });

    // Re-render this block
    const oldEl = this.container.querySelector(`[data-id="${blockId}"]`);
    if (oldEl) {
      const newEl = block.createElement();
      if (newType === 'numbered') {
        const index = this.blocks.indexOf(block);
        newEl.dataset.number = this.getNumberedListNumber(index);
      }
      oldEl.replaceWith(newEl);
      this.focusBlock(blockId);
    }

    this.updateNumberedLists();
    this.scheduleSave();
  }

  /**
   * Get block by ID
   */
  getBlockById(id) {
    return this.blocks.find((b) => b.id === id);
  }

  /**
   * Get block element
   */
  getBlockElement(id) {
    return this.container.querySelector(`[data-id="${id}"]`);
  }

  /**
   * Focus a block
   */
  focusBlock(blockId, atEnd = false) {
    const el = this.getBlockElement(blockId);
    if (!el) return;

    const content = el.querySelector('.block-content');
    if (content) {
      content.focus();
      if (atEnd) {
        this.placeCaretAtEnd(content);
      }
    }
  }

  /**
   * Place caret at end of element
   */
  placeCaretAtEnd(el) {
    const range = this.doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = this.doc.defaultView.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Place caret at start of element
   */
  placeCaretAtStart(el) {
    const range = this.doc.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = this.doc.defaultView.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Update add block hint visibility
   */
  updateAddBlockHint() {
    const hint = this.root.querySelector('.add-block-hint') || this.doc.getElementById('add-block-hint');
    hint.style.display = this.blocks.length === 0 ? 'block' : 'none';
  }

  // ============ Event Handlers ============

  /**
   * Handle title change
   */
  onTitleChange() {
    if (this.noteData) {
      const newTitle = this.titleEl.textContent.trim() || 'Untitled';
      const oldTitle = this.noteData.name;

      this.noteData.name = newTitle;

      // Mark title as manually set if user actually changed it
      // (not just the initial load or auto-title update)
      if (oldTitle !== newTitle && !this.isAutoTitleUpdate) {
        this.noteData.titleManuallySet = true;
      }

      this.scheduleSave();

      if (this.onChange) this.onChange();

      // Notify app to update tab name
      const app = this.getApp();
      if (app && app.updateCurrentTabName) {
        app.updateCurrentTabName(this.noteData.name);
      }
    }
  }

  /**
   * Update title programmatically (for auto-title feature)
   * This doesn't mark the title as manually set
   */
  setTitleProgrammatically(title) {
    if (this.noteData) {
      this.isAutoTitleUpdate = true;
      this.noteData.name = title;
      this.noteData.lastAutoTitleAt = Date.now();
      if (this.isTitleAutoGenerated && this.autoTitleNoteId === this.noteId) {
        this.isTitleAutoGenerated = false;
      }
      this.titleEl.textContent = title;
      this.isAutoTitleUpdate = false;

      this.scheduleSave();

      if (this.onChange) this.onChange();

      // Notify app to update tab name
      const app = this.getApp();
      if (app && app.updateCurrentTabName) {
        app.updateCurrentTabName(title);
      }
    }
  }

  /**
   * Handle title keydown
   */
  onTitleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Focus first block or create one
      if (this.blocks.length > 0) {
        this.focusBlock(this.blocks[0].id);
      } else {
        this.addBlockAtEnd();
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.blocks.length > 0) {
        this.focusBlock(this.blocks[0].id);
      }
    }
  }

  /**
   * Handle block input
   */
  async onBlockInput(e) {
    const blockEl = e.target.closest('.block');
    if (!blockEl) return;

    const block = this.getBlockById(blockEl.dataset.id);
    if (!block) return;

    // Capture before-snapshot for undo if not already pending
    if (!this._contentUndoPending[block.id]) {
      this._recordContentUndo(block.id, this.snapshotBlock(block));
    } else {
      // Extend the debounce timer without replacing the before snapshot
      this._recordContentUndo(block.id, this._contentUndoPending[block.id].before);
    }

    const content = blockEl.querySelector('.block-content');
    if (content && e.target === content) {
      block.content = content.innerHTML;
      block.markUpdated();
    }

    // Handle toggle children content
    if (block.type === 'toggle') {
      const childContent = blockEl.querySelector('.toggle-children-content, .toggle-children-placeholder');
      if (childContent && e.target === childContent) {
        block.children = childContent.innerHTML;
        block.markUpdated();
      }
    }

    // Handle table cell editing
    if (block.type === 'table' && e.target.matches('th, td')) {
      const row = parseInt(e.target.dataset.row);
      const col = parseInt(e.target.dataset.col);
      if (block.tableData && block.tableData[row]) {
        block.tableData[row][col] = e.target.textContent;
        block.markUpdated();
      }
    }

    // Handle bookmark URL input
    if (block.type === 'bookmark' && e.target.classList.contains('bookmark-input')) {
      block.url = e.target.value;
      block.markUpdated();
    }

    // Handle video URL input
    if (block.type === 'video' && e.target.classList.contains('video-input')) {
      block.videoUrl = e.target.value;
      block.markUpdated();
    }

    // Check for wikilinks
    this.checkWikiLinks(block, content);

    // Check for first content and trigger auto-title if applicable
    this.checkFirstContentAutoTitle();

    this.scheduleSave();

    if (this.onChange) this.onChange();
  }

  /**
   * Check if this is the first content and trigger auto-title generation
   * Conditions:
   * 1. Note hasn't received content before
   * 2. Auto-title is enabled in settings
   * 3. Current title is "Untitled"
   * 4. LLM is configured
   */
  async checkFirstContentAutoTitle() {
    // Skip if already received first content or auto-title is pending
    if (this.hasReceivedFirstContent || this.pendingAutoTitle) {
      return;
    }

    // Check if there's now meaningful content
    const currentContent = this.getAllBlocksTextContent();
    if (currentContent.trim().length < 10) {
      return; // Not enough content yet
    }

    // Mark that we've received first content
    this.hasReceivedFirstContent = true;

    // Check if title is "Untitled"
    const currentTitle = this.noteData?.name || '';
    const isUntitled = !currentTitle ||
      currentTitle.toLowerCase() === 'untitled' ||
      currentTitle.toLowerCase().startsWith('untitled ');

    if (!isUntitled) {
      return; // Title is already set
    }

    // Check if auto-title is enabled and LLM is configured
    const autoTitleEnabled = await Storage.getSetting('autoTitleEnabled', false);
    if (!autoTitleEnabled) {
      return;
    }

    const llm = this.getLLM();
    if (!llm || !llm.isConfigured()) {
      return;
    }

    // Check if title was manually set
    if (this.noteData?.titleManuallySet) {
      return;
    }

    // Prevent duplicate calls
    this.pendingAutoTitle = true;

    try {
      console.debug('First content detected, generating auto-title for note:', this.noteId);
      const newTitle = await llm.generateTitle(currentContent);

      if (newTitle && newTitle.trim()) {
        this.setTitleProgrammatically(newTitle);
        console.debug(`Auto-title generated on first content: "${newTitle}"`);
      }
    } catch (error) {
      console.error('Failed to generate auto-title on first content:', error);
    } finally {
      this.pendingAutoTitle = false;
    }
  }

  /**
   * Get all blocks' text content combined
   */
  getAllBlocksTextContent() {
    return this.blocks
      .map(block => this.extractBlockTextContent(block))
      .filter(text => text && text.trim())
      .join('\n\n');
  }

  /**
   * Check for wikilink shortcuts [[
   */
  async checkWikiLinks(block, contentEl) {
    const selection = this.doc.defaultView.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const textBefore = range.startContainer.textContent.substring(0, range.startOffset);

    // Check if user just typed [[
    const lastTwo = textBefore.slice(-2);
    if (lastTwo === '[[' && !this.wikiMenuVisible) {
      // Get all note names for autocomplete
      this.noteNames = await Storage.getNoteNames();
      this.showWikiMenu(contentEl.closest('.block'));
      return;
    }

    // Update filter if menu is visible
    if (this.wikiMenuVisible) {
      const match = textBefore.match(/\[\[([^\]]*)$/);
      if (match) {
        this.wikiFilter = match[1];
        this.renderWikiMenu();
      } else {
        this.hideWikiMenu();
      }
    }
  }

  /**
   * Show wikilink menu
   */
  showWikiMenu(blockEl) {
    if (!this.wikiMenu) return;
    this.wikiMenuVisible = true;
    this.wikiMenuIndex = 0;
    this.wikiFilter = '';
    this.wikiMenu.classList.remove('hidden');

    // Position menu
    const selection = this.doc.defaultView.getSelection();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    this.wikiMenu.style.left = `${rect.left}px`;
    this.wikiMenu.style.top = `${rect.bottom + this.doc.defaultView.scrollY}px`;

    this.renderWikiMenu();
  }

  /**
   * Hide wikilink menu
   */
  hideWikiMenu() {
    this.wikiMenuVisible = false;
    if (this.wikiMenu) this.wikiMenu.classList.add('hidden');
  }

  /**
   * Render wikilink menu items
   */
  renderWikiMenu() {
    if (!this.wikiMenuItems) return;
    this.wikiMenuItems.innerHTML = '';

    const filtered = this.noteNames
      .filter(name => name.toLowerCase().includes(this.wikiFilter.toLowerCase()))
      .slice(0, 10);

    if (filtered.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'slash-menu-item empty';
      empty.textContent = 'No matching notes';
      this.wikiMenuItems.appendChild(empty);
      return;
    }

    filtered.forEach((name, index) => {
      const item = this.doc.createElement('div');
      item.className = `slash-menu-item ${index === this.wikiMenuIndex ? 'active' : ''}`;
      item.innerHTML = `
        <div class="slash-menu-item-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="slash-menu-item-text">
          <div class="slash-menu-item-title">${name}</div>
        </div>
      `;
      item.addEventListener('click', () => this.selectWikiMenuItem(name));
      this.wikiMenuItems.appendChild(item);
    });
  }

  /**
   * Select an item from the wiki menu
   */
  selectWikiMenuItem(noteName) {
    const selection = this.doc.defaultView.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    const text = container.textContent;

    // Find the [[ that triggered the menu
    const beforePos = text.lastIndexOf('[[', range.startOffset - 1);
    if (beforePos !== -1) {
      const beforeText = text.substring(0, beforePos);
      const afterText = text.substring(range.startOffset);

      // Create wiki link HTML
      const escapedNoteName = Utils.escapeHtml(noteName);
      const linkHtml = `<a href="#" class="wiki-link" data-note-name="${escapedNoteName}">[[${escapedNoteName}]]</a>&nbsp;`;

      // Replace text node with HTML
      // Since it's contenteditable, we can use document.execCommand or manual DOM manipulation
      // Manual manipulation is often more reliable
      const parent = container.parentElement;
      const index = Array.from(parent.childNodes).indexOf(container);

      const beforeNode = this.doc.createTextNode(beforeText);
      const afterNode = this.doc.createTextNode(afterText);

      const tempDiv = this.doc.createElement('div');
      tempDiv.innerHTML = linkHtml;
      const linkNode = tempDiv.firstChild;
      const spaceNode = tempDiv.lastChild;

      parent.replaceChild(afterNode, container);
      parent.insertBefore(beforeNode, afterNode);
      parent.insertBefore(linkNode, afterNode);
      parent.insertBefore(spaceNode, afterNode);

      // Place caret after the space
      const newRange = this.doc.createRange();
      newRange.setStart(spaceNode, 1);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);

      // Update block content
      const blockEl = parent.closest('.block');
      if (blockEl) {
        const block = this.getBlockById(blockEl.dataset.id);
        if (block) {
          block.content = parent.innerHTML;
          this.scheduleSave();
        }
      }
    }

    this.hideWikiMenu();
  }

  /**
   * Check for markdown shortcuts
   */
  async checkMarkdownShortcuts(block, contentEl) {
    if (block.type !== 'text') return;

    const text = contentEl.textContent;

    // Check shortcuts
    const shortcuts = {
      '# ': 'h1',
      '## ': 'h2',
      '### ': 'h3',
      '- ': 'bullet',
      '* ': 'bullet',
      '1. ': 'numbered',
      '[] ': 'todo',
      '[ ] ': 'todo',
      '> ': 'quote',
      '``` ': 'code',
      '---': 'divider',
    };

    for (const [shortcut, type] of Object.entries(shortcuts)) {
      if (text.startsWith(shortcut)) {
        // Remove the shortcut text
        const newContent = text.slice(shortcut.length);
        block.content = newContent;
        this.changeBlockType(block.id, type);
        return;
      }
    }

    // Check for /template
    if (text === '/template') {
      this.templates = await Storage.getTemplates();
      this.showTemplateMenu(contentEl.closest('.block'));
      return;
    }
  }

  /**
   * Show template menu
   */
  showTemplateMenu(blockEl) {
    if (!this.templateMenu) return;
    this.templateMenuVisible = true;
    this.templateMenuIndex = 0;
    this.templateFilter = '';
    this.templateMenu.classList.remove('hidden');

    const rect = blockEl.getBoundingClientRect();
    this.templateMenu.style.left = `${rect.left}px`;
    this.templateMenu.style.top = `${rect.bottom + this.doc.defaultView.scrollY}px`;

    this.renderTemplateMenu();
  }

  /**
   * Hide template menu
   */
  hideTemplateMenu() {
    this.templateMenuVisible = false;
    if (this.templateMenu) this.templateMenu.classList.add('hidden');
  }

  /**
   * Render template menu items
   */
  renderTemplateMenu() {
    if (!this.templateMenuItems) return;
    this.templateMenuItems.innerHTML = '';

    const filtered = this.templates
      .filter(t => t.name.toLowerCase().includes(this.templateFilter.toLowerCase()))
      .slice(0, 10);

    if (filtered.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'slash-menu-item empty';
      empty.textContent = 'No templates found';
      this.templateMenuItems.appendChild(empty);
      return;
    }

    filtered.forEach((template, index) => {
      const item = this.doc.createElement('div');
      item.className = `slash-menu-item ${index === this.templateMenuIndex ? 'active' : ''}`;
      item.innerHTML = `
        <div class="slash-menu-item-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="slash-menu-item-text">
          <div class="slash-menu-item-title">${template.name}</div>
        </div>
      `;
      item.addEventListener('click', () => this.selectTemplateItem(template.id));
      this.templateMenuItems.appendChild(item);
    });
  }

  /**
   * Select a template to insert
   */
  async selectTemplateItem(templateId) {
    const templateBlocks = await Storage.getElementsByNote(templateId);
    if (!templateBlocks || templateBlocks.length === 0) {
      this.hideTemplateMenu();
      return;
    }

    // Get current selection point
    const selection = this.doc.defaultView.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const currentBlockEl = range.startContainer.parentElement.closest('.block');
    if (!currentBlockEl) return;

    const currentBlockId = currentBlockEl.dataset.id;
    const currentBlockIndex = this.blocks.findIndex(b => b.id === currentBlockId);

    // Remove the "/template" text if present
    const contentEl = currentBlockEl.querySelector('.block-content');
    if (contentEl && contentEl.textContent.startsWith('/template')) {
      contentEl.textContent = contentEl.textContent.replace('/template', '').trim();
    }

    // Insert blocks from template
    const newBlocks = [];
    for (const blockData of templateBlocks) {
      // Clone block data and generate new ID
      const newData = { ...blockData, id: Utils.generateId(), canvasId: this.noteId };

      // Variable replacement
      if (newData.content) {
        newData.content = this.processTemplateVariables(newData.content);
      }
      if (newData.tableData) {
        newData.tableData = newData.tableData.map(row =>
          row.map(cell => this.processTemplateVariables(cell))
        );
      }

      const newBlock = Block.deserialize(newData);
      newBlocks.push(newBlock);
    }

    // Add blocks to the list at the correct position
    this.blocks.splice(currentBlockIndex + 1, 0, ...newBlocks);

    // Save all new blocks
    for (let i = 0; i < this.blocks.length; i++) {
      this.blocks[i].order = i;
      await Storage.saveElement(this.blocks[i].serialize());
    }

    this.renderBlocks();
    this.hideTemplateMenu();
    this.scheduleSave();

    // Focus first inserted block
    if (newBlocks.length > 0) {
      this.focusBlock(newBlocks[0].id);
    }
  }

  /**
   * Process variables in template content
   */
  processTemplateVariables(text) {
    if (typeof text !== 'string') return text;

    const now = new Date();
    const variables = {
      '{{date}}': now.toLocaleDateString(),
      '{{time}}': now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      '{{title}}': this.noteData?.name || 'Untitled',
      '{{datetime}}': now.toLocaleString(),
    };

    let result = text;
    for (const [key, value] of Object.entries(variables)) {
      result = result.split(key).join(value);
    }
    return result;
  }

  /**
   * Handle block keydown
   */
  onBlockKeyDown(e) {
    const blockEl = e.target.closest('.block');
    if (!blockEl) return;

    const block = this.getBlockById(blockEl.dataset.id);
    if (!block) return;

    const content = blockEl.querySelector('.block-content');

    // Handle table cell Tab/Shift+Tab navigation (Req 33.1, 33.2)
    if (block.type === 'table' && e.target.matches('th, td') && e.key === 'Tab') {
      e.preventDefault();
      this.handleTableTabNavigation(block, e.target, e.shiftKey);
      return;
    }

    // Handle bookmark URL input Enter
    if (block.type === 'bookmark' && e.target.classList.contains('bookmark-input')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const url = e.target.value.trim();
        if (url) {
          this.processBookmarkUrl(block, url);
        }
      }
      return;
    }

    // Handle video URL input Enter
    if (block.type === 'video' && e.target.classList.contains('video-input')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const url = e.target.value.trim();
        if (url) {
          block.videoUrl = url;
          this.rerenderBlock(block);
          this.scheduleSave();
        }
      }
      return;
    }

    // Slash command
    if (e.key === '/' && content && content.textContent === '') {
      e.preventDefault();
      this.showSlashMenu(blockEl);
      return;
    }

    // Handle slash menu navigation
    if (this.slashMenuVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.navigateSlashMenu(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.navigateSlashMenu(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        this.selectSlashMenuItem();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideSlashMenu();
        return;
      }
    }

    // Handle wiki menu navigation
    if (this.wikiMenuVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = this.noteNames.filter(name => name.toLowerCase().includes(this.wikiFilter.toLowerCase())).slice(0, 10);
        this.wikiMenuIndex = (this.wikiMenuIndex + 1) % items.length;
        this.renderWikiMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = this.noteNames.filter(name => name.toLowerCase().includes(this.wikiFilter.toLowerCase())).slice(0, 10);
        this.wikiMenuIndex = (this.wikiMenuIndex - 1 + items.length) % items.length;
        this.renderWikiMenu();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const items = this.noteNames.filter(name => name.toLowerCase().includes(this.wikiFilter.toLowerCase())).slice(0, 10);
        if (items[this.wikiMenuIndex]) {
          this.selectWikiMenuItem(items[this.wikiMenuIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideWikiMenu();
        return;
      }
    }

    // Handle template menu navigation
    if (this.templateMenuVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = this.templates.filter(t => t.name.toLowerCase().includes(this.templateFilter.toLowerCase())).slice(0, 10);
        this.templateMenuIndex = (this.templateMenuIndex + 1) % items.length;
        this.renderTemplateMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = this.templates.filter(t => t.name.toLowerCase().includes(this.templateFilter.toLowerCase())).slice(0, 10);
        this.templateMenuIndex = (this.templateMenuIndex - 1 + items.length) % items.length;
        this.renderTemplateMenu();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const items = this.templates.filter(t => t.name.toLowerCase().includes(this.templateFilter.toLowerCase())).slice(0, 10);
        if (items[this.templateMenuIndex]) {
          this.selectTemplateItem(items[this.templateMenuIndex].id);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideTemplateMenu();
        return;
      }
    }

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const shortcutAction = typeof ShortcutUtils !== 'undefined'
      ? ShortcutUtils.getEditorShortcutAction({
        code: e.code,
        key: e.key,
        modKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        blockType: block.type,
      })
      : null;

    if (shortcutAction) {
      e.preventDefault();

      if (shortcutAction.type === 'insert-below') {
        const nextType = ['bullet', 'numbered', 'todo'].includes(block.type) ? block.type : 'text';
        this.insertBlockAfter(block.id, nextType, '', {
          indentLevel: block.indentLevel || 0,
        });
        return;
      }

      if (shortcutAction.type === 'move-block') {
        this.moveBlockByDirection(block.id, shortcutAction.direction);
        return;
      }

      if (shortcutAction.type === 'convert-block') {
        this.changeBlockType(block.id, shortcutAction.blockType);
        return;
      }

      if (shortcutAction.type === 'indent-block') {
        this.adjustBlockIndent(block.id, shortcutAction.delta);
        return;
      }
    }

    // Enter - create new block
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();

      // Get content after cursor
      const sel = this.doc.defaultView.getSelection();
      const range = sel.getRangeAt(0);
      const afterRange = range.cloneRange();
      afterRange.selectNodeContents(content);
      afterRange.setStart(range.endContainer, range.endOffset);
      const afterContent = afterRange.cloneContents();
      const afterText = this.getTextFromFragment(afterContent);

      // Remove content after cursor
      afterRange.deleteContents();
      block.content = content.innerHTML;

      // Determine new block type
      let newType = 'text';
      if (block.type === 'bullet' || block.type === 'numbered' || block.type === 'todo') {
        // Continue list if current block has content
        if (content.textContent.trim()) {
          newType = block.type;
        }
      }

      // Create new block
      this.insertBlockAfter(block.id, newType, afterText, {
        indentLevel: ['bullet', 'numbered', 'todo'].includes(newType) ? (block.indentLevel || 0) : 0,
      });
      this.scheduleSave();
      return;
    }

    // Backspace at start - merge with previous or change type
    if (e.key === 'Backspace') {
      const sel = this.doc.defaultView.getSelection();
      if (sel.isCollapsed && this.isCaretAtStart(content)) {
        e.preventDefault();

        // If block has special type, convert to text first
        if (block.type !== 'text') {
          this.changeBlockType(block.id, 'text');
          return;
        }

        // Merge with previous block
        const index = this.blocks.indexOf(block);
        if (index > 0) {
          const prevBlock = this.blocks[index - 1];
          const prevEl = this.getBlockElement(prevBlock.id);
          const prevContent = prevEl?.querySelector('.block-content');

          if (prevContent && prevBlock.type !== 'divider' && prevBlock.type !== 'image') {
            const prevLength = prevContent.textContent.length;
            prevBlock.content = prevContent.innerHTML + block.content;
            this.deleteBlock(block.id);

            // Place cursor at merge point
            setTimeout(() => {
              const newPrevContent = this.getBlockElement(prevBlock.id)?.querySelector('.block-content');
              if (newPrevContent) {
                this.placeCaretAtPosition(newPrevContent, prevLength);
              }
            }, 0);
          }
        }
        return;
      }
    }

    // Delete at end - merge with next
    if (e.key === 'Delete') {
      const sel = this.doc.defaultView.getSelection();
      if (sel.isCollapsed && this.isCaretAtEnd(content)) {
        e.preventDefault();

        const index = this.blocks.indexOf(block);
        if (index < this.blocks.length - 1) {
          const nextBlock = this.blocks[index + 1];
          const nextEl = this.getBlockElement(nextBlock.id);
          const nextContent = nextEl?.querySelector('.block-content');

          if (nextContent && nextBlock.type !== 'divider' && nextBlock.type !== 'image') {
            block.content = content.innerHTML + nextBlock.content;
            content.innerHTML = block.content;
            this.deleteBlock(nextBlock.id);
            this.placeCaretAtEnd(content);
          }
        }
        return;
      }
    }

    // Arrow up - move to previous block
    if (e.key === 'ArrowUp') {
      if (this.isCaretAtStart(content)) {
        e.preventDefault();
        const index = this.blocks.indexOf(block);
        if (index > 0) {
          this.focusBlock(this.blocks[index - 1].id, true);
        } else {
          this.titleEl.focus();
        }
      }
    }

    // Arrow down - move to next block
    if (e.key === 'ArrowDown') {
      if (this.isCaretAtEnd(content)) {
        e.preventDefault();
        const index = this.blocks.indexOf(block);
        if (index < this.blocks.length - 1) {
          this.focusBlock(this.blocks[index + 1].id);
        }
      }
    }
  }

  /**
   * Handle block focus
   */
  onBlockFocus(e) {
    const blockEl = e.target.closest('.block');
    if (blockEl) {
      this.activeBlock = blockEl.dataset.id;
    }
  }

  /**
   * Handle block blur
   */
  onBlockBlur(e) {
    // Delay to allow click events to fire
    setTimeout(() => {
      if (!this.container.contains(this.doc.activeElement)) {
        this.activeBlock = null;
      }
    }, 100);
  }

  /**
   * Handle block click
   */
  onBlockClick(e) {
    // Block handle click — show block action menu with "Turn into..."
    if (e.target.closest('.block-handle')) {
      const blockEl = e.target.closest('.block');
      if (blockEl) {
        e.preventDefault();
        e.stopPropagation();
        const handle = e.target.closest('.block-handle');
        this.showBlockActionMenu(blockEl.dataset.id, handle);
      }
      return;
    }

    // Todo checkbox
    if (e.target.closest('.todo-checkbox')) {
      const blockEl = e.target.closest('.block');
      const block = this.getBlockById(blockEl.dataset.id);
      if (block) {
        block.checked = !block.checked;
        blockEl.classList.toggle('checked', block.checked);
        this.scheduleSave();
      }
      return;
    }

    // Toggle arrow
    if (e.target.closest('.toggle-arrow')) {
      const blockEl = e.target.closest('.block');
      const block = this.getBlockById(blockEl.dataset.id);
      if (block) {
        block.collapsed = !block.collapsed;
        blockEl.classList.toggle('expanded', !block.collapsed);
        this.scheduleSave();
      }
      return;
    }

    // Table controls
    if (e.target.closest('.table-controls button')) {
      const btn = e.target.closest('button');
      const blockEl = e.target.closest('.block');
      const block = this.getBlockById(blockEl.dataset.id);
      if (block && block.type === 'table') {
        if (btn.classList.contains('add-row-btn')) {
          this.addTableRow(block, blockEl);
        } else if (btn.classList.contains('add-col-btn')) {
          this.addTableColumn(block, blockEl);
        } else if (btn.classList.contains('remove-row-btn')) {
          this.removeTableRow(block, blockEl);
        } else if (btn.classList.contains('remove-col-btn')) {
          this.removeTableColumn(block, blockEl);
        }
      }
      return;
    }

    // Image placeholder
    if (e.target.closest('.image-placeholder')) {
      // Handled by block creation
      return;
    }

    // File placeholder
    if (e.target.closest('.file-placeholder')) {
      // Handled by block creation
      return;
    }

    // Wiki Link click
    if (e.target.closest('.wiki-link')) {
      e.preventDefault();
      const noteName = e.target.closest('.wiki-link').dataset.noteName;
      const app = this.getApp();
      if (noteName && app) {
        app.openNoteByName(noteName);
      }
      return;
    }

    // Multi-block selection (Req 13.1–13.5)
    const blockEl = e.target.closest('.block');
    if (!blockEl) return;
    const clickedId = blockEl.dataset.id;
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    if (e.shiftKey && this.lastSelectedBlockId) {
      // Shift+Click: range selection (Req 13.1)
      e.preventDefault();
      const lastIdx = this.blocks.findIndex(b => b.id === this.lastSelectedBlockId);
      const clickIdx = this.blocks.findIndex(b => b.id === clickedId);
      if (lastIdx !== -1 && clickIdx !== -1) {
        const start = Math.min(lastIdx, clickIdx);
        const end = Math.max(lastIdx, clickIdx);
        this.selectedBlockIds.clear();
        for (let i = start; i <= end; i++) {
          this.selectedBlockIds.add(this.blocks[i].id);
        }
        this.updateBlockSelectionUI();
      }
    } else if (isMac ? e.metaKey : e.ctrlKey) {
      // Ctrl/Cmd+Click: toggle selection (Req 13.2)
      e.preventDefault();
      if (this.selectedBlockIds.has(clickedId)) {
        this.selectedBlockIds.delete(clickedId);
      } else {
        this.selectedBlockIds.add(clickedId);
      }
      this.lastSelectedBlockId = clickedId;
      this.updateBlockSelectionUI();
    } else {
      // Plain click: clear selection (Req 13.5)
      if (this.selectedBlockIds.size > 0) {
        this.clearBlockSelection();
      }
      this.lastSelectedBlockId = clickedId;
    }
  }

  /**
   * Add row to table
   */
  addTableRow(block, blockEl) {
    if (!block.tableData) return;
    const newRow = new Array(block.cols).fill('');
    block.tableData.push(newRow);
    block.rows++;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Add column to table
   */
  addTableColumn(block, blockEl) {
    if (!block.tableData) return;
    block.tableData.forEach((row, index) => {
      row.push(index === 0 ? `Header ${block.cols + 1}` : '');
    });
    block.cols++;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Remove row from table
   */
  removeTableRow(block, blockEl) {
    if (!block.tableData || block.rows <= 1) return;
    block.tableData.pop();
    block.rows--;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Remove column from table
   */
  removeTableColumn(block, blockEl) {
    if (!block.tableData || block.cols <= 1) return;
    block.tableData.forEach((row) => {
      row.pop();
    });
    block.cols--;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Re-render a single block in-place, preserving focus and cursor position (Req 50.1, 50.3).
   * @param {Object} block - Block instance to re-render
   */
  rerenderBlock(block) {
    const oldEl = this.getBlockElement(block.id);
    if (!oldEl) return;

    // Save cursor state if this block is focused
    const sel = this.doc.defaultView.getSelection();
    const oldContent = oldEl.querySelector('.block-content');
    const hadFocus = oldContent && this.doc.activeElement === oldContent;
    let cursorOffset = 0;
    if (hadFocus && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const preRange = this.doc.createRange();
      preRange.selectNodeContents(oldContent);
      preRange.setEnd(range.startContainer, range.startOffset);
      cursorOffset = preRange.toString().length;
    }

    const newEl = block.createElement();
    if (block.type === 'numbered') {
      const index = this.blocks.indexOf(block);
      newEl.dataset.number = this.getNumberedListNumber(index);
    }
    oldEl.replaceWith(newEl);

    // Restore focus and cursor position
    if (hadFocus) {
      const newContent = newEl.querySelector('.block-content');
      if (newContent) {
        newContent.focus();
        this.placeCaretAtPosition(newContent, cursorOffset);
      }
    }

    // Observe lazy images in the new element
    this.observeImages(newEl);

    // Update wide content centering if this is a wide block type
    if (['table', 'image', 'video'].includes(block.type)) {
      requestAnimationFrame(() => this.updateWideContentCentering());
    }
  }

  /**
   * Insert a single block's DOM element after the specified block, without full re-render (Req 50.2).
   * @param {Object} block - Block instance to insert
   * @param {string|null} afterId - ID of the block to insert after, or null to prepend
   */
  insertBlockDOM(block, afterId) {
    const newEl = block.createElement();
    if (block.type === 'numbered') {
      const index = this.blocks.indexOf(block);
      newEl.dataset.number = this.getNumberedListNumber(index);
    }

    if (afterId) {
      const afterEl = this.getBlockElement(afterId);
      if (afterEl) {
        afterEl.after(newEl);
      } else {
        this.container.appendChild(newEl);
      }
    } else {
      this.container.prepend(newEl);
    }

    this.observeImages(newEl);
    this.updateNumberedLists();
    this.updateAddBlockHint();
  }

  /**
   * Remove a single block's DOM element without full re-render (Req 50.2).
   * @param {string} blockId - ID of the block to remove
   */
  removeBlockDOM(blockId) {
    const el = this.getBlockElement(blockId);
    if (el) {
      el.remove();
    }
    this.updateNumberedLists();
    this.updateAddBlockHint();
  }

  // ============ Undo / Redo ============

  /**
   * @typedef {Object} UndoEntry
   * @property {'add'|'delete'|'move'|'convert'|'content'} type
   * @property {string} blockId
   * @property {Object} before - Snapshot before the operation
   * @property {Object} after - Snapshot after the operation
   * @property {number} [fromIndex] - For move operations
   * @property {number} [toIndex] - For move operations
   */

  /**
   * Push an undo entry onto the stack. Clears redo stack (Req 11.4).
   * Caps stack at 100 entries (Req 11.5).
   * @param {UndoEntry} entry
   */
  pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.undoMaxSize) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  /**
   * Snapshot a block for undo before/after state.
   * @param {Object|null} block
   * @returns {Object|null}
   */
  snapshotBlock(block) {
    if (!block) return null;
    return block.serialize();
  }

  /**
   * Undo the most recent operation (Req 11.2).
   */
  undo() {
    if (this.undoStack.length === 0) return;
    const entry = this.undoStack.pop();
    this._applyUndoEntry(entry, /* reverse */ true);
    this.redoStack.push(entry);
  }

  /**
   * Redo the most recently undone operation (Req 11.3).
   */
  redo() {
    if (this.redoStack.length === 0) return;
    const entry = this.redoStack.pop();
    this._applyUndoEntry(entry, /* reverse */ false);
    this.undoStack.push(entry);
  }

  /**
   * Apply an undo entry. When reverse=true we restore `before`, otherwise `after`.
   * @param {UndoEntry} entry
   * @param {boolean} reverse
   */
  _applyUndoEntry(entry, reverse) {
    const snapshot = reverse ? entry.before : entry.after;

    switch (entry.type) {
      case 'add': {
        if (reverse) {
          // Undo add → remove the block
          const idx = this.blocks.findIndex(b => b.id === entry.blockId);
          if (idx !== -1) {
            this.blocks.splice(idx, 1);
            Storage.deleteElement(entry.blockId);
          }
        } else {
          // Redo add → re-insert the block
          if (snapshot) {
            const block = Block.deserialize(snapshot);
            const insertIdx = snapshot.order != null ? Math.min(snapshot.order, this.blocks.length) : this.blocks.length;
            this.blocks.splice(insertIdx, 0, block);
          }
        }
        break;
      }
      case 'delete': {
        if (reverse) {
          // Undo delete → re-insert the block
          if (entry.before) {
            const block = Block.deserialize(entry.before);
            const insertIdx = entry.before.order != null ? Math.min(entry.before.order, this.blocks.length) : this.blocks.length;
            this.blocks.splice(insertIdx, 0, block);
          }
        } else {
          // Redo delete → remove the block again
          const idx = this.blocks.findIndex(b => b.id === entry.blockId);
          if (idx !== -1) {
            this.blocks.splice(idx, 1);
            Storage.deleteElement(entry.blockId);
          }
        }
        break;
      }
      case 'move': {
        const fromIdx = reverse ? entry.toIndex : entry.fromIndex;
        const toIdx = reverse ? entry.fromIndex : entry.toIndex;
        if (fromIdx != null && toIdx != null && fromIdx < this.blocks.length) {
          const [item] = this.blocks.splice(fromIdx, 1);
          this.blocks.splice(toIdx, 0, item);
        }
        break;
      }
      case 'convert':
      case 'content': {
        const block = this.getBlockById(entry.blockId);
        if (block && snapshot) {
          // Restore block properties from snapshot
          Object.assign(block, snapshot);
          block.id = entry.blockId; // Ensure ID stays consistent
        }
        break;
      }
    }

    this.renderBlocks();
    this.scheduleSave();
  }

  /**
   * Record a content-change undo entry with debouncing.
   * Groups rapid keystrokes into a single undo entry per block.
   * @param {string} blockId
   * @param {Object} beforeSnapshot - Snapshot taken before the first keystroke in this group
   */
  _recordContentUndo(blockId, beforeSnapshot) {
    const pending = this._contentUndoPending[blockId];
    if (pending && pending.timer) {
      clearTimeout(pending.timer);
    }

    if (!pending) {
      // First keystroke for this block — store the before snapshot
      this._contentUndoPending[blockId] = { timer: null, before: beforeSnapshot };
    }

    this._contentUndoPending[blockId].timer = setTimeout(() => {
      const block = this.getBlockById(blockId);
      if (block) {
        this.pushUndo({
          type: 'content',
          blockId,
          before: this._contentUndoPending[blockId].before,
          after: this.snapshotBlock(block),
        });
      }
      delete this._contentUndoPending[blockId];
    }, 600);
  }

  /**
   * Handle global keydown
   */
  onGlobalKeyDown(e) {
    // Delete selected blocks: Backspace/Delete with multi-block selection (Req 13.4)
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.selectedBlockIds.size > 0) {
      e.preventDefault();
      this.deleteSelectedBlocks();
      return;
    }

    // Undo: Ctrl+Z / Cmd+Z (Req 11.2)
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    if (modKey && !e.altKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }
    // Redo: Ctrl+Shift+Z / Cmd+Shift+Z (Req 11.3)
    if (modKey && !e.altKey && e.key === 'Z' && e.shiftKey) {
      e.preventDefault();
      this.redo();
      return;
    }

    // Start typing anywhere to create/focus block
    if (
      !e.target.closest('#editor') &&
      !e.target.closest('.modal') &&
      !e.target.closest('.sidebar') &&
      !e.target.closest('.ai-sidebar') &&
      !e.target.closest('#ai-chat-input') &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key.length === 1
    ) {
      // Focus last block or create new one
      if (this.blocks.length > 0) {
        const lastBlock = this.blocks[this.blocks.length - 1];
        this.focusBlock(lastBlock.id, true);
      } else {
        this.addBlockAtEnd();
      }
    }
  }

  // ============ Slash Menu ============

  /**
   * Build slash menu items
   */
  buildSlashMenu() {
    if (!this.slashMenuItems) return;
    this.slashMenuItems.innerHTML = '';

    const types = [
      'text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle',
      'quote', 'code', 'divider', 'callout', 'image', 'table', 'bookmark',
      'video', 'file', 'equation'
    ];

    types.forEach((type, index) => {
      const info = BlockTypes[type];
      const item = this.doc.createElement('div');
      item.className = 'slash-menu-item';
      item.dataset.type = type;
      item.dataset.index = index;

      item.innerHTML = `
        <div class="slash-menu-item-icon">${info.icon}</div>
        <div class="slash-menu-item-text">
          <div class="slash-menu-item-title">${info.name}</div>
          <div class="slash-menu-item-desc">${info.description}</div>
        </div>
      `;

      this.slashMenuItems.appendChild(item);
    });
  }

  /**
   * Show slash menu
   */
  showSlashMenu(blockEl) {
    const rect = blockEl.getBoundingClientRect();
    this.slashMenu.style.left = rect.left + 'px';
    this.slashMenu.style.top = rect.bottom + 4 + 'px';
    this.slashMenu.classList.remove('hidden');
    this.slashMenuVisible = true;
    this.slashMenuIndex = 0;
    this.updateSlashMenuSelection();
  }

  /**
   * Hide slash menu
   */
  hideSlashMenu() {
    this.slashMenu.classList.add('hidden');
    this.slashMenuVisible = false;
  }

  /**
   * Navigate slash menu
   */
  navigateSlashMenu(direction) {
    const items = this.slashMenuItems.querySelectorAll('.slash-menu-item');
    this.slashMenuIndex = Math.max(0, Math.min(items.length - 1, this.slashMenuIndex + direction));
    this.updateSlashMenuSelection();
  }

  /**
   * Update slash menu selection
   */
  updateSlashMenuSelection() {
    if (!this.slashMenuItems) return;
    const items = this.slashMenuItems.querySelectorAll('.slash-menu-item');
    items.forEach((item, index) => {
      item.classList.toggle('selected', index === this.slashMenuIndex);
    });

    // Scroll into view
    const selected = items[this.slashMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Select slash menu item
   */
  selectSlashMenuItem() {
    const items = this.slashMenuItems.querySelectorAll('.slash-menu-item');
    const selected = items[this.slashMenuIndex];
    if (selected) {
      const type = selected.dataset.type;
      this.changeBlockType(this.activeBlock, type);
    }
    this.hideSlashMenu();
  }

  /**
   * Handle slash menu click
   */
  onSlashMenuClick(e) {
    const item = e.target.closest('.slash-menu-item');
    if (item) {
      const type = item.dataset.type;
      this.changeBlockType(this.activeBlock, type);
      this.hideSlashMenu();
    }
  }

  // ============ Drag and Drop ============

  /**
   * Handle drag start
   */
  onDragStart(e) {
    const blockEl = e.target.closest('.block');
    if (!blockEl) return;

    this.isDragging = true;
    this.draggedBlock = blockEl.dataset.id;
    blockEl.classList.add('dragging');

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', blockEl.dataset.id);

    // Set block content data for drag-to-sidebar (Req 46.1)
    const block = this.getBlockById(blockEl.dataset.id);
    if (block) {
      const textContent = this.extractBlockTextContent(block);
      e.dataTransfer.setData('application/x-block-content', textContent || '');
      e.dataTransfer.setData('application/x-block-type', block.type || 'text');
      e.dataTransfer.setData('application/x-block-html', block.content || '');
    }
  }

  /**
   * Handle drag end
   */
  onDragEnd(e) {
    this.isDragging = false;
    this.draggedBlock = null;

    this.container.querySelectorAll('.block').forEach((el) => {
      el.classList.remove('dragging', 'drag-over');
    });

    // Clean up sidebar drop overlay (Req 46.1)
    const overlay = document.getElementById('sidebar-drop-overlay');
    if (overlay) overlay.remove();
    const notesList = document.getElementById('sidebar-notes-list');
    if (notesList) {
      notesList.querySelectorAll('.sidebar-note-item.sidebar-drop-target').forEach(el => {
        el.classList.remove('sidebar-drop-target');
      });
    }
  }

  /**
   * Handle drag over
   */
  onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const blockEl = e.target.closest('.block');
    if (blockEl && blockEl.dataset.id !== this.draggedBlock) {
      // Remove drag-over from all
      this.container.querySelectorAll('.block').forEach((el) => {
        el.classList.remove('drag-over');
      });
      blockEl.classList.add('drag-over');
    }
  }

  /**
   * Handle drop
   */
  onDrop(e) {
    e.preventDefault();
    this.container.classList.remove('drag-over');

    // Handle file drop
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      this.handleFiles(e.dataTransfer.files);
      return;
    }

    const targetEl = e.target.closest('.block');
    if (!targetEl || targetEl.dataset.id === this.draggedBlock) return;

    const draggedId = this.draggedBlock;
    const targetId = targetEl.dataset.id;

    // Reorder blocks
    const draggedIndex = this.blocks.findIndex((b) => b.id === draggedId);
    const targetIndex = this.blocks.findIndex((b) => b.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    const [draggedBlock] = this.blocks.splice(draggedIndex, 1);
    this.blocks.splice(targetIndex, 0, draggedBlock);

    this.renderBlocks();
    this.scheduleSave();
  }

  /**
   * Handle touch start on block handle for long-press drag (Req 10.2)
   * @param {TouchEvent} e
   */
  onHandleTouchStart(e) {
    const handle = e.target.closest('.block-handle');
    if (!handle) return;

    this._longPressTimer = setTimeout(() => {
      const blockEl = handle.closest('.block');
      if (!blockEl) return;

      this.isDragging = true;
      this.draggedBlock = blockEl.dataset.id;
      blockEl.classList.add('dragging');
    }, 500);
  }

  /**
   * Handle touch end — clear long-press timer and finalize drag (Req 10.2)
   * @param {TouchEvent} e
   */
  onHandleTouchEnd(e) {
    clearTimeout(this._longPressTimer);
    this._longPressTimer = null;

    if (!this.isDragging) return;

    const touch = e.changedTouches[0];
    const targetEl = this.doc.elementFromPoint(touch.clientX, touch.clientY);
    const targetBlock = targetEl ? targetEl.closest('.block') : null;

    if (targetBlock && targetBlock.dataset.id !== this.draggedBlock) {
      const draggedIndex = this.blocks.findIndex((b) => b.id === this.draggedBlock);
      const targetIndex = this.blocks.findIndex((b) => b.id === targetBlock.dataset.id);

      if (draggedIndex !== -1 && targetIndex !== -1) {
        const [moved] = this.blocks.splice(draggedIndex, 1);
        this.blocks.splice(targetIndex, 0, moved);
        this.scheduleSave();
      }
    }

    this.isDragging = false;
    this.draggedBlock = null;
    this.container.querySelectorAll('.block').forEach((el) => {
      el.classList.remove('dragging', 'drag-over');
    });
    this.renderBlocks();
  }

  /**
   * Handle touch move — update drag-over indicator during long-press drag (Req 10.2)
   * @param {TouchEvent} e
   */
  onHandleTouchMove(e) {
    if (!this.isDragging) return;
    e.preventDefault();

    const touch = e.touches[0];
    const targetEl = this.doc.elementFromPoint(touch.clientX, touch.clientY);
    const targetBlock = targetEl ? targetEl.closest('.block') : null;

    this.container.querySelectorAll('.block').forEach((el) => {
      el.classList.remove('drag-over');
    });

    if (targetBlock && targetBlock.dataset.id !== this.draggedBlock) {
      targetBlock.classList.add('drag-over');
    }
  }

  /**
   * Handle global paste event with smart content detection (Req 34.1–34.6)
   * @param {ClipboardEvent} e
   */
  onPaste(e) {
    // Only handle if not in an input/textarea (unless it's our blocks)
    const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    const isBlock = e.target.closest('.block-content');

    if (isInput && !isBlock) return;

    const items = e.clipboardData.items;
    const files = [];

    // Check for image data in clipboard (Req 34.2)
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      this.handleFiles(files);
      return;
    }

    // Get plain text from clipboard for smart detection
    const text = e.clipboardData.getData('text/plain');
    if (!text || !text.trim()) return;

    const trimmed = text.trim();

    // Determine the current block context
    const blockEl = e.target.closest('.block');
    const currentBlock = blockEl ? this.getBlockById(blockEl.dataset.id) : null;
    const currentBlockContent = currentBlock ? this.extractBlockTextContent(currentBlock) : '';
    const isEmptyBlock = currentBlock && currentBlock.type === 'text' && !currentBlockContent.trim();

    // (Req 34.1) URL detection → bookmark block
    if (this.isUrl(trimmed)) {
      e.preventDefault();
      if (isEmptyBlock) {
        this.convertBlockToBookmark(currentBlock, trimmed);
      } else {
        this.insertBookmarkBlockAfterCurrent(trimmed);
      }
      return;
    }

    // (Req 34.3) Fenced code block detection
    if (this.isFencedCode(trimmed)) {
      e.preventDefault();
      const codeContent = this.extractFencedCode(trimmed);
      if (isEmptyBlock) {
        this.changeBlockType(currentBlock.id, 'code');
        currentBlock.content = this.escapeHtmlForBlock(codeContent);
        this.rerenderBlock(currentBlock);
        this.scheduleSave();
      } else {
        this.insertBlockAfter(
          currentBlock ? currentBlock.id : this.blocks[this.blocks.length - 1]?.id,
          'code',
          this.escapeHtmlForBlock(codeContent)
        );
      }
      return;
    }

    // (Req 34.5) TSV/CSV detection → table block
    if (this.isTsvOrCsv(trimmed)) {
      e.preventDefault();
      const tableData = this.parseTsvOrCsv(trimmed);
      if (tableData && tableData.length > 0) {
        const afterId = currentBlock ? currentBlock.id : this.blocks[this.blocks.length - 1]?.id;
        if (isEmptyBlock) {
          this.convertBlockToTable(currentBlock, tableData);
        } else {
          this.insertBlockAfter(afterId, 'table', '', {
            tableData,
            rows: tableData.length,
            cols: tableData[0].length,
          });
        }
      }
      return;
    }

    // (Req 34.4) Markdown detection → markdownToBlocks()
    if (this.hasMarkdownFormatting(trimmed)) {
      e.preventDefault();
      const parsedBlocks = typeof AIResponseUtils !== 'undefined'
        ? AIResponseUtils.markdownToBlocks(trimmed)
        : null;

      if (parsedBlocks && parsedBlocks.length > 0) {
        let afterId = currentBlock ? currentBlock.id : null;

        // If current block is empty, replace it with the first parsed block
        if (isEmptyBlock && parsedBlocks.length > 0) {
          const first = parsedBlocks.shift();
          this.changeBlockType(currentBlock.id, first.type);
          currentBlock.content = first.content || '';
          if (first.checked !== undefined) currentBlock.checked = first.checked;
          if (first.tableData) {
            currentBlock.tableData = first.tableData;
            currentBlock.rows = first.rows;
            currentBlock.cols = first.cols;
          }
          this.rerenderBlock(currentBlock);
          afterId = currentBlock.id;
        }

        // Insert remaining blocks after
        for (const blockData of parsedBlocks) {
          const opts = {};
          if (blockData.checked !== undefined) opts.checked = blockData.checked;
          if (blockData.tableData) {
            opts.tableData = blockData.tableData;
            opts.rows = blockData.rows;
            opts.cols = blockData.cols;
          }
          if (blockData.equation) opts.equation = blockData.equation;
          if (blockData.url) { opts.url = blockData.url; opts.title = blockData.title || ''; }
          if (blockData.imageUrl) { opts.imageUrl = blockData.imageUrl; opts.src = blockData.src; opts.caption = blockData.caption; }

          const inserted = this.insertBlockAfter(
            afterId || this.blocks[this.blocks.length - 1]?.id,
            blockData.type,
            blockData.content || '',
            opts
          );
          afterId = inserted.id;
        }
        this.scheduleSave();
      }
      return;
    }

    // (Req 34.6) Fallback → plain text insertion (default browser behavior)
    // Do nothing — let the browser handle the paste natively
  }

  /**
   * Check if a string is a valid URL
   * @param {string} text
   * @returns {boolean}
   */
  isUrl(text) {
    // Must be a single line and look like a URL
    if (text.includes('\n')) return false;
    try {
      const url = new URL(text);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Check if text contains a fenced code block pattern
   * @param {string} text
   * @returns {boolean}
   */
  isFencedCode(text) {
    return /^```[\s\S]*```\s*$/m.test(text);
  }

  /**
   * Extract code content from fenced code block
   * @param {string} text
   * @returns {string}
   */
  extractFencedCode(text) {
    const match = text.match(/^```[^\n]*\n?([\s\S]*?)```\s*$/);
    return match ? match[1].replace(/\n$/, '') : text;
  }

  /**
   * Check if text is TSV or CSV (at least 2 rows and 2 columns)
   * @param {string} text
   * @returns {boolean}
   */
  isTsvOrCsv(text) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return false;

    // Check for tab-separated
    const tabCounts = lines.map(l => (l.match(/\t/g) || []).length);
    if (tabCounts[0] >= 1 && tabCounts.every(c => c === tabCounts[0])) return true;

    // Check for comma-separated (consistent column count, at least 2 cols)
    const commaCounts = lines.map(l => (l.match(/,/g) || []).length);
    if (commaCounts[0] >= 1 && commaCounts.every(c => c === commaCounts[0])) return true;

    return false;
  }

  /**
   * Parse TSV or CSV text into a 2D array
   * @param {string} text
   * @returns {Array<Array<string>>}
   */
  parseTsvOrCsv(text) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0) return [];

    // Detect delimiter: tabs take priority
    const hasTabs = lines[0].includes('\t');
    const delimiter = hasTabs ? '\t' : ',';

    return lines.map(line => line.split(delimiter).map(cell => cell.trim()));
  }

  /**
   * Check if text contains markdown formatting worth parsing
   * @param {string} text
   * @returns {boolean}
   */
  hasMarkdownFormatting(text) {
    // Must have multiple lines or clear markdown patterns
    return /^#{1,3} /m.test(text) ||        // headings
      /^[\-\*] /m.test(text) ||              // bullet lists
      /^\d+\. /m.test(text) ||               // numbered lists
      /^> /m.test(text) ||                   // blockquotes
      /^- \[[ xX]\] /m.test(text) ||         // todo items
      /^```/m.test(text) ||                  // code blocks
      /^\|.+\|/m.test(text) ||              // tables
      /^(-{3,}|\*{3,}|_{3,})$/m.test(text); // dividers
  }

  /**
   * Escape HTML for block content
   * @param {string} text
   * @returns {string}
   */
  escapeHtmlForBlock(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Convert an existing block to a bookmark block (Req 34.1)
   * @param {Object} block
   * @param {string} url
   */
  convertBlockToBookmark(block, url) {
    block.type = 'bookmark';
    block.url = url;
    block.title = url;
    block.description = '';
    block.favicon = '';
    block.content = '';
    this.rerenderBlock(block);
    this.scheduleSave();

    // Fetch link preview asynchronously (non-blocking)
    this.fetchLinkPreview(block, url);
  }

  /**
   * Insert a new bookmark block after the current block
   * @param {string} url
   */
  insertBookmarkBlockAfterCurrent(url) {
    const afterId = this.activeBlock
      ? this.activeBlock.id
      : this.blocks[this.blocks.length - 1]?.id;

    const block = this.insertBlockAfter(afterId, 'bookmark', '', {
      url,
      title: url,
      description: '',
      favicon: '',
    });

    // Fetch link preview asynchronously (non-blocking)
    this.fetchLinkPreview(block, url);
  }

  /**
   * Fetch link preview metadata for a bookmark block (non-blocking)
   * @param {Object} block
   * @param {string} url
   */
  async fetchLinkPreview(block, url) {
    try {
      const hostname = new URL(url).hostname;
      block.favicon = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;

      // Try to extract a readable title from the URL
      const pathParts = new URL(url).pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        const lastPart = decodeURIComponent(pathParts[pathParts.length - 1])
          .replace(/[-_]/g, ' ')
          .replace(/\.\w+$/, '');
        if (lastPart && lastPart.length > 1) {
          block.title = lastPart.charAt(0).toUpperCase() + lastPart.slice(1);
        }
      }

      if (block.title === url) {
        block.title = hostname;
      }

      this.rerenderBlock(block);
      this.scheduleSave();
    } catch {
      // Silently fail — bookmark still works with URL as title
    }
  }

  /**
   * Convert an existing block to a table block
   * @param {Object} block
   * @param {Array<Array<string>>} tableData
   */
  convertBlockToTable(block, tableData) {
    block.type = 'table';
    block.content = '';
    block.tableData = tableData;
    block.rows = tableData.length;
    block.cols = tableData[0].length;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Handle multiple files (from drop or paste)
   */
  async handleFiles(files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        await this.uploadImageAndCreateBlock(file);
      }
    }
  }

  /**
   * Upload image and create a block for it
   */
  async uploadImageAndCreateBlock(file) {
    try {
      // Compress image first
      let blob = file;
      const win = this.doc.defaultView;
      if (win.ImageCompression || (win.opener && win.opener.ImageCompression)) {
        blob = await ImageCompression.compress(file);
      }

      const dataUrl = await Utils.readFileAsDataURL(blob);

      // Create new image block
      const block = this.createBlock('image');
      block.imageUrl = dataUrl;

      // Add after active block or at end
      if (this.activeBlock) {
        const index = this.blocks.findIndex(b => b.id === this.activeBlock.id);
        this.blocks.splice(index + 1, 0, block);
      } else {
        this.blocks.push(block);
      }

      this.renderBlocks();
      this.scheduleSave();
    } catch (error) {
      console.error('Failed to upload image:', error);
    }
  }

  // ============ Image Handling ============

  /**
   * Handle image upload
   */
  async handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const blockId = e.target.dataset.blockId;
    const block = this.getBlockById(blockId);
    if (!block) return;

    try {
      const dataUrl = await Utils.readFileAsDataURL(file);
      block.imageUrl = dataUrl;

      // Re-render block
      const oldEl = this.getBlockElement(blockId);
      if (oldEl) {
        const newEl = block.createElement();
        oldEl.replaceWith(newEl);
      }

      this.scheduleSave();
    } catch (error) {
      console.error('Failed to upload image:', error);
      Utils.showToast('Failed to upload image', 'error');
    }

    e.target.value = '';
  }

  /**
   * Handle file upload
   */
  async handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const blockId = e.target.dataset.blockId;
    const block = this.getBlockById(blockId);
    if (!block) return;

    try {
      const dataUrl = await Utils.readFileAsDataURL(file);
      block.fileName = file.name;
      block.fileSize = file.size;
      block.fileData = dataUrl;

      // Re-render block
      this.rerenderBlock(block);
      this.scheduleSave();
    } catch (error) {
      console.error('Failed to upload file:', error);
      Utils.showToast('Failed to upload file', 'error');
    }

    e.target.value = '';
  }

  /**
   * Process bookmark URL and fetch metadata
   */
  async processBookmarkUrl(block, url) {
    try {
      // Ensure URL has protocol
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      block.url = url;

      // Try to extract basic info from URL
      const urlObj = new URL(url);
      block.title = urlObj.hostname;
      block.favicon = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;

      // Re-render block
      this.rerenderBlock(block);
      this.scheduleSave();
    } catch (error) {
      console.error('Failed to process bookmark URL:', error);
      Utils.showToast('Invalid URL', 'error');
    }
  }

  // ============ Utilities ============

  /**
   * Check if caret is at start of element
   */
  isCaretAtStart(el) {
    const sel = this.doc.defaultView.getSelection();
    if (!sel.isCollapsed) return false;

    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);

    return preRange.toString().length === 0;
  }

  /**
   * Check if caret is at end of element
   */
  isCaretAtEnd(el) {
    const sel = this.doc.defaultView.getSelection();
    if (!sel.isCollapsed) return false;

    const range = sel.getRangeAt(0);
    const postRange = range.cloneRange();
    postRange.selectNodeContents(el);
    postRange.setStart(range.endContainer, range.endOffset);

    return postRange.toString().length === 0;
  }

  /**
   * Place caret at specific position
   */
  placeCaretAtPosition(el, position) {
    const range = this.doc.createRange();
    const sel = this.doc.defaultView.getSelection();

    let currentPos = 0;
    const walker = this.doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const nodeLength = node.textContent.length;

      if (currentPos + nodeLength >= position) {
        range.setStart(node, position - currentPos);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }

      currentPos += nodeLength;
    }

    // If position is beyond content, place at end
    this.placeCaretAtEnd(el);
  }

  /**
   * Get text from document fragment
   */
  getTextFromFragment(fragment) {
    const div = this.doc.createElement('div');
    div.appendChild(fragment.cloneNode(true));
    return div.innerHTML;
  }

  /**
   * Render backlinks panel
   */
  async renderBacklinks() {
    const panel = this.root.querySelector('.backlinks-panel') || this.doc.getElementById('backlinks-panel');
    const list = this.root.querySelector('.backlinks-list') || this.doc.getElementById('backlinks-list');
    if (!panel || !list) return;

    if (!this.noteId) {
      panel.classList.add('hidden');
      return;
    }

    const backlinks = await Storage.getBacklinks(this.noteId);

    if (backlinks.length === 0) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    list.innerHTML = '';

    backlinks.forEach(note => {
      const item = this.doc.createElement('div');
      item.className = 'backlink-item';
      item.innerHTML = `
        <div class="backlink-item-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
      `;
      const titleDiv = this.doc.createElement('div');
      titleDiv.className = 'backlink-item-title';
      titleDiv.textContent = note.name || 'Untitled';
      item.appendChild(titleDiv);
      item.addEventListener('click', () => {
        const app = this.getApp();
        if (app) {
          app.openNote(note.id);
        }
      });
      list.appendChild(item);
    });
  }

  // ============ Saving ============

  /**
   * Schedule save with debounce (Req 25.1).
   * Batches multiple rapid edits into a single save with a 500ms delay.
   * @returns {void}
   */
  scheduleSave() {
    this.updateSaveStatus('Saving...');
    this._snapshotDirty = true;

    clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.save(), 500);
  }

  /**
   * Collect DOM-dependent save metadata inside a rAF callback (Req 25.2).
   * Batches DOM reads to avoid forced synchronous layouts during save prep.
   * @returns {Promise<{preview: string, todoProgress: Object|null, text: string}>}
   */
  _prepareSaveData() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        let preview = '';
        let todoProgress = null;
        if (typeof SidebarUtils !== 'undefined') {
          const metadata = SidebarUtils.buildNoteSaveMetadata(this.blocks);
          preview = metadata.preview;
          todoProgress = metadata.todoProgress;
        }
        const text = this.getAllBlocksTextContent();
        resolve({ preview, todoProgress, text });
      });
    });
  }

  /**
   * Persist note and blocks to storage.
   * Uses rAF-batched DOM reads for save prep (Req 25.2),
   * updates "Saved" status on completion (Req 25.3),
   * and retries once after 1 s on failure with error toast if retry also fails (Req 25.4).
   * @param {boolean} [isRetry=false] - Whether this is a retry attempt
   * @returns {Promise<void>}
   */
  async save(isRetry = false) {
    try {
      // Batch DOM reads via rAF before writing to storage (Req 25.2)
      const saveData = await this._prepareSaveData();

      // Save note
      if (this.noteData) {
        this.noteData.preview = saveData.preview;
        this.noteData.todoProgress = saveData.todoProgress;

        await Storage.updateNote(this.noteData);

        // Update bidirectional links
        const linkNames = Utils.extractWikiLinks(saveData.text);
        await Storage.updateNoteLinks(this.noteId, linkNames);
      }

      // Save blocks
      for (let i = 0; i < this.blocks.length; i++) {
        const block = this.blocks[i];
        const data = block.serialize();
        // Field name 'canvasId' kept for backward compatibility
        data.canvasId = this.noteId;
        data.order = i;
        await Storage.saveElement(data);
      }

      this.updateSaveStatus('Saved');

      // Trigger background indexing and sidebar preview refresh
      const app = this.getApp();
      if (app && app.triggerIndexing) {
        app.triggerIndexing(this.noteId);
      }
      if (app && app.updateSidebarNotePreview) {
        app.updateSidebarNotePreview(this.noteData);
      }
    } catch (error) {
      console.error('Failed to save:', error);

      if (!isRetry) {
        // Retry once after 1 second (Req 25.4)
        this.updateSaveStatus('Retrying...');
        setTimeout(() => this.save(true), 1000);
      } else {
        // Retry also failed — show error toast (Req 25.4)
        this.updateSaveStatus('Error saving');
        Utils.showToast('Failed to save note. Please try again.', 'error');
      }
    }
  }

  /**
   * Update save status display
   */
  updateSaveStatus(status) {
    const el = this.doc.getElementById('save-status');
    if (el) {
      el.textContent = status;
    }
  }

  /**
   * Update timestamp display below title
   */
  updateTimestampDisplay() {
    const timestampEl = this.root.querySelector('.page-timestamp') || this.doc.getElementById('page-timestamp');
    if (!timestampEl || !this.noteData) return;

    const createdAt = this.noteData.createdAt;
    const updatedAt = this.noteData.updatedAt;

    if (!createdAt) {
      timestampEl.textContent = '';
      return;
    }

    const createdStr = Utils.formatTimestamp(createdAt);

    // Show both created and updated if different (more than 1 minute apart)
    if (updatedAt && Math.abs(updatedAt - createdAt) > 60000) {
      const updatedStr = Utils.formatTimestamp(updatedAt);
      timestampEl.textContent = `Created ${createdStr} · Updated ${updatedStr}`;
    } else {
      timestampEl.textContent = `Created ${createdStr}`;
    }
  }

  /**
   * Initialize Intersection Observer for lazy loading images
   */
  initImageObserver() {
    this.imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
            img.classList.remove('lazy-image');
            img.classList.add('loaded');

            // Update centering once this specific image loads
            img.addEventListener('load', () => {
              this.updateWideContentCentering();
            }, { once: true });

            observer.unobserve(img);
          }
        }
      });
    }, {
      rootMargin: '400px 0px', // Preload images 400px before they enter viewport
      threshold: 0.01
    });
  }

  /**
   * Start observing lazy images in a container
   */
  observeImages(container = this.container) {
    const images = container.querySelectorAll('.lazy-image');
    images.forEach(img => {
      this.imageObserver.observe(img);
    });
  }

  // ============ Multi-Block Selection (Req 13) ============

  /**
   * Update the visual selection state on all blocks.
   */
  updateBlockSelectionUI() {
    const allBlocks = this.container.querySelectorAll('.block');
    allBlocks.forEach(el => {
      el.classList.toggle('block-selected', this.selectedBlockIds.has(el.dataset.id));
    });
    this.updateSelectionActionBar();
  }

  /**
   * Clear multi-block selection and remove action bar.
   */
  clearBlockSelection() {
    this.selectedBlockIds.clear();
    const allBlocks = this.container.querySelectorAll('.block.block-selected');
    allBlocks.forEach(el => el.classList.remove('block-selected'));
    this.hideSelectionActionBar();
  }

  /**
   * Show or update the floating action bar for multi-block selection (Req 13.3).
   */
  updateSelectionActionBar() {
    if (this.selectedBlockIds.size < 2) {
      this.hideSelectionActionBar();
      return;
    }

    let bar = this.doc.querySelector('.selection-action-bar');
    if (!bar) {
      bar = this.doc.createElement('div');
      bar.className = 'selection-action-bar';

      const actions = [
        { label: 'Delete', action: 'delete', danger: true },
        { label: 'Move Up', action: 'move-up' },
        { label: 'Move Down', action: 'move-down' },
        { label: 'Turn into...', action: 'turn-into' },
      ];

      actions.forEach(({ label, action, danger }) => {
        const btn = this.doc.createElement('button');
        btn.className = 'selection-action-btn' + (danger ? ' danger' : '');
        btn.textContent = label;
        btn.dataset.action = action;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handleSelectionAction(action, btn);
        });
        bar.appendChild(btn);
      });

      this.doc.body.appendChild(bar);
    }

    // Update count label
    let countLabel = bar.querySelector('.selection-count');
    if (!countLabel) {
      countLabel = this.doc.createElement('span');
      countLabel.className = 'selection-count';
      bar.prepend(countLabel);
    }
    countLabel.textContent = `${this.selectedBlockIds.size} selected`;

    // Position at bottom center of editor
    const editor = this.root.querySelector('.editor') || this.doc.getElementById('editor');
    if (editor) {
      const rect = editor.getBoundingClientRect();
      bar.style.left = `${rect.left + rect.width / 2}px`;
      bar.style.bottom = '24px';
    }
  }

  /**
   * Hide the floating selection action bar.
   */
  hideSelectionActionBar() {
    const bar = this.doc.querySelector('.selection-action-bar');
    if (bar) bar.remove();
  }

  /**
   * Handle an action from the selection action bar.
   * @param {string} action
   * @param {HTMLElement} anchorBtn - Button element for submenu positioning
   */
  handleSelectionAction(action, anchorBtn) {
    if (action === 'delete') {
      this.deleteSelectedBlocks();
    } else if (action === 'move-up') {
      this.moveSelectedBlocks(-1);
    } else if (action === 'move-down') {
      this.moveSelectedBlocks(1);
    } else if (action === 'turn-into') {
      this.showSelectionTurnIntoMenu(anchorBtn);
    }
  }

  /**
   * Delete all selected blocks (Req 13.4).
   */
  deleteSelectedBlocks() {
    if (this.selectedBlockIds.size === 0) return;

    // Find the index of the first selected block for focus after deletion
    const firstSelectedIdx = this.blocks.findIndex(b => this.selectedBlockIds.has(b.id));

    // Record undo entries and delete
    const idsToDelete = new Set(this.selectedBlockIds);
    idsToDelete.forEach(id => {
      const idx = this.blocks.findIndex(b => b.id === id);
      if (idx !== -1) {
        const snapshot = this.snapshotBlock(this.blocks[idx]);
        snapshot.order = idx;
        this.pushUndo({ type: 'delete', blockId: id, before: snapshot, after: null });
      }
    });

    this.blocks = this.blocks.filter(b => !idsToDelete.has(b.id));
    idsToDelete.forEach(id => Storage.deleteElement(id));

    // Ensure at least one block remains
    if (this.blocks.length === 0) {
      const block = this.createBlock('text');
      this.blocks.push(block);
    }

    this.clearBlockSelection();
    this.renderBlocks();

    // Focus block preceding the selection, or first block
    const focusIdx = Math.max(0, Math.min(firstSelectedIdx, this.blocks.length - 1));
    this.focusBlock(this.blocks[focusIdx].id, true);
    this.scheduleSave();
  }

  /**
   * Move all selected blocks up or down by one position.
   * @param {number} direction - -1 for up, 1 for down
   */
  moveSelectedBlocks(direction) {
    if (this.selectedBlockIds.size === 0) return;

    // Get sorted indices of selected blocks
    const indices = [];
    this.blocks.forEach((b, i) => {
      if (this.selectedBlockIds.has(b.id)) indices.push(i);
    });

    if (direction === -1 && indices[0] === 0) return;
    if (direction === 1 && indices[indices.length - 1] === this.blocks.length - 1) return;

    // Move in the right order to avoid conflicts
    const ordered = direction === -1 ? indices : indices.slice().reverse();
    ordered.forEach(idx => {
      const target = idx + direction;
      const temp = this.blocks[idx];
      this.blocks[idx] = this.blocks[target];
      this.blocks[target] = temp;
    });

    this.renderBlocks();
    this.updateBlockSelectionUI();
    this.scheduleSave();
  }

  /**
   * Show "Turn into..." submenu for selected blocks.
   * @param {HTMLElement} anchorBtn
   */
  showSelectionTurnIntoMenu(anchorBtn) {
    // Remove any existing submenu
    const existing = this.doc.querySelector('.turn-into-menu');
    if (existing) existing.remove();

    const submenu = this.doc.createElement('div');
    submenu.className = 'turn-into-menu';

    this.getTurnIntoTypes().forEach(({ type, name, icon }) => {
      const item = this.doc.createElement('div');
      item.className = 'context-menu-item';

      const iconSpan = this.doc.createElement('span');
      iconSpan.className = 'turn-into-icon';
      iconSpan.textContent = icon;
      item.appendChild(iconSpan);

      const label = this.doc.createElement('span');
      label.textContent = name;
      item.appendChild(label);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedBlockIds.forEach(id => {
          const block = this.getBlockById(id);
          if (block && block.type !== type) {
            this.changeBlockType(id, type);
          }
        });
        submenu.remove();
        this.clearBlockSelection();
      });

      submenu.appendChild(item);
    });

    // Position above the button
    const rect = anchorBtn.getBoundingClientRect();
    submenu.style.position = 'fixed';
    submenu.style.left = `${rect.left}px`;
    submenu.style.top = `${rect.top - 8}px`;
    submenu.style.transform = 'translateY(-100%)';

    this.doc.body.appendChild(submenu);

    // Close on outside click
    const closeHandler = (e) => {
      if (!submenu.contains(e.target)) {
        submenu.remove();
        this.doc.removeEventListener('click', closeHandler);
      }
    };
    requestAnimationFrame(() => {
      this.doc.addEventListener('click', closeHandler);
    });
  }

  /**
   * Block types available in the "Turn into..." menu (Req 12.1).
   * Excludes media-only types (image, video, file, bookmark, equation, table)
   * since they require special data that text conversion can't provide.
   * @returns {Array<{type: string, name: string, icon: string}>}
   */
  getTurnIntoTypes() {
    return [
      { type: 'text', name: 'Text', icon: 'T' },
      { type: 'h1', name: 'Heading 1', icon: 'H1' },
      { type: 'h2', name: 'Heading 2', icon: 'H2' },
      { type: 'h3', name: 'Heading 3', icon: 'H3' },
      { type: 'bullet', name: 'Bulleted List', icon: '•' },
      { type: 'numbered', name: 'Numbered List', icon: '1.' },
      { type: 'todo', name: 'To-do', icon: '☐' },
      { type: 'quote', name: 'Quote', icon: '"' },
      { type: 'code', name: 'Code', icon: '</>' },
      { type: 'callout', name: 'Callout', icon: '💡' },
      { type: 'divider', name: 'Divider', icon: '—' },
      { type: 'toggle', name: 'Toggle', icon: '▶' },
    ];
  }

  /**
   * Handle Tab/Shift+Tab navigation within table cells (Req 33.1, 33.2)
   * @param {Object} block - The table block
   * @param {HTMLElement} cell - The currently focused cell (th or td)
   * @param {boolean} shiftKey - Whether Shift is held
   */
  handleTableTabNavigation(block, cell, shiftKey) {
    const row = parseInt(cell.dataset.row);
    const col = parseInt(cell.dataset.col);
    const blockEl = this.getBlockElement(block.id);
    if (!blockEl) return;

    let nextRow = row;
    let nextCol = col;

    if (shiftKey) {
      // Move to previous cell
      nextCol--;
      if (nextCol < 0) {
        nextRow--;
        nextCol = block.cols - 1;
      }
      if (nextRow < 0) return; // Already at first cell
    } else {
      // Move to next cell
      nextCol++;
      if (nextCol >= block.cols) {
        nextRow++;
        nextCol = 0;
      }
      // Tab in last cell creates new row
      if (nextRow >= block.rows) {
        this.addTableRow(block, blockEl);
        nextRow = block.rows - 1;
        nextCol = 0;
      }
    }

    const nextCell = blockEl.querySelector(`[data-row="${nextRow}"][data-col="${nextCol}"]`);
    if (nextCell) {
      nextCell.focus();
      // Select all text in the cell
      const range = this.doc.createRange();
      range.selectNodeContents(nextCell);
      const sel = this.doc.defaultView.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /**
   * Handle right-click on table cells to show context menu (Req 33.3)
   * @param {Event} e - The contextmenu event
   */
  onTableContextMenu(e) {
    const cell = e.target.closest('th, td');
    if (!cell) return;

    const blockEl = e.target.closest('.block[data-type="table"]');
    if (!blockEl) return;

    const block = this.getBlockById(blockEl.dataset.id);
    if (!block || block.type !== 'table') return;

    e.preventDefault();
    this.showTableContextMenu(block, cell, e.clientX, e.clientY);
  }

  /**
   * Show table context menu at the given position (Req 33.3)
   * @param {Object} block - The table block
   * @param {HTMLElement} cell - The right-clicked cell
   * @param {number} x - Mouse X position
   * @param {number} y - Mouse Y position
   */
  showTableContextMenu(block, cell, x, y) {
    this.hideTableContextMenu();

    const row = parseInt(cell.dataset.row);
    const col = parseInt(cell.dataset.col);

    const menu = this.doc.createElement('div');
    menu.className = 'table-context-menu';

    const items = [
      { label: 'Insert Row Above', action: () => this.insertTableRowAt(block, row) },
      { label: 'Insert Row Below', action: () => this.insertTableRowAt(block, row + 1) },
      { label: 'Insert Column Left', action: () => this.insertTableColumnAt(block, col) },
      { label: 'Insert Column Right', action: () => this.insertTableColumnAt(block, col + 1) },
      { label: 'divider' },
      { label: 'Delete Row', action: () => this.deleteTableRowAt(block, row), disabled: block.rows <= 1 },
      { label: 'Delete Column', action: () => this.deleteTableColumnAt(block, col), disabled: block.cols <= 1 },
      { label: 'divider' },
      { label: 'Toggle Header Row', action: () => this.toggleTableHeaderRow(block) },
    ];

    items.forEach(item => {
      if (item.label === 'divider') {
        const hr = this.doc.createElement('div');
        hr.className = 'table-context-menu-divider';
        menu.appendChild(hr);
        return;
      }
      const el = this.doc.createElement('div');
      el.className = 'table-context-menu-item';
      el.textContent = item.label;
      if (item.disabled) {
        el.classList.add('disabled');
      } else {
        el.addEventListener('click', () => {
          item.action();
          this.hideTableContextMenu();
        });
      }
      menu.appendChild(el);
    });

    menu.style.position = 'fixed';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    this.doc.body.appendChild(menu);

    // Adjust if menu goes off-screen
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 8}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 8}px`;
      }
    });

    // Close on outside click
    this._tableContextMenuCloseHandler = (e) => {
      if (!menu.contains(e.target)) {
        this.hideTableContextMenu();
      }
    };
    requestAnimationFrame(() => {
      this.doc.addEventListener('click', this._tableContextMenuCloseHandler);
    });
  }

  /**
   * Hide the table context menu
   */
  hideTableContextMenu() {
    const existing = this.doc.querySelector('.table-context-menu');
    if (existing) existing.remove();
    if (this._tableContextMenuCloseHandler) {
      this.doc.removeEventListener('click', this._tableContextMenuCloseHandler);
      this._tableContextMenuCloseHandler = null;
    }
  }

  /**
   * Insert a row at a specific index in the table
   * @param {Object} block - The table block
   * @param {number} atIndex - Row index to insert at
   */
  insertTableRowAt(block, atIndex) {
    if (!block.tableData) return;
    const newRow = new Array(block.cols).fill('');
    block.tableData.splice(atIndex, 0, newRow);
    block.rows++;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Insert a column at a specific index in the table
   * @param {Object} block - The table block
   * @param {number} atIndex - Column index to insert at
   */
  insertTableColumnAt(block, atIndex) {
    if (!block.tableData) return;
    block.tableData.forEach((row, rowIndex) => {
      row.splice(atIndex, 0, rowIndex === 0 ? `Header ${block.cols + 1}` : '');
    });
    block.cols++;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Delete a specific row from the table
   * @param {Object} block - The table block
   * @param {number} atIndex - Row index to delete
   */
  deleteTableRowAt(block, atIndex) {
    if (!block.tableData || block.rows <= 1) return;
    block.tableData.splice(atIndex, 1);
    block.rows--;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Delete a specific column from the table
   * @param {Object} block - The table block
   * @param {number} atIndex - Column index to delete
   */
  deleteTableColumnAt(block, atIndex) {
    if (!block.tableData || block.cols <= 1) return;
    block.tableData.forEach(row => {
      row.splice(atIndex, 1);
    });
    block.cols--;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Toggle whether the first row is rendered as header (th) or data (td)
   * @param {Object} block - The table block
   */
  toggleTableHeaderRow(block) {
    block.hasHeaderRow = !block.hasHeaderRow;
    this.rerenderBlock(block);
    this.scheduleSave();
  }

  /**
   * Show block action menu anchored to a block handle (Req 12.1).
   * @param {string} blockId - The block ID
   * @param {HTMLElement} anchorEl - The block handle element to anchor the menu to
   */
  showBlockActionMenu(blockId, anchorEl) {
    this.hideBlockActionMenu();

    const block = this.getBlockById(blockId);
    if (!block) return;

    const menu = this.doc.createElement('div');
    menu.className = 'block-action-menu';
    menu.dataset.blockId = blockId;

    // "Turn into..." item
    const turnIntoItem = this.doc.createElement('div');
    turnIntoItem.className = 'context-menu-item';
    turnIntoItem.innerHTML = '<span>Turn into...</span><span class="submenu-arrow">›</span>';
    turnIntoItem.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showTurnIntoSubmenu(blockId, turnIntoItem);
    });
    menu.appendChild(turnIntoItem);

    // AI actions for text-containing blocks (Req 20.1)
    const textBlockTypes = ['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'code', 'toggle'];
    if (textBlockTypes.includes(block.type)) {
      const divider = this.doc.createElement('div');
      divider.className = 'block-action-menu-divider';
      menu.appendChild(divider);

      const aiActions = [
        { action: 'rewrite', label: 'Rewrite', icon: '✏️' },
        { action: 'expand', label: 'Expand', icon: '📝' },
        { action: 'summarize', label: 'Summarize', icon: '📋' },
        { action: 'translate', label: 'Translate', icon: '🌐' },
      ];

      aiActions.forEach(({ action, label, icon }) => {
        const item = this.doc.createElement('div');
        item.className = 'context-menu-item ai-action-item';

        const iconSpan = this.doc.createElement('span');
        iconSpan.className = 'ai-action-icon';
        iconSpan.textContent = icon;
        item.appendChild(iconSpan);

        const labelSpan = this.doc.createElement('span');
        labelSpan.textContent = label;
        item.appendChild(labelSpan);

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hideBlockActionMenu();
          this.handleInlineAIAction(blockId, action);
        });
        menu.appendChild(item);
      });
    }

    // Position menu below the handle
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;

    this.doc.body.appendChild(menu);

    // Close on outside click (deferred so this click doesn't close it)
    requestAnimationFrame(() => {
      this._blockActionMenuCloseHandler = (e) => {
        const submenu = this.doc.querySelector('.turn-into-menu');
        if (!menu.contains(e.target) && !(submenu && submenu.contains(e.target))) {
          this.hideBlockActionMenu();
        }
      };
      this.doc.addEventListener('click', this._blockActionMenuCloseHandler);
    });
  }

  /**
   * Handle an inline AI action on a block (Req 20.1–20.4).
   * @param {string} blockId - The block ID
   * @param {'rewrite'|'expand'|'summarize'|'translate'} action - The AI action
   */
  async handleInlineAIAction(blockId, action) {
    const llm = this.getLLM();

    // Req 20.4: toast if AI not configured
    if (!llm || !llm.isConfigured()) {
      Utils.showToast('AI not configured. Please set up in Settings.', 'error');
      return;
    }

    const block = this.getBlockById(blockId);
    if (!block) return;

    const text = this.extractBlockTextContent(block);
    if (!text || !text.trim()) {
      Utils.showToast('Block has no content to transform', 'error');
      return;
    }

    // System prompts per action (Req 20.2)
    const systemPrompts = {
      rewrite: 'Rewrite the following text to improve clarity and readability. Keep the same meaning and approximate length. Return only the rewritten text, no explanations.',
      expand: 'Expand the following text with more detail and depth. Maintain the same tone and style. Return only the expanded text, no explanations.',
      summarize: 'Summarize the following text concisely. Return only the summary, no explanations.',
      translate: 'Translate the following text to English. If it is already in English, translate it to Spanish. Return only the translated text, no explanations.',
    };

    // Show loading indicator on the block
    const blockEl = this.getBlockElement(blockId);
    if (blockEl) {
      blockEl.classList.add('ai-processing');
    }

    try {
      const messages = [
        { role: 'system', content: systemPrompts[action] },
        { role: 'user', content: text },
      ];

      const result = await llm.chat(messages);

      if (result && result.trim()) {
        // Record undo before replacing content (Req 20.3)
        const beforeSnapshot = this.snapshotBlock(block);
        block.content = result.trim();
        this.pushUndo({
          type: 'content',
          blockId: block.id,
          before: beforeSnapshot,
          after: this.snapshotBlock(block),
        });

        this.rerenderBlock(block);
        this.scheduleSave();
        Utils.showToast(`Block ${action}d`, 'success');
      } else {
        Utils.showToast('AI returned empty response', 'error');
      }
    } catch (error) {
      console.error(`Inline AI ${action} failed:`, error);
      Utils.showToast(`AI ${action} failed: ${error.message}`, 'error');
    } finally {
      if (blockEl) {
        blockEl.classList.remove('ai-processing');
      }
    }
  }

  /**
   * Hide the block action menu and any submenu.
   */
  hideBlockActionMenu() {
    const existing = this.doc.querySelector('.block-action-menu');
    if (existing) existing.remove();
    const existingSub = this.doc.querySelector('.turn-into-menu');
    if (existingSub) existingSub.remove();
    if (this._blockActionMenuCloseHandler) {
      this.doc.removeEventListener('click', this._blockActionMenuCloseHandler);
      this._blockActionMenuCloseHandler = null;
    }
  }

  /**
   * Show the "Turn into..." submenu listing compatible block types (Req 12.1).
   * @param {string} blockId - The block to convert
   * @param {HTMLElement} anchorItem - The menu item to anchor the submenu to
   */
  showTurnIntoSubmenu(blockId, anchorItem) {
    // Remove any existing submenu
    const existingSub = this.doc.querySelector('.turn-into-menu');
    if (existingSub) existingSub.remove();

    const block = this.getBlockById(blockId);
    if (!block) return;

    const submenu = this.doc.createElement('div');
    submenu.className = 'turn-into-menu';

    this.getTurnIntoTypes().forEach(({ type, name, icon }) => {
      const item = this.doc.createElement('div');
      item.className = 'context-menu-item';
      if (type === block.type) {
        item.classList.add('active');
      }

      const iconSpan = this.doc.createElement('span');
      iconSpan.className = 'turn-into-icon';
      iconSpan.textContent = icon;
      item.appendChild(iconSpan);

      const label = this.doc.createElement('span');
      label.textContent = name;
      item.appendChild(label);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (type !== block.type) {
          this.changeBlockType(blockId, type);
        }
        this.hideBlockActionMenu();
      });

      submenu.appendChild(item);
    });

    // Position to the right of the anchor item
    const rect = anchorItem.getBoundingClientRect();
    submenu.style.position = 'fixed';
    submenu.style.left = `${rect.right + 4}px`;
    submenu.style.top = `${rect.top}px`;

    this.doc.body.appendChild(submenu);

    // Adjust if submenu goes off-screen to the right
    requestAnimationFrame(() => {
      const subRect = submenu.getBoundingClientRect();
      if (subRect.right > window.innerWidth) {
        submenu.style.left = `${rect.left - subRect.width - 4}px`;
      }
      if (subRect.bottom > window.innerHeight) {
        submenu.style.top = `${window.innerHeight - subRect.height - 8}px`;
      }
    });
  }

  // ============ Version History / Snapshots (Req 31) ============

  /**
   * Start the 5-minute auto-snapshot interval.
   */
  _startSnapshotInterval() {
    this._stopSnapshotInterval();
    this._snapshotInterval = setInterval(() => this._autoSnapshot(), 5 * 60 * 1000);
  }

  /**
   * Stop the auto-snapshot interval.
   */
  _stopSnapshotInterval() {
    if (this._snapshotInterval) {
      clearInterval(this._snapshotInterval);
      this._snapshotInterval = null;
    }
  }

  /**
   * Auto-save a snapshot if content has changed since last snapshot (Req 31.1).
   */
  async _autoSnapshot() {
    if (!this._snapshotDirty || !this.noteId || !this.noteData) return;
    this._snapshotDirty = false;

    try {
      const blocks = this.blocks.map(b => b.serialize());
      await Storage.saveSnapshot(this.noteId, blocks, this.noteData.name || 'Untitled');
    } catch (e) {
      console.warn('Auto-snapshot failed:', e);
    }
  }

  /**
   * Toggle the version history panel (Req 31.2).
   */
  async toggleVersionHistory() {
    const existing = this.doc.getElementById('version-history-panel');
    if (existing) {
      existing.remove();
      this._versionHistoryOpen = false;
      return;
    }
    this._versionHistoryOpen = true;

    const snapshots = await Storage.getSnapshots(this.noteId);

    const panel = this.doc.createElement('div');
    panel.id = 'version-history-panel';
    panel.className = 'version-history-panel';

    // Header
    const header = this.doc.createElement('div');
    header.className = 'version-history-header';

    const title = this.doc.createElement('span');
    title.textContent = 'Version History';
    header.appendChild(title);

    const closeBtn = this.doc.createElement('button');
    closeBtn.className = 'icon-btn';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    closeBtn.addEventListener('click', () => {
      panel.remove();
      this._versionHistoryOpen = false;
    });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Timeline
    const timeline = this.doc.createElement('div');
    timeline.className = 'version-history-timeline';

    if (snapshots.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'version-history-empty';
      empty.textContent = 'No snapshots yet. Snapshots are saved automatically every 5 minutes during editing.';
      timeline.appendChild(empty);
    } else {
      snapshots.forEach(snap => {
        const item = this.doc.createElement('div');
        item.className = 'version-history-item';

        const info = this.doc.createElement('div');
        info.className = 'version-history-item-info';

        const ts = this.doc.createElement('span');
        ts.className = 'version-history-item-time';
        ts.textContent = this.formatRelativeTime(snap.timestamp);
        ts.title = new Date(snap.timestamp).toLocaleString();
        info.appendChild(ts);

        const snapTitle = this.doc.createElement('span');
        snapTitle.className = 'version-history-item-title';
        snapTitle.textContent = snap.title || 'Untitled';
        info.appendChild(snapTitle);

        item.appendChild(info);

        const actions = this.doc.createElement('div');
        actions.className = 'version-history-item-actions';

        const previewBtn = this.doc.createElement('button');
        previewBtn.className = 'secondary-btn-small';
        previewBtn.textContent = 'Preview';
        previewBtn.addEventListener('click', () => this._previewSnapshot(snap));
        actions.appendChild(previewBtn);

        const revertBtn = this.doc.createElement('button');
        revertBtn.className = 'secondary-btn-small danger';
        revertBtn.textContent = 'Revert';
        revertBtn.addEventListener('click', () => this._revertToSnapshot(snap));
        actions.appendChild(revertBtn);

        item.appendChild(actions);
        timeline.appendChild(item);
      });
    }

    panel.appendChild(timeline);

    // Insert panel after header
    const headerEl = this.doc.getElementById('header');
    if (headerEl && headerEl.parentNode) {
      headerEl.parentNode.insertBefore(panel, headerEl.nextSibling);
    } else {
      this.doc.body.appendChild(panel);
    }
  }

  /**
   * Show a read-only preview of a snapshot (Req 31.3).
   * @param {Object} snap - Snapshot object
   */
  _previewSnapshot(snap) {
    // Remove existing preview
    const existing = this.doc.getElementById('snapshot-preview-modal');
    if (existing) existing.remove();

    const modal = this.doc.createElement('div');
    modal.id = 'snapshot-preview-modal';
    modal.className = 'modal';

    const content = this.doc.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '700px';

    // Header
    const mHeader = this.doc.createElement('div');
    mHeader.className = 'modal-header';

    const mTitle = this.doc.createElement('h2');
    mTitle.textContent = `Snapshot — ${new Date(snap.timestamp).toLocaleString()}`;
    mHeader.appendChild(mTitle);

    const closeBtn = this.doc.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => modal.remove());
    mHeader.appendChild(closeBtn);
    content.appendChild(mHeader);

    // Body — read-only block preview
    const body = this.doc.createElement('div');
    body.className = 'modal-body snapshot-preview-body';

    if (snap.blocks && snap.blocks.length > 0) {
      snap.blocks.forEach(blockData => {
        const div = this.doc.createElement('div');
        div.className = `snapshot-block snapshot-block-${blockData.type || 'text'}`;

        const text = blockData.content
          ? blockData.content.replace(/<[^>]*>/g, '')
          : '';

        if (blockData.type === 'divider') {
          div.appendChild(this.doc.createElement('hr'));
        } else if (blockData.type === 'todo') {
          const checkbox = this.doc.createElement('span');
          checkbox.textContent = blockData.checked ? '☑ ' : '☐ ';
          div.appendChild(checkbox);
          div.appendChild(this.doc.createTextNode(text));
        } else {
          div.textContent = text || '\u00A0';
        }

        body.appendChild(div);
      });
    } else {
      const empty = this.doc.createElement('p');
      empty.textContent = 'This snapshot has no content.';
      body.appendChild(empty);
    }

    content.appendChild(body);
    modal.appendChild(content);

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    this.doc.body.appendChild(modal);
  }

  /**
   * Revert current note to a snapshot's content (Req 31.4).
   * @param {Object} snap - Snapshot object
   */
  async _revertToSnapshot(snap) {
    let confirmed = true;
    if (typeof confirmDialog === 'function') {
      confirmed = await confirmDialog({
        title: 'Revert to Snapshot',
        message: `Replace current content with the version from ${new Date(snap.timestamp).toLocaleString()}? This will save the current content as a new snapshot first.`,
        confirmText: 'Revert',
        danger: true,
      });
    }
    if (!confirmed) return;

    // Save current state as a snapshot before reverting
    try {
      const currentBlocks = this.blocks.map(b => b.serialize());
      await Storage.saveSnapshot(this.noteId, currentBlocks, this.noteData.name || 'Untitled');
    } catch (e) {
      console.warn('Failed to save pre-revert snapshot:', e);
    }

    // Delete existing blocks for this note
    const existingElements = await Storage.getElementsByNote(this.noteId);
    const ids = existingElements.map(el => el.id);
    if (ids.length > 0) {
      await Storage.deleteElements(ids);
    }

    // Restore blocks from snapshot
    this.blocks = [];
    for (let i = 0; i < snap.blocks.length; i++) {
      const data = snap.blocks[i];
      const block = Block.deserialize(data);
      this.blocks.push(block);

      const saveData = block.serialize();
      saveData.canvasId = this.noteId;
      saveData.order = i;
      await Storage.saveElement(saveData);
    }

    // Update note title if snapshot had one
    if (snap.title && this.noteData) {
      this.noteData.name = snap.title;
      this.titleEl.textContent = snap.title;
      await Storage.updateNote(this.noteData);
    }

    this.renderBlocks();
    this._snapshotDirty = false;

    // Close version history panel
    const panel = this.doc.getElementById('version-history-panel');
    if (panel) panel.remove();
    this._versionHistoryOpen = false;

    // Close preview modal if open
    const previewModal = this.doc.getElementById('snapshot-preview-modal');
    if (previewModal) previewModal.remove();

    Utils.showToast('Reverted to snapshot', 'success');
  }
}

window.BlockEditor = BlockEditor;
