'use strict';

/**
 * How the extension's sources load their JavaScript, read from the repository root: the
 * kernel's tests see from it which modules each page and the service worker reach. Since #27
 * slice 2 the bundler builds dist/ from these sources and scripts/build/closure.js checks it.
 *
 * The roots are the manifest's background.service_worker and every <script src> in the
 * pages. Module scripts are followed through their static imports and `export ... from`;
 * a classic service worker through its importScripts() calls with string arguments.
 *
 * Each page's modules are also kept by depth from its own module scripts.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

// Manifest keys that name an extension page
const MANIFEST_PAGES = [
  ['chrome_url_overrides', 'newtab'],
  ['chrome_url_overrides', 'history'],
  ['chrome_url_overrides', 'bookmarks'],
  ['side_panel', 'default_path'],
  ['action', 'default_popup'],
  ['options_ui', 'page'],
  ['options_page'],
  ['devtools_page'],
];

/**
 * `file` relative to `root`, with forward slashes
 */
function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * The value of attribute `name` in the attribute text of a tag, or null
 */
function attribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3];
}

/**
 * The external scripts a page loads, in order, as { src, module }. Inline scripts have no
 * src, and the extension CSP blocks them anyway.
 */
function scriptTags(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const tags = [];
  for (const match of text.matchAll(/<script\b([^>]*)>/gi)) {
    const src = attribute(match[1], 'src');
    if (src === null) continue;
    const type = attribute(match[1], 'type');
    tags.push({ src, module: type !== null && type.trim().toLowerCase() === 'module' });
  }
  return tags;
}

/**
 * A call of importScripts, bare or through self or globalThis
 */
function isImportScripts(callee) {
  const globalObject = node => ts.isIdentifier(node) && (node.text === 'self' || node.text === 'globalThis');
  if (ts.isIdentifier(callee)) return callee.text === 'importScripts';
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'importScripts' && globalObject(callee.expression);
  if (ts.isElementAccessExpression(callee)) {
    return ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === 'importScripts' && globalObject(callee.expression);
  }
  return false;
}

/**
 * What a script's syntax tree says about loading: its static imports, and the calls and
 * awaits that matter in a service worker, each with its line:col. `module` parses it as
 * the ES module it's loaded as, even with no import or export: as a script, await (x) is a
 * call to a function named await.
 */
