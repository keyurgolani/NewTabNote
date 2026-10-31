/**
 * Background service worker for New Tab Note
 * Handles context menus and keyboard shortcuts. Its network, the API request proxy and the
 * offscreen document it goes through included, is js/kernel/composition/worker-network.js's,
 * installed in one call at the end of this file.
 *
 * A module worker (manifest background "type": "module"). Everything it imports runs before
 * the listeners below register, and a throw there stops the worker with no menus or
 * commands, so no module in this graph may throw, or use top-level await, while it loads.
 * `npm run check:dist` checks the await, and e2e/worker.spec.js the registrations. In this
 * file every listener registers first, and #35's coordinator is built last, in a try/catch
 * (test/background-coordinator.test.js lists each listener, and which start it).
 */

// The network guard first, ahead of every other module (#21 slice 1b): it wraps the worker's
// fetch before anything else can call it, and never throws. Its handle is the worker's alone.
import { contextGuard } from './kernel/composition/network-guard-first.js';
// utils.js and storage.js put Utils and Storage on self. The worker's kernel no longer runs on
// Storage (#17 PR 1b), and nothing here opens it; #34's harness seeds profiles through it.
import './utils.js';
import './storage.js';
import {
  MIGRATE_MESSAGE,
  createWorkerClient,
  installWorkerRouter,
  migrationEvents,
  workerHost,
} from './kernel/composition/background.js';
import {
  coordinatorHandlers,
  coordinatorInstanceId,
  createCoordinator,
  journal,
  unavailableCoordinator,
} from './kernel/composition/coordinator.js';
import { createFailureEvents } from './kernel/composition/trust.js';
import { installWorkerNetwork } from './kernel/composition/worker-network.js';

/** @typedef {import('./kernel/composition/background.js').WorkerClient} WorkerClient */

/** This worker instance's id, which #13's router sends in each welcome (#35) */
const instanceId = coordinatorInstanceId();

/**
 * The background coordinator (#35, js/kernel/composition/coordinator.js), built at the end of
 * this file, after every listener, so a throw while building it leaves the menus, the commands
 * and #13's port listener in place. Until then, and for good if building it threw, this
 * stand-in answers that it can't serve. It opens nothing until an event needs storage: an
 * install or update, a browser start, a page's port session, a capture, or a page waiting on
 * the migration. The kernel it builds starts #17's migration run, which upgrades the notes
 * database after a verified recovery point, then opens the database and runs startup
 * maintenance, and a capture waits for all of it, except while an older build's open page
 * blocks the upgrade. Each run it makes goes to the journal as its own migration event (#20).
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
 * worker. Each welcome says what the coordinator can do now, a page's session starts it, and
 * system.coordinatorHealth asks it. It never throws.
 */
installWorkerRouter({
  coordinatorId: instanceId,
  status: () => coordinator.status(),
  sessions: {
    opened: () => {
      coordinator.start();
    },
  },
  handlers: coordinatorHandlers(() => coordinator),
});

/**
 * The worker's global. A module's top-level functions aren't globals, so captureToDailyNote
 * is published here for #34's harness, and the listeners call it through this name, as
 * they did in the classic worker. It runs the kernel's captureToDailyNote command.
 * @type {any}
 */
const workerGlobal = self;
workerGlobal.captureToDailyNote = captureToDailyNote;
/**
 * The latest migration attempt's outcome, for #34's harness, which seeds a profile only once
 * it's in. It starts the coordinator, whose kernel starts the run.
 */
Object.defineProperty(workerGlobal, 'storageUpgrade', { get: () => migrationDone(), configurable: true });

/**
 * The migration run of the coordinator's kernel (#17 PR 1b), after starting the coordinator:
 * its start builds the kernel before it returns, and the kernel starts the run. Null when it
 * has no kernel, since building it threw.
 * @returns {WorkerClient['migration'] | null}
 */
function migration() {
  coordinator.start();
  const client = /** @type {Partial<WorkerClient>} */ (coordinator.client());
  return client.migration || null;
}

/** @returns {WorkerClient['migration']['done'] | null} */
function migrationDone() {
  const run = migration();
  return run ? run.done : null;
}

/**
 * What a page that found no database, or an older one, hears when it waits on the migration
 * (#17, Q12): the attempt in progress, or after one that was short of space or failed, a new
 * one. Only its status goes back, never anything stored. js/kernel/composition/worker-network.js
 * runs it for this extension's own senders only (#21's isOwnSender), a page in a tab included,
 * since a new attempt can make another full recovery point, and answers any other sender
 * `{error: 'request-refused'}`.
 * @returns {Promise<{status: string}>}
 */
function migrationStatus() {
  const run = migration();
  if (!run) return Promise.resolve({ status: 'failed' });
  return run.request().then(
    outcome => ({ status: outcome.status }),
    () => ({ status: 'failed' }),
  );
}

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
  // Sightings a context held in chrome.storage.local because NewTabNoteTrust wouldn't open
  // reconcile now, not only at the next failure; with none held this reads one key and opens
  // nothing
  events.reconcile();
} catch {
  // The journal is best effort: without it the worker does exactly what it did
}
// The worker's network (#21 slice 1b): its one onMessage listener, the request proxy, and the
// guard's wiring, which journals what the guard refused into the events above. It never throws.
// It hands a page's wait on the migration (#17) to migrationStatus, from this extension's own
// senders only. Every event comes after this file has run, the coordinator's build included.
installWorkerNetwork({ guard: contextGuard, events: failureEvents, ownHandlers: { [MIGRATE_MESSAGE]: migrationStatus } });
try {
  coordinator = createCoordinator({
    instanceId,
    makeKernel: () => createWorkerClient({ ...workerHost(), report: migrationEvents(failureEvents.event) }),
    events: failureEvents,
  });
} catch (error) {
  // The stand-in stays, every capture says it couldn't open the notes, and #20 hears why
  console.error("NewTabNote: the background coordinator couldn't be built", error);
  journal(failureEvents, 'coordinator.start-failed', {}, error);
}
