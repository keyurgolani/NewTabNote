(function (global) {
  const DEFAULT_TEXT_BLOCK_PLACEHOLDER = "Type '/' for commands, or just start writing...";

  function getBlockPlaceholder(type, fallback = '') {
    if (type === 'text' && (!fallback || !String(fallback).trim())) {
      return DEFAULT_TEXT_BLOCK_PLACEHOLDER;
    }

    return fallback || '';
  }

  const api = {
    DEFAULT_TEXT_BLOCK_PLACEHOLDER,
    getBlockPlaceholder,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.BlockPlaceholders = api;
})(typeof window !== 'undefined' ? window : globalThis);
