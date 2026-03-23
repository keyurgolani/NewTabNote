/**
 * Floating inline formatting toolbar.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
 *
 * @typedef {Object} FormattingToolbarConfig
 * @property {Document} [doc] - Document to use (defaults to window.document)
 */

/**
 * FormattingToolbar — a floating toolbar that appears above text selections
 * inside `.block-content` elements. Provides Bold, Italic, Code, Link,
 * Strikethrough, and Highlight buttons. Uses `document.execCommand` with
 * Range API fallback. Reflects current selection formatting state.
 */
class FormattingToolbar {
  /**
   * @param {FormattingToolbarConfig} [config]
   */
  constructor(config = {}) {
    /** @type {Document} */
    this.doc = config.doc || document;

    /** @type {HTMLDivElement|null} */
    this.el = null;

    /** @type {HTMLDivElement|null} */
    this.linkInput = null;

    /** @type {boolean} */
    this.visible = false;

    /** @type {boolean} */
    this.linkMode = false;

    /** @type {Range|null} Saved range while link input is focused */
    this._savedRange = null;

    this._build();
    this._bindEvents();
  }

  // ── Button definitions ──────────────────────────────────────────────

  /** @returns {Array<{id: string, command: string, label: string, icon: string}>} */
  static get BUTTONS() {
    return [
      { id: 'bold',          command: 'bold',          label: 'Bold',          icon: 'B'  },
      { id: 'italic',        command: 'italic',        label: 'Italic',        icon: 'I'  },
      { id: 'code',          command: 'code',          label: 'Code',          icon: '<>' },
      { id: 'link',          command: 'link',          label: 'Link',          icon: '🔗' },
      { id: 'strikethrough', command: 'strikeThrough', label: 'Strikethrough', icon: 'S'  },
      { id: 'highlight',     command: 'highlight',     label: 'Highlight',     icon: 'H'  },
    ];
  }

  // ── DOM construction ──────────────────────────────────────────────

  /** Build the toolbar DOM and append to document body. */
  _build() {
    const el = this.doc.createElement('div');
    el.className = 'formatting-toolbar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Text formatting');

    // Format buttons
    const btnGroup = this.doc.createElement('div');
    btnGroup.className = 'formatting-toolbar-buttons';

    for (const btn of FormattingToolbar.BUTTONS) {
      const button = this.doc.createElement('button');
      button.type = 'button';
      button.className = 'formatting-toolbar-btn';
      button.dataset.command = btn.command;
      button.dataset.id = btn.id;
      button.setAttribute('aria-label', btn.label);
      button.title = btn.label;
      button.textContent = btn.icon;
      if (btn.id === 'italic') button.style.fontStyle = 'italic';
      if (btn.id === 'strikethrough') button.style.textDecoration = 'line-through';
      btnGroup.appendChild(button);
    }

    el.appendChild(btnGroup);

    // Inline link input (hidden by default)
    const linkWrap = this.doc.createElement('div');
    linkWrap.className = 'formatting-toolbar-link-input';
    linkWrap.style.display = 'none';

    const linkField = this.doc.createElement('input');
    linkField.type = 'url';
    linkField.placeholder = 'Paste or type URL…';
    linkField.className = 'formatting-toolbar-url';
    linkField.setAttribute('aria-label', 'URL');

    const linkConfirm = this.doc.createElement('button');
    linkConfirm.type = 'button';
    linkConfirm.className = 'formatting-toolbar-btn formatting-toolbar-link-ok';
    linkConfirm.textContent = '✓';
    linkConfirm.setAttribute('aria-label', 'Apply link');

    linkWrap.appendChild(linkField);
    linkWrap.appendChild(linkConfirm);
    el.appendChild(linkWrap);

    this.el = el;
    this.linkInput = linkWrap;
    this._linkField = linkField;
    this._linkConfirm = linkConfirm;
    this._btnGroup = btnGroup;

