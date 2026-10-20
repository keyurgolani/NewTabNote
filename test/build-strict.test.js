const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const CleanCSS = require('clean-css');

const ROOT = path.join(__dirname, '..');
const build = require('../scripts/build.js');
const { excerpt, MARKERS } = require('../scripts/ci/failure-excerpt.js');

const LISTS = [build.JS_FILES, build.CSS_FILES, build.HTML_FILES, build.STATIC_FILES, build.STATIC_DIRS];

// What scripts/build.js reads: itself, the top-level entries its lists name, and tsc's config
const SOURCE_ENTRIES = [...new Set([
  'scripts',
  'package.json',
  'jsconfig.json',
  ...LISTS.flat().map(entry => entry.split('/')[0]),
])];

// A listed JS file that gets minified, and a CSS file that gets level 2
const MINIFIED_JS = build.JS_FILES.find(file => !build.isCopiedAsIs(file));
const LEVEL_2_CSS = build.CSS_FILES.find(file => !build.CSS_LEVEL_1.includes(file));
const OTHER_LEVEL_2_CSS = build.CSS_FILES.find(file => file !== LEVEL_2_CSS && !build.CSS_LEVEL_1.includes(file));

// CleanCSS 5.3.3's level-2 removeUnusedAtRules pass throws on this (see CSS_LEVEL_1 in build.js)
const LEVEL_2_CRASH = '\n@keyframes ntn-strict{from{opacity:0}to{opacity:1}}\n.ntn-strict{animation:ntn-strict var(--ntn-strict) ease}\n';
// A local @import of a missing file is a CleanCSS error, not a throw
const CLEANCSS_ERROR = '@import url(ntn-strict-missing.css);\n';
const TERSER_ERROR = '\nconst = ;\n';

const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

/**
 * Copy the source tree to a temp dir with node_modules linked, then apply a fixture
 */
function tree(fixture = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-build-strict-'));
  temps.push(dir);
  for (const entry of SOURCE_ENTRIES) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fixture({
    append: (file, text) => fs.appendFileSync(path.join(dir, file), text),
    prepend: (file, text) => fs.writeFileSync(path.join(dir, file), text + fs.readFileSync(path.join(dir, file), 'utf8')),
    remove: file => fs.rmSync(path.join(dir, file), { recursive: true }),
    replace: (file, from, to) => {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!text.includes(from)) throw new Error(`${file} has no ${JSON.stringify(from)} to replace`);
      fs.writeFileSync(path.join(dir, file), text.replace(from, to));
    },
  });
  return dir;
}

function runBuild(dir, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'scripts', 'build.js'), ...args], { cwd: dir });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output, dist: path.join(dir, 'dist') }));
  });
}

// The build output lines worth reading in a failure message, or its last lines
function brief(output) {
  const lines = output.trimEnd().split('\n');
  const notable = lines.filter(line => /✗|⚠️|Error|failed/.test(line));
  return (notable.length > 0 ? notable : lines.slice(-15)).join('\n');
}

function assertRefused({ code, output }, file, refusal) {
  assert.equal(code, 1, brief(output));
  const line = output.split('\n').find(l => l.includes(`✗ ${file}: --strict`));
  assert.ok(line, `no refusal line for ${file} in:\n${brief(output)}`);
  assert.ok(line.includes(refusal), `"${refusal}" missing from: ${line}`);
  assert.match(output, /Strict build failed: refused \d+ fallback/);
  assert.doesNotMatch(output, /Build complete/);
}

function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(prefix, entry.name);
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  }).sort();
}

