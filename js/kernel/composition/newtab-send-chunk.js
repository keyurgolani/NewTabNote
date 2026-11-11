/**
 * The new tab's send chunk (#35 slice 4d's page move): what the new tab's root loads at idle once
 * its first read is in, 2 seconds at most, or at its first command, whichever comes first (Q6 a),
 * when 3b's journal chunk loaded before. It holds:
 * - NEWTAB_SENDS: for each command the new tab sends the worker, the shared catalog's entry and
 *   its result schema, and no payload schema (S4). #13's client reads only an operation's entry
 *   and result, and the worker's router checks every payload as it arrives, so no payload schema
 *   object is made in the page. test/kernel/handlers.test.mjs holds the lookup to the worker's,
 *   type by type.
 * - #13's client on the runtime port, as `newtab`, with the reader's ledger, so a command whose
 *   reply was lost resolves by its key before the page hears anything.
 * - The journal's chunk (journal-chunk.js), started on the client's session, with the tab's
 *   failure events, so the owner lock the journal holds and each entry it writes name the session
 *   the worker's router knows the page by.
 * - The closing save a page's close-time draft holds (#33), which it keeps in the page, so the
 *   draft carries the edit to the next start (newTabWrites).
 *
 * The client keeps #13's message caps: a command over its operation's maxBytes, as the port sends
 * it, is refused as payload-too-large before it goes (#259).
 *
 * Loading it touches no browser API: the client opens its port at its first send, and the journal
 * opens its database only when it's there or its first entry needs it.
 */

import * as v from '../../lib/valibot/index.mjs';
import { TRUST_QUERIES } from '../../trust/core/contracts.js';
import { statusFrom } from '../../trust/core/status-message.js';
import { inContextStores } from '../adapters/in-context.js';
import { createRuntimePortTransport } from '../adapters/messaging/runtime-port.js';
import { COMMANDS } from '../core/contracts/commands.js';
import { bulkResultSchema, outcomeSchema, queryStateSchema } from '../core/contracts/outcome-schemas.js';
import { unavailable } from '../core/contracts/outcomes.js';
import { DRAFT_PREFIX } from '../core/domain/close-draft-keys.js';
import { createClient } from '../core/messaging/client.js';
import { createLookup } from '../core/messaging/operations.js';
import { systemClock } from '../core/ports/runtime.js';
import { startPageJournal } from './journal-chunk.js';
import { hostTimers, randomIds } from './messaging.js';

/** @typedef {import('../adapters/messaging/runtime-port.js').Runtime} Runtime */
/** @typedef {import('../core/messaging/client.js').Client} MessagingClient */
/** @typedef {import('../core/contracts/validate.js').Operation} Operation */
/** @typedef {import('../core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../core/application/journaling.js').JournalingLocks} JournalingLocks */
/** @typedef {import('../core/application/journaling.js').JournalingOptions} JournalingOptions */
/** @typedef {import('../core/application/close-drafts.js').DraftStorage} DraftStorage */
/** @typedef {import('../core/contracts/commands.js').Command} Command */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('./host.js').Client} PageClient */
/** @typedef {import('./host.js').PageEvents} PageEvents */
/** @typedef {typeof import('./page-reads.js').failingFast} FailingFast */

/**
 * The chrome.runtime the new tab's writes take: its port, and the message that wakes the worker's
 * drain
 * @typedef {Runtime & {sendMessage?: (message: unknown) => Promise<unknown>}} NewTabRuntime
 */

/**
 * The commands the page keeps: its session's write, which commits in the page (rule 2), and the
 * worker's own startup maintenance, which leaves the page for the worker's start (rule 8)
 */
const KEPT = Object.freeze(['saveWorkspaceSession', 'runStartupMaintenance']);

/**
 * Each command the new tab sends the worker: every one the shared catalog allows on the new tab
 * but the two it keeps, with its entry and the result schema its answer has, and no payload schema
 * @type {Readonly<Record<string, Operation>>}
 */
const SENT = Object.freeze(
  Object.fromEntries(
    Object.entries(COMMANDS)
      .filter(([type, entry]) => entry.surfaces.includes('newtab') && !KEPT.includes(type))
      .map(([type, entry]) => [
        type,
        /** @type {Operation} */ (
          /** @type {unknown} */ (
            Object.freeze({ entry, payload: undefined, result: entry.bulk ? bulkResultSchema : outcomeSchema })
          )
        ),
      ]),
  ),
);

/**
 * The status lines' trust.status, which the new tab asks the worker over the port (#280's probe):
 * its entry, and its answer checked by statusFrom, as the lines check the worker message's answer,
 * with no payload schema
 * @type {Readonly<Record<string, Operation>>}
 */
const STATUS_SENT = Object.freeze({
  'trust.status': /** @type {Operation} */ (
    /** @type {unknown} */ (
      Object.freeze({
        entry: TRUST_QUERIES['trust.status'],
        payload: undefined,
        result: queryStateSchema(v.custom(value => statusFrom(value) !== null)),
      })
    )
  ),
});

/** The commands the new tab sends the worker, on the shared catalog's entries, and trust.status */
export const NEWTAB_SENDS = createLookup({ ...SENT, ...STATUS_SENT });

