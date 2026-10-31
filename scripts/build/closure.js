'use strict';

/**
 * The closure check (#27 AC5; safety: a missing file is a broken feature). Starting from
 * manifest.json, it follows every path the package names: manifest keys, each page's src,
 * href, poster, data, and srcset, stylesheet url() and CSS imports, static and literal dynamic
 * imports, new Worker, importScripts, chrome.runtime.getURL, chrome.offscreen.createDocument's
 * url, chrome.tabs.create's url, and iconUrl, a shorthand `{ url }` or `{ iconUrl }` included. It
 * fails on a named path the package lacks; on an import of a bare specifier, which nothing
 * resolves without a bundler or an import map; on a file nothing names that
 * build/static-assets.json doesn't list; and on a path of any of those kinds built at run time
 * in first-party code, which it couldn't follow (#89's review: terser folds some constants into
 * literals, so a development build shipped them unchecked). A vendored file's own paths are its
 * record's, and the loader's (js/runtime/lazy.js, #27 slice 3) are its retry's, which it builds
 * from build-info.json's chunks, so each of those has to be in the package instead (AC5).
 *
 * Paths resolve as Chrome resolves them: imports, page attributes, and stylesheet URLs from
 * their own file; new Worker and importScripts from the page or worker that runs the script;
 * the chrome.* paths and iconUrl from the package root.
 */

const fs = require('node:fs');
const path = require('node:path');
const { problem } = require('./diagnostics.js');
const { scanScript } = require('./js-scan.js');
const { htmlTags, rawTextElements, cssUrls } = require('./markup.js');
const { readVendor } = require('./notices.js');
const { LOADER } = require('./vite-config.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */

const STATIC_ASSETS = path.join(__dirname, '..', '..', 'build', 'static-assets.json');

/**
 * LOADER is the one first-party file that builds a path at run time: its retry imports the file
 * build-info.json's chunks names. The bundler ships it at its own path, alone in its chunk
 * (scripts/build/vite-config.js), so it names the same file in the sources and in a build.
 */

/**
 * build-info.json's chunks in `files`, the map the loader's retry reads, or {} without one
 * @param {PackageFiles} files
 * @returns {Record<string, unknown>}
 */
function packagedChunks(files) {
  if (!files.has('build-info.json')) return {};
  try {
    const { chunks } = JSON.parse(files.text('build-info.json'));
    return chunks && typeof chunks === 'object' ? chunks : {};
  } catch {
    // A build-info.json that doesn't parse is npm run package's to report (readBuildInfo)
    return {};
  }
}

/** Manifest keys that name one file */
const MANIFEST_FILES = [
  ['background', 'service_worker'],
  ['chrome_url_overrides', 'newtab'],
  ['chrome_url_overrides', 'history'],
  ['chrome_url_overrides', 'bookmarks'],
  ['side_panel', 'default_path'],
  ['action', 'default_popup'],
  ['options_ui', 'page'],
  ['options_page'],
  ['devtools_page'],
];

/** Page attributes that name a file */
const URL_ATTRIBUTES = ['src', 'href', 'poster', 'data'];

/**
 * What takes each kind of path a script names, for the problem when it's built at run time.
 * A static import's specifier is always a literal.
 * @type {Record<import('./js-scan.js').ReferenceKind, string>}
 */
const NON_LITERAL = {
  import: 'An import',
  'dynamic-import': 'import()',
  worker: 'new Worker()',
  'worker-url': 'new Worker(new URL())',
  'import-scripts': 'importScripts()',
  'get-url': 'chrome.runtime.getURL',
  'offscreen-document': 'chrome.offscreen.createDocument\'s url',
  'tabs-create': 'chrome.tabs.create\'s url',
  'icon-url': 'iconUrl',
};

/** @typedef {'page' | 'stylesheet' | 'script' | 'other'} Kind */

/**
 * @typedef {object} StaticAssets
 * @property {Set<string>} files
 * @property {string[]} directories - each ending in /
 */

/**
 * The static assets the package may hold without anything naming them
 * @param {string} [file]
 * @returns {StaticAssets}
 */
function staticAssets(file = STATIC_ASSETS) {
  const listed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const paths = (/** @type {unknown} */ rows) => (Array.isArray(rows) ? rows.map((row) => String(row.path)) : []);
  return { files: new Set(paths(listed.files)), directories: paths(listed.directories) };
}

/**
 * Whether the static assets list `file`. A directory row covers only scripts, so any other
 * file under it still has to be named.
 * @param {StaticAssets} assets
 * @param {string} file
 * @returns {boolean}
 */
function isListed(assets, file) {
  if (assets.files.has(file)) return true;
  return /\.m?js$/.test(file) && assets.directories.some((dir) => file.startsWith(dir));
}

/**
 * What kind of file a path is, by its extension
 * @param {string} file
 * @returns {Kind}
 */
function kindOf(file) {
  if (/\.html?$/i.test(file)) return 'page';
  if (/\.css$/i.test(file)) return 'stylesheet';
  if (/\.m?js$/i.test(file)) return 'script';
  return 'other';
}

/**
 * The package path `value` names, resolved against the directory `base` ('' for the root);
 * 'elsewhere' for a URL outside the package, a fragment, or nothing; 'outside' for a path
 * that climbs out of the package
 * @param {string} value
 * @param {string} base
 * @returns {string}
 */
function resolve(value, base) {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) return 'elsewhere';
  let pathname = trimmed;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(trimmed);
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'chrome-extension') return 'elsewhere';
    pathname = trimmed.replace(/^chrome-extension:\/\/[^/]*/i, '');
  }
  pathname = pathname.replace(/[?#].*$/, '');
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Not percent-encoded as a URL would be; Chrome opens the path as written
  }
  // A directory, such as the package root getURL('') names, isn't a file to look for
  if (pathname === '' || pathname.endsWith('/')) return 'elsewhere';
  const joined = pathname.startsWith('/') ? pathname.slice(1) : path.posix.join(base, pathname);
  const normalized = path.posix.normalize(joined);
  if (normalized === '..' || normalized.startsWith('../')) return 'outside';
  if (normalized === '.') return 'elsewhere';
  return normalized;
}

