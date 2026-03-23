/**
 * @typedef {'debug'|'info'|'warn'|'error'} LogLevel
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} module - Module name that produced the log
 * @property {LogLevel} level - Severity level
 * @property {string} message - Log message
 * @property {Array<*>} [data] - Optional additional data
 */

/**
 * @typedef {Object} Logger
 * @property {function(string, string, ...any): void} debug
 * @property {function(string, string, ...any): void} info
 * @property {function(string, string, ...any): void} warn
 * @property {function(string, string, ...any): void} error
 * @property {function(string): void} setLevel - Set minimum log level
 * @property {function(): LogLevel} getLevel - Get current minimum log level
 */

/** @type {Record<LogLevel, number>} */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Detect whether we're running in a development environment.
 * @returns {boolean}
 */
function isDevEnvironment() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
      const manifest = chrome.runtime.getManifest();
      return !('update_url' in manifest);
    }
  } catch (_) { /* ignore */ }
  return typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production';
}

/**
 * Create a structured logger with severity levels.
 * @param {LogLevel} [initialLevel] - Minimum log level. Defaults to 'warn' in production, 'debug' in development.
 * @returns {Logger}
 */
function createLogger(initialLevel) {
  /** @type {LogLevel} */
  let minLevel = initialLevel || (isDevEnvironment() ? 'debug' : 'warn');

  /**
   * @param {LogLevel} level
   * @param {string} moduleName
   * @param {string} message
   * @param {Array<*>} data
   */
  function log(level, moduleName, message, data) {
    if (LEVELS[level] < LEVELS[minLevel]) return;

    /** @type {LogEntry} */
    const entry = {
      timestamp: new Date().toISOString(),
      module: moduleName,
      level,
      message,
    };
    if (data.length) entry.data = data;

    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${moduleName}]`;
    const consoleFn = level === 'debug' ? console.debug
      : level === 'info' ? console.info
      : level === 'warn' ? console.warn
      : console.error;

    if (data.length) {
      consoleFn(prefix, message, ...data);
    } else {
      consoleFn(prefix, message);
    }
  }

  /**
   * @param {string} level
   */
  function setLevel(level) {
    if (!(level in LEVELS)) {
      console.warn(`[Logger] Invalid log level: "${level}". Expected one of: debug, info, warn, error`);
      return;
    }
    minLevel = /** @type {LogLevel} */ (level);
  }

  function getLevel() {
    return minLevel;
  }

  return {
    debug: (moduleName, message, ...data) => log('debug', moduleName, message, data),
    info: (moduleName, message, ...data) => log('info', moduleName, message, data),
    warn: (moduleName, message, ...data) => log('warn', moduleName, message, data),
    error: (moduleName, message, ...data) => log('error', moduleName, message, data),
    setLevel,
    getLevel,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createLogger };
} else if (typeof window !== 'undefined') {
  window.createLogger = createLogger;
}
