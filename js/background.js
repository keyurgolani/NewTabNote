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
Storage.init();

let creatingOffscreen;

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
    console.log('Background: Received API_REQUEST for', request.url);
    handleApiRequest(request)
      .then(response => {
        console.log('Background: API response status:', response.status, 'ok:', response.ok);
        sendResponse(response);
      })
      .catch(error => {
        console.error('Background: API error:', error.message);
        sendResponse({ error: error.message });
      });
    return true;
  }
});

async function handleApiRequest(request) {
  const { url, options } = request;

  console.log('Background: Making fetch to', url);

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
      console.log('Background: Offscreen failed, trying direct fetch:', e.message);
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
    console.log('Background: Fetch response status:', response.status);

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
 * Capture content to daily note
 */
async function captureToDailyNote(item) {
  try {
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
        content: item.content + (item.source ? ` (Source: ${item.source})` : ''),
        canvasId: note.id,
        order: Date.now()
      };
    }

    await Storage.saveElement(blockData);

    // Notify user
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Captured to New Tab Note',
      message: item.type === 'bookmark' ? `Saved link: ${item.title}` : 'Saved selected text'
    });

  } catch (error) {
    console.error('Failed to capture to daily note:', error);
  }
}
