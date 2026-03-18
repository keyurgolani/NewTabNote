/**
 * Storage manager using IndexedDB for New Tab Note
 * 
 * Note: IndexedDB store names remain as 'canvases' for backward compatibility
 * with existing user data. The API methods use "Note" terminology.
 */

// Mock chrome.storage for local testing if running via file://
if (typeof chrome === 'undefined' || !chrome.storage) {
  const mockStorage = {
    local: {
      get: (keys, callback) => {
        const result = {};
        const ks = Array.isArray(keys) ? keys : [keys];
        ks.forEach(k => {
          try {
            const val = localStorage.getItem(`chrome_mock_${k}`);
            result[k] = val ? JSON.parse(val) : undefined;
          } catch (e) {
            result[k] = undefined;
          }
        });
        setTimeout(() => callback(result), 0);
      },
      set: (items, callback) => {
        Object.keys(items).forEach(k => {
          localStorage.setItem(`chrome_mock_${k}`, JSON.stringify(items[k]));
        });
        if (callback) setTimeout(callback, 0);
      }
    },
    onChanged: {
      addListener: () => { }
    }
  };
  const mockRuntime = {
    lastError: null,
    sendMessage: () => { }
  };

  // Assign to all possible global scopes
  if (typeof window !== 'undefined') window.chrome = { storage: mockStorage, runtime: mockRuntime };
  if (typeof self !== 'undefined') self.chrome = { storage: mockStorage, runtime: mockRuntime };
  if (typeof globalThis !== 'undefined') globalThis.chrome = { storage: mockStorage, runtime: mockRuntime };
}

class DatabaseManager {
  constructor() {
    this.dbName = 'CanvasTabDB';
    this.dbVersion = 7; // Bumped version for vectors
    this.db = null;
    // Store names kept as 'canvases' for backward compatibility with existing databases
    this.requiredStores = ['canvases', 'elements', 'settings', 'media', 'search_index', 'folders', 'links', 'themes', 'vectors'];
  }

  /**
   * Initialize the database
   */
  async init() {
    // First, check if we need to delete a corrupted database
    await this.checkAndRepairDatabase();

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.error);
        reject(event.target.error);
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;

        // Verify all stores exist
        const missingStores = this.requiredStores.filter(
          (store) => !this.db.objectStoreNames.contains(store)
        );

        if (missingStores.length > 0) {
          console.warn('Missing stores detected:', missingStores);
          // Close and delete, then retry
          this.db.close();
          this.deleteAndRetry().then(resolve).catch(reject);
          return;
        }

        // Initialize default settings in chrome.storage.local on first load
        await this.initializeDefaultSettings();

        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        console.log('Upgrading database from version', event.oldVersion, 'to', event.newVersion);

        // Canvases store
        if (!db.objectStoreNames.contains('canvases')) {
          const canvasStore = db.createObjectStore('canvases', { keyPath: 'id' });
          canvasStore.createIndex('name', 'name', { unique: false });
          canvasStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Elements store
        if (!db.objectStoreNames.contains('elements')) {
          const elementStore = db.createObjectStore('elements', { keyPath: 'id' });
          elementStore.createIndex('canvasId', 'canvasId', { unique: false });
          elementStore.createIndex('type', 'type', { unique: false });
        }

        // Settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('media')) {
          const mediaStore = db.createObjectStore('media', { keyPath: 'id' });
          mediaStore.createIndex('canvasId', 'canvasId', { unique: false });
        }

        // Search index store
        if (!db.objectStoreNames.contains('search_index')) {
          db.createObjectStore('search_index', { keyPath: 'noteId' });
        }

        // Folders store
        if (!db.objectStoreNames.contains('folders')) {
          const folderStore = db.createObjectStore('folders', { keyPath: 'id' });
          folderStore.createIndex('parentId', 'parentId', { unique: false });
          folderStore.createIndex('name', 'name', { unique: false });
        }

        // Links store (for bidirectional linking)
        if (!db.objectStoreNames.contains('links')) {
          const linkStore = db.createObjectStore('links', { keyPath: 'id' });
          linkStore.createIndex('fromNoteId', 'fromNoteId', { unique: false });
          linkStore.createIndex('toNoteId', 'toNoteId', { unique: false });
        }

