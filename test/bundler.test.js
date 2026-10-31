'use strict';

// #27 slice 2, the bundler swap: the bundler's configuration (scripts/build/vite-config.js), how
// the build reads what the bundler reports and refuses (scripts/build/bundle.js), the inputs it
// lists (scripts/build/inputs.js), the background's own checks (scripts/build/background.js), the
// checks on the modules the bundle holds, the pages as the bundler reads them, the indexer's
// starter, and what git ignores. Nothing here runs the bundler: npm run verify:fixtures builds
// each rule's fixture, and every build checks what it wrote.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../scripts/build/vite-config.js');
const { bundlerProblem, warningProblem, chunkNames, moduleMap, commonJsProblems, loaderProblems, sourcePath, keepingLogger } = require('../scripts/build/bundle.js');
const { checkCommonJs } = require('../scripts/build/commonjs.js');
const { BUILD_INPUTS, SOURCE_DIRS, listedInputs, buildEntries } = require('../scripts/build/inputs.js');
const { checkBackgroundSources, pageGlobalReads, loadingProblems } = require('../scripts/build/background.js');
const { checkSourceEnvironment } = require('../scripts/build/environment.js');
const { checkBundledVendor, readVendor } = require('../scripts/build/notices.js');
const { checkClosure, resolve } = require('../scripts/build/closure.js');
const { scanScript } = require('../scripts/build/js-scan.js');
const { htmlTags, rawTextElements } = require('../scripts/build/markup.js');
const { fromMap } = require('../scripts/build/package-files.js');
const { parse: parseCss, walk, splitTopLevel } = require('../scripts/css-parser.js');
const { ROOT, sourcePackage, filesUnder } = require('./helpers/source-package.js');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MANIFEST = JSON.parse(read('manifest.json'));
const PAGES = Object.values(config.PAGES);

/** What a pass's configuration takes, reporting into an empty report */
function passOptions(mode = 'production') {
  return { root: '/repo', outDir: '/repo/.dist-staging-x', mode, buildId: 'build-x', report: { chunks: [], assets: [] }, logger: /** @type {any} */ ({}), onLog: () => {} };
}

/** A chunk as the report plugin records one */
function chunk(pass, name, fileName, fields = {}) {
  return { pass, name, fileName, isEntry: false, isDynamicEntry: false, facadeModuleId: null, moduleIds: [], imports: [], commonJs: [], ...fields };
}

/** A page's <script src> tags */
function scripts(page) {
  return htmlTags(read(page)).filter((tag) => tag.name === 'script' && tag.attributes.has('src'));
}

const isModule = (tag) => (tag.attributes.get('type') || '').trim().toLowerCase() === 'module';

/**
 * The modules a graph reaches from `entries` in the sources, as the bundler folds them in:
 * static imports, import(), and the module workers it starts. js/lib/ only with `vendored`.
 */
function graphFrom(entries, { vendored = false } = {}) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { kind, value } of scanScript(file, read(file)).references) {
      if (!['import', 'dynamic-import', 'worker-url'].includes(kind) || value === null) continue;
      const target = resolve(value, path.posix.dirname(file));
      if (fs.existsSync(path.join(ROOT, target))) queue.push(target);
    }
  }
  return [...seen].filter((file) => vendored || !file.startsWith('js/lib/')).sort();
}

const PAGE_ENTRIES = PAGES.flatMap((page) => scripts(page).filter(isModule).map((tag) => resolve(tag.attributes.get('src'), '')));

/** CSS as the bundler minifies a page's stylesheets: lightningcss, at the build's targets */
function minifiedCss(text) {
  const { transform } = require('lightningcss');
  return Buffer.from(transform({ filename: 'page.css', code: Buffer.from(text), minify: true, targets: config.lightningcssTargets() }).code).toString('utf8');
}

/** A rule's key: the at-rules and rules around it, then one selector of its list */
const ruleKey = (ancestors, selector) => [...ancestors.map((node) => (node.type === 'at-rule' ? `@${node.name} ${node.prelude}` : node.prelude)), selector].join(' || ');

/** Each key a source selector has in lightningcss's output, from the selector minified alone */
const outputKeys = new Map();
function keysOf(ancestors, selector) {
  const snippet = ancestors.reduceRight((inner, node) => `${node.type === 'at-rule' ? `@${node.name} ${node.prelude}` : node.prelude}{${inner}}`, `${selector}{color:red}`);
  if (!outputKeys.has(snippet)) {
    const keys = [];
    walk(parseCss(minifiedCss(snippet)), (node, around) => {
      if (node.type === 'rule' && node.declarations.length > 0) splitTopLevel(node.prelude).forEach((one) => keys.push(ruleKey(around, one)));
    });
    outputKeys.set(snippet, keys);
  }
  return outputKeys.get(snippet);
}

/**
 * The unprefixed declarations of a page's stylesheets that its minified CSS holds only in a
 * prefixed form, as `file:line selector property`. Each source selector is matched with the
 * output's by minifying it alone, and the output's selector lists are split, so a rule the
 * minifier merges with another still matches.
 * @param {Array<{file: string, text: string}>} sheets - in the order the page links them
 * @returns {string[]}
 */
function prefixOnly(sheets) {
  /** @type {Map<string, Set<string>>} */
  const output = new Map();
  walk(parseCss(minifiedCss(sheets.map(({ text }) => text).join('\n'))), (node, ancestors) => {
    if (node.type !== 'rule') return;
    for (const selector of splitTopLevel(node.prelude)) {
      const key = ruleKey(ancestors, selector);
      if (!output.has(key)) output.set(key, new Set());
      node.declarations.forEach(({ property }) => output.get(key).add(property));
    }
  });
  const found = new Set();
  for (const { file, text } of sheets) {
    walk(parseCss(text), (node, ancestors) => {
      if (node.type !== 'rule') return;
      for (const selector of splitTopLevel(node.prelude)) {
        for (const key of keysOf(ancestors, selector)) {
          const kept = output.get(key);
          if (!kept) continue;
          for (const { property, line } of node.declarations) {
            if (property.startsWith('-') || kept.has(property)) continue;
            if ([...kept].some((name) => /^-[a-z]+-/.test(name) && name.replace(/^-[a-z]+-/, '') === property)) found.add(`${file}:${line} ${selector} ${property}`);
          }
        }
      }
    });
  }
  return [...found];
}