/**
 * The paths a manifest names, as [key, path]
 * @param {any} manifest
 * @returns {Array<[string, string]>}
 */
function manifestPaths(manifest) {
  /** @type {Array<[string, string]>} */
  const found = [];
  for (const keys of MANIFEST_FILES) {
    const value = keys.reduce((object, key) => (object && typeof object === 'object' ? object[key] : undefined), manifest);
    if (typeof value === 'string') found.push([keys.join('.'), value]);
  }
  const icons = (/** @type {string} */ key, /** @type {unknown} */ value) => {
    if (typeof value === 'string') found.push([key, value]);
    else if (value && typeof value === 'object') {
      for (const [size, file] of Object.entries(value)) if (typeof file === 'string') found.push([`${key}.${size}`, file]);
    }
  };
  icons('icons', manifest.icons);
  icons('action.default_icon', manifest.action && manifest.action.default_icon);
  const lists = (/** @type {string} */ key, /** @type {unknown} */ entries, /** @type {string[]} */ fields) => {
    if (!Array.isArray(entries)) return;
    entries.forEach((entry, i) => {
      for (const field of fields) {
        const files = entry && entry[field];
        if (Array.isArray(files)) files.forEach((file) => { if (typeof file === 'string' && !file.includes('*')) found.push([`${key}[${i}].${field}`, file]); });
      }
    });
  };
  lists('content_scripts', manifest.content_scripts, ['js', 'css']);
  lists('web_accessible_resources', manifest.web_accessible_resources, ['resources']);
  if (manifest.sandbox && Array.isArray(manifest.sandbox.pages)) {
    manifest.sandbox.pages.forEach((/** @type {unknown} */ file, /** @type {number} */ i) => { if (typeof file === 'string') found.push([`sandbox.pages[${i}]`, file]); });
  }
  return found;
}

/**
 * Check that the package's references close over its files
 * @param {PackageFiles} files
 * @param {{staticAssets?: StaticAssets, vendored?: Set<string>, chunks?: Record<string, unknown>}} [options] -
 *   vendored: the package's vendored files (js/lib/vendor.json), whose own run-time paths aren't
 *   followed; chunks: build-info.json's, the files the loader's retry imports, by default the
 *   package's own build-info.json's (the build checks before it writes one)
 * @returns {{problems: Problem[], referenced: Set<string>}}
 */