        // Themes store
        if (!db.objectStoreNames.contains('themes')) {
          const themeStore = db.createObjectStore('themes', { keyPath: 'id' });
          themeStore.createIndex('name', 'name', { unique: false });
          themeStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Vectors store (for embeddings)
        if (!db.objectStoreNames.contains('vectors')) {
          db.createObjectStore('vectors', { keyPath: 'id' });
        }
      };

      request.onblocked = () => {
        console.warn('Database upgrade blocked. Please close other tabs using this extension.');
      };
    });
  }

  /**
   * Check if database is corrupted and needs repair
   */
  async checkAndRepairDatabase() {
    return new Promise((resolve) => {
      const request = indexedDB.open(this.dbName);

      request.onsuccess = (event) => {
        const db = event.target.result;
        const currentVersion = db.version;

        // Check if all required stores exist
        const missingStores = this.requiredStores.filter(
          (store) => !db.objectStoreNames.contains(store)
        );

        db.close();

        if (missingStores.length > 0 && currentVersion >= this.dbVersion) {
          // Database is corrupted, delete it
          console.warn('Corrupted database detected, deleting...');
          const deleteRequest = indexedDB.deleteDatabase(this.dbName);
          deleteRequest.onsuccess = () => {
            console.log('Corrupted database deleted');
            resolve();
          };
          deleteRequest.onerror = () => resolve();
        } else {
          resolve();
        }
      };

      request.onerror = () => resolve();
    });
  }

  /**
   * Delete database and retry initialization
   */
  async deleteAndRetry() {
    return new Promise((resolve, reject) => {
      console.log('Deleting database for fresh start...');
      const deleteRequest = indexedDB.deleteDatabase(this.dbName);

      deleteRequest.onsuccess = () => {
        console.log('Database deleted, reinitializing...');
        // Retry init
        const request = indexedDB.open(this.dbName, this.dbVersion);

        request.onerror = (event) => reject(event.target.error);

        request.onsuccess = (event) => {
          this.db = event.target.result;
          resolve();
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          const canvasStore = db.createObjectStore('canvases', { keyPath: 'id' });
          canvasStore.createIndex('name', 'name', { unique: false });
          canvasStore.createIndex('updatedAt', 'updatedAt', { unique: false });

          const elementStore = db.createObjectStore('elements', { keyPath: 'id' });
          elementStore.createIndex('canvasId', 'canvasId', { unique: false });
          elementStore.createIndex('type', 'type', { unique: false });

          db.createObjectStore('settings', { keyPath: 'key' });

          const mediaStore = db.createObjectStore('media', { keyPath: 'id' });
          mediaStore.createIndex('canvasId', 'canvasId', { unique: false });

          db.createObjectStore('search_index', { keyPath: 'noteId' });

          const folderStore = db.createObjectStore('folders', { keyPath: 'id' });
          folderStore.createIndex('parentId', 'parentId', { unique: false });
          folderStore.createIndex('name', 'name', { unique: false });

          const linkStore = db.createObjectStore('links', { keyPath: 'id' });
          linkStore.createIndex('fromNoteId', 'fromNoteId', { unique: false });
          linkStore.createIndex('toNoteId', 'toNoteId', { unique: false });
        };
      };

      deleteRequest.onerror = () => {
        reject(new Error('Failed to delete corrupted database'));
      };
    });
  }

  /**
   * Generic transaction helper
   */
  transaction(storeNames, mode = 'readonly') {
    return this.db.transaction(storeNames, mode);
  }

  /**
   * Get object store
   */
  getStore(storeName, mode = 'readonly') {
    return this.transaction(storeName, mode).objectStore(storeName);
  }

  // ============ Daily Note Operations ============

  /**
   * Get today's daily note
   */
  async getTodayNote() {
    const todayStr = new Date().toISOString().split('T')[0];
    const notes = await this.getAllNotes(true); // Include archived to find daily notes
    return notes.find(n => n.isDaily && n.dateStr === todayStr);
  }

  /**
   * Create daily note for today if it doesn't exist
   */
  async ensureDailyNote() {
    let note = await this.getTodayNote();
    if (!note) {
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const name = `Daily Note - ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      note = await this.createNote(name);
      note.isDaily = true;
      note.dateStr = todayStr;
      await this.updateNote(note);

      // Check for daily note template
      const templateId = await this.getSetting('dailyNoteTemplate');
      if (templateId) {
        await this.applyTemplateToNote(note.id, templateId);
      }
    }
    return note;
  }

  /**
   * Create or get daily note for a specific date
   */
  async ensureDailyNoteForDate(dateStr) {
    const notes = await this.getAllNotes(true);
    let note = notes.find(n => n.isDaily && n.dateStr === dateStr);
    if (!note) {
      const date = new Date(dateStr + 'T00:00:00');
      const name = `Daily Note - ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      note = await this.createNote(name);
      note.isDaily = true;
      note.dateStr = dateStr;
      await this.updateNote(note);

      const templateId = await this.getSetting('dailyNoteTemplate');
      if (templateId) {
        await this.applyTemplateToNote(note.id, templateId);
      }
    }
    return note;
  }

  // ============ Note Operations ============

  /**
   * Create a new note
   */
  async createNote(name = 'Untitled') {
    const note = {
      id: Utils.generateId(),
      name: name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      archivedAt: null,
      titleManuallySet: false, // Track if user manually set the title
      lastAutoTitleAt: null, // Track when auto-title last ran
      insights: null, // AI-extracted insights (todos, reminders, deadlines, highlights)
      lastInsightsExtractedAt: null, // Track when insights were last extracted
      preview: '',
      pinned: false,
      todoProgress: null,
      isDaily: false, // flag for daily notes
      dateStr: null, // e.g., '2026-01-28' for daily notes
      isTemplate: false, // flag for template notes
      folderId: null, // parent folder ID
      viewport: {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
      },
      settings: {
        gridType: 'dots',
        backgroundColor: '#fafafa',
      },
    };

    const tx = this.transaction(['canvases', 'search_index'], 'readwrite');
    await tx.objectStore('canvases').add(note);

    // Initial search index entry
    await tx.objectStore('search_index').add({
      noteId: note.id,
      name: note.name,
      content: '',
      updatedAt: note.updatedAt
    });

    return note;
  }

  /**
   * Get all notes (excludes archived and trashed by default)
   */
  async getAllNotes(includeArchived = false) {
    return new Promise((resolve, reject) => {
      // Store name 'canvases' kept for backward compatibility
      const store = this.getStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        let notes = request.result.reverse();
        // Always exclude trashed notes
        notes = notes.filter(note => !note.trashed);
        // Always exclude templates from main list
        notes = notes.filter(note => !note.isTemplate);
        if (!includeArchived) {
          notes = notes.filter(note => !note.archived);
        }
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all note names for autocomplete
   */
  async getNoteNames() {
    const notes = await this.getAllNotes(true);
    return notes
      .map(n => n.name)
      .filter(name => name && name.trim() !== '' && name.toLowerCase() !== 'untitled');
  }

  /**
   * Get archived notes only (excludes trashed)
   */
  async getArchivedNotes() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        const notes = request.result
          .filter(note => note.archived && !note.trashed)
          .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Apply a template to a note
   */
  async applyTemplateToNote(noteId, templateId) {
    const templateElements = await this.getNoteElements(templateId);
    if (!templateElements || templateElements.length === 0) return;

    const note = await this.getNote(noteId);
    if (!note) return;

    // Build replacement variables
    const now = new Date();
    const variables = {
      '{{date}}': now.toLocaleDateString(),
      '{{time}}': now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      '{{title}}': note.name || 'Untitled',
      '{{datetime}}': now.toLocaleString(),
    };

    const processText = (text) => {
      if (typeof text !== 'string') return text;
      let result = text;
      for (const [key, value] of Object.entries(variables)) {
        result = result.split(key).join(value);
      }
      return result;
    };

    // Clone and save elements
    for (const element of templateElements) {
      const newElement = {
        ...element,
        id: Utils.generateId(),
        canvasId: noteId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (newElement.content) {
        newElement.content = processText(newElement.content);
      }
      if (newElement.tableData) {
        newElement.tableData = newElement.tableData.map(row =>
          row.map(cell => processText(cell))
        );
      }

      await this.saveElement(newElement);
    }
  }

  /**
   * Get all template notes
   */
  async getTemplates() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        const notes = request.result
          .filter(note => note.isTemplate && !note.trashed)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Archive a note
   */
  async archiveNote(id) {
    const note = await this.getNote(id);
    if (!note) return null;

    note.archived = true;
    note.archivedAt = Date.now();
    return this.updateNote(note);
  }

  /**
   * Unarchive a note
   */
  async unarchiveNote(id) {
    const note = await this.getNote(id);
    if (!note) return null;

    note.archived = false;
    note.archivedAt = null;
    return this.updateNote(note);
  }

  // ============ Search Index Operations ============

  /**
   * Get all search index entries
   */
  async getSearchIndex() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('search_index');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Set the entire search index
   */
  async setSearchIndex(data) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('search_index', 'readwrite');
      store.clear();
      data.forEach(entry => store.put(entry));
      const tx = store.transaction || store.db.transaction(['search_index'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Update search index for a note
   */
  async updateNoteSearchIndex(noteId, data) {
    const store = this.getStore('search_index', 'readwrite');
    const entry = await store.get(noteId);
    if (entry) {
      const updatedEntry = { ...entry, ...data, updatedAt: Date.now() };
      await store.put(updatedEntry);
    } else {
      await store.add({ noteId, ...data, updatedAt: Date.now() });
    }
  }

  /**
   * Check if a note is empty (has no meaningful content)
   */
  async isNoteEmpty(noteId) {
    const elements = await this.getElementsByNote(noteId);

    // No elements means empty
    if (elements.length === 0) {
      return true;
    }

    // Check if all elements have no meaningful content
    for (const el of elements) {
      // Check text content
      if (el.content) {
        // Strip HTML tags and check for actual text
        const textContent = el.content.replace(/<[^>]*>/g, '').trim();
        if (textContent.length > 0) {
          return false;
        }
      }

      // Check for media content
      if (el.imageUrl || el.fileData || el.videoUrl) {
        return false;
      }

      // Check for table data
      if (el.tableData && Array.isArray(el.tableData)) {
        const hasContent = el.tableData.some(row =>
          row.some(cell => cell && cell.trim() && !cell.startsWith('Header '))
        );
        if (hasContent) {
          return false;
        }
      }

      // Check for bookmark
      if (el.url && el.title) {
        return false;
      }

      // Check for toggle children content
      if (el.children) {
        const childContent = el.children.replace(/<[^>]*>/g, '').trim();
        if (childContent.length > 0) {
          return false;
        }
      }

      // Check for equation
      if (el.equation && el.equation.trim()) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a note is untitled
   */
  isNoteUntitled(note) {
    if (!note || !note.name) return true;
    const name = note.name.toLowerCase().trim();
    return name === '' || name === 'untitled' || name.match(/^untitled\s*\d*$/);
  }

  /**
   * Move note to trash (soft delete)
   * If note is untitled and empty, permanently delete instead
   */
  async trashNote(id) {
    const note = await this.getNote(id);
    if (!note) return null;

    // Check if note is untitled and empty - if so, permanently delete
    const isUntitled = this.isNoteUntitled(note);
    if (isUntitled) {
      const isEmpty = await this.isNoteEmpty(id);
      if (isEmpty) {
        await this.permanentlyDeleteNote(id);
        return { permanentlyDeleted: true };
      }
    }

    note.trashed = true;
    note.trashedAt = Date.now();
    // Clear archived status when trashing
    note.archived = false;
    note.archivedAt = null;
    return this.updateNote(note);
  }

  /**
   * Restore note from trash
   */
  async restoreNote(id) {
    const note = await this.getNote(id);
    if (!note) return null;

    note.trashed = false;
    note.trashedAt = null;
    return this.updateNote(note);
  }

  /**
   * Get trashed notes
   */
  async getTrashedNotes() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        const notes = request.result
          .filter(note => note.trashed)
          .sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Permanently delete note (used for emptying trash)
   */
  async permanentlyDeleteNote(id) {
    // Delete all elements for this note
    await this.deleteElementsByNote(id);
    // Delete all media for this note
    await this.deleteMediaByNote(id);

    // Delete vectors for this note
    try {
      const store = this.getStore('vectors', 'readwrite');
      await store.delete(id);
    } catch (e) {
      console.warn('Failed to delete vectors for note:', id, e);
    }

    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Perform an action on multiple notes at once
   * @param {Array<string>} ids - Array of note IDs
   * @param {string} action - 'trash', 'archive', 'unarchive', 'restore', 'delete'
   */
  async bulkNoteAction(ids, action) {
    if (!ids || ids.length === 0) return [];

    const results = [];
    for (const id of ids) {
      let result;
      switch (action) {
        case 'trash':
          result = await this.trashNote(id);
          break;
        case 'archive':
          result = await this.archiveNote(id);
          break;
        case 'unarchive':
          result = await this.unarchiveNote(id);
          break;
        case 'restore':
          result = await this.restoreNote(id);
          break;
        case 'delete':
          result = await this.permanentlyDeleteNote(id);
          break;
      }
      results.push(result);
    }
    return results;
  }

  /**
   * Alias for getElementsByNote for backward compatibility/consistency
   */
  async getElements(noteId) {
    return this.getElementsByNote(noteId);
  }

  /**
   * Clean up old trashed notes (auto-delete after retention period)
   */
  async cleanupTrash(retentionDays = 30) {
    const trashedNotes = await this.getTrashedNotes();
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

    const expiredNotes = trashedNotes.filter(note =>
      note.trashedAt && note.trashedAt < cutoffTime
    );

    for (const note of expiredNotes) {
      await this.permanentlyDeleteNote(note.id);
    }

    return expiredNotes.length;
  }

  /**
   * Empty trash (permanently delete all trashed notes)
   */
  async emptyTrash() {
    const trashedNotes = await this.getTrashedNotes();
    for (const note of trashedNotes) {
      await this.permanentlyDeleteNote(note.id);
    }
    return trashedNotes.length;
  }

  /**
   * Get note by ID
   */
  async getNote(id) {
    return new Promise((resolve, reject) => {
      // Store name 'canvases' kept for backward compatibility
      const store = this.getStore('canvases');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update note
   */
  async updateNote(note) {
    note.updatedAt = Date.now();
    return new Promise((resolve, reject) => {
      // Store name 'canvases' kept for backward compatibility
      const store = this.getStore('canvases', 'readwrite');
      const request = store.put(note);
      request.onsuccess = async () => {
        // Update search index if name changed
        if (note.name !== undefined) {
          await this.updateNoteNameInSearchIndex(note.id, note.name);
        }
        resolve(note);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Helper to update only name in search index
   */
  async updateNoteNameInSearchIndex(noteId, name) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('search_index', 'readwrite');
      const getRequest = store.get(noteId);
      getRequest.onsuccess = () => {
        const entry = getRequest.result;
        if (entry) {
          entry.name = name;
          entry.updatedAt = Date.now();
          const putRequest = store.put(entry);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          resolve();
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  // ============ Folder Operations ============

  /**
   * Create a new folder
   */
  async createFolder(name, parentId = null) {
    const folder = {
      id: Utils.generateId(),
      name: name,
      parentId: parentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      color: null,
      collapsed: false
    };

    await this.getStore('folders', 'readwrite').add(folder);
    return folder;
  }

  /**
   * Get all folders
   */
  async getAllFolders() {
    return new Promise((resolve, reject) => {
      const request = this.getStore('folders').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get folder by ID
   */
  async getFolder(id) {
    return new Promise((resolve, reject) => {
      const request = this.getStore('folders').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update a folder
   */
  async updateFolder(folder) {
    folder.updatedAt = Date.now();
    return new Promise((resolve, reject) => {
      const request = this.getStore('folders', 'readwrite').put(folder);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete a folder and its contents (recursive)
   */
  async deleteFolder(folderId) {
    // 1. Get all child folders and notes
    const folders = await this.getAllFolders();
    const notes = await this.getAllNotes(true);

    const childrenToProcess = [folderId];
    const foldersToDelete = [];
    const notesToProcess = [];

    // Find all nested folders
    let i = 0;
    while (i < childrenToProcess.length) {
      const currentId = childrenToProcess[i];
      foldersToDelete.push(currentId);

      const childFolders = folders.filter(f => f.parentId === currentId);
      childFolders.forEach(f => {
        if (!childrenToProcess.includes(f.id)) {
          childrenToProcess.push(f.id);
        }
      });

      const folderNotes = notes.filter(n => n.folderId === currentId);
      folderNotes.forEach(n => notesToProcess.push(n));

      i++;
    }

    // 2. Delete folders and process notes (e.g., move to trash or delete)
    const tx = this.transaction(['folders', 'canvases'], 'readwrite');
    const folderStore = tx.objectStore('folders');
    const noteStore = tx.objectStore('canvases');

    for (const id of foldersToDelete) {
      folderStore.delete(id);
    }

    for (const note of notesToProcess) {
      // For now, move orphaned notes to root (null folder)
      note.folderId = null;
      note.updatedAt = Date.now();
      noteStore.put(note);
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Move note to folder
   */
  async moveNoteToFolder(noteId, folderId) {
    const note = await this.getNote(noteId);
    if (note) {
      note.folderId = folderId;
      return this.updateNote(note);
    }
    return false;
  }

  /**
   * Delete note (moves to trash - soft delete)
   */
  async deleteNote(id) {
    return this.trashNote(id);
  }

  // ============ Linking & Backlinks Operations ============

  /**
   * Update internal links for a note
   * @param {string} fromNoteId - The source note
   * @param {Array<string>} targetNoteNames - Names of notes being linked to
   */
  async updateNoteLinks(fromNoteId, targetNoteNames) {
    if (!targetNoteNames || targetNoteNames.length === 0) {
      // Clear existing links from this note
      await this.clearLinksFromNote(fromNoteId);
      return;
    }

    // 1. Find IDs for these note names
    const allNotes = await this.getAllNotes(true);
    const targetIds = [];

    targetNoteNames.forEach(name => {
      const targetNote = allNotes.find(n => n.name && n.name.toLowerCase() === name.toLowerCase());
      if (targetNote && targetNote.id !== fromNoteId) {
        targetIds.push(targetNote.id);
      }
    });

    // 2. Clear old links and add new ones
    const tx = this.transaction('links', 'readwrite');
    const store = tx.objectStore('links');

    // Manual clear
    const index = store.index('fromNoteId');
    const request = index.getAll(fromNoteId);

    return new Promise((resolve, reject) => {
      request.onsuccess = async () => {
        const existingLinks = request.result;
        existingLinks.forEach(link => store.delete(link.id));

        // Add new unique links
        const uniqueTargetIds = [...new Set(targetIds)];
        uniqueTargetIds.forEach(toNoteId => {
          store.add({
            id: Utils.generateId(),
            fromNoteId,
            toNoteId,
            createdAt: Date.now()
          });
        });

        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all links originating from a note
   */
  async clearLinksFromNote(noteId) {
    const tx = this.transaction('links', 'readwrite');
    const store = tx.objectStore('links');
    const index = store.index('fromNoteId');
    const request = index.getAll(noteId);

    return new Promise((resolve) => {
      request.onsuccess = () => {
        request.result.forEach(link => store.delete(link.id));
        resolve();
      };
      request.onerror = () => resolve();
    });
  }

  /**
   * Get all backlinks for a note
   */
  async getBacklinks(noteId) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('links');
      const index = store.index('toNoteId');
      const request = index.getAll(noteId);

      request.onsuccess = async () => {
        const links = request.result;
        const sourceNoteIds = links.map(l => l.fromNoteId);

        // Fetch note details for each source
        const sourceNotes = [];
        for (const id of sourceNoteIds) {
          const note = await this.getNote(id);
          if (note) sourceNotes.push(note);
        }
        resolve(sourceNotes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // ============ Element Operations ============

  /**
   * Save element
   */
  async saveElement(element) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('elements', 'readwrite');
      const request = store.put(element);
      request.onsuccess = () => resolve(element);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Save multiple elements
   */
  async saveElements(elements) {
    return new Promise((resolve, reject) => {
      const tx = this.transaction('elements', 'readwrite');
      const store = tx.objectStore('elements');

      elements.forEach((el) => store.put(el));

      tx.oncomplete = () => resolve(elements);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get elements by note ID
   * Note: Index name 'canvasId' kept for backward compatibility
   */
  async getElementsByNote(noteId) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('elements');
      const index = store.index('canvasId');
      const request = index.getAll(noteId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete element
   */
  async deleteElement(id) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('elements', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete multiple elements
   */
  async deleteElements(ids) {
    return new Promise((resolve, reject) => {
      const tx = this.transaction('elements', 'readwrite');
      const store = tx.objectStore('elements');

      ids.forEach((id) => store.delete(id));

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Delete all elements for a note
   */
  async deleteElementsByNote(noteId) {
    const elements = await this.getElementsByNote(noteId);
    const ids = elements.map((el) => el.id);
    if (ids.length > 0) {
      await this.deleteElements(ids);
    }
  }

  // ============ Media Operations ============

  /**
   * Save media blob
   */
  async saveMedia(id, canvasId, blob, type) {
    const media = {
      id,
      canvasId,
      blob,
      type,
      createdAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const store = this.getStore('media', 'readwrite');
      const request = store.put(media);
      request.onsuccess = () => resolve(media);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get media by ID
   */
  async getMedia(id) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('media');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete media by note
   * Note: Index name 'canvasId' kept for backward compatibility
   */
  async deleteMediaByNote(noteId) {
    return new Promise((resolve, reject) => {
      const tx = this.transaction('media', 'readwrite');
      const store = tx.objectStore('media');
      // Index name 'canvasId' kept for backward compatibility
      const index = store.index('canvasId');
      const request = index.getAllKeys(noteId);

      request.onsuccess = () => {
        request.result.forEach((key) => store.delete(key));
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============ Settings Operations ============
  // Settings use chrome.storage.local for cross-tab synchronization

  /**
   * Get setting from chrome.storage.local
   */
  async getSetting(key, defaultValue = null) {
    return new Promise((resolve) => {
      const storageKey = `setting_${key}`;
      chrome.storage.local.get([storageKey], (result) => {
        if (chrome.runtime.lastError) {
          console.warn('Error getting setting:', chrome.runtime.lastError);
          resolve(defaultValue);
          return;
        }
        resolve(result[storageKey] !== undefined ? result[storageKey] : defaultValue);
      });
    });
  }

  /**
   * Set setting in chrome.storage.local
   */
  async setSetting(key, value) {
    return new Promise((resolve, reject) => {
      const storageKey = `setting_${key}`;
      chrome.storage.local.set({ [storageKey]: value }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error setting value:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Get all settings
   */
  async getAllSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (result) => {
        if (chrome.runtime.lastError) {
          console.warn('Error getting all settings:', chrome.runtime.lastError);
          resolve({});
          return;
        }
        // Filter to only setting_ prefixed keys and remove prefix
        const settings = {};
        for (const [key, value] of Object.entries(result)) {
          if (key.startsWith('setting_')) {
            settings[key.substring(8)] = value;
          }
        }
        resolve(settings);
      });
    });
  }

  /**
   * Add listener for settings changes (for cross-tab sync)
   */
  onSettingsChange(callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      const settingChanges = {};
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith('setting_')) {
          const settingKey = key.substring(8);
          settingChanges[settingKey] = {
            oldValue: change.oldValue,
            newValue: change.newValue
          };
        }
      }

      if (Object.keys(settingChanges).length > 0) {
        callback(settingChanges);
      }
    });
  }

  /**
   * Initialize default settings in chrome.storage.local on first load
   * This ensures the storage permission is actively used from the start
   */
  async initializeDefaultSettings() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        console.warn('Storage: chrome.storage.local not available. Fallback might be needed.');
        resolve();
        return;
      }

      chrome.storage.local.get(['setting_storageInitialized'], async (result) => {
        if (result.setting_storageInitialized) {
          // Already initialized
          resolve();
          return;
        }

        // Default settings to write
        const defaultSettings = {
          setting_storageInitialized: true,
          setting_theme: 'system',
          setting_font: 'default',
          setting_width: 'default',
          setting_llmProvider: 'none',
          setting_llmApiKey: '',
          setting_llmModel: '',
          setting_ollamaUrl: 'http://localhost:11434',
          setting_trashRetention: 30,
          setting_sidebarOpen: true,
          setting_sidebarWidth: 260,
          setting_sidebarViewMode: 'list',
          setting_autoTitleEnabled: false,
          setting_autoTitleInterval: 15,
          setting_insightsEnabled: false,
          setting_insightsInterval: 360,
          setting_aiSidebarWidth: 360,
          setting_openTabs: null,
          setting_activeTabIndex: 0,
          setting_aiChatHistory: [],
          setting_noteChatMessages: [],
          setting_globalChatHistory: [],
          setting_globalChatMessages: [],
          setting_lastAutoTitleRun: 0,
          setting_lastInsightsRun: 0
        };

        chrome.storage.local.set(defaultSettings, () => {
          if (chrome.runtime.lastError) {
            console.warn('Error initializing default settings:', chrome.runtime.lastError);
          } else {
            console.log('Default settings initialized in chrome.storage.local');
          }
          resolve();
        });
      });
    });
  }

  // ============ Export/Import ============

  /**
   * Export all data
   */
  async exportAll() {
    const notes = await this.getAllNotes();
    const allElements = [];
    const allMedia = [];

    for (const note of notes) {
      const elements = await this.getElementsByNote(note.id);
      allElements.push(...elements);
    }

    // Get all media
    const mediaStore = this.getStore('media');
    const mediaRequest = await new Promise((resolve, reject) => {
      const request = mediaStore.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    allMedia.push(...mediaRequest);

    // Convert blobs to base64 for export
    const mediaWithBase64 = await Promise.all(
      allMedia.map(async (m) => {
        if (m.blob instanceof Blob) {
          const base64 = await Utils.readFileAsDataURL(m.blob);
          return { ...m, blob: base64 };
        }
        return m;
      })
    );

    return {
      version: 1,
      exportedAt: Date.now(),
      // Key name 'canvases' kept for backward compatibility with existing exports
      canvases: notes,
      elements: allElements,
      media: mediaWithBase64,
    };
  }

  /**
   * Export single note
   */
  async exportNote(noteId) {
    const note = await this.getNote(noteId);
    const elements = await this.getElementsByNote(noteId);

    // Get media for this note
    const mediaStore = this.getStore('media');
    // Index name 'canvasId' kept for backward compatibility
    const index = mediaStore.index('canvasId');
    const media = await new Promise((resolve, reject) => {
      const request = index.getAll(noteId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // Convert blobs to base64
    const mediaWithBase64 = await Promise.all(
      media.map(async (m) => {
        if (m.blob instanceof Blob) {
          const base64 = await Utils.readFileAsDataURL(m.blob);
          return { ...m, blob: base64 };
        }
        return m;
      })
    );

    return {
      version: 1,
      exportedAt: Date.now(),
      // Key name 'canvases' kept for backward compatibility with existing exports
      canvases: [note],
      elements,
      media: mediaWithBase64,
    };
  }

  /**
   * Import data
   * Note: Import format uses 'canvases' key for backward compatibility
   */
  async importData(data, merge = false) {
    if (!merge) {
      // Clear existing data
      const existingNotes = await this.getAllNotes();
      for (const note of existingNotes) {
        await this.deleteNote(note.id);
      }
    }

    // Import notes (data uses 'canvases' key for backward compatibility)
    for (const note of data.canvases) {
      if (merge) {
        // Generate new IDs to avoid conflicts
        const oldId = note.id;
        note.id = Utils.generateId();

        // Update element references (field name 'canvasId' kept for backward compatibility)
        data.elements
          .filter((el) => el.canvasId === oldId)
          .forEach((el) => {
            el.canvasId = note.id;
          });

        // Update media references (field name 'canvasId' kept for backward compatibility)
        data.media
          .filter((m) => m.canvasId === oldId)
          .forEach((m) => {
            m.canvasId = note.id;
          });
      }

      await new Promise((resolve, reject) => {
        // Store name 'canvases' kept for backward compatibility
        const store = this.getStore('canvases', 'readwrite');
        const request = store.put(note);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    // Import elements
    await this.saveElements(data.elements);

    // Import media (convert base64 back to blobs)
    // Field name 'canvasId' kept for backward compatibility
    for (const m of data.media) {
      if (typeof m.blob === 'string' && m.blob.startsWith('data:')) {
        const response = await fetch(m.blob);
        m.blob = await response.blob();
      }
      await this.saveMedia(m.id, m.canvasId, m.blob, m.type);
    }

    return data.canvases;
  }

  /**
   * Get all custom themes
   */
  async getCustomThemes() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('themes');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        resolve(request.result.reverse());
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Save a custom theme
   */
  async saveCustomTheme(theme) {
    if (!theme.id) theme.id = Utils.generateId();
    theme.updatedAt = Date.now();

    return new Promise((resolve, reject) => {
      const store = this.getStore('themes', 'readwrite');
      const request = store.put(theme);
      request.onsuccess = () => resolve(theme);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete a custom theme
   */
  async deleteCustomTheme(id) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('themes', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Save a vector embedding for a note
   */
  async saveVector(noteId, vector) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('vectors', 'readwrite');
      const request = store.put({ id: noteId, noteId, vector, updatedAt: Date.now() });
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get a vector embedding for a note
   */
  async getVector(noteId) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('vectors', 'readonly');
      const request = store.get(noteId);
      request.onsuccess = () => resolve(request.result?.vector || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all vectors
   */
  async getAllVectors() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('vectors', 'readonly');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
}

// Global instance
const Storage = new DatabaseManager();
(typeof window !== 'undefined' ? window : self).Storage = Storage;
