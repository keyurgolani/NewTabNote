/**
 * TabController — manages tab bar UI: open tabs, tab switching, creation,
 * closing, split-view, and Picture-in-Picture.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 */
class TabController {
  constructor({ storage, eventBus, domRefs, logger }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.domRefs = domRefs;
    this.logger = logger;

    // Tab state
    this.openTabs = []; // Array of { noteId, name }
    this.activeTabIndex = 0;

    // Split-view state
    this.splitViewEnabled = false;
    this.activeEditorSide = 'left'; // 'left' or 'right'

    // PiP state
    this.pipWindow = null;
    this.pipEditor = null;

    // Editor references (set by App after construction)
    this.editor = null;
    this.secondaryEditor = null;

    // App-level callbacks (set by App after construction)
    this.onCreateNote = null;       // () => Promise<Note>
    this.onRefreshNotesList = null;  // () => Promise<void>
    this.onRenderNotesList = null;   // () => Promise<void>
    this.onGetNotes = null;          // () => Note[]
  }

  /** Initialize tabs: wire DOM listeners. */
  async init() {
    this._bindTabListeners();
    this._bindSplitViewListeners();
    this._bindPiPListener();
    this._bindPaneFocusListeners();
  }

  /** Tear down PiP window if open. */
  destroy() {
    if (this.pipWindow) {
      this.pipWindow.close();
      this.pipWindow = null;
      this.pipEditor = null;
    }
  }

  // ─── Private: bind listeners ───

  _bindTabListeners() {
    const newTabBtn = document.getElementById('new-tab-btn');
    if (newTabBtn) {
      newTabBtn.addEventListener('click', async () => {
        await this.openNewTab();
      });
    }

    // Middle-click on tab bar to open new tab
    const tabsContainer = document.getElementById('note-tabs');
    if (tabsContainer) {
      tabsContainer.addEventListener('auxclick', async (e) => {
        if (e.button === 1 && e.target === tabsContainer) {
          e.preventDefault();
          await this.openNewTab();
        }
      });
    }
  }

  _bindSplitViewListeners() {
    const splitViewToggle = document.getElementById('split-view-toggle');
    if (splitViewToggle) {
      splitViewToggle.addEventListener('click', () => this.toggleSplitView());
    }
  }

  _bindPiPListener() {
    const pipToggle = document.getElementById('pip-toggle');
    if (pipToggle) {
      if ('documentPictureInPicture' in window) {
        pipToggle.addEventListener('click', () => {
          const editor = this.getEditor();
          if (editor && editor.noteId) {
            this.openNoteInPiP(editor.noteId);
          }
        });
      } else {
        pipToggle.classList.add('hidden');
      }
    }
  }

  _bindPaneFocusListeners() {
    const editorContainer = document.getElementById('editor-container');
    const secondaryContainer = document.getElementById('secondary-editor-container');

    if (editorContainer) {
      editorContainer.addEventListener('click', () => {
        this.setActiveEditorSide('left');
      }, true);
    }
    if (secondaryContainer) {
      secondaryContainer.addEventListener('click', () => {
        this.setActiveEditorSide('right');
      }, true);
    }
  }

  // ─── Editor access ───

  /**
   * Get the editor instance for a side.
   * @param {string|null} [side=null] - 'left' or 'right'; defaults to active side
   * @returns {BlockEditor|null}
   */
  getEditor(side = null) {
    const targetSide = side || this.activeEditorSide;
    return targetSide === 'left' ? this.editor : this.secondaryEditor;
  }

  // ─── Tab CRUD ───

