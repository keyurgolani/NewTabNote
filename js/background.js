/**
 * Background service worker for New Tab Note
 * Handles context menus, keyboard shortcuts, and API requests via offscreen document.
 *
 * A module worker (manifest background "type": "module"). Everything it imports runs before
 * the listeners below register, and a throw there stops the worker with no menus or
 * commands, so no module in this graph may throw, or use top-level await, while it loads.
 * `npm run check:dist` checks the await, and e2e/worker.spec.js the registrations. In this
 * file every listener registers first, and #35's coordinator is built last, in a try/catch
 * (test/background-coordinator.test.js lists each listener, and which start it).
 */

// The network guard first, ahead of every other module (#21 slice 1b): it wraps the worker's
// fetch before anything else can call it, and never throws
import './kernel/composition/network-guard-first.js';
// utils.js and storage.js put Utils and Storage on self, where the worker's root finds Storage
import './utils.js';
import './storage.js';
import { createWorkerClient, installWorkerRouter } from './kernel/composition/background.js';
import { coordinatorInstanceId, createCoordinator, unavailableCoordinator } from './kernel/composition/coordinator.js';
import { createFailureEvents } from './kernel/composition/trust.js';
import { checkRequest, isOwnSender, send, storedLoopbackOrigin } from './kernel/composition/api-request.js';
import { REGISTRY_PROBLEMS } from './kernel/composition/destinations.js';
import { journalRefusals, refuseEveryDestination } from './kernel/composition/network-refusals.js';

// A registry the destination client found a problem with: the client refuses every request,
// and so does the network guard, which reports why once (#21 slice 1b)
if (REGISTRY_PROBLEMS.length > 0) refuseEveryDestination(self);

/** This worker instance's id, which #13's router sends in each welcome (#35) */
const instanceId = coordinatorInstanceId();

/**
 * The background coordinator (#35, js/kernel/composition/coordinator.js), built at the end of
 * this file, after every listener, so a throw while building it leaves the menus, the commands
 * and #13's port listener in place. Until then, and for good if building it threw, this
 * stand-in answers that it can't serve. It opens nothing until an event needs storage: an
 * install or update, a browser start, a page's port session, or a capture.
 */
let coordinator = unavailableCoordinator(instanceId);

/**
 * The worker's failure events (#20, "Diagnostic journal"), set with the coordinator at the end
 * of this file: a failed open and a failed capture go to the diagnostic journal and raise their
 * incidents in NewTabNoteTrust, which opens only when the first one happens. Best effort:
 * nothing here changes what the worker does or logs.
 * @type {{event(code: string, fields?: Record<string, unknown>, error?: unknown): void}}
 */
let failureEvents = { event() {} };

/**
 * #13's router, which takes each port this extension's pages open by its name. It's installed
 * here at the top level, synchronously, so Chrome finds its listener when a port wakes the
 * worker. Each welcome says what the coordinator can do now, and a page's session starts it.
 * It never throws.
 */
installWorkerRouter({
  coordinatorId: instanceId,
  status: () => coordinator.status(),
  sessions: {
    opened: () => {
      coordinator.start();
    },
  },
});

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
  // Check if offscreen document already exists. Both paths stay string literals, so the
  // build's closure check (#27) can find offscreen.html in the package.
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });

  if (existingContexts.length > 0) {
    return;
  }

  // Create offscreen document if it doesn't exist. One that couldn't be made is made again at
  // the next request, so a failure once doesn't send every later one around it.
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING'],
      justification: 'Making API requests to bypass CORS for Ollama and other LLM providers'
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

/** How long the worker waits for the offscreen document's answer before it fetches itself */
const OFFSCREEN_ANSWER_MS = 30_000;

/**
 * `message` sent to the offscreen document, and its answer, or undefined when it doesn't
 * answer within OFFSCREEN_ANSWER_MS
 * @param {object} message
 * @returns {Promise<unknown>}
 */
async function askOffscreen(message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), OFFSCREEN_ANSWER_MS); });
  try {
    return await Promise.race([chrome.runtime.sendMessage(message), late]);
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
      const response = /** @type {{ok: boolean, status: number, data: *} | {error: string} | undefined} */ (await askOffscreen({
        type: 'OFFSCREEN_API_REQUEST',
        url: checked.url,
        options,
        loopbackOrigin: new URL(checked.url).origin,
      }));
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
chrome.runtime.onInstalled.addListener((details) => {
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

  // The menus first, then storage: first-run settings, and after an install or an update the
  // read-only integrity check (#35)
  coordinator.installed(details && details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelAction();
  coordinator.start();
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
    await coordinator.start();
    const kernel = coordinator.client();
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

// ============ The coordinator ============

// Built last, after every listener above (#35): a throw here leaves them all in place
try {
  const events = createFailureEvents({ surface: 'worker-internal' });
  failureEvents = events;
  // The calls the network guard refused, the ones it held since the worker started first
  journalRefusals(self, events);
  // Sightings a context held in chrome.storage.local because NewTabNoteTrust wouldn't open
  // reconcile now, not only at the next failure; with none held this reads one key and opens
  // nothing
  events.reconcile();
} catch {
  // The journal is best effort: without it the worker does exactly what it did
}
try {
  coordinator = createCoordinator({ instanceId, makeKernel: () => createWorkerClient(), events: failureEvents });
} catch (error) {
  // The stand-in stays, and every capture says it couldn't open the notes
  console.error("NewTabNote: the background coordinator couldn't be built", error);
}
