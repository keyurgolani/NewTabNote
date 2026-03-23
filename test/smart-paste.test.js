const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Smart paste detection helpers extracted for testing.
 * These mirror the methods on BlockEditor in js/editor.js.
 */

function isUrl(text) {
  if (text.includes('\n')) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isFencedCode(text) {
  return /^```[\s\S]*```\s*$/m.test(text);
}

function extractFencedCode(text) {
  const match = text.match(/^```[^\n]*\n?([\s\S]*?)```\s*$/);
  return match ? match[1].replace(/\n$/, '') : text;
}

function isTsvOrCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return false;
  const tabCounts = lines.map(l => (l.match(/\t/g) || []).length);
  if (tabCounts[0] >= 1 && tabCounts.every(c => c === tabCounts[0])) return true;
  const commaCounts = lines.map(l => (l.match(/,/g) || []).length);
  if (commaCounts[0] >= 1 && commaCounts.every(c => c === commaCounts[0])) return true;
  return false;
}

function parseTsvOrCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const hasTabs = lines[0].includes('\t');
  const delimiter = hasTabs ? '\t' : ',';
  return lines.map(line => line.split(delimiter).map(cell => cell.trim()));
}

function hasMarkdownFormatting(text) {
  return /^#{1,3} /m.test(text) ||
    /^[\-\*] /m.test(text) ||
    /^\d+\. /m.test(text) ||
    /^> /m.test(text) ||
    /^- \[[ xX]\] /m.test(text) ||
    /^```/m.test(text) ||
    /^\|.+\|/m.test(text) ||
    /^(-{3,}|\*{3,}|_{3,})$/m.test(text);
}

function escapeHtmlForBlock(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============ URL Detection Tests ============

test('isUrl detects valid HTTP URLs', () => {
  assert.equal(isUrl('https://example.com'), true);
  assert.equal(isUrl('http://example.com/path?q=1'), true);
  assert.equal(isUrl('https://sub.domain.co.uk/page'), true);
});

test('isUrl rejects non-URL text', () => {
  assert.equal(isUrl('hello world'), false);
  assert.equal(isUrl('not a url'), false);
  assert.equal(isUrl(''), false);
});

test('isUrl rejects multi-line text even with URL on first line', () => {
  assert.equal(isUrl('https://example.com\nmore text'), false);
});

test('isUrl rejects non-http protocols', () => {
  assert.equal(isUrl('ftp://example.com'), false);
  assert.equal(isUrl('javascript:alert(1)'), false);
});

// ============ Fenced Code Detection Tests ============

test('isFencedCode detects fenced code blocks', () => {
  assert.equal(isFencedCode('```\nconst x = 1;\n```'), true);
  assert.equal(isFencedCode('```js\nconsole.log("hi");\n```'), true);
});

test('isFencedCode rejects plain text', () => {
  assert.equal(isFencedCode('just some text'), false);
  assert.equal(isFencedCode('``` only opening'), false);
});

test('extractFencedCode extracts code content without fences', () => {
  assert.equal(extractFencedCode('```js\nconst x = 1;\n```'), 'const x = 1;');
  assert.equal(extractFencedCode('```\nline1\nline2\n```'), 'line1\nline2');
});

// ============ TSV/CSV Detection Tests ============

test('isTsvOrCsv detects tab-separated data', () => {
  assert.equal(isTsvOrCsv('Name\tAge\nAlice\t30\nBob\t25'), true);
});

test('isTsvOrCsv detects comma-separated data', () => {
  assert.equal(isTsvOrCsv('Name,Age\nAlice,30\nBob,25'), true);
});

test('isTsvOrCsv rejects single-line text', () => {
  assert.equal(isTsvOrCsv('just one line'), false);
});

test('isTsvOrCsv rejects plain multi-line text without delimiters', () => {
  assert.equal(isTsvOrCsv('line one\nline two\nline three'), false);
});

test('parseTsvOrCsv parses TSV into 2D array', () => {
  const result = parseTsvOrCsv('Name\tAge\nAlice\t30');
  assert.deepEqual(result, [['Name', 'Age'], ['Alice', '30']]);
});

test('parseTsvOrCsv parses CSV into 2D array', () => {
  const result = parseTsvOrCsv('Name,Age\nAlice,30');
  assert.deepEqual(result, [['Name', 'Age'], ['Alice', '30']]);
});

test('parseTsvOrCsv prefers tabs over commas when both present', () => {
  const result = parseTsvOrCsv('a,b\tc,d\ne,f\tg,h');
  assert.equal(result[0].length, 2); // split by tab, not comma
});

// ============ Markdown Detection Tests ============

test('hasMarkdownFormatting detects headings', () => {
  assert.equal(hasMarkdownFormatting('# Title'), true);
  assert.equal(hasMarkdownFormatting('## Subtitle'), true);
  assert.equal(hasMarkdownFormatting('### Section'), true);
});

test('hasMarkdownFormatting detects lists', () => {
  assert.equal(hasMarkdownFormatting('- item one'), true);
  assert.equal(hasMarkdownFormatting('* item one'), true);
  assert.equal(hasMarkdownFormatting('1. first item'), true);
});

test('hasMarkdownFormatting detects blockquotes', () => {
  assert.equal(hasMarkdownFormatting('> quoted text'), true);
});

test('hasMarkdownFormatting detects todo items', () => {
  assert.equal(hasMarkdownFormatting('- [x] done task'), true);
  assert.equal(hasMarkdownFormatting('- [ ] pending task'), true);
});

test('hasMarkdownFormatting detects code blocks', () => {
  assert.equal(hasMarkdownFormatting('```\ncode\n```'), true);
});

test('hasMarkdownFormatting detects dividers', () => {
  assert.equal(hasMarkdownFormatting('---'), true);
  assert.equal(hasMarkdownFormatting('***'), true);
});

test('hasMarkdownFormatting rejects plain text', () => {
  assert.equal(hasMarkdownFormatting('just plain text here'), false);
  assert.equal(hasMarkdownFormatting('no special formatting'), false);
});

// ============ HTML Escaping Tests ============

test('escapeHtmlForBlock escapes special characters', () => {
  assert.equal(escapeHtmlForBlock('<script>alert("xss")</script>'),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

test('escapeHtmlForBlock handles empty/null input', () => {
  assert.equal(escapeHtmlForBlock(''), '');
  assert.equal(escapeHtmlForBlock(null), '');
});