function inspect(text, file, { module = false } = {}) {
  const options = module
    ? { languageVersion: ts.ScriptTarget.Latest, setExternalModuleIndicator: sourceFile => { sourceFile.externalModuleIndicator = true; } }
    : ts.ScriptTarget.Latest;
  const source = ts.createSourceFile(file, text, options, false, ts.ScriptKind.JS);
  const at = node => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${line + 1}:${character + 1}`;
  };
  const found = { imports: [], topLevelAwait: [], dynamicImports: [], importScripts: [], syntaxErrors: [] };

  for (const diagnostic of source.parseDiagnostics || []) {
    const { line, character } = source.getLineAndCharacterOfPosition(diagnostic.start || 0);
    found.syntaxErrors.push(`${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} at ${line + 1}:${character + 1}`);
  }
  for (const statement of source.statements) {
    const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : null;
    if (specifier && ts.isStringLiteral(specifier)) found.imports.push({ specifier: specifier.text, at: at(statement) });
  }

  const walk = (node, inFunction) => {
    if (!inFunction && (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier))) {
      found.topLevelAwait.push(at(node));
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) found.dynamicImports.push(at(node));
      if (isImportScripts(node.expression)) {
        found.importScripts.push({
          at: at(node),
          names: node.arguments.map(arg => (ts.isStringLiteralLike(arg) ? arg.text : null)),
        });
      }
    }
    const nested = inFunction || ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
    ts.forEachChild(node, child => walk(child, nested));
  };
  walk(source, false);
  return found;
}

/**
 * @typedef {object} ScriptGraph
 * @property {{file: string, module: boolean}|null} worker - the manifest's service worker
 * @property {Set<string>} modules - files loaded as ES modules, by a page or the worker
 * @property {Set<string>} classic - files loaded as classic scripts
 * @property {Set<string>} workerFiles - every file the service worker loads
 * @property {Set<string>} pages - the pages read, the manifest's included
 * @property {Map<string, Array<{file: string, depth: number}>>} pageModules - each page's
 *   modules, its own module scripts at depth 0 and each import one deeper than the closest
 *   module that imports it, in the order a breadth-first walk of the imports reaches them
 * @property {number} references - script tags, imports, and importScripts names resolved
 * @property {Array<{from: string, message: string}>} problems - what can't load, in the
 *   order found
 */

/**
 * Read how the package in `root` loads its scripts.
 * @param {string} root
 * @param {object} [options]
 * @param {string[]} [options.pages] - pages to read besides those the manifest names
 * @param {boolean} [options.inspectClassic] - parse classic page scripts too, to report
 *   import/export statements Chrome would refuse in them (check:dist; the build skips it)
 * @returns {ScriptGraph}
 */
function readScriptGraph(root, { pages = [], inspectClassic = false } = {}) {
  const graph = {
    worker: null,
    modules: new Set(),
    classic: new Set(),
    workerFiles: new Set(),
    pages: new Set(),
    pageModules: new Map(),
    references: 0,
    problems: [],
  };
  const reported = new Set();
  const problem = (from, message) => {
    if (reported.has(message)) return;
    reported.add(message);
    graph.problems.push({ from, message });
  };
  const resolved = new Set();
  const inspected = new Map();
  // Modules followed from a page; graph.workerFiles holds those followed from the worker
  const pageModules = new Set();
  // Each module's imports that resolve, in order
  const importsOf = new Map();

  // A file is read as a module or as a classic script, the way it's loaded
  const read = (file, module) => {
    const key = `${module ? 'module' : 'classic'}:${file}`;
    if (!inspected.has(key)) {
      inspected.set(key, inspect(fs.readFileSync(path.join(root, file), 'utf8'), file, { module }));
    }
    return inspected.get(key);
  };

  /**
   * The file `reference` names, relative to root, or null after reporting why it can't
   * load. `base` is the directory relative references start from.
   */
  const resolve = (from, what, reference, base, { bare = false } = {}) => {
    const describe = `${from} ${what} ${JSON.stringify(reference)}`;
    if (/^[a-z][a-z\d+.-]*:/i.test(reference)) {
      problem(from, `${describe}, which is a URL, not a file in the package`);
      return null;
    }
    if (bare && !/^(\.{1,2})?\//.test(reference)) {
      problem(from, `${describe}: a bare specifier, which nothing resolves without a bundler or an import map`);
      return null;
    }
    const clean = reference.replace(/[?#].*$/, '');
    const full = clean.startsWith('/') ? path.join(root, clean) : path.join(root, base, clean);
    const file = relative(root, full);
    if (file.startsWith('../') || path.isAbsolute(file)) {
      problem(from, `${describe}, which resolves outside the package`);
      return null;
    }
    resolved.add(`${from}\0${reference}`);
    graph.references = resolved.size;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      problem(from, `${describe}, but ${file} is missing`);
      return null;
    }
    return file;
  };

  const followModule = (file, inWorker) => {
    const followed = inWorker ? graph.workerFiles : pageModules;
    if (followed.has(file)) return;
    followed.add(file);
    graph.modules.add(file);

    const found = read(file, true);
    found.syntaxErrors.forEach(error => problem(file, `${file} doesn't parse: ${error}`));
    if (inWorker) {
      found.topLevelAwait.forEach(at => problem(file, `${file} uses top-level await at ${at}; Chrome won't start a module service worker whose graph has it`));
      found.dynamicImports.forEach(at => problem(file, `${file} calls import() at ${at}, which a service worker can't`));
      found.importScripts.forEach(({ at }) => problem(file, `${file} calls importScripts() at ${at}, which throws in a module service worker`));
    }
    const targets = [];
    for (const { specifier } of found.imports) {
      const target = resolve(file, 'imports', specifier, path.posix.dirname(file), { bare: true });
      if (target) targets.push(target);
    }
    importsOf.set(file, targets);
    targets.forEach(target => followModule(target, inWorker));
  };

  // A page's modules by depth, breadth first from its own module scripts
  const modulesOfPage = entries => {
    const depths = new Map(entries.map(file => [file, 0]));
    const pending = [...entries];
    while (pending.length > 0) {
      const file = pending.shift();
      for (const target of importsOf.get(file) || []) {
        if (depths.has(target)) continue;
        depths.set(target, depths.get(file) + 1);
        pending.push(target);
      }
    }
    return [...depths].map(([file, depth]) => ({ file, depth }));
  };

  const followClassicWorker = file => {
    if (graph.workerFiles.has(file)) return;
    graph.workerFiles.add(file);
    graph.classic.add(file);
    const found = read(file, false);
    found.syntaxErrors.forEach(error => problem(file, `${file} doesn't parse: ${error}`));
    if (found.imports.length > 0) problem(file, `${file} is a classic service worker script but has import or export statements`);
    for (const { at, names } of found.importScripts) {
      for (const name of names) {
        if (name === null) {
          problem(file, `${file} calls importScripts() at ${at} with a name that isn't a string, so it can't be checked`);
          continue;
        }
        // importScripts resolves names against the worker script's URL
        const target = resolve(file, 'imports scripts', name, path.posix.dirname(graph.worker.file));
        if (target) followClassicWorker(target);
      }
    }
  };

  const manifestPath = path.join(root, 'manifest.json');
  let manifest = null;
  if (!fs.existsSync(manifestPath)) {
    problem('manifest.json', 'manifest.json is missing');
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      problem('manifest.json', `manifest.json doesn't parse: ${error.message}`);
    }
  }

  const pageList = [...pages];
  if (manifest) {
    for (const keys of MANIFEST_PAGES) {
      const value = keys.reduce((object, key) => (object && typeof object === 'object' ? object[key] : undefined), manifest);
      if (typeof value !== 'string') continue;
      const page = resolve('manifest.json', `names ${keys.join('.')}`, value, '');
      if (page) pageList.push(page);
    }
    const background = manifest.background;
    if (background && typeof background.service_worker === 'string') {
      const file = resolve('manifest.json', 'names background.service_worker', background.service_worker, '');
      if (file) {
        graph.worker = { file, module: background.type === 'module' };
        if (graph.worker.module) followModule(file, true);
        else followClassicWorker(file);
      }
    }
  }

  for (const page of [...new Set(pageList)].sort()) {
    if (!fs.existsSync(path.join(root, page))) continue;
    graph.pages.add(page);
    const entries = [];
    for (const tag of scriptTags(fs.readFileSync(path.join(root, page), 'utf8'))) {
      const file = resolve(page, `loads <script${tag.module ? ' type="module"' : ''} src>`, tag.src, path.posix.dirname(page));
      if (!file) continue;
      if (tag.module) {
        followModule(file, false);
        entries.push(file);
      } else {
        graph.classic.add(file);
        if (inspectClassic && read(file, false).imports.length > 0) {
          problem(page, `${page} loads ${file} as a classic script, but it has import or export statements`);
        }
      }
    }
    graph.pageModules.set(page, modulesOfPage(entries));
  }

  return graph;
}

module.exports = { readScriptGraph, scriptTags, inspect };