    this.doc.body.appendChild(el);
  }

  // ── Event binding ─────────────────────────────────────────────────

  _bindEvents() {
    // Selection change — show/hide toolbar
    this.doc.addEventListener('selectionchange', () => this._onSelectionChange());

    // Button clicks (delegated)
    this._btnGroup.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep selection alive
      const target = /** @type {HTMLElement} */ (e.target);
      const btn = /** @type {HTMLElement} */ (target.closest('.formatting-toolbar-btn'));
      if (!btn) return;
      this._onButtonClick(btn.dataset.command, btn.dataset.id);
    });

    // Link input confirm
    this._linkConfirm.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._applyLink();
    });

    this._linkField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._applyLink();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this._hideLinkInput();
        this._restoreRange();
      }
    });

    // Hide on mousedown outside toolbar
    this.doc.addEventListener('mousedown', (e) => {
      const target = /** @type {Node} */ (e.target);
      if (this.visible && this.el && !this.el.contains(target)) {
        // Let selectionchange handle hide; don't force-hide here
        // so that clicking inside editor to change selection works.
      }
    });
  }

  // ── Selection handling ────────────────────────────────────────────

  _onSelectionChange() {
    // Don't hide while link input is focused
    if (this.linkMode) return;

    const sel = this.doc.defaultView.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hide();
      return;
    }

    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;

    // Only show inside .block-content elements
    const ancestor = container.nodeType === Node.ELEMENT_NODE
      ? /** @type {Element} */ (container)
      : container.parentElement;
    const blockContent = ancestor?.closest('.block-content');

    if (!blockContent) {
      this.hide();
      return;
    }

    this._positionAbove(range);
    this._updateActiveStates();
    this.show();
  }

  // ── Positioning ───────────────────────────────────────────────────

  /**
   * Position the toolbar above the given Range.
   * @param {Range} range
   */
  _positionAbove(range) {
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      this.hide();
      return;
    }

    const toolbarHeight = this.el.offsetHeight || 36;
    const gap = 8;

    let top = rect.top - toolbarHeight - gap + window.scrollY;
    let left = rect.left + (rect.width / 2) + window.scrollX;

    // Ensure toolbar stays within viewport horizontally
    const toolbarWidth = this.el.offsetWidth || 240;
    const halfWidth = toolbarWidth / 2;
    const viewportWidth = this.doc.defaultView.innerWidth;

    if (left - halfWidth < 4) left = halfWidth + 4;
    if (left + halfWidth > viewportWidth - 4) left = viewportWidth - halfWidth - 4;

    // If not enough room above, show below
    if (top < window.scrollY + 4) {
      top = rect.bottom + gap + window.scrollY;
    }

    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }

  // ── Show / Hide ───────────────────────────────────────────────────

  show() {
    if (!this.el) return;
    this.el.classList.add('visible');
    this.visible = true;
  }

  hide() {
    if (!this.el) return;
    this.el.classList.remove('visible');
    this.visible = false;
    this._hideLinkInput();
  }

  // ── Active state reflection (Req 9.5) ─────────────────────────────

  _updateActiveStates() {
    for (const btn of FormattingToolbar.BUTTONS) {
      const el = this._btnGroup.querySelector(`[data-id="${btn.id}"]`);
      if (!el) continue;

      let active = false;
      if (btn.id === 'code') {
        active = this._isInsideTag('CODE');
      } else if (btn.id === 'highlight') {
        active = this._isInsideTag('MARK');
      } else if (btn.id === 'link') {
        active = this._isInsideTag('A');
      } else {
        try { active = this.doc.queryCommandState(btn.command); } catch (_) { /* ignore */ }
      }

      el.classList.toggle('active', active);
    }
  }

  /**
   * Check if the current selection is inside a given tag name.
   * @param {string} tagName
   * @returns {boolean}
   */
  _isInsideTag(tagName) {
    const sel = this.doc.defaultView.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    let node = sel.anchorNode;
    while (node && node !== this.doc.body) {
      if (node.nodeType === Node.ELEMENT_NODE && /** @type {Element} */ (node).tagName === tagName) return true;
      node = node.parentNode;
    }
    return false;
  }

  // ── Command execution ─────────────────────────────────────────────

  /**
   * Handle a toolbar button click.
   * @param {string} command - execCommand name
   * @param {string} id - button id
   */
  _onButtonClick(command, id) {
    if (id === 'link') {
      this._showLinkInput();
      return;
    }

    if (id === 'code') {
      this._toggleInlineCode();
    } else if (id === 'highlight') {
      this._toggleHighlight();
    } else {
      this.doc.execCommand(command, false, null);
    }

    this._updateActiveStates();
  }

  /**
   * Toggle inline <code> wrapping via Range API.
   */
  _toggleInlineCode() {
    const sel = this.doc.defaultView.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);

    if (this._isInsideTag('CODE')) {
      // Unwrap: replace <code> with its text content
      let node = sel.anchorNode;
      while (node && /** @type {Element} */ (node).tagName !== 'CODE') node = node.parentNode;
      if (node && /** @type {Element} */ (node).tagName === 'CODE') {
        const text = this.doc.createTextNode(node.textContent);
        node.parentNode.replaceChild(text, node);
        // Re-select the text
        const newRange = this.doc.createRange();
        newRange.selectNodeContents(text);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    } else {
      const code = this.doc.createElement('code');
      try {
        code.appendChild(range.extractContents());
      } catch (_) {
        code.textContent = range.toString();
        range.deleteContents();
      }
      range.insertNode(code);
      // Select the code element contents
      const newRange = this.doc.createRange();
      newRange.selectNodeContents(code);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
  }

  /**
   * Toggle <mark> (highlight) wrapping via Range API.
   */
  _toggleHighlight() {
    const sel = this.doc.defaultView.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);

    if (this._isInsideTag('MARK')) {
      let node = sel.anchorNode;
      while (node && /** @type {Element} */ (node).tagName !== 'MARK') node = node.parentNode;
      if (node && /** @type {Element} */ (node).tagName === 'MARK') {
        const text = this.doc.createTextNode(node.textContent);
        node.parentNode.replaceChild(text, node);
        const newRange = this.doc.createRange();
        newRange.selectNodeContents(text);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    } else {
      const mark = this.doc.createElement('mark');
      try {
        mark.appendChild(range.extractContents());
      } catch (_) {
        mark.textContent = range.toString();
        range.deleteContents();
      }
      range.insertNode(mark);
      const newRange = this.doc.createRange();
      newRange.selectNodeContents(mark);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
  }

  // ── Link input ────────────────────────────────────────────────────

  _showLinkInput() {
    this._saveRange();
    this.linkMode = true;
    this._btnGroup.style.display = 'none';
    this.linkInput.style.display = 'flex';

    // Pre-fill if already inside a link
    if (this._isInsideTag('A')) {
      const sel = this.doc.defaultView.getSelection();
      let node = sel.anchorNode;
      while (node && /** @type {Element} */ (node).tagName !== 'A') node = node.parentNode;
      if (node) this._linkField.value = /** @type {HTMLAnchorElement} */ (node).href || '';
    } else {
      this._linkField.value = '';
    }

    this._linkField.focus();
  }

  _hideLinkInput() {
    this.linkMode = false;
    if (this.linkInput) this.linkInput.style.display = 'none';
    if (this._btnGroup) this._btnGroup.style.display = 'flex';
    if (this._linkField) this._linkField.value = '';
  }

  _applyLink() {
    const url = (this._linkField.value || '').trim();
    this._hideLinkInput();
    this._restoreRange();

    if (!url) return;

    this.doc.execCommand('createLink', false, url);
    this._updateActiveStates();
  }

  // ── Range save/restore (for link input focus) ─────────────────────

  _saveRange() {
    const sel = this.doc.defaultView.getSelection();
    if (sel && sel.rangeCount > 0) {
      this._savedRange = sel.getRangeAt(0).cloneRange();
    }
  }

  _restoreRange() {
    if (!this._savedRange) return;
    const sel = this.doc.defaultView.getSelection();
    sel.removeAllRanges();
    sel.addRange(this._savedRange);
    this._savedRange = null;
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  destroy() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    this.el = null;
  }
}

// ── Inject styles ─────────────────────────────────────────────────────

(function injectFormattingToolbarStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('formatting-toolbar-styles')) return;

  const style = document.createElement('style');
  style.id = 'formatting-toolbar-styles';
  style.textContent = [
    '.formatting-toolbar {',
    '  position: absolute;',
    '  display: flex;',
    '  flex-direction: column;',
    '  align-items: stretch;',
    '  background: var(--bg-primary, #fff);',
    '  border: 1px solid var(--border-color, #e5e5e5);',
    '  border-radius: 8px;',
    '  box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.1));',
    '  padding: 4px;',
    '  z-index: 1100;',
    '  transform: translateX(-50%);',
    '  opacity: 0;',
    '  pointer-events: none;',
    '  transition: opacity 0.12s ease;',
    '  white-space: nowrap;',
    '}',
    '.formatting-toolbar.visible {',
    '  opacity: 1;',
    '  pointer-events: auto;',
    '}',
    '.formatting-toolbar-buttons {',
    '  display: flex;',
    '  gap: 2px;',
    '}',
    '.formatting-toolbar-btn {',
    '  width: 32px;',
    '  height: 32px;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  border: none;',
    '  background: transparent;',
    '  color: var(--text-secondary, #6b6b6b);',
    '  border-radius: 6px;',
    '  cursor: pointer;',
    '  font-size: 14px;',
    '  font-weight: 600;',
    '  font-family: inherit;',
    '  transition: background 0.15s ease, color 0.15s ease;',
    '}',
    '.formatting-toolbar-btn:hover {',
    '  background: var(--bg-hover, #f0f0f0);',
    '  color: var(--text-primary, #1a1a1a);',
    '}',
    '.formatting-toolbar-btn.active {',
    '  background: var(--accent-color, #2383e2);',
    '  color: #fff;',
    '}',
    '.formatting-toolbar-link-input {',
    '  display: flex;',
    '  gap: 4px;',
    '  padding: 2px 0 0 0;',
    '}',
    '.formatting-toolbar-url {',
    '  flex: 1;',
    '  min-width: 180px;',
    '  padding: 4px 8px;',
    '  border: 1px solid var(--border-color, #e5e5e5);',
    '  border-radius: 6px;',
    '  font-size: 13px;',
    '  font-family: inherit;',
    '  background: var(--bg-secondary, #f7f7f7);',
    '  color: var(--text-primary, #1a1a1a);',
    '  outline: none;',
    '}',
    '.formatting-toolbar-url:focus {',
    '  border-color: var(--accent-color, #2383e2);',
    '}',
    '.formatting-toolbar-link-ok {',
    '  width: 28px;',
    '  font-size: 16px;',
    '}',
  ].join('\n');

  document.head.appendChild(style);
})();

// Dual CommonJS/browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FormattingToolbar };
} else if (typeof window !== 'undefined') {
  window.FormattingToolbar = FormattingToolbar;
}