  /**
   * Load saved tabs from storage or create initial tab.
   */
  async loadSavedTabs() {
    const storage = this.storage;
    const savedTabs = await storage.getSetting('openTabs', null);
    const savedActiveIndex = await storage.getSetting('activeTabIndex', 0);
    this.splitViewEnabled = await storage.getSetting('splitViewEnabled', false);
    const secondaryNoteId = await storage.getSetting('secondaryNoteId', null);

    if (savedTabs && savedTabs.length > 0) {
      // Validate that saved tabs still exist
      const validTabs = [];
      for (const tab of savedTabs) {
        const note = await storage.getNote(tab.noteId);
        if (note) {
          validTabs.push({ noteId: note.id, name: note.name || 'Untitled' });
        }
      }

      if (validTabs.length > 0) {
        this.openTabs = validTabs;
        this.activeTabIndex = Math.min(savedActiveIndex, validTabs.length - 1);
        await this.switchToTab(this.activeTabIndex);

        if (this.splitViewEnabled) {
          // Force toggle to enable UI
          this.splitViewEnabled = false;
          await this.toggleSplitView();
          if (secondaryNoteId) {
            await this.secondaryEditor.loadNote(secondaryNoteId);
          }
        }

        this.renderTabs();
        return;
      }
    }

    // No saved tabs or all invalid - create initial tab with first note
    const notes = this.onGetNotes ? this.onGetNotes() : [];
    if (notes.length > 0) {
      this.openTabs = [{ noteId: notes[0].id, name: notes[0].name || 'Untitled' }];
      this.activeTabIndex = 0;
      await this.editor.loadNote(notes[0].id);
    }

    if (this.splitViewEnabled) {
      this.splitViewEnabled = false;
      await this.toggleSplitView();
      if (secondaryNoteId) {
        await this.secondaryEditor.loadNote(secondaryNoteId);
      }
    }

    this.renderTabs();
  }

  /**
   * Save tabs to storage.
   */
  async saveTabs() {
    const storage = this.storage;
    await storage.setSetting('openTabs', this.openTabs);
    await storage.setSetting('activeTabIndex', this.activeTabIndex);
    await storage.setSetting('splitViewEnabled', this.splitViewEnabled);
    if (this.secondaryEditor && this.secondaryEditor.noteId) {
      await storage.setSetting('secondaryNoteId', this.secondaryEditor.noteId);
    }
  }

