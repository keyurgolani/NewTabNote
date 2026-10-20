/**
 * A small, tolerant CSS parser for scripts/design-token-scan.js and the design
 * token tests. It keeps comments and strings out of the structure, keeps a `;`
 * inside parentheses (as in a data: url()), and reports line numbers.
 *
 *   parse(text)              stylesheet: rules and at-rules
 *   parseDeclarations(text)  a declaration list, as in a style attribute
 *
 * Nodes:
 *   { type: 'rule', prelude, declarations, children, line }
 *   { type: 'at-rule', name, prelude, declarations, children, block, line }
 * A rule's children are nested rules; an at-rule has declarations (@font-face,
 * @property, @page, ...) or children (@media, @supports, @keyframes, ...).
 * Declarations: { property, value, important, line }. Property names are
 * lowercased, except custom properties.
 */

const DECLARATION_AT_RULES = ['font-face', 'property', 'page', 'counter-style', 'font-palette-values', 'viewport', 'font-feature-values'];

function createReader(text, startLine = 1) {
  return { text, pos: 0, line: startLine };
}

function advance(reader, count = 1) {
  for (let i = 0; i < count && reader.pos < reader.text.length; i++) {
    if (reader.text[reader.pos] === '\n') reader.line++;
    reader.pos++;
  }
}

/**
 * Skip a comment or a string at the reader, returning the text it covered, or null
 */
function skipOpaque(reader) {
  const { text } = reader;
  const ch = text[reader.pos];
  const start = reader.pos;
  if (ch === '/' && text[reader.pos + 1] === '*') {
    const end = text.indexOf('*/', reader.pos + 2);
    advance(reader, (end === -1 ? text.length : end + 2) - reader.pos);
    return { kind: 'comment', text: text.slice(start, reader.pos) };
  }
  if (ch === '"' || ch === '\'') {
    advance(reader);
    while (reader.pos < text.length && text[reader.pos] !== ch) {
      if (text[reader.pos] === '\\') advance(reader);
      advance(reader);
    }
    advance(reader);
    return { kind: 'string', text: text.slice(start, reader.pos) };
  }
  return null;
}

/**
 * Read up to one of `stops` at parenthesis depth 0, outside strings and comments.
 * Comments are dropped from the returned text.
 */
function readUntil(reader, stops) {
  let out = '';
  let depth = 0;
  while (reader.pos < reader.text.length) {
    const opaque = skipOpaque(reader);
    if (opaque) {
      if (opaque.kind === 'string') out += opaque.text;
      continue;
    }
    const ch = reader.text[reader.pos];
    if (depth === 0 && stops.includes(ch)) return { text: out, stop: ch };
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    out += ch;
    advance(reader);
  }
  return { text: out, stop: null };
}

function skipSpace(reader) {
  while (reader.pos < reader.text.length) {
    if (/\s/.test(reader.text[reader.pos])) {
      advance(reader);
      continue;
    }
    const start = reader.pos;
    const opaque = skipOpaque(reader);
    if (opaque && opaque.kind === 'comment') continue;
    if (opaque) {
      // A string isn't space: rewind
      reader.line -= (reader.text.slice(start, reader.pos).match(/\n/g) || []).length;
      reader.pos = start;
    }
    return;
  }
}

function declarationOf(raw, line) {
  const colon = raw.indexOf(':');
  if (colon === -1) return null;
  const name = raw.slice(0, colon).trim();
  if (!/^-{0,2}[A-Za-z_][\w-]*$/.test(name)) return null;
  let value = raw.slice(colon + 1).trim();
  let important = false;
  const bang = /!\s*important\s*$/i.exec(value);
  if (bang) {
    important = true;
    value = value.slice(0, bang.index).trim();
  }
  return { property: name.startsWith('--') ? name : name.toLowerCase(), value, important, line };
}

/**
 * Parse a declaration block up to its closing brace (or the end), with nested rules
 */
function readBlock(reader) {
  const declarations = [];
  const children = [];
  for (;;) {
    skipSpace(reader);
    if (reader.pos >= reader.text.length) break;
    if (reader.text[reader.pos] === '}') {
      advance(reader);
      break;
    }
    if (reader.text[reader.pos] === ';') {
      advance(reader);
      continue;
    }
    const line = reader.line;
    const { text, stop } = readUntil(reader, [';', '{', '}']);
    if (stop === '{') {
      advance(reader);
      children.push(nodeOf(text.trim(), reader, line));
      continue;
    }
    const declaration = declarationOf(text, line);
    if (declaration) declarations.push(declaration);
    if (stop === ';') advance(reader);
  }
  return { declarations, children };
}

function nodeOf(prelude, reader, line) {
  if (prelude.startsWith('@')) {
    const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
    const name = (match ? match[1] : '').toLowerCase();
    const rest = match ? match[2].trim() : '';
    if (DECLARATION_AT_RULES.includes(name)) {
      const { declarations } = readBlock(reader);
      return { type: 'at-rule', name, prelude: rest, declarations, children: [], block: true, line };
    }
    return { type: 'at-rule', name, prelude: rest, declarations: [], children: readRules(reader, true), block: true, line };
  }
  const { declarations, children } = readBlock(reader);
  return { type: 'rule', prelude, declarations, children, line };
}

function readRules(reader, nested) {
  const nodes = [];
  for (;;) {
    skipSpace(reader);
    if (reader.pos >= reader.text.length) break;
    const ch = reader.text[reader.pos];
    if (ch === '}') {
      advance(reader);
      if (nested) break;
      continue;
    }
    if (ch === ';') {
      advance(reader);
      continue;
    }
    const line = reader.line;
    const { text, stop } = readUntil(reader, [';', '{', '}']);
    const prelude = text.trim();
    if (stop === '{') {
      advance(reader);
      nodes.push(nodeOf(prelude, reader, line));
    } else if (prelude.startsWith('@')) {
      const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
      nodes.push({ type: 'at-rule', name: (match ? match[1] : '').toLowerCase(), prelude: match ? match[2].trim() : '', declarations: [], children: [], block: false, line });
      if (stop === ';') advance(reader);
    } else if (stop === ';') {
      advance(reader);
    } else if (stop === '}' && nested) {
      advance(reader);
      break;
    } else if (stop === '}') {
      advance(reader);
    }
  }
  return nodes;
}

/**
 * Parse a stylesheet
 * @param {string} text
 * @param {number} [startLine]
 */
function parse(text, startLine = 1) {
  return readRules(createReader(text, startLine), false);
}

/**
 * Parse a declaration list, such as a style attribute
 * @param {string} text
 * @param {number} [startLine]
 */
function parseDeclarations(text, startLine = 1) {
  return readBlock(createReader(text, startLine)).declarations;
}

/**
 * Every rule and at-rule, depth first, with the at-rules around it
 */
function walk(nodes, visit, ancestors = []) {
  for (const node of nodes) {
    visit(node, ancestors);
    walk(node.children, visit, [...ancestors, node]);
  }
}

/**
 * Split a value at top-level commas, outside parentheses and strings
 */
function splitTopLevel(value, separator = ',') {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += value[i + 1] || '';
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    if (depth === 0 && ch === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map(part => part.trim());
}

module.exports = { parse, parseDeclarations, walk, splitTopLevel };
