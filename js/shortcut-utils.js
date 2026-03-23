(function (global) {
  const LIST_BLOCK_TYPES = new Set(['bullet', 'numbered', 'todo']);
  const MAX_INDENT_LEVEL = 4;

  /**
   * @typedef {Object} AppShortcutParams
   * @property {string} code - KeyboardEvent.code
   * @property {string} key - KeyboardEvent.key
   * @property {boolean} modKey - Ctrl (or Cmd on macOS) pressed
   * @property {boolean} shiftKey - Shift pressed
   * @property {boolean} altKey - Alt pressed
   * @property {boolean} isInput - Whether focus is in an input field
   */

  /**
   * Determine the app-level shortcut action for a keyboard event.
   * @param {AppShortcutParams} params - Keyboard event parameters
   * @returns {string|null} Action name or null if no match
   */
  function getAppShortcutAction({
    code,
    key,
    modKey,
    shiftKey,
    altKey,
    isInput,
  }) {
    if (key === 'Escape') {
      return 'escape';
    }

    if (modKey && shiftKey && code === 'KeyN') {
      return 'new-note';
    }

    if (modKey && shiftKey && code === 'KeyE') {
      return 'toggle-sidebar';
    }

    if (modKey && shiftKey && code === 'KeyA') {
      return 'command-palette';
    }

    if (modKey && shiftKey && code === 'F11') {
      return 'toggle-focus-mode';
    }

    if (altKey && code === 'KeyN') {
      return 'legacy-new-note';
    }

    if (altKey && code === 'KeyA') {
      return 'toggle-ai';
    }

    if (modKey && code === 'Backslash') {
      return 'toggle-sidebar';
    }

    if (modKey && code === 'KeyK') {
      return 'focus-search';
    }

    if (altKey && code === 'KeyD') {
      return 'daily-note';
    }

    if (modKey && code === 'KeyW') {
      return 'close-tab';
    }

    if (modKey && code === 'Tab') {
      return shiftKey ? 'prev-tab' : 'next-tab';
    }

    if (!isInput && key === '?') {
      return 'show-shortcuts';
    }

    return null;
  }

  /**
   * @typedef {Object} EditorShortcutParams
   * @property {string} code - KeyboardEvent.code
   * @property {boolean} modKey - Ctrl (or Cmd on macOS) pressed
   * @property {boolean} shiftKey - Shift pressed
   * @property {boolean} altKey - Alt pressed
   * @property {string} blockType - Current block type
   */

  /**
   * Determine the editor-level shortcut action for a keyboard event.
   * @param {EditorShortcutParams} params - Keyboard event parameters
   * @returns {{type: string, direction?: number, blockType?: string, delta?: number}|null} Action object or null
   */
  function getEditorShortcutAction({
    code,
    modKey,
    shiftKey,
    altKey,
    blockType,
  }) {
    if (modKey && code === 'Enter') {
      return { type: 'insert-below' };
    }

    if (modKey && shiftKey && code === 'ArrowUp') {
      return { type: 'move-block', direction: -1 };
    }

    if (modKey && shiftKey && code === 'ArrowDown') {
      return { type: 'move-block', direction: 1 };
    }

    if (altKey && code === 'Digit1') {
      return { type: 'convert-block', blockType: 'h1' };
    }

    if (altKey && code === 'Digit2') {
      return { type: 'convert-block', blockType: 'h2' };
    }

    if (altKey && code === 'Digit3') {
      return { type: 'convert-block', blockType: 'h3' };
    }

    if (code === 'Tab' && LIST_BLOCK_TYPES.has(blockType)) {
      return { type: 'indent-block', delta: shiftKey ? -1 : 1 };
    }

    return null;
  }

  /**
   * Clamp an indent level within valid bounds.
   * @param {number} [currentLevel=0] - Current indent level
   * @param {number} [delta=0] - Change to apply
   * @param {number} [maxLevel=MAX_INDENT_LEVEL] - Maximum indent level
   * @returns {number} Clamped indent level
   */
  function clampIndentLevel(currentLevel = 0, delta = 0, maxLevel = MAX_INDENT_LEVEL) {
    return Math.max(0, Math.min(maxLevel, currentLevel + delta));
  }

  /**
   * Move an item in an array from one index to another.
   * @param {Array<*>} items - Source array
   * @param {number} fromIndex - Index to move from
   * @param {number} toIndex - Index to move to
   * @returns {Array<*>} New array with the item moved
   */
  function moveItemInArray(items, fromIndex, toIndex) {
    const nextItems = [...items];

    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= nextItems.length ||
      toIndex >= nextItems.length ||
      fromIndex === toIndex
    ) {
      return nextItems;
    }

    const [item] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, item);
    return nextItems;
  }

  const api = {
    clampIndentLevel,
    getAppShortcutAction,
    getEditorShortcutAction,
    moveItemInArray,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.ShortcutUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
