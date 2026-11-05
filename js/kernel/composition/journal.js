/**
 * The service worker's journal (#35 slice 3): its own entries in `NewTabNoteJournal`, written
 * through InContextStores (adapters/in-context.js), and the coordinator's drain of every
 * context's (core/application/journal-drain.js).
 *
 * - keep(): js/background.js writes a capture's entry before it starts the coordinator and
 *   sends the capture, so a capture the kernel can't take now is kept, under the coordinator's
 *   instance id, and replays at the next drain. The first entry takes Web Lock
 *   `journal.owner.<instanceId>`, held for as long as the worker lives, so no other drain takes
 *   its entries for orphans. An entry stays in flight, which this worker's own drain leaves
 *   alone, until settle() removes it on an answer that ends it, or release() leaves it for the
 *   drain.
 * - drain(): the coordinator runs it once it's ready, and again when a page wakes the worker
 *   (DRAIN_MESSAGE), under Web Lock `journal.replay`. One asked for while one runs runs once
 *   more after it, as the recovery-point purge does, so an entry written meanwhile is read too.
 *   A profile with no journal database opens nothing and makes none. What its last drain left,
 *   the oldest orphaned entry and the notes it held back (held(), slice 3b), it keeps for
 *   system.coordinatorHealth.
 * - What the drain can't replay is `journal.entry-unreplayable` (#20, the lead's answer to the
 *   plan's Q8), on the coordinator's provider, and a capture among them is told to `notify`, with
 *   why. A stop for good at a capture raises the incident and tells it nothing, since it's still
 *   kept (the lead's call on #182). What its drains raised, and the stops they counted, the
 *   worker keeps for its life, so a mark the journal can't write doesn't raise it again, and the
 *   third drain in a row that stops at an entry raises it all the same (slice 3b). A capture it
 *   adds is `capture.committed`, as one the worker adds at once is, so it resolves the capture
 *   incident its failure raised.
 *
 * Building it opens nothing, and nothing here throws into the worker: a journal that can't be
 * written leaves the capture to run as it did before slice 3, and says so on the console and as
 * `journal.append-failed`, by the capture's note and the failure's code only, which raises no
 * incident (#35 slice 4a).
 */

import { inContextStores } from '../adapters/in-context.js';
import { drainJournal } from '../core/application/journal-drain.js';
import { SURFACES } from '../core/contracts/surfaces.js';
import { WORKER_COMMANDS } from '../core/contracts/worker-catalog.js';
import { DRAIN_MESSAGE, OWNER_LOCK_PREFIX, REPLAY_LOCK, journalEntry, ownerLock } from '../core/domain/journal.js';
import { journaledLookup } from '../core/messaging/journaled-operations.js';
import { systemClock } from '../core/ports/runtime.js';

/** @typedef {import('../adapters/in-context.js').InContextStores} InContextStores */
/** @typedef {import('../core/application/journal-drain.js').DrainClient} DrainClient */
/** @typedef {import('../core/application/journal-drain.js').DrainResult} DrainResult */
/** @typedef {import('../core/domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../core/contracts/commands.js').CommandType} CommandType */

export { DRAIN_MESSAGE };

/**
 * The Web Locks the journal holds: `request` for the owner and replay locks, and `query` for
 * the owners alive now, without which no other context's entry is replayed
 * @typedef {object} JournalLocks
 * @property {<T>(name: string, options: {mode: 'exclusive'}, callback: () => Promise<T>) => Promise<T>} request
 * @property {() => Promise<{held?: Array<{name?: string}>}>} [query]
 */

/**
 * @typedef {object} WorkerJournal
 * @property {(command: {type: CommandType, commandId: string} & Record<string, unknown>, fields: {noteId: string}) => Promise<boolean>} keep
 *   Writes `command`'s entry, in flight, and answers whether it's written. Never rejects.
 * @property {(opId: string) => Promise<void>} settle - its command answered for good, so the entry goes. Never rejects.
 * @property {(opId: string) => void} release - its command didn't commit, so the entry stays for the drain
 * @property {(client: DrainClient) => Promise<DrainResult | null>} drain - never rejects; null with no journal to read
 * @property {() => number | null} oldestOrphanedEntryAt - what the last drain left, for system.coordinatorHealth
 * @property {() => DrainResult['held']} held - the notes the last drain held back, for system.coordinatorHealth (slice 3b)
 */