function checkClosure(files, { staticAssets: assets = staticAssets(), vendored = new Set(readVendor().keys()), chunks = packagedChunks(files) } = {}) {
  /** @type {Problem[]} */
  const problems = [];
  /** @type {Set<string>} */
  const referenced = new Set(['manifest.json']);
  /** @type {Array<{file: string, base: string}>} */
  const pending = [];
  const followed = new Set();

  /**
   * Follow a reference from `from`: `value` resolved against `base`, read as `kind` of file
   * @param {string} from
   * @param {string} what
   * @param {string} value
   * @param {string} base
   * @param {string} [scriptBase] - where a script it names resolves new Worker and importScripts
   */
  const follow = (from, what, value, base, scriptBase) => {
    const target = resolve(value, base);
    if (target === 'elsewhere') return;
    if (target === 'outside') {
      problems.push(problem('closure/missing', value, `${what} in ${from} resolves outside the package`));
      return;
    }
    if (!files.has(target)) {
      problems.push(problem('closure/missing', target, `${what} in ${from}, but ${files.label} doesn't have it`));
      return;
    }
    referenced.add(target);
    const contextBase = kindOf(target) === 'script' ? (scriptBase ?? path.posix.dirname(target).replace(/^\.$/, '')) : '';
    const key = `${target}\0${contextBase}`;
    if (!followed.has(key)) {
      followed.add(key);
      pending.push({ file: target, base: contextBase });
    }
  };

  if (!files.has('manifest.json')) {
    problems.push(problem('closure/missing', 'manifest.json', `${files.label} has no manifest.json`));
    return { problems, referenced };
  }
  let manifest;
  try {
    manifest = JSON.parse(files.text('manifest.json'));
  } catch (error) {
    problems.push(problem('build/manifest', 'manifest.json', `doesn't parse: ${error instanceof Error ? error.message : error}`));
    return { problems, referenced };
  }
  for (const [key, value] of manifestPaths(manifest)) {
    // The service worker runs its scripts from its own directory; pages from theirs
    follow('manifest.json', `names it as ${key}`, value, '');
  }
  // The loader's retry imports these from the package root, so each has to be in the package
  for (const [name, value] of Object.entries(chunks)) {
    const target = typeof value === 'string' ? resolve(value, '') : 'outside';
    if (target !== 'elsewhere' && target !== 'outside' && files.has(target)) referenced.add(target);
    else problems.push(problem('closure/missing', String(value), `build-info.json names it as chunks.${name}, the file the loader's retry imports, but ${files.label} doesn't have it`));
  }

  while (pending.length > 0) {
    const next = pending.shift();
    if (!next) break;
    const { file, base } = next;
    const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    const kind = kindOf(file);

    if (kind === 'page') {
      const html = files.text(file);
      for (const tag of htmlTags(html)) {
        for (const name of URL_ATTRIBUTES) {
          const value = tag.attributes.get(name);
          if (value === undefined) continue;
          // A page's scripts resolve workers against the page
          follow(file, `<${tag.name} ${name}> at ${tag.at}`, value, dir, dir);
        }
        const srcset = tag.attributes.get('srcset');
        if (srcset) {
          for (const candidate of srcset.split(',')) {
            const url = candidate.trim().split(/\s+/)[0];
            if (url) follow(file, `<${tag.name} srcset> at ${tag.at}`, url, dir);
          }
        }
        const style = tag.attributes.get('style');
        if (style) cssUrls(style).forEach(({ value }) => follow(file, `a style attribute at ${tag.at}`, value, dir));
      }
      for (const element of rawTextElements(html)) {
        if (element.name === 'style') cssUrls(element.body).forEach(({ value }) => follow(file, `its <style> at ${element.at}`, value, dir));
      }
    } else if (kind === 'stylesheet') {
      for (const { value, at } of cssUrls(files.text(file))) follow(file, `url() at ${at}`, value, dir);
    } else if (kind === 'script') {
      const scan = scanScript(file, files.text(file));
      for (const { kind: referenceKind, value, at } of scan.references) {
        const where = `${file}:${at}`;
        if (value === null) {
          // A vendored library's own run-time paths are its record's business (js/lib/vendor.json),
          // and the loader's are its retry's, from build-info.json's chunks
          if (!vendored.has(file) && file !== LOADER) {
            problems.push(problem('closure/non-literal', where, `${NON_LITERAL[referenceKind]} gets a path built at run time, which the closure check can't follow. Pass a string literal.`));
          }
          continue;
        }
        if (referenceKind === 'import' || referenceKind === 'dynamic-import') {
          // A bare specifier names a package, which Chrome resolves only through an import map. A
          // URL is elsewhere, and the remote-code scan's.
          if (!/^(?:\.{0,2}\/|[a-z][a-z\d+.-]*:)/i.test(value)) {
            problems.push(problem('closure/missing', where, `${NON_LITERAL[referenceKind]} of "${value}": a bare specifier, which nothing resolves without a bundler or an import map`));
            continue;
          }
          follow(file, `${referenceKind === 'import' ? 'imported' : 'import()ed'} at ${at}`, value, dir, base);
        } else if (referenceKind === 'worker') {
          follow(file, `new Worker() at ${at}`, value, base);
        } else if (referenceKind === 'worker-url') {
          // new URL(path, import.meta.url): against the script itself, wherever it runs
          follow(file, `new Worker(new URL()) at ${at}`, value, dir);
        } else if (referenceKind === 'import-scripts') {
          follow(file, `importScripts() at ${at}`, value, base, base);
        } else {
          /** @type {Record<string, string>} */
          const names = {
            'get-url': 'chrome.runtime.getURL',
            'offscreen-document': 'chrome.offscreen.createDocument',
            'tabs-create': 'chrome.tabs.create',
            'icon-url': 'iconUrl',
          };
          follow(file, `${names[referenceKind]} at ${at}`, value, '');
        }
      }
    }
  }

  for (const file of files.paths) {
    if (!referenced.has(file) && !isListed(assets, file)) {
      problems.push(problem('closure/unreferenced', file, `nothing in ${files.label} names it, and build/static-assets.json doesn't list it`));
    }
  }
  return { problems, referenced };
}

