/**
 * Storage manager using IndexedDB for New Tab Note
 * 
 * Note: IndexedDB store names remain as 'canvases' for backward compatibility
 * with existing user data. The API methods use "Note" terminology.
 */

class StorageManager {
  constructor() {
    this.dbName = 'CanvasTabDB';
    this.dbVersion = 2; // Bumped version to force upgrade
    this.db = null;
    // Store names kept as 'canvases' for backward compatibility with existing databases
    this.requiredStores = ['canvases', 'elements', 'settings', 'media'];
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

      request.onsuccess = (event) => {
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

        // Media blobs store (for images/videos)
        if (!db.objectStoreNames.contains('media')) {
          const mediaStore = db.createObjectStore('media', { keyPath: 'id' });
          mediaStore.createIndex('canvasId', 'canvasId', { unique: false });
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

    return new Promise((resolve, reject) => {
      // Store name 'canvases' kept for backward compatibility
      const store = this.getStore('canvases', 'readwrite');
      const request = store.add(note);
      request.onsuccess = () => resolve(note);
      request.onerror = () => reject(request.error);
    });
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
        if (!includeArchived) {
          notes = notes.filter(note => !note.archived);
        }
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
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

    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
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
      request.onsuccess = () => resolve(note);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete note (moves to trash - soft delete)
   */
  async deleteNote(id) {
    return this.trashNote(id);
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
      // Index name 'canvasId' kept for backward compatibility
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
}

// Create global instance
window.Storage = new StorageManager();