  /**
   * Cache last-opened note ID in chrome.storage.local for fast startup.
   * @param {string} noteId
   */
  cacheLastOpenedNoteId(noteId) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ lastOpenedNoteId: noteId });
    }
  }

  /**
   * Get cached last-opened note ID from chrome.storage.local.
   * @returns {Promise<string|null>}
   */
  static getCachedLastOpenedNoteId() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('lastOpenedNoteId', (result) => {
          resolve(result.lastOpenedNoteId || null);
        });
      } else {
        resolve(null);
      }
    });
  }

  /**
   * Render tabs in the header.
   */
  renderTabs() {
    const container = document.getElementById('note-tabs');
    if (!container) return;

    container.innerHTML = '';

    this.openTabs.forEach((tab, index) => {
      const tabEl = document.createElement('button');
      tabEl.className = 'note-tab';
      if (index === this.activeTabIndex) {
        tabEl.classList.add('active');
      }
      tabEl.dataset.index = index;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'note-tab-name';
      nameSpan.textContent = tab.name || 'Untitled';
      tabEl.appendChild(nameSpan);

      // Close button (only show if more than one tab)
      if (this.openTabs.length > 1) {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'note-tab-close';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>`;
        closeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.closeTab(index);
        });
        tabEl.appendChild(closeBtn);
      }

      // Click to switch tab
      tabEl.addEventListener('click', async () => {
        await this.switchToTab(index);
      });

      // Middle-click to close tab
      tabEl.addEventListener('auxclick', async (e) => {
        if (e.button === 1) {
          e.preventDefault();
          await this.closeTab(index);
        }
      });

      container.appendChild(tabEl);
    });
  }

  /**
   * Switch to a specific tab.
   */
  async switchToTab(index) {
    if (index < 0 || index >= this.openTabs.length) return;

    this.activeTabIndex = index;
    const tab = this.openTabs[index];

    await this.getEditor().loadNote(tab.noteId);
    this.renderTabs();
    if (this.onRenderNotesList) await this.onRenderNotesList();
    await this.saveTabs();

    // Cache last-opened note ID for fast startup (Req 27.2)
    this.cacheLastOpenedNoteId(tab.noteId);
  }

  /**
   * Open a note in a new tab (or focus existing).
   */
  async openNoteInNewTab(noteId) {
    const note = await this.storage.getNote(noteId);
    if (!note) return;

    // Check if already open
    const existingIndex = this.openTabs.findIndex(t => t.noteId === noteId);
    if (existingIndex !== -1) {
      await this.switchToTab(existingIndex);
      return;
    }

    // Add new tab
    this.openTabs.push({ noteId: note.id, name: note.name || 'Untitled' });
    this.activeTabIndex = this.openTabs.length - 1;

    await this.getEditor().loadNote(noteId);
    this.renderTabs();
    if (this.onRenderNotesList) await this.onRenderNotesList();
    await this.saveTabs();

    // Cache last-opened note ID for fast startup (Req 27.2)
    this.cacheLastOpenedNoteId(noteId);
  }

  /**
   * Open a new tab with a new note.
   */
  async openNewTab() {
    if (this.onCreateNote) {
      const note = await this.onCreateNote();
      if (note) {
        if (this.onRefreshNotesList) await this.onRefreshNotesList();
        await this.openNoteInNewTab(note.id);
        document.getElementById('page-title').focus();
      }
    }
  }

  /**
   * Cycle through open tabs.
   * @param {number} direction - 1 for next, -1 for previous
   */
  async cycleTab(direction) {
    if (this.openTabs.length <= 1) return;
    let nextIndex = this.activeTabIndex + direction;
    if (nextIndex >= this.openTabs.length) nextIndex = 0;
    if (nextIndex < 0) nextIndex = this.openTabs.length - 1;
    await this.switchToTab(nextIndex);
  }

  /**
   * Close the currently active tab.
   */
  async closeCurrentTab() {
    await this.closeTab(this.activeTabIndex);
  }

  /**
   * Close a tab by index.
   */
  async closeTab(index) {
    if (this.openTabs.length <= 1) return; // Don't close last tab

    this.openTabs.splice(index, 1);

    // Adjust active index if needed
    if (this.activeTabIndex >= this.openTabs.length) {
      this.activeTabIndex = this.openTabs.length - 1;
    } else if (this.activeTabIndex > index) {
      this.activeTabIndex--;
    } else if (this.activeTabIndex === index) {
      // Stay at same index (which now points to next tab) or go to previous
      this.activeTabIndex = Math.min(index, this.openTabs.length - 1);
    }

    await this.switchToTab(this.activeTabIndex);
  }

  /**
   * Close tab for a specific note if open.
   */
  closeTabForNote(noteId) {
    const tabIndex = this.openTabs.findIndex(t => t.noteId === noteId);
    if (tabIndex !== -1) {
      this.closeTab(tabIndex);
    }
  }

  /**
   * Update tab name when note title changes.
   */
  updateCurrentTabName(name) {
    if (this.openTabs[this.activeTabIndex]) {
      this.openTabs[this.activeTabIndex].name = name || 'Untitled';
      this.renderTabs();
      this.saveTabs();
    }
  }

  /**
   * Open note in current tab or new tab based on modifier key.
   */
  async openNoteWithModifier(noteId, event) {
    if (event && (event.ctrlKey || event.metaKey)) {
      // Ctrl/Cmd+click opens in new tab
      await this.openNoteInNewTab(noteId);
    } else {
      // Regular click opens in current tab
      const note = await this.storage.getNote(noteId);
      if (!note) return;

      this.openTabs[this.activeTabIndex] = { noteId: note.id, name: note.name || 'Untitled' };
      await this.getEditor().loadNote(noteId);
      this.renderTabs();
      if (this.onRenderNotesList) await this.onRenderNotesList();
      await this.saveTabs();
    }
  }

  // ─── Split view ───

  /**
   * Toggle between single and split view.
   */
  async toggleSplitView() {
    this.splitViewEnabled = !this.splitViewEnabled;
    const workspace = document.getElementById('workspace-container');
    const secondaryPane = document.getElementById('secondary-editor-container');
    const splitBtn = document.getElementById('split-view-toggle');

    if (this.splitViewEnabled) {
      workspace.classList.add('split-mode');
      secondaryPane.classList.remove('hidden');
      splitBtn.classList.add('active');

      // If secondary editor has no note, load a blank one or last open
      if (!this.secondaryEditor.noteId) {
        const notes = this.onGetNotes ? this.onGetNotes() : [];
        const otherNote = notes.find(n => n.id !== this.editor.noteId);
        if (otherNote) {
          await this.secondaryEditor.loadNote(otherNote.id);
        }
      }
    } else {
      workspace.classList.remove('split-mode');
      secondaryPane.classList.add('hidden');
      splitBtn.classList.remove('active');
      this.setActiveEditorSide('left');
    }

    // Resize observers/centering update
    if (this.editor) this.editor.updateWideContentCentering();
    if (this.secondaryEditor) this.secondaryEditor.updateWideContentCentering();
  }

  /**
   * Set the active editor side.
   */
  setActiveEditorSide(side) {
    if (this.activeEditorSide === side) return;

    this.activeEditorSide = side;

    const leftPane = document.getElementById('editor-container');
    const rightPane = document.getElementById('secondary-editor-container');

    if (side === 'left') {
      leftPane.classList.add('active');
      rightPane.classList.remove('active');
    } else {
      rightPane.classList.add('active');
      leftPane.classList.remove('active');
    }
  }

  // ─── Picture-in-Picture ───

  /**
   * Open a note in a Document Picture-in-Picture window.
   */
  async openNoteInPiP(noteId) {
    if (!('documentPictureInPicture' in window)) {
      console.error('Document Picture-in-Picture API not supported');
      return;
    }

    // Close existing PiP if any
    if (this.pipWindow) {
      this.pipWindow.close();
    }

    try {
      // Request a PiP window
      this.pipWindow = await documentPictureInPicture.requestWindow({
        width: 500,
        height: 600,
      });

      // Copy stylesheets to the PiP window
      [...document.styleSheets].forEach((styleSheet) => {
        try {
          if (styleSheet.href) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = styleSheet.href;
            this.pipWindow.document.head.appendChild(link);
          } else {
            const style = document.createElement('style');
            for (const rule of styleSheet.cssRules) {
              style.appendChild(document.createTextNode(rule.cssText));
            }
            this.pipWindow.document.head.appendChild(style);
          }
        } catch (e) {
          console.error('Could not copy stylesheet to PiP window:', e);
        }
      });

      // Add common styles
      const customStyle = document.createElement('style');
      customStyle.textContent = `
        body { margin: 0; padding: 0; background: var(--bg-primary); color: var(--text-primary); }
        .pip-editor-wrapper { height: 100vh; overflow-y: auto; padding: 20px; }
        /* Hide UI elements that don't make sense in PiP */
        .slash-menu { z-index: 2000; }
      `;
      this.pipWindow.document.head.appendChild(customStyle);

      // Create editor structure
      const wrapper = document.createElement('div');
      wrapper.className = 'pip-editor-wrapper editor-pane active';
      wrapper.id = 'pip-editor-container';
      wrapper.innerHTML = `
        <div class="editor">
          <div class="page-title" contenteditable="true" data-placeholder="Untitled" spellcheck="false"></div>
          <div class="page-timestamp"></div>
          <div class="blocks-container"></div>
          <div class="add-block-hint">
            <span>Press Enter to add a new block, or type / for commands</span>
          </div>
          
          <div class="backlinks-panel hidden">
            <div class="backlinks-header"><span>Backlinks</span></div>
            <div class="backlinks-list"></div>
          </div>

          <div class="slash-menu hidden">
            <div class="slash-menu-header">Basic blocks</div>
            <div class="slash-menu-items"></div>
          </div>

          <div class="wiki-menu slash-menu hidden">
            <div class="slash-menu-header">Link to note</div>
            <div class="slash-menu-items"></div>
          </div>

          <div class="template-menu slash-menu hidden">
            <div class="slash-menu-header">Insert template</div>
            <div class="slash-menu-items"></div>
          </div>
        </div>
      `;
      this.pipWindow.document.body.appendChild(wrapper);

      // Copy theme properties from main document
      this.pipWindow.document.documentElement.style.cssText = document.documentElement.style.cssText;
      this.pipWindow.document.documentElement.className = document.documentElement.className;

      // Initialize editor in PiP window
      this.pipEditor = new BlockEditor({
        root: wrapper
      });

      await this.pipEditor.loadNote(noteId);

      // Handle PiP window closing
      this.pipWindow.addEventListener('pagehide', () => {
        this.pipWindow = null;
        this.pipEditor = null;
      });

    } catch (e) {
      console.error('Failed to open PiP window:', e);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TabController };
} else if (typeof window !== 'undefined') {
  window.TabController = TabController;
}
