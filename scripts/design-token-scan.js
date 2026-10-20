#!/usr/bin/env node

/**
 * Design token scanner (#16). Counts what Quiet Atlas retires in production CSS,
 * HTML, JS style strings, canvas styles, and Chart.js configs, per file, against
 * test/fixtures/design-token-baseline.json. `npm test` runs it through
 * test/design-token-scan.test.js.
 *
 *   npm run design-token-scan               fail on a failure rule, a count above the
 *                                           baseline, a file with no entry that counts
 *                                           anything, or a lower count not yet recorded
 *   npm run design-token-scan -- --update   record lowered and removed counts; exits 1
 *                                           without writing when anything rose
 *   npm run design-token-scan -- --list [pattern]   print every occurrence
 *   node scripts/design-token-scan.js --init        write the first baseline; refuses
 *                                           when the file exists
 *
 * Production means the root HTML pages, css/, and js/, skipping js/lib/,
 * design/, test/, and the generated token output.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const css = require('./css-parser.js');

const ROOT_DIR = path.join(__dirname, '..');
const BASELINE_PATH = 'test/fixtures/design-token-baseline.json';
const SOURCE_PATH = 'design/quiet-atlas.tokens.json';
const GENERATED = ['css/design-tokens.css', 'js/design/tokens.generated.js'];
const SKIPPED_DIRS = ['js/lib/', 'design/', 'test/', 'node_modules/', 'dist/'];
const UPDATE_COMMAND = 'npm run design-token-scan -- --update';

/** Counted patterns. Their counts per file only fall. */
const PATTERNS = {
  'color-literal': 'Raw colors: hex, rgb(), hsl(), and the other color functions, and named colors in color properties',
  'theme-branching': 'Theme branching outside the token output: [data-theme] and [data-scheme] selectors, prefers-color-scheme, dataset.theme, and comparisons with \'dark\' or \'light\'',
  'runtime-style': 'Runtime <style> creation: createElement(\'style\') and markup strings with <style',
  'inline-style-block': 'Inline <style> blocks in HTML',
  'style-attribute': 'style= attributes in HTML and markup strings, and setAttribute(\'style\')',
  'undefined-var': 'var() of a property no production file or token defines, with no fallback',
  'unregistered-read': 'getPropertyValue() of a custom property the token output doesn\'t register (it registers the color tokens), or of a computed name',
  'gradient-text': 'Gradient text: a rule with background-clip: text',
  'backdrop-filter': 'backdrop-filter',
  'hard-shadow': 'box-shadow with a nonzero offset and zero blur',
  'one-sided-border': 'A one-sided border of 2px or more',
  'transition-all': 'transition: all, or a transition with no property',
  'px-font-size': 'A px font size: font-size and font in CSS and style writes, canvas fonts, and Chart.js font sizes',
  'alias-use': 'var() of a legacy name (legacy.aliases in design/quiet-atlas.tokens.json)',
};

/** Failure rules: any occurrence fails, whatever the baseline says */
const FAILURES = {
  import: 'An @import',
  'remote-url': 'A remote url() or a remote <link> href',
  'font-face-src': 'An @font-face url() source outside fonts/',
};

const NAMED_COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
  + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen '
  + 'darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray '
  + 'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia '
  + 'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender '
  + 'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink '
  + 'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta '
  + 'maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise '
  + 'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
  + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red '
  + 'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
  + 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));

