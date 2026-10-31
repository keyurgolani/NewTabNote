'use strict';

/**
 * What each page of a built extension loads before it can run, read from the package on disk
 * (#27 slice 4a, `npm run perf:probe`). It reads the package the way Chrome loads it, not the
 * build that made it, so it works the same on the legacy build, the 1.4.0 package and a
 * bundler's output:
 *
 * - a page is the HTML file the manifest names for the new tab, the Popup or the Side Panel;
 * - its JavaScript is every <script src>, every <link rel="modulepreload">, and every static
 *   import or `export ... from` reached from its module scripts (the initial closure);
 * - its CSS is every <link rel="stylesheet"> and every `@import` reached from them;
 * - its fonts are the font files those stylesheets name in `url()`;
 * - outside those, in buckets of their own that the page's total leaves out: `lazy`, what an
 *   `import('<literal>')` in the closure loads with its own static imports, and `workers`, what
 *   a `new Worker('<literal>')` (relative to the page) or a
 *   `new Worker(new URL('<literal>', import.meta.url))` (relative to the module) in the closure
 *   starts, with the worker's static imports and `importScripts('<literal>')` calls. A
 *   non-literal `import()` is only counted.
 *
 * Bytes are each file's raw size and its gzip size at level 9 (sizesOf), so the numbers come
 * out the same from one run to the next; slice 4b's analyzer reuses sizesOf. A reference that
 * resolves to no file in the package is a problem, and the probe fails on any.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ts = require('typescript');

/**
 * The pages budgets cover, by name: where the manifest names each, and the file the harness
 * opens when it doesn't (1.4.x opens popup.html from the toolbar button through
 * chrome.tabs.create, with no action.default_popup)
 */
const SURFACES = Object.freeze([
  ['newtab', ['chrome_url_overrides', 'newtab'], 'newtab.html'],
  ['popup', ['action', 'default_popup'], 'popup.html'],
  ['sidepanel', ['side_panel', 'default_path'], 'sidepanel.html'],
]);

const FONT = /\.(?:woff2?|ttf|otf)$/i;

/**
 * The value of attribute `name` in the attribute text of a tag, or null
 * @param {string} attributes
 * @param {string} name
 */
function attribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3];
}

/**
 * What a page's HTML asks for: scripts (with whether each is a module), module preloads and
 * stylesheets, in order, outside comments
 * @param {string} html
 */
function htmlReferences(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [];
  const preloads = [];
  const styles = [];
  for (const match of text.matchAll(/<script\b([^>]*)>/gi)) {
    const src = attribute(match[1], 'src');
    if (src === null) continue;
    const type = attribute(match[1], 'type');
    scripts.push({ src, module: type !== null && type.trim().toLowerCase() === 'module' });
  }
  for (const match of text.matchAll(/<link\b([^>]*)>/gi)) {
    const rel = (attribute(match[1], 'rel') || '').trim().toLowerCase().split(/\s+/);
    const href = attribute(match[1], 'href');
    if (href === null) continue;
    if (rel.includes('modulepreload')) preloads.push(href);
    else if (rel.includes('stylesheet')) styles.push(href);
  }
  return { scripts, preloads, styles };
}

/**
 * A module's static imports (and `export ... from`), and how many `import()` calls it has
 * @param {string} text
 * @param {string} file
 */
