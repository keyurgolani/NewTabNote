/**
 * @typedef {Object} EventBus
 * @property {function(string, Function): Function} on - Subscribe. Returns unsubscribe fn.
 * @property {function(string, *): void} emit - Publish event with optional payload.
 * @property {function(string, Function): void} off - Unsubscribe.
 */

/**
 * Create a lightweight pub/sub event bus for cross-controller communication.
 * @returns {EventBus}
 */
function createEventBus() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  /**
   * Subscribe to an event.
   * @param {string} event - Event name (e.g. 'note:saved')
   * @param {Function} handler - Callback invoked with the event payload
   * @returns {Function} Unsubscribe function
   */
  function on(event, handler) {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event).add(handler);
    return () => off(event, handler);
  }

  /**
   * Publish an event with an optional payload.
   * @param {string} event - Event name
   * @param {*} [payload] - Data passed to each handler
   */
  function emit(event, payload) {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(payload);
    }
  }

  /**
   * Unsubscribe a handler from an event.
   * @param {string} event - Event name
   * @param {Function} handler - The handler to remove
   */
  function off(event, handler) {
    const handlers = listeners.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      listeners.delete(event);
    }
  }

  return { on, emit, off };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createEventBus };
} else if (typeof window !== 'undefined') {
  window.createEventBus = createEventBus;
}
