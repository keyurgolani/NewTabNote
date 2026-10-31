/**
 * SettingsController — manages settings modal UI: theme selection, font/width preferences,
 * export/import, trash retention, auto-backup, daily note template, shortcuts modal,
 * width selector pill, cross-tab settings sync, and backup status checks.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 */
class SettingsController {
  /**
   * @param {{storage: any, domRefs: any, logger: any, onOpened?: (() => Promise<void>)|null}} deps - `onOpened`
   *   runs each time Settings opens, for sections that read their state then (#17 PR 1b)
   */
  constructor({ storage, domRefs, logger, onOpened = null }) {
    this.storage = storage;
    this.domRefs = domRefs;
    this.logger = logger;
    /** @type {(() => Promise<void>)|null} */
    this.onSettingsOpened = onOpened;

    // App-level callbacks (set by App after construction)
    this.onApplyTheme = null;
    this.onOpenThemeBuilder = null;
    this.onCloseAllModals = null;
    this.onRefreshNotesList = null;
    /** @type {((noteId: string) => Promise<void>)|null} After Merge: open a note it imported, unless a pane can't take it */
    this.onOpenImportedNote = null;
    this.getEditor = null;
    /** @type {(() => Promise<void>)|null} Hold and flush every open editor before an import commits */
    this.onFlushEditors = null;
    /** @type {((trashedIds: Array<string>, trashedAt: number|null) => Promise<void>)|null} After an import: release the hold and move panes off trashed notes */
    this.onReloadEditors = null;
    /** @type {any} removeNotes (js/kernel/composition/removal.js), set by App: Trash Note goes through it */
    this.removal = null;
    this.onSetupAutoTitle = null;
    this.onSetupInsightsExtraction = null;
    this.onUpdateAISidebarState = null;
    this.onRenderNotesList = null;
    this.onUpdateSmartSuggestions = null;
    this.onRenderAIPromptTemplateSettings = null;
    /** @type {(() => Promise<void>)|null} Write what every open editor has pending, before a full export reads */
    this.onSaveOpenEditors = null;
    /** @type {function|null} */
    this._settingsFocusTrapCleanup = null;
    /** @type {function|null} */
    this._shortcutsFocusTrapCleanup = null;
    /** @type {HTMLElement|null} Where focus was when Keyboard Shortcuts opened */
    this._shortcutsReturnFocus = null;
  }

  /** Initialize settings: wire DOM listeners, check backup status. */
  async init() {
    this.setupSettings();
    this.setupSettingsNav();
    this.setupSettingsSearch();
    this.setupWidthSelectorPill();
    await this.applyFont();
    await this.applyWidth();
    this.setupSettingsSync();
    this.checkBackupStatus();
  }

  /** Tear down — no persistent listeners to clean up currently. */
  destroy() {}

  // ─── Settings modal setup ───