function moduleReferences(text, file) {
  const source = ts.createSourceFile(file, text, {
    languageVersion: ts.ScriptTarget.Latest,
    setExternalModuleIndicator: sourceFile => {
      sourceFile.externalModuleIndicator = true;
    },
  }, false, ts.ScriptKind.JS);
  const imports = [];
  const lazy = [];
  const workers = [];
  const importScripts = [];
  let dynamicImports = 0;
  for (const statement of source.statements) {
    const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : null;
    if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
  }
  const isImportMetaUrl = node =>
    ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  const walk = node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      dynamicImports++;
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first)) lazy.push(first.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'importScripts') {
      for (const arg of node.arguments) if (ts.isStringLiteralLike(arg)) importScripts.push(arg.text);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'Worker' || node.expression.text === 'SharedWorker')) {
      const [first] = node.arguments || [];
      if (first && ts.isStringLiteralLike(first)) workers.push({ specifier: first.text, base: 'page' });
      else if (first && ts.isNewExpression(first) && ts.isIdentifier(first.expression) && first.expression.text === 'URL') {
        const [url, base] = first.arguments || [];
        if (url && ts.isStringLiteralLike(url) && base && isImportMetaUrl(base)) workers.push({ specifier: url.text, base: 'module' });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { imports, dynamicImports, lazy, workers, importScripts };
}

/**
 * A stylesheet's `@import`s and the font files its `url()`s name. Comments and strings are
 * read plainly: a url() inside a comment still counts, which only ever overcounts.
 * @param {string} text
 */
function cssReferences(text) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = [];
  const fonts = [];
  for (const match of stripped.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s"')]+))/gi)) {
    imports.push(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of stripped.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s"')]+))\s*\)/gi)) {
    const url = match[1] ?? match[2] ?? match[3];
    if (FONT.test(url.replace(/[?#].*$/, ''))) fonts.push(url);
  }
  return { imports: imports.filter(url => !FONT.test(url)), fonts };
}

/**
 * Raw and gzip bytes of `buffer`
 * @param {Buffer} buffer
 */
function sizesOf(buffer) {
  // Level 9, so a number is the same from one run, and one machine, to the next
  return { raw: buffer.length, gzip: zlib.gzipSync(buffer, { level: 9 }).length };
}

/**
 * Reads each surface page of the package in `root`
 * @param {string} root - the built extension directory
 * @returns {{pages: Record<string, PageBytes>, problems: string[]}}
 *
 * @typedef {{raw: number, gzip: number, files: number}} TypeBytes
 * @typedef {object} PageBytes
 * @property {string} file - the page, relative to the package
 * @property {TypeBytes} html
 * @property {TypeBytes} js
 * @property {TypeBytes} css
 * @property {TypeBytes} fonts
 * @property {TypeBytes} total - what the page loads before it runs: html, js, css and fonts
 * @property {TypeBytes} lazy - what its literal import() calls load, outside the total
 * @property {TypeBytes} workers - what its new Worker() calls start, outside the total
 * @property {number} modules - ES module files in the initial closure
 * @property {number} classicScripts - classic <script src> files
 * @property {number} dynamicImports - import() calls in the initial closure, literal or not
 * @property {string[]} missing - lazy chunks and workers it names that the package lacks
 * @property {Array<{file: string, type: string, raw: number, gzip: number}>} files - type is
 *   html, js, css or fonts for the total, lazy or workers for the rest
 */
function packageBytes(root) {
  const problems = [];
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { pages: {}, problems: [`${root} has no manifest.json`] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sizes = new Map();
  const sized = file => {
    if (!sizes.has(file)) sizes.set(file, sizesOf(fs.readFileSync(path.join(root, file))));
    return sizes.get(file);
  };

  /**
   * The package file `reference` names from `from` (a file relative to root), or null after
   * noting why it can't load
   */
  const resolve = (from, reference, { missing } = {}) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith('//')) {
      problems.push(`${from} names ${JSON.stringify(reference)}, a URL outside the package`);
      return null;
    }
    const clean = reference.replace(/[?#].*$/, '');
    const full = clean.startsWith('/') ? path.join(root, clean) : path.join(root, path.posix.dirname(from), clean);
    const file = path.relative(root, full).split(path.sep).join('/');
    if (file.startsWith('../')) {
      problems.push(`${from} names ${JSON.stringify(reference)}, outside the package`);
      return null;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      // A lazy chunk or worker the package lacks (1.4.0's indexer) is the page's to report,
      // not a reason the page can't be measured
      if (missing) missing.add(file);
      else problems.push(`${from} names ${JSON.stringify(reference)}, but ${file} is missing`);
      return null;
    }
    return file;
  };

  const pages = {};
  for (const [name, keys, fallback] of SURFACES) {
    const named = keys.reduce((object, key) => (object && typeof object === 'object' ? object[key] : undefined), manifest);
    if (typeof named !== 'string' && !fs.existsSync(path.join(root, fallback))) {
      problems.push(`the package has no ${name} page: the manifest names none and ${fallback} is missing`);
      continue;
    }
    const page = resolve('manifest.json', typeof named === 'string' ? named : fallback);
    if (!page) continue;
    /** @type {Map<string, string>} file -> type */
    const loaded = new Map([[page, 'html']]);
    let modules = 0;
    let classicScripts = 0;
    let dynamicImports = 0;
    /** import() and new Worker() targets the initial closure names, followed once it's read */
    const lazyEntries = [];
    const workerEntries = [];
    /** @type {Set<string>} lazy chunks and workers the page names that the package lacks */
    const missing = new Set();

    const followModule = file => {
      if (loaded.has(file)) return;
      loaded.set(file, 'js');
      modules++;
      const found = moduleReferences(fs.readFileSync(path.join(root, file), 'utf8'), file);
      dynamicImports += found.dynamicImports;
      for (const specifier of found.imports) {
        if (!/^(\.{1,2})?\//.test(specifier)) {
          problems.push(`${file} imports ${JSON.stringify(specifier)}, a bare specifier nothing resolves in a package`);
          continue;
        }
        const target = resolve(file, specifier);
        if (target) followModule(target);
      }
      for (const specifier of found.lazy) {
        const target = resolve(file, specifier, { missing });
        if (target) lazyEntries.push(target);
      }
      for (const { specifier, base } of found.workers) {
        const target = resolve(base === 'page' ? page : file, specifier, { missing });
        if (target) workerEntries.push(target);
      }
    };

    /** A lazy chunk or a worker and what it loads in turn, outside the initial closure */
    const followOutside = (file, type) => {
      if (loaded.has(file)) return;
      loaded.set(file, type);
      const found = moduleReferences(fs.readFileSync(path.join(root, file), 'utf8'), file);
      for (const specifier of [...found.imports, ...found.lazy]) {
        if (!/^(\.{1,2})?\//.test(specifier)) continue;
        const target = resolve(file, specifier, { missing });
        if (target) followOutside(target, type);
      }
      // importScripts names resolve against the worker script's own URL
      for (const name of found.importScripts) {
        const target = resolve(file, name, { missing });
        if (target) followOutside(target, type);
      }
    };
    const followStyle = file => {
      if (loaded.has(file)) return;
      loaded.set(file, 'css');
      const found = cssReferences(fs.readFileSync(path.join(root, file), 'utf8'));
      for (const url of found.imports) {
        const target = resolve(file, url);
        if (target) followStyle(target);
      }
      for (const url of found.fonts) {
        const target = resolve(file, url);
        if (target && !loaded.has(target)) loaded.set(target, 'fonts');
      }
    };

    const refs = htmlReferences(fs.readFileSync(path.join(root, page), 'utf8'));
    for (const { src, module } of refs.scripts) {
      const file = resolve(page, src);
      if (!file) continue;
      if (module) {
        followModule(file);
      } else if (!loaded.has(file)) {
        loaded.set(file, 'js');
        classicScripts++;
      }
    }
    for (const href of refs.preloads) {
      const file = resolve(page, href);
      if (file) followModule(file);
    }
    for (const href of refs.styles) {
      const file = resolve(page, href);
      if (file) followStyle(file);
    }
    // After the initial closure, so a file it already has stays in it
    for (const file of lazyEntries) followOutside(file, 'lazy');
    for (const file of workerEntries) followOutside(file, 'workers');

    const empty = () => ({ raw: 0, gzip: 0, files: 0 });
    const totals = { html: empty(), js: empty(), css: empty(), fonts: empty(), lazy: empty(), workers: empty() };
    const total = empty();
    const files = [];
    for (const [file, type] of [...loaded].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const { raw, gzip } = sized(file);
      files.push({ file, type, raw, gzip });
      const buckets = type === 'lazy' || type === 'workers' ? [totals[type]] : [totals[type], total];
      for (const bucket of buckets) {
        bucket.raw += raw;
        bucket.gzip += gzip;
        bucket.files += 1;
      }
    }
    pages[name] = { file: page, ...totals, total, modules, classicScripts, dynamicImports, missing: [...missing].sort(), files };
  }
  return { pages, problems };
}

module.exports = { packageBytes, htmlReferences, moduleReferences, cssReferences, sizesOf, SURFACES };
