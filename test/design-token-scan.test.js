'use strict';

// Design token scanner (#16 slice 1): scripts/design-token-scan.js. The first test
// is the required check: production matches test/fixtures/design-token-baseline.json.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scanner = require('../scripts/design-token-scan.js');

const ROOT = path.join(__dirname, '..');
const DESIGN = {
  tokens: new Set(['--surface-paper', '--text-primary', '--space-region']),
  registered: new Set(['--surface-paper', '--text-primary']),
  aliases: new Set(['--bg-primary']),
};

/** Scan fixture files and return each file's counts and the failures */
function scanFixtures(texts) {
  const result = scanner.scan({ root: ROOT, design: DESIGN, files: Object.keys(texts), texts });
  return { counts: result.counts, failures: result.failures, occurrences: result.occurrences };
}

function countsOf(file, text) {
  return scanFixtures({ [file]: text }).counts[file] || {};
}

function capture() {
  const lines = [];
  return { lines, log: line => lines.push(line), error: line => lines.push(line) };
}

describe('production matches the design token baseline', () => {
  it('has no failure, no count above its entry, no count in a file without one, and no unrecorded drop', () => {
    const out = capture();
    const code = scanner.main([], { root: ROOT, log: out.log, error: out.error });
    assert.equal(code, 0, out.lines.join('\n'));
  });

  it('scans the root pages, css/, and js/, and skips js/lib/, design/, test/, and the generated output', () => {
    const files = scanner.productionFiles(ROOT);
    for (const file of ['newtab.html', 'popup.html', 'sidepanel.html', 'offscreen.html', 'css/editor.css', 'js/app.js', 'js/design/contrast.js']) {
      assert.ok(files.includes(file), file);
    }
    for (const file of files) {
      assert.ok(!/^(?:js\/lib|design|test|node_modules|dist)\//.test(file), file);
      assert.ok(!scanner.GENERATED.includes(file), file);
    }
  });

  it('counts nothing in the design system\'s own modules', () => {
    const { counts } = scanner.scan({ root: ROOT });
    assert.equal(counts['js/design/contrast.js'], undefined);
  });

  it('records every pattern the issue lists, and only those', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, scanner.BASELINE_PATH), 'utf8'));
    assert.deepEqual(baseline.patterns, scanner.PATTERNS, `the baseline's pattern descriptions are stale: run \`${'npm run design-token-scan -- --update'}\``);
    assert.deepEqual(Object.keys(scanner.PATTERNS), [
      'color-literal', 'theme-branching', 'runtime-style', 'inline-style-block', 'style-attribute', 'undefined-var',
      'unregistered-read', 'gradient-text', 'backdrop-filter', 'hard-shadow', 'one-sided-border', 'transition-all',
      'px-font-size', 'alias-use',
    ]);
    assert.deepEqual(Object.keys(scanner.FAILURES), ['import', 'remote-url', 'font-face-src']);
  });
});