/**
 * What a closing save its page's close-time draft holds is answered, unsent (newTabWrites): nothing
 * went, as a send that can't go is answered, and it isn't retryable, since its page is going
 * @returns {Outcome}
 */
const keptInDraft = () => unavailable('coordinator', 'reload-required', false);

/**
 * What the client warns of, with an operation's name and an error at most, never a payload
 * @type {import('../core/ports/runtime.js').Logger}
 */
const messagingLogger = Object.freeze({
  warn: (event, detail) => console.warn(`NewTabNote messaging: ${event}`, detail),
  error: (event, detail) => console.error(`NewTabNote messaging: ${event}`, detail),
});

/**
 * The new tab's client to the worker's router, as `newtab`, which opens its port at its first send
 * @param {{runtime: Runtime, extensionVersion: string, ledger?: IdempotencyLedger}} options -
 *   `ledger`: the reader's, by which a command whose reply was lost resolves
 * @returns {MessagingClient}
 */
export function newTabSender({ runtime, extensionVersion, ledger }) {
  return createClient({
    transport: createRuntimePortTransport({ runtime }),
    surface: 'newtab',
    extensionVersion,
    lookup: NEWTAB_SENDS,
    ids: randomIds,
    clock: systemClock,
    timers: hostTimers,
    logger: messagingLogger,
    ...(ledger ? { ledger } : {}),
  });
}

/**
 * The new tab's writes (rule 3): its client, and the page's journal on the client's session, so the
 * worker's drain on a closed port waits on this page's owner lock. `ready` resolves once the journal
 * holds that lock, or can't, since until then it sends a journaled command unjournaled. `execute`
 * gives a journaled command its entry and then sends it, and sends any other as it is, but a closing
 * save its page's close-time draft holds, which it keeps in the page (heldByDraft). The journal's
 * apply of the editor saves closed pages left sends through `failingFast`, as a run of its own, so a
 * worker that doesn't answer holds the drafts' lock one wait for it (#246). Each reply, the apply's
 * too, goes to `published` before its sender hears it, so the page's feed hears of what it committed
 * (rule 5).
 * @param {{
 *   reads: PageClient,
 *   runtime: NewTabRuntime,
 *   extensionVersion: string,
 *   indexedDB: IDBFactory,
 *   ledger?: IdempotencyLedger,
 *   locks: JournalingLocks | null,
 *   storage?: DraftStorage,
 *   events?: PageEvents,
 *   failingFast: FailingFast,
 *   published: (command: Command, outcome: Outcome | BulkOutcome) => void,
 * }} options - `reads`: the new tab's kernel, in whose shape the journal's apply sends through the
 *   client. `events`: the tab's failure events, which hear of an entry the journal couldn't take.
 *   `failingFast`: the roots' run (page-reads.js), and `published`, the root's feed of each reply,
 *   which the root hands in, so this chunk imports nothing more of the start's.
 */
export function newTabWrites({
  reads,
  runtime,
  extensionVersion,
  indexedDB,
  ledger,
  locks,
  storage,
  events,
  failingFast,
  published,
}) {
  const client = newTabSender({ runtime, extensionVersion, ledger });
  /** @type {(command: Command) => Promise<Outcome | BulkOutcome>} */
  const send = command =>
    /** @type {Promise<Outcome | BulkOutcome>} */ (client.execute(command)).then(outcome => {
      published(command, outcome);
      return outcome;
    });
  // The journal's apply sends applyCloseDraft alone, which answers an Outcome
  const run = failingFast(/** @type {(command: Command) => Promise<Outcome>} */ (send));
  const sender = /** @type {PageClient} */ (/** @type {unknown} */ (Object.freeze({ ...reads, execute: run })));
  const journal = startPageJournal(sender, client.sessionId, 'newtab', {
    stores: inContextStores({ indexedDB }),
    locks,
    storage,
    runtime,
    events,
  });
  /**
   * Whether `command` is a closing save its page's close-time draft holds (#33): a save its editor
   * covered, under the id of the draft it wrote for the same edit at the page's own close
   * (js/editor.js, _writeCloseDraft), which the page's localStorage holds under that id. The worker
   * outlives the page, so sent, the save would commit after the page went, and the next start would
   * drop the draft for that commit (application/close-drafts.js, applyCloseDraft), whatever another
   * tab did to the note since. Kept in the page, it goes with the page, as it did on the page's own
   * connection, whose transaction Chrome aborts with the page (application/notes.js,
   * saveNoteContent), and the draft carries the edit to the next start, which applies it by #33's
   * rules.
   * @param {Command} command
   * @param {JournalingOptions} [options]
   * @returns {boolean}
   */
  const heldByDraft = (command, options) => {
    if (!options || options.covered !== true || command.type !== 'saveNoteContent' || !storage) return false;
    try {
      return storage.getItem(`${DRAFT_PREFIX}${command.commandId}`) !== null;
    } catch {
      // A page that can't read its localStorage wrote no draft there
      return false;
    }
  };
  return Object.freeze({
    client,
    ready: journal.ready,
    applied: journal.applied,
    /** @type {(command: Command, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>} */
    execute: (command, options) =>
      heldByDraft(command, options) ? Promise.resolve(keptInDraft()) : journal.execute(command, send, options),
  });
}
