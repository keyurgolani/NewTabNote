/**
 * Background service worker for New Tab Note
 * Handles context menus, keyboard shortcuts, and API requests via offscreen document.
 *
 * A module worker (manifest background "type": "module"). Everything it imports runs before
 * the listeners below register, and a throw there stops the worker with no menus or
 * commands, so no module in this graph may throw, or use top-level await, while it loads.
 * `npm run check:dist` checks the await, and e2e/worker.spec.js the registrations.
 */

// utils.js and storage.js put Utils and Storage on self. The worker's kernel no longer runs on
// Storage (#17 PR 1b), and nothing here opens it; #34's harness seeds profiles through it.
import './utils.js';
import './storage.js';
import {
  MIGRATE_MESSAGE,
  PURGE_MESSAGE,
  createWorkerClient,
  installWorkerRouter,
  migrationEvents,
  workerHost,
} from './kernel/composition/background.js';
import { createFailureEvents } from './kernel/composition/trust.js';
import { checkRequest, isOwnSender, send, storedLoopbackOrigin } from './kernel/composition/api-request.js';

/** When the worker started opening the database, for how long a failed open took */
const openStartedAt = Date.now();

/**
 * The worker's failure events (#20, "Diagnostic journal"): a failed open, a failed capture, and
 * a stopped recovery-point purge go to the diagnostic journal and raise their incidents in
 * NewTabNoteTrust, which opens only when the first one happens. Best effort: nothing here
 * changes what the worker does or logs.
 */
const failureEvents = createFailureEvents({ surface: 'worker-internal' });


// Sightings a context held in chrome.storage.local because NewTabNoteTrust wouldn't open
// reconcile now, not only at the next failure; with none held this reads one key and opens
// nothing
failureEvents.reconcile();

/**
 * The worker's kernel. It starts #17's migration run now, which upgrades the notes database
 * after a verified recovery point, then opens the database and runs startup maintenance, and a
 * capture waits for all of it, except while an older build's open page blocks the upgrade.
 * Each run it makes goes to the journal as its own migration event (#20), and so does a purge
 * of the recovery points that stopped, and its end (#17 PR 2b).
 */
const kernel = createWorkerClient({ ...workerHost(), report: migrationEvents(failureEvents.event), events: failureEvents });

// The worker's storage init: an open that failed is a storage incident now, not only when a
// capture finds it
kernel.whenReady().then(
  failure => {
    // A blocked upgrade is the run's own event (storage.migration-blocked), not a failed open
    if (!failure || failure.code === 'blocked-upgrade') return;
    failureEvents.event(
      'storage.open-failed',
      { subjectId: 'CanvasTabDB', durationMs: Math.max(0, Date.now() - openStartedAt) },
      failure,
    );
  },
  () => {},
);

/**
 * #13's router, which takes each port this extension's pages open by its name. It's installed
 * here at the top level, synchronously, so Chrome finds its listener when a port wakes the
 * worker. It serves only the handshake and system.messagingHealth until #35, and it never
 * throws.
 */
installWorkerRouter();

/**
 * The worker's global. A module's top-level functions aren't globals, so captureToDailyNote
 * is published here for #34's harness, and the listeners call it through this name, as
 * they did in the classic worker. It runs the kernel's captureToDailyNote command.
 * @type {any}
 */
const workerGlobal = self;
workerGlobal.captureToDailyNote = captureToDailyNote;
/** The latest migration attempt's outcome, for #34's harness, which seeds a profile only once it's in */
Object.defineProperty(workerGlobal, 'storageUpgrade', { get: () => kernel.migration.done, configurable: true });
/** The latest data transforms' outcome (#17 PR 3a), for #34's harness */
Object.defineProperty(workerGlobal, 'storageTransforms', { get: () => kernel.transforms.done, configurable: true });
/** The latest recovery-point purge's outcome (#17 PR 2b), for #34's harness */
Object.defineProperty(workerGlobal, 'storagePurge', { get: () => kernel.purge.done, configurable: true });