describe('scripts/build.js --strict', { concurrency: true }, () => {
  it('builds today\'s tree, with the same dist as a build without the flag', async () => {
    const [strict, plain] = await Promise.all([runBuild(tree(), ['--strict']), runBuild(tree())]);
    assert.equal(strict.code, 0, brief(strict.output));
    assert.equal(plain.code, 0, brief(plain.output));
    assert.doesNotMatch(strict.output, /✗|Level-2 minification failed|not found, skipping|Error minifying/);

    const files = listFiles(strict.dist);
    assert.deepEqual(listFiles(plain.dist), files);
    for (const file of files) {
      assert.ok(fs.readFileSync(path.join(strict.dist, file)).equals(fs.readFileSync(path.join(plain.dist, file))), file);
    }
  });

  it('refuses to skip a missing listed file, for every list', async () => {
    const missing = LISTS.map(list => list[list.length - 1]);
    const result = await runBuild(tree(({ remove }) => missing.forEach(remove)), ['--strict']);
    for (const file of missing) {
      const label = build.STATIC_DIRS.includes(file) ? `${file}/` : file;
      assertRefused(result, label, 'refused to skip a missing listed file');
    }
  });

  it('refuses to copy a JS file unminified after a terser error', async () => {
    const result = await runBuild(tree(({ append }) => append(MINIFIED_JS, TERSER_ERROR)), ['--strict']);
    assertRefused(result, MINIFIED_JS, 'refused to copy it unminified after a terser error');
  });

  it('refuses to copy a CSS file unminified after a CleanCSS error', async () => {
    const result = await runBuild(tree(({ prepend }) => prepend(LEVEL_2_CSS, CLEANCSS_ERROR)), ['--strict']);
    assertRefused(result, LEVEL_2_CSS, 'refused to copy it unminified after a CleanCSS error');
  });

  it('refuses the level-1 retry after a CleanCSS level-2 error', async () => {
    assert.throws(
      () => new CleanCSS(build.CLEANCSS_OPTIONS).minify(LEVEL_2_CRASH),
      'CleanCSS no longer throws on this fixture: pick another level-2 crash, and check whether CSS_LEVEL_1 in scripts/build.js is still needed',
    );
    const result = await runBuild(tree(({ append }) => append(LEVEL_2_CSS, LEVEL_2_CRASH)), ['--strict']);
    assertRefused(result, LEVEL_2_CSS, 'refused the level-1 retry after a CleanCSS level-2 error');
  });

  it('lists every refusal with its detail, and pr-gate\'s build excerpt starts there', async () => {
    const result = await runBuild(tree(({ append }) => {
      append(MINIFIED_JS, TERSER_ERROR);
      append(LEVEL_2_CSS, LEVEL_2_CRASH);
    }), ['--strict']);
    assertRefused(result, MINIFIED_JS, 'refused to copy it unminified after a terser error');
    assertRefused(result, LEVEL_2_CSS, 'refused the level-1 retry after a CleanCSS level-2 error');

    // terser's location, with the column counted from 1 like an editor
    const source = fs.readFileSync(path.join(ROOT, MINIFIED_JS), 'utf8') + TERSER_ERROR;
    const offset = source.lastIndexOf('const = ;');
    const location = `${MINIFIED_JS}:${source.slice(0, offset).split('\n').length}:${'const '.length + 1}`;

    let crash = '';
    try {
      new CleanCSS(build.CLEANCSS_OPTIONS).minify(fs.readFileSync(path.join(ROOT, LEVEL_2_CSS), 'utf8') + LEVEL_2_CRASH);
    } catch (e) {
      crash = e.message;
    }
    assert.ok(crash, 'the level-2 fixture no longer makes CleanCSS throw');

    const lines = excerpt(result.output, MARKERS.build).split('\n');
    const shown = lines.join('\n');
    assert.equal(lines[0], '✗ Strict build failed: refused 2 fallbacks', shown);
    assert.ok(lines.includes(`   ${MINIFIED_JS}: refused to copy it unminified after a terser error: Name expected (${location})`), shown);
    assert.ok(lines.includes(`   ${LEVEL_2_CSS}: refused the level-1 retry after a CleanCSS level-2 error: ${crash}`), shown);
  });

  it('without --strict, falls back as before and exits 0', async () => {
    const missingJs = build.JS_FILES[build.JS_FILES.length - 1];
    const dir = tree(({ append, prepend, remove }) => {
      remove(missingJs);
      append(MINIFIED_JS, TERSER_ERROR);
      prepend(LEVEL_2_CSS, CLEANCSS_ERROR);
      append(OTHER_LEVEL_2_CSS, LEVEL_2_CRASH);
    });
    const { code, output, dist } = await runBuild(dir);
    assert.equal(code, 0, brief(output));
    assert.match(output, new RegExp(`${missingJs} not found, skipping`));
    assert.match(output, /Level-2 minification failed for .*falling back to level-1/);
    assert.equal(fs.existsSync(path.join(dist, missingJs)), false);
    // terser and CleanCSS errors copy the source unminified
    for (const file of [MINIFIED_JS, LEVEL_2_CSS]) {
      assert.equal(fs.readFileSync(path.join(dist, file), 'utf8'), fs.readFileSync(path.join(dir, file), 'utf8'), file);
    }
    assert.ok(fs.statSync(path.join(dist, OTHER_LEVEL_2_CSS)).size > 0);
  });

  it('ships every file under js/kernel/ but its package.json, and minifies each file the way it loads', async () => {
    const { code, output, dist } = await runBuild(tree(), ['--strict']);
    assert.equal(code, 0, brief(output));
    assert.equal(fs.existsSync(path.join(dist, 'js/kernel/composition/background.js')), true);
    assert.equal(fs.existsSync(path.join(dist, 'js/kernel/package.json')), false);

    const line = file => output.split('\n').find(l => l.includes(` ${file}: `)) || '';
    for (const file of ['js/popup.js', 'js/sidepanel.js', 'js/background.js', 'js/utils.js', 'js/app.js', 'js/kernel/composition/background.js']) {
      assert.match(line(file), /saved, module\)$/, `${file} should be minified as an ES module`);
    }
    for (const file of ['js/offscreen.js', 'js/insights-summary.js']) {
      assert.match(line(file), /saved\)$/, `${file} should be minified as a classic script`);
    }
    // A classic script keeps its top-level names. offscreen.js comes after js/main.js, and
    // terser used to carry main.js's module: true over to it through the shared options.
    assert.match(fs.readFileSync(path.join(dist, 'js/offscreen.js'), 'utf8'), /function handleApiRequest\(/);
  });

  it('refuses a file loaded both as a module and as a classic script, and a missing walked directory', async () => {
    const result = await runBuild(tree(({ replace, remove }) => {
      const entry = '<script type="module" src="js/popup.js">';
      replace('popup.html', entry, `<script src="js/utils.js"></script>\n  ${entry}`);
      remove('js/kernel');
    }), ['--strict']);
    assertRefused(result, 'js/utils.js', 'refused to minify a file loaded both as an ES module and as a classic script');
    assertRefused(result, 'js/kernel/', 'refused to skip a missing listed file');
  });
});

describe('terserOptions', () => {
  it('gives each call its own copy, so a module minify leaves the next file alone', async () => {
    const before = JSON.stringify(build.TERSER_OPTIONS);
    const options = build.terserOptions(true);
    assert.equal(options.module, true);
    assert.equal(build.terserOptions(false).module, false);
    options.compress.module = 'changed';
    // terser writes module: true into the nested objects it's handed
    await require('terser').minify('export const x = 1;', build.terserOptions(true));
    assert.equal(JSON.stringify(build.TERSER_OPTIONS), before);
    assert.equal(build.terserOptions(false).compress.module, undefined);
  });
});

describe('COPY_AS_IS', () => {
  it('matches exact paths and directory entries ending in a slash', () => {
    const list = ['js/lib/', 'js/vendor.js'];
    assert.equal(build.isCopiedAsIs('js/lib/fuse.js', list), true);
    assert.equal(build.isCopiedAsIs('js/vendor.js', list), true);
    assert.equal(build.isCopiedAsIs('js/library.js', list), false);
    assert.equal(build.isCopiedAsIs('js/vendor.js.map', list), false);
  });
});