describe("the bundler's configuration (scripts/build/vite-config.js)", () => {
  it("builds the four pages as HTML entries, and the service worker in a pass of its own as one file at the manifest's path", () => {
    const pages = config.pagesConfig(passOptions());
    assert.deepEqual(pages.build.rolldownOptions.input, {
      newtab: '/repo/newtab.html', popup: '/repo/popup.html', sidepanel: '/repo/sidepanel.html', offscreen: '/repo/offscreen.html',
    });
    const background = config.backgroundConfig(passOptions());
    assert.deepEqual(background.build.rolldownOptions.input, { background: '/repo/js/background.js' });
    const { output } = background.build.rolldownOptions;
    assert.deepEqual([output.format, output.entryFileNames, output.codeSplitting], ['es', 'js/background.js', false]);
    assert.equal(background.build.modulePreload, false);
    assert.deepEqual(MANIFEST.background, { service_worker: config.BACKGROUND_ENTRY, type: 'module' });
    // Both passes write into the one staging directory, which the build empties itself
    for (const pass of [pages, background]) assert.deepEqual([pass.build.outDir, pass.build.emptyOutDir], ['/repo/.dist-staging-x', false]);
    // Chrome 116 has modulepreload, so the polyfill would only add code
    assert.deepEqual(pages.build.modulePreload, { polyfill: false });
  });

  it("minifies JavaScript with terser in production only and CSS with lightningcss in both, writes no source map, reads no config or .env file, and inlines NODE_ENV and the build's ID alone, with no CommonJS module", () => {
    for (const mode of ['production', 'development']) {
      for (const pass of [config.pagesConfig(passOptions(mode)), config.backgroundConfig(passOptions(mode))]) {
        assert.equal(pass.build.minify, mode === 'production' ? 'terser' : false, mode);
        assert.equal(pass.build.cssMinify, 'lightningcss');
        assert.equal(pass.build.sourcemap, false);
        // Every asset stays a file the closure check follows, never a data: URL
        assert.equal(pass.build.assetsInlineLimit, 0);
        assert.deepEqual([pass.configFile, pass.envDir, pass.publicDir, pass.build.copyPublicDir], [false, false, false, false]);
        assert.equal(pass.mode, mode);
        assert.deepEqual(pass.define, { 'process.env.NODE_ENV': JSON.stringify(mode), __NTN_BUILD_ID__: JSON.stringify('build-x'), module: 'undefined' });
      }
    }
  });

  it("turns off only the bundler's timing check, whose warning says how busy the machine is, in every pass and the workers' build", () => {
    // Any warning fails the build, and under load this one failed five fixtures' builds
    const pages = config.pagesConfig(passOptions());
    const background = config.backgroundConfig(passOptions());
    for (const options of [pages.build.rolldownOptions, pages.worker.rolldownOptions, background.build.rolldownOptions]) {
      assert.deepEqual(options.checks, { bundlerTimings: false });
    }
  });

  it('targets the Chrome version the manifest asks for, in JavaScript and in CSS', () => {
    assert.equal(MANIFEST.minimum_chrome_version, String(config.MINIMUM_CHROME_VERSION));
    assert.equal(config.TARGET, `chrome${config.MINIMUM_CHROME_VERSION}`);
    for (const pass of [config.pagesConfig(passOptions()), config.backgroundConfig(passOptions())]) {
      assert.deepEqual([pass.build.target, pass.build.cssTarget], [config.TARGET, config.TARGET]);
    }
    assert.deepEqual(config.lightningcssTargets(), { chrome: config.MINIMUM_CHROME_VERSION << 16 });
  });

  it('keeps license comments, and leaves out the unsafe compress options', () => {
    assert.equal(config.TERSER_OPTIONS.format.comments, config.LICENSE_COMMENTS);
    for (const comment of ['! Fuse.js v7.0.0', '*\n * @license MIT', ' @preserve', '* @copyright 2024 someone', ' Licensed under the Apache license']) {
      assert.match(comment, config.LICENSE_COMMENTS, comment);
    }
    assert.doesNotMatch(' a plain comment', config.LICENSE_COMMENTS);
    assert.deepEqual(Object.keys(config.TERSER_OPTIONS.compress).filter((key) => key.startsWith('unsafe')), []);
  });

  it("gives each call its own copy of terser's options, since terser writes into the ones it's given", async () => {
    const before = JSON.stringify(config.TERSER_OPTIONS);
    const options = config.terserOptions();
    options.compress.module = 'changed';
    // terser writes module: true into the nested objects it's handed
    await require('terser').minify('export const x = 1;', { ...config.terserOptions(), module: true });
    assert.equal(JSON.stringify(config.TERSER_OPTIONS), before);
    assert.equal(config.terserOptions().compress.module, undefined);
    assert.notStrictEqual(config.pagesConfig(passOptions()).build.terserOptions, config.pagesConfig(passOptions()).build.terserOptions);
  });

  it("minifies a module worker's chunk with the same options in production, which Vite's own terser doesn't reach, and leaves it alone in development", async () => {
    const plugins = (mode) => config.pagesConfig(passOptions(mode)).worker.plugins();
    assert.deepEqual(plugins('production').map(({ name }) => name), ['ntn:report', 'ntn:worker-terser']);
    assert.deepEqual(plugins('development').map(({ name }) => name), ['ntn:report']);
    const [, terser] = plugins('production');
    const result = await terser.renderChunk('/*! Kept, MIT */\nexport function longName(argument) { return argument + 1; }\n// dropped\n', {}, { format: 'es' });
    assert.match(result.code, /^\/\*! Kept, MIT \*\//);
    assert.doesNotMatch(result.code, /dropped|argument/);
    assert.match(result.code, /export function longName\(/);
    // The bundler writes what terser gave it, instead of printing it again
    const worker = config.pagesConfig(passOptions()).worker;
    assert.deepEqual([worker.format, worker.rolldownOptions.output.minify], ['es', false]);
  });

  it('records what each pass wrote: every chunk with the modules it holds, and every asset', () => {
    const options = passOptions();
    const [pagesReport] = config.pagesConfig(options).plugins;
    const [backgroundReport] = config.backgroundConfig(options).plugins;
    pagesReport.generateBundle({}, {
      'assets/newtab-A1.js': { type: 'chunk', fileName: 'assets/newtab-A1.js', name: 'newtab', isEntry: true, isDynamicEntry: false, facadeModuleId: '/repo/newtab.html', moduleIds: ['/repo/js/main.js'], imports: ['assets/host-B2.js'] },
      'assets/newtab-C3.css': { type: 'asset', fileName: 'assets/newtab-C3.css' },
    });
    backgroundReport.generateBundle({}, {
      'js/background.js': { type: 'chunk', fileName: 'js/background.js', name: 'background', isEntry: true, isDynamicEntry: false, facadeModuleId: '/repo/js/background.js', moduleIds: ['/repo/js/background.js'], imports: [] },
    });
    assert.deepEqual(options.report, {
      chunks: [
        chunk('pages', 'newtab', 'assets/newtab-A1.js', { isEntry: true, facadeModuleId: '/repo/newtab.html', moduleIds: ['/repo/js/main.js'], imports: ['assets/host-B2.js'] }),
        chunk('background', 'background', 'js/background.js', { isEntry: true, facadeModuleId: '/repo/js/background.js', moduleIds: ['/repo/js/background.js'] }),
      ],
      assets: [{ pass: 'pages', fileName: 'assets/newtab-C3.css' }],
    });
  });

  it("keeps an icon's own name under icons/, which the manifest and the service worker name, and hashes every other asset under assets/", () => {
    assert.equal(config.assetFileName({ originalFileNames: ['icons/icon48.png'] }), 'icons/[name][extname]');
    assert.equal(config.assetFileName({ originalFileNames: ['icons/icon16.png', 'icons/icon48.png'] }), 'icons/[name][extname]');
    for (const originalFileNames of [['css/a.png'], ['icons/a.png', 'css/a.png'], [], undefined]) {
      assert.equal(config.assetFileName({ originalFileNames }), 'assets/[name]-[hash][extname]', JSON.stringify(originalFileNames));
    }
  });

  it("copies the static files no page or script imports, each there, with the manifest's icons and no icon source", () => {
    for (const file of config.STATIC_FILES) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    for (const icon of [...Object.values(MANIFEST.icons), ...Object.values(MANIFEST.action.default_icon)]) assert.ok(config.STATIC_FILES.includes(icon), icon);
    assert.deepEqual(config.STATIC_FILES.filter((file) => file.endsWith('.svg')), []);
  });
});

describe('the pages as the bundler reads them', () => {
  it("load each classic script with vite-ignore, which keeps the bundler off it, and CLASSIC_SCRIPTS lists those and the libraries the loader puts in", () => {
    const classic = PAGES.flatMap((page) => scripts(page).filter((tag) => !isModule(tag)).map((tag) => {
      assert.ok(tag.attributes.has('vite-ignore'), `${page} loads ${tag.attributes.get('src')} without vite-ignore`);
      return tag.attributes.get('src');
    }));
    assert.deepEqual(classic.sort(), ['js/entries/boot-guard.js', 'js/insights-summary.js']);
    // #27 slice 3: the vendored libraries load at their first use, as classic scripts the loader puts in
    const loaded = [...read(config.LOADER).matchAll(/chrome\.runtime\.getURL\('([^']+)'\)/g)].map(([, file]) => file);
    assert.deepEqual(loaded.sort(), ['js/lib/chart.js', 'js/lib/fuse.js', 'js/lib/jszip.min.js', 'js/lib/transformers.js']);
    assert.deepEqual([...classic, ...loaded].sort(), Object.keys(config.CLASSIC_SCRIPTS).sort());
    const vendor = readVendor();
    for (const [file, how] of Object.entries(config.CLASSIC_SCRIPTS)) {
      // A vendored library ships byte for byte, as its record pins it; first-party code minified
      assert.equal(how, file.startsWith('js/lib/') ? 'as-is' : 'minify', file);
      if (how === 'as-is') assert.ok(vendor.has(file), file);
    }
  });

  it("load their own code as module scripts, offscreen.html's included, so what each imports resolves in the pages pass as the worker's does in its own", () => {
    const modules = Object.fromEntries(PAGES.map((page) => [page, scripts(page).filter(isModule).map((tag) => tag.attributes.get('src'))]));
    assert.deepEqual(modules, { 'newtab.html': ['js/entries/newtab.js'], 'popup.html': ['js/popup.js'], 'sidepanel.html': ['js/sidepanel.js'], 'offscreen.html': ['js/offscreen.js'] });
    for (const page of PAGES) for (const tag of scripts(page).filter(isModule)) assert.equal(tag.attributes.has('vite-ignore'), false, page);
    assert.equal(Object.hasOwn(config.CLASSIC_SCRIPTS, 'js/offscreen.js'), false);
  });

  it('hold no inline style, no inline script but a JSON data block, and no module preload, which the bundler writes', () => {
    for (const page of PAGES) {
      const html = read(page);
      for (const element of rawTextElements(html)) {
        assert.notEqual(element.name, 'style', `${page} has a <style> at ${element.at}`);
        if (element.attributes.has('src') || element.body.trim() === '') continue;
        assert.match(element.attributes.get('type') || '', /^application\/(ld\+)?json$/i, `${page} has an inline script at ${element.at}`);
      }
      assert.deepEqual(htmlTags(html).filter((tag) => tag.name === 'link' && /modulepreload/i.test(tag.attributes.get('rel') || '')), [], page);
    }
  });

  it("link stylesheets lightningcss reads with no warning at the build's targets, popup's and the side panel's in files of their own", () => {
    const { transform } = require('lightningcss');
    const sheets = PAGES.flatMap((page) => htmlTags(read(page))
      .filter((tag) => tag.name === 'link' && tag.attributes.get('rel') === 'stylesheet')
      .map((tag) => tag.attributes.get('href')));
    assert.deepEqual(sheets.sort(), ['css/editor.css', 'css/popup.css', 'css/premium-chat.css', 'css/sidepanel.css', 'css/stats.css']);
    for (const sheet of sheets) {
      const result = transform({ filename: sheet, code: Buffer.from(read(sheet)), minify: true, targets: config.lightningcssTargets() });
      assert.deepEqual(result.warnings, [], sheet);
    }
  });

  it("keep every unprefixed declaration through lightningcss: none comes out only in a prefixed form, which Chrome may ignore", () => {
    // lightningcss takes backdrop-filter and -webkit-backdrop-filter for one property and keeps
    // the last, and Chrome doesn't support the prefixed one, so the AI chat's ticker and tool
    // cards lost their blur (#99's review). Each page's stylesheets, as the bundler minifies them
    for (const page of PAGES) {
      const sheets = htmlTags(read(page))
        .filter((tag) => tag.name === 'link' && tag.attributes.get('rel') === 'stylesheet')
        .map((tag) => ({ file: /** @type {string} */ (tag.attributes.get('href')), text: read(/** @type {string} */ (tag.attributes.get('href'))) }));
      assert.deepEqual(prefixOnly(sheets), [], page);
    }
    // The check itself: in one rule, in two the minifier merges, in a media query with a selector
    // list, and in the order lightningcss keeps the unprefixed one
    const one = (text) => prefixOnly([{ file: 'a.css', text }]);
    assert.deepEqual(one('.a {\n  backdrop-filter: blur(1px);\n  -webkit-backdrop-filter: blur(1px);\n}'), ['a.css:2 .a backdrop-filter']);
    assert.deepEqual(one('.a { backdrop-filter: blur(1px) }\n.a { -webkit-backdrop-filter: blur(1px) }'), ['a.css:1 .a backdrop-filter']);
    assert.deepEqual(one('@media (max-width: 640px) { .b, .c > d { backdrop-filter: blur(var(--x)); -webkit-backdrop-filter: blur(var(--x)) } }'), [
      'a.css:1 .b backdrop-filter', 'a.css:1 .c > d backdrop-filter',
    ]);
    assert.deepEqual(one('.a { -webkit-backdrop-filter: blur(1px); backdrop-filter: blur(1px) }'), []);
    assert.deepEqual(one('.a { -webkit-background-clip: text; background-clip: text }'), []);
  });
});

describe('the inputs a build lists (scripts/build/inputs.js)', () => {
  it("lists the pages, the background's entry, the classic scripts, and the static files, each there", () => {
    assert.deepEqual(listedInputs(), [...PAGES, config.BACKGROUND_ENTRY, ...Object.keys(config.CLASSIC_SCRIPTS), ...config.STATIC_FILES]);
    for (const file of listedInputs()) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  });

  it('reads every top-level entry the sources name, so a copy with only those builds as the tree does', () => {
    const entries = buildEntries();
    assert.deepEqual(entries, [...new Set(entries)].sort());
    for (const entry of [...BUILD_INPUTS, ...SOURCE_DIRS]) assert.ok(entries.includes(entry) && fs.existsSync(path.join(ROOT, entry)), entry);
    for (const entry of ['icons', 'manifest.json', 'newtab.html', 'LICENSE', 'THIRD_PARTY_NOTICES']) assert.ok(entries.includes(entry), entry);
    const { referenced } = checkClosure(sourcePackage());
    for (const file of referenced) assert.ok(entries.includes(file.split('/')[0]), file);
  });
});

describe('what the build reads from the bundler (scripts/build/bundle.js)', () => {
  it('names an error by what refused it, terser, the stylesheet pipeline, or the bundler, at the file and position', () => {
    const terser = bundlerProblem({ message: '\u001b[31mUnexpected token: punc (;)\u001b[39m\n', plugin: 'vite:terser', id: '/repo/js/a.js', loc: { line: 3, column: 4 } }, '/repo');
    assert.deepEqual([terser.code, terser.subject, terser.message], ['build/terser', 'js/a.js:3:5', 'terser refused it: Unexpected token: punc (;)']);
    const css = bundlerProblem({ message: 'Unexpected end of input', plugin: 'vite:css', id: '/repo/css/a.css' }, '/repo');
    assert.deepEqual([css.code, css.subject], ['build/css', 'css/a.css']);
    assert.deepEqual(['build/css', 'css/a.css'], [bundlerProblem({ message: 'x', id: '/repo/css/a.css?inline' }, '/repo').code, bundlerProblem({ message: 'x', id: '/repo/css/a.css?inline' }, '/repo').subject]);
    assert.equal(bundlerProblem({ message: '[lightningcss minify] Unexpected token' }, '/repo').code, 'build/css');
    // An error the bundler wraps names its plugin and file at the start of the message, as the
    // css-error fixture's @import of a missing file does
    const wrapped = bundlerProblem({ message: "[plugin vite:css] /repo/css/stats.css:undefined:NaN\nError: [postcss] ENOENT: no such file or directory, open 'gone.css'" }, '/repo');
    assert.deepEqual([wrapped.code, wrapped.subject], ['build/css', 'css/stats.css']);
    const unresolved = bundlerProblem({ message: 'Could not resolve "./gone.js" in js/a.js', id: '/repo/js/a.js' }, '/repo');
    assert.deepEqual([unresolved.code, unresolved.subject, unresolved.message], ['build/bundle', 'js/a.js', 'Could not resolve "./gone.js" in js/a.js']);
    assert.deepEqual([bundlerProblem(new Error('broke'), '/repo').code, bundlerProblem(new Error('broke'), '/repo').subject], ['build/bundle', 'the bundle']);
    // A module outside the sources keeps its id
    assert.equal(bundlerProblem({ message: 'x', id: '/elsewhere/b.js' }, '/repo').subject, '/elsewhere/b.js');
  });

  it("fails the build on every warning, a stylesheet's as build/css and any other as build/bundler-warning, with its detail", () => {
    const css = warningProblem('[vite:css][lightningcss] Unknown pseudo-class: ntn-unknown\n  css/premium-chat.css:900:13');
    assert.deepEqual([css.code, css.subject, css.details], ['build/css', 'the stylesheets', ['  css/premium-chat.css:900:13']]);
    assert.match(css.message, /A CSS warning fails the build as an error does\.$/);
    const other = warningProblem('<script src="js/x.js"> in "/popup.html" can\'t be bundled without type="module" attribute');
    assert.deepEqual([other.code, other.subject, other.details], ['build/bundler-warning', 'the bundle', undefined]);
    assert.match(other.message, /No bundler warning is reviewed as allowed\.$/);
    assert.equal(warningProblem(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')).details.length, 12);
  });

  it('reads a module id as a source path, through the root\'s real path too, and nothing else as one', () => {
    assert.equal(sourcePath('/repo/js/a.js', '/repo'), 'js/a.js');
    // A temporary directory on macOS is /var/..., and an id can come through /private/var/...
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ntn-bundler-'));
    try {
      assert.equal(sourcePath(path.join(fs.realpathSync(dir), 'js', 'a.js'), dir), 'js/a.js');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const id of ['\0vite/modulepreload-polyfill.js', '/repo/js/a.js?worker_file&type=module', '/elsewhere/a.js', '/repo/node_modules/valibot/index.mjs']) {
      assert.equal(sourcePath(id, '/repo'), null, id);
    }
  });

  it('names each chunk a loader addresses once, and fails two chunks of one name', () => {
    const report = { assets: [], chunks: [
      chunk('pages', 'newtab', 'assets/newtab-A1.js', { isEntry: true }),
      chunk('pages', 'host', 'assets/host-B2.js'),
      chunk('pages', 'trust', 'assets/trust-E5.js', { isDynamicEntry: true }),
      chunk('worker', 'indexer', 'assets/indexer-D4.js', { isEntry: true }),
      chunk('background', 'background', 'js/background.js', { isEntry: true }),
    ] };
    assert.deepEqual(chunkNames(report), {
      chunks: { background: 'js/background.js', indexer: 'assets/indexer-D4.js', newtab: 'assets/newtab-A1.js', trust: 'assets/trust-E5.js' },
      problems: [],
    });
    report.chunks.push(chunk('pages', 'trust', 'assets/trust-F6.js', { isDynamicEntry: true }));
    const { problems } = chunkNames(report);
    assert.deepEqual(problems.map(({ code, subject }) => `${code} ${subject}`), ['build/bundle trust']);
    assert.match(problems[0].message, /two chunks are named trust, assets\/trust-E5\.js and assets\/trust-F6\.js/);
  });

  it('maps each source module to the files that hold it, and splits the graphs by pass, the workers with the pages', () => {
    const report = { assets: [], chunks: [
      chunk('pages', 'newtab', 'assets/newtab-A1.js', { moduleIds: ['/repo/js/main.js', '/repo/js/utils.js', '\0vite/preload-helper.js', '/repo/css/editor.css'] }),
      chunk('worker', 'indexer', 'assets/indexer-D4.js', { moduleIds: ['/repo/js/workers/indexer.js'] }),
      chunk('background', 'background', 'js/background.js', { moduleIds: ['/repo/js/background.js', '/repo/js/utils.js', '/repo/node_modules/x/index.js'] }),
    ] };
    assert.deepEqual(moduleMap(report, '/repo'), {
      modules: {
        'js/background.js': ['js/background.js'],
        'js/main.js': ['assets/newtab-A1.js'],
        'js/utils.js': ['assets/newtab-A1.js', 'js/background.js'],
        'js/workers/indexer.js': ['assets/indexer-D4.js'],
      },
      graphs: { background: ['js/background.js', 'js/utils.js'], pages: ['js/main.js', 'js/utils.js', 'js/workers/indexer.js'] },
    });
  });

  it('keeps each warning Vite logs, a warnOnce once, and drops its info and its errors, which a pass also throws', () => {
    const warnings = [];
    const logger = keepingLogger(/** @type {any} */ ({ clearScreen() {} }), warnings);
    logger.info('built in 1s');
    logger.warn('\u001b[33m(!) a warning\u001b[39m\n');
    logger.warnOnce('once');
    logger.warnOnce('once');
    logger.error('failed');
    assert.deepEqual(warnings, ['(!) a warning', 'once']);
  });
});

describe('the background checks (scripts/build/background.js)', () => {
  const found = (text, imports = false) => loadingProblems('js/x.js', text, { imports }).map(({ code, what, at }) => `${code} ${what} ${at}`);

  it("finds what a worker can't load after it starts, and an await only at the top level", () => {
    assert.deepEqual(found("import './a.js';\nexport * from './b.js';\nimport('./c.js');\nimportScripts('d.js');\nself.importScripts('e.js');\nglobalThis.importScripts('f.js');", true), [
      'background/not-self-contained a static import 1:1',
      'background/not-self-contained a static import 2:1',
      'background/not-self-contained import() 3:1',
      'background/not-self-contained importScripts() 4:1',
      'background/not-self-contained importScripts() 5:1',
      'background/not-self-contained importScripts() 6:1',
    ]);
    // A module of the graph imports statically, which the bundler folds in
    assert.deepEqual(found("import './a.js';\nexport { x } from './b.js';"), []);
    assert.deepEqual(found('await a;\nfor await (const x of y) {}\nif (c) { await d; }'), [
      'background/top-level-await top-level await 1:1',
      'background/top-level-await top-level await 2:1',
      'background/top-level-await top-level await 3:10',
    ]);
    assert.deepEqual(found('async function f() { await a; }\nconst g = async () => { for await (const x of y) {} };\nclass C { async m() { await b; } }\nconst o = { async m() { await c; } };'), []);
  });

  it('reads every file as the module it loads as, so await (x) and await [x] count in a file with no import or export', () => {
    assert.deepEqual(found('await (a);\nawait [b];'), ['background/top-level-await top-level await 1:1', 'background/top-level-await top-level await 2:1']);
  });

  it('passes document and window behind each typeof check it knows, and nowhere else', () => {
    const guarded = [
      "const t = typeof document !== 'undefined' ? document.title : '';",
      "const t = typeof document === 'undefined' ? '' : document.title;",
      "const t = 'undefined' != typeof window ? window.name : '';",
      "const t = (typeof window !== 'undefined') ? window.name : '';",
      "const t = typeof document !== 'undefined' && document.title;",
      "const t = typeof document === 'undefined' || document.title;",
      "const t = a && typeof window !== 'undefined' && window.name;",
      "if (typeof window !== 'undefined') { window.x = 1; }",
      "if (typeof window === 'undefined') {} else { window.x = 1; }",
      "function f() { if (typeof document === 'undefined') return; document.title = 'x'; }",
      "for (;;) { if (typeof document === 'undefined') break; document.title = 'x'; }",
      "function f() { if (typeof document === 'undefined') { throw new Error('no page'); } return document.title; }",
      // Made after the exit, so it reads only where the check passed
      "function f() { if (typeof window === 'undefined') return null; const g = () => window.name; return g; }",
      'function f(document) { return document.title; }',
      'function f({ window }) { return window.name; }',
      'function f() { const window = {}; return window.name; }',
      'function f(x) { if (x) { var document = {}; } return document.title; }',
      'for (const document of pages) { document.title = 1; }',
      'try { run(); } catch (window) { window.name = 1; }',
      "import { document } from './dom.js'; document.title = 1;",
      'const { document } = page; document.title = 1;',
      'const f = function document() { return document.name; };',
      'const t = typeof document;',
      'const o = { document: 1, window: 2 }; o.document = o.window;',
    ];
    for (const text of guarded) assert.deepEqual(pageGlobalReads('js/x.js', text), [], text);
    const unguarded = [
      ['const t = document.title;', 'document'],
      ["const t = typeof document === 'undefined' ? document.title : '';", 'document'],
      ["const t = typeof window !== 'undefined' && document.title;", 'document'],
      ["const t = typeof document !== 'undefined' || document.title;", 'document'],
      ["if (typeof document !== 'undefined') {} else { document.title = 'x'; }", 'document'],
      ["function f() { if (typeof document !== 'undefined') return; document.title = 'x'; }", 'document'],
      // #99's delta: a function declaration is hoisted, so it exists, and can run, before the exit
      ["function f() { if (typeof window === 'undefined') return g; function g() { return window.name; } return null; }", 'window'],
      // A local of a block the read is outside of is gone by then
      ['function f(x) { if (x) { const document = 1; } return document.title; }', 'document'],
      ['function f() { { let window = 1; } return window.name; }', 'window'],
      ['for (const document of pages) {} document.title = 1;', 'document'],
      ['function g() { var window = 1; } window.name = 1;', 'window'],
      ["window.addEventListener('x', f);", 'window'],
    ];
    for (const [text, name] of unguarded) {
      assert.deepEqual(pageGlobalReads('js/x.js', text), [{ name, at: `1:${text.lastIndexOf(name) + 1}` }], text);
    }
  });

  it('reports each problem at its module and position, with what to do', () => {
    const text = "export const t = () => document.title;\nimport('./b.js');";
    const problems = checkBackgroundSources([{ file: 'js/a.js', text }]);
    assert.deepEqual(problems.map(({ code, subject }) => `${code} ${subject}`), ['background/not-self-contained js/a.js:2:1', `background/dom js/a.js:1:${text.indexOf('document') + 1}`]);
    assert.match(problems[0].message, /^import\(\) in the service worker's graph, which the worker can't run\. Import it statically\.$/);
    assert.match(problems[1].message, /^reads document, which the service worker doesn't have, outside a typeof check\. Guard it: typeof document !== 'undefined'\.$/);
  });
});

describe('the graphs in the sources, as the bundler folds them', () => {
  const background = graphFrom([config.BACKGROUND_ENTRY]);
  const pages = graphFrom(PAGE_ENTRIES);
  const all = graphFrom([...PAGE_ENTRIES, config.BACKGROUND_ENTRY], { vendored: true });

  it("reaches the kernel from the service worker, on the legacy adapter, and passes the background's checks", () => {
    for (const file of ['js/background.js', 'js/utils.js', 'js/storage.js', 'js/kernel/composition/background.js',
      'js/kernel/adapters/legacy/adapter.js', 'js/kernel/core/application/kernel.js']) {
      assert.ok(background.includes(file), file);
    }
    // js/utils.js's trapFocus reads document behind its typeof check (#27 slice 2)
    assert.deepEqual(checkBackgroundSources(background.map((file) => ({ file, text: read(file) }))), []);
  });

  it('read no environment variable but NODE_ENV in any first-party module either pass holds, the indexer included', () => {
    assert.ok(pages.includes('js/workers/indexer.js') && pages.includes('js/offscreen.js'));
    const modules = [...new Set([...pages, ...background])].map((file) => ({ file, text: read(file) }));
    assert.deepEqual(checkSourceEnvironment(modules), []);
  });

  it("hold no first-party module the bundler would wrap as CommonJS: the legacy files' dual export reads module only behind its typeof check, which the build defines as undefined, and none names exports or require", () => {
    // Wrapped, a legacy file would get a module object and take its Node branch, so the page
    // never gets its global (#27 slice 2's first extension run: "createLogger is not defined").
    // Any other read of module would be undefined.exports, which throws (#99's review).
    const modules = [...new Set([...pages, ...background])].map((file) => ({ file, text: read(file) }));
    // The vendored ones too, Valibot's build today (#99's delta), as the build checks them
    assert.deepEqual(checkCommonJs(all.map((file) => ({ file, text: read(file) }))), []);
    assert.ok(all.includes('js/lib/valibot/index.mjs'));
    const dual = modules.filter(({ text }) => /typeof module !== 'undefined' && module\.exports/.test(text));
    assert.ok(dual.length >= 20, `${dual.length} files with the dual export`);
    for (const pass of [config.pagesConfig(passOptions()), config.backgroundConfig(passOptions())]) assert.equal(pass.define.module, 'undefined');
  });

  it("hold no vendored module but Valibot's build, which its record and THIRD_PARTY_NOTICES cover, and no classic script", () => {
    assert.deepEqual(all.filter((file) => file.startsWith('js/lib/')), ['js/lib/valibot/index.mjs']);
    const notices = fromMap(new Map([['THIRD_PARTY_NOTICES', fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES'))]]), 'the build');
    assert.deepEqual(checkBundledVendor(all, notices), []);
    // A classic script the bundle also held would run twice (build/load-mode)
    for (const file of Object.keys(config.CLASSIC_SCRIPTS)) assert.equal(all.includes(file), false, file);
  });

  it("fails a bundled vendored module with no record, one that differs from its record, and one THIRD_PARTY_NOTICES doesn't name", () => {
    const record = /** @type {any} */ (readVendor().get('js/lib/valibot/index.mjs'));
    const vendor = new Map([['js/lib/valibot/index.mjs', { ...record, sha256: '0'.repeat(64) }]]);
    const notices = fromMap(new Map([['THIRD_PARTY_NOTICES', Buffer.from('1. Something else\n')]]), 'the build');
    const problems = checkBundledVendor(['js/a.js', 'js/lib/valibot/index.mjs', 'js/lib/other.mjs'], notices, ROOT, vendor);
    assert.deepEqual(problems.map(({ code, subject }) => `${code} ${subject}`), [
      'vendor/mismatch js/lib/valibot/index.mjs',
      'notices/no-entry js/lib/valibot/index.mjs',
      'vendor/unlisted js/lib/other.mjs',
    ]);
  });

  it('fails an environment read in a bundled module, which the bundler would otherwise replace before the output checks see it', () => {
    const text = 'const mode = process.env.NODE_ENV;\nconst key = process.env.API_KEY;\nconst env = import.meta.env;';
    assert.deepEqual(checkSourceEnvironment([{ file: 'js/a.js', text }]).map(({ code, subject, message }) => `${code} ${subject} ${message.split(' in ')[0]}`), [
      'env/reference js/a.js:2:13 process.env.API_KEY',
      'env/reference js/a.js:3:13 import.meta.env',
    ]);
  });
});

describe('the CommonJS checks (scripts/build/commonjs.js, scripts/build/bundle.js)', () => {
  const found = (text) => checkCommonJs([{ file: 'js/a.js', text }]).map(({ code, subject, message }) => `${code} ${subject} ${message.split(',')[0]}`);

  it('pass the dual export, a parameter or local named module or require, and typeof module or exports on its own', () => {
    assert.deepEqual(found([
      'function f() {}',
      "if (typeof module !== 'undefined' && module.exports) {",
      '  module.exports = { f };',
      "} else if (typeof window !== 'undefined') {",
      '  window.f = f;',
      '}',
      "export const node = typeof module !== 'undefined' ? module.exports : null;",
      'export const load = (module) => module.default;',
      'export function local() { const require = (x) => x; return require(1); }',
      "export function local2(require) { return typeof require === 'function'; }",
      "export const commonJs = typeof exports === 'object';",
    ].join('\n')), []);
  });

  it("fail a module.exports outside the typeof check, module read on its own, a free exports or require, and typeof require", () => {
    // #99's review: with module defined as undefined, the first two read undefined.exports and
    // throw, and the bundler wraps a file that names exports or require. #99's delta: it swaps
    // a free require for its require shim, a function, so typeof require takes the Node branch
    // on a page.
    const lines = [
      "if (typeof module !== 'undefined' && module.exports) module.exports = { f };",
      'module.exports.extra = 1;',
      'const m = module;',
      'exports.g = 2;',
      "const h = require('./h.js');",
      "export const node = typeof require === 'function';",
    ];
    assert.deepEqual(found(lines.join('\n')), [
      'build/commonjs js/a.js:2:1 reads module outside a typeof check',
      'build/commonjs js/a.js:3:11 reads module outside a typeof check',
      'build/commonjs js/a.js:4:1 names exports',
      'build/commonjs js/a.js:5:11 names require',
      `build/commonjs js/a.js:6:${lines[5].indexOf('require') + 1} checks typeof require`,
    ]);
  });

  it('fail a chunk that holds a module the bundler wrapped as CommonJS, by the module, whatever made it wrap', () => {
    // The report plugin finds the wrapper in each module as the bundler rendered it, before
    // terser renames it
    const options = passOptions();
    const [report] = config.pagesConfig(options).plugins;
    report.generateBundle({}, {
      'assets/newtab-A1.js': {
        type: 'chunk', fileName: 'assets/newtab-A1.js', name: 'newtab', isEntry: true, isDynamicEntry: false, facadeModuleId: '/repo/newtab.html',
        moduleIds: ['\0rolldown/runtime.js', '/repo/js/a.js', '/repo/js/b.js'], imports: [],
        modules: {
          '\0rolldown/runtime.js': { code: 'var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), cb = null), mod.exports);\n' },
          '/repo/js/a.js': { code: '// js/a.js\nvar require_a = /* @__PURE__ */ __commonJSMin(((exports) => {\n\texports.c = 3;\n}));\n' },
          '/repo/js/b.js': { code: '// js/b.js\nconst d = require_a();\n' },
        },
      },
    });
    assert.deepEqual(options.report.chunks.map(({ commonJs }) => commonJs), [['/repo/js/a.js']]);
    assert.deepEqual(commonJsProblems(options.report, '/repo').map(({ code, subject, message }) => `${code} ${subject} ${message.split(',')[0]}`), [
      'build/commonjs js/a.js the bundler wrapped it as CommonJS in assets/newtab-A1.js',
    ]);
    assert.deepEqual(commonJsProblems({ chunks: [chunk('pages', 'newtab', 'assets/newtab-A1.js')], assets: [] }, '/repo'), []);
  });
});

describe("the loader's chunk (#27 slice 3: scripts/build/vite-config.js, scripts/build/bundle.js)", () => {
  const LOADER_ID = `/repo/${config.LOADER}`;

  it('puts the loader alone in a chunk the pages pass writes at its own path, and every other chunk under assets/, hashed', () => {
    const { output } = config.pagesConfig(passOptions()).build.rolldownOptions;
    const [group] = output.codeSplitting.groups;
    assert.equal(output.codeSplitting.groups.length, 1);
    assert.equal(group.test(LOADER_ID), true);
    assert.equal(group.test('/repo/js/main.js'), false);
    const named = (moduleIds) => output.chunkFileNames({ name: 'x', isEntry: false, isDynamicEntry: false, facadeModuleId: null, moduleIds, exports: [] });
    assert.equal(named([LOADER_ID]), config.LOADER);
    assert.equal(named([LOADER_ID, '/repo/js/utils.js']), 'assets/[name]-[hash].js');
    assert.equal(named(['/repo/js/main.js']), 'assets/[name]-[hash].js');
    assert.equal(output.entryFileNames, 'assets/[name]-[hash].js');
    // The workers' build and the background pass keep their own names
    assert.equal(config.pagesConfig(passOptions()).worker.rolldownOptions.output.chunkFileNames, 'assets/[name]-[hash].js');
    assert.equal(config.backgroundConfig(passOptions()).build.rolldownOptions.output.codeSplitting, false);
  });

  it("knows the loader's module by the sources' real path too, as a temporary directory's on macOS", () => {
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-loader-'));
    try {
      const { output } = config.pagesConfig({ ...passOptions(), root: dir }).build.rolldownOptions;
      const realId = path.join(fs.realpathSync(dir), config.LOADER);
      assert.equal(output.codeSplitting.groups[0].test(path.join(dir, config.LOADER)), true);
      assert.equal(output.codeSplitting.groups[0].test(realId), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a loader merged into another chunk, a loader chunk that holds more, and one without the build ID', () => {
    const os = require('node:os');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-loader-'));
    try {
      fs.mkdirSync(path.join(outDir, 'js/runtime'), { recursive: true });
      fs.writeFileSync(path.join(outDir, config.LOADER), 'function i(){try{return"build-x"}catch{return null}}');
      const report = (chunks) => ({ chunks, assets: [] });
      const own = chunk('pages', 'loader', config.LOADER, { moduleIds: [LOADER_ID] });
      assert.deepEqual(loaderProblems(report([own, chunk('pages', 'newtab', 'assets/newtab-A1.js', { moduleIds: ['/repo/js/entries/newtab.js'] })]), '/repo', outDir, 'build-x'), []);
      const codes = (problems) => problems.map(({ code, subject, message }) => `${code} ${subject}: ${message}`);
      assert.deepEqual(codes(loaderProblems(report([chunk('pages', 'newtab', 'assets/newtab-A1.js', { moduleIds: ['/repo/js/entries/newtab.js', LOADER_ID] })]), '/repo', outDir, 'build-x')), [
        'build/loader js/runtime/lazy.js: the bundle writes it into assets/newtab-A1.js, not into a chunk of its own at its path',
      ]);
      assert.deepEqual(codes(loaderProblems(report([chunk('pages', 'loader', config.LOADER, { moduleIds: [LOADER_ID, '/repo/js/utils.js', '\0rolldown/runtime.js'] })]), '/repo', outDir, 'build-x')), [
        'build/loader js/runtime/lazy.js: its chunk holds js/utils.js too',
      ]);
      assert.match(codes(loaderProblems(report([own]), '/repo', outDir, 'build-y')).join('\n'), /^build\/loader js\/runtime\/lazy\.js: it doesn't carry the build's ID, build-y,/);
      assert.match(codes(loaderProblems(report([]), '/repo', outDir, 'build-x')).join('\n'), /into no chunk/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('holds the boot root, the loader, and the workspace chunk in the pages graph, and the loader imports nothing', () => {
    const pages = graphFrom(PAGE_ENTRIES);
    for (const file of ['js/entries/newtab.js', 'js/entries/boot.js', config.LOADER, 'js/workspace.js', 'js/main.js', 'js/app.js']) {
      assert.ok(pages.includes(file), file);
    }
    assert.deepEqual(scanScript(config.LOADER, read(config.LOADER)).references.filter(({ kind }) => kind === 'import'), []);
  });
});

describe("the indexer's starter (js/kernel/composition/workers.js)", () => {
  const STARTER = 'js/kernel/composition/workers.js';

  it('starts js/workers/indexer.js as a module worker, and is the one place first-party code starts a worker', () => {
    const starts = (file) => scanScript(file, read(file)).references.filter(({ kind }) => kind === 'worker' || kind === 'worker-url');
    assert.deepEqual(starts(STARTER).map(({ kind, value }) => `${kind} ${value}`), ['worker-url ../../workers/indexer.js']);
    assert.match(read(STARTER), /new Worker\(new URL\('\.\.\/\.\.\/workers\/indexer\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
    const firstParty = filesUnder('js').filter((file) => /\.m?js$/.test(file) && !file.startsWith('js/lib/'));
    assert.deepEqual(firstParty.filter((file) => starts(file).length > 0), [STARTER]);
    // A module worker can't call importScripts()
    assert.deepEqual(scanScript('js/workers/indexer.js', read('js/workers/indexer.js')).references.filter(({ kind }) => kind === 'import-scripts'), []);
  });

  it('goes from the composition root through App to NotesManager, which the tests load as classic scripts, where import.meta is a syntax error', () => {
    for (const file of ['js/app.js', 'js/controllers/notes-manager.js']) {
      assert.deepEqual(scanScript(file, read(file)).moduleSyntax, [], file);
    }
    assert.match(read('js/kernel/composition/newtab.js'), /import \{ startIndexer \} from '\.\/workers\.js';/);
    assert.match(read('js/app.js'), /new NotesManager\(\{[^}]*startIndexer: this\.startIndexer,/);
    assert.match(read('js/controllers/notes-manager.js'), /this\.indexerWorker = this\.startIndexer\(\);/);
  });

  it("is in what the composition root hands App, and App keeps it, since without it nothing indexes and nothing says so", () => {
    // #99's delta: #97's rebase rewrote both lines
    const ts = require('typescript');
    const text = read('js/kernel/composition/newtab.js');
    const source = ts.createSourceFile('newtab.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const handed = [];
    const visit = (node) => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'page.App' && node.arguments && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const property of node.arguments[0].properties) handed.push(property.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(handed.includes('startIndexer'), handed.join(', '));
    const { createLegacyEnv } = require('./helpers/legacy-env');
    const env = createLegacyEnv();
    env.load('js/utils.js', 'js/core/storage-error.js', 'js/core/dom-refs.js', 'js/core/logger.js', 'js/ui/export-notice.js', 'js/storage.js', 'js/search.js', 'js/app.js');
    const App = env.get('App');
    const starter = () => null;
    assert.equal(new App({ startIndexer: starter }).startIndexer, starter);
    assert.equal(new App({}).startIndexer, null);
  });
});

describe('what git ignores', () => {
  it("ignores the build's output and reports, and the Impeccable design hook's cache, which it writes in every worktree", () => {
    for (const file of ['dist/manifest.json', 'dist-report/modules.json', '.impeccable/hook.cache.json']) {
      assert.doesNotThrow(() => execFileSync('git', ['-C', ROOT, 'check-ignore', '-q', file]), file);
    }
  });
});
