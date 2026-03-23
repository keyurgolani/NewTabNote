/**
 * @typedef {Object} ConfirmDialogOptions
 * @property {string} title
 * @property {string} message
 * @property {string} [confirmText='Confirm']
 * @property {string} [cancelText='Cancel']
 * @property {boolean} [danger=false]
 */

/**
 * Show a custom confirmation dialog styled with the app's design system.
 * Focus-trapped modal with Escape-to-cancel and Enter-to-confirm.
 *
 * Validates: Requirements 47.1, 47.2, 47.3, 47.4
 *
 * @param {ConfirmDialogOptions} options
 * @returns {Promise<boolean>} Resolves true if confirmed, false if cancelled
 */
function confirmDialog(options) {
  const {
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = false
  } = options;

  return new Promise((resolve) => {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);

    // Dialog container
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    // Title
    const titleEl = document.createElement('h3');
    titleEl.className = 'confirm-dialog-title';
    titleEl.textContent = title;
    dialog.appendChild(titleEl);

    // Message
    const messageEl = document.createElement('p');
    messageEl.className = 'confirm-dialog-message';
    messageEl.textContent = message;
    dialog.appendChild(messageEl);

    // Button row
    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-dialog-btn confirm-dialog-cancel';
    cancelBtn.textContent = cancelText;
    cancelBtn.type = 'button';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm-dialog-btn confirm-dialog-confirm';
    if (danger) {
      confirmBtn.classList.add('confirm-dialog-danger');
    }
    confirmBtn.textContent = confirmText;
    confirmBtn.type = 'button';

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    /** @type {HTMLElement[]} */
    const focusableEls = [cancelBtn, confirmBtn];
    let focusIndex = 1; // start on confirm button

    function cleanup() {
      overlay.removeEventListener('keydown', onKeyDown);
      overlay.removeEventListener('mousedown', onOverlayClick);
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }

    function close(result) {
      cleanup();
      resolve(result);
    }

    /**
     * @param {KeyboardEvent} e
     */
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        close(document.activeElement === cancelBtn ? false : true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          focusIndex = (focusIndex - 1 + focusableEls.length) % focusableEls.length;
        } else {
          focusIndex = (focusIndex + 1) % focusableEls.length;
        }
        focusableEls[focusIndex].focus();
      }
    }

    /**
     * @param {MouseEvent} e
     */
    function onOverlayClick(e) {
      if (e.target === overlay) {
        close(false);
      }
    }

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('mousedown', onOverlayClick);

    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}

/**
 * @typedef {Object} PromptDialogOptions
 * @property {string} title
 * @property {string} message
 * @property {string} [defaultValue='']
 * @property {string} [confirmText='OK']
 * @property {string} [cancelText='Cancel']
 * @property {string} [placeholder='']
 */

/**
 * Show a custom prompt dialog with a text input field.
 * Returns the entered string on confirm, or null on cancel.
 *
 * @param {PromptDialogOptions} options
 * @returns {Promise<string|null>}
 */
function promptDialog(options) {
  const {
    title,
    message,
    defaultValue = '',
    confirmText = 'OK',
    cancelText = 'Cancel',
    placeholder = ''
  } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const titleEl = document.createElement('h3');
    titleEl.className = 'confirm-dialog-title';
    titleEl.textContent = title;
    dialog.appendChild(titleEl);

    const messageEl = document.createElement('p');
    messageEl.className = 'confirm-dialog-message';
    messageEl.textContent = message;
    dialog.appendChild(messageEl);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'confirm-dialog-input';
    input.value = defaultValue;
    if (placeholder) input.placeholder = placeholder;
    dialog.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-dialog-btn confirm-dialog-cancel';
    cancelBtn.textContent = cancelText;
    cancelBtn.type = 'button';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm-dialog-btn confirm-dialog-confirm';
    confirmBtn.textContent = confirmText;
    confirmBtn.type = 'button';

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    /** @type {HTMLElement[]} */
    const focusableEls = [input, cancelBtn, confirmBtn];
    let focusIndex = 0;

    function cleanup() {
      overlay.removeEventListener('keydown', onKeyDown);
      overlay.removeEventListener('mousedown', onOverlayClick);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function close(result) {
      cleanup();
      resolve(result);
    }

    /** @param {KeyboardEvent} e */
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement === cancelBtn) {
          close(null);
        } else {
          close(input.value);
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          focusIndex = (focusIndex - 1 + focusableEls.length) % focusableEls.length;
        } else {
          focusIndex = (focusIndex + 1) % focusableEls.length;
        }
        focusableEls[focusIndex].focus();
      }
    }

    /** @param {MouseEvent} e */
    function onOverlayClick(e) {
      if (e.target === overlay) close(null);
    }

    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', () => close(input.value));
    overlay.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('mousedown', onOverlayClick);

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

