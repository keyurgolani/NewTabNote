/**
 * ExportImportService — consolidates all export/import operations into a single service.
 * Delegates to SettingsController (full export, backup, import) and NotesManager
 * (single note export/import, markdown conversion).
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 */
class ExportImportService {
  constructor({ storage, eventBus, domRefs, logger }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.domRefs = domRefs;
    this.logger = logger;

    // Controller references (set by App after construction)
    this.settingsController = null;
    this.notesManager = null;

    // App-level callbacks
    this.getEditor = null;
    this.onRefreshNotesList = null;
    this.onOpenNoteInNewTab = null;
  }

  /** Initialize the service. */
  async init() {
    // No-op for now; controllers are wired after construction.
  }

  /** Tear down. */
  destroy() {
    this.settingsController = null;
    this.notesManager = null;
  }

  // ─── Single Note Export ───

  /**
   * Export a single note as Markdown file.
   * @param {string} noteId
   */
  async exportNoteAsMarkdown(noteId) {
    if (this.notesManager) {
      await this.notesManager.exportNoteById(noteId);
      return;
    }
    console.warn('ExportImportService: notesManager not available for exportNoteAsMarkdown');
  }

  /**
   * Export the current note as JSON (single-note format).
   */
  async exportCurrentNoteAsJson() {
    if (this.settingsController) {
      await this.settingsController.exportCurrentNote();
      return;
    }
    console.warn('ExportImportService: settingsController not available for exportCurrentNoteAsJson');
  }

  // ─── Bulk Export ───

  /**
   * Export all data as JSON.
   */
  async exportAllAsJson() {
    if (this.settingsController) {
      await this.settingsController.exportAll();
      return;
    }
    console.warn('ExportImportService: settingsController not available for exportAllAsJson');
  }

  /**
   * Export all notes as a ZIP of Markdown files.
   */
  async exportAllAsMarkdownZip() {
    if (this.settingsController) {
      await this.settingsController.exportAllAsMarkdown();
      return;
    }
    console.warn('ExportImportService: settingsController not available for exportAllAsMarkdownZip');
  }

  // ─── Backup ───

  /**
   * Create a full timestamped backup.
   */
  async createBackup() {
    if (this.settingsController) {
      await this.settingsController.createBackup();
      return;
    }
    console.warn('ExportImportService: settingsController not available for createBackup');
  }

  // ─── Import ───

  /**
   * Import a single note from file (.md, .txt, or .json single-note format).
   * @param {File} file
   */
  async importNote(file) {
    if (this.notesManager) {
      await this.notesManager.importNote(file);
      return;
    }
    console.warn('ExportImportService: notesManager not available for importNote');
  }

  /**
   * Import from a full backup JSON file (merge or replace).
   * @param {File} file
   */
  async importFromBackup(file) {
    if (this.settingsController) {
      await this.settingsController.importFromFile(file);
      return;
    }
    console.warn('ExportImportService: settingsController not available for importFromBackup');
  }
}

// Dual CommonJS/browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExportImportService };
} else if (typeof window !== 'undefined') {
  window.ExportImportService = ExportImportService;
}