/**
 * Each page preloads exactly the chunks its module scripts import, statically and through each
 * other (#27 slice 2: the bundler writes these links, which replaced scripts/module-preloads.js).
 * A missing preload costs a round trip per import level, and a preload of anything else fetches
 * code the page doesn't run at start (`closure/preload`).
 * @param {PackageFiles} files
 * @returns {Problem[]}
 */
function checkPreloads(files) {
  /** @type {Problem[]} */
  const problems = [];
  for (const page of files.paths.filter((file) => kindOf(file) === 'page')) {
    const dir = path.posix.dirname(page) === '.' ? '' : path.posix.dirname(page);
    /** @type {string[]} */
    const entries = [];
    /** @type {Set<string>} */
    const preloads = new Set();
    for (const tag of htmlTags(files.text(page))) {
      const src = tag.attributes.get('src');
      const href = tag.attributes.get('href');
      if (tag.name === 'script' && (tag.attributes.get('type') || '').trim().toLowerCase() === 'module' && src) entries.push(resolve(src, dir));
      if (tag.name === 'link' && /(^|\s)modulepreload(\s|$)/i.test(tag.attributes.get('rel') || '') && href) preloads.add(resolve(href, dir));
    }
    /** @type {Set<string>} */
    const imported = new Set();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = /** @type {string} */ (queue.shift());
      if (!files.has(file) || kindOf(file) !== 'script') continue;
      const base = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
      for (const { kind, value } of scanScript(file, files.text(file)).references) {
        if (kind !== 'import' || value === null) continue;
        const target = resolve(value, base);
        if (target === 'elsewhere' || target === 'outside' || entries.includes(target) || imported.has(target)) continue;
        imported.add(target);
        queue.push(target);
      }
    }
    for (const file of imported) {
      if (!preloads.has(file)) problems.push(problem('closure/preload', page, `doesn't preload ${file}, which its module scripts import`));
    }
    for (const file of preloads) {
      if (!imported.has(file)) problems.push(problem('closure/preload', page, `preloads ${file}, which its module scripts don't import at start`));
    }
  }
  return problems;
}

/**
 * A script a page loads without type="module" runs as a classic script, which can't parse an
 * import or export statement or import.meta, so none of it runs (`build/load-mode`)
 * @param {PackageFiles} files
 * @returns {Problem[]}
 */
function checkClassicScripts(files) {
  /** @type {Problem[]} */
  const problems = [];
  for (const page of files.paths.filter((file) => kindOf(file) === 'page')) {
    const dir = path.posix.dirname(page) === '.' ? '' : path.posix.dirname(page);
    for (const tag of htmlTags(files.text(page))) {
      const src = tag.attributes.get('src');
      if (tag.name !== 'script' || !src || (tag.attributes.get('type') || '').trim().toLowerCase() === 'module') continue;
      const file = resolve(src, dir);
      if (!files.has(file) || kindOf(file) !== 'script') continue;
      const [first] = scanScript(file, files.text(file)).moduleSyntax;
      if (first !== undefined) {
        problems.push(problem('build/load-mode', file, `${page} loads it as a classic script at ${tag.at}, but it has an import or export statement or import.meta at ${first}, which only a module parses`));
      }
    }
  }
  return problems;
}

module.exports = { checkClosure, checkPreloads, checkClassicScripts, staticAssets, isListed, resolve, manifestPaths, packagedChunks, STATIC_ASSETS };