// Properties whose values name colors
const COLOR_PROPERTY = /^(?:--.+|color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?(?:-color)?|outline(?:-color)?|text-decoration(?:-color)?|text-emphasis(?:-color)?|column-rule(?:-color)?|caret-color|accent-color|fill|stroke|stop-color|flood-color|lighting-color|box-shadow|text-shadow|scrollbar-color|-webkit-text-fill-color|-webkit-text-stroke(?:-color)?|-webkit-tap-highlight-color)$/;
const HEX_COLOR = /(^|[^\w&#-])(#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4}))(?![\w-])/gi;
// A color function with arguments: "rgb() form" in prose isn't a color
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[^\s)]/gi;
const VAR = /var\(\s*(--[\w-]*)/g;
const REMOTE_URL = /url\(\s*['"]?\s*(?:https?:)?\/\//i;
const ONE_SIDE = /^border-(?:top|right|bottom|left|block-start|block-end|inline-start|inline-end)(?:-width)?$/;
const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'];
const EASING = /^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|normal|allow-discrete|initial|inherit|unset|revert)$|^(?:steps|cubic-bezier|linear)\(/i;
const TIME = /^[+-]?(?:\d+\.?\d*|\.\d+)m?s$/i;
const PX = /(?:^|[^\w.-])(\d*\.?\d+)px\b/;

// ---------- Files ----------

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function isSkipped(file) {
  return GENERATED.includes(file) || SKIPPED_DIRS.some(dir => file.startsWith(dir));
}

/**
 * The production files: root HTML, and CSS and JS under css/ and js/
 */
function productionFiles(root = ROOT_DIR) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) files.push(entry.name);
  }
  const walkDir = dir => {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const rel = toPosix(path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (!isSkipped(`${rel}/`)) walkDir(rel);
      } else if (/\.(?:css|js|mjs)$/.test(entry.name) && !isSkipped(rel)) {
        files.push(rel);
      }
    }
  };
  walkDir('css');
  walkDir('js');
  return files.filter(file => !isSkipped(file)).sort();
}

// ---------- Token source ----------

function readDesign(root = ROOT_DIR) {
  const source = JSON.parse(fs.readFileSync(path.join(root, SOURCE_PATH), 'utf8'));
  const tokens = Object.entries(source.tokens || {});
  return {
    tokens: new Set(tokens.map(([name]) => name)),
    // The token output registers colors with @property
    registered: new Set(tokens.filter(([, token]) => token.type === 'color').map(([name]) => name)),
    aliases: new Set((source.legacy && source.legacy.aliases) || []),
  };
}

// ---------- Units: the CSS and markup inside each file ----------

/**
 * The line of an offset in a text, by binary search over its line starts
 */
function lineIndex(text, startLine = 1) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return offset => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return startLine + low;
  };
}

/**
 * Collect what a file holds, without counting yet: stylesheets, declaration lists,
 * markup, strings, and the JS facts the counts need. `fromJs` marks what came out
 * of a JS string, whose hex and function colors are counted on the string itself.
 */
function collect(file, text) {
  const unit = { file, sheets: [], declarationLists: [], strings: [], markup: [], js: [], links: [] };
  if (file.endsWith('.css')) {
    unit.sheets.push({ nodes: css.parse(text), base: path.posix.dirname(file), fromJs: false });
  } else if (file.endsWith('.html')) {
    collectHtml(unit, text, 1, path.posix.dirname(file), false);
  } else {
    collectJs(unit, text, 1);
  }
  return unit;
}

const COLOR_ATTRIBUTES = ['fill', 'stroke', 'color', 'bgcolor', 'stop-color', 'flood-color', 'lighting-color'];

/**
 * Markup: <style> blocks, style= attributes, color attributes, <link> hrefs, and
 * inline <script> bodies. Blanking keeps offsets, so line numbers stay right.
 */
