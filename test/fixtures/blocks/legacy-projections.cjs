/**
 * The five plain-text extractors and three Markdown exporters as they were on `next`, copied
 * word for word, before #14 slice 1 moved them onto the block models' projections and codec:
 * each from `1c9bff7`, and the editor's `stripHtmlTags` as #105 (`caf9e105`) left it, parsing
 * in an inert document. The characterization tests run these against the projections: in Node
 * (test/blocks-characterization.test.js) on a document that reads text with html-text.js, and
 * in Chromium (e2e/block-projections.spec.js), where `doc` is the page's document.
 *
 * Nothing in the extension loads this file.
 */

'use strict';

// ============ SidebarUtils (js/sidebar-utils.js) ============

function sidebarStripHtml(value = '') {
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sidebarExtractBlockText(block = {}) {
  const stripHtml = sidebarStripHtml;
  if (!block || typeof block !== 'object') {
    return '';
  }

  if (block.type === 'toggle') {
    return [stripHtml(block.content), stripHtml(block.children)].filter(Boolean).join(' ');
  }

  if (block.type === 'bookmark') {
    return [block.title, block.description, block.url].filter(Boolean).join(' ');
  }

  if (block.type === 'equation') {
    return stripHtml(block.equation);
  }

  if (block.type === 'table' && Array.isArray(block.tableData)) {
    return block.tableData.flat().map(cell => stripHtml(cell)).filter(Boolean).join(' ');
  }

  if (block.type === 'file') {
    return stripHtml(block.fileName);
  }

  if (block.type === 'video') {
    return stripHtml(block.videoUrl);
  }

  return stripHtml(block.content);
}

// ============ The kernel's note domain (js/kernel/core/domain/note.js) ============

function kernelStripHtml(value = '') {
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function kernelBlockText(block) {
  const stripHtml = kernelStripHtml;
  if (block.type === 'toggle') return [stripHtml(block.content), stripHtml(block.children)].filter(Boolean).join(' ');
  if (block.type === 'bookmark') return [block.title, block.description, block.url].filter(Boolean).join(' ');
  if (block.type === 'equation') return stripHtml(block.equation);
  if (block.type === 'table' && Array.isArray(block.tableData)) {
    return block.tableData
      .flat()
      .map(cell => stripHtml(cell))
      .filter(Boolean)
      .join(' ');
  }
  if (block.type === 'file') return stripHtml(block.fileName);
  if (block.type === 'video') return stripHtml(block.videoUrl);
  return stripHtml(block.content);
}

// ============ BlockEditor (js/editor.js), reading through `doc` ============

function editorExtractBlockTextContent(block, doc) {
  const stripHtmlTags = html => {
    if (!html) return '';
    // Parsed in a document of its own, never an element of the page's
    const inert = doc.implementation.createHTMLDocument('');
    const div = inert.createElement('div');
    div.innerHTML = html;
    return div.textContent || '';
  };
  if (!block) return '';

  switch (block.type) {
    case 'text':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'bullet':
    case 'numbered':
    case 'todo':
    case 'quote':
    case 'callout':
    case 'code':
      return stripHtmlTags(block.content || '');
    case 'toggle':
      return stripHtmlTags(block.content || '') + ' ' + stripHtmlTags(block.children || '');
    case 'table':
      if (block.tableData && Array.isArray(block.tableData)) {
        return block.tableData.map(row => row.join(' ')).join(' ');
      }
      return '';
    default:
      return '';
  }
}

// ============ AIChatController and NotesManager (the same extractBlockText), through `doc` ============

function chatExtractBlockText(block, doc) {
  const stripHtml = html => {
    if (!html) return '';
    const div = doc.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  };
  if (!block) return '';

  switch (block.type) {
    case 'text':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'bullet':
    case 'numbered':
    case 'todo':
    case 'quote':
    case 'callout':
      return stripHtml(block.content || '');

    case 'code':
      return block.content || '';

    case 'toggle': {
      const mainText = stripHtml(block.content || '');
      const childText = stripHtml(block.children || '');
      return [mainText, childText].filter(t => t).join('\n');
    }

    case 'table':
      if (block.tableData && Array.isArray(block.tableData)) {
        return block.tableData.map(row => row.join(' ')).join('\n');
      }
      return '';

    case 'bookmark':
      return block.title || block.url || '';

    case 'equation':
      return block.equation || '';

    default:
      return '';
  }
}

// ============ AIResponseUtils (js/ai-response-utils.js), which NotesManager and SettingsController call ============

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

module.exports = {
  sidebarExtractBlockText,
  kernelBlockText,
  editorExtractBlockTextContent,
  chatExtractBlockText,
  htmlToMarkdown,
  blockToMarkdown,
};
