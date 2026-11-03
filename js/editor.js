/**
 * Block Editor - handles all editor interactions
 */

/**
 * Whether the page has version history: off once a snapshot write answers that the database,
 * one an older profile left, has no snapshots store, as 1.4.x kept it off. Every editor on the
 * page, the PiP editor's included, shares it.
 */
const VERSION_HISTORY = { off: false };

/**
 * What keeps keys pressed outside the note off it while it's open
 * (BlockEditor's _overlayOpen): the modals (Settings, Keyboard Shortcuts,
 * Theme Builder, the command palette, the AI insert preview, a snapshot's
 * preview), the note and folder menus, the slash, link, and template menus,
 * the block, Turn into, and table menus, the confirm dialogs, onboarding, and
 * any other dialog or menu. A <dialog> counts only with `open`.
 */
const OPEN_OVERLAYS = [
  '.modal', '.context-menu', '.slash-menu', '.block-action-menu', '.turn-into-menu', '.table-context-menu',
  '.confirm-dialog-overlay', '.onboarding-overlay', 'dialog[open]',
  '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[aria-modal="true"]',
].join(', ');

/** Input types that take no typed text, so an input of one isn't a text field (BlockEditor's _inTextField) */
const NON_TEXT_INPUTS = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'];

/**
 * What a Turn into that removes structure says goes and what stays (#14 slice 3), for one block
 * and for a selection's, by the part the kernel's conversions.js names, in the order it names them
 */
const TURN_LOSSES = Object.freeze([
  {
    part: 'grid',
    one: "The table's grid is removed. Its cells are kept as text, one row per line.",
    many: 'Tables lose their grid, and their cells are kept as text, one row per line.',
  },
  { part: 'image', one: 'The image is removed. Undo brings it back.', many: 'Images are removed.' },
  {
    part: 'video',
    one: 'The video is removed. Its link is kept as text.',
    many: 'Videos are removed, and their links are kept as text.',
  },
  {
    part: 'file',
    one: 'The attached file is removed. Its name is kept as text.',
    many: 'Attached files are removed, and their names are kept as text.',
  },
  {
    part: 'arrow',
    one: "The toggle's arrow is removed. Its hidden content moves to a new block below it.",
    many: 'Toggles lose their arrow, and their hidden content moves to a new block below each one.',
  },
]);

/**
 * What an editor asks of the page around it: its navigation port. App gives it to the editors
 * it makes, and TabController to the PiP editor, in place of the window.app lookup getApp made.
 * @typedef {Object} EditorNavigation
 * @property {(name: string) => void} titleChanged - The note's title changed, so its tab shows it
 * @property {(note: Object) => void} noteSaved - The note was saved, so search and the sidebar catch up
 * @property {(noteId: string) => void} openNote - Open a note, as a backlink does
 * @property {(name: string) => void} openNoteByName - Open the note a wiki link names
 * @property {(editor: BlockEditor, goneId: string, note: Object) => Promise<void>} noteReplaced
 *   The editor saved a deleted note's text as `note`, so the tab that showed it follows
 * @property {() => void} reloadPage - Reload the new tab, which opens the notes database again
 */

/**
 * What an editor with no page around it asks of none, such as one a test makes on its own
 * @type {EditorNavigation}
 */
const NO_NAVIGATION = Object.freeze({
  titleChanged() {},
  noteSaved() {},
  openNote() {},
  openNoteByName() {},
  noteReplaced: async () => {},
  reloadPage() {},
});

/**
 * The provider calls an editor makes: its AI port (js/services/ai-port.mjs), which App gives
 * the editors it makes, and TabController the PiP editor, in place of the LLM global getLLM
 * looked up.
 * @typedef {Object} EditorAI
 * @property {() => boolean} isConfigured
 * @property {(text: string) => Promise<string|null>} generateTitle
 * @property {(text: string, name?: string) => Promise<Object|null>} extractInsights
 * @property {(messages: Array<{role: string, content: string}>) => Promise<string>} chat
 */

/**
 * What an editor with no page around it has: no provider
 * @type {EditorAI}
 */
const NO_AI = Object.freeze({
  isConfigured: () => false,
  generateTitle: async () => null,
  extractInsights: async () => null,
  chat: async () => '',
});

/** The note fields insights write (the kernel's attachInsights), and all a job shows of them */
const INSIGHT_FIELDS = ['insights', 'lastInsightsExtractedAt', 'lastInsightsContentHash'];

/**
 * Every editor this page built: the new tab's two panes and the pop-out's (#33). The page's own
 * close writes a close-time draft for each one holding an edit it hasn't seen commit, before any
 * of them issues its closing write (BlockEditor._writeCloseDraft).
 * @type {Set<BlockEditor>}
 */
const pageEditors = new Set();

/** Whether this page listens for its own close, to write its editors' close-time drafts */
let closeDraftsBound = false;

/**
 * The saves this page's editors issued, by note, so one editor's draft counts another's save of
 * the same note as the page's own, committed or not (#33): each one's place in the page's save
 * order, the title it carried, the digest of each block it sent, as the note stores it, and once
 * it commits, the revision it committed at and whether its title was stored (committedPageSave)
 * @type {Map<string, Array<{seq: number, name: (string|undefined), blocks: Map<string, string>, orders?: Map<string, number>, moved?: Set<string>, committed?: {revision: number, named: boolean}}>>}
 */
const pageSaves = new Map();

/** The page's save order: each issued save and each editor's base takes its place in it */
let pageSeq = 0;

/** At the page's own close: each editor's close-time draft, the pop-out's included (#33) */
function writeCloseDrafts() {
  for (const editor of pageEditors) {
    try {
      editor._writeCloseDraft();
    } catch (error) {
      // Never out of pagehide: the editors' closing writes still run. Its name, never the edit.
      console.warn('A close-time draft was skipped:', error && error.name);
    }
  }
}

/**
 * Forget the page's issued saves of `noteId` that every editor holding the note has a base past,
 * and the note's whole list once no editor holds it
 * @param {string} noteId
 * @returns {void}
 */
function prunePageSaves(noteId) {
  const saves = pageSaves.get(noteId);
  if (!saves) return;
  let oldest = Infinity;
  for (const editor of pageEditors) {
    const seen = editor._seen.get(noteId);
    if (seen) oldest = Math.min(oldest, seen.seq);
  }
  const kept = saves.filter((save) => save.seq > oldest);
  if (kept.length === 0) pageSaves.delete(noteId);
  else pageSaves.set(noteId, kept);
}

/**
 * A save of `noteId` the page issued committed, at content revision `revision`: each block it
 * wrote is stored as it sent it, until a later commit writes that block. So of the page's
 * committed saves, only the newest commit's digest of each block can be what's stored, and only
 * the newest stored name, and the rest go, and so does a save that names nothing more. Commits
 * are ordered by their revisions, not by when they were issued or heard of, and a save still in
 * flight keeps all it sent. A note's list keeps its newest commit of each block and the saves in
 * flight, however many times one pane saves while another holds an older base.
 * @param {string} noteId
 * @param {number} seq - the committed save's place in the page's save order
 * @param {number} revision - the content revision it committed at
 * @param {boolean} named - whether the name it carried is stored
 * @returns {void}
 */
function committedPageSave(noteId, seq, revision, named) {
  const saves = pageSaves.get(noteId);
  if (!saves) return;
  // Copies, never the saves' own, which their editors read when they hear of their commits
  const marked = saves.map((save) => (save.seq === seq ? { ...save, committed: { revision, named } } : save));
  /** @type {Map<string, number>} The newest commit of each block */
  const newest = new Map();
  let newestName = -1;
  for (const { blocks, name, committed } of marked) {
    if (!committed) continue;
    for (const id of blocks.keys()) newest.set(id, Math.max(newest.get(id) ?? -1, committed.revision));
    if (committed.named && name !== undefined) newestName = Math.max(newestName, committed.revision);
  }
  const kept = [];
  for (const save of marked) {
    const { committed } = save;
    if (!committed) {
      kept.push(save);
      continue;
    }
    const blocks = new Map([...save.blocks].filter(([id]) => newest.get(id) === committed.revision));
    const name = committed.named && committed.revision === newestName ? save.name : undefined;
    if (blocks.size > 0 || name !== undefined) kept.push({ ...save, name, blocks });
  }
  if (kept.length === 0) pageSaves.delete(noteId);
  else pageSaves.set(noteId, kept);
}

/**
 * A base's revision after one of its editor's own commits of the note: the commit's, when it's
 * the one right after the base's, so nothing else committed in between, and unknown otherwise.
 * Each content commit moves a note's revision by one (#17, the per-pane save).
 * @param {number|null} base
 * @param {unknown} committedAt - the revision the commit's outcome gave
 * @returns {number|null}
 */
function nextRevision(base, committedAt) {
  return typeof base === 'number' && typeof committedAt === 'number' && committedAt === base + 1 ? committedAt : null;
}