function collectHtml(unit, text, startLine, base, fromJs) {
  const blank = value => value.replace(/[^\n]/g, ' ');
  let source = text.replace(/<!--[\s\S]*?-->/g, blank);
  const lineOf = lineIndex(source, startLine);
  const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let match;
  while ((match = styleBlock.exec(source))) {
    // A markup string's <style is counted once, as runtime style, by addJsString
    if (!fromJs) unit.markup.push({ kind: 'inline-style-block', line: lineOf(match.index) });
    const contentStart = match.index + match[0].indexOf('>') + 1;
    unit.sheets.push({ nodes: css.parse(match[1], lineOf(contentStart)), base, fromJs });
  }
  source = source.replace(styleBlock, blank);
  const script = /(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi;
  while ((match = script.exec(source))) {
    // The extension's CSP blocks inline scripts, but count them if they appear
    if (!fromJs && match[2].trim() && !/\ssrc\s*=/i.test(match[1])) collectJs(unit, match[2], lineOf(match.index + match[1].length));
  }
  source = source.replace(script, (block, open, body) => open + blank(body) + block.slice(open.length + body.length));
  const tag = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  while ((match = tag.exec(source))) {
    const line = lineOf(match.index);
    const attribute = /([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
    let attr;
    const found = {};
    while ((attr = attribute.exec(match[2]))) {
      const name = attr[1].toLowerCase();
      const raw = attr[2] === undefined ? '' : attr[2].replace(/^["']|["']$/g, '');
      found[name] = raw;
      if (name === 'style') {
        unit.markup.push({ kind: 'style-attribute', line });
        unit.declarationLists.push({ declarations: css.parseDeclarations(raw, line), line, fromJs });
      } else if (COLOR_ATTRIBUTES.includes(name)) {
        unit.strings.push({ text: raw, line, attribute: true, fromJs });
      }
    }
    if (match[1].toLowerCase() === 'link' && found.href !== undefined && /^(?:https?:)?\/\//i.test(found.href)) {
      unit.links.push({ href: found.href, line });
    }
  }
}

function isCssDeclarationList(text) {
  const segments = text.split(';').map(segment => segment.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(segment => /^-{0,2}[a-z][a-z0-9-]*\s*:\s*\S/i.test(segment));
}

/**
 * Sort one JS string into a stylesheet, a declaration list, markup, a selector, or
 * plain text. Every one is also kept as a string, for the counts that read it whole.
 */
function addJsString(unit, text, line, extra = {}) {
  const string = { text, line, fromJs: true, ...extra };
  if (extra.selector) {
    unit.strings.push(string);
  } else if (/<[a-z][\w-]*[\s>/]/i.test(text)) {
    for (let i = (text.match(/<style\b/gi) || []).length; i > 0; i--) unit.markup.push({ kind: 'runtime-style', line });
    collectHtml(unit, text, line, '', true);
    unit.strings.push({ ...string, markup: true });
  } else if (/\{[^{}]*:[^{}]*\}/.test(text)) {
    unit.sheets.push({ nodes: css.parse(text, line), base: '', fromJs: true });
    unit.strings.push({ ...string, css: true });
  } else if (isCssDeclarationList(text)) {
    unit.declarationLists.push({ declarations: css.parseDeclarations(text, line), line, rule: true, fromJs: true });
    unit.strings.push({ ...string, css: true });
  } else {
    unit.strings.push(string);
  }
}

const PLACEHOLDER = '\u0000';
// DOM methods whose string argument is a selector, where '#add' is an id
const SELECTOR_METHODS = ['querySelector', 'querySelectorAll', 'closest', 'matches', 'webkitMatchesSelector'];

function templateText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) return node.text;
  return node.head.text + node.templateSpans.map(span => PLACEHOLDER + span.literal.text).join('');
}

function isStringish(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}

function stringValue(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function collectJs(unit, text, startLine) {
  const source = ts.createSourceFile(unit.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + startLine;
  const consumed = new Set();
  const selectors = new Set();
  const fact = (kind, node, detail = {}) => unit.js.push({ kind, line: lineOf(node), ...detail });

  const visit = node => {
    // A stylesheet written as an array of lines, then joined
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 1
      && node.elements.every(element => ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element))) {
      const joined = node.elements.map(element => element.text).join('\n');
      if (joined.includes('{') && joined.includes('}')) {
        node.elements.forEach(element => consumed.add(element));
        addJsString(unit, joined, lineOf(node.elements[0]));
      }
    }
    if (isStringish(node) && !consumed.has(node)) addJsString(unit, templateText(node), lineOf(node), { selector: selectors.has(node) });
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const first = node.arguments[0];
      const firstValue = stringValue(first);
      if (SELECTOR_METHODS.includes(method) && first && isStringish(first)) selectors.add(first);
      if (method === 'createElement' && firstValue && firstValue.toLowerCase() === 'style') fact('runtime-style', node);
      if (method === 'setAttribute' && firstValue && firstValue.toLowerCase() === 'style') fact('style-attribute', node);
      if (method === 'getPropertyValue') fact('read', node, { name: firstValue });
      if (method === 'setProperty' && firstValue) {
        fact('define', node, { name: firstValue });
        const second = node.arguments[1];
        if (second && isStringish(second)) fact('style-write', node, { property: firstValue, value: templateText(second).split(PLACEHOLDER).join('0') });
      }
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const equality = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(op);
      if (equality && [node.left, node.right].some(side => ['dark', 'light'].includes(stringValue(side)))) fact('theme-compare', node);
      if (op === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
        const name = node.left.name.text;
        const target = node.left.expression;
        const value = isStringish(node.right) ? templateText(node.right).split(PLACEHOLDER).join('0') : null;
        if (name === 'font' && value !== null) fact('canvas-font', node, { value });
        if (ts.isPropertyAccessExpression(target) && target.name.text === 'style' && value !== null) {
          fact('style-write', node, { property: name.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`), value });
        }
        if (name === 'size' && ts.isPropertyAccessExpression(target) && target.name.text === 'font' && ts.isNumericLiteral(node.right)) {
          fact('chart-font-size', node);
        }
      }
    }
    if (ts.isCaseClause(node) && ['dark', 'light'].includes(stringValue(node.expression))) fact('theme-compare', node);
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'dataset' && ['theme', 'scheme'].includes(node.name.text)) {
      fact('theme-dataset', node);
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'font' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) && propertyName(property.name) === 'size' && ts.isNumericLiteral(property.initializer)) {
          fact('chart-font-size', property);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// ---------- Counting ----------

function hexColors(text) {
  return [...text.matchAll(HEX_COLOR)].map(match => match[2]);
}

function colorFunctions(text) {
  return [...text.matchAll(COLOR_FUNCTION)].length;
}

/**
 * Named colors in a CSS value, outside strings and url()
 */
function namedColors(value) {
  const bare = value.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ').replace(/url\([^)]*\)/gi, ' ').replace(/var\(\s*--[\w-]+/g, ' ');
  return (bare.match(/[a-z]+(?![\w-]*\()/gi) || []).filter(word => NAMED_COLORS.has(word.toLowerCase())).length;
}

/**
 * Colors in one declaration. `named` counts named colors only, for CSS from a JS
 * string, whose hex and function colors the string's own count has.
 */
function colorsInDeclaration(declaration, mode) {
  // Strings are text, as in content: "#1"
  const value = declaration.value.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ').replace(/url\([^)]*\)/gi, ' ');
  let count = mode === 'named' ? 0 : hexColors(value).length + colorFunctions(value);
  if (COLOR_PROPERTY.test(declaration.property)) count += namedColors(value);
  return count;
}

function borderWidthPx(token) {
  if (/^thin$/i.test(token)) return 1;
  if (/^medium$/i.test(token)) return 3;
  if (/^thick$/i.test(token)) return 5;
  const match = /^(\d*\.?\d+)(px|r?em)?$/i.exec(token);
  if (!match) return null;
  const n = Number(match[1]);
  return match[2] && /em$/i.test(match[2]) ? n * 16 : n;
}

/**
 * Width of a one-sided border declaration in px, or null when it can't tell
 */
function oneSidedWidth(declaration) {
  const tokens = css.splitTopLevel(declaration.value, ' ').filter(Boolean);
  if (declaration.property.endsWith('-width')) return borderWidthPx(tokens[0] || '');
  if (tokens.some(token => /^(?:none|hidden)$/i.test(token))) return 0;
  for (const token of tokens) {
    const width = borderWidthPx(token);
    if (width !== null) return width;
  }
  // No width: a var() may hold one; a bare style means medium
  if (tokens.some(token => /^var\(/i.test(token))) return null;
  return tokens.some(token => BORDER_STYLES.includes(token.toLowerCase())) ? 3 : null;
}

/**
 * border-width that sets one side to 2px or more and the others to 0
 */
function isOneSidedBorderWidth(value) {
  const sides = value.split(/\s+/).filter(Boolean).map(borderWidthPx);
  if (sides.length < 2 || sides.some(side => side === null)) return false;
  const [top, right = top, bottom = top, left = right] = sides;
  const wide = [top, right, bottom, left].filter(side => side >= 2).length;
  const zero = [top, right, bottom, left].filter(side => side === 0).length;
  return wide === 1 && zero === 3;
}

/**
 * A value with every function call blanked, innermost first, so var() and color
 * functions drop out and the lengths around them stay
 */
function withoutFunctions(value) {
  let out = value;
  for (let previous = ''; previous !== out;) {
    previous = out;
    out = out.replace(/[\w-]+\([^()]*\)/g, ' ');
  }
  return out;
}

function isHardShadow(value) {
  if (/^none$/i.test(value.trim())) return false;
  return css.splitTopLevel(value).some(layer => {
    // A layer that's only a var() can't be read; lengths beside a var() color can
    const lengths = withoutFunctions(layer).split(/\s+/)
      .filter(token => /^-?(?:\d*\.?\d+)(?:px|r?em|%)?$/i.test(token)).map(token => parseFloat(token));
    if (lengths.length < 2) return false;
    const [x, y, blur = 0] = lengths;
    return (x !== 0 || y !== 0) && blur === 0;
  });
}

function isTransitionAll(property, value) {
  if (property === 'transition-property') return css.splitTopLevel(value).some(part => /^all$/i.test(part));
  if (property !== 'transition') return false;
  return css.splitTopLevel(value).some(layer => {
    const tokens = layer.split(/\s+(?![^(]*\))/).filter(Boolean);
    if (tokens.some(token => /^all$/i.test(token))) return true;
    if (/var\(/i.test(layer) || /^none$/i.test(layer.trim())) return false;
    return tokens.length > 0 && tokens.every(token => TIME.test(token) || EASING.test(token));
  });
}

/**
 * Count the CSS checks over one declaration
 */
function countDeclaration(add, declaration, context, colors = 'all') {
  const { property, value } = declaration;
  if (colors !== 'none') add('color-literal', colorsInDeclaration(declaration, colors), declaration.line, `${property}: ${value}`);
  if (/^(?:-webkit-)?backdrop-filter$/.test(property) && !/^none$/i.test(value)) add('backdrop-filter', 1, declaration.line, value);
  if (property === 'box-shadow' && isHardShadow(value)) add('hard-shadow', 1, declaration.line, value);
  if (ONE_SIDE.test(property)) {
    const width = oneSidedWidth(declaration);
    if (width !== null && width >= 2) add('one-sided-border', 1, declaration.line, `${property}: ${value}`);
  }
  if (property === 'border-width' && isOneSidedBorderWidth(value)) add('one-sided-border', 1, declaration.line, `${property}: ${value}`);
  if (isTransitionAll(property, value)) add('transition-all', 1, declaration.line, `${property}: ${value}`);
  if ((property === 'font-size' || property === 'font') && PX.test(value)) add('px-font-size', 1, declaration.line, `${property}: ${value}`);
  if (REMOTE_URL.test(value)) context.fail('remote-url', declaration.line, `${property}: ${value}`);
}

function countRuleLike(add, declarations, line) {
  if (declarations.some(d => /^(?:-webkit-)?background-clip$/.test(d.property) && /\btext\b/i.test(d.value))) {
    add('gradient-text', 1, line, 'background-clip: text');
  }
}

function countSheet(add, sheet, context) {
  css.walk(sheet.nodes, node => {
    if (node.type === 'at-rule') {
      if (node.name === 'import') context.fail('import', node.line, `@import ${node.prelude}`);
      if (node.name === 'media' && /prefers-color-scheme/i.test(node.prelude)) add('theme-branching', 1, node.line, `@media ${node.prelude}`);
      if (REMOTE_URL.test(node.prelude)) context.fail('remote-url', node.line, `@${node.name} ${node.prelude}`);
      if (node.name === 'font-face') {
        for (const declaration of node.declarations.filter(d => d.property === 'src')) {
          for (const match of declaration.value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
            const resolved = path.posix.normalize(path.posix.join(sheet.base || '.', match[2]));
            if (!resolved.startsWith('fonts/')) context.fail('font-face-src', declaration.line, `src: url(${match[2]})`);
          }
        }
      }
    } else {
      const branches = (node.prelude.match(/\[data-(?:theme|scheme)\b/gi) || []).length;
      if (branches) add('theme-branching', branches, node.line, node.prelude);
      countRuleLike(add, node.declarations, node.line);
    }
    node.declarations.forEach(declaration => countDeclaration(add, declaration, context, sheet.fromJs ? 'named' : 'all'));
  });
}

/**
 * var() uses in a text: undefined ones with no fallback, and legacy names
 */
function countVars(add, text, line, design, defined) {
  for (const match of text.matchAll(VAR)) {
    const name = match[1];
    if (name === '--' || text[match.index + match[0].length] === PLACEHOLDER) continue;
    const rest = text.slice(match.index + match[0].length).trimStart();
    const fallback = rest.startsWith(',');
    if (design.aliases.has(name)) add('alias-use', 1, line, name);
    if (!fallback && !defined.has(name)) add('undefined-var', 1, line, name);
  }
}

/**
 * Custom properties a file defines: declarations, and setProperty() names
 */
function definitionsOf(unit) {
  const names = new Set();
  const addDeclarations = declarations => declarations.forEach(d => d.property.startsWith('--') && names.add(d.property));
  unit.sheets.forEach(sheet => css.walk(sheet.nodes, node => addDeclarations(node.declarations)));
  unit.declarationLists.forEach(list => addDeclarations(list.declarations));
  unit.js.filter(f => f.kind === 'define' && f.name && f.name.startsWith('--')).forEach(f => names.add(f.name));
  return names;
}

/**
 * Count one file. `defined` holds every custom property production or the token
 * source defines.
 */
function countUnit(unit, text, design, defined) {
  const occurrences = [];
  const failures = [];
  const add = (pattern, count, line, detail) => {
    for (let i = 0; i < count; i++) occurrences.push({ file: unit.file, line, pattern, detail });
  };
  const context = { fail: (rule, line, detail) => failures.push({ file: unit.file, line, rule, detail }) };

  unit.sheets.forEach(sheet => countSheet(add, sheet, context));
  unit.declarationLists.forEach(list => {
    if (list.rule) countRuleLike(add, list.declarations, list.line);
    list.declarations.forEach(declaration => countDeclaration(add, declaration, context, list.fromJs ? 'named' : 'all'));
  });
  unit.markup.forEach(item => add(item.kind, 1, item.line, item.kind));
  unit.links.forEach(link => context.fail('remote-url', link.line, `<link href="${link.href}">`));

  // var() in CSS and HTML; JS strings are read whole below
  const declarationVars = list => list.forEach(d => countVars(add, d.value, d.line, design, defined));
  unit.sheets.filter(sheet => !sheet.fromJs).forEach(sheet => css.walk(sheet.nodes, node => declarationVars(node.declarations)));
  unit.declarationLists.filter(list => !list.fromJs).forEach(list => declarationVars(list.declarations));

  for (const string of unit.strings) {
    const named = NAMED_COLORS.has(string.text.trim().toLowerCase());
    if (string.attribute) {
      // An HTML color attribute; in a JS string, its hex is in the string's count
      const raw = string.fromJs ? 0 : hexColors(string.text).length + colorFunctions(string.text);
      add('color-literal', raw + (named ? 1 : 0), string.line, string.text);
      continue;
    }
    // Every JS string: hex and function colors, once, wherever they sit
    if (!string.selector) add('color-literal', hexColors(string.text).length + colorFunctions(string.text), string.line, string.text);
    const plainText = !string.css && !string.markup && !string.selector;
    if (plainText && named && string.text.trim() === string.text.trim().toLowerCase()) add('color-literal', 1, string.line, string.text);
    if (plainText && REMOTE_URL.test(string.text)) context.fail('remote-url', string.line, string.text);
    // Theme branching outside the CSS the parser already counted
    const outsideCss = string.markup
      ? string.text.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, ' ').replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
      : string.text;
    if (!string.css) add('theme-branching', (outsideCss.match(/prefers-color-scheme/gi) || []).length, string.line, string.text);
    if (/^data-(?:theme|scheme)$/.test(string.text) || (!string.css && /\[data-(?:theme|scheme)\b/.test(outsideCss))) {
      add('theme-branching', 1, string.line, string.text);
    }
    countVars(add, string.text, string.line, design, defined);
  }

  for (const f of unit.js) {
    if (f.kind === 'runtime-style') add('runtime-style', 1, f.line, 'createElement(\'style\')');
    if (f.kind === 'style-attribute') add('style-attribute', 1, f.line, 'setAttribute(\'style\')');
    if (f.kind === 'theme-compare') add('theme-branching', 1, f.line, 'comparison with \'dark\' or \'light\'');
    if (f.kind === 'theme-dataset') add('theme-branching', 1, f.line, 'dataset.theme');
    // Standard properties aren't registered or unregistered; a custom one is
    // registered only when the token output registers it
    if (f.kind === 'read' && !(f.name && (design.registered.has(f.name) || !f.name.startsWith('--')))) {
      add('unregistered-read', 1, f.line, f.name === null ? 'a computed name' : f.name);
    }
    if (f.kind === 'canvas-font' && PX.test(f.value)) add('px-font-size', 1, f.line, f.value);
    if (f.kind === 'chart-font-size') add('px-font-size', 1, f.line, 'Chart.js font size');
    // A style write's string has its colors counted already; cssText is parsed as
    // a declaration list
    if (f.kind === 'style-write' && f.property !== 'css-text') {
      countDeclaration(add, { property: f.property, value: f.value, line: f.line }, context, 'none');
    }
  }
  return { occurrences, failures };
}

/**
 * Scan production. Returns counts per file and pattern, every occurrence, and failures.
 */
function scan(options = {}) {
  const root = options.root || ROOT_DIR;
  const design = options.design || readDesign(root);
  const files = options.files || productionFiles(root);
  const texts = options.texts || {};
  const units = files.map(file => {
    const text = texts[file] !== undefined ? texts[file] : fs.readFileSync(path.join(root, file), 'utf8');
    return { unit: collect(file, text), text };
  });
  const defined = new Set(design.tokens);
  units.forEach(({ unit }) => definitionsOf(unit).forEach(name => defined.add(name)));

  const counts = {};
  const occurrences = [];
  const failures = [];
  for (const { unit, text } of units) {
    const result = countUnit(unit, text, design, defined);
    occurrences.push(...result.occurrences);
    failures.push(...result.failures);
    for (const occurrence of result.occurrences) {
      counts[unit.file] = counts[unit.file] || {};
      counts[unit.file][occurrence.pattern] = (counts[unit.file][occurrence.pattern] || 0) + 1;
    }
  }
  return { files, counts: sortCounts(counts), occurrences, failures };
}

function sortCounts(counts) {
  const out = {};
  for (const file of Object.keys(counts).sort()) {
    out[file] = {};
    for (const pattern of Object.keys(PATTERNS)) {
      if (counts[file][pattern]) out[file][pattern] = counts[file][pattern];
    }
  }
  return out;
}

// ---------- Baseline ----------

const ABOUT = 'Per-file counts from scripts/design-token-scan.js (#16). Counts only fall: a higher count, or a count in a file with no entry, fails. '
  + `A lower count fails until it's recorded with \`${UPDATE_COMMAND}\`. Entries are never added, except that an entry follows a file `
  + 'moved or renamed verbatim in the same PR, and a <style> block moved verbatim into a stylesheet takes its counts along.';

function serializeBaseline(counts) {
  return `${JSON.stringify({ about: ABOUT, patterns: PATTERNS, files: sortCounts(counts) }, null, 2)}\n`;
}

function parseBaseline(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.files !== 'object' || data.files === null) throw new Error('missing a "files" object');
  for (const [file, patterns] of Object.entries(data.files)) {
    for (const [pattern, count] of Object.entries(patterns || {})) {
      if (!PATTERNS[pattern]) throw new Error(`${file}: unknown pattern ${pattern}`);
      if (!Number.isInteger(count) || count < 1) throw new Error(`${file} ${pattern}: count ${JSON.stringify(count)}`);
    }
  }
  return data.files;
}

/**
 * Compare counts with the baseline: rises (including files with no entry) and drops
 */
function compare(baseline, counts) {
  const raised = [];
  const lowered = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(counts)]);
  for (const file of [...files].sort()) {
    for (const pattern of Object.keys(PATTERNS)) {
      const allowed = (baseline[file] && baseline[file][pattern]) || 0;
      const count = (counts[file] && counts[file][pattern]) || 0;
      if (count > allowed) raised.push({ file, pattern, allowed, count, entry: Boolean(baseline[file]) });
      else if (count < allowed) lowered.push({ file, pattern, allowed, count });
    }
  }
  return { raised, lowered };
}

function totals(counts) {
  const out = {};
  for (const patterns of Object.values(counts)) {
    for (const [pattern, count] of Object.entries(patterns)) out[pattern] = (out[pattern] || 0) + count;
  }
  return out;
}

/**
 * One line of occurrence detail, with template substitutions shown as ${...}
 */
function printable(detail) {
  return detail.split(PLACEHOLDER).join('${...}').replace(/\s+/g, ' ').slice(0, 120);
}

function main(argv = process.argv.slice(2), options = {}) {
  const root = options.root || ROOT_DIR;
  const log = options.log || console.log;
  const error = options.error || console.error;
  const baselinePath = path.join(root, BASELINE_PATH);
  const init = argv.includes('--init');
  const update = argv.includes('--update');
  const listAt = argv.indexOf('--list');
  const unknown = argv.filter((arg, i) => !['--init', '--update', '--list'].includes(arg) && !(listAt !== -1 && i === listAt + 1));
  if (unknown.length || (init && update)) {
    error(`usage: node scripts/design-token-scan.js [--init | --update | --list [pattern]]${unknown.length ? ` (unknown: ${unknown.join(' ')})` : ''}`);
    return 2;
  }

  const result = scan({ root });
  if (listAt !== -1) {
    const only = argv[listAt + 1];
    if (only && !PATTERNS[only] && !FAILURES[only]) {
      error(`design token scan: unknown pattern ${only}`);
      return 2;
    }
    result.occurrences.filter(o => !only || o.pattern === only).forEach(o => log(`${o.file}:${o.line} ${o.pattern} ${printable(o.detail)}`));
    result.failures.filter(f => !only || f.rule === only).forEach(f => log(`${f.file}:${f.line} ${f.rule} ${f.detail}`));
    return 0;
  }

  if (result.failures.length) {
    error(`design token scan failed: ${result.failures.length} failure${result.failures.length === 1 ? '' : 's'} no baseline allows:`);
    result.failures.forEach(f => error(`  ${f.file}:${f.line} ${f.rule} (${FAILURES[f.rule]}): ${f.detail}`));
    return 1;
  }

  if (init) {
    if (fs.existsSync(baselinePath)) {
      error(`design token scan: refusing --init, ${BASELINE_PATH} already exists. Record drops with \`${UPDATE_COMMAND}\`.`);
      return 1;
    }
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, serializeBaseline(result.counts));
    log(`design token scan: wrote ${BASELINE_PATH} for ${Object.keys(result.counts).length} files`);
    return 0;
  }

  if (!fs.existsSync(baselinePath)) {
    error(`design token scan: ${BASELINE_PATH} is missing`);
    return 1;
  }
  let baseline;
  let baselineText;
  try {
    baselineText = fs.readFileSync(baselinePath, 'utf8');
    baseline = parseBaseline(baselineText);
  } catch (e) {
    error(`design token scan: can't read ${BASELINE_PATH}: ${e.message}`);
    return 1;
  }
  const { raised, lowered } = compare(baseline, result.counts);
  const describe = item => `${item.file} ${item.pattern}: ${item.count} found, ${item.allowed} allowed${item.entry === false ? ' (no baseline entry, so it must count zero)' : ''}`;
  if (raised.length) {
    error(`design token scan failed: ${raised.length} count${raised.length === 1 ? '' : 's'} above ${BASELINE_PATH}${update ? ', so nothing was written' : ''}:`);
    raised.forEach(item => {
      error(`  ${describe(item)}`);
      result.occurrences.filter(o => o.file === item.file && o.pattern === item.pattern).slice(0, 20)
        .forEach(o => error(`    ${o.file}:${o.line} ${printable(o.detail)}`));
    });
    return 1;
  }
  if (lowered.length) {
    if (update) {
      fs.writeFileSync(baselinePath, serializeBaseline(result.counts));
      log(`design token scan: recorded ${lowered.length} lower count${lowered.length === 1 ? '' : 's'} in ${BASELINE_PATH}`);
      lowered.forEach(item => log(`  ${item.file} ${item.pattern}: ${item.allowed} -> ${item.count}`));
      return 0;
    }
    error(`design token scan failed: ${lowered.length} count${lowered.length === 1 ? '' : 's'} below ${BASELINE_PATH}. Record them with \`${UPDATE_COMMAND}\`.`);
    lowered.forEach(item => error(`  ${item.file} ${item.pattern}: ${item.allowed} -> ${item.count}`));
    return 1;
  }
  if (update && serializeBaseline(result.counts) !== baselineText) {
    fs.writeFileSync(baselinePath, serializeBaseline(result.counts));
    log(`design token scan: rewrote ${BASELINE_PATH} with the current pattern descriptions`);
    return 0;
  }
  const sum = totals(result.counts);
  log(`design token scan: OK, ${result.files.length} files match ${BASELINE_PATH}${update ? ', nothing to record' : ''}`);
  Object.keys(PATTERNS).forEach(pattern => log(`  ${pattern}: ${sum[pattern] || 0}`));
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  PATTERNS, FAILURES, BASELINE_PATH, SOURCE_PATH, GENERATED, productionFiles, readDesign, scan, compare, totals,
  serializeBaseline, parseBaseline, main,
};