describe('what the scanner counts', () => {
  it('color literals in CSS values, HTML color attributes and style attributes, and JS strings', () => {
    assert.equal(countsOf('css/x.css', `#add { color: #fff; background: rgb(0 0 0 / 50%); border: 1px solid white;
      content: "#fff white"; transition: color 1s; --tint: #f00; background-image: url(#icon); }`)['color-literal'], 4);
    assert.equal(countsOf('x.html', '<svg><path fill="#fff" stroke="currentColor"/></svg><div style="color: red"></div>')['color-literal'], 2);
    assert.equal(countsOf('js/x.js', `ctx.fillStyle = '#4d9eff';
      const colors = ['#fff', 'rgba(0, 0, 0, 0.1)'];
      const named = 'white';
      const label = 'White';
      const prose = 'use the rgb() form';
      // '#123456' in a comment
      el.style.cssText = 'display: flex; color: #666;';
      el.style.color = '#000';`)['color-literal'], 6);
  });

  it('theme branching: data-theme and data-scheme selectors, prefers-color-scheme, dataset.theme, and dark or light comparisons', () => {
    assert.equal(countsOf('css/x.css', '[data-theme="dark"] .a { color: red } @media (prefers-color-scheme: dark) { .b { color: red } } :root[data-scheme="dark"] {}')['theme-branching'], 3);
    assert.equal(countsOf('js/x.js', `if (theme === 'dark') {}
      matchMedia('(prefers-color-scheme: dark)');
      root.setAttribute('data-theme', mode);
      const t = document.documentElement.dataset.theme;
      switch (t) { case 'light': break; }
      if (role === 'system') {}`)['theme-branching'], 5);
  });

  it('runtime <style> creation, inline <style> blocks, and style= attributes', () => {
    const js = countsOf('js/x.js', `const s = document.createElement('style');
      el.innerHTML = '<style>.a { color: red }</style><span style="margin: 0">x</span>';
      el.setAttribute('style', 'margin: 0');
      el.style.margin = '0';`);
    assert.equal(js['runtime-style'], 2);
    assert.equal(js['style-attribute'], 2);
    const html = countsOf('x.html', '<head><style>a { margin: 0 }</style></head><body><div style="margin: 0"></div><!-- <div style="x"> --></body>');
    assert.equal(html['inline-style-block'], 1);
    assert.equal(html['style-attribute'], 1);
  });

  it('counts CSS inside a markup string once', () => {
    const counts = countsOf('js/x.js', `el.innerHTML = '<style>@media (prefers-color-scheme: dark) { [data-theme="dark"] .a { color: #000 } }</style>'
      + '<p style="color: #fff; font-size: 12px">x</p>';`);
    assert.equal(counts['runtime-style'], 1);
    assert.equal(counts['style-attribute'], 1);
    assert.equal(counts['theme-branching'], 2);
    assert.equal(counts['color-literal'], 2);
    assert.equal(counts['px-font-size'], 1);
  });

  it('var() with no definition and no fallback, against production and token definitions', () => {
    const counts = scanFixtures({
      'css/a.css': 'a { color: var(--nope); margin: var(--nope2, 0); padding: var(--defined); fill: var(--surface-paper) }',
      'css/b.css': ':root { --defined: 1px }',
      'js/x.js': "el.style.setProperty('--set-in-js', 1); el.style.width = 'var(--set-in-js)'; el.style.height = `var(--${name})`;",
    }).counts;
    assert.equal(counts['css/a.css']['undefined-var'], 1);
    assert.equal(counts['js/x.js'], undefined);
  });

  it('getPropertyValue reads of anything but a registered color token', () => {
    assert.equal(countsOf('js/x.js', `const s = getComputedStyle(el);
      s.getPropertyValue('--bg-primary');
      s.getPropertyValue('--surface-paper');
      s.getPropertyValue('--space-region');
      s.getPropertyValue(name);
      s.getPropertyValue('color');`)['unregistered-read'], 3);
  });

  it('gradient text, backdrop-filter, hard offset shadows, one-sided borders, and transition: all', () => {
    const counts = countsOf('css/x.css', `
      h1 { background: linear-gradient(red, blue); -webkit-background-clip: text; background-clip: text; }
      .a { backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
      .b { backdrop-filter: none; }
      .c { box-shadow: 4px 4px 0 #000; }
      .d { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); }
      .e { box-shadow: inset 0 -1px 0 var(--x); }
      .f { box-shadow: var(--shadow); }
      .g { box-shadow: 0 0 0 2px red; }
      .h { border-left: 3px solid var(--x); }
      .i { border-left: 1px solid; }
      .j { border-inline-start: 2px solid red; }
      .k { border-top-width: 4px; }
      .l { border-width: 0 0 2px; }
      .m { border: 2px solid; }
      .n { border-right: solid; }
      .o { transition: all 0.2s; }
      .p { transition: opacity 0.2s; }
      .q { transition: 0.3s; }
      .r { transition: var(--t); }
      .s { transition-property: all; }
      .t { transition: opacity 0.2s, 0.3s ease; }
    `);
    assert.equal(counts['gradient-text'], 1);
    assert.equal(counts['backdrop-filter'], 2);
    assert.equal(counts['hard-shadow'], 2);
    assert.equal(counts['one-sided-border'], 5);
    assert.equal(counts['transition-all'], 4);
  });

  it('px font sizes in CSS, style writes, canvas fonts, and Chart.js configs', () => {
    assert.equal(countsOf('css/x.css', 'a { font-size: 14px } b { font: 12px/1.5 sans-serif } c { font-size: 0.8rem } d { font-size: var(--x, 13px) }')['px-font-size'], 3);
    assert.equal(countsOf('js/x.js', `ctx.font = '12px sans-serif';
      ctx.font = \`\${size}px sans-serif\`;
      el.style.fontSize = '12px';
      el.style.fontSize = '1rem';
      new Chart(canvas, { options: { plugins: { legend: { labels: { font: { size: 11 } } } } } });
      Chart.defaults.font.size = 12;`)['px-font-size'], 5);
  });

  it('alias uses: var() of a legacy name, with or without a fallback', () => {
    const counts = countsOf('css/x.css', 'a { color: var(--bg-primary); background: var(--bg-primary, #fff); fill: var(--text-primary) }');
    assert.equal(counts['alias-use'], 2);
    assert.equal(counts['undefined-var'], 1);
  });
});

