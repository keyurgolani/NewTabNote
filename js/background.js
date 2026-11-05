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
 * file every listener registers first, and #35's coordinator is built last, then the worker's own
 * client its capture goes through, each in a try/catch (test/background-coordinator.test.js
 * lists each listener, and which start it).
 */

// The network guard first, ahead of every other module (#21 slice 1b): it wraps the worker's
// fetch before anything else can call it, and never throws. Its handle is the worker's alone.
import { contextGuard } from './kernel/composition/network-guard-first.js';
import {
  MIGRATE_MESSAGE,
  PURGE_MESSAGE,
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
import { DRAIN_MESSAGE, createWorkerJournal } from './kernel/composition/journal.js';
import { randomIds } from './kernel/composition/messaging.js';
import { createFailureEvents } from './kernel/composition/trust.js';
import { createWorkerInternalClient, createWorkerInternalRouter } from './kernel/composition/worker-internal.js';
import { installWorkerNetwork } from './kernel/composition/worker-network.js';

/** @typedef {import('./kernel/composition/background.js').WorkerClient} WorkerClient */

/** This worker instance's id, which #13's router sends in each welcome (#35) */
const instanceId = coordinatorInstanceId();

/**
 * The background coordinator (#35, js/kernel/composition/coordinator.js), built at the end of
 * this file, after every listener, so a throw while building it leaves the menus, the commands
 * and #13's port listener in place. Until then, and for good if building it threw, this
 * stand-in answers that it can't serve. It opens nothing until an event needs storage: an
 * install or update, a browser start, a page's hello on its port, a capture, or a page waiting on
 * the migration. The kernel it builds starts #17's migration run, which upgrades the notes
 * database after a verified recovery point, then opens the database and runs startup
 * maintenance, and a capture waits for all of it, except while an older build's open page
 * blocks the upgrade. Each run it makes goes to the journal as its own migration event (#20),
 * and so does a purge of the recovery points that stopped, and its end (#17 PR 2b).
 */
let coordinator = unavailableCoordinator(instanceId);

/**
 * The worker's journal (#35 slice 3, js/kernel/composition/journal.js), set at the end of this
 * file, before the coordinator, which drains it: a capture writes its entry there before the
 * coordinator starts, so one the notes can't take now is kept, and the drain adds it once they
 * can. Until then, and for good if building it threw, a capture runs as it did before slice 3.
 * @type {import('./kernel/composition/journal.js').WorkerJournal | null}
 */
let captureJournal = null;

/**
 * The worker's own client (#35 slice 4a, "One committer"), set at the end of this file, after the
 * coordinator: #13's client on the in-process transport, as worker-internal, to the worker's own
 * router on its catalog, which hands the capture to the coordinator's queue. Until then, and for
 * good if building it threw, a capture runs on the queue directly, as the drain's replays do.
 * @type {ReturnType<typeof createWorkerInternalClient> | null}
 */
let ownClient = null;

/**
 * The worker's failure events (#20, "Diagnostic journal"), set with the coordinator at the end
 * of this file: a failed open, a failed capture, and a stopped recovery-point purge go to the
 * diagnostic journal and raise their incidents in NewTabNoteTrust, which opens only when the
 * first one happens. Best effort: nothing here changes what the worker does or logs.
 * @type {{event(code: string, fields?: Record<string, unknown>, error?: unknown): void}}
 */
let failureEvents = { event() {} };

/**
 * #13's router, which takes each port this extension's pages open by its name. It's installed
 * here at the top level, synchronously, so Chrome finds its listener when a port wakes the
 * worker. A page's hello starts the coordinator, and while it's starting the welcome waits for
 * the start, WELCOME_WAIT_MS at most. Each welcome says what the coordinator can do then, and
 * system.coordinatorHealth asks it. It never throws.
 */
installWorkerRouter({
  coordinatorId: instanceId,
  status: () => coordinator.status(),
  settled: () => coordinator.start(),
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
 * The latest data transforms' outcome (#17 PR 3a), for #34's harness. It starts the
 * coordinator too, as storageUpgrade does, so reading it never throws before the start.
 */
Object.defineProperty(workerGlobal, 'storageTransforms', { get: () => transformsDone(), configurable: true });
/**
 * The latest recovery-point purge's outcome (#17 PR 2b), for #34's harness. It starts the
 * coordinator too, as storageUpgrade does, so reading it never throws before the start.
 */
Object.defineProperty(workerGlobal, 'storagePurge', { get: () => purgeDone(), configurable: true });

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
 * The latest data transforms' outcome of the coordinator's kernel (#17 PR 3a), after starting
 * the coordinator, as migration() reads its run. Null when it has no kernel, since building it
 * threw.
 * @returns {WorkerClient['transforms']['done'] | null}
 */
function transformsDone() {
  coordinator.start();
  const client = /** @type {Partial<WorkerClient>} */ (coordinator.client());
  return client.transforms ? client.transforms.done : null;
}

/**
 * The recovery-point purge of the coordinator's kernel (#17 PR 2b), after starting the
 * coordinator, as migration() reads its run. Null when it has no kernel, since building it
 * threw.
 * @returns {WorkerClient['purge'] | null}
 */
function purge() {
  coordinator.start();
  const client = /** @type {Partial<WorkerClient>} */ (coordinator.client());
  return client.purge || null;
}

/** @returns {WorkerClient['purge']['done'] | null} */
function purgeDone() {
  const sweep = purge();
  return sweep ? sweep.done : null;
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

/**
 * What a page of this extension that deleted something for good hears when it wakes the
 * worker with storage.purge (#17 PR 2b): the status of the sweep it asks for. The message
 * carries nothing, since the sweep goes by the tombstones the delete left, and only the status
 * goes back. js/kernel/composition/worker-network.js runs it for this extension's own senders
 * only, as it runs migrationStatus, and answers any other sender `{error: 'request-refused'}`.
 * @returns {Promise<{status: string}>}
 */
function purgeStatus() {
  const sweep = purge();
  if (!sweep) return Promise.resolve({ status: 'failed' });
  return sweep.request().then(
    outcome => ({ status: outcome ? outcome.status : 'skipped' }),
    () => ({ status: 'failed' }),
  );
}

/**
 * Why a capture can't be saved (the reasons the new tab shows), for a capture whose journal
 * entry couldn't be written: one that's kept says so instead (KEPT_CAPTURE)
 */
const CAPTURE_REFUSALS = {
  newerSchema: "Your notes were upgraded by a newer NewTabNote version. This version can't open them safely, so it won't change anything. Update NewTabNote to keep working.",
  missingCoreStores: "Your notes database is incomplete, so this version won't change anything. Open a new tab to export a copy.",
  // #17 PR 1b: the upgrade waits on an open page of an older version
  blockedUpgrade: 'NewTabNote is updating how your notes are stored, and an open NewTabNote tab or window is holding them. Close or reload it, then try again.',
};

/**
 * A capture the notes couldn't take, kept in the journal for the drain (#35 slice 3, the lead's
 * words for the plan's Q2), and one the drain then couldn't add. A kept capture says what will
 * add it when that's up to the user (the director's words for #182): an update, for a database a
 * newer build upgraded, or closing the older build's tabs and windows that hold the upgrade.
 */
const KEPT_CAPTURE = Object.freeze({
  title: "Kept for today's note",
  message: "NewTabNote couldn't save this to your notes yet. It's kept on this device and will be added when your notes open.",
  newerSchema: "Update NewTabNote to add this. A newer version upgraded your notes. It's kept on this device until then.",
  blockedUpgrade: "Close or reload your open NewTabNote tabs and windows to finish an update and add this. It's kept on this device until then.",
  missingStores: 'Open a new tab to export a copy. Your notes database is incomplete. What you added is kept on this device.',
  // #35 slice 4a: the coordinator didn't start it by its deadline, so the drain adds it once the
  // queue lets it, which may be at the worker's next start (the director's words)
  busy: "NewTabNote couldn't save this to your notes yet. It's kept on this device and will be added as soon as NewTabNote can.",
});
const UNREPLAYABLE_CAPTURE = Object.freeze({
  title: 'Not captured',
  message: "NewTabNote couldn't add a kept capture to today's note.",
});
/** A capture a newer build kept, which the drain holds for that build (the lead's Q6) */
const HELD_CAPTURE = Object.freeze({
  title: 'Kept for your notes',
  message: "Update NewTabNote to add a capture from a newer version. It's kept on this device until then.",
});

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
 * The code #13's client answers a capture with when the coordinator didn't start it by its
 * deadline (#35 slice 4a): `unavailable` when it never started, and `unknown` when it started
 * and its answer didn't come in time
 */
const DEADLINE_EXCEEDED = 'deadline-exceeded';

/**
 * What a kept capture says for the answer that kept it: what will add it, when that's up to
 * the user, that it's added as soon as it can be, when the coordinator was busy, and otherwise
 * that it's added when the notes open
 * @param {{cause?: string, code?: string}} answer
 * @returns {string}
 */
function keptMessage({ cause, code }) {
  if (cause === 'newer-schema') return KEPT_CAPTURE.newerSchema;
  if (code === 'blocked-upgrade') return KEPT_CAPTURE.blockedUpgrade;
  if (code === 'missing-core-stores') return KEPT_CAPTURE.missingStores;
  if (code === DEADLINE_EXCEEDED) return KEPT_CAPTURE.busy;
  return KEPT_CAPTURE.message;
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

  // The menus first, then storage: the run's pending steps, first-run settings, and after an
  // install or an update the read-only integrity check, once the transforms and the catch-up
  // are in (#35 slices 1 and 2)
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
 * kernel's captureToDailyNote command. Its journal entry is written first, before the
 * coordinator starts (#35 slice 3), and goes once the capture is answered for good: saved, or
 * refused for what it holds. The command goes through the worker's own client to the
 * coordinator's queue (#35 slice 4a), so it waits its turn behind what the pages sent. A capture
 * the notes can't take now (they won't open, an older build's page holds their upgrade, a write
 * failed, or its turn didn't come by its deadline) is kept, says so and what will add it
 * (keptMessage), and the coordinator's drain adds it to the Daily Note of the day it was made
 * once they can: one whose deadline passed asks for that drain at once, which waits its turn on
 * the same queue. Without an entry, as when the journal can't be written, it ends as it did
 * before slice 3: saved, refused (the database can't be opened safely), or failed, each with a
 * notification; one whose turn didn't come by its deadline waits its turn on the queue, as 1.5.0's
 * capture waited, since nothing could replay it. A refused or failed one, kept or not, is also a
 * `capture.failed` event, which holds the outcome's cause and code and never what was captured.
 * @param {{type: 'bookmark', url?: string, title?: string} | {type: 'text', content: string, source?: string}} item
 * @returns {Promise<void>}
 */
async function captureToDailyNote(item) {
  /** @type {import('./kernel/core/contracts/commands.js').CommandOf<'captureToDailyNote'>} */
  const command = {
    type: 'captureToDailyNote',
    commandId: randomIds.next(),
    // The Daily Note's id if this capture makes it, and the captured block's
    noteId: randomIds.next(),
    blockId: randomIds.next(),
    capture: item.type === 'bookmark'
      ? { type: 'bookmark', url: item.url, title: item.title }
      : { type: 'text', content: item.content, source: item.source },
    // The instant it was made, whose day it lands in, however late the drain adds it
    at: Date.now(),
  };
  const kept = captureJournal ? await captureJournal.keep(command, { noteId: command.noteId }) : false;
  /**
   * The notes can't take it now, for `answer`: kept for the drain, saying what will add it, or
   * today's words without an entry
   * @param {string} words
   * @param {{cause?: string, code?: string}} answer
   */
  const notTaken = (words, answer) => {
    if (kept) {
      captureJournal.release(command.commandId);
      notifyCapture(KEPT_CAPTURE.title, keptMessage(answer));
    } else {
      notifyCapture('Not captured', words);
    }
  };
  try {
    await coordinator.start();
    const kernel = coordinator.client();
    const failure = await kernel.whenReady();
    if (failure) {
      const refusal = captureRefusal(failure);
      // Its cause and code: a refusal warns, as 1.4.x did at open, and any other failure is an error
      (refusal ? console.warn : console.error)('Storage not opened in background:', failure);
      notTaken(refusal || "NewTabNote couldn't open your notes, so nothing was saved.", failure);
      failureEvents.event('capture.failed', {}, failure);
      return;
    }
    // Through the worker's own client, or on the queue directly when it couldn't be built
    let outcome = ownClient ? await ownClient.execute(command) : await kernel.execute(command);
    // An entry that wasn't written has nothing to replay it, so a deadline answer waits its turn on the
    // queue, as 1.5.0's capture waited; #17's ledger answers one that had started
    if (!kept && outcome.code === DEADLINE_EXCEEDED) outcome = await kernel.execute(command);
    if (outcome.kind !== 'committed') {
      const refusal = captureRefusal(outcome);
      // An outcome holds its kind, cause, and code, and never what was captured
      (refusal ? console.warn : console.error)('Failed to capture to daily note:', outcome);
      const reason = CAPTURE_FAILURES[outcome.messageKey] || CAPTURE_FAILED;
      const words = refusal || `Saving to today's note failed: ${reason}`;
      // Unavailable or unanswered, it may land later; refused for what it holds, it never will
      if (outcome.kind === 'unavailable' || outcome.kind === 'unknown') {
        notTaken(words, outcome);
        // The notes are open and the queue was busy: the drain adds it once its turn comes,
        // in the background, and never rejects
        if (kept && outcome.code === DEADLINE_EXCEEDED) coordinator.drain();
      } else {
        if (kept) await captureJournal.settle(command.commandId);
        notifyCapture('Not captured', words);
      }
      failureEvents.event('capture.failed', { commandId: command.commandId }, outcome);
      return;
    }
    if (kept) await captureJournal.settle(command.commandId);
    notifyCapture('Captured to New Tab Note', item.type === 'bookmark' ? `Saved link: ${item.title}` : 'Saved selected text');
    // A capture that committed resolves an earlier capture failure (#20); it opens NewTabNoteTrust
    // only while one may be open
    failureEvents.event('capture.committed', { commandId: command.commandId });
  } catch (error) {
    console.error('Failed to capture to daily note:', error);
    notTaken(`Saving to today's note failed: ${error && error.message ? error.message : 'unknown error'}`, {});
    failureEvents.event('capture.failed', {}, error);
  }
}

/**
 * What a page of this extension that found a journal entry no live context holds hears when it
 * wakes the worker with journal.drain (#35 slice 3, the lead's answer to the plan's Q4): what
 * the drain it asks for did, by status and count. The message carries nothing, since the drain
 * goes by what the journal holds. js/kernel/composition/worker-network.js runs it for this
 * extension's own senders only, as it runs purgeStatus, and answers any other sender
 * `{error: 'request-refused'}`.
 * @returns {Promise<{status: string, replayed: number}>}
 */
function drainStatus() {
  return coordinator.drain().then(
    (result) => {
      const drained = /** @type {{status?: unknown, replayed?: unknown} | null} */ (result && typeof result === 'object' ? result : null);
      return drained && typeof drained.status === 'string' && typeof drained.replayed === 'number'
        ? { status: drained.status, replayed: drained.replayed }
        : { status: 'skipped', replayed: 0 };
    },
    () => ({ status: 'failed', replayed: 0 }),
  );
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
// It hands a page's wait on the migration (#17) to migrationStatus, a page's storage.purge
// after a delete for good (#17 PR 2b) to purgeStatus, and a page's journal.drain (#35 slice 3)
// to drainStatus, from this extension's own senders only. Every event comes after this file
// has run, the coordinator's build included.
installWorkerNetwork({ guard: contextGuard, events: failureEvents, ownHandlers: { [MIGRATE_MESSAGE]: migrationStatus, [PURGE_MESSAGE]: purgeStatus, [DRAIN_MESSAGE]: drainStatus } });
try {
  // Building it opens nothing: the first capture opens NewTabNoteJournal, and the first drain
  // reads it only when it's there
  captureJournal = createWorkerJournal({
    instanceId,
    events: failureEvents,
    // A capture a newer build wrote waits for it; one no build can read is kept as a conflict record
    notify: (entry, code) => {
      const words = code === 'unsupported-version' ? HELD_CAPTURE : UNREPLAYABLE_CAPTURE;
      notifyCapture(words.title, words.message);
    },
  });
} catch (error) {
  // Captures run as they did before slice 3, unjournaled
  console.error("NewTabNote: the worker's journal couldn't be built", error);
}
try {
  coordinator = createCoordinator({
    instanceId,
    makeKernel: () => createWorkerClient({ ...workerHost(), report: migrationEvents(failureEvents.event), events: failureEvents }),
    events: failureEvents,
    journal: captureJournal,
  });
} catch (error) {
  // The stand-in stays, every capture is kept for a later start's drain and says so, and #20
  // hears why
  console.error("NewTabNote: the background coordinator couldn't be built", error);
  journal(failureEvents, 'coordinator.start-failed', {}, error);
}
try {
  // The worker's own client and router (#35 slice 4a), which the capture goes through to the
  // coordinator's queue. Building them opens nothing: the client says hello on its first capture,
  // and its welcome waits for the start, as a page's does.
  const router = createWorkerInternalRouter({
    coordinatorId: instanceId,
    status: () => coordinator.status(),
    settled: () => coordinator.start(),
    enqueue: (command, dispatch) => coordinator.enqueue(command, dispatch),
  });
  ownClient = createWorkerInternalClient({ router });
} catch (error) {
  // A capture runs on the queue directly, as the drain's replays do
  console.error("NewTabNote: the worker's own client couldn't be built", error);
}
