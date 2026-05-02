/**
 * Block Editor - handles all editor interactions
 */

class BlockEditor {
  constructor() {
    this.noteId = null;
    this.noteData = null;
    this.blocks = [];
    this.container = document.getElementById('blocks-container');
    this.titleEl = document.getElementById('page-title');
    this.slashMenu = document.getElementById('slash-menu');
    this.slashMenuItems = this.slashMenu.querySelector('.slash-menu-items');
    this.activeBlock = null;
    this.slashMenuVisible = false;
    this.slashMenuIndex = 0;
    this.slashFilter = '';
    this.saveTimeout = null;
    this.isDragging = false;
    this.draggedBlock = null;
    this.isAutoTitleUpdate = false; // Flag to track programmatic title updates
    this.hasReceivedFirstContent = false; // Track if note has received content
    this.pendingAutoTitle = false; // Prevent duplicate auto-title calls
    this.insightsPollingId = null; // Polling interval for insights extraction completion

    this.setupEventListeners();
    this.buildSlashMenu();
  }

  /**
   * Setup all event listeners
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

    // Drag and drop
    this.container.addEventListener('dragstart', (e) => this.onDragStart(e));
    this.container.addEventListener('dragend', (e) => this.onDragEnd(e));
    this.container.addEventListener('dragover', (e) => this.onDragOver(e));
    this.container.addEventListener('drop', (e) => this.onDrop(e));

    // Add block hint
    document.getElementById('add-block-hint').addEventListener('click', () => {
      this.addBlockAtEnd();
    });

    // Slash menu
    this.slashMenu.addEventListener('click', (e) => this.onSlashMenuClick(e));

    // Close slash menu on outside click
    document.addEventListener('click', (e) => {
      if (!this.slashMenu.contains(e.target) && this.slashMenuVisible) {
        this.hideSlashMenu();
      }
    });

    // Image input
    document.getElementById('image-input').addEventListener('change', (e) => {
      this.handleImageUpload(e);
    });

    // File input
    document.getElementById('file-input').addEventListener('change', (e) => {
      this.handleFileUpload(e);
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => this.onGlobalKeyDown(e));

    // Window resize - update wide content centering
    window.addEventListener('resize', Utils.debounce(() => {
      this.updateWideContentCentering();
    }, 100));
  }

  /**
   * Load a note
   */
  async loadNote(noteId) {
    // Clear any existing insights polling
    if (this.insightsPollingId) {
      clearInterval(this.insightsPollingId);
      this.insightsPollingId = null;
    }

    this.noteId = noteId;
    this.noteData = await Storage.getNote(noteId);

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

    // If no blocks, create initial empty block and focus it
    if (this.blocks.length === 0) {
      const block = this.createBlock('text');
      this.blocks.push(block);
      this.renderBlocks();
    }

    // Scroll to top of editor
    const editorContainer = document.getElementById('editor-container');
    
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
    const existingInsights = document.getElementById('note-insights');
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
    const insightsEl = document.createElement('div');
    insightsEl.id = 'note-insights';
    insightsEl.className = 'note-insights';

    // Header
    const header = document.createElement('div');
    header.className = 'note-insights-header';
    
    const titleContainer = document.createElement('div');
    titleContainer.className = 'note-insights-title';
    titleContainer.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path>
      </svg>
      <span>AI Insights</span>
    `;
    
    const meta = document.createElement('div');
    meta.className = 'note-insights-meta';
    if (insights.extractedAt) {
      meta.textContent = `Updated ${this.formatRelativeTime(insights.extractedAt)}`;
    }
    
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'note-insights-refresh';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', () => this.refreshInsights());
    
    header.appendChild(titleContainer);
    header.appendChild(meta);
    header.appendChild(refreshBtn);
    insightsEl.appendChild(header);

    // Tags section (displayed at top as pills)
    if (insights.tags && insights.tags.length > 0) {
      const tagsContainer = document.createElement('div');
      tagsContainer.className = 'note-insights-tags';
      
      insights.tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'note-insights-tag';
        tagEl.textContent = tag;
        tagsContainer.appendChild(tagEl);
      });
      
      insightsEl.appendChild(tagsContainer);
    }

    // Content container
    const content = document.createElement('div');
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
    const timestamp = document.getElementById('page-timestamp');
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
    const section = document.createElement('div');
    section.className = 'note-insights-section';

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'note-insights-section-title';
    sectionTitle.textContent = title;
    section.appendChild(sectionTitle);

    const list = document.createElement('ul');
    list.className = `note-insights-list ${type}`;

    items.forEach(item => {
      const li = document.createElement('li');
      
      if (type === 'deadlines' && typeof item === 'object') {
        const textSpan = document.createElement('span');
        textSpan.textContent = item.text;
        li.appendChild(textSpan);
        
        if (item.date) {
          const dateInfo = this.getRelativeDateInfo(item.date);
          const dateSpan = document.createElement('span');
          dateSpan.className = 'deadline-date';
          if (dateInfo.urgency) {
            dateSpan.classList.add(dateInfo.urgency);
          }
          
          // Show relative date with actual date in parentheses
          if (dateInfo.relative !== dateInfo.formatted) {
            dateSpan.innerHTML = `${dateInfo.relative} <span class="deadline-actual-date">(${dateInfo.formatted})</span>`;
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
   * Refresh insights for current note
   */
  async refreshInsights() {
    if (!this.noteId || !window.LLM || !window.LLM.isConfigured()) {
      Utils.showToast('AI not configured', 'error');
      return;
    }

    const refreshBtn = document.querySelector('.note-insights-refresh');
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

      const insights = await window.LLM.extractInsights(content, this.noteData.name);
      
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
    const div = document.createElement('div');
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

    this.updateAddBlockHint();
    
    // Update wide content centering after render
    requestAnimationFrame(() => this.updateWideContentCentering());
    
    // Also update centering when images finish loading (they may not have dimensions yet)
    this.setupImageLoadHandlers();
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
    const editor = document.getElementById('editor');
    if (!editor) return;

    const editorWidth = editor.offsetWidth;
    const wideBlockTypes = ['table', 'image', 'video'];

    console.log('[Wide Content Centering] Editor width:', editorWidth);

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

        console.log(`[Wide Content Centering] ${type} - Content width:`, contentWidth, 'Editor width:', editorWidth);

        if (contentWidth > editorWidth) {
          // Content is wider than editor - center it
          const overflow = contentWidth - editorWidth;
          const negativeMargin = -(overflow / 2);
          console.log(`[Wide Content Centering] ${type} - Overflow:`, overflow, 'Negative margin:', negativeMargin);
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
   * Create a new block
   */
  createBlock(type, content = '') {
    return new Block({
      type,
      content,
    });
  }

  /**
   * Add block at end
   */
  addBlockAtEnd() {
    const block = this.createBlock('text');
    this.blocks.push(block);
    const el = block.createElement();
    this.container.appendChild(el);
    this.focusBlock(block.id);
    this.scheduleSave();
    this.updateAddBlockHint();
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
  insertBlockAfter(afterId, type = 'text', content = '') {
    const index = this.blocks.findIndex((b) => b.id === afterId);
    const block = this.createBlock(type, content);

    if (index === -1) {
      this.blocks.push(block);
    } else {
      this.blocks.splice(index + 1, 0, block);
    }

    // Re-render and focus
    this.renderBlocks();
    this.focusBlock(block.id);
    this.scheduleSave();

    return block;
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
      this.blocks[0].content = '';
      this.blocks[0].type = 'text';
      this.renderBlocks();
      this.focusBlock(this.blocks[0].id);
      return;
    }

    this.blocks.splice(index, 1);
    Storage.deleteElement(blockId);

    // Focus previous or next block
    const focusIndex = Math.max(0, index - 1);
    this.renderBlocks();
    this.focusBlock(this.blocks[focusIndex].id, true);
    this.scheduleSave();
  }

  /**
   * Change block type
   */
  changeBlockType(blockId, newType) {
    const block = this.getBlockById(blockId);
    if (!block) return;

    block.type = newType;

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
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Place caret at start of element
   */
  placeCaretAtStart(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Update add block hint visibility
   */
  updateAddBlockHint() {
    const hint = document.getElementById('add-block-hint');
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
      
      // Notify app to update tab name
      if (window.app && window.app.updateCurrentTabName) {
        window.app.updateCurrentTabName(this.noteData.name);
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
      this.titleEl.textContent = title;
      this.isAutoTitleUpdate = false;
      this.scheduleSave();
      
      // Notify app to update tab name
      if (window.app && window.app.updateCurrentTabName) {
        window.app.updateCurrentTabName(title);
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
  onBlockInput(e) {
    const blockEl = e.target.closest('.block');
    if (!blockEl) return;

    const block = this.getBlockById(blockEl.dataset.id);
    if (!block) return;

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

    // Check for markdown shortcuts
    this.checkMarkdownShortcuts(block, content);

    // Check for first content and trigger auto-title if applicable
    this.checkFirstContentAutoTitle();

    this.scheduleSave();
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

    if (!window.LLM || !window.LLM.isConfigured()) {
      return;
    }

    // Check if title was manually set
    if (this.noteData?.titleManuallySet) {
      return;
    }

    // Prevent duplicate calls
    this.pendingAutoTitle = true;

    try {
      console.log('First content detected, generating auto-title for note:', this.noteId);
      const newTitle = await window.LLM.generateTitle(currentContent);

      if (newTitle && newTitle.trim()) {
        this.setTitleProgrammatically(newTitle);
        console.log(`Auto-title generated on first content: "${newTitle}"`);
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
   * Check for markdown shortcuts
   */
  checkMarkdownShortcuts(block, contentEl) {
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

    // Enter - create new block
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();

      // Get content after cursor
      const sel = window.getSelection();
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
      this.insertBlockAfter(block.id, newType, afterText);
      this.scheduleSave();
      return;
    }

    // Backspace at start - merge with previous or change type
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
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
      const sel = window.getSelection();
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

    // Tab - indent (for lists)
    if (e.key === 'Tab') {
      if (block.type === 'bullet' || block.type === 'numbered' || block.type === 'todo') {
        e.preventDefault();
        // TODO: Implement indentation
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
      if (!this.container.contains(document.activeElement)) {
        this.activeBlock = null;
      }
    }, 100);
  }

  /**
   * Handle block click
   */
  onBlockClick(e) {
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
   * Re-render a single block
   */
  rerenderBlock(block) {
    const oldEl = this.getBlockElement(block.id);
    if (oldEl) {
      const newEl = block.createElement();
      oldEl.replaceWith(newEl);
      
      // Update wide content centering if this is a wide block type
      if (['table', 'image', 'video'].includes(block.type)) {
        requestAnimationFrame(() => this.updateWideContentCentering());
      }
    }
  }

  /**
   * Handle global keydown
   */
  onGlobalKeyDown(e) {
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
    this.slashMenuItems.innerHTML = '';

    const types = [
      'text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle',
      'quote', 'code', 'divider', 'callout', 'image', 'table', 'bookmark',
      'video', 'file', 'equation'
    ];

    types.forEach((type, index) => {
      const info = BlockTypes[type];
      const item = document.createElement('div');
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
    const sel = window.getSelection();
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
    const sel = window.getSelection();
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
    const range = document.createRange();
    const sel = window.getSelection();

    let currentPos = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);

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
    const div = document.createElement('div');
    div.appendChild(fragment.cloneNode(true));
    return div.innerHTML;
  }

  // ============ Saving ============

  /**
   * Schedule save with debounce
   */
  scheduleSave() {
    this.updateSaveStatus('Saving...');

    clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.save(), 500);
  }

  /**
   * Save note and blocks
   */
  async save() {
    try {
      // Save note
      if (this.noteData) {
        await Storage.updateNote(this.noteData);
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
    } catch (error) {
      console.error('Failed to save:', error);
      this.updateSaveStatus('Error saving');
    }
  }

  /**
   * Update save status display
   */
  updateSaveStatus(status) {
    const el = document.getElementById('save-status');
    if (el) {
      el.textContent = status;
    }
  }

  /**
   * Update timestamp display below title
   */
  updateTimestampDisplay() {
    const timestampEl = document.getElementById('page-timestamp');
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
}

// Make available globally
window.BlockEditor = BlockEditor;
