/**
 * Block types and definitions for the editor
 */

const BlockTypes = {
  text: {
    name: 'Text',
    description: 'Plain text paragraph',
    icon: 'T',
    placeholder: typeof BlockPlaceholders !== 'undefined'
      ? BlockPlaceholders.getBlockPlaceholder('text', '')
      : '',
    shortcut: null,
  },
  h1: {
    name: 'Heading 1',
    description: 'Large section heading',
    icon: 'H1',
    placeholder: 'Heading 1',
    shortcut: '#',
  },
  h2: {
    name: 'Heading 2',
    description: 'Medium section heading',
    icon: 'H2',
    placeholder: 'Heading 2',
    shortcut: '##',
  },
  h3: {
    name: 'Heading 3',
    description: 'Small section heading',
    icon: 'H3',
    placeholder: 'Heading 3',
    shortcut: '###',
  },
  bullet: {
    name: 'Bulleted List',
    description: 'Simple bullet point',
    icon: '•',
    placeholder: 'List item',
    shortcut: '-',
  },
  numbered: {
    name: 'Numbered List',
    description: 'Numbered list item',
    icon: '1.',
    placeholder: 'List item',
    shortcut: '1.',
  },
  todo: {
    name: 'To-do',
    description: 'Checkbox item',
    icon: '☐',
    placeholder: 'To-do',
    shortcut: '[]',
  },
  toggle: {
    name: 'Toggle',
    description: 'Collapsible content',
    icon: '▶',
    placeholder: 'Toggle heading',
    shortcut: null,
  },
  quote: {
    name: 'Quote',
    description: 'Capture a quote',
    icon: '"',
    placeholder: 'Quote',
    shortcut: '>',
  },
  code: {
    name: 'Code',
    description: 'Code snippet',
    icon: '</>',
    placeholder: 'Code',
    shortcut: '```',
  },
  divider: {
    name: 'Divider',
    description: 'Visual separator',
    icon: '—',
    placeholder: null,
    shortcut: '---',
  },
  callout: {
    name: 'Callout',
    description: 'Highlighted info box',
    icon: '💡',
    placeholder: 'Callout',
    shortcut: null,
  },
  image: {
    name: 'Image',
    description: 'Upload or embed image',
    icon: '🖼',
    placeholder: null,
    shortcut: null,
  },
  table: {
    name: 'Table',
    description: 'Simple table',
    icon: '⊞',
    placeholder: null,
    shortcut: null,
  },
  bookmark: {
    name: 'Bookmark',
    description: 'Link bookmark with preview',
    icon: '🔗',
    placeholder: 'Paste URL...',
    shortcut: null,
  },
  video: {
    name: 'Video',
    description: 'Embed YouTube/Vimeo video',
    icon: '▶️',
    placeholder: 'Paste video URL...',
    shortcut: null,
  },
  file: {
    name: 'File',
    description: 'File attachment',
    icon: '📎',
    placeholder: null,
    shortcut: null,
  },
  equation: {
    name: 'Equation',
    description: 'Math equation',
    icon: '∑',
    placeholder: 'E = mc²',
    shortcut: null,
  },
};

/**
 * Block class representing a single block in the editor
 */
class Block {
  constructor(options = {}) {
    this.id = options.id || Utils.generateId();
    this.type = options.type || 'text';
    this.content = options.content || '';
    this.indentLevel = options.indentLevel || 0;
    this.checked = options.checked || false;
    this.imageUrl = options.imageUrl || null;
    this.calloutIcon = options.calloutIcon || '💡';
    // Toggle properties
    this.collapsed = options.collapsed !== undefined ? options.collapsed : true;
    this.children = options.children || '';
    // Table properties
    this.rows = options.rows || 2;
    this.cols = options.cols || 2;
    this.tableData = options.tableData || null;
    // Bookmark properties
    this.url = options.url || '';
    this.title = options.title || '';
    this.description = options.description || '';
    this.favicon = options.favicon || '';
    // Video properties
    this.videoUrl = options.videoUrl || '';
    // File properties
    this.fileName = options.fileName || '';
    this.fileSize = options.fileSize || 0;
    this.fileData = options.fileData || null;
    // Equation properties
    this.equation = options.equation || '';
    // Block metadata timestamps
    const now = Date.now();
    this.createdAt = options.createdAt || now;
    this.updatedAt = options.updatedAt || now;
  }

