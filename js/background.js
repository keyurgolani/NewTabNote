/**
 * Background service worker for New Tab Note
 * Handles context menus, keyboard shortcuts, and API requests via offscreen document.
 *
 * A module worker (manifest background "type": "module"). Everything it imports runs before
 * the listeners below register, and a throw there stops the worker with no menus or
 * commands, so no module in this graph may throw, or use top-level await, while it loads.
 * `npm run check:dist` checks the await, and e2e/worker.spec.js the registrations.
 */

// utils.js and storage.js put Utils and Storage on self, where the worker's root finds Storage
import './utils.js';
import './storage.js';
import { createWorkerClient } from './kernel/composition/background.js';

/**
 * The worker's kernel. It opens the database and runs startup maintenance now, as
 * Storage.init() did here, and a capture waits for both.
 */
const kernel = createWorkerClient();

/**
 * The worker's global. A module's top-level functions aren't globals, so captureToDailyNote
 * is published here for #34's harness, and the listeners call it through this name, as
 * they did in the classic worker. It runs the kernel's captureToDailyNote command.
 * @type {any}
 */
const workerGlobal = self;
workerGlobal.captureToDailyNote = captureToDailyNote;

/** Why a capture can't be saved (the reasons the new tab shows) */
const CAPTURE_REFUSALS = {
  newerSchema: "Your notes were upgraded by a newer NewTabNote version. This version can't open them safely, so it won't change anything. Update NewTabNote to keep working.",
  missingCoreStores: "Your notes database is incomplete, so this version won't change anything. Open a new tab to export a copy.",
};

/**
 * The refusal for a kernel answer that says the database can't be opened safely: a newer
 * build upgraded it, or it's missing its notes or blocks. Null for any other answer.
 * @param {{cause?: string, code: string}} answer
 * @returns {string | null}
 */
function captureRefusal({ cause, code }) {
  if (cause === 'newer-schema') return CAPTURE_REFUSALS.newerSchema;
  if (code === 'missing-core-stores') return CAPTURE_REFUSALS.missingCoreStores;
  return null;
}

/**
 * Why a capture failed otherwise, in words, by the outcome's messageKey: an outcome carries
 * no error message, which is what 1.4.x showed here. #26 gives every outcome its copy.
 */
const CAPTURE_FAILURES = {
  'unavailable.quota': 'there is no room left to store it',
};
const CAPTURE_FAILED = "the notes database couldn't store it";

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
    workerGlobal.captureToDailyNote({
      type: 'bookmark',
      url: tab.url,
      title: tab.title
    });
  } else if (info.menuItemId === 'capture-selection') {
    workerGlobal.captureToDailyNote({
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
    workerGlobal.captureToDailyNote({
      type: 'bookmark',
      url: tab.url,
      title: tab.title
    });
  } else if (command === 'capture-selection') {
    // Selection capture via command requires content script or scripting API
    // For now, only page capture is reliable via command without content script
    workerGlobal.captureToDailyNote({
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
 * Capture a page, or selected text and the page it came from, to today's Daily Note with the
 * kernel's captureToDailyNote command. Saved, refused (the database can't be opened safely),
 * and failed captures each end with a notification.
 * @param {{type: 'bookmark', url?: string, title?: string} | {type: 'text', content: string, source?: string}} item
 * @returns {Promise<void>}
 */
async function captureToDailyNote(item) {
  try {
    const failure = await kernel.whenReady();
    if (failure) {
      notifyCapture('Not captured', captureRefusal(failure) || "NewTabNote couldn't open your notes, so nothing was saved.");
      return;
    }
    const outcome = await kernel.execute({
      type: 'captureToDailyNote',
      commandId: kernel.ids.next(),
      // The Daily Note's id if this capture makes it, and the captured block's
      noteId: kernel.ids.next(),
      blockId: kernel.ids.next(),
      capture: item.type === 'bookmark'
        ? { type: 'bookmark', url: item.url, title: item.title }
        : { type: 'text', content: item.content, source: item.source },
    });
    if (outcome.kind !== 'committed') {
      const reason = CAPTURE_FAILURES[outcome.messageKey] || CAPTURE_FAILED;
      notifyCapture('Not captured', captureRefusal(outcome) || `Saving to today's note failed: ${reason}`);
      return;
    }
    notifyCapture('Captured to New Tab Note', item.type === 'bookmark' ? `Saved link: ${item.title}` : 'Saved selected text');
  } catch (error) {
    console.error('Failed to capture to daily note:', error);
    notifyCapture('Not captured', `Saving to today's note failed: ${error && error.message ? error.message : 'unknown error'}`);
  }
}
