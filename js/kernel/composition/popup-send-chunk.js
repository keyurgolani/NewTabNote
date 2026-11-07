/**
 * Popup's send chunk (#35 slice 4b-2): what Popup's root loads at its start, in place of the
 * journal's chunk, so its quick note's first Enter doesn't wait for it (Q9). It holds:
 * - #13's client on the runtime port, for the two commands Popup sends the worker: the quick
 *   note's createNote, and applyCloseDraft, which the apply of a closing tab's edit sends with no
 *   entry. It sends nothing else.
 * - The journal's chunk (journal-chunk.js), whose journaling writes a journaled command's entry
 *   before the command goes, started on the client's session (popupWrites).
 * The client keeps #13's message caps. A command whose message is over its operation's maxBytes is
 * refused as payload-too-large before it goes. So a close-time draft over 1 MiB stays where it is,
 * for the next start of a page that applies it in-process (rule 10).
 *
 * Loading it touches no browser API: the client opens its port at its first send, and the journal
 * opens its database only when it's there or its first entry needs it.
 */

import { inContextStores } from '../adapters/in-context.js';
import { createRuntimePortTransport } from '../adapters/messaging/runtime-port.js';
import { COMMANDS } from '../core/contracts/commands.js';
import * as applyCloseDraft from '../core/contracts/operations/apply-close-draft.js';
import * as createNote from '../core/contracts/operations/create-note.js';
import { createClient } from '../core/messaging/client.js';
import { createLookup, operationOf } from '../core/messaging/operations.js';
import { systemClock } from '../core/ports/runtime.js';
import { startPageJournal } from './journal-chunk.js';
import { hostTimers, randomIds } from './messaging.js';

/** @typedef {import('../adapters/messaging/runtime-port.js').Runtime} Runtime */
/** @typedef {import('../core/messaging/client.js').Client} MessagingClient */
/** @typedef {import('../core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../core/application/journaling.js').JournalingLocks} JournalingLocks */
/** @typedef {import('../core/application/journaling.js').JournalingOptions} JournalingOptions */
/** @typedef {import('../core/application/close-drafts.js').DraftStorage} DraftStorage */
/** @typedef {import('../core/contracts/commands.js').Command} Command */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('./host.js').Client} PageClient */
/** @typedef {typeof import('./page-reads.js').failingFast} FailingFast */

/**
 * The chrome.runtime Popup's writes take: its port, and the message that wakes the worker's drain
 * @typedef {Runtime & {sendMessage?: (message: unknown) => Promise<unknown>}} PopupRuntime
 */

/** The commands Popup sends the worker, on the shared catalog's entries */
export const POPUP_SENDS = createLookup({
  createNote: operationOf(COMMANDS.createNote, createNote),
  applyCloseDraft: operationOf(COMMANDS.applyCloseDraft, applyCloseDraft),
});

/**
 * What the client warns of, with an operation's name and an error at most, never a payload
 * @type {import('../core/ports/runtime.js').Logger}
 */
const messagingLogger = Object.freeze({
  warn: (event, detail) => console.warn(`NewTabNote messaging: ${event}`, detail),
  error: (event, detail) => console.error(`NewTabNote messaging: ${event}`, detail),
});

/**
 * Popup's client to the worker's router, as `popup`, which opens its port at its first send
 * @param {{runtime: Runtime, extensionVersion: string, ledger?: IdempotencyLedger}} options -
 *   `ledger`: the reader's, by which a command whose reply was lost resolves
 * @returns {MessagingClient}
 */
export function popupSender({ runtime, extensionVersion, ledger }) {
  return createClient({
    transport: createRuntimePortTransport({ runtime }),
    surface: 'popup',
    extensionVersion,
    lookup: POPUP_SENDS,
    ids: randomIds,
    clock: systemClock,
    timers: hostTimers,
    logger: messagingLogger,
    ...(ledger ? { ledger } : {}),
  });
}

/**
 * Popup's writes (rules 3 and 7): its client, and the page's journal on the client's session, so
 * the owner lock the journal holds and each entry it writes name the session the worker's router
 * knows the page by, which the worker's drain waits on once the page's port closes. `ready`
 * resolves once the journal holds that lock, or can't, since until then it sends a journaled
 * command unjournaled. `execute` gives a journaled command its entry and then sends it, and sends
 * any other, applyCloseDraft among them, as it is.
 * @param {{
 *   reads: PageClient,
 *   runtime: PopupRuntime,
 *   extensionVersion: string,
 *   indexedDB: IDBFactory,
 *   ledger?: IdempotencyLedger,
 *   locks: JournalingLocks | null,
 *   storage?: DraftStorage,
 *   failingFast: FailingFast,
 * }} options - `reads`: Popup's kernel, in whose shape the journal's apply of the editor saves
 *   closed pages left sends through the client. `ledger`: the reader's. `failingFast`: the roots'
 *   run that stops sending once the worker didn't take one of its commands (page-reads.js), which
 *   that apply sends through, as a run of its own (#246). The root hands it in, so this chunk
 *   imports nothing more of the start's.
 */
export function popupWrites({ reads, runtime, extensionVersion, indexedDB, ledger, locks, storage, failingFast }) {
  const client = popupSender({ runtime, extensionVersion, ledger });
  // The journal's apply sends applyCloseDraft alone, which answers an Outcome
  const run = failingFast(/** @type {(command: Command) => Promise<Outcome>} */ (client.execute));
  const sender = /** @type {PageClient} */ (/** @type {unknown} */ (Object.freeze({ ...reads, execute: run })));
  const journal = startPageJournal(sender, client.sessionId, 'popup', {
    stores: inContextStores({ indexedDB }),
    locks,
    storage,
    runtime,
  });
  return Object.freeze({
    client,
    ready: journal.ready,
    /** @type {(command: Command, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>} */
    execute: (command, options) => journal.execute(command, client.execute, options),
  });
}