// Inject styles once
(function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('confirm-dialog-styles')) return;

  const style = document.createElement('style');
  style.id = 'confirm-dialog-styles';
  style.textContent = [
    '.confirm-dialog-overlay {',
    '  position: fixed;',
    '  top: 0; left: 0; right: 0; bottom: 0;',
    '  background: var(--modal-bg, rgba(0,0,0,0.4));',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  z-index: 2000;',
    '  padding: 20px;',
    '}',
    '.confirm-dialog {',
    '  background: var(--bg-primary, #fff);',
    '  border-radius: 12px;',
    '  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.12));',
    '  width: 100%;',
    '  max-width: 400px;',
    '  padding: var(--spacing-xl, 24px);',
    '  animation: confirm-dialog-in 0.15s ease;',
    '}',
    '@keyframes confirm-dialog-in {',
    '  from { opacity: 0; transform: scale(0.96); }',
    '  to { opacity: 1; transform: scale(1); }',
    '}',
    '.confirm-dialog-title {',
    '  font-size: 16px;',
    '  font-weight: 600;',
    '  color: var(--text-primary, #1a1a1a);',
    '  margin: 0 0 8px 0;',
    '}',
    '.confirm-dialog-message {',
    '  font-size: 14px;',
    '  color: var(--text-secondary, #6b6b6b);',
    '  line-height: 1.5;',
    '  margin: 0 0 20px 0;',
    '}',
    '.confirm-dialog-actions {',
    '  display: flex;',
    '  justify-content: flex-end;',
    '  gap: 8px;',
    '}',
    '.confirm-dialog-btn {',
    '  padding: 8px 16px;',
    '  border-radius: 6px;',
    '  font-size: 14px;',
    '  font-family: inherit;',
    '  font-weight: 500;',
    '  cursor: pointer;',
    '  transition: all 0.2s ease;',
    '  border: 1px solid var(--border-color, #e5e5e5);',
    '}',
    '.confirm-dialog-btn:focus-visible {',
    '  outline: 2px solid var(--accent-color, #2383e2);',
    '  outline-offset: 2px;',
    '}',
    '.confirm-dialog-cancel {',
    '  background: var(--bg-secondary, #f7f7f7);',
    '  color: var(--text-primary, #1a1a1a);',
    '}',
    '.confirm-dialog-cancel:hover {',
    '  background: var(--bg-hover, #f0f0f0);',
    '}',
    '.confirm-dialog-confirm {',
    '  background: var(--accent-color, #2383e2);',
    '  color: #fff;',
    '  border-color: var(--accent-color, #2383e2);',
    '}',
    '.confirm-dialog-confirm:hover {',
    '  background: var(--accent-hover, #1a6fc4);',
    '  border-color: var(--accent-hover, #1a6fc4);',
    '}',
    '.confirm-dialog-danger {',
    '  background: var(--danger-color, #e03e3e);',
    '  border-color: var(--danger-color, #e03e3e);',
    '}',
    '.confirm-dialog-danger:hover {',
    '  opacity: 0.9;',
    '}',
    '.confirm-dialog-input {',
    '  width: 100%;',
    '  padding: 8px 12px;',
    '  border: 1px solid var(--border-color, #e5e5e5);',
    '  border-radius: 6px;',
    '  font-size: 14px;',
    '  font-family: inherit;',
    '  background: var(--bg-secondary, #f7f7f7);',
    '  color: var(--text-primary, #1a1a1a);',
    '  margin: 0 0 16px 0;',
    '  box-sizing: border-box;',
    '}',
    '.confirm-dialog-input:focus {',
    '  outline: 2px solid var(--accent-color, #2383e2);',
    '  outline-offset: -1px;',
    '  border-color: var(--accent-color, #2383e2);',
    '}',
  ].join('\n');

  document.head.appendChild(style);
})();

// Dual CommonJS/browser export (same pattern as event-bus.js)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { confirmDialog, promptDialog };
} else if (typeof window !== 'undefined') {
  window.confirmDialog = confirmDialog;
  window.promptDialog = promptDialog;
}