/**
 * The captures among the entries the drain replays, by type: one it couldn't add is told to
 * `notify`, and one it added is `capture.committed`
 * @type {Readonly<Record<string, true>>}
 */
const CAPTURES = Object.freeze({ captureToDailyNote: true });

/**
 * Whether `entry` holds a capture
 * @param {JournalRecord} entry
 */
const isCapture = entry => {
  const type = entry && entry.command && typeof entry.command === 'object' ? entry.command.type : undefined;
  return typeof type === 'string' && Object.hasOwn(CAPTURES, type);
};

/**
 * Warns of what the journal couldn't do, with the failure's code at most
 * @param {string} event
 * @param {unknown} error
 */
const warnOf = (event, error) => {
  const code =
    error && typeof error === 'object' && 'code' in error ? /** @type {{code: unknown}} */ (error).code : null;
  console.warn(`NewTabNote journal: ${event}`, { code });
};

/**
 * Two drains in a row as one answer: the later one's status and code, and both's counts
 * @param {DrainResult} first
 * @param {DrainResult} then
 * @returns {DrainResult}
 */
function combined(first, then) {
  return {
    ...then,
    status: then.status === 'empty' && first.status !== 'empty' ? first.status : then.status,
    replayed: first.replayed + then.replayed,
    swept: first.swept + then.swept,
    kept: first.kept + then.kept,
  };
}

/**
 * @param {{
 *   instanceId: string,
 *   stores?: InContextStores,
 *   locks?: JournalLocks | null,
 *   clock?: {now(): number},
 *   events?: {event(code: string, fields?: Record<string, unknown>, failure?: unknown): void} | null,
 *   notify?: ((entry: JournalRecord, code: string) => void) | null,
 *   warn?: (event: string, error: unknown) => void,
 * }} options - `locks` is navigator.locks, read when first needed, unless a test passes one
 * @returns {WorkerJournal}
 */