/** Why a capture can't be saved (the reasons the new tab shows) */
const CAPTURE_REFUSALS = {
  newerSchema: "Your notes were upgraded by a newer NewTabNote version. This version can't open them safely, so it won't change anything. Update NewTabNote to keep working.",
  missingCoreStores: "Your notes database is incomplete, so this version won't change anything. Open a new tab to export a copy.",
  // #17 PR 1b: the upgrade waits on an open page of an older version, and there's no journal yet
  blockedUpgrade: 'NewTabNote is updating how your notes are stored, and an open NewTabNote tab or window is holding them. Close or reload it, then try again.',
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
  if (code === 'blocked-upgrade') return CAPTURE_REFUSALS.blockedUpgrade;
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
  // Check if offscreen document already exists. Both paths stay string literals, so the
  // build's closure check (#27) can find offscreen.html in the package.
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });

  if (existingContexts.length > 0) {
    return;
  }

  // Create offscreen document if it doesn't exist
  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING'],
      justification: 'Making API requests to bypass CORS for Ollama and other LLM providers'
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // A page that found no database, or an older one, waits on the migration (#17, Q12): the
  // attempt in progress, or after one that was short of space or failed, a new one. Only its
  // status goes back, never anything stored. It's accepted only from the extension's own
  // senders (#21's isOwnSender, as API_REQUEST below), a page in a tab included, since a new
  // attempt can make another full recovery point.
  if (request && request.type === MIGRATE_MESSAGE) {
    if (!isOwnSender(sender)) {
      sendResponse({ status: 'refused' });
      return false;
    }
    kernel.migration.request().then(
      outcome => sendResponse({ status: outcome.status }),
      () => sendResponse({ status: 'failed' }),
    );
    return true;
  }
  // A page of this extension deleted something for good (#17 PR 2b): purge it from the recovery
  // points. The message carries nothing; the sweep goes by the tombstones the delete left, and
  // only the status goes back. It's accepted only from the extension's own senders, as
  // storage.migrate is.
  if (request && request.type === PURGE_MESSAGE) {
    if (!isOwnSender(sender)) {
      sendResponse({ status: 'refused' });
      return false;
    }
    kernel.purge.request().then(
      outcome => sendResponse({ status: outcome ? outcome.status : 'skipped' }),
      () => sendResponse({ status: 'failed' }),
    );
    return true;
  }
  if (request && request.type === 'API_REQUEST') {
    // Only this extension's own pages and worker (#21): a web page or another extension
    // never gets a request made for it
    if (!isOwnSender(sender)) {
      sendResponse({ error: 'request-refused' });
      return false;
    }
    handleApiRequest(request)
      .then(response => {
        if ('error' in response) console.debug('Background: API request failed:', response.error);
        else console.debug('Background: API response status:', response.status, 'ok:', response.ok);
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
 * Handle an API request by proxying it via fetch or the offscreen document, once the policy
 * took it (js/kernel/composition/api-request.js): a packaged destination, or the Ollama URL's
 * loopback origin, with Content-Type only
 * @param {{url: string, options: Object}} request - Request details
 * @returns {Promise<{ok: boolean, status: number, data: *} | {error: string}>} Response object
 */
async function handleApiRequest(request) {
  const checked = checkRequest(request, { loopback: await storedLoopbackOrigin() });
  if (!checked.ok) return { error: 'request-refused' };

  console.debug('Background: Making fetch to', checked.url);

  // The Ollama URL goes through the offscreen document, which checks it again
  if (checked.loopback) {
    try {
      await ensureOffscreenDocument();
      /** @type {{method: string, body?: string}} */
      const options = { method: checked.method };
      if (checked.body !== undefined) options.body = checked.body;
      const response = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_API_REQUEST',
        url: checked.url,
        options,
        loopbackOrigin: new URL(checked.url).origin,
      });
      // Its answer is final, an error included, so the loopback origin is reached once. The
      // worker fetches itself only when the document can't be reached or doesn't answer
      if (response) return response;
    } catch (e) {
      console.debug('Background: Offscreen failed, trying direct fetch:', e.message);
    }
  }

  try {
    const answer = await send(checked);
    console.debug('Background: Fetch response status:', answer.status);
    return answer;
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
 * and failed captures each end with a notification, and a refused or failed one also with a
 * `capture.failed` event, which holds the outcome's cause and code and never what was captured.
 * @param {{type: 'bookmark', url?: string, title?: string} | {type: 'text', content: string, source?: string}} item
 * @returns {Promise<void>}
 */
async function captureToDailyNote(item) {
  try {
    const failure = await kernel.whenReady();
    if (failure) {
      const refusal = captureRefusal(failure);
      // Its cause and code: a refusal warns, as 1.4.x did at open, and any other failure is an error
      (refusal ? console.warn : console.error)('Storage not opened in background:', failure);
      notifyCapture('Not captured', refusal || "NewTabNote couldn't open your notes, so nothing was saved.");
      failureEvents.event('capture.failed', {}, failure);
      return;
    }
    const commandId = kernel.ids.next();
    const outcome = await kernel.execute({
      type: 'captureToDailyNote',
      commandId,
      // The Daily Note's id if this capture makes it, and the captured block's
      noteId: kernel.ids.next(),
      blockId: kernel.ids.next(),
      capture: item.type === 'bookmark'
        ? { type: 'bookmark', url: item.url, title: item.title }
        : { type: 'text', content: item.content, source: item.source },
    });
    if (outcome.kind !== 'committed') {
      const refusal = captureRefusal(outcome);
      // An outcome holds its kind, cause, and code, and never what was captured
      (refusal ? console.warn : console.error)('Failed to capture to daily note:', outcome);
      const reason = CAPTURE_FAILURES[outcome.messageKey] || CAPTURE_FAILED;
      notifyCapture('Not captured', refusal || `Saving to today's note failed: ${reason}`);
      failureEvents.event('capture.failed', { commandId }, outcome);
      return;
    }
    notifyCapture('Captured to New Tab Note', item.type === 'bookmark' ? `Saved link: ${item.title}` : 'Saved selected text');
    // A capture that committed resolves an earlier capture failure (#20); it opens NewTabNoteTrust
    // only while one may be open
    failureEvents.event('capture.committed', { commandId });
  } catch (error) {
    console.error('Failed to capture to daily note:', error);
    notifyCapture('Not captured', `Saving to today's note failed: ${error && error.message ? error.message : 'unknown error'}`);
    failureEvents.event('capture.failed', {}, error);
  }
}