describe('what always fails', () => {
  it('fails an @import, a remote url(), a remote <link>, and an @font-face source outside fonts/', () => {
    const { failures } = scanFixtures({
      'css/x.css': `@import url(other.css);
        a { background: url(https://example.test/a.png) }
        b { background: url("//cdn.example.test/b.png") }
        c { background: url(images/c.png); mask: url(data:image/svg+xml;utf8,<svg></svg>) }
        @font-face { font-family: A; src: url(../fonts/a/a.woff2) format("woff2"), local("A"); }
        @font-face { font-family: B; src: url(b.woff2) format("woff2"); }
        @font-face { font-family: C; src: local("Arial"); }`,
      'x.html': '<link rel="stylesheet" href="https://fonts.example.test/x.css"><link rel="icon" href="icons/icon16.png">',
    });
    assert.deepEqual(failures.map(f => [f.file, f.rule]), [
      ['css/x.css', 'import'],
      ['css/x.css', 'remote-url'],
      ['css/x.css', 'remote-url'],
      ['css/x.css', 'font-face-src'],
      ['x.html', 'remote-url'],
    ]);
    assert.equal(failures.find(f => f.rule === 'font-face-src').detail, 'src: url(b.woff2)');
  });
});

describe('the baseline only falls', () => {
  const temps = [];
  after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

  function tree(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-token-scan-'));
    temps.push(dir);
    fs.mkdirSync(path.join(dir, 'design'));
    fs.copyFileSync(path.join(ROOT, scanner.SOURCE_PATH), path.join(dir, scanner.SOURCE_PATH));
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    return {
      dir,
      write: (file, text) => fs.writeFileSync(path.join(dir, file), text),
      baseline: () => fs.readFileSync(path.join(dir, scanner.BASELINE_PATH), 'utf8'),
      run: (...args) => {
        const out = capture();
        const code = scanner.main(args, { root: dir, log: out.log, error: out.error });
        return { code, output: out.lines.join('\n') };
      },
    };
  }

  it('seeds once with --init and then refuses to', () => {
    const t = tree({ 'css/a.css': 'a { color: #fff }' });
    assert.equal(t.run('--init').code, 0);
    assert.deepEqual(JSON.parse(t.baseline()).files, { 'css/a.css': { 'color-literal': 1 } });
    const again = t.run('--init');
    assert.equal(again.code, 1);
    assert.match(again.output, /refusing --init/);
    assert.equal(t.run().code, 0);
  });

  it('fails a higher count and names the occurrences, and --update won\'t record it', () => {
    const t = tree({ 'css/a.css': 'a { color: #fff }' });
    t.run('--init');
    const before = t.baseline();
    t.write('css/a.css', 'a { color: #fff; background: #000 }');
    const result = t.run();
    assert.equal(result.code, 1);
    assert.match(result.output, /css\/a\.css color-literal: 2 found, 1 allowed/);
    assert.match(result.output, /css\/a\.css:1 background: #000/);
    assert.equal(t.run('--update').code, 1);
    assert.equal(t.baseline(), before);
  });

  it('fails a file with no entry unless it counts zero', () => {
    const t = tree({ 'css/a.css': 'a { color: #fff }' });
    t.run('--init');
    t.write('css/b.css', 'b { margin: 0 }');
    assert.equal(t.run().code, 0);
    t.write('css/b.css', 'b { color: red }');
    const result = t.run();
    assert.equal(result.code, 1);
    assert.match(result.output, /css\/b\.css color-literal: 1 found, 0 allowed \(no baseline entry, so it must count zero\)/);
  });

  it('fails a lower count until --update records it', () => {
    const t = tree({ 'css/a.css': 'a { color: #fff; background: #000 }' });
    t.run('--init');
    t.write('css/a.css', 'a { color: #fff }');
    const result = t.run();
    assert.equal(result.code, 1);
    assert.match(result.output, /Record them with `npm run design-token-scan -- --update`/);
    assert.equal(t.run('--update').code, 0);
    assert.deepEqual(JSON.parse(t.baseline()).files, { 'css/a.css': { 'color-literal': 1 } });
    assert.equal(t.run().code, 0);
  });

  it('drops the entry of a file that counts nothing anymore', () => {
    const t = tree({ 'css/a.css': 'a { color: #fff }' });
    t.run('--init');
    t.write('css/a.css', 'a { color: var(--text-primary) }');
    assert.equal(t.run('--update').code, 0);
    assert.deepEqual(JSON.parse(t.baseline()).files, {});
  });

  it('rewrites stale pattern descriptions on --update', () => {
    const t = tree({ 'css/a.css': 'a { color: #fff }' });
    t.run('--init');
    const stale = JSON.parse(t.baseline());
    stale.patterns['color-literal'] = 'an old description';
    t.write(scanner.BASELINE_PATH, JSON.stringify(stale));
    assert.equal(t.run('--update').code, 0);
    assert.deepEqual(JSON.parse(t.baseline()).patterns, scanner.PATTERNS);
  });

  it('fails a failure rule whatever the baseline says', () => {
    const t = tree({ 'css/a.css': 'a { color: #fff }' });
    t.run('--init');
    t.write('css/a.css', '@import url(b.css); a { color: #fff }');
    const result = t.run();
    assert.equal(result.code, 1);
    assert.match(result.output, /css\/a\.css:1 import/);
  });

  it('rejects a malformed baseline', () => {
    assert.throws(() => scanner.parseBaseline('{"files": {"css/a.css": {"colour": 1}}}'), /unknown pattern colour/);
    assert.throws(() => scanner.parseBaseline('{"files": {"css/a.css": {"color-literal": 0}}}'), /count 0/);
    assert.throws(() => scanner.parseBaseline('{}'), /missing a "files" object/);
  });

  it('compares per file and pattern', () => {
    const { raised, lowered } = scanner.compare(
      { 'css/a.css': { 'color-literal': 2, 'px-font-size': 1 } },
      { 'css/a.css': { 'color-literal': 3 }, 'css/b.css': { 'alias-use': 1 } },
    );
    assert.deepEqual(raised.map(r => [r.file, r.pattern, r.allowed, r.count, r.entry]), [
      ['css/a.css', 'color-literal', 2, 3, true],
      ['css/b.css', 'alias-use', 0, 1, false],
    ]);
    assert.deepEqual(lowered.map(r => [r.file, r.pattern, r.allowed, r.count]), [['css/a.css', 'px-font-size', 1, 0]]);
  });
});
