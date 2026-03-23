/**
 * Custom error class for IndexedDB transaction failures.
 *
 * @extends Error
 * @property {string} code - Error code (e.g., 'TRANSACTION_FAILED', 'INTEGRITY_VIOLATION')
 * @property {string} operation - The operation that failed (e.g., 'createNote', 'saveElement')
 * @property {Error} [cause] - The original IndexedDB error
 */
class StorageError extends Error {
  /**
   * @param {string} code - Structured error code
   * @param {string} operation - The storage operation that failed
   * @param {Error} [cause] - The original error
   */
  constructor(code, operation, cause) {
    super(`Storage error [${code}] during ${operation}${cause ? ': ' + cause.message : ''}`);
    this.name = 'StorageError';
    this.code = code;
    this.operation = operation;
    this.cause = cause || null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StorageError };
} else if (typeof window !== 'undefined') {
  window.StorageError = StorageError;
}
