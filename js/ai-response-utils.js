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
   * The first index of `char` at or after a position, for positions that never go back: the
   * last answer is reused while it's still ahead, so a pass over the text scans it once
   * @param {string} text
   * @param {string} char
   * @returns {(from: number) => number}
   */
  function nextOf(text, char) {
    let from = Infinity;
    let found = -1;
    return at => {
      if (at >= from && (found === -1 || found >= at)) return found;
      from = at;
      found = text.indexOf(char, at);
      return found;
    };
  }

  /**
   * `/\[([^\]]+)\]\(([^)]+)\)/g` replaced by `<a href="$2">$1</a>`, in one pass: from a `[`,
   * the text runs to the first `]`, which `(` must follow, and the address to the first `)`
   * @param {string} text
   * @returns {string}
   */
  function replaceMarkdownLinks(text) {
    const nextClose = nextOf(text, ']');
    const nextParen = nextOf(text, ')');
    let out = '';
    let from = 0;
    for (let at = text.indexOf('['); at !== -1; at = text.indexOf('[', at + 1)) {
      if (at < from) continue;
      const close = nextClose(at + 1);
      if (close === -1) break;
      if (close === at + 1 || text[close + 1] !== '(') continue;
      const paren = nextParen(close + 2);
      if (paren === -1) break;
      if (paren === close + 2) continue;
      out += `${text.slice(from, at)}<a href="${text.slice(close + 2, paren)}">${text.slice(at + 1, close)}</a>`;
      from = paren + 1;
      at = paren;
    }
    return out + text.slice(from);
  }

  /**
   * `/\[\[([^\]]+)\]\]/g` replaced by a wiki link, in one pass: from a `[[`, the name runs to
   * the first `]`, which another `]` must follow
   * @param {string} text
   * @returns {string}
   */
  function replaceWikiLinks(text) {
    const nextClose = nextOf(text, ']');
    let out = '';
    let from = 0;
    for (let at = text.indexOf('[['); at !== -1; at = text.indexOf('[[', at + 1)) {
      if (at < from) continue;
      const close = nextClose(at + 2);
      if (close === -1) break;
      if (close === at + 2 || text[close + 1] !== ']') continue;
      const name = text.slice(at + 2, close);
      out += `${text.slice(from, at)}<a href="#" class="wiki-link" data-note-name="${name}">${name}</a>`;
      from = close + 2;
      at = close + 1;
    }
    return out + text.slice(from);
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
    result = replaceMarkdownLinks(result);
    result = replaceWikiLinks(result);
    result = result.replace(/\n/g, '<br>');

    return result;
  }

  /**
   * `<[^>]*>` (or `<[^>]+>`, with `nonEmpty`) replaced by `by`: each `<` through the first `>`
   * after it, when there's one, in one pass
   * @param {string} text
   * @param {string} by
   * @param {boolean} nonEmpty
   */
  function replaceTags(text, by, nonEmpty) {
    let out = '';
    let from = 0;
    let lt = text.indexOf('<');
    while (lt !== -1) {
      const gt = text.indexOf('>', lt + 1);
      if (gt === -1) break;
      if (nonEmpty && gt === lt + 1) {
        // `<>` isn't a tag; the next `<` may start one
        lt = text.indexOf('<', lt + 1);
        continue;
      }
      out += text.slice(from, lt) + by;
      from = gt + 1;
      lt = text.indexOf('<', from);
    }
    return out + text.slice(from);
  }


  /** What `.` doesn't match: the line terminators */
  const LINE_END = /[\n\r\u2028\u2029]/g;

  /** @param {string} c */
  const isRegexSpace = c => /\s/.test(c);

  /**
   * `text` with ASCII letters lowercased and nothing else changed, so indices stay the same: how
   * a case-insensitive expression without the `u` flag compares these ASCII patterns
   * @param {string} text
   */
  const asciiLower = text => text.replace(/[A-Z]+/g, upper => upper.toLowerCase());

  /**
   * A search for the first match at or after a position, for positions that never go back: the
   * last answer is reused while it's still ahead
   * @param {(from: number) => number} find - the first index at or after `from`, or -1
   * @returns {(from: number) => number}
   */
  function forward(find) {
    let from = Number.POSITIVE_INFINITY;
    let found = -1;
    return at => {
      if (at >= from && (found === -1 || found >= at)) return found;
      from = at;
      found = find(at);
      return found;
    };
  }

  /**
   * The first line terminator at or after a position, or the text's end
   * @param {string} text
   */
  function lineEnds(text) {
    return forward(at => {
      LINE_END.lastIndex = at;
      const match = LINE_END.exec(text);
      return match ? match.index : text.length;
    });
  }

  /**
   * `/<tag>(.*?)<\/tag>/gi` replaced by `before` + the content + `after`: each opening tag with
   * the first closing tag after it on its line
   * @param {string} text
   * @param {string} tag
   * @param {string} before
   * @param {string} after
   */
  function replacePairs(text, tag, before, after) {
    const lower = asciiLower(text);
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const nextClose = forward(at => lower.indexOf(close, at));
    const lineEnd = lineEnds(text);
    let out = '';
    let from = 0;
    let at = lower.indexOf(open);
    while (at !== -1) {
      const inside = at + open.length;
      const end = nextClose(inside);
      const line = lineEnd(inside);
      if (end !== -1 && end < line) {
        out += text.slice(from, at) + before + text.slice(inside, end) + after;
        from = end + close.length;
        at = lower.indexOf(open, from);
      } else {
        // No opening tag later on this line has a closing one either
        at = line < text.length ? lower.indexOf(open, line + 1) : -1;
      }
    }
    return out + text.slice(from);
  }

  /**
   * Per position, the first index at or after it where `needle` starts, or -1
   * @param {string} lower
   * @param {string} needle
   */
  function nextIndex(lower, needle) {
    const next = new Int32Array(lower.length + 2).fill(-1);
    const starts = [];
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) starts.push(at);
    let k = starts.length - 1;
    for (let i = lower.length; i >= 0; i--) {
      while (k >= 0 && starts[k] >= i) k--;
      next[i] = k + 1 < starts.length ? starts[k + 1] : -1;
    }
    return next;
  }

  /**
   * `/<a\s+[^>]*class="wiki-link"[^>]*data-note-name="([^"]*)"[^>]*>.*?<\/a>/gi` replaced by
   * `[[$1]]`. From an `<a` and white space, the tag up to its first `>` must hold the class, and
   * after it a `data-note-name="`; the name runs to the next quote, then the tag to the next `>`,
   * then the link to the first `</a>` on that line. Of the names that complete, the expression's
   * backtracking takes the last one in the tag, which a table of the last completing name at or
   * before each position gives at once.
   * @param {string} text
   */
  function replaceWikiLinkAnchors(text) {
    const lower = asciiLower(text);
    const CLASS = 'class="wiki-link"';
    const NAME = 'data-note-name="';
    const nextGt = nextIndex(lower, '>');
    const nextQuote = nextIndex(lower, '"');
    const nextClass = nextIndex(lower, CLASS);
    const nextName = nextIndex(lower, NAME);
    const nextCloseA = nextIndex(lower, '</a>');
    const nextLineEnd = new Int32Array(text.length + 2).fill(-1);
    for (let i = text.length - 1; i >= 0; i--) {
      const c = text[i];
      nextLineEnd[i] = c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029' ? i : nextLineEnd[i + 1];
    }

    /**
     * Where the link that a name at `d` starts ends, and the name's closing quote, or null
     * @param {number} d
     */
    const completion = d => {
      const quote = nextQuote[d + NAME.length];
      if (quote === -1) return null;
      const gt = nextGt[quote + 1];
      if (gt === -1) return null;
      const closeA = nextCloseA[gt + 1];
      if (closeA === -1) return null;
      const lineEnd = nextLineEnd[gt + 1];
      if (lineEnd !== -1 && lineEnd < closeA) return null;
      return { quote, end: closeA + 4 };
    };

    // Per position, the last name at or before it whose link completes
    const lastName = new Int32Array(text.length + 1).fill(-1);
    for (let i = 0; i <= text.length; i++) {
      const here = nextName[i] === i && completion(i) !== null ? i : -1;
      lastName[i] = here !== -1 ? here : i > 0 ? lastName[i - 1] : -1;
    }

    let out = '';
    let from = 0;
    for (let st = lower.indexOf('<a', from); st !== -1; st = lower.indexOf('<a', st + 1)) {
      if (st < from) continue;
      if (st + 2 >= text.length || !isRegexSpace(text[st + 2])) continue;
      const tagEnd = nextGt[st];
      if (tagEnd === -1) break;
      const classAt = nextClass[st + 3];
      if (classAt === -1 || classAt + CLASS.length > tagEnd) continue;
      const latest = tagEnd - NAME.length;
      const d = latest >= 0 ? lastName[latest] : -1;
      if (d === -1 || d < classAt + CLASS.length) continue;
      const done = /** @type {{quote: number, end: number}} */ (completion(d));
      out += `${text.slice(from, st)}[[${text.slice(d + NAME.length, done.quote)}]]`;
      from = done.end;
      st = from - 1;
    }
    return out + text.slice(from);
  }

  /**
   * `/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi` replaced by `[$2]($1)`: an `<a`, white space,
   * then `href="` at once; the address runs to the next quote, the tag to the next `>`, and the
   * text to the first `</a>` on its line
   * @param {string} text
   */
  function replaceLinkAnchors(text) {
    const lower = asciiLower(text);
    const nextQuote = forward(at => lower.indexOf('"', at));
    const nextGt = forward(at => lower.indexOf('>', at));
    const nextCloseA = forward(at => lower.indexOf('</a>', at));
    const lineEnd = lineEnds(text);
    let out = '';
    let from = 0;
    for (let st = lower.indexOf('<a'); st !== -1; st = lower.indexOf('<a', st + 1)) {
      if (st < from) continue;
      let w = st + 2;
      while (w < text.length && isRegexSpace(text[w])) w++;
      if (w === st + 2 || !lower.startsWith('href="', w)) continue;
      const quote = nextQuote(w + 6);
      if (quote === -1) continue;
      const gt = nextGt(quote + 1);
      if (gt === -1) continue;
      const closeA = nextCloseA(gt + 1);
      if (closeA === -1 || lineEnd(gt + 1) < closeA) continue;
      out += `${text.slice(from, st)}[${text.slice(gt + 1, closeA)}](${text.slice(w + 6, quote)})`;
      from = closeA + 4;
      st = from - 1;
    }
    return out + text.slice(from);
  }

  /**
   * Convert HTML content to Markdown inline formatting, without a DOM (Node.js and browser contexts): as 1.4.1's regular-expression chain made it: wiki links, bold,
   * italic, code, strike-through, links and line breaks, then every other tag dropped. Its
   * input is a string, or anything falsy, which reads as empty; anything else throws, as
   * 1.4.x's `.replace` did.
   * @param {string} html
   * @returns {string}
   */
  function htmlToMarkdown(html) {
    if (!html) return '';
    // 1.4.x called the value's own replace first: a String object has one, and nothing else does
    if (typeof html !== 'string') /** @type {any} */ (html).replace(/(?:)/, '');
    let text = replaceWikiLinkAnchors(String(html));
    text = replacePairs(text, 'b', '**', '**');
    text = replacePairs(text, 'strong', '**', '**');
    text = replacePairs(text, 'i', '*', '*');
    text = replacePairs(text, 'em', '*', '*');
    text = replacePairs(text, 'code', '`', '`');
    text = replacePairs(text, 'del', '~~', '~~');
    text = replacePairs(text, 's', '~~', '~~');
    text = replacePairs(text, 'strike', '~~', '~~');
    text = replaceLinkAnchors(text);
    text = text.replace(/<br\s*\/?>/gi, '\n');
    return replaceTags(text, '', true);
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
    // Tags are dropped in one pass (replaceTags); the other steps are 1.4.1's expressions
    const breaks = String(text || '').replace(/<br\s*\/?>/gi, ' ');
    return replaceTags(breaks, ' ', false)
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
