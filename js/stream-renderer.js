/**
 * StreamRenderer — Decouples token ingestion from DOM rendering using rAF.
 * Manages Stable_Zone / Active_Zone dual rendering with word-boundary snapping
 * and adaptive buffer pressure.
 *
 * Registered on window.StreamRenderer.
 */
class StreamRenderer {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.stableZone - Container for parsed HTML blocks
   * @param {HTMLElement} opts.activeZone - Container for in-progress raw text + cursor
   * @param {function(string): string} opts.parseBlock - Fn to parse markdown block → sanitized HTML
   * @param {function(): void} opts.onContentGrowth - Called when DOM content grows (for scroll)
   */
  constructor({ stableZone, activeZone, parseBlock, onContentGrowth }) {
    this._stableZone = stableZone;
    this._activeZone = activeZone;
    this._parseBlock = parseBlock;
    this._onContentGrowth = onContentGrowth || (() => {});

    this._buffer = '';
    this._stableContent = '';
    this._activeText = '';
    this._rafId = null;
    this._isRunning = false;
    this._blockBoundaryRe = /\n\n|^#{1,3}\s|^```/m;
  }

  /** Full markdown of all completed blocks (for chat history persistence). */
  get stableContent() {
    return this._stableContent;
  }

  /**
   * Append a token string to the internal buffer.
   * Schedules a rAF flush if one isn't already pending.
   * @param {string} token
   */
  push(token) {
    this._buffer += token;
    this._isRunning = true;

    if (this._rafId === null) {
      this._rafId = requestAnimationFrame(() => this._flush());
    }
  }

  /**
   * rAF flush callback.
   * Finds the last word boundary in the buffer, extracts flushable text,
   * checks for block boundaries, parses completed blocks into Stable_Zone,
   * and renders remaining text in Active_Zone with streaming cursor.
   * @private
   */
  _flush() {
    this._rafId = null;

    if (!this._buffer) return;

    // Determine how much of the buffer to flush (word-boundary snapping)
    const flushText = this._extractFlushable();
    if (!flushText && this._buffer.length <= 50) {
      // Nothing flushable yet and buffer isn't under pressure — wait for more tokens
      if (this._isRunning) {
        this._rafId = requestAnimationFrame(() => this._flush());
      }
      return;
    }

    const text = flushText || this._buffer;
    if (flushText) {
      this._buffer = this._buffer.slice(flushText.length);
    } else {
      this._buffer = '';
    }

    this._activeText += text;

    // Check for block boundaries in the accumulated active text
    this._promoteBlocks();

    // Render active zone: raw text + cursor
    this._renderActiveZone();

    this._onContentGrowth();

    // Continue flushing if there's more in the buffer
    if (this._buffer && this._isRunning && this._rafId === null) {
      this._rafId = requestAnimationFrame(() => this._flush());
    }
  }

  /**
   * Extract flushable text from the buffer up to the last word boundary.
   * Adaptive pressure: when buffer > 50 chars, flush more aggressively.
   * @returns {string|null} Text to flush, or null if no word boundary found.
   * @private
   */
  _extractFlushable() {
    const buf = this._buffer;
    if (!buf) return null;

    // Find last word boundary (space or newline)
    let boundary = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] === ' ' || buf[i] === '\n') {
        boundary = i + 1;
        break;
      }
    }

    if (boundary <= 0) return null;

    // Adaptive pressure: when buffer is large, flush up to last word boundary
    if (buf.length > 50) {
      return buf.slice(0, boundary);
    }

    return buf.slice(0, boundary);
  }

  /**
   * Check for block boundaries in _activeText and promote completed blocks
   * to the Stable_Zone via parseBlock().
   * @private
   */
  _promoteBlocks() {
    let text = this._activeText;

    // Keep looking for block boundaries
    while (true) {
      // Look for double newline as a block separator
      const dnIdx = text.indexOf('\n\n');
      if (dnIdx === -1) break;

      const block = text.slice(0, dnIdx).trim();
      text = text.slice(dnIdx + 2);

      if (block) {
        this._commitBlock(block);
      }
    }

    // Check if remaining text starts with a heading or code fence
    // that indicates the previous content was a complete block
    if (text.length > 0) {
      const match = text.match(/^(#{1,3}\s|```)/m);
      if (match && match.index > 0) {
        const block = text.slice(0, match.index).trim();
        text = text.slice(match.index);
        if (block) {
          this._commitBlock(block);
        }
      }
    }

    this._activeText = text;
  }

  /**
   * Parse a completed markdown block and append it to the Stable_Zone.
   * @param {string} markdown - The completed block markdown text.
   * @private
   */
  _commitBlock(markdown) {
    this._stableContent += (this._stableContent ? '\n\n' : '') + markdown;

    const html = this._parseBlock(markdown);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;

    // Append each child node to stable zone
    while (wrapper.firstChild) {
      this._stableZone.appendChild(wrapper.firstChild);
    }
  }

  /**
   * Render the Active_Zone with current in-progress text and streaming cursor.
   * @private
   */
  _renderActiveZone() {
    if (!this._activeZone) return;

    // Create a text node for the active text and append cursor
    this._activeZone.textContent = this._activeText;

    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    this._activeZone.appendChild(cursor);
  }

  /**
   * Remove the streaming cursor from the Active_Zone.
   * @private
   */
  _removeCursor() {
    if (!this._activeZone) return;
    const cursor = this._activeZone.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
  }

  /**
   * Cancel any pending rAF.
   * @private
   */
  _cancelRaf() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Signal that the stream has ended normally.
   * Flushes all remaining buffer to Stable_Zone via parseBlock(), removes cursor.
   */
  finish() {
    this._cancelRaf();
    this._isRunning = false;

    // Flush any remaining buffer
    if (this._buffer) {
      this._activeText += this._buffer;
      this._buffer = '';
    }

    // Promote all remaining active text to stable
    if (this._activeText.trim()) {
      this._commitBlock(this._activeText.trim());
    }
    this._activeText = '';

    // Clear active zone and remove cursor
    if (this._activeZone) {
      this._activeZone.textContent = '';
    }

    this._onContentGrowth();
  }

  /**
   * Abort rendering. Cancels rAF, flushes partial content to Stable_Zone,
   * removes cursor.
   */
  abort() {
    this._cancelRaf();
    this._isRunning = false;

    // Flush buffer into active text
    if (this._buffer) {
      this._activeText += this._buffer;
      this._buffer = '';
    }

    // Promote whatever we have to stable
    if (this._activeText.trim()) {
      this._commitBlock(this._activeText.trim());
    }
    this._activeText = '';

    // Clear active zone
    if (this._activeZone) {
      this._activeZone.textContent = '';
    }

    this._onContentGrowth();
  }

  /**
   * Destroy the renderer. Cancel rAF, null out DOM references.
   */
  destroy() {
    this._cancelRaf();
    this._isRunning = false;
    this._buffer = '';
    this._activeText = '';
    this._stableZone = null;
    this._activeZone = null;
    this._parseBlock = null;
    this._onContentGrowth = null;
  }
}

window.StreamRenderer = StreamRenderer;
