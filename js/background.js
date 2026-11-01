/**
 * Background service worker for New Tab Note
 * Handles context menus, keyboard shortcuts, and API requests via offscreen document.
 */

// Import shared logic
try {
  importScripts('utils.js', 'storage.js');
} catch (e) {
  console.error('Failed to import scripts in background:', e);
}

// Global Storage instance for background (instantiated in storage.js)
let storageReady = Storage.init().catch(e => {
  if (e && (e.code === 'NEWER_SCHEMA' || e.code === 'MISSING_CORE_STORES')) {
    console.warn('Storage not opened in background:', e.message);
  } else {
    console.error('Storage init failed in background:', e);
  }
});

/**
 * The shared DatabaseManager from storage.js. The bare `Storage` global also
 * names the DOM's Web Storage type, so typed reads go through this.
 * @returns {DatabaseManager}
 */
function workerStorage() {
  return /** @type {any} */ (self).Storage;
}

/** Why a capture can't be saved, by Storage.openState (same reason the new tab shows). */
const CAPTURE_REFUSALS = {
  'newer-version': "Your notes were upgraded by a newer NewTabNote version. This version can't open them safely, so it won't change anything. Update NewTabNote to keep working.",
  'missing-core-stores': "Your notes database is incomplete, so this version won't change anything. Open a new tab to export a copy.",
};

let creatingOffscreen;

function supportsSidePanel() {
  return Boolean(chrome.sidePanel && chrome.sidePanel.open);
}

async function enableSidePanelAction() {
  if (!chrome.sidePanel?.setPanelBehavior) return;

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('Failed to enable side panel action behavior:', error.message);
  }
}

async function openFallbackPage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
}

async function openExtensionSidePanel(tab) {
  if (!supportsSidePanel()) {
    await openFallbackPage();
    return;
  }

  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.warn('Failed to open side panel, opening fallback page:', error.message);
    await openFallbackPage();
  }
}

/**
 * Ensure the offscreen document exists for API proxying.
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  const offscreenUrl = 'offscreen.html';

  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(offscreenUrl)]
  });

  if (existingContexts.length > 0) {
    return;
  }

  // Create offscreen document if it doesn't exist
  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['DOM_SCRAPING'],
      justification: 'Making API requests to bypass CORS for Ollama and other LLM providers'
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ status: 'ok' });
    return true;
  }

  if (request.type === 'API_REQUEST') {
    console.debug('Background: Received API_REQUEST for', request.url);
    handleApiRequest(request)
      .then(response => {
        console.debug('Background: API response status:', response.status, 'ok:', response.ok);
        sendResponse(response);
      })
      .catch(error => {
        console.error('Background: API error:', error.message);
        sendResponse({ error: error.message });
      });
    return true;
  }
});

/**
 * Handle an API request by proxying it via fetch or offscreen document.
 * @param {{url: string, options: Object}} request - Request details
 * @returns {Promise<{ok: boolean, status: number, data: *}>} Response object
 */
async function handleApiRequest(request) {
  const { url, options } = request;

  console.debug('Background: Making fetch to', url);

  // For localhost requests, try to use the offscreen document
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    try {
      await ensureOffscreenDocument();
      // Forward the request to the offscreen document
      const response = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_API_REQUEST',
        url,
        options
      });
      if (response && !response.error) {
        return response;
      }
    } catch (e) {
      console.debug('Background: Offscreen failed, trying direct fetch:', e.message);
    }
  }

  try {
    const fetchOptions = {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (options.body) {
      fetchOptions.body = options.body;
    }

    const response = await fetch(url, fetchOptions);
    console.debug('Background: Fetch response status:', response.status);

    const contentType = response.headers.get('content-type') || '';

    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      ok: response.ok,
      status: response.status,
      data: data
    };
  } catch (error) {
    console.error('Background: Fetch error:', error.message);
    return {
      ok: false,
      status: 0,
      error: error.message
    };
  }
}

// ============ Context Menu & Commands ============

/**
 * Handle extension installation/update
 */
chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelAction();

  // Create context menu items
  chrome.contextMenus.create({
    id: 'capture-page',
    title: 'Add current page to today\'s note',
    contexts: ['page']
  });

  chrome.contextMenus.create({
    id: 'capture-selection',
    title: 'Add selection to today\'s note',
    contexts: ['selection']
  });
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelAction();
});

chrome.action.onClicked.addListener((tab) => {
  openExtensionSidePanel(tab);
});

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'capture-page') {
    captureToDailyNote({
      type: 'bookmark',
      url: tab.url,
      title: tab.title
    });
  } else if (info.menuItemId === 'capture-selection') {
    captureToDailyNote({
      type: 'text',
      content: info.selectionText,
      source: tab.url
    });
  }
});

/**
 * Handle keyboard commands
 */
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'capture-page') {
    captureToDailyNote({
      type: 'bookmark',
      url: tab.url,
      title: tab.title
    });
  } else if (command === 'capture-selection') {
    // Selection capture via command requires content script or scripting API
    // For now, only page capture is reliable via command without content script
    captureToDailyNote({
      type: 'bookmark',
      url: tab.url,
      title: tab.title
    });
  }
});

/**
 * Show the outcome of a capture.
 * @param {string} title
 * @param {string} message
 * @returns {void}
 */
function notifyCapture(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title, message });
}

/**
 * Capture content to daily note. Saved, refused (the database can't be
 * opened safely), and failed captures each end with a notification.
 */
async function captureToDailyNote(item) {
  try {
    await storageReady;
    const openState = workerStorage().openState;
    if (openState !== 'open') {
      notifyCapture('Not captured', CAPTURE_REFUSALS[openState] || "NewTabNote couldn't open your notes, so nothing was saved.");
      return;
    }
    const note = await Storage.ensureDailyNote();

    // Create new block
    let blockData;
    if (item.type === 'bookmark') {
      blockData = {
        id: Utils.generateId(),
        type: 'bookmark',
        content: '',
        url: item.url,
        title: item.title,
        canvasId: note.id,
        order: Date.now() // Simple order for now
      };
    } else {
      blockData = {
        id: Utils.generateId(),
        type: 'text',
        // The selection and its page are plain text, escaped into the block's rich content
        content: Utils.escapePlainText(item.content) + (item.source ? ` (Source: ${Utils.escapePlainText(item.source)})` : ''),
        canvasId: note.id,
        order: Date.now()
      };
    }

    await Storage.saveElement(blockData);

    // Notify user
    notifyCapture('Captured to New Tab Note', item.type === 'bookmark' ? `Saved link: ${item.title}` : 'Saved selected text');

  } catch (error) {
    console.error('Failed to capture to daily note:', error);
    notifyCapture('Not captured', `Saving to today's note failed: ${error && error.message ? error.message : 'unknown error'}`);
  }
}