export function createWorkerJournal({
  instanceId,
  stores = inContextStores(),
  locks,
  clock = systemClock,
  events = null,
  notify = null,
  warn = warnOf,
}) {
  /** @returns {JournalLocks | null} */
  const lockManager = () =>
    locks !== undefined
      ? locks
      : /** @type {JournalLocks | null} */ (/** @type {unknown} */ (globalThis.navigator?.locks ?? null));
  /** The opIds of this worker's entries whose command is in flight */
  /** @type {Set<string>} */
  const inFlight = new Set();
  let seq = 0;
  /** @type {Promise<boolean> | null} */
  let owner = null;
  /** @type {number | null} */
  let oldest = null;
  /** @type {DrainResult['held']} what the last drain held back */
  let lastHeld = [];
  /** What this worker's drains raised, by entry and code, for its life (journal-drain.js) */
  /** @type {Set<string>} */
  const raised = new Set();
  /** How many drains in a row stopped at each entry on a code they can retry, for its life */
  /** @type {Map<string, number>} */
  const stops = new Map();

  /**
   * Takes this instance's owner lock once, and holds it for as long as the worker lives.
   * Resolves once it's held, or false when it can't be: the entries are written all the same.
   * @returns {Promise<boolean>}
   */
  const owned = () => {
    if (!owner) {
      owner = new Promise(resolve => {
        const manager = lockManager();
        try {
          if (!manager) {
            resolve(false);
            return;
          }
          manager
            .request(ownerLock(instanceId), { mode: 'exclusive' }, () => {
              resolve(true);
              return new Promise(() => {});
            })
            .catch(() => resolve(false));
        } catch {
          resolve(false);
        }
      });
    }
    return owner;
  };

  /** The journal, open */
  const opened = async () => {
    const journal = stores.journal();
    await journal.open();
    return journal;
  };

  /**
   * The sessions whose owner lock is held now, or null when the lock manager can't say
   * @returns {Promise<ReadonlySet<string> | null>}
   */
  const liveOwners = async () => {
    const manager = lockManager();
    if (!manager || typeof manager.query !== 'function') return null;
    const { held = [] } = (await manager.query()) || {};
    /** @type {Set<string>} */
    const live = new Set();
    for (const lock of held) {
      const name = lock && typeof lock.name === 'string' ? lock.name : '';
      if (name.startsWith(OWNER_LOCK_PREFIX)) live.add(name.slice(OWNER_LOCK_PREFIX.length));
    }
    return live;
  };

  /**
   * An entry the drain can't replay as written, to the journal and, for a capture, to `notify`,
   * but for a stop at an entry that's still kept
   * @param {JournalRecord} entry
   * @param {string} code
   * @param {{stop?: boolean}} [how]
   */
  const unreplayable = (entry, code, how = {}) => {
    const surface = entry && SURFACES.includes(entry.surface) ? { surface: entry.surface } : {};
    try {
      if (events) events.event('journal.entry-unreplayable', surface, { code });
    } catch {
      // Best effort: a journal that can't be written changes nothing the drain does
    }
    if (notify && !how.stop && isCapture(entry)) notify(entry, code);
  };

  /**
   * An entry the drain replayed: a capture resolves the capture incident a failed one raised
   * @param {JournalRecord} entry
   */
  const replayed = entry => {
    try {
      if (events && isCapture(entry)) events.event('capture.committed', {});
    } catch {
      // Best effort, as unreplayable's event is
    }
  };

  /**
   * One drain on `client`, under the replay lock
   * @param {DrainClient} client
   * @returns {Promise<DrainResult | null>}
   */
  const once = async client => {
    if (!(await stores.journalExists())) {
      oldest = null;
      lastHeld = [];
      return null;
    }
    const run = async () => {
      const journal = await opened();
      return drainJournal({
        journal,
        client,
        lookup: journaledLookup,
        liveOwners,
        own: { sessionId: instanceId, inFlight: () => new Set(inFlight) },
        clock,
        unreplayable,
        raised,
        stops,
        replayed,
      });
    };
    const manager = lockManager();
    const result = manager ? await manager.request(REPLAY_LOCK, { mode: 'exclusive' }, run) : await run();
    oldest = result.oldestOrphanedEntryAt;
    lastHeld = result.held;
    return result;
  };

  /** @type {Promise<DrainResult | null> | null} */
  let draining = null;
  let again = false;

  return Object.freeze({
    async keep(command, { noteId }) {
      // In flight before it's written, so no drain of this worker's takes it meanwhile
      inFlight.add(command.commandId);
      try {
        await owned();
        const journal = await opened();
        const { version } = WORKER_COMMANDS[command.type];
        seq += 1;
        await journal.put(
          journalEntry({
            command,
            v: version,
            noteId,
            surface: 'worker-internal',
            ownerSessionId: instanceId,
            seq,
            createdAt: clock.now(),
          }),
        );
        return true;
      } catch (error) {
        inFlight.delete(command.commandId);
        warn('entry-not-written', error);
        try {
          // By the entry's note and the failure's code only (#35 slice 4a)
          if (events) events.event('journal.append-failed', { subjectId: noteId }, error);
        } catch {
          // Best effort, as unreplayable's event is
        }
        return false;
      }
    },
    async settle(opId) {
      try {
        await (await opened()).remove([opId]);
      } catch (error) {
        // It stays, and the next drain finds its command in, by its key
        warn('entry-not-removed', error);
      } finally {
        inFlight.delete(opId);
      }
    },
    release(opId) {
      inFlight.delete(opId);
    },
    drain(client) {
      if (draining) {
        again = true;
        return draining;
      }
      const running = (async () => {
        /** @type {DrainResult | null} */
        let result = null;
        do {
          again = false;
          /** @type {DrainResult | null} */
          let next = null;
          try {
            next = await once(client);
          } catch (error) {
            warn('drain-failed', error);
          }
          result = result && next ? combined(result, next) : next || result;
        } while (again);
        return result;
      })().finally(() => {
        draining = null;
      });
      draining = running;
      return running;
    },
    oldestOrphanedEntryAt: () => oldest,
    held: () => lastHeld.map(note => ({ ...note })),
  });
}
