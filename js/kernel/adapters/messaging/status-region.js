/**
 * #13's status region (#13, "Accessibility and performance"), which #24 (accessibility) has
 * each surface mount at load: one polite live region that announces the connection states
 * that change what the user can do, Reconnecting, Coordinator unavailable, and Unsupported
 * protocol version, and the resolution after one of them. Connecting, and a worker that stops
 * and wakes while nothing waits, are never announced. The region is in the page, empty, from
 * when it's mounted, so a screen reader hears each change, and each transition is announced
 * once. Nothing here moves focus. Retry and Reload keep focus on themselves, and a control
 * that's no longer offered while it has focus stays, disabled, until focus leaves it.
 *
 * Nothing mounts it yet. #24 mounts it at each surface's load, and other announcements, such
 * as #11's "Responding", go through announce().
 */

/** @typedef {import('../../core/messaging/client.js').ConnectionState} ConnectionState */

/**
 * What the region takes of #13's client
 * @typedef {object} StatusSource
 * @property {() => ConnectionState} state
 * @property {(listener: (state: ConnectionState) => void) => () => void} subscribe
 * @property {() => void} retry
 * @property {() => boolean} canReload
 */

/** What the region says, until #1's strings replace these */
export const STATUS_TEXT = Object.freeze({
  reconnecting: 'Reconnecting',
  unavailable: 'Coordinator unavailable',
  unsupported: 'Unsupported protocol version',
  resolved: 'Reconnected',
  retry: 'Retry',
  reload: 'Reload',
});

/** The states that change what the user can do, each announced as it comes */
const PROBLEMS = new Set(['reconnecting', 'unavailable', 'unsupported']);

/**
 * Mounts the region in `parent`
 * @param {object} options
 * @param {Document} options.document
 * @param {Element} options.parent
 * @param {StatusSource} options.client
 * @param {Partial<typeof STATUS_TEXT>} [options.text]
 * @param {() => void} [options.reload] - reloads the page, unless a test passes another
 */
export function mountStatusRegion({
  document,
  parent,
  client,
  text: overrides = {},
  reload = () => document.defaultView?.location.reload(),
}) {
  const text = { ...STATUS_TEXT, ...overrides };
  const root = document.createElement('div');
  root.className = 'ntn-status-region';
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.setAttribute('aria-atomic', 'true');

  /** @type {Map<HTMLButtonElement, boolean>} whether each control is offered */
  const offered = new Map();

  /**
   * @param {string} label
   * @param {() => void} act
   * @returns {HTMLButtonElement}
   */
  const control = (label, act) => {
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.type = 'button';
    button.textContent = label;
    button.hidden = true;
    offered.set(button, false);
    button.addEventListener('click', () => {
      if (offered.get(button)) act();
    });
    // A control withdrawn while it had focus goes once focus leaves it
    button.addEventListener('blur', () => {
      if (!offered.get(button)) button.hidden = true;
    });
    return button;
  };

  const retry = control(text.retry, () => client.retry());
  const reloadButton = control(text.reload, () => {
    if (client.canReload()) reload();
  });
  root.appendChild(message);
  root.appendChild(retry);
  root.appendChild(reloadButton);
  parent.appendChild(root);

  /**
   * Offers a control or withdraws it, never taking focus from it
   * @param {HTMLButtonElement} button
   * @param {boolean} offer
   */
  const offer = (button, offer) => {
    offered.set(button, offer);
    if (offer) {
      button.hidden = false;
      button.removeAttribute('aria-disabled');
    } else if (document.activeElement === button) {
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.hidden = true;
    }
  };

  /** Whether the region's text is a connection state's, which it can clear */
  let ours = false;
  /** Whether a problem was announced and hasn't been resolved */
  let problem = false;
  /** @type {ConnectionState | null} the state last rendered, so each is announced once */
  let last = null;

  /** @param {string} words */
  const say = words => {
    if (message.textContent !== words) message.textContent = words;
  };

  /** @param {ConnectionState} state */
  const render = state => {
    const changed = state !== last;
    last = state;
    if (!changed) {
      // Only what can be offered may have changed
    } else if (PROBLEMS.has(state)) {
      problem = true;
      ours = true;
      say(text[/** @type {'reconnecting' | 'unavailable' | 'unsupported'} */ (state)]);
    } else if (state === 'connected' && problem) {
      problem = false;
      ours = true;
      say(text.resolved);
    } else if (!problem && ours && (state === 'idle' || state === 'connecting')) {
      // Clearing the resolution is silent, and the next problem is heard fresh
      ours = false;
      say('');
    }
    offer(retry, state === 'unavailable');
    offer(reloadButton, state === 'unsupported' && client.canReload());
  };

  const unsubscribe = client.subscribe(render);
  render(client.state());

  return Object.freeze({
    /**
     * Announces `words` politely on the same region, for what other surfaces' features say
     * @param {string} words
     */
    announce(words) {
      ours = false;
      say(words);
    },
    /** Checks again whether Reload can be offered, as after a composition ends or a commit lands */
    refresh() {
      render(client.state());
    },
    /** Takes the region out, as the page goes */
    destroy() {
      unsubscribe();
      root.remove();
    },
  });
}
