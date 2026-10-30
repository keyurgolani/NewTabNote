/**
 * #13's commit hints (#13, "Desired behavior" and AC4): content-free notes on the hint channel
 * that an entity changed, which a page answers by catching up from its cursor (#13 slice 3).
 * The coordinator posts them, never on a port, and coalesces them per entity, so commits to
 * one note in the same turn post one hint. A page drops a hint that's a duplicate or out of
 * order for its entity, one whose commitSeq is no later than the last it heard there, and a
 * subscriber that throws doesn't stop the others.
 */

import { encode } from '../contracts/codec.js';
import { hintSchema } from '../contracts/hint-channel.js';
import { check, readChannelFrame } from '../contracts/validate.js';
import { silentLogger } from '../ports/runtime.js';

/** @typedef {import('../contracts/hint-channel.js').HintFrame} HintFrame */
/** @typedef {Omit<HintFrame, 'frame'>} Hint */
/** @typedef {import('../ports/runtime.js').Logger} Logger */

/**
 * How many entities a page remembers the last commitSeq of. Past it, the one heard longest
 * ago is forgotten, which only lets a duplicate of its hint through, and catching up from the
 * cursor absorbs that.
 */
export const MAX_HINT_ENTITIES = 1024;

/**
 * The hint channel as core sees it: the codec's text each way, as on a link. Its adapter
 * (adapters/messaging/hint-channel.js) passes on only what came from this extension's origin.
 * @typedef {object} Channel
 * @property {(text: string) => void} post
 * @property {(listener: (text: string) => void) => void} onMessage
 * @property {() => void} close
 */

/**
 * @param {Hint} hint
 * @returns {string}
 */
const keyOf = hint => `${hint.entityType} ${hint.entityId}`;

/**
 * Tells `logger`, whose own failure changes nothing
 * @param {Logger} logger
 * @param {string} event
 * @param {Record<string, unknown>} detail
 */
function warn(logger, event, detail) {
  try {
    logger.warn(event, detail);
  } catch {
    // Nothing to tell
  }
}

/**
 * The coordinator's side: posts each hint once its turn ends, the latest for each entity
 * @param {{channel: Channel, logger?: Logger}} options
 */
export function createHintPublisher({ channel, logger = silentLogger }) {
  /** @type {Map<string, HintFrame>} */
  let waiting = new Map();

  const flush = () => {
    const hints = [...waiting.values()];
    waiting = new Map();
    for (const hint of hints) {
      try {
        channel.post(encode(hint));
      } catch (error) {
        warn(logger, 'hint-post-failed', { error });
      }
    }
  };

  return Object.freeze({
    /**
     * Posts a hint for a commit, unless a later one for the same entity comes in this turn. A
     * hint its schema refuses, as one carrying anything but ids and numbers, is dropped.
     * @param {Hint} hint
     */
    publish(hint) {
      /** @type {HintFrame} */
      const frame = {
        frame: 'hint',
        entityType: hint.entityType,
        entityId: hint.entityId,
        revision: hint.revision,
        commitSeq: hint.commitSeq,
      };
      if (!check(hintSchema, { ...hint, frame: 'hint' }).ok) {
        warn(logger, 'hint-refused', { entityType: frame.entityType });
        return;
      }
      const key = keyOf(frame);
      const known = waiting.get(key);
      if (known && known.commitSeq >= frame.commitSeq) return;
      if (waiting.size === 0) Promise.resolve().then(flush);
      waiting.set(key, frame);
    },
  });
}

/**
 * A page's side: hears each hint later than the last for its entity
 * @param {{channel: Channel, logger?: Logger}} options
 */
export function createHintSubscriber({ channel, logger = silentLogger }) {
  /** @type {Map<string, number>} the last commitSeq heard for each entity, the longest ago first */
  const latest = new Map();
  /** @type {Set<(hint: Hint) => void>} */
  const listeners = new Set();

  channel.onMessage(text => {
    const read = readChannelFrame(text);
    if (!read.ok || read.frame.frame !== 'hint') return;
    const { entityType, entityId, revision, commitSeq } = read.frame;
    const key = keyOf({ entityType, entityId, revision, commitSeq });
    if ((latest.get(key) ?? 0) >= commitSeq) return;
    // Set again, so the map's order is the order entities were last heard in
    latest.delete(key);
    latest.set(key, commitSeq);
    if (latest.size > MAX_HINT_ENTITIES) latest.delete(/** @type {string} */ (latest.keys().next().value));
    for (const listener of [...listeners]) {
      try {
        listener({ entityType, entityId, revision, commitSeq });
      } catch (error) {
        warn(logger, 'hint-listener-failed', { error });
      }
    }
  });

  return Object.freeze({
    /**
     * Tells `listener` each hint from now on, until the function it returns is called
     * @param {(hint: Hint) => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}
