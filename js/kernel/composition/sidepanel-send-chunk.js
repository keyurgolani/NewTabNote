/**
 * Side Panel's send chunk (#35 slice 4c): what Side Panel's root loads at its first command, so a
 * start with nothing to apply loads none of it (Q1). It holds #13's client on the runtime port,
 * for the one command Side Panel sends the worker: applyCloseDraft, which its start's apply of a
 * closing tab's edit and its journal's apply of the editor saves closed pages left both send with
 * no entry. It sends nothing else, and no command it sends is journaled, so it starts no journal
 * of its own.
 *
 * The client keeps #13's message caps. A command whose message is over its operation's maxBytes is
 * refused as payload-too-large before it goes. So a close-time draft over 1 MiB stays where it is,
 * for the new tab's next start, which applies it in-process (rule 6).
 *
 * Loading it touches no browser API: the client opens its port at its first send.
 */

import { createRuntimePortTransport } from '../adapters/messaging/runtime-port.js';
import { COMMANDS } from '../core/contracts/commands.js';
import * as applyCloseDraft from '../core/contracts/operations/apply-close-draft.js';
import { createClient } from '../core/messaging/client.js';
import { createLookup, operationOf } from '../core/messaging/operations.js';
import { systemClock } from '../core/ports/runtime.js';
import { hostTimers, randomIds } from './messaging.js';

/** @typedef {import('../adapters/messaging/runtime-port.js').Runtime} Runtime */
/** @typedef {import('../core/messaging/client.js').Client} MessagingClient */
/** @typedef {import('../core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */

/** The one command Side Panel sends the worker, on the shared catalog's entry */
export const SIDEPANEL_SENDS = createLookup({
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
 * Side Panel's client to the worker's router, as `sidepanel`, which opens its port at its first
 * send
 * @param {{runtime: Runtime, extensionVersion: string, ledger?: IdempotencyLedger}} options -
 *   `ledger`: the reader's, by which a command whose reply was lost resolves
 * @returns {MessagingClient}
 */
export function sidePanelSender({ runtime, extensionVersion, ledger }) {
  return createClient({
    transport: createRuntimePortTransport({ runtime }),
    surface: 'sidepanel',
    extensionVersion,
    lookup: SIDEPANEL_SENDS,
    ids: randomIds,
    clock: systemClock,
    timers: hostTimers,
    logger: messagingLogger,
    ...(ledger ? { ledger } : {}),
  });
}
