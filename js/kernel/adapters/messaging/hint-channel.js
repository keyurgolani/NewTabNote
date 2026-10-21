/**
 * #13's hint channel on BroadcastChannel `ntn-hints` (#13, "Topology"). The coordinator posts
 * commit hints there, never on ports, and pages hear them without opening a port. Pages post
 * page-addressed requests and their answers there too. A message counts only when it's text
 * and comes from this extension's own origin, and core reads it as a frame of the channel's
 * (contracts/hint-channel.js) before anything acts on it.
 */

import { HINT_CHANNEL } from '../../core/contracts/hint-channel.js';

/** @typedef {import('../../core/messaging/hints.js').Channel} Channel */

/**
 * What these take of a BroadcastChannel
 * @typedef {object} BroadcastChannelLike
 * @property {(message: unknown) => void} postMessage
 * @property {(type: 'message', listener: (event: {data: unknown, origin: string}) => void) => void} addEventListener
 * @property {() => void} close
 */

/**
 * Opens the hint channel
 * @param {{origin: string, BroadcastChannel?: new (name: string) => BroadcastChannelLike}} options -
 *   `origin` is this extension's, `chrome-extension://<id>`. `BroadcastChannel` is the host's
 *   unless a test passes another.
 * @returns {Channel}
 */
export function openHintChannel({ origin, BroadcastChannel: Channel = globalThis.BroadcastChannel }) {
  const channel = new Channel(HINT_CHANNEL);
  return Object.freeze({
    post(text) {
      channel.postMessage(text);
    },
    onMessage(listener) {
      channel.addEventListener('message', event => {
        if (event.origin !== origin || typeof event.data !== 'string') return;
        listener(event.data);
      });
    },
    close() {
      channel.close();
    },
  });
}
