/**
 * TabController — manages tab bar UI: open tabs, tab switching, creation,
 * closing, split-view, and Picture-in-Picture.
 *
 * @param {Object} deps
 * @param {Object} deps.settings - The page's settings port (js/kernel/composition/settings.js),
 *   which the workspace session is read and saved through
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 * @param {Object} deps.documentClient - The page's document client
 *   (js/kernel/composition/document.js), which the notes a tab or pane opens are read through
 * @param {((target: Document) => () => void)|null} [deps.registerExtraDocument] - The page
 *   loader's (js/runtime/lazy.js): the PiP window gets each stylesheet a chunk adds after it
 *   opens, since it copies the page's only then (#27 slice 3)
 */
class TabController {
  constructor({ settings, domRefs, logger, documentClient, registerExtraDocument = null }) {
    this.settings = settings;
    this.registerExtraDocument = registerExtraDocument;
    /** @type {any} The page's document client (js/kernel/composition/document.js): the notes it reads as stored, other tabs' included */
    this.documentClient = documentClient;
    /** @type {Promise<Object|null>|null} The session as stored, read once for a start (_savedSession) */
    this._startupSession = null;
    this.domRefs = domRefs;
    this.logger = logger;

    // Tab state
    this.openTabs = []; // Array of { noteId, name }
    this.activeTabIndex = 0;
    /**
     * What AI chat, NotesManager, and the palette see of the tabs, in place of App's copy of
     * them: the notes they show, in tab order, and a committed title naming its note's tab.
     * None of them holds the tab array, which TabController replaces when it restores tabs.
     */
    this.noteTabs = Object.freeze({
      openNoteIds: () => this.openTabs.map((tab) => tab.noteId),
      showNoteName: (noteId, name) => this.showNoteName(noteId, name),
    });

    // Split-view state
    this.splitViewEnabled = false;
    this.activeEditorSide = 'left'; // 'left' or 'right'

    // PiP state
    this.pipWindow = null;
    this.pipEditor = null;

    // Editor references (set by App after construction)
    this.editor = null;
    this.secondaryEditor = null;
    // What App gives every editor it makes, which the PiP editor gets too (set by App)
    this.editorPorts = {};

    // App-level callbacks (set by App after construction)
    this.onCreateNote = null;       // () => Promise<Note>
    this.onRenderNotesList = null;   // () => Promise<void>
    /** @type {any} The tab's note list (js/kernel/core/application/note-list.js), set by App */
    this.noteList = null;

    /** @type {BroadcastChannel|null} Tells the other new tabs which notes left the active set, so they refresh their lists */
    this.channel = null;
    /** @type {Promise<void>} forgetNotes calls run one at a time, in order */
    this._forgetQueue = Promise.resolve();
    /** @type {boolean} Whether another tab's message refreshes the lists yet (see workspaceReady) */
    this._refreshesLists = false;
    /** @type {boolean} A message came before that, so workspaceReady refreshes them */
    this._refreshPending = false;
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
   * Backup do before they read, so the file has the last edit. Answers whether
   * every editor holds nothing unstored (BlockEditor.flushSave), which a reload
   * through the page's loader waits on; a quiet flush leaves a failed retry's
   * toast to the caller.
   * @param {{quiet?: boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async saveOpenEditors(options) {
    const saved = await Promise.all(this.getOpenEditors().map((editor) => editor.flushSave(options)));
    return saved.every((answer) => answer === true);
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
   * every pane on a note Replace all trashed moves to another note
   * (forgetNotes), and the other new tabs refresh their lists, even when this
   * one fails to move. An edit typed during the commit still lands in its
   * note, which keeps its stored trash flags. The panes stay where forgetNotes
   * put them, and the active pane's note gets the active tab.
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
    if (trashed.size === 0) return;
    try {
      await this.forgetNotes(trashedIds);
      await this._tabForActivePane();
    } finally {
      this.announceNotesLeft(trashedIds);
    }
  }

  /**
   * After Merge: open a note it imported in the active pane, in a tab, unless
   * that pane keeps a deleted note's unsaved text on screen or the other pane
   * already shows the note.
   * @param {string} noteId
   * @returns {Promise<void>}
   */
  async openImportedNote(noteId) {
    const active = this.getEditor();
    if (!active || active.noteGone) return;
    const other = active === this.editor ? this.secondaryEditor : this.editor;
    if (this.splitViewEnabled && other && other.noteId === noteId) return;
    await this.openNoteInNewTab(noteId);
  }

  /**
   * Give the active pane's note the active tab, opening a tab for it when it
   * has none, and save the tabs when that changed them.
   * @returns {Promise<void>}
   */
  async _tabForActivePane() {
    const active = this.getEditor();
    if (!active || !active.noteId) return;
    const current = this.openTabs[this.activeTabIndex];
    if (current && current.noteId === active.noteId) return;
    this._pushTab({ id: active.noteId, name: active.noteData && active.noteData.name });
    this.renderTabs();
    await this.saveTabs({ lastOpenedNoteId: active.noteId });
  }

  /**
   * Notes left the active set (trash, archive, permanent delete, Empty trash,
   * trash retention, Replace all) in this new tab; another tab's change only
   * refreshes this one's lists (_onNotesLeftElsewhere). Their tabs go. A
   * pane on one of them writes what it has pending, then moves
   * (_moveActivePane, _moveOtherPane); a pane whose note stays never moves,
   * and the two panes never show one note. PiP on one of them closes. A pane
   * whose note turned out deleted with edits it couldn't save keeps them on
   * screen, with the editor's "Save as a new note", and keeps its tab. The tab
   * bar keeps a tab for the note on screen. Tabs are saved only when this tab
   * dropped a tab or moved a pane, so a tab that shows none of the notes leaves
   * the saved workspace alone. Calls run one at a time, in order.
   * @param {Array<string>} ids
   * @returns {Promise<void>}
   */
  forgetNotes(ids) {
    return this._inTurn(() => this._forgetNotes(ids));
  }

  /**
   * Notes are about to leave the active set (removeNotes, js/kernel/composition/removal.js),
   * before the write: as forgetNotes, except that a pane with no other active note to show
   * waits on its note, so a write that fails leaves no new note behind. Answers what the
   * rest of the sequence does: `restore` for notes that stayed (a write that didn't commit, a
   * bulk item that failed), which puts the panes, tabs, and split view back as they were,
   * unless something moved them since, and then `arrive` for the notes that left, which moves
   * the panes still on them, to a new note when there's no other. PiP closed for a leaving note
   * stays closed.
   * @param {Array<string>} ids
   * @returns {Promise<{arrive: (left: Array<string>) => Promise<void>, restore: (stayed: Array<string>) => Promise<void>}>}
   */
  async leaveNotes(ids) {
    /** @type {any} */
    let before = null;
    /** @type {any} */
    let after = null;
    await this._inTurn(async () => {
      before = this._viewState();
      await this._forgetNotes(ids, { create: false });
      after = this._viewState();
    });
    return {
      arrive: (left) => this._inTurn(() => this._forgetNotes(left)),
      restore: (stayed) => this._inTurn(() => this._restoreView(before, after, stayed)),
    };
  }

  /**
   * Run `step` once the forget and leave calls before it are done
   * @param {() => Promise<void>} step
   * @returns {Promise<void>}
   */
  _inTurn(step) {
    const done = this._forgetQueue.then(step, step);
    this._forgetQueue = done.catch(() => {});
    return done;
  }

  /**
   * What a leave changes: the tabs, the active tab, split view and its active side, the note
   * each pane shows, and PiP's
   * @returns {string}
   */
  _viewState() {
    return JSON.stringify({
      tabs: this.openTabs.map((tab) => ({ noteId: tab.noteId, name: tab.name })),
      active: this.activeTabIndex,
      split: this.splitViewEnabled,
      side: this.activeEditorSide,
      left: this.editor ? this.editor.noteId : null,
      right: this.secondaryEditor ? this.secondaryEditor.noteId : null,
      pip: this.pipEditor ? this.pipEditor.noteId : null,
    });
  }

  /**
   * Put the view back as it was before a leave, for notes that didn't leave after all (a write
   * that didn't commit, a bulk item that failed), when a tab or pane showed one of them and the
   * view is still as the leave left it: each pane loads its note again (writing what it holds
   * first), split view comes back with its side, and so do the tabs. The notes that did leave
   * arrive from there (leaveNotes' arrive).
   * @param {string|null} before - _viewState() before the leave
   * @param {string|null} after - and after it
   * @param {Array<string>} [stayed] - the notes that didn't leave; all of them when left out
   * @returns {Promise<void>}
   */
  async _restoreView(before, after, stayed) {
    if (!before || before === after || this._viewState() !== after) return;
    const was = JSON.parse(before);
    if (stayed) {
      const shown = new Set([...was.tabs.map((tab) => tab.noteId), was.left, was.right, was.pip]);
      if (!stayed.some((id) => shown.has(id))) return;
    }
    if (was.left && this.editor.noteId !== was.left) await this.editor.loadNote(was.left);
    if (was.split && was.right && this.secondaryEditor.noteId !== was.right) {
      if ((await this.secondaryEditor.loadNote(was.right)) && !this.splitViewEnabled) this._setSplitView(true);
    }
    if (this.splitViewEnabled) this.setActiveEditorSide(was.side);
    this.openTabs = was.tabs;
    this.activeTabIndex = was.active;
    this.renderTabs();
    // The sidebar marks the note the pane shows again, as a tab switch does
    if (this.onRenderNotesList) await this.onRenderNotesList();
    const shown = this.getEditor();
    await this.saveTabs({ lastOpenedNoteId: shown && shown.noteId });
  }

  /**
   * @param {Array<string>} ids
   * @param {{create?: boolean}} [options] - Whether a pane with no other active note gets a
   *   new one (it waits on its note otherwise)
   * @returns {Promise<void>}
   */
  async _forgetNotes(ids, { create = true } = {}) {
    const gone = new Set((ids || []).filter((id) => typeof id === 'string' && id !== ''));
    if (gone.size === 0) return;
    /** @param {BlockEditor|null} editor */
    const onGone = (editor) => Boolean(editor && editor.noteId && gone.has(editor.noteId));
    const shows = this.openTabs.some((tab) => gone.has(tab.noteId)) || this.getOpenEditors().some(onGone);
    if (!shows) return;

    // Edits typed into a leaving note land in it, or show the pane that it's deleted.
    await Promise.all(this.getOpenEditors().filter(onGone).map((editor) => editor.flushSave()));
    const notes = (await this.documentClient.activeNotes()).filter((note) => !gone.has(note.id));
    // Before the write, a pane with nowhere to go but a new note waits, and so does its tab
    if (!create && notes.length === 0) return;
    /** @param {BlockEditor|null} editor */
    const stays = (editor) => onGone(editor) && editor.noteGone;
    /** @param {BlockEditor|null} editor */
    const moves = (editor) => onGone(editor) && !editor.noteGone;
    const staying = new Set(this.getOpenEditors().filter(stays).map((editor) => editor.noteId));
    let changed = false;

    if (this.pipWindow && moves(this.pipEditor)) {
      this.pipWindow.close();
      changed = true;
    }

    const activeTab = this.openTabs[this.activeTabIndex];
    const kept = this.openTabs.map((tab) => !gone.has(tab.noteId) || staying.has(tab.noteId));
    if (kept.includes(false)) {
      this.activeTabIndex = TabController.keptActiveIndex(kept, this.activeTabIndex);
      this.openTabs = this.openTabs.filter((tab, index) => kept[index]);
      changed = true;
    }
    const activeTabLeft = Boolean(activeTab) && !this.openTabs.includes(activeTab);

    const active = this.getEditor();
    const other = active === this.editor ? this.secondaryEditor : this.editor;
    if (moves(active)) {
      await this._moveActivePane(active, this.splitViewEnabled ? other : null, notes, { activeTabLeft, staying, create });
      changed = true;
    }
    if (this.splitViewEnabled && !stays(other) && (moves(other) || !other.noteId || other.noteId === active.noteId)) {
      await this._moveOtherPane(other, notes, { create });
      changed = true;
    }
    // The hidden right pane lets go of a note that left, so turning split view on never brings it back
    const hidden = this.splitViewEnabled ? null : this.secondaryEditor;
    if (moves(hidden)) await hidden.unload();

    const shown = this.getEditor();
    if (this.openTabs.length === 0 && shown && shown.noteId) {
      this.openTabs.push({ noteId: shown.noteId, name: (shown.noteData && shown.noteData.name) || 'Untitled' });
      this.activeTabIndex = 0;
      changed = true;
    }
    if (!changed) return;
    this.renderTabs();
    // The sidebar marks the note now in view, as a tab switch does. The list may have drawn a
    // new note from its commit before the pane opened it
    if (this.onRenderNotesList) await this.onRenderNotesList();
    await this.saveTabs({ lastOpenedNoteId: shown && shown.noteId });
  }

  /**
   * The active pane's note left. It shows the active tab's note, unless the
   * other pane shows that one or it isn't active (another tab trashed,
   * archived, or deleted it; a deleted one's tab goes); else the first active
   * note the other pane doesn't show, in a new tab when its own tab went; else
   * the other pane's note, with split view closed; else a new note in a new
   * tab, or, with `create` false, it stays. A load the editor refuses, to keep
   * unsaved edits of a deleted note on screen, ends it.
   * @param {BlockEditor} active
   * @param {BlockEditor|null} other - The other pane, while split view is on
   * @param {Array<Object>} notes - Active notes, newest first, without the ones that left
   * @param {{activeTabLeft: boolean, staying: Set<string>, create?: boolean}} state - Whether the
   *   active tab went with the notes, the deleted notes that panes keep on screen, and whether
   *   a new note may be made
   * @returns {Promise<void>}
   */
  async _moveActivePane(active, other, notes, { activeTabLeft, staying, create = true }) {
    const otherId = other ? other.noteId : null;
    const tab = this.openTabs[this.activeTabIndex];
    let skipped = false;
    if (tab && tab.noteId !== otherId && !staying.has(tab.noteId)) {
      const record = await this.documentClient.readNote(tab.noteId);
      if (record && !record.trashed && !record.archived) {
        if ((await active.loadNote(tab.noteId)) || active.noteGone) return;
      } else {
        skipped = true;
        if (!record) {
          this.openTabs = this.openTabs.filter((open) => open !== tab);
          this.activeTabIndex = Math.min(this.activeTabIndex, Math.max(0, this.openTabs.length - 1));
        }
      }
    }
    const next = notes.find((note) => note.id !== otherId);
    if (next) {
      if ((await active.loadNote(next.id)) && (activeTabLeft || skipped || this.openTabs.length === 0)) this._pushTab(next);
      return;
    }
    if (other && otherId && notes.some((note) => note.id === otherId)) {
      // The other pane has the only active note left: it stays in view, and split view closes.
      await this._closeSplitKeeping(other);
      return;
    }
    const created = create && this.onCreateNote ? await this.onCreateNote() : null;
    if (!created) return;
    if (await active.loadNote(created.id)) this._pushTab(created);
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
   * show, else split view closes, else, when it stays for a deleted note's
   * text, a new note, unless `create` is false. A load the editor refuses, to
   * keep unsaved edits of a deleted note on screen, leaves the pane as it is.
   * @param {BlockEditor} other
   * @param {Array<Object>} notes - Active notes, newest first, without the ones that left
   * @param {{create?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async _moveOtherPane(other, notes, { create = true } = {}) {
    const shownId = (other === this.editor ? this.secondaryEditor : this.editor).noteId;
    const pick = notes.find((note) => note.id !== shownId);
    if (pick && ((await other.loadNote(pick.id)) || other.noteGone)) return;
    await this._closeSplitKeeping(this.getEditor());
    if (!this.splitViewEnabled) return;
    const created = create && this.onCreateNote ? await this.onCreateNote() : null;
    if (created) await other.loadNote(created.id);
  }

  /**
   * Turn split view off with `keep`'s note in view, in the left pane. The right
   * pane writes what it has pending before the left one reads that note, and
   * then shows no note, so no hidden copy of it is left to save over the left
   * pane's edits. Split view stays when either pane keeps a deleted note's
   * unsaved text on screen.
   * @param {BlockEditor} keep - The pane whose note stays in view
   * @returns {Promise<void>}
   */
  async _closeSplitKeeping(keep) {
    const left = this.editor;
    const right = this.secondaryEditor;
    await right.flushSave();
    if (right.noteGone) return;
    if (keep === right && right.noteId && left.noteId !== right.noteId) {
      if (!(await left.loadNote(right.noteId))) return;
    }
    if (this.splitViewEnabled) this._setSplitView(false);
    await right.unload();
  }

  /**
   * Tell the other open new tabs which notes left the active set, so they
   * refresh their lists. A page doesn't get its own messages. #13 replaces
   * this with typed events.
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
   * Listen for notes that left in another new tab (see _onNotesLeftElsewhere).
   * @returns {void}
   */
  _openNotesChannel() {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel('ntn-notes');
    this.channel.onmessage = (event) => {
      const ids = event && event.data && event.data.left;
      if (Array.isArray(ids)) this._onNotesLeftElsewhere();
    };
  }

  /**
   * This tab has its workspace (loadSavedTabs, or App's first note): from now
   * on another tab's message refreshes its lists. One that came while it
   * started, maybe after it read the lists, refreshes them once now.
   * @returns {void}
   */
  workspaceReady() {
    this._refreshesLists = true;
    if (!this._refreshPending) return;
    this._refreshPending = false;
    this._onNotesLeftElsewhere();
  }

  /**
   * Another new tab trashed, archived, or deleted notes. This one reads its
   * lists again, through the note list's reload, and the lists and counts
   * show what changed. Nothing else does: its panes, tabs, saved workspace,
   * and empty state stay as they are, as in 1.4.0. A pane on one of those
   * notes keeps it, its saves keep the note's trash and archive state, and one
   * on a note deleted for good shows the notice when it saves (#33). Keeping
   * the copies other tabs hold in step is #6's and #17's.
   * @returns {Promise<void>}
   */
  async _onNotesLeftElsewhere() {
    if (!this._refreshesLists) {
      this._refreshPending = true;
      return;
    }
    if (!this.noteList) return;
    try {
      await this.noteList.reload();
    } catch (error) {
      console.error('Refreshing the lists after another tab changed notes:', error);
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
    // The list has the new note from its commit; the sidebar marks it, as a tab switch does
    if (this.onRenderNotesList) await this.onRenderNotesList();
    await this.saveTabs({ lastOpenedNoteId: isActive ? note.id : null });
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
    const note = await this.documentClient.readNote(noteId);
    return note && !note.trashed ? note : null;
  }

  // ─── Tab CRUD ───

  /**
   * The workspace session as stored, read once for a start: the last-opened note App loads
   * first, and the tabs loadSavedTabs restores, come from one read. Null when the read failed
   * (the kernel query answered `failed`), which a start treats as nothing saved, as 1.4.x's
   * reads answered their defaults, except that it then writes nothing over what may be there.
   * @returns {Promise<Object|null>}
   */
  _savedSession() {
    if (!this._startupSession) {
      this._startupSession = this.settings.session().catch((error) => {
        console.warn('TabController: could not read the saved tabs', error && error.message);
        return null;
      });
    }
    return this._startupSession;
  }

  /**
   * The note the last new tab showed, for a fast start (Req 27.2), or null when there's none
   * or the read failed, so the start opens the first note.
   * @returns {Promise<string|null>}
   */
  async lastOpenedNoteId() {
    const saved = await this._savedSession();
    return (saved && saved.lastOpenedNoteId) || null;
  }

  /**
   * Load saved tabs from storage or create initial tab. Saved tabs and the
   * split note whose notes are gone or in trash aren't reopened, and the split
   * note never repeats the left pane's. The layout that opens is saved, in one
   * write, only when it isn't what's stored (a tab whose note went, a split
   * view that couldn't come back), and never after a read that failed.
   */
  async loadSavedTabs() {
    const saved = await this._savedSession();
    this._startupSession = null;
    const stored = saved || {};
    const savedTabs = stored.openTabs !== undefined ? stored.openTabs : null;
    const savedActiveIndex = stored.activeTabIndex !== undefined ? stored.activeTabIndex : 0;
    const savedSplitView = stored.splitViewEnabled !== undefined ? stored.splitViewEnabled : false;
    const savedSecondaryId = stored.secondaryNoteId !== undefined ? stored.secondaryNoteId : null;
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

    /** @type {string|undefined} The note the restored active tab shows, which becomes the last opened */
    let lastOpenedNoteId;
    if (validTabs.length > 0) {
      this.openTabs = validTabs;
      this.activeTabIndex = TabController.keptActiveIndex(kept, savedActiveIndex);
      // Saved once, below, with the rest of the restored layout
      if (await this.switchToTab(this.activeTabIndex, { persist: false })) {
        lastOpenedNoteId = this.openTabs[this.activeTabIndex].noteId;
      }
    } else {
      // No saved tabs or all invalid - create initial tab with first note
      const notes = this.noteList ? this.noteList.view('active') : [];
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
    if (saved) {
      const session = this._session(lastOpenedNoteId);
      const changed = Object.keys(session).some((key) => JSON.stringify(session[key]) !== JSON.stringify(stored[key]));
      if (changed) await this.settings.saveSession(session);
    }
    this.workspaceReady();
  }

  /**
   * The workspace session this tab shows: its tabs, the active one, split view, the right
   * pane's note when it has one, and, when given, the note that was opened last.
   * @param {string} [lastOpenedNoteId]
   * @returns {Object}
   */
  _session(lastOpenedNoteId) {
    /** @type {Object<string, *>} */
    const session = {
      openTabs: this.openTabs,
      activeTabIndex: this.activeTabIndex,
      splitViewEnabled: this.splitViewEnabled,
    };
    if (this.secondaryEditor && this.secondaryEditor.noteId) session.secondaryNoteId = this.secondaryEditor.noteId;
    if (lastOpenedNoteId) session.lastOpenedNoteId = lastOpenedNoteId;
    return session;
  }

  /**
   * Save the tabs, in one write through the settings port (saveWorkspaceSession), with the
   * note that was just opened when there is one, for a fast start (Req 27.2).
   * @param {{lastOpenedNoteId?: string|null}} [options]
   * @returns {Promise<void>}
   */
  async saveTabs({ lastOpenedNoteId = null } = {}) {
    await this.settings.saveSession(this._session(lastOpenedNoteId || undefined));
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
   * Switch to a specific tab. The tab bar and the saved tabs follow only a
   * load that happened, so a refused one leaves them on the note on screen.
   * Leaving a deleted note's notice takes that note's tab away, and so does
   * clicking the tab of a note deleted elsewhere, with a toast. A start's
   * restore saves the layout itself, once (`persist: false`).
   * @param {number} index
   * @param {{persist?: boolean}} [options]
   * @returns {Promise<boolean>} whether the tab's note loaded
   */
  async switchToTab(index, { persist = true } = {}) {
    if (index < 0 || index >= this.openTabs.length) return false;
    const tab = this.openTabs[index];
    const editor = this.getEditor();
    const goneId = editor.noteGone ? editor.noteId : null;

    if (!(await editor.loadNote(tab.noteId))) {
      if (tab.noteId !== editor.noteId && !(await this.documentClient.readNote(tab.noteId))) await this._dropDeletedTab(tab);
      else this.renderTabs();
      return false;
    }
    this._dropGoneTab(goneId);
    const at = this.openTabs.indexOf(tab);
    if (at !== -1) this.activeTabIndex = at;
    this.renderTabs();
    if (this.onRenderNotesList) await this.onRenderNotesList();
    // With the last-opened note, for a fast start (Req 27.2), in the same write
    if (persist) await this.saveTabs({ lastOpenedNoteId: tab.noteId });
    return true;
  }

  /**
   * Open a note in a new tab (or focus existing). The tab opens once the note
   * is loaded.
   */
  async openNoteInNewTab(noteId) {
    const note = await this.documentClient.readNote(noteId);
    if (!note) return;

    // Check if already open
    const existingIndex = this.openTabs.findIndex(t => t.noteId === noteId);
    if (existingIndex !== -1) {
      await this.switchToTab(existingIndex);
      return;
    }

    const editor = this.getEditor();
    const goneId = editor.noteGone ? editor.noteId : null;
    if (!(await editor.loadNote(noteId))) return;
    this._dropGoneTab(goneId);
    this._pushTab(note);
    this.renderTabs();
    if (this.onRenderNotesList) await this.onRenderNotesList();
    // With the last-opened note, for a fast start (Req 27.2), in the same write
    await this.saveTabs({ lastOpenedNoteId: noteId });
  }

  /**
   * Open a new tab with a new note. App makes it through the kernel, so the note list has it
   * from the commit feed once it settles, with no refresh, and the empty state has followed
   * the list (App.followEmptyState).
   */
  async openNewTab() {
    if (this.onCreateNote) {
      const note = await this.onCreateNote();
      if (note) {
        if (this.noteList) await this.noteList.settled();
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
   * Close a tab by index. Closing the active tab loads the next tab's note (or
   * the previous one's) first, and the tab goes only once that load happened,
   * so a load the editor refuses, to keep a deleted note's unsaved text on
   * screen, leaves the tab bar on the note on screen. A neighbour whose note
   * was deleted elsewhere goes with a toast, and the next one is tried.
   * Closing another tab loads nothing.
   * @param {number} index
   * @returns {Promise<void>}
   */
  async closeTab(index) {
    if (this.openTabs.length <= 1 || index < 0 || index >= this.openTabs.length) return; // Don't close last tab
    const closing = this.openTabs[index];
    if (index !== this.activeTabIndex) {
      const active = this.openTabs[this.activeTabIndex];
      this.openTabs.splice(index, 1);
      this.activeTabIndex = Math.max(0, this.openTabs.indexOf(active));
      this.renderTabs();
      await this.saveTabs();
      return;
    }

    const editor = this.getEditor();
    const goneId = editor.noteGone ? editor.noteId : null;
    let next;
    for (;;) {
      const at = this.openTabs.indexOf(closing);
      next = this.openTabs[at + 1] || this.openTabs[at - 1];
      if (!next) return;
      if (await editor.loadNote(next.noteId)) break;
      if (next.noteId === editor.noteId || (await this.documentClient.readNote(next.noteId))) {
        this.renderTabs();
        return;
      }
      await this._dropDeletedTab(next);
    }
    this.openTabs = this.openTabs.filter((tab) => tab !== closing);
    this._dropGoneTab(goneId);
    this.activeTabIndex = Math.max(0, this.openTabs.indexOf(next));
    this.renderTabs();
    if (this.onRenderNotesList) await this.onRenderNotesList();
    await this.saveTabs({ lastOpenedNoteId: next.noteId });
  }

  /**
   * The tab of a note deleted in another tab, or by trash retention, goes
   * when the user clicks it, with a toast. The pane on screen and its tab stay.
   * @param {{noteId: string, name: string}} tab
   * @returns {Promise<void>}
   */
  async _dropDeletedTab(tab) {
    const active = this.openTabs[this.activeTabIndex];
    this.openTabs = this.openTabs.filter((open) => open !== tab);
    this.activeTabIndex = Math.max(0, this.openTabs.indexOf(active));
    this.renderTabs();
    await this.saveTabs();
    Utils.showToast('That note was deleted, so its tab closed.', 'info');
  }

  /**
   * A pane left a deleted note it kept on screen: that note's tabs go, unless
   * a pane still shows it.
   * @param {string|null} goneId
   * @returns {void}
   */
  _dropGoneTab(goneId) {
    if (!goneId || this.getOpenEditors().some((editor) => editor.noteId === goneId)) return;
    const kept = this.openTabs.map((tab) => tab.noteId !== goneId);
    if (!kept.includes(false)) return;
    this.activeTabIndex = TabController.keptActiveIndex(kept, this.activeTabIndex);
    this.openTabs = this.openTabs.filter((tab, index) => kept[index]);
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
   * A title the kernel committed for `noteId`, from AI chat or NotesManager (noteTabs), names
   * its note's tab, if it has one, and the tabs are saved
   * @param {string} noteId
   * @param {string} name
   * @returns {Promise<void>}
   */
  async showNoteName(noteId, name) {
    const tab = this.openTabs.find((open) => open.noteId === noteId);
    if (!tab) return;
    tab.name = name;
    this.renderTabs();
    await this.saveTabs();
  }

  // ─── Split view ───

  /**
   * Toggle between single and split view.
   */
  async toggleSplitView() {
    if (this.splitViewEnabled) {
      // Written first, so a note the hidden pane holds can open on the left with its last edit
      const right = this.secondaryEditor;
      await right.flushSave();
      // A deleted note's unsaved text stays in view, with its notice, rather than hidden
      if (right.noteGone) {
        Utils.showToast("Split view stays open while the right pane has a deleted note's unsaved text.", 'info');
        return;
      }
      this._setSplitView(false);
      // Saved now, so a reload keeps it (1.4.x saved it only with the next tab change)
      await this.saveTabs();
      return;
    }
    // A right pane without a note would take typing and save none of it
    if (!(await this._fillRightPane())) {
      Utils.showToast('Split view needs a second note.', 'info');
      return;
    }
    this._setSplitView(true);
    await this.saveTabs();
  }

  /**
   * Give the right pane an active note the left pane doesn't show:
   * `preferredId` when it can reopen, else the right pane's own note when it
   * still can, read again since the left pane may have changed it meanwhile,
   * else the first other active note. An archived note doesn't come back
   * there. A right pane keeping a deleted note's unsaved text on screen keeps it.
   * @param {*} [preferredId=null]
   * @returns {Promise<boolean>} false when there's no such note
   */
  async _fillRightPane(preferredId = null) {
    const right = this.secondaryEditor;
    if (right.noteGone) return true;
    const leftId = this.editor.noteId;
    for (const id of [preferredId, right.noteId]) {
      if (!id || id === leftId) continue;
      const note = await this._restorableNote(id);
      if (!note || note.archived) continue;
      if ((await right.loadNote(id)) || right.noteGone) return true;
    }
    const other = (await this.documentClient.activeNotes()).find((note) => note.id !== leftId);
    if (other && ((await right.loadNote(other.id)) || right.noteGone)) return true;
    // No note for it: no hidden copy of the left pane's note either
    if (right.noteId && right.noteId === leftId) await right.unload();
    return false;
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
      // And each one a chunk adds while the window is open (#27 slice 3)
      if (this.registerExtraDocument) {
        const stopMirroring = this.registerExtraDocument(this.pipWindow.document);
        this.pipWindow.addEventListener('pagehide', () => stopMirroring());
      }

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
        root: wrapper,
        ...this.editorPorts,
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
