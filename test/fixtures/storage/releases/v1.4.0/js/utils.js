/**
 * Utility functions for New Tab Note
 */

const Utils = {
  /**
   * Generate a unique ID
   * @returns {string} A unique identifier string
   */
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  },

  /**
   * Deep clone an object
   * @param {*} obj - The object to clone
   * @returns {*} A deep copy of the object
   */
  deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  },

  /**
   * Debounce function
   * @param {Function} fn - The function to debounce
   * @param {number} delay - Delay in milliseconds
   * @returns {Function} The debounced function
   */
  debounce(fn, delay) {
    let timeoutId;
    return function (...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  /**
   * Throttle function
   * @param {Function} fn - The function to throttle
   * @param {number} limit - Minimum interval in milliseconds
   * @returns {Function} The throttled function
   */
  throttle(fn, limit) {
    let inThrottle;
    return function (...args) {
      if (!inThrottle) {
        fn.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  },

  /**
   * Clamp a value between min and max
   * @param {number} value - The value to clamp
   * @param {number} min - Minimum bound
   * @param {number} max - Maximum bound
   * @returns {number} The clamped value
   */
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },

  /**
   * Linear interpolation
   * @param {number} a - Start value
   * @param {number} b - End value
   * @param {number} t - Interpolation factor (0-1)
   * @returns {number} The interpolated value
   */
  lerp(a, b, t) {
    return a + (b - a) * t;
  },

  /**
   * Calculate distance between two points
   * @param {number} x1 - First point X
   * @param {number} y1 - First point Y
   * @param {number} x2 - Second point X
   * @param {number} y2 - Second point Y
   * @returns {number} The Euclidean distance
   */
  distance(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  },

  /**
   * Check if point is inside rectangle
   * @param {number} px - Point X
   * @param {number} py - Point Y
   * @param {{x: number, y: number, width: number, height: number}} rect - The rectangle
   * @returns {boolean} True if point is inside the rectangle
   */
  pointInRect(px, py, rect) {
    return (
      px >= rect.x &&
      px <= rect.x + rect.width &&
      py >= rect.y &&
      py <= rect.y + rect.height
    );
  },

  /**
   * Check if two rectangles intersect
   * @param {{x: number, y: number, width: number, height: number}} r1 - First rectangle
   * @param {{x: number, y: number, width: number, height: number}} r2 - Second rectangle
   * @returns {boolean} True if the rectangles intersect
   */
  rectsIntersect(r1, r2) {
    return !(
      r1.x + r1.width < r2.x ||
      r2.x + r2.width < r1.x ||
      r1.y + r1.height < r2.y ||
      r2.y + r2.height < r1.y
    );
  },

  /**
   * Get bounding box of multiple elements
   * @param {Array<{getBounds: () => {x: number, y: number, width: number, height: number}}>} elements - Elements with getBounds method
   * @returns {{x: number, y: number, width: number, height: number}|null} The bounding box or null if empty
   */
  getBoundingBox(elements) {
    if (elements.length === 0) return null;

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const el of elements) {
      const bounds = el.getBounds();
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  },

  /**
   * Convert screen coordinates to canvas coordinates
   * @param {number} screenX - Screen X coordinate
   * @param {number} screenY - Screen Y coordinate
   * @param {{offsetX: number, offsetY: number, scale: number}} viewport - Viewport transform
   * @returns {{x: number, y: number}} Canvas coordinates
   */
  screenToCanvas(screenX, screenY, viewport) {
    return {
      x: (screenX - viewport.offsetX) / viewport.scale,
      y: (screenY - viewport.offsetY) / viewport.scale,
    };
  },

  /**
   * Convert canvas coordinates to screen coordinates
   * @param {number} canvasX - Canvas X coordinate
   * @param {number} canvasY - Canvas Y coordinate
   * @param {{offsetX: number, offsetY: number, scale: number}} viewport - Viewport transform
   * @returns {{x: number, y: number}} Screen coordinates
   */
  canvasToScreen(canvasX, canvasY, viewport) {
    return {
      x: canvasX * viewport.scale + viewport.offsetX,
      y: canvasY * viewport.scale + viewport.offsetY,
    };
  },

  /**
   * Format file size
   * @param {number} bytes - Size in bytes
   * @returns {string} Human-readable file size string
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  /**
   * Format date
   * @param {number|string|Date} date - Date value to format
   * @returns {string} Formatted date string
   */
  formatDate(date) {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(date));
  },

  /**
   * Format timestamp for display (e.g., "Jan 28, 2026 at 3:45 PM")
   * @param {number} timestamp - Unix timestamp in milliseconds
   * @returns {string} Formatted timestamp string
   */
  formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const dateStr = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
    const timeStr = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
    return `${dateStr} at ${timeStr}`;
  },

  /**
   * Parse color to RGB
   * @param {string} color - CSS color string
   * @returns {{r: number, g: number, b: number, a: number}} RGBA components
   */
  parseColor(color) {
    if (typeof document === 'undefined') return html;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  },

  /**
   * Convert RGB to hex
   * @param {number} r - Red (0-255)
   * @param {number} g - Green (0-255)
   * @param {number} b - Blue (0-255)
   * @returns {string} Hex color string
   */
  rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  },

  /**
   * Get contrasting text color (black or white)
   * @param {string} hexColor - Hex color string
   * @returns {string} '#000000' or '#ffffff'
   */
  getContrastColor(hexColor) {
    const { r, g, b } = this.parseColor(hexColor);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#ffffff';
  },

  /**
   * Load image from URL or file
   * @param {string} src - Image source URL or data URI
   * @returns {Promise<HTMLImageElement>} The loaded image element
   */
  loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  },

  /**
   * Read file as data URL
   * @param {File} file - File to read
   * @returns {Promise<string>} Data URL string
   */
  readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  /**
   * Read file as text
   * @param {File} file - File to read
   * @returns {Promise<string>} File contents as text
   */
  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  },

  /**
   * Download data as file
   * @param {string} data - File content
   * @param {string} filename - Download filename
   * @param {string} [type='application/json'] - MIME type
   * @returns {void}
   */
  downloadFile(data, filename, type = 'application/json') {
    if (typeof document === 'undefined') return;
    const blob = new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Show toast notification
   * @param {string} message - Toast message text
   * @param {string} [type='info'] - Toast type ('info', 'error', 'success')
   * @param {number} [duration=3000] - Duration in milliseconds
   * @returns {void}
   */
  showToast(message, type = 'info', duration = 3000) {
    if (typeof document === 'undefined') {
      console.debug(`Toast (${type}): ${message}`);
      return;
    }
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      container.setAttribute('aria-live', 'polite');
      container.setAttribute('role', 'status');
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideIn 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  /**
   * Fetch link preview data
   * @param {string} url - URL to fetch preview for
   * @returns {Promise<{url: string, title: string, description: string, image: string|null, favicon: string|null}>} Link preview data
   */
  async fetchLinkPreview(url) {
    // In a real extension, you'd use a background script or proxy service
    // For now, we'll create a basic preview from the URL
    try {
      const urlObj = new URL(url);
      return {
        url: url,
        title: urlObj.hostname,
        description: url,
        image: null,
        favicon: `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`,
      };
    } catch (e) {
      return {
        url: url,
        title: 'Link',
        description: url,
        image: null,
        favicon: null,
      };
    }
  },

  /**
   * Smooth bezier curve through points
   * @param {Array<{x: number, y: number}>} points - Array of points
   * @returns {string} SVG path string
   */
  getSmoothPath(points) {
    if (points.length < 2) return '';

    let path = `M ${points[0].x} ${points[0].y}`;

    if (points.length === 2) {
      path += ` L ${points[1].x} ${points[1].y}`;
      return path;
    }

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? i : i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2 >= points.length ? i + 1 : i + 2];

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }

    return path;
  },

  /**
   * Get rotation angle from two points
   * @param {number} cx - Center X
   * @param {number} cy - Center Y
   * @param {number} px - Point X
   * @param {number} py - Point Y
   * @returns {number} Angle in radians
   */
  getAngle(cx, cy, px, py) {
    return Math.atan2(py - cy, px - cx);
  },

  /**
   * Rotate point around center
   * @param {number} px - Point X
   * @param {number} py - Point Y
   * @param {number} cx - Center X
   * @param {number} cy - Center Y
   * @param {number} angle - Rotation angle in radians
   * @returns {{x: number, y: number}} Rotated point
   */
  rotatePoint(px, py, cx, cy, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = px - cx;
    const dy = py - cy;
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos,
    };
  },

  /**
   * Fuzzy search - matches partial words, handles typos, and ranks results
   * @param {string} query - Search query
   * @param {string} text - Text to match against
   * @returns {number} Match score (0 = no match, higher = better match)
   */
  fuzzyMatch(query, text) {
    if (!query || !text) return 0;

    query = query.toLowerCase().trim();
    text = text.toLowerCase();

    // Exact match gets highest score
    if (text === query) return 100;

    // Contains exact query
    if (text.includes(query)) {
      // Bonus for match at start
      if (text.startsWith(query)) return 90;
      // Bonus for match at word boundary
      if (text.includes(' ' + query) || text.includes('-' + query)) return 85;
      return 80;
    }

    // Check if all query characters appear in order (fuzzy)
    let queryIndex = 0;
    let consecutiveMatches = 0;
    let maxConsecutive = 0;
    let totalMatches = 0;
    let lastMatchIndex = -2;

    for (let i = 0; i < text.length && queryIndex < query.length; i++) {
      if (text[i] === query[queryIndex]) {
        totalMatches++;

        // Track consecutive matches
        if (i === lastMatchIndex + 1) {
          consecutiveMatches++;
          maxConsecutive = Math.max(maxConsecutive, consecutiveMatches);
        } else {
          consecutiveMatches = 1;
        }

        lastMatchIndex = i;
        queryIndex++;
      }
    }

    // All characters must be found in order
    if (queryIndex < query.length) return 0;

    // Calculate score based on:
    // - Percentage of query matched
    // - Consecutive character bonus
    // - Length similarity bonus
    const matchRatio = totalMatches / query.length;
    const consecutiveBonus = (maxConsecutive / query.length) * 20;
    const lengthBonus = Math.max(0, 10 - Math.abs(text.length - query.length));

    return Math.min(70, 30 + (matchRatio * 20) + consecutiveBonus + lengthBonus);
  },

  /**
   * Search notes with fuzzy matching
   * @param {Array<{name?: string}>} notes - Array of note objects
   * @param {string} query - Search query
   * @returns {Array<{name?: string}>} Notes sorted by relevance score
   */
  fuzzySearchNotes(notes, query) {
    if (!query || !query.trim()) return notes;

    const scored = notes.map(note => {
      const name = note.name || 'Untitled';
      const score = this.fuzzyMatch(query, name);
      return { note, score };
    });

    return scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.note);
  },

  /**
   * Escape HTML special characters to prevent XSS
   */
  escapeHtml(text) {
    const htmlEntities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, char => htmlEntities[char]);
  },

  /**
   * Parse markdown tables into HTML
   * @param {string} text - Text containing potential tables
   * @returns {string} - Text with tables converted to HTML
   */
  parseMarkdownTables(text) {
    // Match table pattern: header row, separator row, and data rows
    const tableRegex = /^(\|.+\|)\n(\|[-:\s|]+\|)\n((?:\|.+\|\n?)+)/gm;

    return text.replace(tableRegex, (match, headerRow, separatorRow, bodyRows) => {
      // Parse alignment from separator row
      const alignments = separatorRow
        .split('|')
        .filter(cell => cell.trim())
        .map(cell => {
          const trimmed = cell.trim();
          if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
          if (trimmed.endsWith(':')) return 'right';
          return 'left';
        });

      // Parse header cells
      const headerCells = headerRow
        .split('|')
        .filter(cell => cell.trim() !== '')
        .map((cell, i) => {
          const align = alignments[i] || 'left';
          return `<th style="text-align: ${align}">${cell.trim()}</th>`;
        })
        .join('');

      // Parse body rows
      const bodyRowsHtml = bodyRows
        .trim()
        .split('\n')
        .map(row => {
          const cells = row
            .split('|')
            .filter(cell => cell.trim() !== '')
            .map((cell, i) => {
              const align = alignments[i] || 'left';
              return `<td style="text-align: ${align}">${cell.trim()}</td>`;
            })
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');

      return `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRowsHtml}</tbody></table>`;
    });
  },

  /**
   * Extract wikilinks from text [[Note Name]]
   * @param {string} text - Text to parse
   * @returns {Array<string>} - Array of note names
   */
  extractWikiLinks(text) {
    if (!text) return [];
    const regex = /\[\[([^\]]+)\]\]/g;
    const links = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      links.push(match[1].trim());
    }
    return [...new Set(links)]; // Return unique links
  },

  /**
   * Convert wikilinks to HTML links
   * @param {string} html - HTML content to process
   * @returns {string} - HTML with wikilinks converted to <a> tags
   */
  convertWikiLinksToHtml(html) {
    if (!html) return '';
    return html.replace(/\[\[([^\]]+)\]\]/g, (match, noteName) => {
      const name = noteName.trim();
      return `<a href="#" class="wiki-link" data-note-name="${this.escapeHtml(name)}">[[${this.escapeHtml(name)}]]</a>`;
    });
  },

  /**
   * Parse markdown text to HTML
   * Supports: headers, bold, italic, code blocks, inline code, lists, blockquotes, links, hr, tables, paragraphs, and wikilinks
   * @param {string} text - Markdown text to parse
   * @returns {string} - HTML string
   */
  parseMarkdown(text) {
    if (!text) return '';

    // Store code blocks temporarily to prevent processing their content
    const codeBlocks = [];
    const inlineCodes = [];

    // Extract fenced code blocks first (```code```)
    let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
      const index = codeBlocks.length;
      const escapedCode = this.escapeHtml(code.trim());
      const langClass = lang ? ` class="language-${this.escapeHtml(lang)}"` : '';
      codeBlocks.push(`<pre><code${langClass}>${escapedCode}</code></pre>`);
      return `\x00CODEBLOCK${index}\x00`;
    });

    // Extract inline code (`code`)
    result = result.replace(/`([^`\n]+)`/g, (match, code) => {
      const index = inlineCodes.length;
      inlineCodes.push(`<code>${this.escapeHtml(code)}</code>`);
      return `\x00INLINECODE${index}\x00`;
    });

    // Wikilinks [[Note]]
    result = this.convertWikiLinksToHtml(result);

    // Process block-level elements

    // Headers (# ## ###)
    result = result.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    result = result.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    result = result.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Horizontal rules (--- or ***)
    result = result.replace(/^(-{3,}|\*{3,})$/gm, '<hr>');

    // Blockquotes (> quote)
    result = result.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge consecutive blockquotes
    result = result.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // Tables
    result = this.parseMarkdownTables(result);

    // Unordered lists (- item or * item)
    result = result.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> items in <ul> (for unordered)
    result = result.replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => {
      // Check if this is part of an ordered list by looking at context
      return `<ul>${match}</ul>`;
    });

    // Ordered lists (1. item, 2. item, etc.)
    result = result.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
    // Wrap consecutive <oli> items in <ol>
    result = result.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (match) => {
      return `<ol>${match.replace(/<\/?oli>/g, (tag) => tag.replace('oli', 'li'))}</ol>`;
    });

    // Clean up nested list issues
    result = result.replace(/<\/ul>\n<ul>/g, '\n');
    result = result.replace(/<\/ol>\n<ol>/g, '\n');

    // Links [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Bold (**text** or __text__)
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // Italic (*text* or _text_) - be careful not to match inside words
    result = result.replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<em>$1</em>');
    result = result.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, '<em>$1</em>');

    // Paragraphs - wrap text blocks separated by double newlines
    // Split by double newlines, wrap non-block elements in <p>
    const blockTags = ['<h1>', '<h2>', '<h3>', '<ul>', '<ol>', '<blockquote>', '<pre>', '<hr>', '<table>', '\x00CODEBLOCK'];
    const paragraphs = result.split(/\n\n+/);
    result = paragraphs.map(para => {
      para = para.trim();
      if (!para) return '';
      // Check if paragraph starts with a block-level element
      const isBlock = blockTags.some(tag => para.startsWith(tag));
      if (isBlock) return para;
      // Wrap in paragraph, convert single newlines to <br>
      return `<p>${para.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');

    // Restore code blocks
    codeBlocks.forEach((block, index) => {
      result = result.replace(`\x00CODEBLOCK${index}\x00`, block);
    });

    // Restore inline code
    inlineCodes.forEach((code, index) => {
      result = result.replace(`\x00INLINECODE${index}\x00`, code);
    });

    // Clean up any remaining paragraph issues around block elements
    result = result.replace(/<p>(<(?:h[1-3]|ul|ol|blockquote|pre|hr)[^>]*>)/g, '$1');
    result = result.replace(/(<\/(?:h[1-3]|ul|ol|blockquote|pre|hr)>)<\/p>/g, '$1');

    return result;
  },

  /**
   * Set up focus trapping within a modal element.
   * Returns a cleanup function to remove the trap.
   * @param {HTMLElement} modal - The modal container element
   * @returns {function(): void} Cleanup function to remove the focus trap
   */
  trapFocus(modal) {
    const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function onKeyDown(e) {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    modal.addEventListener('keydown', onKeyDown);
    return () => modal.removeEventListener('keydown', onKeyDown);
  },
};

// Make Utils globally available
var globalObject = typeof window !== 'undefined' ? window : self;
globalObject.Utils = Utils;