  /**
   * Mark block as updated (sets updatedAt to current time)
   */
  markUpdated() {
    this.updatedAt = Date.now();
  }

  /**
   * Get formatted metadata text for display
   */
  getMetadataText() {
    const formatTime = (ts) => {
      const date = new Date(ts);
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    };

    const created = formatTime(this.createdAt);

    // Show updated time only if different from created (more than 1 minute)
    if (this.updatedAt && Math.abs(this.updatedAt - this.createdAt) > 60000) {
      const updated = formatTime(this.updatedAt);
      return `Created ${created} · Updated ${updated}`;
    }

    return `Created ${created}`;
  }

  /**
   * Create DOM element for this block
   */
  createElement() {
    const block = document.createElement('div');
    block.className = 'block';
    block.dataset.id = this.id;
    block.dataset.type = this.type;
    block.style.setProperty('--block-indent-level', this.indentLevel || 0);
    block.draggable = true;

    // Add drag handle
    const handle = document.createElement('div');
    handle.className = 'block-handle';
    handle.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="6" r="1.5"/>
      <circle cx="15" cy="6" r="1.5"/>
      <circle cx="9" cy="12" r="1.5"/>
      <circle cx="15" cy="12" r="1.5"/>
      <circle cx="9" cy="18" r="1.5"/>
      <circle cx="15" cy="18" r="1.5"/>
    </svg>`;
    block.appendChild(handle);

    // Add block metadata timestamp (shown on hover)
    const metadata = document.createElement('div');
    metadata.className = 'block-metadata';
    metadata.textContent = this.getMetadataText();
    block.appendChild(metadata);

    // Type-specific content
    switch (this.type) {
      case 'divider':
        block.innerHTML += '<hr>';
        break;

      case 'image':
        const imgWrapper = document.createElement('div');
        imgWrapper.className = 'image-block-wrapper';

        if (this.imageUrl) {
          const img = document.createElement('img');
          // Use data-src for Intersection Observer lazy loading
          img.dataset.src = this.imageUrl;
          img.className = 'lazy-image';
          img.alt = 'Image';
          imgWrapper.appendChild(img);
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = 'image-placeholder';
          placeholder.textContent = 'Click to add image';
          placeholder.addEventListener('click', () => {
            const input = document.getElementById('image-input');
            if (input) {
              input.dataset.blockId = this.id;
              input.click();
            }
          });
          imgWrapper.appendChild(placeholder);
        }
        block.appendChild(imgWrapper);
        break;

      case 'toggle':
        const toggleArrow = document.createElement('div');
        toggleArrow.className = 'toggle-arrow';
        toggleArrow.textContent = '▶';
        block.appendChild(toggleArrow);

        if (!this.collapsed) {
          block.classList.add('expanded');
        }

        const toggleContent = document.createElement('div');
        toggleContent.className = 'block-content';
        toggleContent.contentEditable = true;
        toggleContent.spellcheck = true;
        toggleContent.dataset.placeholder = typeof BlockPlaceholders !== 'undefined'
          ? BlockPlaceholders.getBlockPlaceholder('toggle', BlockTypes.toggle.placeholder)
          : BlockTypes.toggle.placeholder;
        toggleContent.innerHTML = this.content;
        block.appendChild(toggleContent);

        const toggleChildren = document.createElement('div');
        toggleChildren.className = 'toggle-children';
        if (this.children) {
          const childContent = document.createElement('div');
          childContent.className = 'toggle-children-content';
          childContent.contentEditable = true;
          childContent.innerHTML = this.children;
          toggleChildren.appendChild(childContent);
        } else {
          const childPlaceholder = document.createElement('div');
          childPlaceholder.className = 'toggle-children-placeholder';
          childPlaceholder.contentEditable = true;
          childPlaceholder.dataset.placeholder = 'Empty toggle. Click to add content.';
          toggleChildren.appendChild(childPlaceholder);
        }
        block.appendChild(toggleChildren);
        break;

      case 'table':
        this.createTableElement(block);
        break;

      case 'bookmark':
        this.createBookmarkElement(block);
        break;

      case 'video':
        this.createVideoElement(block);
        break;

      case 'file':
        this.createFileElement(block);
        break;

      case 'equation':
        this.createEquationElement(block);
        break;

      case 'todo':
        const checkbox = document.createElement('div');
        checkbox.className = 'todo-checkbox';
        checkbox.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>`;
        block.appendChild(checkbox);
        if (this.checked) {
          block.classList.add('checked');
        }
      // Fall through to add content

      case 'callout':
        if (this.type === 'callout') {
          const icon = document.createElement('span');
          icon.className = 'callout-icon';
          icon.textContent = this.calloutIcon;
          block.appendChild(icon);
        }
      // Fall through to add content

      default:
        const content = document.createElement('div');
        content.className = 'block-content';
        content.contentEditable = true;
        content.spellcheck = true;
        content.dataset.placeholder = typeof BlockPlaceholders !== 'undefined'
          ? BlockPlaceholders.getBlockPlaceholder(this.type, BlockTypes[this.type]?.placeholder)
          : (BlockTypes[this.type]?.placeholder || '');
        content.innerHTML = this.content;
        block.appendChild(content);
    }