/** How long an "insights are being extracted" mark is trusted before the editor clears it */
const INSIGHTS_PENDING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * What one save writes. The note is captured when the save starts, so a later
 * note switch can't change which note it writes. The blocks are taken right
 * before the transaction opens, so a block deleted in between isn't written back.
 * @typedef {Object} EditorSaveState
 * @property {number} seq - Capture order; a newer capture of the same note supersedes an older one
 * @property {string} noteId
 * @property {Object} noteData - The note record, shared with the editor while that note is loaded
 * @property {Array<Object>|null} blocks - Serialized blocks with `canvasId` and `order` set, once taken
 * @property {EditorTitle|null} title - The title set since the note's last save, taken with the blocks
 * @property {boolean} written - True once this state's transaction has been opened
 * @property {boolean} isRetry - The retry after a failed save; failing again shows the error toast
 * @property {{seq: number, name: (string|undefined), blocks: Map<string, string>, orders: Map<string, number>, moved: Set<string>}} [issued] -
 *   What it sent, as the page's issued saves hold it, once its transaction opened on a page that
 *   keeps close-time drafts (#33): each block's digest and order, and the blocks it only moved
 * @property {number|null} [committedRevision] - The content revision its committed outcome gave
 */

/**
 * A title set in the editor that no save has stored yet. The save that takes it writes it with
 * the blocks, as 1.4.x's save wrote the note's name with them.
 * @typedef {Object} EditorTitle
 * @property {string} noteId
 * @property {string} name
 * @property {'typed'|'generated'} origin - typed by the user, or set by the AI (setTitleProgrammatically)
 */

/** The note icon the wiki-link and template pickers show, packaged markup */
const NOTE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
  <polyline points="14 2 14 8 20 8"></polyline>
</svg>`;

class BlockEditor {
  constructor(config = {}) {
    this.root = config.root || document;
    this.doc = this.root.ownerDocument || this.root || document;
    this.noteId = null;
    this.noteData = null;
    this.blocks = [];
    this.onChange = config.onChange || null;
    /** @type {EditorNavigation} */
    this.navigation = config.navigation || NO_NAVIGATION;
    /**
     * What it reads and writes its note through: js/kernel/composition/document.js, over the
     * page's kernel, which App gives every editor in place of Storage
     * @type {any}
     */
    this.documentClient = config.documentClient || null;
    /** @type {EditorAI} */
    this.ai = config.ai || NO_AI;
    /** The tab's logger, whose events a block this editor won't write goes to (Utils.blockRefusal) */
    this.logger = config.logger || null;
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

    // The slash and link menus' lists are listboxes named by their headers, so a screen reader can
    // tell which option the arrow keys picked
    for (const [menu, list] of [[this.slashMenu, this.slashMenuItems], [this.wikiMenu, this.wikiMenuItems]]) {
      if (!list) continue;
      list.setAttribute('role', 'listbox');
      const header = menu.querySelector('.slash-menu-header');
      if (header) list.setAttribute('aria-label', header.textContent);
    }

    this._initPersistenceState();
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
    this._bindLifecycleFlush();
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
   * The AI port, or none for an editor made without one
   * @returns {EditorAI}
   */
  _aiPort() {
    return this.ai || NO_AI;
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

    // Close the slash, link, and template menus on a click outside them
    this.doc.addEventListener('click', (e) => {
      if (!this.slashMenu.contains(e.target) && this.slashMenuVisible) {
        this.hideSlashMenu();
      }
      if (this.wikiMenu && !this.wikiMenu.contains(e.target) && this.wikiMenuVisible) {
        this.hideWikiMenu();
      }
      if (this.templateMenu && !this.templateMenu.contains(e.target) && this.templateMenuVisible) {
        this.hideTemplateMenu();
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
   *
   * The note being left is saved first, and the next note is read into locals
   * and swapped in with one synchronous step, so no save can pair one note's ID
   * with another note's blocks. A load superseded by a later call drops its result.
   * Reloading the open note reads it again after any edit typed during the reads
   * is written, so the reads never replace a newer edit.
   * @param {string} noteId - Note ID to load
   * @returns {Promise<boolean>} Whether the editor shows that note now; false when the
   *   load was superseded, refused to keep a deleted note's unsaved text on screen, or
   *   found no such note
   */
  async loadNote(noteId) {
    const loadSeq = ++this._loadSeq;
    this._stopInsightsPolling();
    this._stopSnapshotInterval();

    // An import holds saves until it commits; the old note's edits go in after it.
    if (this._holdReleased) await this._holdReleased;
    if (loadSeq !== this._loadSeq) return false;
    // "Save as a new note" finishes first, so the text it saves goes with it.
    if (this._savingAsNew) await this._savingAsNew;
    if (loadSeq !== this._loadSeq) return false;

    const knewGone = this.noteGone;
    await this.flushSave();
    if (loadSeq !== this._loadSeq) return false;
    // The note it shows turned out deleted with edits it couldn't save: it stays, with
    // the text and the notice, so they aren't lost unseen.
    if (this.noteGone && !knewGone && noteId !== this.noteId) {
      this._resumeNoteTimers();
      return false;
    }

    let noteData = null;
    let blocksData = [];
    let keepEditorCopy = false;
    // For the note's close-time draft base (#33): the revision the open read the note at, and the
    // page's save order when it began, so a save in flight then counts as one the page issued
    let openedRevision = null;
    let openedSeq = pageSeq;
    for (let round = 0; ; round++) {
      let opened;
      const seqAtOpen = pageSeq;
      try {
        opened = await this.documentClient.openNote(noteId);
      } catch (error) {
        if (!this._isReloadRequired(error)) throw error;
        // The page lost its connection to the database: the note it shows stays, with the notice
        if (loadSeq !== this._loadSeq) return false;
        this._onReloadRequired();
        this._resumeNoteTimers();
        return false;
      }
      noteData = opened ? opened.note : null;
      blocksData = opened ? opened.blocks : [];
      openedRevision = opened && typeof opened.revision === 'number' ? opened.revision : null;
      openedSeq = seqAtOpen;
      if (loadSeq !== this._loadSeq) return false;
      // Switching notes, or nothing written since the reads started: they are current.
      if (noteId !== this.noteId || !this._hasPendingSave()) break;
      // Edits keep arriving during the reads: the editor's copy is the newest one.
      if (round === 2) {
        keepEditorCopy = true;
        break;
      }
      this._writePendingNow();
      await this._waitForWrites();
      if (loadSeq !== this._loadSeq) return false;
    }

    if (!noteData) {
      // Keep the note that is loaded rather than pointing the editor at nothing.
      console.error('Note not found:', noteId);
      this._resumeNoteTimers();
      return this.noteId === noteId;
    }

    // Edits typed into the old note while the reads ran still belong to it.
    this._writePendingNow();

    if (keepEditorCopy) {
      this._resumeNoteTimers();
      return true;
    }

    this._clearNoteGone();
    // A title still unsaved belongs to the note it was set on, whose failed save keeps it
    this._unsavedTitle = null;
    this.noteId = noteId;
    this.noteData = noteData;
    this.blocks = blocksData
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((data) => Block.deserialize(data));

    // Clear undo/redo stacks for new note
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._contentUndoPending = {};

    // Clear multi-block selection
    this.clearBlockSelection();
    // The menus opened on the note being left close with it
    this.hideMenus();

    // Reset snapshot tracking for new note (Req 31.1)
    this._snapshotDirty = false;

    // Set title
    this.titleEl.textContent = this.noteData.name || '';

    // Set timestamp
    this.updateTimestampDisplay();

    // Check if note already has content (for first-content detection)
    const existingContent = this.blocks.some(block => {
      const text = this._textOf(block);
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
    // The close-time draft base, with that empty block in it as the editor shows it, so a close
    // with nothing typed into it writes no draft (#33)
    this._rememberLoaded(blocksData, openedRevision, openedSeq);

    // Scroll to top of editor
    // Set editor width
    const editorContainer = this.root.querySelector('.editor-container') || this.doc.getElementById('editor-container');

    // Focus first block, then ensure scroll is at top. Not while focus is in an
    // open modal, menu, or dialog: it stays there, as on the onboarding
    // walkthrough's button over the welcome note, so keys typed there don't
    // edit the note
    setTimeout(() => {
      const firstContent = this.container.querySelector('.block-content');
      if (firstContent && !this._focusInOverlay()) {
        firstContent.focus();
        this.placeCaretAtEnd(firstContent);
      }
      // Reset scroll after focus (focus can cause scroll)
      if (editorContainer) {
        editorContainer.scrollTop = 0;
      }
    }, 50);

    this._startSnapshotInterval();

    // Render insights section if available (async - checks for extraction state)
    await this.renderInsights();
    if (loadSeq !== this._loadSeq) return this.noteId === noteId;

    // Start polling if extraction is in progress
    await this.startInsightsPollingIfNeeded();
    return this.noteId === noteId;
  }

  /**
   * Show no note, as a hidden pane does once split view closes: what's
   * pending is written first, then the note, its blocks, undo history, and
   * selection go, so the pane keeps no stale copy of a note another pane
   * shows. A pane keeping a deleted note's unsaved text on screen keeps it.
   * @returns {Promise<boolean>} Whether the editor now shows no note
   */
  async unload() {
    const loadSeq = ++this._loadSeq;
    this._stopInsightsPolling();
    this._stopSnapshotInterval();
    if (this._holdReleased) await this._holdReleased;
    if (this._savingAsNew) await this._savingAsNew;
    await this.flushSave();
    if (loadSeq !== this._loadSeq) return false;
    if (this.noteGone) {
      this._resumeNoteTimers();
      return false;
    }
    this.noteId = null;
    this.noteData = null;
    this.blocks = [];
    // Its close-time draft base goes with it, and the page's saves kept for it alone (R160's S1)
    this._forgetIdleBases();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._contentUndoPending = {};
    this.clearBlockSelection();
    this._snapshotDirty = false;
    this.titleEl.textContent = '';
    this.renderBlocks();
    return true;
  }

  /**
   * Stop polling for insights extraction.
   * @returns {void}
   */
  _stopInsightsPolling() {
    if (this.insightsPollingId) {
      clearInterval(this.insightsPollingId);
      this.insightsPollingId = null;
    }
  }

  /**
   * Restart the snapshot interval and insights polling for the loaded note
   * after a load that didn't switch notes.
   * @returns {void}
   */
  _resumeNoteTimers() {
    if (!this.noteId) return;
    this._startSnapshotInterval();
    this.startInsightsPollingIfNeeded().catch((error) => {
      console.warn('Insights polling failed to restart:', error);
    });
  }

  /**
   * Start polling for insights extraction completion if needed
   */
  async startInsightsPollingIfNeeded() {
    // The note is taken now, and every read after an await is checked against it
    const noteId = this.noteId;
    if (!noteId) return;
    const since = await this._insightsPendingSince(noteId);
    if (!since || noteId !== this.noteId) {
      return;
    }

    // Check if extraction started within the last 5 minutes
    if (since <= Date.now() - INSIGHTS_PENDING_TIMEOUT_MS) {
      return;
    }

    // Poll every 2 seconds to check if extraction completed (one poller at a time)
    this._stopInsightsPolling();
    const pollingId = setInterval(async () => {
      // A note switch stops the poller; one still running when it does stops here
      if (this.insightsPollingId !== pollingId || noteId !== this.noteId) {
        clearInterval(pollingId);
        return;
      }
      const stillExtracting = await this._insightsPendingSince(noteId);
      if (stillExtracting || this.insightsPollingId !== pollingId) return;

      // Extraction completed: show the insights it stored, and nothing else of the note
      clearInterval(pollingId);
      this.insightsPollingId = null;
      const stored = await this.documentClient.readNote(noteId);
      if (stored) this.showCommittedInsights(noteId, stored);
    }, 2000);
    this.insightsPollingId = pollingId;
  }

  /**
   * Since when `noteId`'s insights have been being extracted, or null, read as 1.4.x read
   * it: a failed read counts as none
   * @param {string} noteId
   * @returns {Promise<number|null>}
   */
  async _insightsPendingSince(noteId) {
    try {
      return await this.documentClient.insightsPending(noteId);
    } catch (error) {
      console.warn('Insights: could not read whether extraction is running', error && error.message);
      return null;
    }
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

    // Check if extraction is in progress for this note, the one loaded now
    const noteId = this.noteId;
    const since = await this._insightsPendingSince(noteId);
    // Another note loaded meanwhile renders its own
    if (noteId !== this.noteId || !this.noteData) return;
    if (since) {
      // Check if extraction started within the last 5 minutes (timeout protection)
      if (since > Date.now() - INSIGHTS_PENDING_TIMEOUT_MS) {
        // Show loading state
        this.showInsightsLoadingInEditor();
        return;
      }
      // Extraction timed out, clear the stale state
      const outcome = await this.documentClient.setInsightsPending(noteId, false);
      if (outcome.kind !== 'committed') console.warn('Insights: the stale mark stays', outcome.kind, outcome.code);
      if (noteId !== this.noteId || !this.noteData) return;
    }
    // A render that started earlier may have drawn one meanwhile
    const drawn = this.root.querySelector('.note-insights') || this.doc.getElementById('note-insights');
    if (drawn) drawn.remove();

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
   * Show a title the kernel committed for `noteId` (a derived or generated one), without
   * saving anything: only while this editor holds that note, and not over a title the user
   * typed that no save has stored yet, which wins once its save lands. A generated title
   * waiting to save is dropped, since the committed one is newer. The sidebar lists the new
   * name, and moves the note up, from the page's note list, which reads the commit from the
   * commit feed (#12 slice 4c1).
   * @param {string} noteId
   * @param {string} name
   * @returns {'shown'|'typed-title-pending'|'not-open'}
   */
  showCommittedTitle(noteId, name) {
    if (!this.noteData || this.noteId !== noteId) return 'not-open';
    const pending = this._unsavedTitle;
    if (pending && pending.noteId === noteId) {
      if (pending.origin === 'typed') return 'typed-title-pending';
      this._unsavedTitle = null;
    }
    this.noteData.name = name;
    // The commit moved updatedAt, as the save did
    this.noteData.updatedAt = Date.now();
    this.titleEl.textContent = name;
    return 'shown';
  }

  /**
   * Show insights the kernel committed for `noteId`, without saving anything: only the
   * insight fields go onto the editor's copy of the note, and only while it holds that note.
   * @param {string} noteId
   * @param {Object} fields - The note's insight fields, or a note record to take them from
   * @returns {boolean} Whether this editor showed them
   */
  showCommittedInsights(noteId, fields) {
    if (!this.noteData || this.noteId !== noteId) return false;
    for (const field of INSIGHT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(fields, field)) this.noteData[field] = fields[field];
    }
    Promise.resolve(this.renderInsights()).catch((error) => {
      console.warn('Insights: could not show them', error && error.message);
    });
    return true;
  }

  /**
   * Refresh insights for current note
   */
  async refreshInsights() {
    const ai = this._aiPort();
    if (!this.noteId || !this.noteData || !ai.isConfigured()) {
      Utils.showToast('AI not configured', 'error');
      return;
    }

    const refreshBtn = this.doc.querySelector('.note-insights-refresh');
    if (refreshBtn) {
      refreshBtn.classList.add('loading');
      refreshBtn.textContent = 'Extracting...';
    }

    // The note and its text are taken now: the insights go to this note, whichever is open
    // when the provider answers
    const noteId = this.noteId;
    const name = this.noteData.name;
    try {
      const content = this.getAllBlocksTextContent();
      if (content.trim().length < 20) {
        Utils.showToast('Not enough content to extract insights', 'error');
        return;
      }

      const insights = await ai.extractInsights(content, name);

      if (insights) {
        // The insight fields and nothing else, so a pin, trash, or title set meanwhile stays
        const outcome = await this.documentClient.attachInsights(noteId, insights);
        if (outcome.kind === 'committed') {
          this.showCommittedInsights(noteId, { insights, lastInsightsExtractedAt: Date.now() });
          Utils.showToast('Insights updated', 'success');
        } else if (outcome.kind === 'rejected' && outcome.code === 'note-not-found') {
          // Deleted meanwhile, and it stays deleted
          Utils.showToast('Note not found', 'error');
        } else {
          if (outcome.kind === 'unavailable' && outcome.code === 'reload-required') this._onReloadRequired();
          throw new Error(`The insights were not stored (${outcome.kind}: ${outcome.code})`);
        }
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
   * Extract text content from a block object (for content detection): its plain-text
   * projection (#14), which js/kernel/composition/block-projections.js installs
   */
  extractBlockTextContent(block) {
    return globalThis.BlockProjections.plainText(block);
  }

  /**
   * A block's text for the editor's own reads (whether the note has content yet, the text its
   * save reads wiki links from), one block at a time: a block whose text can't be read gives
   * none, so it can't stop a load or a save (#14 slice 3, per-block isolation).
   * extractBlockTextContent itself keeps 1.4.x's output, throws included.
   * @param {Object} block
   * @returns {string}
   */
  _textOf(block) {
    try {
      return this.extractBlockTextContent(block);
    } catch {
      return '';
    }
  }

  /**
   * One picker item, as the slash menu, the wiki-link picker, and the template picker show it:
   * `iconHtml` is packaged markup, and the title and description are set as text, so a name
   * shows exactly as typed
   * @param {string} className
   * @param {string} iconHtml
   * @param {string} title
   * @param {string} [description]
   * @returns {HTMLElement}
   */
  _pickerItem(className, iconHtml, title, description) {
    const item = this.doc.createElement('div');
    item.className = className;
    const icon = this.doc.createElement('div');
    icon.className = 'slash-menu-item-icon';
    icon.innerHTML = iconHtml;
    const text = this.doc.createElement('div');
    text.className = 'slash-menu-item-text';
    const titleEl = this.doc.createElement('div');
    titleEl.className = 'slash-menu-item-title';
    titleEl.textContent = title;
    text.appendChild(titleEl);
    if (description !== undefined) {
      const desc = this.doc.createElement('div');
      desc.className = 'slash-menu-item-desc';
      desc.textContent = description;
      text.appendChild(desc);
    }
    item.appendChild(icon);
    item.appendChild(text);
    return item;
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
   * Take blocks AI chat is inserting into the loaded note (insertBlocks) at `index`, or after
   * the last block, in the task the insert's transaction opens, so a save from then on writes
   * them and every other block where the insert stores them. Undo history goes, as the reload
   * that showed an insert before cleared it. Once the insert commits, the note's close-time
   * draft base takes the blocks as it stored them (_sawInsert).
   * @param {string} noteId
   * @param {Array<Object>} blocks - the inserted blocks, ids included
   * @param {number} [index]
   * @param {Promise<{kind: string}>} [inserting] - the insert's outcome
   * @returns {() => void} Takes them out again, for an insert that wasn't stored
   */
  placeInsertedBlocks(noteId, blocks, index, inserting) {
    if (noteId !== this.noteId) return () => {};
    const added = blocks.map((data) => Block.deserialize(data));
    const at = index === undefined ? this.blocks.length : Math.min(index, this.blocks.length);
    const before = inserting && this._drafts() ? this._serializedBlocks(noteId) : null;
    this.blocks.splice(at, 0, ...added);
    if (before) this._sawInsert(noteId, blocks, at, before, inserting);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._contentUndoPending = {};
    this.renderBlocks();
    return () => {
      if (noteId !== this.noteId) return;
      const ids = new Set(added.map((block) => block.id));
      this.blocks = this.blocks.filter((block) => !ids.has(block.id));
      this.renderBlocks();
    };
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

    // The note's last block goes, and a new empty text block takes its place, rather than the
    // block being retyped, which would drop what its type held (#14 slice 3, the opaque rule)
    if (this.blocks.length === 1) {
      const gone = this.blocks[0];
      const goneSnapshot = this.snapshotBlock(gone);
      goneSnapshot.order = 0;
      const fresh = this.createBlock('text');
      const freshSnapshot = this.snapshotBlock(fresh);
      freshSnapshot.order = 0;
      this.pushUndo({
        type: 'group',
        entries: [
          { type: 'delete', blockId: gone.id, before: goneSnapshot, after: null },
          { type: 'add', blockId: fresh.id, before: null, after: freshSnapshot },
        ],
      });
      this.blocks = [fresh];
      this._deleteStoredBlocks([gone.id]);
      this.renderBlocks();
      this.focusBlock(fresh.id);
      this.scheduleSave();
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
    this._deleteStoredBlocks([blockId]);

    // Remove DOM element incrementally instead of full re-render (Req 50.2)
    const focusIndex = Math.max(0, index - 1);
    this.removeBlockDOM(blockId);
    this.focusBlock(this.blocks[focusIndex].id, true);
    this.scheduleSave();
  }

  /**
   * What `block` keeps and removes when it turns into `newType` (#14 slice 3, the kernel's
   * conversions.js): the new text, the structure that goes, and the text blocks to add after it.
   * Turning into its own type keeps its text as it is. Null when it doesn't convert, as a block in
   * a safe state never does, so nothing re-encodes it.
   * @param {Block} block
   * @param {string} newType
   * @returns {{content: string, removes: readonly string[], after: readonly {type: string, content: string}[]} | null}
   */
  _conversionOf(block, newType) {
    if (block.safeState()) return null;
    if (newType === block.type) return { content: block.content, removes: [], after: [] };
    return globalThis.BlockProjections.conversionOf(block.serialize(), newType);
  }

  /**
   * Whether `block`'s text is all it holds, so a merge that takes its text and deletes it loses
   * nothing (#14 slice 3): turning it into text would remove and move nothing, it carries no
   * field its type doesn't own, and its imageUrl holds no image
   * @param {Block} block
   * @returns {boolean}
   */
  _holdsOnlyText(block) {
    if (block.kept || globalThis.BlockProjections.holdsImage(block.imageUrl)) return false;
    const asText = this._conversionOf(block, 'text');
    return asText !== null && asText.removes.length === 0 && asText.after.length === 0;
  }

  /**
   * Turn `block` into `newType` as `conversion` says, adding its text blocks right after it, with
   * no render or save (#14 slice 3)
   * @param {Block} block
   * @param {string} newType
   * @param {{content: string, after: readonly {type: string, content: string}[]}} conversion - _conversionOf's
   * @returns {Array<UndoEntry>} its undo entries in the order they ran: the convert, then each add
   */
  _convertBlock(block, newType, conversion) {
    const before = this.snapshotBlock(block);
    block.content = conversion.content;
    block.type = newType;

    // Discard incompatible properties (Req 12.3). What a block holds is kept in its new text,
    // or the conversion asked first (turnInto)
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

    /** @type {Array<UndoEntry>} */
    const entries = [{ type: 'convert', blockId: block.id, before, after: this.snapshotBlock(block) }];
    let index = this.blocks.indexOf(block);
    for (const added of conversion.after) {
      const fresh = this.createBlock(added.type, added.content);
      index += 1;
      this.blocks.splice(index, 0, fresh);
      const after = this.snapshotBlock(fresh);
      after.order = index;
      entries.push({ type: 'add', blockId: fresh.id, before: null, after });
    }
    return entries;
  }

  /**
   * Change block type. A conversion that removes structure (a table's grid, an image, a video,
   * an attached file, or a toggle's arrow with what it hides) happens only once it's
   * `confirmed`, by the yes turnInto asks for (#14 slice 3); without one it changes nothing.
   * The conversion is one undo entry.
   * @param {string} blockId
   * @param {string} newType
   * @param {{confirmed?: boolean}} [options]
   * @returns {boolean} whether it changed
   */
  changeBlockType(blockId, newType, { confirmed = false } = {}) {
    const block = this.getBlockById(blockId);
    const conversion = block ? this._conversionOf(block, newType) : null;
    if (!conversion || (conversion.removes.length > 0 && !confirmed)) return false;

    const entries = this._convertBlock(block, newType, conversion);
    this.pushUndo(entries.length === 1 ? entries[0] : { type: 'group', entries });

    // Re-render this block, with the blocks it added after it
    const oldEl = this.container.querySelector(`[data-id="${blockId}"]`);
    if (oldEl) {
      const newEl = block.createElement();
      if (newType === 'numbered') {
        const index = this.blocks.indexOf(block);
        newEl.dataset.number = this.getNumberedListNumber(index);
      }
      oldEl.replaceWith(newEl);
      let afterId = blockId;
      for (const entry of entries.slice(1)) {
        this.insertBlockDOM(this.getBlockById(entry.blockId), afterId);
        afterId = entry.blockId;
      }
      this.focusBlock(blockId);
    }

    this.updateNumberedLists();
    this.scheduleSave();
    return true;
  }

  /**
   * Turn a block into `newType`, asking first when that removes structure (#14 slice 3). Turn
   * into in a block's menu, Alt+1, 2 and 3, Backspace at a block's start and the slash menu come
   * here. The question opens in this editor's own document, so a pop-out editor asks in its own
   * window, and a yes is one undo entry.
   * @param {string} blockId
   * @param {string} newType
   * @returns {Promise<boolean>} whether it turned
   */
  async turnInto(blockId, newType) {
    const block = this.getBlockById(blockId);
    const conversion = block ? this._conversionOf(block, newType) : null;
    if (!conversion) return false;
    if (conversion.removes.length === 0) return this.changeBlockType(blockId, newType);
    const noteId = this.noteId;
    const focused = this.doc.activeElement;
    if (!(await this._confirmTurn([conversion], newType))) {
      this._focusAfterCancel(focused, [blockId]);
      return false;
    }
    // The note and the block it asked about are still the ones on screen
    if (noteId !== this.noteId || this.getBlockById(blockId) !== block) return false;
    return this.changeBlockType(blockId, newType, { confirmed: true });
  }

  /**
   * Turn the blocks `ids` names into `newType`, Turn into on a selection (#14 slice 3): it asks
   * once for all of them when any loses structure, and a yes is one undo entry. A block of the
   * type already, or in a safe state, stays as it is.
   * @param {Iterable<string>} ids
   * @param {string} newType
   * @returns {Promise<boolean>} whether any turned
   */
  async turnSelectionInto(ids, newType) {
    const wanted = new Set(ids);
    const turning = this.blocks.filter((block) => wanted.has(block.id) && block.type !== newType);
    const conversions = turning.map((block) => this._conversionOf(block, newType)).filter(Boolean);
    if (conversions.length === 0) return false;
    if (conversions.some((conversion) => conversion.removes.length > 0)) {
      const noteId = this.noteId;
      const focused = this.doc.activeElement;
      if (!(await this._confirmTurn(conversions, newType))) {
        this._focusAfterCancel(focused, this.blocks.filter((block) => wanted.has(block.id)).map((block) => block.id));
        return false;
      }
      if (noteId !== this.noteId) return false;
    }

    /** @type {Array<UndoEntry>} */
    const entries = [];
    for (const block of turning) {
      // A block gone since it asked stays gone
      if (this.getBlockById(block.id) !== block) continue;
      const conversion = this._conversionOf(block, newType);
      if (conversion) entries.push(...this._convertBlock(block, newType, conversion));
    }
    if (entries.length === 0) return false;
    this.pushUndo(entries.length === 1 ? entries[0] : { type: 'group', entries });
    this.renderBlocks();
    this.scheduleSave();
    return true;
  }

  /**
   * Put focus back after a question's Cancel (#14 slice 3): where it was in this note, so typing
   * goes on there, or else, when the question came from outside the note (a block's menu, a
   * selection), in the first of `blockIds` that takes it, its text or a table's first cell. A
   * card takes none.
   * @param {Element | null} focused - what had focus when the question opened
   * @param {string[]} blockIds - the blocks the question was about, in note order
   */
  _focusAfterCancel(focused, blockIds) {
    const back = /** @type {HTMLElement | null} */ (focused);
    if (back && this.container.contains(back) && typeof back.focus === 'function') {
      back.focus();
      return;
    }
    for (const id of blockIds) {
      const el = this.getBlockElement(id);
      const target = /** @type {HTMLElement | null} */ (el ? el.querySelector('.block-content, td, th') : null);
      if (target) {
        target.focus();
        return;
      }
    }
  }

  /**
   * Ask before a Turn into removes structure (#14 slice 3), in this editor's own document, so a
   * pop-out editor asks in its own window: what goes and what's kept, for one block or for a
   * selection's. Undo reverses it, so its yes is no danger button. No dialog, no turn.
   * @param {Array<{removes: readonly string[]}>} conversions - one for each block that turns
   * @param {string} newType
   * @returns {Promise<boolean>} true on a yes
   */
  _confirmTurn(conversions, newType) {
    const ask = globalThis.confirmDialog;
    if (typeof ask !== 'function') return Promise.resolve(false);
    const named = this.getTurnIntoTypes().find(({ type }) => type === newType);
    const label = named ? named.name : (BlockTypes[newType] ? BlockTypes[newType].name : newType);
    const removed = new Set(conversions.flatMap((conversion) => conversion.removes));
    const one = conversions.length === 1;
    const sentences = TURN_LOSSES.filter(({ part }) => removed.has(part)).map((loss) => (one ? loss.one : loss.many));
    if (!one && removed.has('image')) sentences.push('Undo brings them back.');
    return ask({
      title: one ? `Turn into ${label}?` : `Turn ${conversions.length} blocks into ${label}?`,
      message: sentences.join(' '),
      confirmText: `Turn into ${label}`,
      cancelText: 'Cancel',
      initialFocus: 'cancel',
      doc: this.doc,
    });
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
      // Only where focus went: a caret in a hidden pane's block would swallow every key typed after it
      if (atEnd && this.doc.activeElement === content) {
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
        this._titleSet(newTitle, 'typed');
      }

      this.scheduleSave();

      if (this.onChange) this.onChange();

      this.navigation.titleChanged(this.noteData.name);
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
      this._titleSet(title, 'generated');

      this.scheduleSave();

      if (this.onChange) this.onChange();

      this.navigation.titleChanged(title);
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

    // The note is taken now: the title goes to this note, whichever is open when it comes
    const noteId = this.noteId;
    if (!noteId) return;
    // Prevent duplicate calls
    this.pendingAutoTitle = true;

    try {
      // Check if auto-title is enabled and the AI is configured
      if (!(await this._autoTitleEnabled())) return;
      const ai = this._aiPort();
      if (!ai.isConfigured()) return;

      // Check if title was manually set
      if (noteId !== this.noteId || this.noteData?.titleManuallySet) return;

      console.debug('First content detected, generating auto-title for note:', noteId);
      const newTitle = await ai.generateTitle(currentContent);
      if (!newTitle || !newTitle.trim()) return;

      if (noteId === this.noteId && this.noteData) {
        // A title the user typed meanwhile wins
        const pending = this._unsavedTitle;
        if (this.noteData.titleManuallySet || (pending && pending.noteId === noteId && pending.origin === 'typed')) return;
        // Into the next save, with the blocks, as 1.4.x saved it
        this.setTitleProgrammatically(newTitle);
      } else {
        // The editor moved on, and the save that left the note is written: the note gets the
        // title as a derived one, which a title set by hand keeps out
        const outcome = await this.documentClient.deriveTitle(noteId, newTitle);
        if (outcome.kind !== 'committed') console.warn('Auto-title: not stored', outcome.kind, outcome.code);
      }
      console.debug('Auto-title generated on first content for note:', noteId);
    } catch (error) {
      console.error('Failed to generate auto-title on first content:', error);
    } finally {
      if (noteId === this.noteId) this.pendingAutoTitle = false;
    }
  }

  /**
   * Whether auto-title is on, as 1.4.x read it: off when nothing is stored or the read fails
   * @returns {Promise<boolean>}
   */
  async _autoTitleEnabled() {
    try {
      const { autoTitleEnabled = false } = await this.documentClient.preferences(['autoTitleEnabled']);
      return Boolean(autoTitleEnabled);
    } catch (error) {
      console.warn('Auto-title: could not read whether it is on', error && error.message);
      return false;
    }
  }

  /**
   * Get all blocks' text content combined
   * @param {Array<Object>} [blocks=this.blocks] - Blocks or serialized block records
   * @returns {string}
   */
  getAllBlocksTextContent(blocks = this.blocks) {
    return blocks
      .map(block => this._textOf(block))
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
      this.noteNames = await this.documentClient.noteNames();
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
    this._pickLive();
    this.wikiMenuVisible = true;
    this.wikiMenuIndex = 0;
    this.wikiFilter = '';
    // It opens under the caret when it fits there, then stays on the side it's on (renderWikiMenu)
    this.wikiMenuAbove = false;

    // It opens from the caret, or from its block when the caret has no box of its own
    const selection = this.doc.defaultView.getSelection();
    const caret = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    this.wikiMenuAnchor = caret && (caret.width || caret.height) ? caret : blockEl.getBoundingClientRect();

    this.renderWikiMenu();
  }

  /**
   * Hide wikilink menu
   */
  hideWikiMenu() {
    this.wikiMenuVisible = false;
    if (this.wikiMenu) this.wikiMenu.classList.add('hidden');
    this._announcePick(null);
  }

  /**
   * Render wikilink menu items, then place the menu again, since its size follows the filter
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
    }

    filtered.forEach((name, index) => {
      const item = this._pickerItem(`slash-menu-item ${index === this.wikiMenuIndex ? 'active' : ''}`, NOTE_ICON, name);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === this.wikiMenuIndex));
      item.addEventListener('click', () => this.selectWikiMenuItem(name));
      this.wikiMenuItems.appendChild(item);
    });

    // Under the caret, or above it near the bottom, measured first (Utils.placeMenuBeside). It
    // stays on the side it's on while it fits there, so the list changing as you type doesn't
    // move it across the caret, and the highlighted name stays in view as the arrow keys move it
    if (this.wikiMenuVisible && this.wikiMenuAnchor) {
      const { top } = Utils.placeMenuBeside(this.wikiMenu, this.wikiMenuAnchor, { gap: 0, above: this.wikiMenuAbove });
      this.wikiMenuAbove = top < this.wikiMenuAnchor.top;
      const active = this.wikiMenuItems.querySelector('.slash-menu-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
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

      // The link is rich text, so it goes in through the rendering port (#14)
      const tempDiv = this.doc.createElement('div');
      globalThis.BlockRendering.render(tempDiv, linkHtml);
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
        // Remove the shortcut text. What's left is the block's text, plain, so it's escaped into
        // the block's rich content (#14 slice 2)
        const newContent = text.slice(shortcut.length);
        block.content = globalThis.BlockRendering.escapePlainText(newContent);
        this.changeBlockType(block.id, type);
        return;
      }
    }

    // Check for /template
    if (text === '/template') {
      this.templates = await this.documentClient.templates();
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
    // It opens under the block when it fits there, then stays on the side it's on (renderTemplateMenu)
    this.templateMenuAbove = false;
    this.templateMenuAnchor = blockEl.getBoundingClientRect();

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
   * Render template menu items, then place the menu again, since its size follows the filter
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
    }

    filtered.forEach((template, index) => {
      const item = this._pickerItem(`slash-menu-item ${index === this.templateMenuIndex ? 'active' : ''}`, NOTE_ICON, template.name);
      item.addEventListener('click', () => this.selectTemplateItem(template.id));
      this.templateMenuItems.appendChild(item);
    });

    // Under the block, or above it near the bottom, measured first (Utils.placeMenuBeside). Like
    // the link menu, it stays on the side it's on while it fits there, and keeps the highlighted
    // template in view
    if (this.templateMenuVisible && this.templateMenuAnchor) {
      const { top } = Utils.placeMenuBeside(this.templateMenu, this.templateMenuAnchor, { gap: 0, above: this.templateMenuAbove });
      this.templateMenuAbove = top < this.templateMenuAnchor.top;
      const active = this.templateMenuItems.querySelector('.slash-menu-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Select a template to insert
   */
  async selectTemplateItem(templateId) {
    // In the order they were made, not always the order the template shows them, as 1.4.x's
    // Storage.getElementsByNote listed them by id when every id began with the time it was made.
    // Kept on purpose for R1's no visible change rule, so a later slice can choose the order the
    // template shows instead. Since #17 PR 2a a new block's id can be a UUID, so this goes by
    // Utils.inCreationOrder's key: the time in an id Utils.generateId made, else createdAt, then
    // order, then the id. A copy this insert makes has such an id, and the createdAt of the
    // block it copies, as in 1.4.x.
    const templateBlocks = Utils.inCreationOrder(await this.documentClient.blocksOf(templateId));
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

      // Variable replacement: the values are plain text, escaped into rich content, for its text
      // and its attributes alike (#14 slice 2)
      if (newData.content) {
        newData.content = this.processTemplateVariables(newData.content, globalThis.BlockRendering.escapeAttributeText);
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

    for (let i = 0; i < this.blocks.length; i++) {
      this.blocks[i].order = i;
    }

    this.renderBlocks();
    this.hideTemplateMenu();
    // The inserted blocks are saved now, with the rest of the note, as saveNoteContent saves them
    this.scheduleSave();
    this.save();

    // Focus first inserted block
    if (newBlocks.length > 0) {
      this.focusBlock(newBlocks[0].id);
    }
  }

  /**
   * Process variables in template content
   * @param {unknown} text
   * @param {(value: string) => string} [as] - how a value is written into the field: as it is,
   *   for plain text, or escaped into rich text
   */
  processTemplateVariables(text, as = (value) => value) {
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
      result = result.split(key).join(as(value));
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

    // With blocks selected, Backspace and Delete delete the selection (onGlobalKeyDown, Req
    // 13.4), so the block they're pressed in leaves them alone (#14 slice 3)
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.selectedBlockIds && this.selectedBlockIds.size > 0) return;

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
        if (items.length) this._announcePick(items[this.wikiMenuIndex], this.wikiMenuIndex, items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = this.noteNames.filter(name => name.toLowerCase().includes(this.wikiFilter.toLowerCase())).slice(0, 10);
        this.wikiMenuIndex = (this.wikiMenuIndex - 1 + items.length) % items.length;
        this.renderWikiMenu();
        if (items.length) this._announcePick(items[this.wikiMenuIndex], this.wikiMenuIndex, items.length);
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

    // A card in a safe state is no list item to the block shortcuts, whatever type its record
    // names, so Tab moves on from it, and a block added below it is text at no indent (#14)
    const safe = block.safeState();
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const shortcutAction = typeof ShortcutUtils !== 'undefined'
      ? ShortcutUtils.getEditorShortcutAction({
        code: e.code,
        key: e.key,
        modKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        blockType: safe ? '' : block.type,
      })
      : null;

    if (shortcutAction) {
      e.preventDefault();

      if (shortcutAction.type === 'insert-below') {
        const nextType = !safe && ['bullet', 'numbered', 'todo'].includes(block.type) ? block.type : 'text';
        this.insertBlockAfter(block.id, nextType, '', {
          indentLevel: (!safe && block.indentLevel) || 0,
        });
        return;
      }

      if (shortcutAction.type === 'move-block') {
        this.moveBlockByDirection(block.id, shortcutAction.direction);
        return;
      }

      if (shortcutAction.type === 'convert-block') {
        this.turnInto(block.id, shortcutAction.blockType);
        return;
      }

      if (shortcutAction.type === 'indent-block') {
        this.adjustBlockIndent(block.id, shortcutAction.delta);
        return;
      }
    }

    // A card in a safe state holds nothing to type in (#14). A key typed on it, Space too, does
    // nothing: its default is prevented, so the note doesn't take it and Space doesn't scroll, but
    // it goes on, so the app's shortcuts still hear it. Enter, Backspace, Delete, Tab and the arrow
    // keys are the browser's, which do nothing on a card but move focus, and so are Alt chords, as
    // type anywhere leaves them.
    if (safe) {
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault();
      return;
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
          this.turnInto(block.id, 'text');
          return;
        }

        // Merge with previous block
        const index = this.blocks.indexOf(block);
        if (index > 0) {
          const prevBlock = this.blocks[index - 1];
          const prevEl = this.getBlockElement(prevBlock.id);
          const prevContent = prevEl?.querySelector('.block-content');

          // The block merges in only when its text is all it holds (#14 slice 3)
          if (prevContent && prevBlock.type !== 'divider' && prevBlock.type !== 'image' && this._holdsOnlyText(block)) {
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
          // The next block merges in only when its text is all it holds, so a toggle's hidden
          // content and a field its type doesn't own stay (#14 slice 3)
          if (nextContent && nextBlock.type !== 'divider' && nextBlock.type !== 'image' && this._holdsOnlyText(nextBlock)) {
            block.content = content.innerHTML + nextBlock.content;
            globalThis.BlockRendering.render(content, block.content);
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
      if (noteName) this.navigation.openNoteByName(noteName);
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
   * @property {'add'|'delete'|'move'|'convert'|'content'|'group'} type
   * @property {string} [blockId]
   * @property {Object} [before] - Snapshot before the operation
   * @property {Object} [after] - Snapshot after the operation
   * @property {number} [fromIndex] - For move operations
   * @property {number} [toIndex] - For move operations
   * @property {Array<UndoEntry>} [entries] - A group's entries, one action's steps in the order
   *   they ran, which undo in the reverse order (#14 slice 3)
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
    this._applyUndoStep(entry, reverse);
    this.renderBlocks();
    this.scheduleSave();
  }

  /**
   * An entry's change to the blocks, with no render or save. A group's entries apply in the order
   * they ran and undo in the reverse order, so one action that took several steps undoes in one
   * (#14 slice 3): a Turn into that adds a block, a selection's Turn into or delete, or the last
   * block's delete.
   * @param {UndoEntry} entry
   * @param {boolean} reverse
   */
  _applyUndoStep(entry, reverse) {
    const snapshot = reverse ? entry.before : entry.after;

    switch (entry.type) {
      case 'group': {
        const steps = reverse ? [...entry.entries].reverse() : entry.entries;
        for (const step of steps) this._applyUndoStep(step, reverse);
        break;
      }
      case 'add': {
        if (reverse) {
          // Undo add → remove the block
          const idx = this.blocks.findIndex(b => b.id === entry.blockId);
          if (idx !== -1) {
            this.blocks.splice(idx, 1);
            this._deleteStoredBlocks([entry.blockId]);
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
            this._deleteStoredBlocks([entry.blockId]);
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
        const index = this.blocks.findIndex(b => b.id === entry.blockId);
        if (index !== -1 && snapshot) {
          // A block made from the snapshot takes the old one's place: the snapshot holds every
          // field the block held, those this class doesn't model too, which decode reads again
          // rather than copying them onto the old block (#14 slice 3)
          this.blocks[index] = Block.deserialize({ ...snapshot, id: entry.blockId });
        }
        break;
      }
    }
  }

  /**
   * Record a content-change undo entry with debouncing.
   * Groups rapid keystrokes into a single undo entry per block.
   * A note loaded since empties the map with the undo history, so a group's timer that finds
   * its group gone from the map does nothing, even on the same note opened again.
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

    const group = this._contentUndoPending[blockId];
    group.timer = setTimeout(() => {
      if (this._contentUndoPending[blockId] !== group) return;
      const block = this.getBlockById(blockId);
      if (block) {
        this.pushUndo({
          type: 'content',
          blockId,
          before: group.before,
          after: this.snapshotBlock(block),
        });
      }
      delete this._contentUndoPending[blockId];
    }, 600);
  }

  /**
   * Whether a keydown or paste on the document is this editor's to handle
   * (see _takesTypedKey). A hidden pane takes none, so it never undoes,
   * deletes, or pastes into a stale copy of a note.
   * @param {Event} e
   * @returns {boolean}
   */
  _ownsDocumentEvent(e) {
    return this._takesTypedKey(/** @type {any} */ (e && e.target));
  }

  /**
   * Handle global keydown. Both panes' editors listen on one document, and only
   * the one the key is for acts on it (see _takesTypedKey), so undo, redo, and
   * deleting a block selection happen in one pane. A text field outside the
   * note keeps its keys (see _inTextField), so Backspace, Delete, and undo
   * there edit the field. While a modal, menu, or dialog is open (see
   * _overlayOpen), only a key pressed in this editor's own pane is the note's.
   */
  onGlobalKeyDown(e) {
    if (!this._takesTypedKey(e.target)) return;
    if (this._inTextField(e.target)) return;
    if (!this._inOwnPane(e.target) && this._overlayOpen()) {
      // The browser's own undo, redo, and delete would still edit the note through the caret left in it
      if (BlockEditor.editsThroughCaret(e)) e.preventDefault();
      return;
    }

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

    // Type anywhere: a printable key goes to the note, moving focus there before
    // the key types, unless something took it already, what has focus keeps it,
    // or a modal, menu, or dialog is open
    if (
      !e.defaultPrevented &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key.length === 1 &&
      !this._keyStaysAt(e)
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

  /**
   * Whether a key pressed at `target` is this editor's. Both panes listen on
   * one document, so a key pressed in a pane is that pane's, and any other key
   * is the active pane's while it shows. Picture-in-Picture's pane is always
   * active in its own window.
   * @param {Element} target - Where the key was pressed
   * @returns {boolean}
   */
  _takesTypedKey(target) {
    const pane = target && typeof target.closest === 'function' ? target.closest('.editor-pane') : null;
    if (pane) return pane === this.root;
    const classes = this.root.classList;
    return Boolean(classes) && classes.contains('active') && !classes.contains('hidden');
  }

  /**
   * Whether the browser's default for a key edits the page through its caret
   * or its undo history, wherever focus is: Backspace, Delete, undo, and redo.
   * A caret left in a block when focus moved to a button still takes them.
   * @param {KeyboardEvent} e
   * @returns {boolean}
   */
  static editsThroughCaret(e) {
    if (e.key === 'Backspace' || e.key === 'Delete') return true;
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    return modKey && !e.altKey && (e.key === 'z' || e.key === 'Z' || (!isMac && e.key === 'y'));
  }

  /**
   * Whether `target` is in this editor's own pane: its title, its blocks, or
   * anything else the pane holds. Picture-in-Picture's pane is its window's
   * editor.
   * @param {Element} target - Where the key was pressed
   * @returns {boolean}
   */
  _inOwnPane(target) {
    return Boolean(target) && typeof this.root.contains === 'function' && this.root.contains(target);
  }

  /**
   * Whether `target` is in a text field that handles its own keys: an input
   * that takes text, a textarea, or a select, anywhere (a bookmark's URL input
   * included), or editable text that isn't this editor's own title or blocks.
   * The search box, Settings, the AI chat input, and the command palette are.
   * @param {Element} target - Where the key was pressed
   * @returns {boolean}
   */
  _inTextField(target) {
    if (!target || typeof target.closest !== 'function') return false;
    const control = /** @type {any} */ (target.closest('input, textarea, select'));
    if (control) {
      if (control.tagName !== 'INPUT') return true;
      return !NON_TEXT_INPUTS.includes(String(control.type || control.getAttribute('type') || 'text').toLowerCase());
    }
    const editable = /** @type {any} */ (target).isContentEditable;
    const isEditable = typeof editable === 'boolean' ? editable : Boolean(target.closest('[contenteditable]'));
    return isEditable && !this.root.contains(target);
  }

  /**
   * Whether a printable key stays where it was pressed instead of going to
   * the note: a text control (input, textarea, select, editable text),
   * another control that takes keys itself (summary, details, media
   * controls), or a modal, menu, listbox, or dialog has focus, one is open
   * wherever focus is, the app takes the key as a shortcut (? opens Keyboard
   * Shortcuts), or it's Space on a button, which presses it, or on a link,
   * where the browser does what it does (links open on Enter). Enter isn't
   * printable, so it never goes either.
   * @param {KeyboardEvent} e
   * @returns {boolean}
   */
  _keyStaysAt(e) {
    const target = /** @type {Element} */ (e.target);
    if (target.closest('input, textarea, select, [contenteditable], summary, details, audio[controls], video[controls]')) return true;
    if (target.closest('.modal, dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return true;
    if (this._overlayOpen()) return true;
    // Only the new tab's window has the app's shortcuts; in Picture-in-Picture a ? is typed
    if (this.doc === document && BlockEditor.isAppShortcut(e)) return true;
    return e.key === ' ' && Boolean(target.closest('button, a[href], [role="button"], [role="link"]'));
  }

  /**
   * Whether the app takes a key as one of its shortcuts. ShortcutsManager
   * listens on window, so it hears a key after the editors do, and a key it
   * takes (? opens Keyboard Shortcuts) mustn't move focus into the note first.
   * It reads the key as ShortcutsManager does.
   * @param {KeyboardEvent} e
   * @returns {boolean}
   */
  static isAppShortcut(e) {
    const shortcuts = /** @type {any} */ (window).ShortcutUtils;
    if (!shortcuts) return false;
    const target = /** @type {Element} */ (e.target);
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.getAttribute('contenteditable') === 'true';
    const modKey = navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? e.metaKey : e.ctrlKey;
    return shortcuts.getAppShortcutAction({
      code: e.code, key: e.key, modKey, shiftKey: e.shiftKey, altKey: e.altKey, isInput,
    }) !== null;
  }

  /**
   * Whether a modal, menu, or dialog is open in this editor's window. The
   * modals leave focus on the button that opened them, and a right-click
   * leaves it where it was, so while one is open typed letters stay out of
   * the note wherever focus is, and undo, redo, and delete act on it only
   * from its own pane. Open means in the page with no `hidden` class on it or
   * around it (see OPEN_OVERLAYS).
   * @returns {boolean}
   */
  _overlayOpen() {
    return Array.from(this.doc.querySelectorAll(OPEN_OVERLAYS)).some((element) => !element.closest('.hidden'));
  }

  /**
   * Whether focus is in an open modal, menu, or dialog (see _overlayOpen)
   * @returns {boolean}
   */
  _focusInOverlay() {
    const focused = this.doc.activeElement;
    const overlay = focused && typeof focused.closest === 'function' ? focused.closest(OPEN_OVERLAYS) : null;
    return Boolean(overlay) && !overlay.closest('.hidden');
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
      // The icon is packaged markup; the name and description are set as text
      const item = this._pickerItem('slash-menu-item', info.icon, info.name, info.description);
      item.dataset.type = type;
      item.dataset.index = String(index);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');

      this.slashMenuItems.appendChild(item);
    });
  }

  /**
   * Show slash menu
   */
  showSlashMenu(blockEl) {
    this._pickLive();
    // Under the block, or above it near the bottom, measured first (Utils.placeMenuBeside)
    Utils.placeMenuBeside(this.slashMenu, blockEl.getBoundingClientRect(), { gap: 4 });
    this.slashMenuVisible = true;
    this.slashMenuIndex = 0;
    this.updateSlashMenuSelection();
  }

  /**
   * Hide slash menu
   */
  hideSlashMenu() {
    if (this.slashMenu) this.slashMenu.classList.add('hidden');
    this.slashMenuVisible = false;
    this._announcePick(null);
  }

  /**
   * Close every menu this editor opens: the slash, link, and template menus,
   * a block's menu with Turn into, a selection's Turn into, and a table's
   * menu. Escape does this in both panes (App.closeAllModals), since an open
   * menu holds the keys pressed outside the note.
   * @returns {void}
   */
  hideMenus() {
    this.hideSlashMenu();
    this.hideWikiMenu();
    this.hideTemplateMenu();
    this.hideBlockActionMenu();
    this.hideTableContextMenu();
  }

  /**
   * Navigate slash menu
   */
  navigateSlashMenu(direction) {
    const items = this.slashMenuItems.querySelectorAll('.slash-menu-item');
    this.slashMenuIndex = Math.max(0, Math.min(items.length - 1, this.slashMenuIndex + direction));
    this.updateSlashMenuSelection();
    const picked = items[this.slashMenuIndex];
    const title = picked && picked.querySelector('.slash-menu-item-title');
    if (title) this._announcePick(title.textContent, this.slashMenuIndex, items.length);
  }

  /**
   * Update slash menu selection
   */
  updateSlashMenuSelection() {
    if (!this.slashMenuItems) return;
    const items = this.slashMenuItems.querySelectorAll('.slash-menu-item');
    items.forEach((item, index) => {
      item.classList.toggle('selected', index === this.slashMenuIndex);
      item.setAttribute('aria-selected', String(index === this.slashMenuIndex));
    });

    // Scroll into view
    const selected = items[this.slashMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * The polite live region where the slash and link menus say which item the arrow keys picked.
   * It's visually hidden, and there's one per document, which the editors in it share. A menu
   * makes it when it opens, so it's there before the first thing it says.
   * @returns {HTMLElement}
   */
  _pickLive() {
    let live = this.doc.getElementById('menu-pick-live');
    if (!live) {
      live = this.doc.createElement('div');
      live.id = 'menu-pick-live';
      live.className = 'menu-pick-live';
      live.setAttribute('aria-live', 'polite');
      this.doc.body.appendChild(live);
    }
    return live;
  }

  /**
   * Say which item the arrow keys picked, its label and its place, such as "Heading 1, 2 of 18".
   * Focus stays in the block while a menu is open, so this is how a screen reader hears what Enter
   * will pick. With no label, what the region says is cleared, as when a menu closes.
   * @param {string | null} label
   * @param {number} [index]
   * @param {number} [count]
   */
  _announcePick(label, index = 0, count = 0) {
    if (label) {
      this._pickLive().textContent = `${label}, ${index + 1} of ${count}`;
      return;
    }
    const live = this.doc && this.doc.getElementById ? this.doc.getElementById('menu-pick-live') : null;
    if (live) live.textContent = '';
  }

  /**
   * Select slash menu item
   */
  selectSlashMenuItem() {
    const items = this.slashMenuItems.querySelectorAll('.slash-menu-item');
    const selected = items[this.slashMenuIndex];
    if (selected) {
      const type = selected.dataset.type;
      this.turnInto(this.activeBlock, type);
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
      this.turnInto(this.activeBlock, type);
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

    // Set block content data for drag-to-sidebar (Req 46.1). A block in a safe state moves within
    // the note, and carries nothing the sidebar would store as a new block (#14 slice 3)
    const block = this.getBlockById(blockEl.dataset.id);
    if (block && !block.safeState()) {
      const textContent = this.extractBlockTextContent(block);
      e.dataTransfer.setData('application/x-block-content', textContent || '');
      e.dataTransfer.setData('application/x-block-type', block.type || 'text');
      e.dataTransfer.setData('application/x-block-html', block.content || '');
      // The drop keeps the markup only with this drag's token (#14 slice 2)
      e.dataTransfer.setData(Utils.BLOCK_DRAG_TOKEN, Utils.startBlockDrag());
    }
  }

  /**
   * Handle drag end
   */
  onDragEnd(e) {
    this.isDragging = false;
    this.draggedBlock = null;
    Utils.endBlockDrag();

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
    // The drop ends the drag, and a reorder's re-render removes the element its dragend would
    // reach, so the drag's token goes now (#14 slice 2)
    Utils.endBlockDrag();

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
   * Handle global paste event with smart content detection (Req 34.1–34.6).
   * A paste follows the rules keys do (see onGlobalKeyDown): it is one pane's,
   * a text field outside the note keeps it, and while a modal, menu, or dialog
   * is open only a paste with focus in this editor's own pane is the note's.
   * That last rule reads focus, not the target: with text selected in a block,
   * the target is that block wherever focus went.
   * @param {ClipboardEvent} e
   */
  onPaste(e) {
    if (!this._ownsDocumentEvent(e)) return;
    if (this._inTextField(/** @type {Element} */ (e.target))) return;
    if (!this._inOwnPane(this.doc.activeElement) && this._overlayOpen()) return;

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
    // No paste removes what a block holds (#14): a paste turns the block it's in only when that
    // block holds nothing, by the empty-note rule, so a text block with no text, no markup, no
    // image and no field its type doesn't own. Otherwise what it makes goes after the block.
    const isEmptyBlock = currentBlock && !globalThis.BlockProjections.isMeaningful(currentBlock.serialize());

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
      // An empty block turns only when that removes nothing it holds (#14 slice 3); otherwise
      // the code goes after it
      if (isEmptyBlock && this.changeBlockType(currentBlock.id, 'code')) {
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
      // Blocks made from pasted text are written only when each decodes as a known block (#14)
      // A refused paste says so, as a refused import, AI insert or drop does
      if (parsedBlocks && Utils.blockRefusal(parsedBlocks, this.logger)) {
        Utils.showToast('Failed to paste content', 'error');
        return;
      }

      if (parsedBlocks && parsedBlocks.length > 0) {
        let afterId = currentBlock ? currentBlock.id : null;

        // If current block is empty, replace it with the first parsed block, when turning it
        // removes nothing it holds (#14 slice 3)
        if (isEmptyBlock && parsedBlocks.length > 0 && this.changeBlockType(currentBlock.id, parsedBlocks[0].type)) {
          const first = parsedBlocks.shift();
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
    // `/^```[\s\S]*```\s*$/m.test(text)` in one pass: a fence at a line's start, then a later
    // fence after which only white space runs to a line's end or the text's end. `test` read
    // any value as a string, and so does this.
    const source = `${text}`;
    const isLineEnd = (/** @type {string} */ c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
    let open = -1;
    for (let at = source.indexOf('```'); at !== -1; at = source.indexOf('```', at + 1)) {
      if (open === -1) {
        if (at === 0 || isLineEnd(source[at - 1])) open = at;
        continue;
      }
      if (at < open + 3) continue;
      let end = at + 3;
      while (end < source.length && !isLineEnd(source[end]) && /\s/.test(source[end])) end++;
      if (end === source.length || isLineEnd(source[end])) return true;
    }
    return false;
  }

  /**
   * Extract code content from fenced code block
   * @param {string} text
   * @returns {string}
   */
  extractFencedCode(text) {
    // `/^```[^\n]*\n?([\s\S]*?)```\s*$/`'s code, in one pass: the closing fence can only be
    // the one before the trailing white space, and the code starts after the opening line, or
    // at that fence when it's on the opening line
    if (!text.startsWith('```')) return text;
    let tail = text.length;
    while (tail > 0 && /\s/.test(text[tail - 1])) tail--;
    const close = tail - 3;
    if (close < 3 || !text.startsWith('```', close)) return text;
    const lineEnd = text.indexOf('\n', 3);
    const start = Math.min(lineEnd === -1 ? text.length : lineEnd + 1, close);
    return text.slice(start, close).replace(/\n$/, '');
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

    const backlinks = await this.documentClient.backlinks(this.noteId);

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
      item.addEventListener('click', () => this.navigation.openNote(note.id));
      list.appendChild(item);
    });
  }

  // ============ Saving ============

  /**
   * Set up save and load bookkeeping. Called from the constructor.
   * @returns {void}
   */
  _initPersistenceState() {
    /** @type {ReturnType<typeof setTimeout>|null} Pending debounce or 1 s retry timer */
    this.saveTimeout = null;
    /** The loaded note was edited after its last save started */
    this._loadedDue = false;
    /** True while a failed save waits for its retry (Req 25.4) */
    this._retryPending = false;
    /** @type {Map<string, EditorSaveState>} The newest failed save of each note, for its retry */
    this._retryCopies = new Map();
    /** Capture counter for EditorSaveState.seq */
    this._saveSeq = 0;
    /** @type {Map<string, number>} Newest capture per note whose transaction has opened */
    this._writtenSeq = new Map();
    /** @type {Map<string, number>} Per note, the newest capture whose save failed and that no later save stored */
    this._failedSeq = new Map();
    /** @type {string|null} The note a revert is replacing the blocks of, while it commits */
    this._revertingNoteId = null;
    /** A flush during the revert kept what was on screen as a snapshot */
    this._revertEditsKept = false;
    /** @type {Promise<void>} Resolves once the revert in progress is done */
    this._revertDone = Promise.resolve();
    /** A revert is running, from its confirm to its end; a second one is refused meanwhile */
    this._revertInFlight = false;
    /** @type {Set<{state: EditorSaveState, promise: Promise<void>}>} */
    this._inFlightSaves = new Set();
    /** Load counter; a load that is no longer the latest drops its result */
    this._loadSeq = 0;
    /** Quiet flushes running (flushSave): a failed retry's toast is left to their caller */
    this._quietFlushes = 0;
    /** True while an import holds saves (see holdSaves) */
    this._savesHeld = false;
    /** The save timer fired while saves were held */
    this._heldSaveDue = false;
    /** @type {Promise<void>|null} Resolves when the current hold ends */
    this._holdReleased = null;
    /** @type {((value?: any) => void)|null} */
    this._releaseHold = null;
    /** True once a save of the loaded note found it deleted: its text stays on screen, unsaved */
    this.noteGone = false;
    /** @type {HTMLElement|null} The notice that says so, with "Save as a new note" */
    this._noteGoneNotice = null;
    /** @type {Promise<void>|null} "Save as a new note" while it runs; loadNote waits for it */
    this._savingAsNew = null;
    /** @type {Set<string>} Deleted notes whose text "Save as a new note" saved under a new ID */
    this._rescuedIds = new Set();
    /** @type {EditorTitle|null} The title set since its note's last save, which every save of that note carries until one stores it */
    this._unsavedTitle = null;
    /** True once a save found the page's connection to the notes database gone: only a reload opens it again */
    this.reloadRequired = false;
    /** @type {HTMLElement|null} The notice that says so, with Reload */
    this._reloadNotice = null;
    /**
     * Each note's base (#33, #17): what this editor last saw commit of it (its saves, AI chat's
     * inserts and its reverts), or its load, which tells a close-time draft and each save what
     * this editor changed. `stored` is each block's digest as the note stores it, `orders` its
     * order as stored, and `sent` the editor's own serialization's digest at that order, for a
     * block whose stored shape differs (a 1.4.x record, a capture). `revision` is the content
     * revision, null when it isn't known, `updatedAt` the stored stamp as last read, which the
     * editor's own saves never move (QA1), `name` the name, and `seq` the base's place in the
     * page's save order. Kept for the loaded note and for each note with a save in flight or
     * waiting to retry, on a page that keeps drafts.
     * @type {Map<string, {seq: number, revision: (number|null), updatedAt: (number|null), name: (string|undefined), stored: Map<string, string>, sent: Map<string, string>, orders: Map<string, number>}>}
     */
    this._seen = new Map();
    /**
     * @type {Set<string>} The blocks whose delete this editor issued and hasn't seen settle. One
     * the editor shows again before its delete commits (an undo) goes whole with the next save,
     * which commits after the delete, so it ends stored as shown (#17, the per-pane save)
     */
    this._deleting = new Set();
    /**
     * @type {Map<string, string>} The id of each note's close-time draft, which its closing save
     * issued at the same close takes as its commandId (#33)
     */
    this._closingIds = new Map();
  }

  /**
   * A title was set on the loaded note, so its next save writes it. A title the AI sets after
   * one the user typed stays typed, as 1.4.x's save kept `titleManuallySet` once the user had
   * typed one.
   * @param {string} name
   * @param {'typed'|'generated'} origin
   * @returns {void}
   */
  _titleSet(name, origin) {
    if (!this.noteId) return;
    const pending = this._unsavedTitle;
    const typed = origin === 'typed' || Boolean(pending && pending.noteId === this.noteId && pending.origin === 'typed');
    /** @type {EditorTitle} */
    const title = { noteId: this.noteId, name, origin: typed ? 'typed' : 'generated' };
    this._unsavedTitle = title;
  }

  /**
   * Show the title stored for `noteId` once a save found it set by hand and kept out the
   * generated one it carried: in the title, the editor's copy, and the tab, while this editor
   * holds that note and no newer title waits to save. Schedules no save.
   * @param {string} noteId
   * @returns {void}
   */
  _showStoredTitle(noteId) {
    this.documentClient.readNote(noteId).then((stored) => {
      if (!stored || noteId !== this.noteId || !this.noteData) return;
      const pending = this._unsavedTitle;
      if (pending && pending.noteId === noteId) return;
      this.noteData.name = stored.name;
      this.noteData.titleManuallySet = stored.titleManuallySet;
      this.titleEl.textContent = stored.name || '';
      this.navigation.titleChanged(stored.name);
    }, (error) => {
      console.warn('Could not read the title the note kept', error && error.message);
    });
  }

  /**
   * @param {*} error - What a document client read threw
   * @returns {boolean} True when it failed because the page lost its connection to the database
   */
  _isReloadRequired(error) {
    const state = error && error.cause;
    return Boolean(state && state.code === 'reload-required');
  }

  /**
   * Delete blocks the user deleted from the loaded note, as their own command. Its transaction
   * opens before this returns, so a save that starts later can't write the blocks back.
   * @param {Array<string>} blockIds
   * @returns {Promise<void>}
   */
  _deleteStoredBlocks(blockIds) {
    if (!this.noteId || blockIds.length === 0) return Promise.resolve();
    const noteId = this.noteId;
    for (const id of blockIds) this._deleting.add(id);
    const settled = () => {
      for (const id of blockIds) this._deleting.delete(id);
    };
    return this.documentClient.deleteBlocks(noteId, blockIds).then((outcome) => {
      settled();
      if (outcome.kind === 'committed') {
        // They're gone as stored, so a close-time draft no longer lists them (#33). The base's
        // revision moves only to the delete's own, one past it, since nothing else committed then.
        // A delete that deleted nothing moves none, and answers the note's revision as it is, so
        // any other one there is another writer's commit
        const seen = this._seen.get(noteId);
        if (seen) {
          for (const id of blockIds) {
            seen.stored.delete(id);
            seen.sent.delete(id);
            seen.orders.delete(id);
          }
          if (seen.revision !== null && outcome.revision !== seen.revision) {
            seen.revision = outcome.changedIds.includes(noteId) ? nextRevision(seen.revision, outcome.revision) : null;
          }
        }
        return;
      }
      if (outcome.kind === 'unavailable' && outcome.code === 'reload-required') {
        this._onReloadRequired();
        return;
      }
      // Codes only, never what the blocks hold
      console.error('Failed to delete blocks:', outcome.kind, outcome.code);
    }, (error) => {
      settled();
      throw error;
    });
  }

  // ============ Close-time drafts (#33) ============

  /**
   * The page's close-time draft writer (js/kernel/composition/close-draft-writer.js), which the
   * document client hands its editors, or null on a page that keeps none
   * @returns {{page: string, digest: (block: Object, noteId: string) => string, write: (fields: Object) => boolean}|null}
   */
  _drafts() {
    return (this.documentClient && this.documentClient.closeDrafts) || null;
  }

  /**
   * The loaded note's blocks as a save writes them: serialized, with `canvasId` and `order` set
   * @param {string} noteId
   * @returns {Array<Object>}
   */
  _serializedBlocks(noteId) {
    return this.blocks.map((block, index) => {
      const data = block.serialize();
      // Field name 'canvasId' kept for backward compatibility
      data.canvasId = noteId;
      data.order = index;
      return data;
    });
  }

  /**
   * The loaded note is what's stored, as the open read it: its close-time draft holds what
   * changes from here (#33). The base takes the open's revision and stamp, each block's digest
   * as stored, and the editor's own serialization's where the two differ. Notes with nothing in
   * flight or waiting to retry are forgotten.
   * @param {Array<Object>} records - the blocks as the open read them
   * @param {number|null} revision - the note's content revision as the open read it
   * @param {number} seq - the page's save order when the open began
   * @returns {void}
   */
  _rememberLoaded(records, revision, seq) {
    if (!this._drafts()) return;
    this._forgetIdleBases();
    const noteId = this.noteId;
    this._seen.set(noteId, {
      seq,
      revision,
      updatedAt: typeof this.noteData.updatedAt === 'number' ? this.noteData.updatedAt : null,
      name: this.noteData.name,
      ...this._baseDigests(noteId, records),
    });
    prunePageSaves(noteId);
  }

  /**
   * Forget the base of each note this editor doesn't show and has no save of in flight or
   * waiting to retry, and the page's saves kept for it alone (#33)
   * @returns {void}
   */
  _forgetIdleBases() {
    const holding = new Set(this._retryCopies.keys());
    if (this.noteId) holding.add(this.noteId);
    for (const { state } of this._inFlightSaves) holding.add(state.noteId);
    for (const noteId of [...this._seen.keys()]) {
      if (holding.has(noteId)) continue;
      this._seen.delete(noteId);
      prunePageSaves(noteId);
    }
  }

  /**
   * A base's digests of the loaded note, whose blocks the editor shows as `records` stores them:
   * each block's as stored and its order as stored, and the editor's own serialization's digest
   * at that order where the two differ
   * @param {string} noteId
   * @param {Array<Object>} records - the note's blocks as stored
   * @returns {{stored: Map<string, string>, sent: Map<string, string>, orders: Map<string, number>}}
   */
  _baseDigests(noteId, records) {
    const drafts = this._drafts();
    const stored = new Map(records.map((record) => [record.id, drafts.digest(record, noteId)]));
    /** @type {Map<string, number>} */
    const orders = new Map();
    for (const record of records) if (typeof record.order === 'number') orders.set(record.id, record.order);
    const sent = new Map();
    for (const block of this._serializedBlocks(noteId)) {
      const at = orders.get(block.id);
      const digest = drafts.digest(at === undefined ? block : { ...block, order: at }, noteId);
      if (stored.get(block.id) !== digest) sent.set(block.id, digest);
    }
    return { stored, sent, orders };
  }

  /**
   * How a block of the loaded note stands against the note's base (#17, the per-pane save):
   * 'put' when its fields differ from the base's at the order the base has it at, when the base
   * has no such block, or when its delete is still in flight, so an undo that brings it back
   * before the delete commits still stores it; 'move' when only its order differs; and null
   * when neither
   * @param {{stored: Map<string, string>, sent: Map<string, string>, orders: Map<string, number>}} seen
   * @param {Object} block - serialized, as a save writes it
   * @param {string} noteId
   * @returns {'put'|'move'|null}
   */
  _changeOf(seen, block, noteId) {
    if (this._deleting.has(block.id)) return 'put';
    const was = seen.sent.has(block.id) ? seen.sent.get(block.id) : seen.stored.get(block.id);
    if (was === undefined) return 'put';
    const at = seen.orders.get(block.id);
    const atBase = at === undefined || at === block.order ? block : { ...block, order: at };
    if (this._drafts().digest(atBase, noteId) !== was) return 'put';
    return at !== undefined && at !== block.order ? 'move' : null;
  }

  /**
   * A save of `state` committed: what it sent is what's stored now, as far as this editor knows.
   * Each block it sent takes the digest and order it sent, and the revision stays known only
   * when the save committed right after the base's, so nothing else did in between
   * (nextRevision). One the connection's close cut short (`'stored'`) has no revision, so a
   * draft goes by its digests. A block it only moved and that's stored in a shape the editor
   * doesn't write keeps its stored digest, which the move changed in a way the editor can't
   * tell, and its own serialization's moves. Only a newer save than the base moves it.
   * @param {EditorSaveState} state
   * @param {number|null} revision - the outcome's, null when it gives none
   * @param {{nameKnown?: boolean}} [options] - nameKnown false: the save's generated title was
   *   kept out, so the stored name isn't known
   * @returns {void}
   */
  _sawCommit(state, revision, { nameKnown = true } = {}) {
    const seen = this._seen.get(state.noteId);
    const issued = state.issued;
    if (!seen || !issued || issued.seq <= seen.seq) return;
    for (const [id, digest] of issued.blocks) {
      if (issued.moved.has(id) && seen.sent.has(id)) {
        seen.sent.set(id, digest);
      } else {
        seen.stored.set(id, digest);
        seen.sent.delete(id);
      }
      const order = issued.orders.get(id);
      if (order !== undefined) seen.orders.set(id, order);
    }
    seen.revision = nextRevision(seen.revision, revision);
    if (!nameKnown) seen.name = undefined;
    else if (issued.name !== undefined) seen.name = issued.name;
    seen.seq = issued.seq;
    prunePageSaves(state.noteId);
  }

  /**
   * AI chat's insert into the loaded note (placeInsertedBlocks): once it commits, the note's base
   * takes the blocks as the insert stored them, so a draft holds only what changes after it
   * (R160's B1). That's each inserted block at its place, with the editor's own serialization
   * where the two differ, and each block the insert moved down whose copy here is still the
   * base's. A block typed into since the base keeps its digests, so its edit stays in a draft,
   * and so does the stored digest of a moved block stored in another shape, which the editor
   * can't tell: only its own serialization's moves. The base waits for this editor's saves that
   * were writing, so their commits come first, and keeps its place in the page's save order, so
   * the saves issued since still count as the page's own. Its revision stays known only when
   * the insert committed right after the base's (nextRevision); otherwise a draft goes by its
   * digests.
   * @param {string} noteId
   * @param {Array<Object>} inserted - the blocks as insertBlocks takes them
   * @param {number} at - where the editor placed them
   * @param {Array<Object>} before - the editor's blocks before it placed them, serialized
   * @param {Promise<{kind: string}>} inserting - the insert's outcome
   * @returns {void}
   */
  _sawInsert(noteId, inserted, at, before, inserting) {
    const drafts = this._drafts();
    const seen = drafts ? this._seen.get(noteId) : null;
    if (!seen) return;
    const after = this._serializedBlocks(noteId);
    /** @type {Map<string, string>} */
    const stored = new Map();
    /** @type {Map<string, string>} */
    const sent = new Map();
    /** @type {Map<string, number>} */
    const orders = new Map();
    inserted.forEach((data, offset) => {
      const order = at + offset;
      const asStored = drafts.digest({ ...data, order }, noteId);
      const own = drafts.digest(after[order], noteId);
      stored.set(data.id, asStored);
      orders.set(data.id, order);
      if (own !== asStored) sent.set(data.id, own);
    });
    // The insert moves down each stored block at or past its place, by as many as it puts
    for (const block of before.slice(at)) {
      const was = seen.orders.get(block.id);
      if (was === undefined || was < at || this._changeOf(seen, block, noteId) === 'put') continue;
      const order = was + inserted.length;
      (seen.sent.has(block.id) ? sent : stored).set(block.id, drafts.digest({ ...block, order }, noteId));
      orders.set(block.id, order);
    }
    const seq = ++pageSeq;
    const writing = Array.from(this._inFlightSaves).filter(({ state }) => state.written).map((entry) => entry.promise);
    const settled = writing.length > 0 ? Promise.all([inserting, ...writing]).then(([outcome]) => outcome) : inserting;
    settled.then((outcome) => {
      const base = this._seen.get(noteId);
      if (!outcome || outcome.kind !== 'committed' || !base || base.seq >= seq) return;
      for (const [id, digest] of stored) {
        base.stored.set(id, digest);
        if (!sent.has(id)) base.sent.delete(id);
      }
      for (const [id, digest] of sent) base.sent.set(id, digest);
      for (const [id, order] of orders) base.orders.set(id, order);
      base.revision = nextRevision(base.revision, /** @type {{revision?: number}} */ (outcome).revision);
    }, () => {});
  }

  /**
   * The editor's own revert committed, and what it shows is what the restore stored: the note's
   * base now, so a draft holds only what changes after it (R160's B1). A restore replaces every
   * block of the note, so the base takes the whole of it, with the restore's revision, the title
   * it set, if any, and the page's save order when its transaction opened, after every save it
   * overwrote. The stamp stays the load's (QA1).
   * @param {string} noteId
   * @param {{records: Array<Object>, revision: (number|null), name?: string, seq: number}} commit -
   *   the blocks as stored, in order
   * @returns {void}
   */
  _sawRevert(noteId, { records, revision, name, seq }) {
    const seen = this._drafts() ? this._seen.get(noteId) : null;
    if (!seen || seq < seen.seq) return;
    Object.assign(seen, this._baseDigests(noteId, records), { seq, revision });
    if (name !== undefined) seen.name = name;
    prunePageSaves(noteId);
  }

  /**
   * What this editor's saves of `noteId` in flight sent, all but `except`, and how: 'put' for a
   * block any of them put, and 'move' for one they only moved
   * @param {string} noteId
   * @param {EditorSaveState} [except]
   * @returns {Map<string, 'put'|'move'>}
   */
  _sentInFlight(noteId, except) {
    /** @type {Map<string, 'put'|'move'>} */
    const inFlight = new Map();
    for (const { state: other } of this._inFlightSaves) {
      if (other === except || other.noteId !== noteId || !other.written || !other.issued) continue;
      for (const id of other.issued.blocks.keys()) {
        if (inFlight.get(id) !== 'put') inFlight.set(id, other.issued.moved.has(id) ? 'move' : 'put');
      }
    }
    return inFlight;
  }

  /**
   * What `blocks` of note `noteId` put and move against its base (#17, the per-pane save): each
   * block whose fields changed since, or that the base has none of, whole; each block that only
   * moved, by its new order; and each block a save of this editor still in flight sent, but
   * `except`, again in the form it went in, so a later save never leaves an earlier one's text or
   * order standing when it's back to the base's. A save sends that, and a close-time draft holds
   * it the same way, a block the pane only moved as its move, never whole (#33, #6).
   * @param {string} noteId
   * @param {Array<Object>} blocks - serialized, as a save writes them
   * @param {EditorSaveState} [except] - the save they're for
   * @returns {{put: Array<Object>, moves: Array<{id: string, order: number}>}}
   */
  _saveChanges(noteId, blocks, except) {
    const seen = this._seen.get(noteId);
    const inFlight = this._sentInFlight(noteId, except);
    const put = [];
    const moves = [];
    for (const block of blocks) {
      const own = this._changeOf(seen, block, noteId);
      const before = inFlight.get(block.id);
      const change = own === 'put' || before === 'put' ? 'put' : own || before || null;
      if (change === 'put') put.push(block);
      else if (change === 'move') moves.push({ id: block.id, order: block.order });
    }
    return { put, moves };
  }

  /**
   * The close-time draft of `noteId`'s edit: the blocks changed since the base, the ones deleted
   * since, the moves of the ones it only moved, and the title when it changed since, with the
   * base the applier reads (the stack's format, js/kernel/core/domain/close-draft.js). The base
   * names only the draft's own blocks, which are all the applier reads it for: their digests,
   * and each moved block's order, as the page last saw it commit and as its saves since gave it,
   * while that save's digest of the block stands, so the next start can tell another writer's
   * reorder since and keep it (#6). All of the blocks, and no move, when the editor holds no base
   * of the note.
   * @param {string} noteId
   * @param {Array<Object>} blocks - serialized, as a save writes them
   * @param {EditorTitle|null} title - the title set since the note's last save, if any
   * @returns {Object|null} null when nothing changed since the base
   */
  _closeDraftOf(noteId, blocks, title) {
    const seen = this._seen.get(noteId) || null;
    const { put: changed, moves } = seen ? this._saveChanges(noteId, blocks) : { put: blocks, moves: [] };
    const present = new Set(blocks.map((block) => block.id));
    const deleted = seen ? [...seen.stored.keys()].filter((id) => !present.has(id)) : [];
    const named = title && title.noteId === noteId && (!seen || title.name !== seen.name) ? title : null;
    if (seen && changed.length === 0 && moves.length === 0 && deleted.length === 0 && !named) return null;
    const ids = new Set([...changed.map((block) => block.id), ...deleted]);
    const moved = new Set(moves.map((move) => move.id));
    /** @param {Map<string, string>} digests - by block id, the draft's own blocks only */
    const ofDraft = (digests) => Object.fromEntries([...digests].filter(([id]) => ids.has(id)));
    /**
     * @param {Map<string, number>|undefined} orders - by block id: the draft's moved blocks', when it moves any
     * @param {Map<string, string>} [standing] - an issued save's digests: its order of a block counts only while
     *   its digest of the block stands, so not once the page's own later commit wrote the block again
     */
    const ofMoves = (orders, standing) => (moved.size > 0 && orders
      ? { orders: Object.fromEntries([...orders].filter(([id]) => moved.has(id) && (!standing || standing.has(id)))) }
      : {});
    const issuedSaves = (pageSaves.get(noteId) || [])
      .filter((save) => !seen || save.seq > seen.seq)
      .map((save) => ({ ...(save.name === undefined ? {} : { name: save.name }), blocks: ofDraft(save.blocks), ...ofMoves(save.orders, save.blocks) }));
    // A block stored in a shape the editor doesn't write (a 1.4.x record, a capture) that another
    // tab saved since, unchanged, is stored as the editor writes it: that copy is the base's too
    // (R160's N1)
    const own = seen ? ofDraft(seen.sent) : {};
    if (Object.keys(own).length > 0) issuedSaves.push({ blocks: own });
    const meta = this._computeSaveData(blocks);
    return {
      noteId,
      base: {
        revision: seen ? seen.revision : null,
        updatedAt: seen ? seen.updatedAt : null,
        ...(seen && seen.name !== undefined ? { name: seen.name } : {}),
        blocks: seen ? ofDraft(seen.stored) : {},
        ...(seen ? ofMoves(seen.orders) : {}),
        issuedSaves,
      },
      blocks: changed,
      ...(moves.length > 0 ? { orders: moves } : {}),
      deletedBlockIds: deleted,
      preview: meta.preview,
      todoProgress: meta.todoProgress,
      linkedNames: globalThis.BlockProjections.wikiLinkNames(meta.text),
      ...(named ? { name: named.name, titleOrigin: named.origin } : {}),
    };
  }

  /**
   * At the page's own close, before any editor issues its closing write: one close-time draft for
   * each note this editor holds an edit of that it hasn't seen commit, written to localStorage at
   * once, which a closing page always manages, whatever IndexedDB is doing. The next start applies
   * it (js/kernel/core/application/close-drafts.js). That covers an edit pending, in flight,
   * failed, or refused because the page lost its connection (V7). Each draft's id is the
   * commandId the closing save of its note takes, if the editor issues one. A draft that doesn't
   * fit is skipped, and the closing write still runs. Nothing for a note the editor found deleted,
   * or one whose blocks a revert is replacing, whose typing goes to version history instead.
   * @returns {void}
   */
  _writeCloseDraft() {
    const drafts = this._drafts();
    if (!drafts) return;
    /** @type {Map<string, EditorSaveState>} The newest copy in flight or waiting to retry of each note the editor left */
    const left = new Map();
    const take = (/** @type {EditorSaveState} */ state) => {
      if (state.noteId === this.noteId || !state.blocks || this._isSuperseded(state)) return;
      const kept = left.get(state.noteId);
      if (!kept || kept.seq < state.seq) left.set(state.noteId, state);
    };
    for (const { state } of this._activeSaves()) take(state);
    for (const copy of this._retryCopies.values()) take(copy);

    const edits = [];
    if (this.noteId && this.noteData && !this.noteGone && !this._isReverting()) {
      const title = this._unsavedTitle && this._unsavedTitle.noteId === this.noteId ? this._unsavedTitle : null;
      edits.push(this._closeDraftOf(this.noteId, this._serializedBlocks(this.noteId), title));
    }
    for (const state of left.values()) edits.push(this._closeDraftOf(state.noteId, state.blocks, state.title));
    for (const fields of edits) {
      if (!fields) continue;
      const id = this.documentClient.newId();
      this._closingIds.set(fields.noteId, id);
      drafts.write({ id, ...fields });
    }
  }

  /**
   * Schedule save with debounce (Req 25.1).
   * Batches multiple rapid edits into a single save with a 500ms delay.
   * @returns {void}
   */
  scheduleSave() {
    this.updateSaveStatus('Saving...');
    this._snapshotDirty = true;
    this._loadedDue = true;
    this._armSaveTimer(500);
  }

  /**
   * Arm the save timer. The 1 s retry shares the handle, so a pending retry
   * counts as a pending save for flushSave and the page-hide flush, and a
   * debounce that fires first runs the retry with it.
   * @param {number} delay
   * @returns {void}
   */
  _armSaveTimer(delay) {
    clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      if (this._savesHeld) {
        this._heldSaveDue = true;
        return;
      }
      this._startDue();
    }, delay);
  }

  /**
   * Cancel the pending timer and report whether anything was due: an edit, a
   * retry, or a save that came due while held.
   * @returns {boolean}
   */
  _takePendingSave() {
    const due = this.saveTimeout !== null || this._heldSaveDue || this._retryCopies.size > 0;
    clearTimeout(this.saveTimeout);
    this.saveTimeout = null;
    this._heldSaveDue = false;
    return due;
  }

  /**
   * Take what a due save covers: the loaded note when it was edited or its
   * last save failed, and the failed copy of each note the editor has left.
   * @returns {{loaded: boolean, loadedIsRetry: boolean, others: Array<EditorSaveState>}}
   */
  _takeDueWork() {
    // A copy is moot once a newer write of its note has opened.
    const copies = Array.from(this._retryCopies.values()).filter((copy) => !this._isSuperseded(copy));
    this._retryCopies.clear();
    this._retryPending = false;
    const loadedFailed = copies.some((copy) => copy.noteId === this.noteId);
    const work = {
      loaded: this._loadedDue || loadedFailed,
      // An edit after the failure makes this a fresh save, with its own retry.
      loadedIsRetry: loadedFailed && !this._loadedDue,
      others: copies.filter((copy) => copy.noteId !== this.noteId && copy.blocks),
    };
    this._loadedDue = false;
    return work;
  }

  /**
   * Start what came due (see _takeDueWork).
   * @returns {Promise<void>}
   */
  _startDue() {
    const { loaded, loadedIsRetry, others } = this._takeDueWork();
    const work = others.map((copy) => this._rewrite(copy));
    // While a revert commits, the loaded note's save waits for it, and then writes the
    // restored blocks (see _revertToSnapshot)
    if (loaded && this._isReverting()) {
      this._loadedDue = true;
      this._heldSaveDue = true;
      // Resolves once the revert is done and the save it lets through has finished, so a caller
      // that needs the note stored (AI insert, flushSave) waits for that, not for nothing
      const revert = this._revertDone;
      work.push(revert.then(() => this.flushSave()).then(() => {}));
    } else if (loaded) {
      work.push(this._startSave(loadedIsRetry));
    }
    return Promise.all(work).then(() => {});
  }

  /**
   * Save the loaded note now. Callers that need it stored before acting on it
   * (AI insert) await this.
   * @returns {Promise<void>}
   */
  save() {
    this._takePendingSave();
    this._loadedDue = true;
    return this._startDue();
  }

  /**
   * Write any pending save now, or wait for the one in flight. A pending retry
   * counts, and runs now. Writes nothing when nothing is pending. Answers
   * whether everything the editor holds is stored: false while an edit whose
   * save failed, its retry included, has no later save that stored it, while a
   * deleted note keeps its text on screen, and once the page has to reload with
   * an edit it can't write. A quiet flush (a reload's guard) leaves a failed
   * retry's toast to its caller, which says the failure itself.
   * @param {{quiet?: boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async flushSave({ quiet = false } = {}) {
    if (quiet) this._quietFlushes += 1;
    try {
      // A pending save, the retry it may schedule, and the saves in flight: a few rounds at most.
      for (let round = 0; round < 8; round++) {
        if (this._takePendingSave()) {
          await this._startDue();
          continue;
        }
        const active = this._activeSaves();
        if (active.length > 0) {
          await Promise.all(active.map((entry) => entry.promise));
          continue;
        }
        return this._failedSeq.size === 0 && !this.noteGone && !this.reloadRequired;
      }
      return false;
    } finally {
      if (quiet) this._quietFlushes -= 1;
    }
  }

  /**
   * Saves still to finish: transactions open, or saves waiting for a frame
   * that no newer write of their note has superseded.
   * @returns {Array<{state: EditorSaveState, promise: Promise<void>}>}
   */
  _activeSaves() {
    return Array.from(this._inFlightSaves).filter(({ state }) => state.written || !this._isSuperseded(state));
  }

  /**
   * @returns {boolean} True when a save is pending, waiting to retry, or in flight
   */
  _hasPendingSave() {
    return this.saveTimeout !== null || this._heldSaveDue || this._retryCopies.size > 0
      || this._activeSaves().length > 0;
  }

  /**
   * Wait for the saves whose transactions are open.
   * @returns {Promise<void>}
   */
  async _waitForWrites() {
    const writing = Array.from(this._inFlightSaves).filter(({ state }) => state.written);
    await Promise.all(writing.map((entry) => entry.promise));
  }

  /**
   * Start a save of the loaded note. Only the note is captured now; the
   * blocks are taken right before the transaction opens (_takeBlockSnapshot).
   * @param {boolean} [isRetry=false]
   * @returns {EditorSaveState|null} null when no note is loaded
   */
  _captureSaveState(isRetry = false) {
    if (!this.noteId || !this.noteData) return null;
    return {
      seq: ++this._saveSeq, noteId: this.noteId, noteData: this.noteData, blocks: null, title: null, written: false, isRetry,
    };
  }

  /**
   * Serialize the loaded note's blocks into `state`, synchronously, right
   * before its transaction opens. A block deleted while the save waited is
   * gone from them, so the save can't write it back.
   * @param {EditorSaveState} state
   * @returns {boolean} false when the editor no longer has that note loaded
   */
  _takeBlockSnapshot(state) {
    if (this.noteId !== state.noteId || !this.noteData) return false;
    const noteId = state.noteId;
    state.noteData = this.noteData;
    const title = this._unsavedTitle;
    state.title = title && title.noteId === noteId ? title : null;
    state.blocks = this._serializedBlocks(noteId);
    return true;
  }

  /**
   * Start a save of the loaded note and track it until it finishes.
   * @param {boolean} isRetry
   * @returns {Promise<void>}
   */
  _startSave(isRetry) {
    const state = this._captureSaveState(isRetry);
    if (!state) return Promise.resolve();
    return this._trackSave(state, this._runSave(state));
  }

  /**
   * @param {EditorSaveState} state
   * @param {Promise<void>} work
   * @returns {Promise<void>}
   */
  _trackSave(state, work) {
    const entry = { state, promise: Promise.resolve() };
    entry.promise = work.finally(() => {
      this._inFlightSaves.delete(entry);
    });
    this._inFlightSaves.add(entry);
    return entry.promise;
  }

  /**
   * Run one save: wait a frame (Req 25.2), then take the blocks, compute the
   * metadata, and open the note-and-blocks transaction in one synchronous
   * step. Afterwards update the search name, links, indexing, and sidebar,
   * and show "Saved" (Req 25.3).
   * @param {EditorSaveState} state
   * @returns {Promise<void>}
   */
  async _runSave(state) {
    try {
      await this._nextFrame();
      // A page-hide flush or a newer save of this note may have written it while we waited.
      if (state.written || this._isSuperseded(state)) return;
      // A newer save of this note waits too, and it writes the same, newer blocks.
      if (this._newerSaveWaiting(state)) return;
      // loadNote writes the note it leaves before switching, which supersedes this save.
      if (!this._takeBlockSnapshot(state)) {
        console.warn('Save skipped: the editor left the note before it was written', state.noteId);
        return;
      }
      const meta = this._computeSaveData(state.blocks);
      this._applySaveMeta(state, meta);
      this._afterSaveWrite(state, await this._writeSaveState(state, meta));
    } catch (error) {
      this._onSaveFailed(error, state);
    }
  }

  /**
   * Retry once after 1 s, then show the error toast (Req 25.4). The failed
   * copy is kept, so a retry after the editor has left its note writes that
   * note, not whichever note is loaded by then.
   * @param {*} error
   * @param {EditorSaveState} state
   * @returns {void}
   */
  _onSaveFailed(error, state) {
    console.error('Failed to save:', error);
    if ((this._failedSeq.get(state.noteId) || 0) < state.seq) this._failedSeq.set(state.noteId, state.seq);
    if (state.isRetry) {
      this.updateSaveStatus('Error saving');
      if (this._quietFlushes === 0) Utils.showToast('Failed to save note. Please try again.', 'error');
      return;
    }
    // A newer write of this note has opened since, and it holds this edit too.
    if (this._isSuperseded(state)) return;
    const kept = this._retryCopies.get(state.noteId);
    if (!kept || kept.seq < state.seq) this._retryCopies.set(state.noteId, state);
    this._retryPending = true;
    this.updateSaveStatus('Retrying...');
    // A pending debounce fires sooner and runs the retry with it.
    if (this.saveTimeout === null && !this._heldSaveDue) this._armSaveTimer(1000);
  }

  /**
   * @param {EditorSaveState} state
   * @returns {boolean} True when a newer capture of the same note has been written
   */
  _isSuperseded(state) {
    return (this._writtenSeq.get(state.noteId) || 0) > state.seq;
  }

  /**
   * @param {EditorSaveState} state
   * @param {{preview: string, todoProgress: Object|null}} meta
   * @returns {void}
   */
  _applySaveMeta(state, meta) {
    state.noteData.preview = meta.preview;
    state.noteData.todoProgress = meta.todoProgress;
  }

  /**
   * Save a captured state with saveNoteContent: its blocks, what the editor derived from them,
   * a title set since the last save, and the note names its wiki links hold. The command opens
   * its note-and-blocks transaction before this returns, and writes no other note field, so a
   * pin, folder move, or template conversion made meanwhile stays. The search entry's name and
   * the links follow in the same command, as 1.4.x's save updated them after the note.
   * @param {EditorSaveState} state
   * @param {{preview: string, todoProgress: Object|null, text: string}} meta
   * @returns {Promise<'saved'|'title-kept'|'stored'|'gone'|'reload'>} 'title-kept' when it saved
   *   everything but a generated title, which a title set by hand kept out; 'gone' when the note no longer exists and
   *   nothing was written; 'reload' when the page had lost its connection to the database, so
   *   nothing was written; 'stored' when the connection closed while the save ran: its
   *   note-and-blocks transaction had opened, and a closing connection lets it finish, but the
   *   search entry and links that follow it couldn't be written. Rejects when the save failed
   *   otherwise.
   * @param {boolean} [closing] - the page's own close: the save takes the id of the close-time
   *   draft its editor wrote for the same edit as its commandId (#33)
   */
  _writeSaveState(state, meta, closing = false) {
    state.written = true;
    if ((this._writtenSeq.get(state.noteId) || 0) < state.seq) {
      this._writtenSeq.set(state.noteId, state.seq);
    }
    // A save puts only what this editor changed since the last save it saw commit, and a block
    // it only moved goes by its order, so its copy of a block another pane or tab saved since
    // never goes over that save, and the note's preview and to-do progress come from its blocks
    // as stored (#33, #144, #17). It goes when it puts nothing too, so a title saves and the
    // record catches up after a delete. An editor with no base of the note saves the whole note.
    const partial = Boolean(this._drafts()) && this._seen.has(state.noteId);
    const changes = partial ? this._saveChanges(state.noteId, state.blocks, state) : { put: state.blocks, moves: [] };
    const save = {
      noteId: state.noteId,
      blocks: changes.put,
      ...(partial ? { deriveFromStored: true } : { preview: meta.preview, todoProgress: meta.todoProgress }),
      ...(changes.moves.length > 0 ? { orders: changes.moves } : {}),
      linkedNames: globalThis.BlockProjections.wikiLinkNames(meta.text),
    };
    if (state.title) Object.assign(save, { name: state.title.name, titleOrigin: state.title.origin });
    // What it sends, among the page's issued saves, so a close-time draft of the note from any of
    // the page's editors counts it as the page's own, committed or not (#33): each block it puts
    // or moves by its digest as it will be stored, and its order
    const drafts = this._drafts();
    if (drafts) {
      const byId = new Map(state.blocks.map((block) => [block.id, block]));
      const sent = [...changes.put, ...changes.moves.map((move) => byId.get(move.id))];
      state.issued = {
        seq: ++pageSeq,
        name: state.title ? state.title.name : undefined,
        blocks: new Map(sent.map((block) => [block.id, drafts.digest(block, state.noteId)])),
        orders: new Map(sent.map((block) => [block.id, block.order])),
        moved: new Set(changes.moves.map((move) => move.id)),
      };
      pageSaves.set(state.noteId, [...(pageSaves.get(state.noteId) || []), state.issued]);
    }
    const commandId = closing ? this._closingIds.get(state.noteId) : undefined;
    if (commandId) this._closingIds.delete(state.noteId);
    // Open now, the command's first transaction opens before this returns
    const openAtStart = typeof this.documentClient.connectionOpen === 'function'
      ? this.documentClient.connectionOpen()
      : true;
    return this.documentClient.saveContent(save, commandId ? { commandId } : undefined).then((outcome) => {
      if (outcome.kind === 'committed') state.committedRevision = typeof outcome.revision === 'number' ? outcome.revision : null;
      // The note had a title set by hand by the time it committed, so the generated one it carried was dropped
      if (outcome.kind === 'committed' && outcome.code === 'content-saved-title-kept') return 'title-kept';
      if (outcome.kind === 'committed') return 'saved';
      if (outcome.kind === 'rejected' && outcome.code === 'note-not-found') return 'gone';
      if (outcome.kind === 'unavailable' && outcome.code === 'reload-required') return openAtStart ? 'stored' : 'reload';
      // Its kind and code, never the note's content
      throw new Error(`The save was not stored (${outcome.kind}: ${outcome.code})`);
    });
  }

  /**
   * What follows a save's answer: "Saved", and search indexing and the sidebar's preview
   * catching up; or the notice for a deleted note, or for a page that has to reload.
   * @param {EditorSaveState} state
   * @param {'saved'|'title-kept'|'stored'|'gone'|'reload'} result
   * @returns {void}
   */
  _afterSaveWrite(state, result) {
    // A save that stored the note's text clears an older one's failure
    if (result !== 'gone' && result !== 'reload' && (this._failedSeq.get(state.noteId) || 0) <= state.seq) {
      this._failedSeq.delete(state.noteId);
    }
    // What it sent is the note's close-time draft base now (#33). A save the connection's close
    // cut short stored its text with no revision to say, and one whose generated title was kept
    // out leaves the stored name unknown here.
    if (result === 'saved' || result === 'title-kept') {
      this._sawCommit(state, state.committedRevision ?? null, { nameKnown: result === 'saved' });
    } else if (result === 'stored') {
      this._sawCommit(state, null);
    }
    // The page's commits of its blocks before this one are moot now. A save with no revision to
    // say keeps its place as one in flight.
    const committedAt = state.committedRevision;
    if (state.issued && typeof committedAt === 'number' && (result === 'saved' || result === 'title-kept')) {
      committedPageSave(state.noteId, state.issued.seq, committedAt, result === 'saved');
    }
    if (result === 'title-kept') this._showStoredTitle(state.noteId);
    if (result === 'gone') {
      this._onNoteGone(state);
      return;
    }
    if (result === 'stored') {
      // The note, its blocks, and its title are stored. The search entry is rebuilt at the next
      // start and the links on the note's next save. The page can't read or write anything
      // more, so the next edit gets the reload notice.
      if (state.title && this._unsavedTitle === state.title) this._unsavedTitle = null;
      if (!this.reloadRequired) this.updateSaveStatus('Saved');
      return;
    }
    if (result === 'reload') {
      this._onReloadRequired();
      return;
    }
    // The title it carried is stored, or was kept out, unless a newer one was set meanwhile
    if (state.title && this._unsavedTitle === state.title) this._unsavedTitle = null;
    state.noteData.updatedAt = Date.now();
    if (!this.reloadRequired) this.updateSaveStatus('Saved');
    this.navigation.noteSaved(state.noteData);
  }

  /**
   * Save metadata for a set of blocks: preview, todo progress, and the text
   * wiki links are read from.
   * @param {Array<Object>} blocks
   * @returns {{preview: string, todoProgress: Object|null, text: string}}
   */
  _computeSaveData(blocks) {
    let preview = '';
    let todoProgress = null;
    if (typeof SidebarUtils !== 'undefined') {
      const metadata = SidebarUtils.buildNoteSaveMetadata(blocks);
      preview = metadata.preview;
      todoProgress = metadata.todoProgress;
    }
    const text = this.getAllBlocksTextContent(blocks);
    return { preview, todoProgress, text };
  }

  /**
   * Wait for the next animation frame of this editor's own window, so a save
   * reads its metadata with that frame's other DOM reads instead of forcing a
   * layout (Req 25.2). The PiP editor follows the PiP window, which keeps
   * painting while the new tab is in the background.
   * @returns {Promise<void>}
   */
  _nextFrame() {
    const view = (this.doc && this.doc.defaultView) || window;
    return new Promise((resolve) => {
      view.requestAnimationFrame(() => resolve());
    });
  }

  /**
   * @param {EditorSaveState} state
   * @returns {boolean} True when a newer save of the same note is waiting for its frame
   */
  _newerSaveWaiting(state) {
    return this._activeSaves().some(({ state: other }) => !other.written
      && other.noteId === state.noteId && other.seq > state.seq);
  }

  /**
   * A closed pop-out's editor leaves the page's editors once its close save has committed, so it
   * and its closed document don't stay with the page. One whose save failed holds the edit for
   * its retry, so it stays, and the page's own close still writes its draft (#33).
   * @returns {void}
   */
  _leavePageWhenSaved() {
    // allSettled, so a save that ever rejects still leaves the decision to what's pending
    Promise.allSettled(this._activeSaves().map((entry) => entry.promise)).then(() => {
      if (!this._hasPendingSave()) pageEditors.delete(this);
    });
  }

  /**
   * Write pending edits when the page is hidden or closed. Each editor listens
   * on its own document and window, so the PiP editor covers the PiP window,
   * and the PiP editor also listens for this page's own close.
   * @returns {void}
   */
  _bindLifecycleFlush() {
    const doc = this.doc;
    pageEditors.add(this);
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') this._writePendingNow();
    });
    // Another context's upgrade closes the page's connection; what is pending goes first
    const stop = this.documentClient && typeof this.documentClient.beforeConnectionCloses === 'function'
      ? this.documentClient.beforeConnectionCloses(() => this._writePendingNow())
      : null;
    const win = doc.defaultView;
    if (win) {
      // Only this page's own close is one a close-time draft is for: the pop-out's (Document PiP)
      // editor lives in the pop-out's document, and when the pop-out closes, this page and its
      // connection stay. In a page, doc === document exactly for its own editors.
      const ownPage = doc === document;
      // The page's own close writes every editor's close-time draft, the pop-out's included,
      // before any of them issues its closing write, which can't commit while another page's
      // transaction holds the blocks (#33). Chromium fires pagehide before visibilitychange at a
      // close, so pagehide comes first here too. Bound once, ahead of every editor's own
      // listener. A page kept in the back/forward cache may come back with its edits, so it
      // writes none.
      if (ownPage && !closeDraftsBound) {
        closeDraftsBound = true;
        win.addEventListener('pagehide', (event) => {
          if (!event.persisted) writeCloseDrafts();
        });
      }
      // The pop-out's editor writes through this page's connection, and when the whole tab
      // closes, this page's pagehide fires before the pop-out's, so a write the pop-out opens
      // after it is lost. So the pop-out's editor also writes at this page's own close, with the
      // page's closing writes (#33). Its listener goes when the pop-out closes, so a pop-out
      // closed earlier leaves none on the page.
      const pageClose = ownPage ? null : new AbortController();
      if (pageClose) {
        window.addEventListener('pagehide', (event) => {
          if (!event.persisted) this._writePendingNow({ closing: true });
        }, { signal: pageClose.signal });
      }
      win.addEventListener('pagehide', (event) => {
        if (pageClose && !event.persisted) pageClose.abort();
        // The pop-out's own close is no close of this page, so its pending save goes whole
        this._writePendingNow({ closing: ownPage && !event.persisted });
        if (pageClose && !event.persisted) this._leavePageWhenSaved();
        // A PiP window that closes takes its editor with it
        if (stop && !ownPage) stop();
      });
    }
  }

  /**
   * Synchronously write what is pending: a timer (debounce or retry), a save
   * that came due while held, or a save still waiting for its frame. The
   * loaded note gets one fresh snapshot, which supersedes its waiting saves,
   * and each note the editor has left gets its newest failed copy. Hidden
   * pages don't run rAF and closing pages don't wait, so the metadata is
   * computed here and the transactions open before this returns.
   * Writes nothing when nothing is pending.
   * @param {{closing?: boolean}} [options] - closing: the page's own close, whose saves take the
   *   ids of the close-time drafts written for them (#33)
   * @returns {void}
   */
  _writePendingNow({ closing = false } = {}) {
    const waiting = this._activeSaves()
      .map((entry) => entry.state)
      .filter((state) => !state.written && state.noteId === this.noteId);
    const due = this._takePendingSave();
    if (!due && waiting.length === 0) return;

    const work = due ? this._takeDueWork() : { loaded: false, loadedIsRetry: false, others: [] };
    for (const copy of work.others) this._rewrite(copy, closing);
    if (!work.loaded && waiting.length === 0) return;
    // A revert is replacing the blocks on screen: what was typed into them goes into version
    // history, and none of it goes back onto the note over the restored blocks
    if (this._isReverting()) {
      this._keepEditsOfRevert();
      return;
    }

    const isRetry = work.loaded ? work.loadedIsRetry : waiting.every((state) => state.isRetry);
    const state = this._captureSaveState(isRetry);
    if (state && this._takeBlockSnapshot(state)) this._writeNow(state, closing);
  }

  /**
   * Write a failed save's copy again, as its retry, after the editor has left
   * that note. It keeps its capture order, so it can't supersede a newer save
   * of the note.
   * @param {EditorSaveState} copy
   * @param {boolean} [closing] - the page's own close (#33)
   * @returns {Promise<void>}
   */
  _rewrite(copy, closing = false) {
    return this._writeNow({ ...copy, written: false, isRetry: true }, closing);
  }

  /**
   * Write a state whose blocks are taken, without waiting for a frame. The
   * transaction opens before this returns.
   * @param {EditorSaveState} state
   * @param {boolean} [closing] - the page's own close (#33)
   * @returns {Promise<void>}
   */
  _writeNow(state, closing = false) {
    let work;
    try {
      const meta = this._computeSaveData(state.blocks);
      this._applySaveMeta(state, meta);
      work = this._writeSaveState(state, meta, closing).then((result) => this._afterSaveWrite(state, result));
    } catch (error) {
      work = Promise.reject(error);
    }
    return this._trackSave(state, work.catch((error) => this._onSaveFailed(error, state)));
  }

  /**
   * Hold saves while another writer commits (import). Edits still schedule
   * saves; one that comes due waits for releaseSaves. flushSave and the
   * page-hide flush still write.
   * @returns {void}
   */
  holdSaves() {
    if (this._savesHeld) return;
    this._savesHeld = true;
    this._holdReleased = new Promise((resolve) => {
      this._releaseHold = resolve;
    });
  }

  /**
   * End a hold and start any save that came due during it.
   * @returns {void}
   */
  releaseSaves() {
    if (!this._savesHeld) return;
    const release = this._releaseHold;
    this._savesHeld = false;
    this._holdReleased = null;
    this._releaseHold = null;
    if (release) release();
    if (this._heldSaveDue) {
      this._heldSaveDue = false;
      this._startDue();
    }
  }

  /**
   * Take on trash or archive flags another writer stored for the loaded note
   * (import Replace), so the editor shows them. saveNoteWithBlocks keeps the
   * stored flags in any case.
   * @param {{trashed?: boolean, trashedAt?: number|null, archived?: boolean, archivedAt?: number|null}} flags
   * @returns {void}
   */
  adoptNoteFlags(flags) {
    if (this.noteData) Object.assign(this.noteData, flags);
  }

  /**
   * A save found its note deleted, so nothing was written. While the editor
   * shows that note it says so, keeps the text on screen, and offers "Save as a
   * new note"; nothing is created on its own. Changes to a note the editor has
   * left (a failed save's retry) get a toast.
   * @param {EditorSaveState} state
   * @returns {void}
   */
  _onNoteGone(state) {
    if (state.noteId !== this.noteId) {
      // Nothing can store the left note's changes any more, and the toast says so, so its
      // failure no longer holds the editor's flush
      this._failedSeq.delete(state.noteId);
      // A write that was in flight when "Save as a new note" took the text is moot
      if (!this._rescuedIds.has(state.noteId)) {
        Utils.showToast("A note you edited was deleted, so its last changes aren't saved.", 'error');
      }
      return;
    }
    this.noteGone = true;
    this.updateSaveStatus('Not saved');
    if (this._noteGoneNotice) return;

    const notice = this.doc.createElement('div');
    notice.className = 'note-gone-notice';
    notice.setAttribute('role', 'alert');
    const text = this.doc.createElement('p');
    text.className = 'note-gone-text';
    // Focusable from script, so a part's Reload can hand over to these words (ownNoticeText)
    text.setAttribute('tabindex', '-1');
    text.textContent = "This note was deleted, so these changes aren't saved.";
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'primary-btn note-gone-btn';
    button.textContent = 'Save as a new note';
    button.addEventListener('click', () => this.saveAsNewNote());
    notice.appendChild(text);
    notice.appendChild(button);
    const column = this.root.querySelector('.editor') || this.root;
    column.insertBefore(notice, column.firstChild);
    this._noteGoneNotice = notice;
  }

  /**
   * The words of the notice this editor shows for changes it couldn't save: the reload-required
   * notice's, or the deleted note's. A part's Reload that a save stopped moves focus there, where
   * a screen reader reads the sentence, Enter does nothing, and Tab reaches the notice's button,
   * whose Reload runs no save guards (#27 slice 3b). Null when it shows neither.
   * @returns {HTMLElement | null}
   */
  ownNoticeText() {
    const notice = this._reloadNotice || this._noteGoneNotice;
    return notice ? notice.querySelector('.note-gone-text') : null;
  }

  /**
   * A save of this editor's failed, its one retry included, and nothing has stored it since
   * @returns {boolean}
   */
  hasFailedSave() {
    return this._failedSeq.size > 0;
  }

  /**
   * @returns {void}
   */
  _clearNoteGone() {
    if (this._noteGoneNotice) this._noteGoneNotice.remove();
    this._noteGoneNotice = null;
    this.noteGone = false;
  }

  /**
   * A save or delete found the page's connection to the notes database gone: another context
   * upgraded or deleted the database, or Chrome closed the connection. Nothing is written, and
   * nothing is retried, since only a reload opens the database again. The text stays on screen
   * with a notice, in the deleted-note notice's form, whose Reload reloads the page.
   * @returns {void}
   */
  _onReloadRequired() {
    this.reloadRequired = true;
    this.updateSaveStatus('Not saved');
    if (this._reloadNotice) return;

    const notice = this.doc.createElement('div');
    notice.className = 'note-gone-notice reload-notice';
    notice.setAttribute('role', 'alert');
    const text = this.doc.createElement('p');
    text.className = 'note-gone-text';
    // Focusable from script, so a part's Reload can hand over to these words (ownNoticeText)
    text.setAttribute('tabindex', '-1');
    text.textContent = "This page lost its connection to your notes, so these changes aren't saved. Copy anything you need, then reload.";
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'primary-btn note-gone-btn';
    button.textContent = 'Reload';
    button.addEventListener('click', () => this.navigation.reloadPage());
    notice.appendChild(text);
    notice.appendChild(button);
    const column = this.root.querySelector('.editor') || this.root;
    column.insertBefore(notice, column.firstChild);
    this._reloadNotice = notice;
  }

  /**
   * "Save as a new note": a deleted note's text, still on screen, becomes a new
   * active note with the same title, pin, and folder if it still exists. The
   * editor keeps its blocks, under new IDs so they never share a record with
   * the deleted note's, and writes them to the new note from here on, and the
   * note's tab follows. A loadNote called meanwhile waits for it.
   * @returns {Promise<void>}
   */
  saveAsNewNote() {
    if (!this._savingAsNew && this.noteGone) {
      this._savingAsNew = this._saveAsNewNote().finally(() => {
        this._savingAsNew = null;
      });
    }
    return this._savingAsNew || Promise.resolve();
  }

  /**
   * @returns {Promise<void>}
   */
  async _saveAsNewNote() {
    const goneId = this.noteId;
    const gone = this.noteData || {};
    const fields = {
      noteId: this.documentClient.newId(),
      name: gone.name || 'Untitled',
      pinned: Boolean(gone.pinned),
      titleManuallySet: Boolean(gone.titleManuallySet),
    };
    // Its folder while that's still there (Replace all takes folders too), else the root: a note in a missing folder shows nowhere
    let outcome = await this.documentClient.createNote({ ...fields, folderId: gone.folderId || null });
    if (outcome.kind === 'rejected' && outcome.code === 'folder-not-found') {
      outcome = await this.documentClient.createNote({ ...fields, folderId: null });
    }
    if (outcome.kind !== 'committed') {
      console.error('Save as a new note failed:', outcome.kind, outcome.code);
      if (outcome.kind === 'unavailable' && outcome.code === 'reload-required') this._onReloadRequired();
      else Utils.showToast("Couldn't save this as a new note. Try again.", 'error');
      return;
    }
    const note = await this.documentClient.readNote(fields.noteId).catch(() => null)
      || { id: fields.noteId, name: fields.name, pinned: fields.pinned, titleManuallySet: fields.titleManuallySet };
    // The deleted note's pending and failed saves can't land anywhere; the new note gets all the text.
    this._takePendingSave();
    this._retryCopies.delete(goneId);
    this._failedSeq.delete(goneId);
    this._rescuedIds.add(goneId);
    // The new note has the title already
    this._unsavedTitle = null;
    this.noteId = note.id;
    this.noteData = note;
    for (const block of this.blocks) block.id = Utils.generateId();
    // The new note is stored with no blocks, so a close-time draft holds all of them (#33)
    this._seen.delete(goneId);
    prunePageSaves(goneId);
    if (this._drafts()) {
      this._seen.set(note.id, {
        seq: pageSeq,
        revision: typeof outcome.revision === 'number' ? outcome.revision : null,
        updatedAt: typeof note.updatedAt === 'number' ? note.updatedAt : null,
        name: note.name,
        stored: new Map(),
        sent: new Map(),
        orders: new Map(),
      });
    }
    // Undo history points at the old IDs, and the blocks render again under the new ones
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._contentUndoPending = {};
    this._clearNoteGone();
    this.renderBlocks();
    await this.save();
    try {
      await this.navigation.noteReplaced(this, goneId, note);
    } catch (error) {
      console.error('The tab of a note saved as a new note did not follow it:', error);
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
   * Delete all selected blocks (Req 13.4). A selection holding a block this build can't show asks
   * first, since nobody can see what such a block holds (#14 slice 3); the rest delete at once,
   * as before. One Undo brings them all back, each where it was.
   * @returns {Promise<void>}
   */
  async deleteSelectedBlocks() {
    if (this.selectedBlockIds.size === 0) return;

    const idsToDelete = new Set(this.selectedBlockIds);
    const selected = this.blocks.filter(b => idsToDelete.has(b.id));
    const safe = selected.filter(b => b.safeState()).length;
    if (safe > 0) {
      const noteId = this.noteId;
      const focused = this.doc.activeElement;
      if (!(await this._confirmDeleteUnseen(selected.length, safe))) {
        // The selection stays, for another try
        this._focusAfterCancel(focused, selected.map(b => b.id));
        return;
      }
      // The note it asked about is still the one on screen
      if (noteId !== this.noteId) return;
      for (const id of idsToDelete) if (!this.getBlockById(id)) idsToDelete.delete(id);
      if (idsToDelete.size === 0) return;
    }

    // Find the index of the first selected block for focus after deletion
    const firstSelectedIdx = this.blocks.findIndex(b => idsToDelete.has(b.id));

    // One undo entry for the whole delete (#14 slice 3), its blocks recorded last first, so
    // undo puts each back where it was, first first
    /** @type {Array<UndoEntry>} */
    const entries = [];
    for (let idx = this.blocks.length - 1; idx >= 0; idx--) {
      const block = this.blocks[idx];
      if (!idsToDelete.has(block.id)) continue;
      const snapshot = this.snapshotBlock(block);
      snapshot.order = idx;
      entries.push({ type: 'delete', blockId: block.id, before: snapshot, after: null });
    }

    this.blocks = this.blocks.filter(b => !idsToDelete.has(b.id));
    this._deleteStoredBlocks([...idsToDelete]);

    // Ensure at least one block remains, which the same undo takes away again
    if (this.blocks.length === 0) {
      const block = this.createBlock('text');
      this.blocks.push(block);
      const after = this.snapshotBlock(block);
      after.order = 0;
      entries.push({ type: 'add', blockId: block.id, before: null, after });
    }
    if (entries.length > 0) this.pushUndo(entries.length === 1 ? entries[0] : { type: 'group', entries });

    this.clearBlockSelection();
    this.renderBlocks();

    // Focus block preceding the selection, or first block
    const focusIdx = Math.max(0, Math.min(firstSelectedIdx, this.blocks.length - 1));
    this.focusBlock(this.blocks[focusIdx].id, true);
    this.scheduleSave();
  }

  /**
   * Ask before deleting `count` selected blocks, `safe` of which this build can't show (#14 slice
   * 3), in this editor's own document, so a pop-out editor asks in its own window. No dialog, no
   * delete.
   * @param {number} count
   * @param {number} safe
   * @returns {Promise<boolean>} true on a yes
   */
  _confirmDeleteUnseen(count, safe) {
    const ask = globalThis.confirmDialog;
    if (typeof ask !== 'function') return Promise.resolve(false);
    const which = safe === count ? 'all' : safe === 1 ? 'one' : String(safe);
    return ask({
      title: count === 1 ? 'Delete this block?' : `Delete ${count} blocks?`,
      message: count === 1
        ? "This version of NewTabNote can't show what's in it, so you can't see what you'd delete. Undo brings it back."
        : `This version of NewTabNote can't show what's in ${which} of them, so you can't see everything you'd delete. Undo brings them back.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
      initialFocus: 'cancel',
      doc: this.doc,
    });
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
        submenu.remove();
        // One question for all of them, and one undo entry (#14 slice 3); only a turn clears the
        // selection, so Cancel keeps it
        this.turnSelectionInto([...this.selectedBlockIds], type).then(turned => {
          if (turned) this.clearBlockSelection();
        });
      });

      submenu.appendChild(item);
    });

    submenu.style.position = 'fixed';
    this.doc.body.appendChild(submenu);
    // Above the button, measured first, so its top stays in the window (Utils.placeMenuBeside)
    Utils.placeMenuBeside(submenu, anchorBtn.getBoundingClientRect(), { above: true, gap: 8 });

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
    this.doc.body.appendChild(menu);
    // At the pointer, or above it near the bottom, measured first, as the note menu is (Utils.placeMenu)
    Utils.placeMenu(menu, x, y);

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
    // A block in a safe state can't be converted or sent to AI, so it has no menu (#14 slice 3)
    if (!block || block.safeState()) return;

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

    menu.style.position = 'fixed';
    this.doc.body.appendChild(menu);
    // Under the handle, or above it near the bottom, measured first (Utils.placeMenuBeside)
    Utils.placeMenuBeside(menu, anchorEl.getBoundingClientRect(), { gap: 4 });

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
    const ai = this._aiPort();

    // Req 20.4: toast if AI not configured
    if (!ai.isConfigured()) {
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

      const result = await ai.chat(messages);

      if (result && result.trim()) {
        // The reply is plain text, written into the block's rich content, and only when the
        // block decodes as a known block with it (#14 slice 2)
        const content = globalThis.BlockRendering.escapePlainText(result.trim());
        if (Utils.blockRefusal([{ ...block.serialize(), content }], this.logger)) {
          Utils.showToast(`AI ${action} failed`, 'error');
          return;
        }
        // Record undo before replacing content (Req 20.3)
        const beforeSnapshot = this.snapshotBlock(block);
        block.content = content;
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
          this.turnInto(blockId, type);
        }
        this.hideBlockActionMenu();
      });

      submenu.appendChild(item);
    });

    submenu.style.position = 'fixed';
    this.doc.body.appendChild(submenu);
    // Right of the item, or left of it near the right edge, moved up near the bottom, measured
    // first, so it shows where it stays (Utils.placeSubmenu)
    Utils.placeSubmenu(submenu, anchorItem.getBoundingClientRect(), { gap: 4 });
  }

  // ============ Version History / Snapshots (Req 31) ============

  /**
   * Start the 5-minute auto-snapshot interval, unless the page has no version history.
   */
  _startSnapshotInterval() {
    this._stopSnapshotInterval();
    if (VERSION_HISTORY.off) return;
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
   * Save a snapshot if content has changed since last snapshot (Req 31.1), through saveSnapshot.
   * The note and its blocks are taken now.
   * @returns {Promise<void>}
   */
  _autoSnapshot() {
    if (!this._snapshotDirty || !this.noteId || !this.noteData || VERSION_HISTORY.off) return Promise.resolve();
    this._snapshotDirty = false;
    const blocks = this.blocks.map(b => b.serialize());
    return this.documentClient.saveSnapshot(this.noteId, blocks, this.noteData.name || 'Untitled').then((outcome) => {
      if (outcome.kind === 'committed' || this._versionHistoryGone(outcome)) return;
      // Its kind and code, never what the note holds
      console.warn('Auto-snapshot not stored:', outcome.kind, outcome.code);
    });
  }

  /**
   * Turn version history off for the page when `outcome` says the database has no snapshots
   * store, as 1.4.x kept it off for such a database.
   * @param {{kind: string, code?: string}} outcome
   * @returns {boolean} Whether it did
   */
  _versionHistoryGone(outcome) {
    if (outcome.kind !== 'unavailable' || outcome.code !== 'store-unavailable') return false;
    VERSION_HISTORY.off = true;
    this._stopSnapshotInterval();
    return true;
  }

  /**
   * One snapshot, blocks included, for its preview or a revert. Null, with a toast, when it
   * can't be read or is gone.
   * @param {string} snapshotId
   * @returns {Promise<Object|null>}
   */
  async _readSnapshot(snapshotId) {
    let snap = null;
    try {
      snap = await this.documentClient.snapshot(snapshotId);
    } catch (error) {
      if (this._isReloadRequired(error)) this._onReloadRequired();
      else console.warn('Snapshot could not be read', error && error.message);
    }
    if (!snap) Utils.showToast('Failed to load snapshot', 'error');
    return snap;
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

    // Each snapshot's id, time, and title; a preview or a revert reads its blocks
    const noteId = this.noteId;
    let snapshots = [];
    try {
      if (noteId) snapshots = await this.documentClient.snapshots(noteId);
    } catch (error) {
      this._versionHistoryOpen = false;
      if (this._isReloadRequired(error)) this._onReloadRequired();
      else console.warn('Version history could not be read', error && error.message);
      Utils.showToast('Failed to load version history', 'error');
      return;
    }
    // Another note opened while the list was read
    if (noteId !== this.noteId) {
      this._versionHistoryOpen = false;
      return;
    }

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
   * @param {{id?: string, timestamp: number, blocks?: Array<Object>}} summary - The snapshot as
   *   version history lists it, whose blocks are read now, or one with its blocks
   */
  async _previewSnapshot(summary) {
    const snap = Array.isArray(summary.blocks) ? summary : await this._readSnapshot(summary.id);
    if (!snap) return;
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

        // Tags dropped through the block model layer's replaceTags (#14), in linear time; the
        // content's own replace runs first, so content that isn't text throws as it always did
        const text = blockData.content
          ? globalThis.BlockProjections.replaceTags(String(blockData.content.replace(/(?:)/, '')), '', false)
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
   * @returns {boolean} True while a revert of the loaded note commits
   */
  _isReverting() {
    return Boolean(this.noteId) && this._revertingNoteId === this.noteId;
  }

  /**
   * Keep the loaded note's blocks as they are on screen as a snapshot, while a revert replaces
   * them, rather than save them onto the note. Its transaction opens before this returns, so a
   * page-hide flush stores it.
   * @returns {void}
   */
  _keepEditsOfRevert() {
    const noteId = this.noteId;
    const typed = this.blocks.map((b) => b.serialize());
    this._snapshotDirty = false;
    this._revertEditsKept = true;
    this.documentClient.saveSnapshot(noteId, typed, (this.noteData && this.noteData.name) || 'Untitled').then((kept) => {
      if (kept.kind !== 'committed') console.warn('Snapshot of edits made during a revert not stored:', kept.kind, kept.code);
    });
  }

  /**
   * Put a committed revert's blocks and title on screen. Text typed into the blocks they replace
   * goes into version history first (_keepEditsOfRevert), so it isn't lost. They're the note's
   * close-time draft base from here (_sawRevert).
   * @param {Array<Object>} blocksData - The blocks as stored, in order
   * @param {string} [title]
   * @param {{records: Array<Object>, revision: (number|null), seq: number}} [commit] - the blocks'
   *   records as stored, the revision they're stored at, and the page's save order when the
   *   write or the read that gave them began
   * @returns {void}
   */
  _showRevertedBlocks(blocksData, title, commit) {
    if (this._snapshotDirty) this._keepEditsOfRevert();
    this.blocks = blocksData.map((data) => Block.deserialize(data));
    if (title && this.noteData) {
      this.noteData.name = title;
      this.titleEl.textContent = title;
    }
    if (commit) this._sawRevert(this.noteId, { ...commit, name: title || undefined });
    this.renderBlocks();
    this._snapshotDirty = false;
  }

  /**
   * After a committed revert whose blocks didn't reach the screen (_runRevert), read the note as
   * stored and show it, while saves are still held. A lost connection shows the reload notice.
   * @param {string} noteId
   * @returns {Promise<boolean>} Whether the screen shows the note as stored now
   */
  async _showStoredRevert(noteId) {
    try {
      const seq = pageSeq;
      const opened = await this.documentClient.openNote(noteId);
      if (!opened || noteId !== this.noteId) return false;
      const blocks = (opened.blocks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      const revision = typeof opened.revision === 'number' ? opened.revision : null;
      this._showRevertedBlocks(blocks, opened.note && opened.note.name, { records: blocks, revision, seq });
      return true;
    } catch (error) {
      if (this._isReloadRequired(error)) this._onReloadRequired();
      else console.error('Failed to show the reverted note:', error && error.message);
      return false;
    }
  }

  /**
   * Revert current note to a snapshot's content (Req 31.4), with restoreSnapshot: in one unit
   * the note as stored becomes a snapshot, the snapshot's blocks replace the note's, and its
   * title the note's name, while a pin, folder, trash, or hand-set title made elsewhere stays.
   * The edits waiting to save are written first, so that snapshot holds them. While the revert
   * commits, no save writes the loaded note: the debounce and save() wait for it, and a flush
   * (the page hiding or closing, the connection closing) keeps what's on screen as a snapshot
   * of its own (_keepEditsOfRevert), so the replaced blocks never go back onto the note.
   * @param {{id: string, timestamp: number}} summary - The snapshot, as version history lists it
   */
  async _revertToSnapshot(summary) {
    // One revert at a time: a second one, from the panel left open, would race the first's
    // hold and the saves waiting on it. It's a repeated click, so it's dropped without a word,
    // and the first revert's own outcome still shows
    if (this._revertInFlight) return;
    this._revertInFlight = true;
    try {
      await this._runRevert(summary);
    } finally {
      this._revertInFlight = false;
    }
  }

  /**
   * The revert itself (see _revertToSnapshot), which only one call runs at a time
   * @param {{id: string, timestamp: number}} summary
   * @returns {Promise<void>}
   */
  async _runRevert(summary) {
    const noteId = this.noteId;
    let confirmed = true;
    if (typeof confirmDialog === 'function') {
      confirmed = await confirmDialog({
        title: 'Revert to Snapshot',
        message: `Replace current content with the version from ${new Date(summary.timestamp).toLocaleString()}? This will save the current content as a new snapshot first.`,
        confirmText: 'Revert',
        danger: true,
      });
    }
    if (!confirmed || !noteId || noteId !== this.noteId) return;

    const snap = await this._readSnapshot(summary.id);
    if (!snap || noteId !== this.noteId) return;

    await this.flushSave();
    // Another note opened meanwhile, or text on screen isn't stored, so the snapshot taken first
    // wouldn't hold it: nothing is reverted, and the text stays
    if (noteId !== this.noteId || this.noteGone || this.reloadRequired) return;
    if (this._failedSeq.has(noteId)) {
      Utils.showToast("Failed to revert: your latest changes aren't saved yet. Please try again.", 'error');
      return;
    }

    // Its transaction opens now, with nothing waiting to save, after every save the page issued
    // so far, which it overwrites (#33)
    const restoring = this.documentClient.restoreSnapshot(noteId, snap.id, snap.blocks || [], snap.title || undefined);
    const restoredAt = pageSeq;
    this._revertingNoteId = noteId;
    /** @type {() => void} This revert's own, so nothing else can end it */
    let endRevert = () => {};
    this._revertDone = new Promise((resolve) => {
      endRevert = resolve;
    });
    this._revertEditsKept = false;
    this._snapshotDirty = false;
    const holding = !this._savesHeld;
    if (holding) this.holdSaves();
    try {
      let outcome;
      try {
        outcome = await restoring;
      } catch (error) {
        outcome = { kind: 'unavailable', code: 'revert-failed' };
        console.error('Failed to revert:', error && error.message);
      }

      if (outcome.kind !== 'committed') {
        this._revertingNoteId = null;
        // Nothing was reverted: what was typed meanwhile saves to the note as it is, a flush's
        // snapshot of it included
        if (this._revertEditsKept || this._snapshotDirty) {
          this._loadedDue = true;
          this._heldSaveDue = true;
        }
        this._versionHistoryGone(outcome);
        if (outcome.kind === 'unavailable' && outcome.code === 'reload-required') {
          this._onReloadRequired();
          return;
        }
        // Its kind and code, never what the note holds
        console.error('Revert not stored:', outcome.kind, outcome.code);
        Utils.showToast('Failed to revert to snapshot', 'error');
        return;
      }

      if (noteId === this.noteId) {
        try {
          // The snapshot's blocks, stored at their places, as restoreSnapshot writes them
          const records = (snap.blocks || []).map((block, order) => ({ ...block, canvasId: noteId, order }));
          const revision = typeof outcome.revision === 'number' ? outcome.revision : null;
          this._showRevertedBlocks(snap.blocks || [], snap.title, { records, revision, seq: restoredAt });
        } catch (error) {
          // The restore committed, but its blocks didn't reach the screen, which may still hold
          // the ones it replaced. Saves are still held, so the note as stored goes on screen
          // before any of them can write those back
          console.error('Failed to show the reverted note:', error && error.message);
          if (!(await this._showStoredRevert(noteId))) {
            // Nothing shows the revert, so the note goes back to what's on screen, as when a
            // revert fails. Version history keeps both, and the toast says it didn't revert
            if (!this.reloadRequired) {
              this._loadedDue = true;
              this._heldSaveDue = true;
              Utils.showToast('Failed to revert to snapshot', 'error');
            }
            return;
          }
        }
      }
    } finally {
      // Whatever happened above, the hold and the saves waiting on this revert go on, the saves
      // once the hold has let the loaded note's save start
      this._revertingNoteId = null;
      if (holding) this.releaseSaves();
      endRevert();
    }

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