  setupSettings() {
    const modal = document.getElementById('settings-modal');
    const settingsBtn = document.getElementById('settings-btn');
    if (!modal || !settingsBtn) return;

    const closeBtn = modal.querySelector('.close-btn');

    settingsBtn.addEventListener('click', async () => {
      await this.openSettingsModal();
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        if (this._settingsFocusTrapCleanup) { this._settingsFocusTrapCleanup(); this._settingsFocusTrapCleanup = null; }
      });
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
        if (this._settingsFocusTrapCleanup) { this._settingsFocusTrapCleanup(); this._settingsFocusTrapCleanup = null; }
      }
    });

    // Theme select
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
      themeSelect.addEventListener('change', async (e) => {
        await this.storage.setSetting('theme', e.target.value);
        if (this.onApplyTheme) this.onApplyTheme();
        this.updateThemePreview(e.target.value);
      });
    }

    // Font select
    const fontSelect = document.getElementById('font-select');
    if (fontSelect) {
      fontSelect.addEventListener('change', async (e) => {
        await this.storage.setSetting('font', e.target.value);
        this.applyFont();
      });
    }

    // Width select
    const widthSelect = document.getElementById('width-select');
    if (widthSelect) {
      widthSelect.addEventListener('change', async (e) => {
        await this.storage.setSetting('width', e.target.value);
        this.applyWidth();
      });
    }

    // Export All
    const exportAllBtn = document.getElementById('export-all-btn');
    if (exportAllBtn) {
      exportAllBtn.addEventListener('click', async () => {
        await this.exportAll();
      });
    }

    // Export Current Note
    const exportCurrentBtn = document.getElementById('export-current-btn');
    if (exportCurrentBtn) {
      exportCurrentBtn.addEventListener('click', async () => {
        await this.exportCurrentNote();
      });
    }

    // Export ZIP
    const exportZipBtn = document.getElementById('export-zip-btn');
    if (exportZipBtn) {
      exportZipBtn.addEventListener('click', async () => {
        await this.exportAllAsMarkdown();
      });
    }

    // Create Backup
    const backupBtn = document.getElementById('backup-btn');
    if (backupBtn) {
      backupBtn.addEventListener('click', async () => {
        await this.createBackup();
      });
    }

    // Import
    const importBtn = document.getElementById('import-btn');
    const importInput = document.getElementById('import-input');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => {
        importInput.click();
      });

      importInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        try {
          if (file) {
            await this.importFromFile(file);
          }
        } finally {
          e.target.value = '';
        }
      });
    }

    // Delete note
    const deletePageBtn = document.getElementById('delete-page-btn');
    if (deletePageBtn) {
      deletePageBtn.addEventListener('click', async () => {
        await this.deleteCurrentNote();
      });
    }

    // Trash retention setting
    const trashRetentionSelect = document.getElementById('trash-retention-select');
    if (trashRetentionSelect) {
      trashRetentionSelect.addEventListener('change', async (e) => {
        await this.storage.setSetting('trashRetention', parseInt(e.target.value));
      });
    }

    // Daily Note template
    const dailyNoteTemplateSelect = document.getElementById('daily-note-template-select');
    if (dailyNoteTemplateSelect) {
      dailyNoteTemplateSelect.addEventListener('change', async (e) => {
        await this.storage.setSetting('dailyNoteTemplate', e.target.value);
      });
    }

    // Auto Backup settings
    const autoBackupToggle = document.getElementById('auto-backup-toggle');
    if (autoBackupToggle) {
      autoBackupToggle.addEventListener('change', async (e) => {
        await this.storage.setSetting('autoBackupEnabled', e.target.checked);
      });
    }

    const backupFrequencySelect = document.getElementById('backup-frequency-select');
    if (backupFrequencySelect) {
      backupFrequencySelect.addEventListener('change', async (e) => {
        await this.storage.setSetting('autoBackupFrequency', parseInt(e.target.value));
      });
    }

    // Theme Builder button
    const openThemeBuilderBtn = document.getElementById('open-theme-builder-btn');
    if (openThemeBuilderBtn) {
      openThemeBuilderBtn.addEventListener('click', () => {
        const settingsModal = document.getElementById('settings-modal');
        if (settingsModal) settingsModal.classList.add('hidden');
        if (this.onOpenThemeBuilder) this.onOpenThemeBuilder();
      });
    }

    // Help / Shortcuts button
    const shortcutsBtn = document.getElementById('shortcuts-btn');
    if (shortcutsBtn) {
      shortcutsBtn.addEventListener('click', () => {
        this.toggleShortcutsModal();
      });
    }

    const shortcutsModal = document.getElementById('shortcuts-modal');
    if (shortcutsModal) {
      const scCloseBtn = shortcutsModal.querySelector('.close-btn');
      scCloseBtn?.addEventListener('click', () => this.toggleShortcutsModal(false));
      shortcutsModal.addEventListener('click', (e) => {
        if (e.target === shortcutsModal) this.toggleShortcutsModal(false);
      });
    }
  }

  // ─── Settings category navigation ───

  setupSettingsNav() {
    const nav = document.getElementById('settings-nav');
    if (!nav) return;

    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.settings-nav-item');
      if (!btn) return;

      const category = btn.dataset.category;
      this.switchSettingsCategory(category);
    });
  }

  switchSettingsCategory(category) {
    const nav = document.getElementById('settings-nav');
    const content = document.querySelector('.settings-content');
    if (!nav || !content) return;

    // Clear search when switching categories
    const searchInput = document.getElementById('settings-search');
    if (searchInput && searchInput.value) {
      searchInput.value = '';
      this.clearSettingsSearch();
    }

    nav.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.category === category);
    });

    content.querySelectorAll('.settings-category').forEach(cat => {
      cat.classList.toggle('active', cat.dataset.category === category);
    });
  }

  // ─── Settings search ───

  setupSettingsSearch() {
    const searchInput = document.getElementById('settings-search');
    if (!searchInput) return;

    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      if (query) {
        this.filterSettings(query);
      } else {
        this.clearSettingsSearch();
      }
    });
  }

  filterSettings(query) {
    const content = document.querySelector('.settings-content');
    const noResults = document.getElementById('settings-no-results');
    const nav = document.getElementById('settings-nav');
    if (!content) return;

    content.classList.add('searching');

    // Deactivate nav items during search
    if (nav) {
      nav.querySelectorAll('.settings-nav-item').forEach(btn => btn.classList.remove('active'));
    }

    let anyVisible = false;
    content.querySelectorAll('.settings-section[data-setting-label]').forEach(section => {
      const label = (section.dataset.settingLabel || '').toLowerCase();
      const desc = (section.dataset.settingDesc || '').toLowerCase();
      const h3Text = (section.querySelector('h3')?.textContent || '').toLowerCase();
      const matches = label.includes(query) || desc.includes(query) || h3Text.includes(query);
      section.classList.toggle('search-hidden', !matches);
      if (matches) anyVisible = true;
    });

    if (noResults) {
      noResults.classList.toggle('hidden', anyVisible);
    }
  }

  clearSettingsSearch() {
    const content = document.querySelector('.settings-content');
    const noResults = document.getElementById('settings-no-results');
    if (!content) return;

    content.classList.remove('searching');

    content.querySelectorAll('.settings-section.search-hidden').forEach(s => {
      s.classList.remove('search-hidden');
    });

    if (noResults) noResults.classList.add('hidden');

    // Re-activate the first nav item if none is active
    const nav = document.getElementById('settings-nav');
    if (nav && !nav.querySelector('.settings-nav-item.active')) {
      const firstBtn = nav.querySelector('.settings-nav-item');
      if (firstBtn) {
        this.switchSettingsCategory(firstBtn.dataset.category);
      }
    }
  }

  // ─── Theme preview ───

  updateThemePreview(themeId) {
    const preview = document.getElementById('theme-preview');
    if (!preview) return;

    // Determine effective colors based on theme
    let bgPrimary, bgSecondary, textPrimary, textSecondary, textMuted, borderColor;

    if (themeId === 'dark') {
      bgPrimary = '#191919';
      bgSecondary = '#252525';
      textPrimary = '#e0e0e0';
      textSecondary = '#9b9b9b';
      textMuted = '#6b6b6b';
      borderColor = '#333';
    } else if (themeId === 'light') {
      bgPrimary = '#ffffff';
      bgSecondary = '#f7f7f7';
      textPrimary = '#1a1a1a';
      textSecondary = '#6b6b6b';
      textMuted = '#9b9b9b';
      borderColor = '#e5e5e5';
    } else {
      // system or custom — use current computed values
      const cs = getComputedStyle(document.documentElement);
      bgPrimary = cs.getPropertyValue('--bg-primary').trim();
      bgSecondary = cs.getPropertyValue('--bg-secondary').trim();
      textPrimary = cs.getPropertyValue('--text-primary').trim();
      textSecondary = cs.getPropertyValue('--text-secondary').trim();
      textMuted = cs.getPropertyValue('--text-muted').trim();
      borderColor = cs.getPropertyValue('--border-color').trim();
    }

    preview.style.borderColor = borderColor;
    preview.style.background = borderColor;

    const sidebar = preview.querySelector('.theme-preview-sidebar');
    if (sidebar) sidebar.style.background = bgSecondary;

    const editor = preview.querySelector('.theme-preview-editor');
    if (editor) editor.style.background = bgPrimary;

    const title = preview.querySelector('.theme-preview-title');
    if (title) title.style.background = textPrimary;

    preview.querySelectorAll('.theme-preview-bar').forEach(bar => {
      bar.style.background = textMuted;
    });

    preview.querySelectorAll('.theme-preview-line').forEach(line => {
      line.style.background = textSecondary;
    });
  }

  // ─── Open / update settings modal ───

  async openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    if (this.onCloseAllModals) this.onCloseAllModals();
    modal.classList.remove('hidden');
    this._settingsFocusTrapCleanup = Utils.trapFocus(modal);

    // Reset search and show first category
    const searchInput = document.getElementById('settings-search');
    if (searchInput) searchInput.value = '';
    this.clearSettingsSearch();
    this.switchSettingsCategory('general');

    await this.updateSettingsUI();
    if (this.onSettingsOpened) {
      await this.onSettingsOpened().catch((error) => console.warn('A settings section could not read its state:', error));
    }
  }

  async updateSettingsUI() {
    const storage = this.storage;

    // Theme
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect && typeof Themes !== 'undefined') {
      const options = await Themes.getThemeOptions();
      const currentTheme = await storage.getSetting('theme', 'system');

      themeSelect.innerHTML = '';
      options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.name;
        option.selected = opt.id === currentTheme;
        themeSelect.appendChild(option);
      });
      themeSelect.value = currentTheme;
      this.updateThemePreview(currentTheme);
    }

    // Font
    const font = await storage.getSetting('font', 'default');
    const fontSelect = document.getElementById('font-select');
    if (fontSelect) fontSelect.value = font;

    // Width
    const width = await storage.getSetting('width', 'default');
    const widthSelect = document.getElementById('width-select');
    if (widthSelect) widthSelect.value = width;

    // Auto Backup settings
    const autoBackupEnabled = await storage.getSetting('autoBackupEnabled', false);
    const autoBackupFrequency = await storage.getSetting('autoBackupFrequency', 7);

    const autoBackupToggle = document.getElementById('auto-backup-toggle');
    const backupFrequencySelect = document.getElementById('backup-frequency-select');

    if (autoBackupToggle) {
      autoBackupToggle.checked = autoBackupEnabled;
    }
    if (backupFrequencySelect) {
      backupFrequencySelect.value = autoBackupFrequency.toString();
    }

    // Trash retention
    const trashRetentionSelect = document.getElementById('trash-retention-select');
    if (trashRetentionSelect) {
      trashRetentionSelect.value = (await storage.getSetting('trashRetention', 30)).toString();
    }

    // Daily Note Template
    const dailyNoteTemplateSelect = document.getElementById('daily-note-template-select');
    if (dailyNoteTemplateSelect) {
      const templates = await storage.getTemplates();
      const currentTemplateId = await storage.getSetting('dailyNoteTemplate', '');

      dailyNoteTemplateSelect.innerHTML = '<option value="">No template</option>';
      templates.forEach(t => {
        const option = document.createElement('option');
        option.value = t.id;
        option.textContent = t.name;
        option.selected = t.id === currentTemplateId;
        dailyNoteTemplateSelect.appendChild(option);
      });
    }

    if (this.onRenderAIPromptTemplateSettings) {
      this.onRenderAIPromptTemplateSettings();
    }

    // Notes list
    await this.updateNotesList();
  }

  async updateNotesList() {
    const list = document.getElementById('pages-list');
    if (!list) return;

    const notes = await this.storage.getAllNotes();
    const editor = this.getEditor ? this.getEditor() : null;

    list.innerHTML = '';

    notes.forEach((note) => {
      const item = document.createElement('div');
      item.className = 'page-item';
      if (editor && note.id === editor.noteId) {
        item.classList.add('active');
      }

      item.innerHTML = `
        <span class="page-item-date">${Utils.formatDate(note.updatedAt)}</span>
      `;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'page-item-name';
      nameSpan.textContent = note.name || 'Untitled';
      item.insertBefore(nameSpan, item.firstChild);

      item.addEventListener('click', async () => {
        if (editor) await editor.loadNote(note.id);
        if (this.onRefreshNotesList) await this.onRefreshNotesList();
        document.getElementById('settings-modal').classList.add('hidden');
      });

      list.appendChild(item);
    });
  }

  // ─── Font / Width / Theme ───

  async applyFont() {
    const font = await this.storage.getSetting('font', 'default');
    document.documentElement.dataset.font = font;
  }

  async applyWidth() {
    const width = await this.storage.getSetting('width', 'default');
    document.documentElement.dataset.width = width;
    this.updateWidthSelectorPill(width);

    // Update wide content centering after width change
    const editor = this.getEditor ? this.getEditor() : null;
    if (editor) {
      requestAnimationFrame(() => editor.updateWideContentCentering());
    }
  }

  // ─── Width selector pill (header) ───

  setupWidthSelectorPill() {
    const widthSelector = document.getElementById('width-selector-header');
    if (!widthSelector) return;

    widthSelector.addEventListener('click', async (e) => {
      const btn = e.target.closest('.width-option');
      if (!btn) return;

      const width = btn.dataset.width;
      await this.storage.setSetting('width', width);
      this.applyWidth();

      // Also update the settings modal select if it's open
      const widthSelect = document.getElementById('width-select');
      if (widthSelect) {
        widthSelect.value = width;
      }
    });
  }

  updateWidthSelectorPill(width) {
    const widthSelector = document.getElementById('width-selector-header');
    if (!widthSelector) return;

    widthSelector.querySelectorAll('.width-option').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.width === width);
    });
  }

  // ─── Shortcuts modal ───

  /**
   * Open or close Keyboard Shortcuts. It opens on ? as well as from its
   * button, so focus moves into it, where the keys pressed while it's open
   * stay. Closing it puts focus back where it was, if focus is still in it
   * (a shortcut such as Mod+K may have moved it out), and otherwise off the
   * hidden close button.
   * @param {boolean} [force] - Open (true) or close (false); toggles without it
   * @returns {void}
   */
  toggleShortcutsModal(force) {
    const modal = document.getElementById('shortcuts-modal');
    if (!modal) return;

    const open = !modal.classList.contains('hidden');
    const show = force !== undefined ? force : !open;
    if (show === open) return;
    if (show) {
      this._shortcutsReturnFocus = /** @type {HTMLElement|null} */ (document.activeElement);
      modal.classList.remove('hidden');
      this._shortcutsFocusTrapCleanup = Utils.trapFocus(modal);
      const closeBtn = /** @type {HTMLElement|null} */ (modal.querySelector('.close-btn'));
      if (closeBtn) closeBtn.focus();
    } else {
      modal.classList.add('hidden');
      if (this._shortcutsFocusTrapCleanup) { this._shortcutsFocusTrapCleanup(); this._shortcutsFocusTrapCleanup = null; }
      const previous = this._shortcutsReturnFocus;
      this._shortcutsReturnFocus = null;
      const focused = /** @type {HTMLElement|null} */ (document.activeElement);
      if (!focused || !modal.contains(focused)) return;
      if (previous && previous !== document.body && previous.isConnected) previous.focus();
      else focused.blur();
    }
  }

  // ─── Export / Import / Backup ───

  /**
   * Export JSON: download the full export (Storage.exportAllAsBlob) as a file,
   * after the open editors have written their pending edits.
   * @returns {Promise<boolean>} True once the file is handed to the browser
   */
  async exportAll() {
    try {
      if (this.onSaveOpenEditors) await this.onSaveOpenEditors();
      const file = await this.storage.exportAllAsBlob();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      Utils.downloadFile(file, `new-tab-note-export-${timestamp}.json`);
    } catch (error) {
      console.error('Export failed:', error);
      Utils.showToast('Export failed', 'error');
      return false;
    }
    Utils.showToast('All notes exported as JSON', 'success');
    await this._afterFullExport({ backup: true });
    return true;
  }

  /**
   * Once a full export (Export JSON, Create Backup) is the browser's: the
   * receipt the export notice listens for, and for Export JSON the time auto
   * backup counts from. Best-effort, since the file is already handed over.
   * @param {{backup?: boolean}} [what]
   * @returns {Promise<void>}
   */
  async _afterFullExport({ backup = false } = {}) {
    const at = Date.now();
    try {
      await this.storage.setSetting('lastFullExportAt', at);
      if (backup) await this.storage.setSetting('lastBackupAt', at);
    } catch (error) {
      console.warn('The export was handed to the browser, but its time was not saved:', error);
    }
  }

  async exportAllAsMarkdown() {
    try {
      const zip = new JSZip();
      const folder = zip.folder("NewTabNote-Export");

      const notes = await this.storage.getAllNotes();

      for (const note of notes) {
        if (note.isTrash) continue;

        const blocks = await this.storage.getElementsByNote(note.id);
        const sortedBlocks = blocks.sort((a, b) => (a.order || 0) - (b.order || 0));

        let markdown = `# ${note.name || 'Untitled'}\n\n`;
        for (const block of sortedBlocks) {
          markdown += this.blockToMarkdown(block);
        }

        const safeName = (note.name || 'Untitled')
          .replace(/[^a-z0-9\s-]/gi, '')
          .replace(/\s+/g, '-')
          .toLowerCase() || 'note-' + note.id;

        folder.file(`${safeName}.md`, markdown);
      }

      const content = await zip.generateAsync({ type: "blob" });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `new-tab-note-markdown-${timestamp}.zip`;

      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);

      Utils.showToast('All notes exported as ZIP', 'success');
      await this.storage.setSetting('lastBackupAt', Date.now());
    } catch (error) {
      console.error('ZIP export failed:', error);
      Utils.showToast('Export failed', 'error');
    }
  }

  /**
   * A note as every export writes it: without the fields #17 PR 3 writes beside its flags,
   * js/kernel/core/domain/placement.js's NEW_NOTE_FIELDS (test/import.test.js holds Export
   * Current Note to that list), which 1.4.1's single-note import ignores (#17 PR 3b, Q8)
   * @param {Record<string, any>} note
   * @returns {Record<string, any>}
   */
  static exportedNote(note) {
    const copy = { ...note };
    for (const field of ['placement', 'kind', 'lifecycle', 'dailyKey', 'dailyTimeZone', 'dailyDuplicateOf']) {
      delete copy[field];
    }
    return copy;
  }

  async exportCurrentNote() {
    try {
      const editor = this.getEditor ? this.getEditor() : null;
      if (!editor || !editor.noteId) {
        Utils.showToast('No note selected', 'error');
        return;
      }

      const stored = await this.storage.getNote(editor.noteId);
      const note = stored && SettingsController.exportedNote(stored);
      const blocks = await this.storage.getElementsByNote(editor.noteId);

      const data = {
        version: 1,
        exportType: 'single-note',
        exportedAt: new Date().toISOString(),
        note: note,
        blocks: blocks,
      };

      const json = JSON.stringify(data, null, 2);
      const noteName = (note.name || 'Untitled').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      Utils.downloadFile(json, `new-tab-note-note-${noteName}-${timestamp}.json`);
      Utils.showToast('Note exported', 'success');
    } catch (error) {
      console.error('Export current note failed:', error);
      Utils.showToast('Export failed', 'error');
    }
  }

  /**
   * Create Backup: the full export with backup fields, downloaded as a file,
   * after the open editors have written their pending edits.
   * @returns {Promise<boolean>} True once the file is handed to the browser
   */
  async createBackup() {
    try {
      if (this.onSaveOpenEditors) await this.onSaveOpenEditors();
      const file = await this.storage.exportAllAsBlob({
        backupType: 'full-backup',
        backupCreatedAt: new Date().toISOString(),
        backupVersion: 1,
      });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      Utils.downloadFile(file, `new-tab-note-backup-${timestamp}.json`);
    } catch (error) {
      console.error('Backup failed:', error);
      Utils.showToast('Backup failed', 'error');
      return false;
    }
    Utils.showToast('Backup created', 'success');
    await this._afterFullExport();
    return true;
  }

  /**
   * The dialog helpers from js/ui/confirm-dialog.js, which live on window.
   * @returns {{choiceDialog: function(Object): Promise<string>, confirmDialog: function(Object): Promise<boolean>}}
   */
  _dialogs() {
    return /** @type {any} */ (window);
  }

  /**
   * Import a backup file. Order: parse, validate, choose, confirm Replace all,
   * flush every open editor, then let Storage.importData write the recovery
   * copy (Replace all) and commit. Dismissing a dialog or a refused file
   * changes nothing.
   * @param {Blob} file
   * @returns {Promise<void>}
   */
  async importFromFile(file) {
    let data;
    try {
      data = JSON.parse(await Utils.readFileAsText(/** @type {File} */ (file)));
    } catch (error) {
      this._showImportFailed("the file isn't valid JSON");
      return;
    }

    const check = this.storage.validateImport(data);
    if (check.ok === false) {
      this._showImportFailed(check.reason);
      return;
    }

    const { counts } = check;
    const choice = await this._dialogs().choiceDialog({
      title: 'Import backup',
      message: `This backup has ${this._count(counts.notes, 'note')}, ${this._count(counts.blocks, 'block')}, `
        + `and ${this._count(counts.folders, 'folder')}. Merge adds them as copies next to your notes. `
        + 'Replace all moves your active notes to trash first.',
      choices: [
        { id: 'merge', label: 'Merge', variant: 'primary' },
        { id: 'replace', label: 'Replace all' },
        { id: 'cancel', label: 'Cancel' },
      ],
      cancelId: 'cancel',
    });
    if (choice !== 'merge' && choice !== 'replace') return;
    if (choice === 'replace' && !(await this._confirmReplaceAll())) return;

    /** @type {ImportResult|null} */
    let result = null;
    try {
      if (this.onFlushEditors) await this.onFlushEditors();
      result = await this.storage.importData(data, choice);
    } catch (error) {
      console.error('Import failed:', error);
      this._showImportFailed(error && error.message ? error.message : 'unknown error');
    }

    // Editors resume, and the notes Replace all trashed leave every new tab
    const resumed = await this._afterImport(async () => {
      if (this.onReloadEditors) await this.onReloadEditors(result ? result.trashedIds : [], result ? result.trashedAt : null);
    });
    if (!result) return;

    Utils.showToast(this._importSummary(result), 'success', 6000);
    // Merge opens the first note it imported, in a tab. Replace all already left the panes on
    // active notes, with the active pane's note on the active tab (onReloadEditors).
    const opened = await this._afterImport(async () => {
      if (result.mode !== 'merge' || !this.onOpenImportedNote) return;
      const noteId = await this._firstActiveNote(result.importedIds);
      if (noteId) await this.onOpenImportedNote(noteId);
    });
    const listed = await this._afterImport(async () => {
      if (this.onRefreshNotesList) await this.onRefreshNotesList();
    });
    if (!resumed || !opened || !listed) {
      Utils.showToast("Your notes were imported, but this page didn't finish updating. Reload it to see them.", 'error', 6000);
    }
  }

  /**
   * The first of `ids` that is an active note: not archived, not a template, not in trash.
   * @param {Array<string>} ids
   * @returns {Promise<string|null>}
   */
  async _firstActiveNote(ids) {
    for (const id of ids) {
      const note = await this.storage.getNote(id);
      if (note && !note.archived && !note.isTemplate && !note.trashed) return id;
    }
    return null;
  }

  /**
   * Run a step that follows an import, so one that fails (a chrome.storage
   * write, say) doesn't stop the steps after it. The failure is logged.
   * @param {() => Promise<void>} step
   * @returns {Promise<boolean>} false when the step failed
   */
  async _afterImport(step) {
    try {
      await step();
      return true;
    } catch (error) {
      console.error('A step after the import failed:', error);
      return false;
    }
  }

  /**
   * The second, danger-styled confirmation for Replace all. Focus starts on Cancel.
   * @returns {Promise<boolean>}
   */
  async _confirmReplaceAll() {
    const activeCount = (await this.storage.getAllNotes()).length;
    const retention = Number(await this.storage.getSetting('trashRetention', 30));
    const moves = activeCount === 1
      ? '1 active note moves to trash, where it stays'
      : `${activeCount} active notes move to trash, where they stay`;
    const stay = retention > 0 ? `for ${this._count(retention, 'day')}` : 'until you empty trash';
    return this._dialogs().confirmDialog({
      title: 'Replace all notes?',
      message: `${moves} ${stay}. Archived notes, templates, and folders stay. A recovery copy is saved first.`,
      confirmText: 'Replace all',
      cancelText: 'Cancel',
      danger: true,
      initialFocus: 'cancel',
    });
  }

  /**
   * @param {string} reason
   * @returns {void}
   */
  _showImportFailed(reason) {
    Utils.showToast(`Import failed before any change: ${reason}`, 'error', 6000);
  }

  /**
   * @param {ImportResult} result
   * @returns {string}
   */
  _importSummary(result) {
    const parts = [this._count(result.notes, 'note'), this._count(result.blocks, 'block')];
    if (result.folders > 0) parts.push(this._count(result.folders, 'folder'));
    if (result.media > 0) parts.push(this._count(result.media, 'media file'));
    const imported = parts.length > 1
      ? `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts[parts.length - 1]}`
      : parts[0];
    let summary = `Imported ${imported}.`;
    if (result.skippedMedia > 0) {
      summary += ` Skipped ${this._count(result.skippedMedia, 'media file')} that belonged to no note in the backup.`;
    }
    return summary;
  }

  /**
   * @param {number} n
   * @param {string} noun - Singular; plural adds "s"
   * @returns {string}
   */
  _count(n, noun) {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }

  // ─── Delete current note ───

  async deleteCurrentNote() {
    if (!await confirmDialog({ title: 'Trash Note', message: 'Move this note to trash?' })) {
      return;
    }

    const editor = this.getEditor ? this.getEditor() : null;
    if (!editor) return;

    const currentId = editor.noteId;
    // Through removeNotes, as the sidebar's Trash: panes move off it, the kernel's trashNote
    // writes it, and the lists and the other new tabs follow. A write that fails puts the panes
    // back and says so.
    const outcome = await this.removal.removeNotes({ type: 'trashNote', noteId: currentId });

    document.getElementById('settings-modal').classList.add('hidden');
    // A note another tab already deleted has left all the same
    const gone = outcome.kind === 'rejected' && outcome.reason === 'not-found';
    if (outcome.kind !== 'committed' && !gone) {
      console.error('Failed to move note to trash:', outcome.kind, outcome.code);
      Utils.showToast(Utils.writeFailureMessage('Failed to move note to trash', outcome), 'error');
      return;
    }
    Utils.showToast(outcome.code === 'note-deleted' ? 'Empty note deleted' : 'Note moved to trash', 'success');
  }

  // ─── Block to markdown (for export) ───

  blockToMarkdown(block) {
    // Delegate to App's method if available, or use AIResponseUtils
    if (typeof AIResponseUtils !== 'undefined' && AIResponseUtils.blockToMarkdown) {
      return AIResponseUtils.blockToMarkdown(block);
    }

    const content = this.htmlToMarkdown(block.content || '');

    switch (block.type) {
      case 'h1': return `# ${content}\n\n`;
      case 'h2': return `## ${content}\n\n`;
      case 'h3': return `### ${content}\n\n`;
      case 'bullet': return `- ${content}\n`;
      case 'numbered': return `1. ${content}\n`;
      case 'todo': return `- [${block.checked ? 'x' : ' '}] ${content}\n`;
      case 'quote': return `> ${content}\n\n`;
      case 'code': return `\`\`\`\n${block.content || ''}\n\`\`\`\n\n`;
      case 'divider': return `---\n\n`;
      case 'callout': return `> ${block.calloutIcon || '💡'} ${content}\n\n`;
      case 'toggle': return `<details>\n<summary>${content}</summary>\n${block.children || ''}\n</details>\n\n`;
      case 'image': return block.imageUrl ? `![${content}](${block.imageUrl})\n\n` : '';
      case 'bookmark': return block.url ? `[${block.title || block.url}](${block.url})\n\n` : '';
      case 'equation': return `$$\n${block.equation || ''}\n$$\n\n`;
      case 'table':
        if (block.tableData && block.tableData.length > 0) {
          let md = '';
          block.tableData.forEach((row, i) => {
            md += '| ' + row.join(' | ') + ' |\n';
            if (i === 0) {
              md += '| ' + row.map(() => '---').join(' | ') + ' |\n';
            }
          });
          return md + '\n';
        }
        return '';
      default: return content ? `${content}\n\n` : '\n';
    }
  }

  htmlToMarkdown(html) {
    if (!html) return '';
    return html
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<i>(.*?)<\/i>/gi, '*$1*')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<s>(.*?)<\/s>/gi, '~~$1~~')
      .replace(/<strike>(.*?)<\/strike>/gi, '~~$1~~')
      .replace(/<a href="(.*?)">(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  }

  // ─── Cross-tab settings sync ───

  setupSettingsSync() {
    // settings.changed names the keys only, so each value applied is read again, from the
    // storage the listener is on (#12 slice 7's settings port replaces both)
    const storage = this.storage;
    storage.onSettingsChange(async ({ keys }) => {
      const changed = new Set(keys);
      /**
       * Reads `key` again and gives its value to `apply`, unless the read fails: a value it
       * couldn't read is left as this tab has it, never applied as missing
       * @param {string} key
       * @param {(value: *) => void} apply
       */
      const reread = async (key, apply) => {
        let value;
        try {
          value = await storage.readSetting(key);
        } catch (error) {
          this.logger?.warn?.('SettingsController', `Couldn't read ${key} again after another tab changed it`, error);
          return;
        }
        apply(value);
      };

      // Apply theme changes
      if (changed.has('theme')) {
        if (this.onApplyTheme) this.onApplyTheme();
      }

      // Apply font changes
      if (changed.has('font')) {
        await this.applyFont();
      }

      // Apply width changes
      if (changed.has('width')) {
        await this.applyWidth();
      }

      // Apply sidebar state changes (delegate to App for backward compat)
      for (const key of ['sidebarOpen', 'sidebarWidth', 'sidebarViewMode', 'sidebarSortMode']) {
        if (changed.has(key) && this.onSidebarStateChanged) {
          await reread(key, (value) => this.onSidebarStateChanged(key, value));
        }
      }

      // Apply AI sidebar width changes
      if (changed.has('aiSidebarWidth')) {
        if (this.onAISidebarWidthChanged) await reread('aiSidebarWidth', (value) => this.onAISidebarWidthChanged(value));
      }

      // Reinitialize LLM if provider settings changed
      if (['llmProvider', 'llmApiKey', 'llmModel', 'ollamaUrl'].some((key) => changed.has(key))) {
        if (this.onLLMSettingsChanged) this.onLLMSettingsChanged();
      }

      if (changed.has('aiPromptTemplates')) {
        if (this.onAIPromptTemplatesChanged) {
          await reread('aiPromptTemplates', (value) => this.onAIPromptTemplatesChanged(value));
        }
      }

      // Update auto-title settings
      if (changed.has('autoTitleEnabled') || changed.has('autoTitleInterval')) {
        if (this.onSetupAutoTitle) this.onSetupAutoTitle();
      }

      // Update insights settings
      if (changed.has('insightsEnabled') || changed.has('insightsInterval')) {
        if (this.onSetupInsightsExtraction) this.onSetupInsightsExtraction();
      }
    });
  }

  // ─── Backup status check ───

  async checkBackupStatus() {
    const enabled = await this.storage.getSetting('autoBackupEnabled', false);
    if (!enabled) return;

    const frequency = await this.storage.getSetting('autoBackupFrequency', 1); // default: daily
    const lastBackup = await this.storage.getSetting('lastBackupAt', 0);
    const now = Date.now();
    const daysSinceBackup = (now - lastBackup) / (1000 * 60 * 60 * 24);

    if (daysSinceBackup >= frequency) {
      try {
        await this.storage.createAutoBackup();
        this.logger?.info?.('SettingsController', 'Auto-backup created to chrome.storage.local');
      } catch (error) {
        console.warn('Auto-backup failed:', error);
        Utils.showToast('Auto-backup failed. Consider exporting manually.', 'error');
        // A data-risk incident (#20, "Diagnostic journal"), with the error's name and never its message
        if (this.logger && typeof this.logger.event === 'function') this.logger.event('backup.auto-failed', {}, error);
      }
    }
  }
}

// Dual CommonJS/browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SettingsController };
} else if (typeof window !== 'undefined') {
  window.SettingsController = SettingsController;
}
