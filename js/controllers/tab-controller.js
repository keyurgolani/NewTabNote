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
    this.onUpdateEmptyState = null;  // () => void

    /** @type {BroadcastChannel|null} Tells the other new tabs which notes left the active set */
    this.channel = null;
    /** @type {Promise<void>} forgetNotes calls run one at a time, in order */
    this._forgetQueue = Promise.resolve();
  }

  /** Initialize tabs: wire DOM listeners. */
  async init() {
    this._bindTabListeners();
    this._bindSplitViewListeners();
    this._bindPiPListener();
    this._bindPaneFocusListeners();
    this._openNotesChannel();
  }

  /** Tear down PiP window if open. */
  destroy() {
    if (this.pipWindow) {
      this.pipWindow.close();
      this.pipWindow = null;
      this.pipEditor = null;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
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

  /**
   * Every editor open in this tab: primary, secondary, and PiP.
   * @returns {Array<BlockEditor>}
   */
  getOpenEditors() {
    return [this.editor, this.secondaryEditor, this.pipEditor].filter(Boolean);
  }

  /**
   * Write what every open editor has pending, as Export JSON and Create
   * Backup do before they read, so the file has the last edit.
   * @returns {Promise<void>}
   */
  async saveOpenEditors() {
    await Promise.all(this.getOpenEditors().map((editor) => editor.flushSave()));
  }

  /**
   * Before an import commits: hold saves in every open editor, then write what
   * each one has pending, so nothing written later carries pre-import flags.
   * @returns {Promise<void>}
   */
  async flushEditorsForImport() {
    const editors = this.getOpenEditors();
    editors.forEach((editor) => editor.holdSaves());
    await Promise.all(editors.map((editor) => editor.flushSave()));
  }

  /**
   * After an import (or a failed one, with no IDs): release the save hold, then
   * every pane on a note Replace all trashed moves to another note, and the
   * other new tabs do the same (forgetNotes), even when this one fails to. An
   * edit typed during the commit still lands in its note, which keeps its
   * stored trash flags.
   * @param {Array<string>} [trashedIds=[]]
   * @param {number|null} [trashedAt=null]
   * @returns {Promise<void>}
   */
  async reloadEditorsAfterImport(trashedIds = [], trashedAt = null) {
    const trashed = new Set(trashedIds);
    const flags = { trashed: true, trashedAt: trashedAt || Date.now(), archived: false, archivedAt: null };
    for (const editor of this.getOpenEditors()) {
      if (editor.noteId && trashed.has(editor.noteId)) editor.adoptNoteFlags(flags);
      editor.releaseSaves();
    }
    try {
      await this.forgetNotes(trashedIds);
    } finally {
      this.announceNotesLeft(trashedIds);
    }
  }

  /**
   * Notes left the active set (trash, archive, permanent delete, Replace all),
   * in this new tab or another. Their tabs go. A pane on one of them writes
   * what it has pending, then moves (_moveActivePane, _moveOtherPane); a pane
   * whose note stays never moves, and the two panes never show one note. PiP on
   * one of them closes. A pane whose note turned out deleted with edits it
   * couldn't save keeps them on screen, with the editor's "Save as a new note",
   * and keeps its tab. The tab bar keeps a tab for the note on screen, and tabs
   * are saved once, at the end. Calls run one at a time, in order.
   * @param {Array<string>} ids
   * @returns {Promise<void>}
   */
  forgetNotes(ids) {
    const run = () => this._forgetNotes(ids);
    const done = this._forgetQueue.then(run, run);
    this._forgetQueue = done.catch(() => {});
    return done;
  }

  /**
   * @param {Array<string>} ids
   * @returns {Promise<void>}
   */
  async _forgetNotes(ids) {
    const gone = new Set((ids || []).filter((id) => typeof id === 'string' && id !== ''));
    if (gone.size === 0) return;
    /** @param {BlockEditor|null} editor */
    const onGone = (editor) => Boolean(editor && editor.noteId && gone.has(editor.noteId));

    // Edits typed into a leaving note land in it, or show the pane that it's deleted.
    await Promise.all(this.getOpenEditors().filter(onGone).map((editor) => editor.flushSave()));
    /** @param {BlockEditor|null} editor */
    const stays = (editor) => onGone(editor) && editor.noteGone;
    /** @param {BlockEditor|null} editor */
    const moves = (editor) => onGone(editor) && !editor.noteGone;
    const staying = new Set(this.getOpenEditors().filter(stays).map((editor) => editor.noteId));

    if (this.pipWindow && moves(this.pipEditor)) this.pipWindow.close();

    const activeTab = this.openTabs[this.activeTabIndex];
    const kept = this.openTabs.map((tab) => !gone.has(tab.noteId) || staying.has(tab.noteId));
    this.activeTabIndex = TabController.keptActiveIndex(kept, this.activeTabIndex);
    this.openTabs = this.openTabs.filter((tab, index) => kept[index]);
    const activeTabLeft = Boolean(activeTab) && !this.openTabs.includes(activeTab);

    const notes = (await this.storage.getAllNotes()).filter((note) => !gone.has(note.id));
    const active = this.getEditor();
    const other = active === this.editor ? this.secondaryEditor : this.editor;
    if (moves(active)) {
      await this._moveActivePane(active, this.splitViewEnabled ? other : null, notes, { activeTabLeft, staying });
    }
    if (this.splitViewEnabled && !stays(other) && (moves(other) || !other.noteId || other.noteId === active.noteId)) {
      await this._moveOtherPane(other, notes);
    }

    const shown = this.getEditor();
    if (this.openTabs.length === 0 && shown && shown.noteId) {
      this.openTabs.push({ noteId: shown.noteId, name: (shown.noteData && shown.noteData.name) || 'Untitled' });
      this.activeTabIndex = 0;
    }
    this.renderTabs();
    await this.saveTabs();
    if (shown && shown.noteId) this.cacheLastOpenedNoteId(shown.noteId);
  }

  /**
   * The active pane's note left. It shows the active tab's note, unless the
   * other pane shows that one; else the first active note the other pane
   * doesn't show, in a new tab when its own tab went; else the other pane's
   * note, with split view closed; else a new note in a new tab. A load the
   * editor refuses, to keep unsaved edits of a deleted note on screen, ends it.
   * @param {BlockEditor} active
   * @param {BlockEditor|null} other - The other pane, while split view is on
   * @param {Array<Object>} notes - Active notes, newest first, without the ones that left
   * @param {{activeTabLeft: boolean, staying: Set<string>}} state - Whether the active tab went
   *   with the notes, and the deleted notes that panes keep on screen
   * @returns {Promise<void>}
   */
  async _moveActivePane(active, other, notes, { activeTabLeft, staying }) {
    const otherId = other ? other.noteId : null;
    const tab = this.openTabs[this.activeTabIndex];
    if (tab && tab.noteId !== otherId && !staying.has(tab.noteId)) {
      await active.loadNote(tab.noteId);
      if (active.noteId === tab.noteId || active.noteGone) return;
    }
    const next = notes.find((note) => note.id !== otherId);
    if (next) {
      await active.loadNote(next.id);
      if (active.noteId === next.id && (activeTabLeft || this.openTabs.length === 0)) this._pushTab(next);
      return;
    }
    if (other && otherId && notes.some((note) => note.id === otherId)) {
      // The other pane has the only active note left: it stays in view, and split view closes.
      if (active === this.editor) {
        await this.editor.loadNote(otherId);
        if (this.editor.noteId !== otherId) return;
      }
      this._setSplitView(false);
      return;
    }
    const created = this.onCreateNote ? await this.onCreateNote() : null;
    if (!created) return;
    await active.loadNote(created.id);
    if (active.noteId === created.id) this._pushTab(created);
  }

  /**
   * Make `note`'s tab the active one, opening one when there's none, without loading it.
   * @param {{id: string, name?: string}} note
   * @returns {void}
   */
  _pushTab(note) {
    const index = this.openTabs.findIndex((tab) => tab.noteId === note.id);
    if (index !== -1) {
      this.activeTabIndex = index;
      return;
    }
    this.openTabs.push({ noteId: note.id, name: note.name || 'Untitled' });
    this.activeTabIndex = this.openTabs.length - 1;
  }

  /**
   * The pane the tabs don't drive: an active note the active pane doesn't
   * show, else split view closes. A load the editor refuses, to keep unsaved
   * edits of a deleted note on screen, leaves the pane as it is.
   * @param {BlockEditor} other
   * @param {Array<Object>} notes - Active notes, newest first, without the ones that left
   * @returns {Promise<void>}
   */
  async _moveOtherPane(other, notes) {
    const shownId = (other === this.editor ? this.secondaryEditor : this.editor).noteId;
    const pick = notes.find((note) => note.id !== shownId);
    if (pick) {
      await other.loadNote(pick.id);
      if (other.noteId === pick.id || other.noteGone) return;
    }
    await this._closeSplit();
  }

  /**
   * Turn split view off with the active pane's note in the left pane, the one
   * that stays visible.
   * @returns {Promise<void>}
   */
  async _closeSplit() {
    const active = this.getEditor();
    if (active === this.secondaryEditor && active.noteId && this.editor.noteId !== active.noteId) {
      await active.flushSave();
      await this.editor.loadNote(active.noteId);
    }
    if (this.splitViewEnabled) this._setSplitView(false);
  }

  /**
   * Tell the other open new tabs which notes left the active set, so they run
   * forgetNotes too. A page doesn't get its own messages. #13 replaces this
   * with typed events.
   * @param {Array<string>} ids
   * @returns {void}
   */
  announceNotesLeft(ids) {
    if (!this.channel || !ids || ids.length === 0) return;
    try {
      this.channel.postMessage({ left: Array.from(ids) });
    } catch (error) {
      console.warn('Could not tell the other tabs which notes left:', error);
    }
  }

  /**
   * Listen for notes that left in another new tab.
   * @returns {void}
   */
  _openNotesChannel() {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel('ntn-notes');
    this.channel.onmessage = (event) => {
      const ids = event && event.data && event.data.left;
      if (Array.isArray(ids)) this._onNotesLeftElsewhere(ids);
    };
  }

  /**
   * @param {Array<string>} ids
   * @returns {Promise<void>}
   */
  async _onNotesLeftElsewhere(ids) {
    try {
      await this.forgetNotes(ids);
      if (this.onRefreshNotesList) await this.onRefreshNotesList();
      if (this.onUpdateEmptyState) this.onUpdateEmptyState();
    } catch (error) {
      console.error('Notes that left in another tab:', error);
    }
  }

  /**
   * An editor saved a deleted note's text as `note` ("Save as a new note"):
   * the tab that showed the old note shows the new one, or the active pane
   * gets a tab for it.
   * @param {BlockEditor} editor
   * @param {string} oldId
   * @param {{id: string, name?: string}} note
   * @returns {Promise<void>}
   */
  async noteReplaced(editor, oldId, note) {
    const tab = { noteId: note.id, name: note.name || 'Untitled' };
    const isActive = editor === this.getEditor();
    const index = this.openTabs.findIndex((t) => t.noteId === oldId);
    if (index !== -1) {
      this.openTabs[index] = tab;
      if (isActive) this.activeTabIndex = index;
    } else if (isActive) {
      this.openTabs.push(tab);
      this.activeTabIndex = this.openTabs.length - 1;
    }
    this.renderTabs();
    if (this.onRefreshNotesList) await this.onRefreshNotesList();
    await this.saveTabs();
    if (isActive) this.cacheLastOpenedNoteId(note.id);
  }

  /**
   * Where the active tab lands once some tabs are dropped: on the same tab when
   * it stays, otherwise on the next tab that stays, or the last one.
   * @param {Array<boolean>} kept - Whether each tab stays, in tab order
   * @param {number} activeIndex
   * @returns {number}
   */
  static keptActiveIndex(kept, activeIndex) {
    const keptBefore = kept.slice(0, Math.max(0, activeIndex)).filter(Boolean).length;
    return Math.max(0, Math.min(keptBefore, kept.filter(Boolean).length - 1));
  }

  /**
   * The note a saved tab or split pane may reopen at startup: one that still
   * exists outside trash. A note in trash opens only when the user picks it.
   * @param {*} noteId
   * @returns {Promise<Object|null>}
   */
  async _restorableNote(noteId) {
    if (typeof noteId !== 'string' || noteId === '') return null;
    const note = await this.storage.getNote(noteId);
    return note && !note.trashed ? note : null;
  }

  // ─── Tab CRUD ───

  /**
   * Load saved tabs from storage or create initial tab. Saved tabs and the
   * split note whose notes are gone or in trash aren't reopened, the split
   * note never repeats the left pane's, and the layout that opens is saved.
   */
  async loadSavedTabs() {
    const storage = this.storage;
    const savedTabs = await storage.getSetting('openTabs', null);
    const savedActiveIndex = await storage.getSetting('activeTabIndex', 0);
    const savedSplitView = await storage.getSetting('splitViewEnabled', false);
    const savedSecondaryId = await storage.getSetting('secondaryNoteId', null);
    this.splitViewEnabled = false;

    // Keep the saved tabs whose notes still exist outside trash
    const validTabs = [];
    const kept = [];
    for (const tab of Array.isArray(savedTabs) ? savedTabs : []) {
      const note = await this._restorableNote(tab && tab.noteId);
      kept.push(Boolean(note));
      if (note) {
        validTabs.push({ noteId: note.id, name: note.name || 'Untitled' });
      }
    }

    if (validTabs.length > 0) {
      this.openTabs = validTabs;
      this.activeTabIndex = TabController.keptActiveIndex(kept, savedActiveIndex);
      await this.switchToTab(this.activeTabIndex);
    } else {
      // No saved tabs or all invalid - create initial tab with first note
      const notes = this.onGetNotes ? this.onGetNotes() : [];
      if (notes.length > 0) {
        this.openTabs = [{ noteId: notes[0].id, name: notes[0].name || 'Untitled' }];
        this.activeTabIndex = 0;
        await this.editor.loadNote(notes[0].id);
      }
    }

    // Split view comes back only with a note for the right pane that the left doesn't show
    if (savedSplitView && this.editor.noteId && (await this._fillRightPane(savedSecondaryId))) {
      this._setSplitView(true);
    }

    this.renderTabs();
    await this.saveTabs();
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
    const api = TabController._chromeApi();
    if (api && api.storage && api.storage.local) {
      api.storage.local.set({ lastOpenedNoteId: noteId });
    }
  }

  /**
   * Get cached last-opened note ID from chrome.storage.local. A read that
   * fails resolves null.
   * @returns {Promise<string|null>}
   */
  static getCachedLastOpenedNoteId() {
    return new Promise((resolve) => {
      const api = TabController._chromeApi();
      if (!api || !api.storage || !api.storage.local) {
        resolve(null);
        return;
      }
      api.storage.local.get('lastOpenedNoteId', (result) => {
        if (api.runtime && api.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve((result && result.lastOpenedNoteId) || null);
      });
    });
  }

  /**
   * The chrome API, where there is one.
   * @returns {any}
   */
  static _chromeApi() {
    return /** @type {any} */ (globalThis).chrome;
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
    if (this.splitViewEnabled) {
      this._setSplitView(false);
      return;
    }
    // A right pane without a note would take typing and save none of it
    if (!(await this._fillRightPane())) {
      Utils.showToast('Split view needs a second note.', 'info');
      return;
    }
    this._setSplitView(true);
  }

  /**
   * Give the right pane a note the left pane doesn't show: `preferredId` when
   * it can reopen, else the right pane's own note when it still can, else the
   * first other active note.
   * @param {*} [preferredId=null]
   * @returns {Promise<boolean>} false when there's no such note
   */
  async _fillRightPane(preferredId = null) {
    const right = this.secondaryEditor;
    const leftId = this.editor.noteId;
    for (const id of [preferredId, right.noteId]) {
      if (!id || id === leftId || !(await this._restorableNote(id))) continue;
      if (right.noteId !== id) await right.loadNote(id);
      if (right.noteId === id) return true;
    }
    const other = (await this.storage.getAllNotes()).find((note) => note.id !== leftId);
    if (!other) return false;
    await right.loadNote(other.id);
    return right.noteId === other.id;
  }

  /**
   * Show or hide the right pane. Hiding it makes the left pane active.
   * @param {boolean} on
   * @returns {void}
   */
  _setSplitView(on) {
    this.splitViewEnabled = on;
    const workspace = document.getElementById('workspace-container');
    const secondaryPane = document.getElementById('secondary-editor-container');
    const splitBtn = document.getElementById('split-view-toggle');

    if (on) {
      workspace.classList.add('split-mode');
      secondaryPane.classList.remove('hidden');
      splitBtn.classList.add('active');
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
