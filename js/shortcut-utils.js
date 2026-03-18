(function (global) {
  const LIST_BLOCK_TYPES = new Set(['bullet', 'numbered', 'todo']);
  const MAX_INDENT_LEVEL = 4;

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

    if (!isInput && key === '?') {
      return 'show-shortcuts';
    }

    return null;
  }

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

  function clampIndentLevel(currentLevel = 0, delta = 0, maxLevel = MAX_INDENT_LEVEL) {
    return Math.max(0, Math.min(maxLevel, currentLevel + delta));
  }

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
