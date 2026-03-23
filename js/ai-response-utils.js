(function (global) {
  /**
   * Escape HTML special characters.
   * @param {string} text - Raw text
   * @returns {string} Escaped HTML string
   */
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Convert inline markdown formatting to HTML.
   * @param {string} text - Markdown text
   * @returns {string} HTML string
   */
  function markdownInlineToHtml(text) {
    let result = escapeHtml(text || '');

    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    result = result.replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<em>$1</em>');
    result = result.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, '<em>$1</em>');
    result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    result = result.replace(/\[\[([^\]]+)\]\]/g, '<a href="#" class="wiki-link" data-note-name="$1">$1</a>');
    result = result.replace(/\n/g, '<br>');

    return result;
  }

  /**
   * Convert HTML content to Markdown inline formatting.
   * Regex-based for use in Node.js (no DOM) and browser contexts.
   * @param {string} html - HTML string
   * @returns {string} Markdown text
   */
  function htmlToMarkdown(html) {
    if (!html) return '';
    return html
      .replace(/<a\s+[^>]*class="wiki-link"[^>]*data-note-name="([^"]*)"[^>]*>.*?<\/a>/gi, '[[$1]]')
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<i>(.*?)<\/i>/gi, '*$1*')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<del>(.*?)<\/del>/gi, '~~$1~~')
      .replace(/<s>(.*?)<\/s>/gi, '~~$1~~')
      .replace(/<strike>(.*?)<\/strike>/gi, '~~$1~~')
      .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  }

  /**
   * Convert a block object to Markdown text.
   * @param {Object} block - Block object with type, content, and type-specific properties
   * @returns {string} Markdown representation
   */
  function blockToMarkdown(block) {
    const content = htmlToMarkdown(block.content || '');

    switch (block.type) {
      case 'h1': return `# ${content}\n\n`;
      case 'h2': return `## ${content}\n\n`;
      case 'h3': return `### ${content}\n\n`;
      case 'bullet': return `- ${content}\n`;
      case 'numbered': return `1. ${content}\n`;
      case 'todo': return `- [${block.checked ? 'x' : ' '}] ${content}\n`;
      case 'quote': return `> ${content}\n\n`;
      case 'code': return `\`\`\`\n${block.content || ''}\n\`\`\`\n\n`;
      case 'divider': return `---\n\n`;
      case 'callout': return `> ${block.calloutIcon || '💡'} ${content}\n\n`;
      case 'toggle': return `<details>\n<summary>${content}</summary>\n${htmlToMarkdown(block.children || '')}\n</details>\n\n`;
      case 'image': return (block.imageUrl || block.src) ? `![${block.caption || content}](${block.imageUrl || block.src})\n\n` : '';
      case 'bookmark': return block.url ? `[${block.title || block.url}](${block.url})\n\n` : '';
      case 'equation': return `$$\n${block.equation || ''}\n$$\n\n`;
      case 'table':
        if (block.tableData && block.tableData.length > 0) {
          let md = '';
          block.tableData.forEach((row, i) => {
            md += '| ' + row.join(' | ') + ' |\n';
            if (i === 0) {
              md += '| ' + row.map(() => '---').join(' | ') + ' |\n';
            }
          });
          return md + '\n';
        }
        return '';
      default: return content ? `${content}\n\n` : '\n';
    }
  }

  /**
   * Parse markdown text into an array of block objects.
   * @param {string} text - Markdown text
   * @returns {Array<{type: string, content: string, checked?: boolean, tableData?: Array<Array<string>>, rows?: number, cols?: number, equation?: string, caption?: string, src?: string, imageUrl?: string, title?: string, url?: string}>} Parsed blocks
   */
  function markdownToBlocks(text) {
    const blocks = [];
    const lines = String(text || '').split('\n');
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      if (line.trim() === '') {
        index += 1;
        continue;
      }

      if (line.trim().startsWith('```')) {
        const codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith('```')) {
          codeLines.push(lines[index]);
          index += 1;
        }
        index += 1;
        blocks.push({ type: 'code', content: escapeHtml(codeLines.join('\n')) });
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        blocks.push({ type: 'divider', content: '' });
        index += 1;
        continue;
      }

      const h1Match = line.match(/^# (.+)$/);
      if (h1Match) {
        blocks.push({ type: 'h1', content: markdownInlineToHtml(h1Match[1]) });
        index += 1;
        continue;
      }

      const h2Match = line.match(/^## (.+)$/);
      if (h2Match) {
        blocks.push({ type: 'h2', content: markdownInlineToHtml(h2Match[1]) });
        index += 1;
        continue;
      }

      const h3Match = line.match(/^### (.+)$/);
      if (h3Match) {
        blocks.push({ type: 'h3', content: markdownInlineToHtml(h3Match[1]) });
        index += 1;
        continue;
      }

      const todoMatch = line.match(/^- \[([ xX])\] (.*)$/);
      if (todoMatch) {
        blocks.push({
          type: 'todo',
          content: markdownInlineToHtml(todoMatch[2]),
          checked: todoMatch[1].toLowerCase() === 'x',
        });
        index += 1;
        continue;
      }

      const bulletMatch = line.match(/^[\-\*] (.+)$/);
      if (bulletMatch) {
        blocks.push({ type: 'bullet', content: markdownInlineToHtml(bulletMatch[1]) });
        index += 1;
        continue;
      }

      const numberedMatch = line.match(/^\d+\. (.+)$/);
      if (numberedMatch) {
        blocks.push({ type: 'numbered', content: markdownInlineToHtml(numberedMatch[1]) });
        index += 1;
        continue;
      }

      const quoteMatch = line.match(/^> (.+)$/);
      if (quoteMatch) {
        const quoteLines = [quoteMatch[1]];
        index += 1;
        while (index < lines.length && /^> (.+)$/.test(lines[index])) {
          quoteLines.push(lines[index].match(/^> (.+)$/)[1]);
          index += 1;
        }
        blocks.push({ type: 'quote', content: markdownInlineToHtml(quoteLines.join('\n')) });
        continue;
      }

      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const tableRows = [];

        while (
          index < lines.length &&
          lines[index].trim().startsWith('|') &&
          lines[index].trim().endsWith('|')
        ) {
          const row = lines[index].trim();
          if (/^\|[\s\-:]+(\|[\s\-:]+)*\|$/.test(row)) {
            index += 1;
            continue;
          }

          const cells = row.slice(1, -1).split('|').map(cell => cell.trim());
          tableRows.push(cells);
          index += 1;
        }

        if (tableRows.length > 0) {
          blocks.push({
            type: 'table',
            content: '',
            tableData: tableRows,
            rows: tableRows.length,
            cols: tableRows[0].length,
          });
        }

        continue;
      }

      if (line.trim().startsWith('$$')) {
        let equation = line.trim().slice(2);

        if (equation.endsWith('$$')) {
          equation = equation.slice(0, -2);
          index += 1;
        } else {
          index += 1;
          const equationLines = [equation];

          while (index < lines.length && !lines[index].trim().endsWith('$$')) {
            equationLines.push(lines[index]);
            index += 1;
          }

          if (index < lines.length) {
            equationLines.push(lines[index].trim().slice(0, -2));
            index += 1;
          }

          equation = equationLines.join('\n');
        }

        blocks.push({ type: 'equation', content: '', equation: equation.trim() });
        continue;
      }

      const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imageMatch) {
        blocks.push({
          type: 'image',
          content: '',
          caption: imageMatch[1],
          src: imageMatch[2],
          imageUrl: imageMatch[2],
        });
        index += 1;
        continue;
      }

      const linkMatch = line.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        blocks.push({
          type: 'bookmark',
          content: '',
          title: linkMatch[1],
          url: linkMatch[2],
        });
        index += 1;
        continue;
      }

      const paraLines = [line];
      index += 1;
      while (
        index < lines.length &&
        lines[index].trim() !== '' &&
        !/^#{1,3} /.test(lines[index]) &&
        !/^[\-\*] /.test(lines[index]) &&
        !/^\d+\. /.test(lines[index]) &&
        !/^> /.test(lines[index]) &&
        !lines[index].trim().startsWith('```') &&
        !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[index].trim())
      ) {
        paraLines.push(lines[index]);
        index += 1;
      }

      blocks.push({ type: 'text', content: markdownInlineToHtml(paraLines.join('\n')) });
    }

    return blocks;
  }

  /**
   * Strip HTML tags from text.
   * @param {string} text - HTML string
   * @returns {string} Plain text
   */
  function stripHtml(text) {
    return String(text || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Parse an AI response into block objects, falling back to a single text block.
   * @param {string} text - AI response text (markdown)
   * @returns {Array<Object>} Parsed block objects
   */
  function parseAIResponseToBlocks(text) {
    const parsedBlocks = markdownToBlocks(text);

    if (parsedBlocks.length === 0) {
      return [{ type: 'text', content: String(text || '').trim() }];
    }

    return parsedBlocks.map(block => {
      if (typeof block.content === 'string') {
        return { ...block, content: stripHtml(block.content) ? block.content : block.content };
      }
      return { ...block };
    });
  }

  /**
   * Build a preview summary for AI-generated blocks before insertion.
   * @param {Array<Object>} blocks - Block objects to preview
   * @returns {{totalBlocks: number, counts: Array<{type: string, count: number}>, summary: string, items: Array<{type: string, content: string, checked: boolean}>}} Preview data
   */
  function buildAIInsertPreview(blocks) {
    const items = Array.isArray(blocks) ? blocks : [];
    const countMap = new Map();

    items.forEach(item => {
      const type = item.type || 'text';
      countMap.set(type, (countMap.get(type) || 0) + 1);
    });

    const summary = items
      .map(item => stripHtml(item.content || item.title || item.caption || ''))
      .filter(Boolean)
      .join(' ')
      .trim()
      .slice(0, 220);

    return {
      totalBlocks: items.length,
      counts: Array.from(countMap.entries()).map(([type, count]) => ({ type, count })),
      summary,
      items: items.map(item => ({
        type: item.type || 'text',
        content: stripHtml(item.content || item.title || item.caption || ''),
        checked: Boolean(item.checked),
      })),
    };
  }

  const api = {
    blockToMarkdown,
    buildAIInsertPreview,
    htmlToMarkdown,
    markdownInlineToHtml,
    markdownToBlocks,
    parseAIResponseToBlocks,
    stripHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.AIResponseUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