    // Add number for numbered lists
    if (this.type === 'numbered') {
      block.dataset.number = '1'; // Will be updated by editor
    }

    return block;
  }

  /**
   * Create table element
   */
  createTableElement(block) {
    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'table-wrapper';

    const table = document.createElement('table');

    // Initialize table data if not present
    if (!this.tableData) {
      this.tableData = [];
      for (let i = 0; i < this.rows; i++) {
        const row = [];
        for (let j = 0; j < this.cols; j++) {
          row.push(i === 0 ? `Header ${j + 1}` : '');
        }
        this.tableData.push(row);
      }
    }

    // Create table rows
    this.tableData.forEach((rowData, rowIndex) => {
      const tr = document.createElement('tr');
      rowData.forEach((cellData, colIndex) => {
        const cell = rowIndex === 0 ? document.createElement('th') : document.createElement('td');
        cell.contentEditable = true;
        cell.textContent = cellData;
        cell.dataset.row = rowIndex;
        cell.dataset.col = colIndex;
        tr.appendChild(cell);
      });
      table.appendChild(tr);
    });

    tableWrapper.appendChild(table);

    // Add table controls
    const controls = document.createElement('div');
    controls.className = 'table-controls';
    controls.innerHTML = `
      <button class="add-row-btn">+ Row</button>
      <button class="add-col-btn">+ Column</button>
      <button class="remove-row-btn">- Row</button>
      <button class="remove-col-btn">- Column</button>
    `;
    tableWrapper.appendChild(controls);

    block.appendChild(tableWrapper);
  }

  /**
   * Create bookmark element
   */
  createBookmarkElement(block) {
    if (this.url && this.title) {
      const card = document.createElement('a');
      card.className = 'bookmark-card';
      card.href = this.url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';

      const content = document.createElement('div');
      content.className = 'bookmark-content';

      const title = document.createElement('div');
      title.className = 'bookmark-title';
      title.textContent = this.title;
      content.appendChild(title);

      if (this.description) {
        const desc = document.createElement('div');
        desc.className = 'bookmark-description';
        desc.textContent = this.description;
        content.appendChild(desc);
      }

      const urlDiv = document.createElement('div');
      urlDiv.className = 'bookmark-url';
      if (this.favicon) {
        const favicon = document.createElement('img');
        favicon.className = 'bookmark-favicon';
        favicon.src = this.favicon;
        favicon.alt = '';
        urlDiv.appendChild(favicon);
      }
      const urlText = document.createElement('span');
      urlText.textContent = new URL(this.url).hostname;
      urlDiv.appendChild(urlText);
      content.appendChild(urlDiv);

      card.appendChild(content);
      block.appendChild(card);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'bookmark-placeholder';

      const input = document.createElement('input');
      input.type = 'url';
      input.className = 'bookmark-input';
      input.placeholder = 'Paste URL and press Enter...';
      input.value = this.url;
      placeholder.appendChild(input);

      block.appendChild(placeholder);
    }
  }

  /**
   * Create video element
   */
  createVideoElement(block) {
    if (this.videoUrl) {
      const embedUrl = this.getVideoEmbedUrl(this.videoUrl);
      if (embedUrl) {
        const container = document.createElement('div');
        container.className = 'video-container';

        const iframe = document.createElement('iframe');
        iframe.src = embedUrl;
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        iframe.allowFullscreen = true;
        container.appendChild(iframe);

        block.appendChild(container);
      } else {
        this.createVideoPlaceholder(block);
      }
    } else {
      this.createVideoPlaceholder(block);
    }
  }

  /**
   * Create video placeholder
   */
  createVideoPlaceholder(block) {
    const placeholder = document.createElement('div');
    placeholder.className = 'video-placeholder';

    const icon = document.createElement('div');
    icon.className = 'video-placeholder-icon';
    icon.textContent = '▶️';
    placeholder.appendChild(icon);

    const text = document.createElement('div');
    text.textContent = 'Embed a video';
    placeholder.appendChild(text);

    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'video-input';
    input.placeholder = 'Paste YouTube or Vimeo URL...';
    input.value = this.videoUrl;
    placeholder.appendChild(input);

    block.appendChild(placeholder);
  }

  /**
   * Get video embed URL from various video platforms
   */
  getVideoEmbedUrl(url) {
    if (!url) return null;

    // YouTube
    const youtubeMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (youtubeMatch) {
      return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
    }

    // Vimeo
    const vimeoMatch = url.match(/(?:vimeo\.com\/)(\d+)/);
    if (vimeoMatch) {
      return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    }

    return null;
  }

  /**
   * Create file element
   */
  createFileElement(block) {
    if (this.fileName && this.fileData) {
      const card = document.createElement('div');
      card.className = 'file-card';

      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.textContent = '📎';
      card.appendChild(icon);

      const info = document.createElement('div');
      info.className = 'file-info';

      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = this.fileName;
      info.appendChild(name);

      const size = document.createElement('div');
      size.className = 'file-size';
      size.textContent = this.formatFileSize(this.fileSize);
      info.appendChild(size);

      card.appendChild(info);

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'file-download';
      downloadBtn.textContent = 'Download';
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.downloadFile();
      });
      card.appendChild(downloadBtn);

      block.appendChild(card);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'file-placeholder';
      placeholder.textContent = 'Click to attach a file';
      placeholder.addEventListener('click', () => {
        document.getElementById('file-input').dataset.blockId = this.id;
        document.getElementById('file-input').click();
      });
      block.appendChild(placeholder);
    }
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Download the attached file
   */
  downloadFile() {
    if (!this.fileData || !this.fileName) return;

    const link = document.createElement('a');
    link.href = this.fileData;
    link.download = this.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * Create equation element
   */
  createEquationElement(block) {
    const container = document.createElement('div');
    container.className = 'equation-container';

    const display = document.createElement('div');
    display.className = 'equation-display';
    display.textContent = this.equation || '';
    if (!this.equation) {
      display.classList.add('equation-placeholder');
      display.textContent = 'Click to add equation';
    }
    container.appendChild(display);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'equation-input';
    input.placeholder = 'Type equation (e.g., E = mc²)';
    input.value = this.equation;
    input.style.display = 'none';
    container.appendChild(input);

    // Toggle between display and input
    display.addEventListener('click', () => {
      display.style.display = 'none';
      input.style.display = 'block';
      input.focus();
    });

    input.addEventListener('blur', () => {
      this.equation = input.value;
      display.textContent = this.equation || '';
      if (!this.equation) {
        display.classList.add('equation-placeholder');
        display.textContent = 'Click to add equation';
      } else {
        display.classList.remove('equation-placeholder');
      }
      display.style.display = 'block';
      input.style.display = 'none';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      }
    });

    block.appendChild(container);
  }

  /**
   * Serialize block for storage
   */
  serialize() {
    const data = {
      id: this.id,
      type: this.type,
      content: this.content,
      indentLevel: this.indentLevel,
      checked: this.checked,
      imageUrl: this.imageUrl,
      calloutIcon: this.calloutIcon,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };

    // Add type-specific properties
    if (this.type === 'toggle') {
      data.collapsed = this.collapsed;
      data.children = this.children;
    }

    if (this.type === 'table') {
      data.rows = this.rows;
      data.cols = this.cols;
      data.tableData = this.tableData;
    }

    if (this.type === 'bookmark') {
      data.url = this.url;
      data.title = this.title;
      data.description = this.description;
      data.favicon = this.favicon;
    }

    if (this.type === 'video') {
      data.videoUrl = this.videoUrl;
    }

    if (this.type === 'file') {
      data.fileName = this.fileName;
      data.fileSize = this.fileSize;
      data.fileData = this.fileData;
    }

    if (this.type === 'equation') {
      data.equation = this.equation;
    }

    return data;
  }

  /**
   * Create block from serialized data
   */
  static deserialize(data) {
    return new Block(data);
  }
}

// Make available globally
window.BlockTypes = BlockTypes;
window.Block = Block;
